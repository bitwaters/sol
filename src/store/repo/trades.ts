import { measureSync } from '../../ops/metrics.js';
import { Decimal } from 'decimal.js';
import type { Db } from '../db.js';
import { normalizeTrackItem, type NormalizedTrade, type TradeSource } from '../../ingest/normalize.js';
import { getSourceHealth, upsertSourceHealth, type SourceHealth } from './health.js';

const INSERT_TRADE_SQL = `
INSERT OR IGNORE INTO trades (
  event_id, chain, tx_hash, maker, side, base_address, symbol,
  raw_amount, raw_amount_unit, raw_decimals, amount_normalized,
  amount_usd, amount_usd_num, price_usd, action_hint, is_open_or_close,
  timestamp, raw, created_at
) VALUES (
  @event_id, @chain, @tx_hash, @maker, @side, @base_address, @symbol,
  @raw_amount, @raw_amount_unit, @raw_decimals, @amount_normalized,
  @amount_usd, @amount_usd_num, @price_usd, @action_hint, @is_open_or_close,
  @timestamp, @raw, @created_at
)`;

export interface UpsertResult {
  insertedEvents: number;
  newSourceObservations: number;
  total: number;
  /** 本批真正新插入的事件（按成交时间升序） */
  insertedTrades: NormalizedTrade[];
  updatedTrades: NormalizedTrade[];
}

export interface IngestResult extends UpsertResult {
  health: SourceHealth;
}

/** 同 tx/钱包/代币/方向/秒，数量、quote、USD 同时接近且匹配唯一时合并。公开源缺少 quote_address；两边均提供时必须一致。 */
export function findCanonicalEventId(db: Db, source: TradeSource, trade: NormalizedTrade): string | null {
  const alias = db.prepare('SELECT event_id FROM trade_event_aliases WHERE source=? AND alias_id=?').get(source, trade.eventId) as { event_id: string } | undefined;
  if (alias) return alias.event_id;
  if (eventExists(db, trade.eventId)) return trade.eventId;
  const candidates = db.prepare(`SELECT t.event_id, t.amount_normalized, t.raw FROM trades t
    WHERE t.chain=? AND t.tx_hash=? AND t.maker=? AND t.base_address=? AND t.side=? AND t.timestamp=?
      AND NOT EXISTS (SELECT 1 FROM trade_sources s WHERE s.event_id=t.event_id AND s.source=?)`)
    .all(trade.chain, trade.txHash, trade.maker, trade.baseAddress, trade.side, trade.timestamp, source) as Array<{ event_id: string; amount_normalized: string | null; raw: string | null }>;
  const close = (a: unknown, b: unknown): boolean => {
    if (a == null || b == null) return false;
    try { const x = new Decimal(String(a)); const y = new Decimal(String(b));
      return x.isFinite() && y.isFinite() && x.gte(0) && y.gte(0) && x.minus(y).abs().lte(Decimal.max(x.abs(), y.abs()).mul('0.000001'));
    } catch { return false; }
  };
  const incoming = trade.raw as Record<string, unknown> | null;
  const matches = candidates.filter(row => {
    let raw: Record<string, unknown>; try { raw = JSON.parse(row.raw ?? '{}') as Record<string, unknown>; } catch { return false; }
    return raw && incoming &&
      (raw['quote_address'] == null || incoming['quote_address'] == null || raw['quote_address'] === incoming['quote_address']) &&
      close(row.amount_normalized, trade.amountNormalized) && close(raw['quote_amount'], incoming['quote_amount']) &&
      close(raw['amount_usd'], incoming['amount_usd']);
  });
  return matches.length === 1 ? matches[0]!.event_id : null;
}

/** 从事件权威数值和各来源观测恢复重放输入；follow 全仓提示、公开源余额各自保留。 */
export function readStoredTrade(db: Db, eventId: string): NormalizedTrade {
  const row = db.prepare('SELECT * FROM trades WHERE event_id=?').get(eventId) as Record<string, any>;
  const observations = db.prepare('SELECT source,raw FROM trade_sources WHERE event_id=? ORDER BY first_seen_at,source').all(eventId) as Array<{ source: TradeSource; raw: string }>;
  let balance: string | null = null;
  for (const observation of observations) {
    const normalized = normalizeTrackItem(observation.source, JSON.parse(observation.raw));
    if (normalized?.balance !== null && normalized?.balance !== undefined) balance = normalized.balance;
  }
  return { eventId, chain: row['chain'], txHash: row['tx_hash'], maker: row['maker'], side: row['side'],
    baseAddress: row['base_address'], symbol: row['symbol'], rawAmount: row['raw_amount'],
    rawAmountUnit: row['raw_amount_unit'], rawDecimals: row['raw_decimals'], amountNormalized: row['amount_normalized'],
    amountUsd: row['amount_usd'], amountUsdNum: row['amount_usd_num'], priceUsd: row['price_usd'],
    actionHint: row['action_hint'], isOpenOrClose: row['is_open_or_close'], balance,
    timestamp: row['timestamp'], raw: row['raw'] ? JSON.parse(row['raw']) : null };
}

/**
 * 幂等写入成交事件与来源观测：
 * - 事件金额只累计一次（event_id 主键）
 * - 同一事件出现在多个来源时只追加 trade_sources
 */
export function upsertTrades(
  db: Db,
  source: TradeSource,
  trades: NormalizedTrade[],
  now = Math.floor(Date.now() / 1000),
): UpsertResult {
  const insertTrade = db.prepare(INSERT_TRADE_SQL);
  const insertSource = db.prepare(
    `INSERT OR IGNORE INTO trade_sources (event_id, source, raw_is_open_or_close, raw, first_seen_at)
     VALUES (?, ?, ?, ?, ?)`,
  );

  const run = db.transaction((items: NormalizedTrade[]): UpsertResult => {
    let insertedEvents = 0;
    let newSourceObservations = 0;
    const insertedTrades: NormalizedTrade[] = [];
    const updatedTrades: NormalizedTrade[] = [];
    for (const incoming of items) {
      const canonicalId = findCanonicalEventId(db, source, incoming) ?? incoming.eventId;
      const trade = { ...incoming, eventId: canonicalId };
      const res = insertTrade.run({
        event_id: trade.eventId,
        chain: trade.chain,
        tx_hash: trade.txHash,
        maker: trade.maker,
        side: trade.side,
        base_address: trade.baseAddress,
        symbol: trade.symbol,
        raw_amount: trade.rawAmount,
        raw_amount_unit: trade.rawAmountUnit,
        raw_decimals: trade.rawDecimals,
        amount_normalized: trade.amountNormalized,
        amount_usd: trade.amountUsd,
        amount_usd_num: trade.amountUsdNum,
        price_usd: trade.priceUsd,
        action_hint: trade.actionHint,
        is_open_or_close: trade.isOpenOrClose,
        timestamp: trade.timestamp,
        raw: JSON.stringify(trade.raw),
        created_at: now,
      });
      if (res.changes > 0) {
        insertedEvents += 1;
        insertedTrades.push(trade);
      }

      db.prepare('INSERT OR IGNORE INTO trade_event_aliases(source,alias_id,event_id) VALUES (?,?,?)').run(source, incoming.eventId, canonicalId);
      const sourceRes = insertSource.run(
        trade.eventId,
        source,
        trade.isOpenOrClose,
        JSON.stringify(trade.raw),
        now,
      );
      if (sourceRes.changes > 0) {
        newSourceObservations += 1;
        if (source === 'follow' && trade.actionHint !== null) {
          db.prepare('UPDATE trades SET action_hint=? WHERE event_id=?').run(trade.actionHint, canonicalId);
        }
        if (res.changes === 0) updatedTrades.push(readStoredTrade(db, canonicalId));
      }
    }
    return { insertedEvents, newSourceObservations, total: items.length, insertedTrades, updatedTrades };
  });

  return run(trades);
}

/**
 * 采集批处理：成交流 + 来源观测 + 水位/缺口 在同一事务内完成
 */
export function ingestBatch(
  db: Db,
  source: TradeSource,
  trades: NormalizedTrade[],
  healthPatch: Partial<SourceHealth> & { source: string },
  now = Math.floor(Date.now() / 1000),
  onInserted?: (inserted: NormalizedTrade[]) => void,
): IngestResult {
  const run = db.transaction((): IngestResult => {
    const result = measureSync(`poll.store.${source}`,()=>upsertTrades(db, source, trades, now));
    measureSync(`poll.health.${source}`,()=>upsertSourceHealth(db, healthPatch, now));
    if (onInserted && result.insertedTrades.length + result.updatedTrades.length > 0) {
      measureSync(`poll.enqueue.${source}`,()=>onInserted([...result.insertedTrades, ...result.updatedTrades].sort((a, b) => a.timestamp - b.timestamp || a.eventId.localeCompare(b.eventId))));
    }
    return { ...result, health: getSourceHealth(db, source) };
  });
  return run();
}

export function countTrades(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM trades').get() as { n: number };
  return row.n;
}

/** 事件是否已入库（用于采集重叠检测） */
export function eventExists(db: Db, eventId: string): boolean {
  const row = db.prepare('SELECT 1 AS ok FROM trades WHERE event_id = ?').get(eventId) as
    | { ok: number }
    | undefined;
  return row !== undefined;
}

export function countTradeSources(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM trade_sources').get() as { n: number };
  return row.n;
}
