import { readFileSync } from 'node:fs';
import type { Logger } from '../logger.js';
import type { Db } from '../store/db.js';

export const WALLET_PROFILE_TTL_SEC = 1800;

export interface WalletProfile {
  address: string;
  name: string | null;
  twitter: string | null;
  tags: string[];
  fundFrom: string | null;
  fundFromAddress: string | null;
  walletCreatedAt: number | null;
  refreshedAt: number;
}

export interface WalletGateway {
  fetchWalletStats(wallets: string[]): Promise<unknown>;
}

export interface EnrichWalletsOptions {
  now?: () => number;
  logger?: Logger;
  /** 单次批量上限（官方限制 100） */
  batchSize?: number;
}

function get(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value === '' ? null : value;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 解析 portfolio stats 响应（实测为单个对象；兼容数组） */
export function parseWalletStats(raw: unknown): WalletProfile[] {
  const rows: Record<string, unknown>[] = Array.isArray(raw)
    ? (raw as Record<string, unknown>[])
    : raw && typeof raw === 'object'
      ? [raw as Record<string, unknown>]
      : [];

  return rows
    .filter((row) => row !== null && typeof row === 'object' && !Array.isArray(row))
    .map((row) => {
      const address = str(row['wallet_address']) ?? str(get(row, 'common.wallet_address'));
      if (!address) return null;
      const tagsRaw = get(row, 'common.tags');
      const tags = Array.isArray(tagsRaw) ? tagsRaw.filter((t): t is string => typeof t === 'string') : [];
      return {
        address,
        name: str(get(row, 'common.name')),
        twitter: str(get(row, 'common.twitter_username')),
        tags,
        fundFrom: str(get(row, 'common.fund_from')),
        fundFromAddress: str(get(row, 'common.fund_from_address')),
        walletCreatedAt: num(get(row, 'common.created_at')),
        refreshedAt: 0,
      } satisfies WalletProfile;
    })
    .filter((p): p is WalletProfile => p !== null);
}

export function upsertWalletProfile(db: Db, profile: WalletProfile): void {
  db.prepare(
    `INSERT INTO wallets (address, name, twitter, tags, fund_from, fund_from_address, wallet_created_at, refreshed_at)
     VALUES (@address, @name, @twitter, @tags, @fund_from, @fund_from_address, @wallet_created_at, @refreshed_at)
     ON CONFLICT(address) DO UPDATE SET
       name = excluded.name, twitter = excluded.twitter, tags = excluded.tags,
       fund_from = excluded.fund_from, fund_from_address = excluded.fund_from_address,
       wallet_created_at = excluded.wallet_created_at, refreshed_at = excluded.refreshed_at`,
  ).run({
    address: profile.address,
    name: profile.name,
    twitter: profile.twitter,
    tags: JSON.stringify(profile.tags),
    fund_from: profile.fundFrom,
    fund_from_address: profile.fundFromAddress,
    wallet_created_at: profile.walletCreatedAt,
    refreshed_at: profile.refreshedAt,
  });
}

export function getWalletProfile(db: Db, address: string): WalletProfile | null {
  const row = db
    .prepare('SELECT * FROM wallets WHERE address = ?')
    .get(address) as
    | {
        address: string;
        name: string | null;
        twitter: string | null;
        tags: string | null;
        fund_from: string | null;
        fund_from_address: string | null;
        wallet_created_at: number | null;
        refreshed_at: number | null;
      }
    | undefined;
  if (!row) return null;
  return {
    address: row.address,
    name: row.name,
    twitter: row.twitter,
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : [],
    fundFrom: row.fund_from,
    fundFromAddress: row.fund_from_address,
    walletCreatedAt: row.wallet_created_at,
    refreshedAt: row.refreshed_at ?? 0,
  };
}

/**
 * 钱包画像富化（M1-13）：批量拉取 portfolio stats 并落库
 * 返回 address → profile 映射（含未命中的地址）
 */
export async function enrichWallets(
  db: Db,
  gateway: WalletGateway,
  addresses: string[],
  options: EnrichWalletsOptions = {},
): Promise<Map<string, WalletProfile>> {
  const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
  const batchSize = options.batchSize ?? 100;
  const unique = [...new Set(addresses.filter((a) => a.length > 0))];
  const out = new Map<string, WalletProfile>();

  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = unique.slice(i, i + batchSize);
    const raw = await gateway.fetchWalletStats(batch);
    const profiles = parseWalletStats(raw);
    for (const profile of profiles) {
      const withTime = { ...profile, refreshedAt: now };
      upsertWalletProfile(db, withTime);
      out.set(profile.address, withTime);
    }
    options.logger?.debug('钱包画像批量完成', { requested: batch.length, received: profiles.length });
  }

  return out;
}

export interface CexBlacklistEntry {
  address: string;
  label: string;
  type: string;
}

export interface CexBlacklist {
  entries: Map<string, CexBlacklistEntry>;
}

/** 加载 CEX / 跨链桥 / 服务地址黑名单（人工维护，见 data/cex-blacklist.json） */
export function loadCexBlacklist(path: string): CexBlacklist {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { entries?: CexBlacklistEntry[] };
  const entries = new Map<string, CexBlacklistEntry>();
  for (const entry of raw.entries ?? []) {
    if (entry.address) entries.set(entry.address, entry);
  }
  return { entries };
}

/** 资金来源是否属于被排除的类别（不据此合并） */
export function isExcludedFunder(
  blacklist: CexBlacklist,
  address: string | null,
  excludeLabels: string[],
): boolean {
  if (!address) return false;
  const entry = blacklist.entries.get(address);
  if (!entry) return false;
  return excludeLabels.includes(entry.type) || excludeLabels.includes(entry.label);
}
