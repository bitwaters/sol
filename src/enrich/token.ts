import type { Logger } from '../logger.js';
import type { Db } from '../store/db.js';

/** 分层缓存 TTL（秒），见 DEVELOPMENT.md §7.4 */
export const CACHE_TTL = {
  price: 60,
  risk: 300,
  basic: 1800,
} as const;

export interface TokenSocials {
  twitter?: string;
  telegram?: string;
  website?: string;
}

export interface TokenSnapshot {
  address: string;
  symbol: string | null;
  name: string | null;
  launchpad: string | null;
  createdAt: number | null;
  price: string | null;
  marketCap: number | null;
  liquidity: number | null;
  holderCount: number | null;
  top10Rate: number | null;
  bundlerRate: number | null;
  insiderRate: number | null;
  entrapmentRate: number | null;
  botDegenRate: number | null;
  freshWalletRate: number | null;
  devHoldRate: number | null;
  sniperCount: number | null;
  creatorTokenStatus: string | null;
  honeypot: number | null;
  renouncedMint: boolean | null;
  renouncedFreeze: boolean | null;
  hasSocial: boolean;
  socials: TokenSocials;
  priceUpdatedAt: number | null;
  riskUpdatedAt: number | null;
  basicUpdatedAt: number | null;
  enrichedAt: number;
  /** 缺失的硬过滤依赖字段（§7.4 缺失值决策表） */
  missing: string[];
}

export interface EnrichGateway {
  fetchTokenInfo(address: string): Promise<unknown>;
  fetchTokenSecurity(address: string): Promise<unknown>;
}

export interface EnrichOptions {
  /** Measurement reads do not overwrite caches concurrently refreshed by live evaluation. */
  persist?: boolean;
  now?: () => number;
  logger?: Logger;
  /** 强制刷新（忽略 TTL） */
  force?: boolean;
}

interface TokenRow {
  address: string;
  symbol: string | null;
  name: string | null;
  launchpad: string | null;
  created_at: number | null;
  price: string | null;
  price_updated_at: number | null;
  risk_updated_at: number | null;
  basic_updated_at: number | null;
  market_cap: number | null;
  liquidity: number | null;
  holder_count: number | null;
  top10_rate: number | null;
  bundler_rate: number | null;
  insider_rate: number | null;
  entrapment_rate: number | null;
  bot_degen_rate: number | null;
  sniper_count: number | null;
  fresh_wallet_rate: number | null;
  dev_hold_rate: number | null;
  creator_token_status: string | null;
  is_honeypot: number | null;
  renounced_mint: number | null;
  renounced_freeze: number | null;
  has_social: number | null;
  socials: string | null;
  enriched_at: number | null;
}

function get(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value === '' ? null : value;
  if (typeof value === 'number') return String(value);
  return null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function bool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return null;
}

export interface ParsedTokenInfo {
  symbol: string | null;
  name: string | null;
  launchpad: string | null;
  createdAt: number | null;
  price: string | null;
  marketCap: number | null;
  liquidity: number | null;
  holderCount: number | null;
  top10Rate: number | null;
  bundlerRate: number | null;
  insiderRate: number | null;
  entrapmentRate: number | null;
  botDegenRate: number | null;
  freshWalletRate: number | null;
  devHoldRate: number | null;
  sniperCount: number | null;
  creatorTokenStatus: string | null;
  hasSocial: boolean;
  socials: TokenSocials;
}

export function parseTokenInfo(raw: unknown): ParsedTokenInfo {
  const rawPrice = str(get(raw, 'price.price'));
  const priceStr = rawPrice !== null && Number.isFinite(Number(rawPrice)) && Number(rawPrice) > 0 ? rawPrice : null;
  const supply = num(get(raw, 'circulating_supply'));
  const marketCap = priceStr !== null && supply !== null ? Number(priceStr) * supply : null;
  const twitter = str(get(raw, 'link.twitter_username')) ?? undefined;
  const telegram = str(get(raw, 'link.telegram')) ?? undefined;
  const website = str(get(raw, 'link.website')) ?? undefined;
  return {
    symbol: str(get(raw, 'symbol')),
    name: str(get(raw, 'name')),
    launchpad: str(get(raw, 'launchpad_platform')),
    createdAt: num(get(raw, 'creation_timestamp')),
    price: priceStr,
    marketCap: marketCap !== null && Number.isFinite(marketCap) && marketCap >= 0 ? marketCap : null,
    liquidity: num(get(raw, 'liquidity')),
    holderCount: num(get(raw, 'holder_count')),
    top10Rate: num(get(raw, 'stat.top_10_holder_rate')),
    bundlerRate: num(get(raw, 'stat.top_bundler_trader_percentage')),
    insiderRate: num(get(raw, 'stat.top_rat_trader_percentage')),
    entrapmentRate: num(get(raw, 'stat.top_entrapment_trader_percentage')),
    botDegenRate: num(get(raw, 'stat.bot_degen_rate')),
    freshWalletRate: num(get(raw, 'stat.fresh_wallet_rate')),
    devHoldRate: num(get(raw, 'stat.dev_team_hold_rate')),
    sniperCount: num(get(raw, 'wallet_tags_stat.sniper_wallets')),
    creatorTokenStatus: str(get(raw, 'dev.creator_token_status')),
    hasSocial: Boolean(twitter ?? telegram ?? website),
    socials: { twitter, telegram, website },
  };
}

export interface ParsedTokenSecurity {
  top10Rate: number | null;
  honeypot: number | null;
  renouncedMint: boolean | null;
  renouncedFreeze: boolean | null;
}

export function parseTokenSecurity(raw: unknown): ParsedTokenSecurity {
  return {
    top10Rate: num(get(raw, 'top_10_holder_rate')),
    honeypot: num(get(raw, 'honeypot')),
    renouncedMint: bool(get(raw, 'renounced_mint')),
    renouncedFreeze: bool(get(raw, 'renounced_freeze_account')),
  };
}

export function rowToSnapshot(row: TokenRow): TokenSnapshot {
  return {
    address: row.address,
    symbol: row.symbol,
    name: row.name,
    launchpad: row.launchpad,
    createdAt: row.created_at,
    price: row.price,
    marketCap: row.market_cap,
    liquidity: row.liquidity,
    holderCount: row.holder_count,
    top10Rate: row.top10_rate,
    bundlerRate: row.bundler_rate,
    insiderRate: row.insider_rate,
    entrapmentRate: row.entrapment_rate,
    botDegenRate: row.bot_degen_rate,
    freshWalletRate: row.fresh_wallet_rate,
    devHoldRate: row.dev_hold_rate,
    sniperCount: row.sniper_count,
    creatorTokenStatus: row.creator_token_status,
    honeypot: row.is_honeypot,
    renouncedMint: row.renounced_mint === null ? null : row.renounced_mint !== 0,
    renouncedFreeze: row.renounced_freeze === null ? null : row.renounced_freeze !== 0,
    hasSocial: row.has_social === 1,
    socials: row.socials ? (JSON.parse(row.socials) as TokenSocials) : {},
    priceUpdatedAt: row.price_updated_at,
    riskUpdatedAt: row.risk_updated_at,
    basicUpdatedAt: row.basic_updated_at,
    enrichedAt: row.enriched_at ?? 0,
    missing: [],
  };
}

const HARD_FIELDS: Array<[keyof TokenSnapshot, string]> = [
  ['price', 'price'],
  ['marketCap', 'market_cap'],
  ['createdAt', 'created_at'],
  ['liquidity', 'liquidity'],
  ['holderCount', 'holder_count'],
  ['top10Rate', 'top_10_holder_rate'],
  ['bundlerRate', 'bundler_rate'],
  ['insiderRate', 'insider_rate'],
  ['entrapmentRate', 'entrapment_rate'],
  ['botDegenRate', 'bot_degen_rate'],
  ['freshWalletRate', 'fresh_wallet_rate'],
  ['devHoldRate', 'dev_hold_rate'],
  ['sniperCount', 'sniper_count'],
  ['honeypot', 'honeypot'],
  ['renouncedMint', 'renounced_mint'],
  ['renouncedFreeze', 'renounced_freeze'],
];

export function computeMissing(snapshot: TokenSnapshot): string[] {
  const missing: string[] = [];
  for (const [key, label] of HARD_FIELDS) {
    const value = snapshot[key];
    if (value === null || value === undefined) missing.push(label);
  }
  return missing;
}

export function getCachedToken(db: Db, address: string): TokenRow | null {
  return (db.prepare('SELECT * FROM tokens WHERE address = ?').get(address) as TokenRow | undefined) ?? null;
}

function upsertToken(db: Db, snapshot: TokenSnapshot): void {
  db.prepare(
    `INSERT INTO tokens (
      address, symbol, name, launchpad, created_at,
      price, price_updated_at, risk_updated_at, basic_updated_at,
      market_cap, liquidity, holder_count,
      top10_rate, bundler_rate, insider_rate, entrapment_rate, bot_degen_rate,
      sniper_count, fresh_wallet_rate, dev_hold_rate, creator_token_status,
      is_honeypot, renounced_mint, renounced_freeze, has_social, socials, enriched_at
    ) VALUES (
      @address, @symbol, @name, @launchpad, @created_at,
      @price, @price_updated_at, @risk_updated_at, @basic_updated_at,
      @market_cap, @liquidity, @holder_count,
      @top10_rate, @bundler_rate, @insider_rate, @entrapment_rate, @bot_degen_rate,
      @sniper_count, @fresh_wallet_rate, @dev_hold_rate, @creator_token_status,
      @is_honeypot, @renounced_mint, @renounced_freeze, @has_social, @socials, @enriched_at
    ) ON CONFLICT(address) DO UPDATE SET
      symbol = excluded.symbol, name = excluded.name, launchpad = excluded.launchpad,
      created_at = excluded.created_at,
      price = excluded.price, price_updated_at = excluded.price_updated_at,
      risk_updated_at = excluded.risk_updated_at, basic_updated_at = excluded.basic_updated_at,
      market_cap = excluded.market_cap, liquidity = excluded.liquidity, holder_count = excluded.holder_count,
      top10_rate = excluded.top10_rate, bundler_rate = excluded.bundler_rate, insider_rate = excluded.insider_rate,
      entrapment_rate = excluded.entrapment_rate, bot_degen_rate = excluded.bot_degen_rate,
      sniper_count = excluded.sniper_count, fresh_wallet_rate = excluded.fresh_wallet_rate,
      dev_hold_rate = excluded.dev_hold_rate, creator_token_status = excluded.creator_token_status,
      is_honeypot = excluded.is_honeypot, renounced_mint = excluded.renounced_mint,
      renounced_freeze = excluded.renounced_freeze, has_social = excluded.has_social,
      socials = excluded.socials, enriched_at = excluded.enriched_at`,
  ).run({
    address: snapshot.address,
    symbol: snapshot.symbol,
    name: snapshot.name,
    launchpad: snapshot.launchpad,
    created_at: snapshot.createdAt,
    price: snapshot.price,
    price_updated_at: snapshot.priceUpdatedAt,
    risk_updated_at: snapshot.riskUpdatedAt,
    basic_updated_at: snapshot.basicUpdatedAt,
    market_cap: snapshot.marketCap,
    liquidity: snapshot.liquidity,
    holder_count: snapshot.holderCount,
    top10_rate: snapshot.top10Rate,
    bundler_rate: snapshot.bundlerRate,
    insider_rate: snapshot.insiderRate,
    entrapment_rate: snapshot.entrapmentRate,
    bot_degen_rate: snapshot.botDegenRate,
    sniper_count: snapshot.sniperCount,
    fresh_wallet_rate: snapshot.freshWalletRate,
    dev_hold_rate: snapshot.devHoldRate,
    creator_token_status: snapshot.creatorTokenStatus,
    is_honeypot: snapshot.honeypot,
    renounced_mint: snapshot.renouncedMint === null ? null : snapshot.renouncedMint ? 1 : 0,
    renounced_freeze: snapshot.renouncedFreeze === null ? null : snapshot.renouncedFreeze ? 1 : 0,
    has_social: snapshot.hasSocial ? 1 : 0,
    socials: JSON.stringify(snapshot.socials),
    enriched_at: snapshot.enrichedAt,
  });
}

/**
 * token 富化（M1-12）：分层缓存 + 字段映射（§6.2）
 * - 价格 60s / 风险 5min / 基础资料 30min
 * - token info 提供价格与大部分风险字段；token security 提供 honeypot 与权限
 */
export async function enrichToken(
  db: Db,
  gateway: EnrichGateway,
  address: string,
  options: EnrichOptions = {},
): Promise<TokenSnapshot> {
  const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
  const cached = getCachedToken(db, address);

  const priceStale =
    options.force === true ||
    cached === null ||
    cached.price_updated_at === null ||
    now - cached.price_updated_at > CACHE_TTL.price;
  const riskStale =
    options.force === true ||
    cached === null ||
    cached.risk_updated_at === null ||
    now - cached.risk_updated_at > CACHE_TTL.risk;
  const basicStale =
    options.force === true ||
    cached === null ||
    cached.basic_updated_at === null ||
    now - cached.basic_updated_at > CACHE_TTL.basic;

  const base: TokenSnapshot = cached
    ? rowToSnapshot(cached)
    : {
        address,
        symbol: null,
        name: null,
        launchpad: null,
        createdAt: null,
        price: null,
        marketCap: null,
        liquidity: null,
        holderCount: null,
        top10Rate: null,
        bundlerRate: null,
        insiderRate: null,
        entrapmentRate: null,
        botDegenRate: null,
        freshWalletRate: null,
        devHoldRate: null,
        sniperCount: null,
        creatorTokenStatus: null,
        honeypot: null,
        renouncedMint: null,
        renouncedFreeze: null,
        hasSocial: false,
        socials: {},
        priceUpdatedAt: null,
        riskUpdatedAt: null,
        basicUpdatedAt: null,
        enrichedAt: 0,
        missing: [],
      };

  const snapshot: TokenSnapshot = { ...base, address };

  if (priceStale || basicStale || riskStale) {
    options.logger?.debug('富化 token info', { address, priceStale, riskStale, basicStale });
    const infoRaw = await gateway.fetchTokenInfo(address);
    const info = parseTokenInfo(infoRaw);
    if (priceStale) {
      snapshot.price = info.price;
      snapshot.priceUpdatedAt = now;
    }
    if (basicStale) {
      snapshot.symbol = info.symbol;
      snapshot.name = info.name;
      snapshot.launchpad = info.launchpad;
      snapshot.createdAt = info.createdAt;
      snapshot.hasSocial = info.hasSocial;
      snapshot.socials = info.socials;
      snapshot.basicUpdatedAt = now;
    }
    if (riskStale) {
      snapshot.marketCap = info.marketCap;
      snapshot.liquidity = info.liquidity;
      snapshot.holderCount = info.holderCount;
      snapshot.top10Rate = info.top10Rate;
      snapshot.bundlerRate = info.bundlerRate;
      snapshot.insiderRate = info.insiderRate;
      snapshot.entrapmentRate = info.entrapmentRate;
      snapshot.botDegenRate = info.botDegenRate;
      snapshot.freshWalletRate = info.freshWalletRate;
      snapshot.devHoldRate = info.devHoldRate;
      snapshot.sniperCount = info.sniperCount;
      snapshot.creatorTokenStatus = info.creatorTokenStatus;
      snapshot.riskUpdatedAt = now;
    }
  }

  if (riskStale) {
    options.logger?.debug('富化 token security', { address });
    const securityRaw = await gateway.fetchTokenSecurity(address);
    const security = parseTokenSecurity(securityRaw);
    snapshot.honeypot = security.honeypot;
    snapshot.renouncedMint = security.renouncedMint;
    snapshot.renouncedFreeze = security.renouncedFreeze;
    if (snapshot.top10Rate === null) snapshot.top10Rate = security.top10Rate;
  }

  snapshot.enrichedAt = now;
  snapshot.missing = computeMissing(snapshot);
  if (options.persist !== false) upsertToken(db, snapshot);
  return snapshot;
}
