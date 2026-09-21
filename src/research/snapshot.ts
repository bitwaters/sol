import { gzipSync, gunzipSync } from 'node:zlib';
import type { AppConfig } from '../config.js';
import { getCachedToken, rowToSnapshot, type TokenSnapshot } from '../enrich/token.js';
import { type CexBlacklist, type CexBlacklistEntry, type WalletProfile } from '../enrich/wallet.js';
import { openDatabase, type Db } from '../store/db.js';
import type { ResearchConfig } from './config.js';

type Row = Record<string, string | number | null>;
export interface FrozenSnapshot {
  token: string; at: number; config: AppConfig; maxWindowMinutes: number;
  tables: Record<string, Row[]>; observedBuys: Record<string, number>;
  quote: TokenSnapshot | null; blacklist: CexBlacklistEntry[];
}
export class SnapshotLimitError extends Error {}
/** Capture only what is available NOW, including event arrival time and source arrival time.
 * Freeze the entire retained token history of every wallet appearing within the maximum replay window.
 * Wallets outside that window cannot vote, contribute net flow, or bridge same-tx clustering (which only uses window members).
 * Their unrelated history is omitted; relevant wallet histories are never truncated. */
export function freezeSnapshot(db: Db, token: string, at: number, config: AppConfig, research: ResearchConfig,
  blacklist: CexBlacklist, quote?: TokenSnapshot, profiles: WalletProfile[] = []): FrozenSnapshot {
  const trades = db.prepare(`WITH relevant AS (SELECT DISTINCT maker FROM trades WHERE base_address=? AND timestamp BETWEEN ? AND ?)
    SELECT * FROM trades WHERE base_address=? AND timestamp<=? AND maker IN (SELECT maker FROM relevant)
    ORDER BY timestamp,event_id LIMIT ?`)
    .all(token,at-research.windowMinutes*60,at,token,at,research.maxSnapshotTrades + 1) as Row[];
  const makers = [...new Set(trades.map(t => String(t.maker)))];
  if (trades.length > research.maxSnapshotTrades || makers.length > research.maxSnapshotWallets)
    throw new SnapshotLimitError('snapshot_size_limit');
  const tables: Record<string, Row[]> = { trades };
  const tokenRow = getCachedToken(db, token);
  tables.tokens = db.prepare('SELECT * FROM tokens WHERE address=?').all(token) as Row[];
  const marks=makers.map(()=>'?').join(',')||'NULL';
  tables.trade_sources = db.prepare(`SELECT s.* FROM trade_sources s JOIN trades t ON s.event_id=t.event_id
    WHERE t.base_address=? AND t.timestamp<=? AND t.maker IN (${marks})`).all(token,at,...makers) as Row[];
  tables.wallet_positions = db.prepare(`SELECT * FROM wallet_positions WHERE token=? AND wallet IN (${marks})`).all(token,...makers) as Row[];
  tables.position_checkpoints = db.prepare(`SELECT * FROM position_checkpoints WHERE token=? AND checked_at<=? AND wallet IN (${marks})`).all(token,at,...makers) as Row[];
  tables.wallets = []; const observedBuys: Record<string, number> = {};
  for (const maker of makers) {
    const row = db.prepare('SELECT * FROM wallets WHERE address=?').get(maker) as Row | undefined;
    if (row) tables.wallets.push(row);
    observedBuys[maker] = (db.prepare("SELECT COUNT(*) n FROM trades WHERE maker=? AND side='buy' AND timestamp<=?")
      .get(maker, at) as { n: number }).n;
  }
  // Network enrichment stays inside the frozen research payload and never mutates foreground caches.
  for (const p of profiles) {
    if (!makers.includes(p.address) || p.refreshedAt > at) continue;
    tables.wallets = tables.wallets.filter(w => w.address !== p.address);
    tables.wallets.push({ address: p.address, name: p.name, twitter: p.twitter, tags: JSON.stringify(p.tags),
      fund_from: p.fundFrom, fund_from_address: p.fundFromAddress, wallet_created_at: p.walletCreatedAt, refreshed_at: p.refreshedAt });
  }
  tables.data_gaps = db.prepare('SELECT * FROM data_gaps WHERE from_ts<=? AND to_ts>=?')
    .all(at, Math.min(at - research.windowMinutes * 60, ...trades.map(t=>Number(t.timestamp)))) as Row[];
  tables.position_jobs=db.prepare('SELECT * FROM position_jobs WHERE token=?').all(token) as Row[];
  tables.cost_invalidation_job=db.prepare('SELECT * FROM cost_invalidation_job').all() as Row[];
  tables.source_health = db.prepare('SELECT * FROM source_health').all() as Row[];
  tables.source_outages = db.prepare('SELECT * FROM source_outages WHERE from_ts<=? AND to_ts>=?')
    .all(at, Math.min(at - research.windowMinutes * 60, ...trades.map(t=>Number(t.timestamp)))) as Row[];
  tables.kv = db.prepare(`SELECT * FROM kv WHERE key IN ('quality_tracking_started_at','observation_started_at','enabled_sources','service_started_at','paused',?,?,?,?)`)
    .all(`mute:${token}`, `rebuild_paused:${token}`, `hardblock:${token}`, `retrigger:${token}`) as Row[];
  for(const maker of makers)tables.kv.push(...db.prepare('SELECT * FROM kv WHERE key IN (?,?)')
    .all(`gap_affected:${token}:${maker}`,`gap_affected_until:${token}:${maker}`) as Row[]);
  return { token, at, config: structuredClone(config), maxWindowMinutes: research.windowMinutes, tables, observedBuys,
    quote: quote ?? (tokenRow ? rowToSnapshot(tokenRow) : null), blacklist: [...blacklist.entries.values()] };
}
export const pack = (snapshot: FrozenSnapshot): Buffer => gzipSync(JSON.stringify(snapshot));
export const unpack = (data: Buffer): FrozenSnapshot => JSON.parse(gunzipSync(data).toString('utf8')) as FrozenSnapshot;
const allowed = new Set(['trades','tokens','trade_sources','wallet_positions','position_checkpoints','wallets','data_gaps','source_outages','source_health','kv','position_jobs','cost_invalidation_job']);
export function restoreSnapshot(snapshot: FrozenSnapshot): Db {
  const db = openDatabase({ path: ':memory:' });
  try {
    db.prepare('DELETE FROM kv').run();
    db.transaction(() => {
      for (const [table, rows] of Object.entries(snapshot.tables)) {
        if (!allowed.has(table)) throw new Error('Invalid research snapshot table');
        const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(r => r.name));
        for (const row of rows) {
          const keys = Object.keys(row);
          if (!keys.length || keys.some(key => !columns.has(key))) throw new Error('Invalid research snapshot columns');
          db.prepare(`INSERT OR REPLACE INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(k => row[k]!));
        }
      }
    })();
    return db;
  } catch (error) { db.close(); throw error; }
}
