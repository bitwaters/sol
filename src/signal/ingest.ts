import type { NormalizedTrade } from '../ingest/normalize.js';
import type { Logger } from '../logger.js';
import { getKv, setKv, type Db } from '../store/db.js';
import { checkIntegrity } from './integrity.js';
import { applyTrade, getLatestCycle } from './positions.js';
import { rebuildWalletToken } from './rebuild.js';

/** 在 ingestBatch 的事务中应用成交；迟到事件（含同秒乱序）统一重放。 */
export function applyIngestedTrades(db: Db, trades: NormalizedTrade[], dustRatio: number, logger?: Logger): void {
  const now = Math.floor(Date.now() / 1000);
  const gaps = checkIntegrity(db, ['smartmoney', 'kol', 'follow'], now);
  const hasGap = gaps.recentGaps.length + gaps.acceptedGaps.length > 0;
  const observationStartedAt = getKv<number>(db, 'observation_started_at');
  const late = new Map<string, { wallet: string; token: string; from: number }>();
  for (const trade of trades) {
    const key = `${trade.maker}:${trade.baseAddress}`;
    if (hasGap) {
      setKv(db, `gap_affected:${trade.baseAddress}:${trade.maker}`, true, now);
      const key = `gap_affected_until:${trade.baseAddress}:${trade.maker}`;
      setKv(db, key, Math.max(getKv<number>(db, key) ?? 0, ...[...gaps.recentGaps, ...gaps.acceptedGaps].map(gap => gap.gapTo)), now);
    }
    const latest = getLatestCycle(db, trade.maker, trade.baseAddress);
    if (latest?.lastTradeTs != null && trade.timestamp <= latest.lastTradeTs) {
      const previous = late.get(key);
      late.set(key, { wallet: trade.maker, token: trade.baseAddress, from: Math.min(previous?.from ?? trade.timestamp, trade.timestamp) });
    } else if (!late.has(key)) {
      applyTrade(db, trade, { dustRatio, hasRecentGap: hasGap, observationStartedAt });
    }
  }
  for (const { wallet, token, from } of late.values()) {
    const row = db.prepare('SELECT created_at FROM tokens WHERE address = ?').get(token) as { created_at: number | null } | undefined;
    rebuildWalletToken(db, wallet, token, from, {
      dustRatio, hasRecentGap: hasGap, observationStartedAt, tokenCreatedAt: row?.created_at ?? null,
    }, logger);
  }
}
