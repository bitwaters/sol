import type { OpenApiClient } from '../gmgn/OpenApiClient.js';
import type { Logger } from '../logger.js';
import { BanGate, TokenBucket } from './limiter.js';
import { runtimeMetrics } from '../ops/metrics.js';

/** 端点权重（来源：GMGN 官方 skill 文档，§4.2） */
export const ROUTE_WEIGHTS = {
  smartmoney: 1,
  kol: 1,
  followWallet: 3,
  tokenInfo: 1,
  tokenSecurity: 1,
  tokenPool: 1,
  walletActivity: 3,
  walletStats: 3,
  walletProfits: 3,
  walletHoldings: 5,
  kline: 2,
} as const;

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
  const candidate = err as { apiError?: unknown; resetAtUnix?: unknown; status?: number };
  if (candidate.status !== 429 && candidate.apiError !== 'RATE_LIMIT_EXCEEDED' && candidate.apiError !== 'RATE_LIMIT_BANNED') {
    return null;
  }
  return {
    apiError: typeof candidate.apiError === 'string' ? candidate.apiError : 'HTTP_429',
    resetAtUnix:
      typeof candidate.resetAtUnix === 'number' && candidate.resetAtUnix > 0
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
}

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

  constructor(options: GmgnGatewayOptions) {
    this.client = options.client;
    this.limiter = options.limiter;
    this.banGate = options.banGate;
    this.logger = options.logger;
    this.now = options.now ?? (() => Date.now());
  }

  get isBanned(): boolean {
    return this.banGate.isBanned;
  }

  get bannedUntil(): number | null {
    return this.banGate.bannedUntil;
  }

  /** 调用前：封禁门 → 权重获取 → 再查封禁门（等待期间可能新增封禁）→ 执行 */
  async call<T>(route: RouteName, fn: (client: OpenApiClient) => Promise<T>): Promise<T> {
    const queuedAt = performance.now();
    // 排队期间可能新增封禁；过期的额度不能攒到解禁后集中释放。
    while (true) {
      await this.banGate.waitIfBanned();
      await this.limiter.acquire(ROUTE_WEIGHTS[route]);
      if (!this.banGate.isBanned) break;
    }
    const requestedAt = performance.now();
    runtimeMetrics.observe(`gmgn.queue.${route}`, requestedAt - queuedAt);
    let outcome = 'ok';
    try {
      return await fn(this.client);
    } catch (err) {
      outcome = 'error';
      const rateLimit = extractRateLimitInfo(err);
      if (rateLimit) {
        outcome = 'limited';
        const resetAtMs =
          rateLimit.resetAtUnix != null
            ? rateLimit.resetAtUnix * 1000 + 1000
            : this.now() + 5 * 60 * 1000;
        this.banGate.banUntil(resetAtMs, rateLimit.apiError);
        this.logger?.warn('GMGN 限频封禁', {
          route,
          apiError: rateLimit.apiError,
          resetAt: new Date(resetAtMs).toISOString(),
        });
        throw new RateLimitedError(resetAtMs, rateLimit.apiError);
      }
      throw err;
    } finally {
      runtimeMetrics.observe(`gmgn.request.${route}.${outcome}`, performance.now() - requestedAt);
    }
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
