import type { OpenApiClient } from '../gmgn/OpenApiClient.js';
import type { Logger } from '../logger.js';
import { BanGate, TokenBucket } from './limiter.js';
import { runtimeMetrics } from '../ops/metrics.js';
import { withDeadline } from '../deadline.js';

/** GMGNAI/gmgn-skills official route weights, verified 2026-09-23. */
export const ROUTE_WEIGHTS = {
  smartmoney: 1,
  kol: 1,
  followWallet: 10,
  tokenInfo: 1,
  tokenSecurity: 1,
  tokenPool: 1,
  walletActivity: 3,
  walletStats: 3,
  walletProfits: 3,
  walletHoldings: 2,
  kline: 2,
} as const;

export class BackgroundBusyError extends Error {
  constructor() { super('background budget unavailable'); this.name = 'BackgroundBusyError'; }
}

export type RouteName = keyof typeof ROUTE_WEIGHTS;

/** 429 / 封禁错误：由调用方决定退避与回补，封禁期内不得重试 */
export class RateLimitedError extends Error {
  readonly resetAtMs: number;
  readonly apiError: string;

  constructor(resetAtMs: number, apiError: string) {
    super(`GMGN 限频（${apiError}），恢复时间 ${new Date(resetAtMs).toISOString()}`);
    this.name = 'RateLimitedError';
    this.resetAtMs = resetAtMs;
    this.apiError = apiError;
  }
}

function extractRateLimitInfo(
  err: unknown,
): { apiError: string; resetAtUnix?: number } | null {
  if (!(err instanceof Error)) return null;
  const candidate = err as { apiError?: unknown; apiCode?:unknown; resetAtUnix?: unknown; status?: number };
  if (candidate.status !== 429 && candidate.apiCode !== 429 && candidate.apiCode !== '429' && candidate.apiError !== 'RATE_LIMIT_EXCEEDED' && candidate.apiError !== 'RATE_LIMIT_BANNED') {
    return null;
  }
  return {
    apiError: typeof candidate.apiError === 'string' ? candidate.apiError : 'HTTP_429',
    resetAtUnix:
      typeof candidate.resetAtUnix === 'number' && Number.isFinite(candidate.resetAtUnix) && candidate.resetAtUnix > 0 && candidate.resetAtUnix < 8.64e12
        ? candidate.resetAtUnix
        : undefined,
  };
}

export interface GmgnGatewayOptions {
  client: OpenApiClient;
  limiter: TokenBucket;
  banGate: BanGate;
  logger?: Logger;
  /** 注入时钟便于测试 */
  now?: () => number;
  requestTimeoutMs?: number;
  /** Numeric-only cooldown/adaptive budget state; survives process restarts. */
  savedLimitState?: GatewayLimitState | null;
  saveLimitState?: (state: GatewayLimitState) => void;
}

export interface GatewayLimitState {bannedUntilMs:number;reason:string;effectiveRate:number;lastLimitedAt:number;}

/**
 * GMGN 调用网关：统一串行化限流预算、处理 429/封禁、按端点权重计费。
 * 所有业务模块只能通过本网关访问 GMGN。
 */
export class GmgnGateway {
  private readonly client: OpenApiClient;
  private readonly limiter: TokenBucket;
  private readonly banGate: BanGate;
  private readonly logger?: Logger;
  private readonly now: () => number;
  private backgroundNextAt = 0;
  private backgroundInFlight = false;
  private readonly requestTimeoutMs: number;
  private dispatchTail: Promise<void> = Promise.resolve();
  private admissions = 0;
  private nextStartAt = 0;
  private effectiveRate: number;
  private lastLimitedAt = 0;
  private readonly saveLimitState?: (state: GatewayLimitState) => void;

  constructor(options: GmgnGatewayOptions) {
    this.client = options.client;
    this.limiter = options.limiter;
    this.banGate = options.banGate;
    this.logger = options.logger;
    this.now = options.now ?? (() => Date.now());
    this.requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
    this.effectiveRate = this.limiter.ratePerSecond;
    this.saveLimitState = options.saveLimitState;
    const saved=options.savedLimitState;
    if(saved){
      if(Number.isFinite(saved.effectiveRate)&&saved.effectiveRate>0)this.effectiveRate=Math.min(this.effectiveRate,saved.effectiveRate);
      if(Number.isFinite(saved.lastLimitedAt))this.lastLimitedAt=saved.lastLimitedAt;
      if(Number.isFinite(saved.bannedUntilMs)&&saved.bannedUntilMs>this.now())this.banGate.banUntil(saved.bannedUntilMs,saved.reason);
    }
  }

  get limitState(): GatewayLimitState {
    return {bannedUntilMs:this.banGate.bannedUntil??0,reason:this.banGate.banReason??'',effectiveRate:this.effectiveRate,lastLimitedAt:this.lastLimitedAt};
  }

  /** Serialize admissions, not responses. Start-time pacing never banks credits during stalls. */
  private async admit(route:RouteName,background:boolean):Promise<()=>void> {
    const weight=ROUTE_WEIGHTS[route];
    if(weight>this.limiter.capacity)throw new Error(`GMGN limiter capacity must be at least ${weight} for ${route}`);
    if(background){
      const deadline=performance.now()+5000,reserve=Math.min(3,this.limiter.capacity-weight);
      while(this.admissions>0||this.now()<Math.max(this.nextStartAt,this.backgroundNextAt)||this.limiter.available<weight+reserve){
        if(this.banGate.isBanned||performance.now()>=deadline)throw new BackgroundBusyError();
        await new Promise(resolve=>setTimeout(resolve,250));
      }
      if(this.banGate.isBanned)throw new BackgroundBusyError();
    }
    const previous=this.dispatchTail;
    let unlock!:()=>void;
    this.dispatchTail=new Promise<void>(resolve=>{unlock=resolve;});
    this.admissions++;
    const release=()=>{this.admissions--;unlock();};
    await previous;
    try {
      while(true){
        if(background&&this.banGate.isBanned)throw new BackgroundBusyError();
        await this.banGate.waitIfBanned();
        const delay=this.nextStartAt-this.now();
        if(delay>0){await new Promise(resolve=>setTimeout(resolve,Math.min(delay,60_000)));continue;}
        await this.limiter.acquire(weight);
        if(!this.banGate.isBanned)break;
      }
      return release;
    }catch(error){release();throw error;}
  }

  private rateLimit(error:unknown,route:RouteName):unknown {
    const info=extractRateLimitInfo(error);if(!info)return error;
    const now=this.now(),alreadyBanned=this.banGate.isBanned;
    const resetAtMs=info.resetAtUnix!=null?Math.max(now+1000,info.resetAtUnix*1000+1000):now+300_000;
    // Concurrent in-flight failures belong to the same episode; don't repeatedly cut the budget.
    if(!alreadyBanned)this.effectiveRate=Math.max(Math.min(2,this.limiter.ratePerSecond),this.effectiveRate*.8);
    this.lastLimitedAt=now;
    this.banGate.banUntil(resetAtMs,info.apiError);
    this.saveLimitState?.(this.limitState);
    this.logger?.warn('GMGN 限频封禁',{route,apiError:info.apiError,resetAt:new Date(this.banGate.bannedUntil!).toISOString(),effectiveRate:this.effectiveRate});
    return new RateLimitedError(this.banGate.bannedUntil!,info.apiError);
  }

  get isBanned(): boolean {
    return this.banGate.isBanned;
  }

  get bannedUntil(): number | null {
    return this.banGate.bannedUntil;
  }

  /** Every outbound request shares admission pacing, weight accounting and the persisted ban. */
  async call<T>(route: RouteName, fn: (client: OpenApiClient) => Promise<T>, background = false): Promise<T> {
    const queuedAt=performance.now();
    if(background&&this.backgroundInFlight)throw new BackgroundBusyError();
    if(background)this.backgroundInFlight=true;
    let release:(()=>void)|undefined,requestedAt:number|undefined,outcome='ok';
    try {
      do {
        release=await this.admit(route,background);
        if(!this.banGate.isBanned)break;
        release();release=undefined;
      }while(true);
      requestedAt=performance.now();
      runtimeMetrics.observe(`gmgn.queue.${route}`,requestedAt-queuedAt);
      // Hold the admission lock through the actual invocation. No catch-up burst after event-loop stalls.
      this.nextStartAt=this.now()+ROUTE_WEIGHTS[route]*1000/this.effectiveRate;
      if(background)this.backgroundNextAt=this.now()+ROUTE_WEIGHTS[route]*1000;
      // Attach ban handling to the transport itself: even a late 429 after our deadline must close the gate.
      let request:Promise<T>;
      try {request=fn(this.client);}
      catch(error){throw this.rateLimit(error,route);}
      request=request.catch(error=>{throw this.rateLimit(error,route);});
      release();release=undefined;
      return await withDeadline(()=>request,this.requestTimeoutMs);
    } catch(error) {
      outcome=error instanceof RateLimitedError?'limited':'error';
      throw error;
    } finally {
      release?.();
      if(background)this.backgroundInFlight=false;
      if(requestedAt!==undefined)runtimeMetrics.observe(`gmgn.request.${route}.${outcome}`,performance.now()-requestedAt);
    }
  }

  /** Low-priority measurement traffic shares the global ban and budget. */
  background() {
    return {
      fetchWalletStats: (wallet: string) => this.call('walletStats', c => c.getWalletStats('sol', [wallet], '7d'), true),
      fetchTokenInfo: (address: string) => this.call('tokenInfo', c => c.getTokenInfo('sol', address), true),
      fetchTokenSecurity: (address: string) => this.call('tokenSecurity', c => c.getTokenSecurity('sol', address), true),
      fetchKline: (address: string, resolution: string, from: number, to: number) =>
        this.call('kline', c => c.getTokenKline('sol', address, resolution, from, to), true),
    };
  }

  // ---- 业务便捷方法（M1-9/M1-12/M1-13 使用） ----

  fetchSmartmoney(limit: number): Promise<unknown> {
    return this.call('smartmoney', (c) => c.getSmartMoney('sol', limit));
  }

  fetchKol(limit: number): Promise<unknown> {
    return this.call('kol', (c) => c.getKol('sol', limit));
  }

  fetchFollowWallet(params: { limit?: number; nextPageToken?: string; wallet?: string }): Promise<unknown> {
    const extra: Record<string, string | number | string[]> = {};
    if (params.limit != null) extra['limit'] = params.limit;
    if (params.nextPageToken) extra['next_page_token'] = params.nextPageToken;
    if (params.wallet) extra['wallet'] = params.wallet;
    return this.call('followWallet', (c) => c.getFollowWallet('sol', extra));
  }

  fetchTokenInfo(address: string): Promise<unknown> {
    return this.call('tokenInfo', (c) => c.getTokenInfo('sol', address));
  }

  fetchTokenSecurity(address: string): Promise<unknown> {
    return this.call('tokenSecurity', (c) => c.getTokenSecurity('sol', address));
  }

  fetchTokenPool(address: string): Promise<unknown> {
    return this.call('tokenPool', (c) => c.getTokenPoolInfo('sol', address));
  }

  async fetchWalletStats(wallets: string[], period = '7d'): Promise<unknown> {
    // 实测 repeated wallet_address 仅返回第一个钱包；逐地址请求并分别计入权重。
    const profiles: unknown[] = [];
    for (const wallet of [...new Set(wallets)]) {
      const data = await this.call('walletStats', (c) => c.getWalletStats('sol', [wallet], period));
      if (Array.isArray(data)) profiles.push(...data);
      else if (data && typeof data === 'object') profiles.push(data);
    }
    return profiles;
  }

  fetchWalletProfits(wallets: string[], period = '7d'): Promise<unknown> {
    return this.call('walletProfits', (c) => c.getWalletProfits('sol', wallets, period));
  }

  fetchWalletActivity(wallet: string, extra: Record<string, string | number> = {}): Promise<unknown> {
    return this.call('walletActivity', (c) => c.getWalletActivity('sol', wallet, extra));
  }

  fetchKline(address: string, resolution: string, from: number, to: number): Promise<unknown> {
    return this.call('kline', (c) => c.getTokenKline('sol', address, resolution, from, to));
  }
}
