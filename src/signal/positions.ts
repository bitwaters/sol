import { Decimal } from 'decimal.js';
import type { NormalizedTrade } from '../ingest/normalize.js';
import { getKv, setKv, type Db } from '../store/db.js';

export type PositionState = 'open' | 'closed' | 'unknown' | 'incomplete';

export interface PositionCycle {
  wallet: string;
  token: string;
  cycleNo: number;
  state: PositionState;
  costComplete: boolean;
  boughtAmount: Decimal;
  soldAmount: Decimal;
  boughtUsd: Decimal;
  soldUsd: Decimal;
  avgEntryPriceUsd: Decimal | null;
  cycleStartedAt: number | null;
  lastBuyTs: number | null;
  lastSellTs: number | null;
  lastTradeTs: number | null;
  confidence: number;
}

export interface PositionContext {
  /** 代币创建时间（token info） */
  tokenCreatedAt?: number | null;
  /** 本地开始观测时间（kv: observation_started_at） */
  observationStartedAt?: number | null;
  /** 该 token 涉及的来源是否存在近期缺口 */
  hasRecentGap?: boolean;
  /** 清仓灰尘阈值（余量/买入量） */
  dustRatio: number;
}

interface PositionRow {
  wallet: string;
  token: string;
  cycle_no: number;
  state: PositionState;
  cost_complete: number;
  bought_amount: string;
  sold_amount: string;
  bought_usd: string;
  sold_usd: string;
  avg_entry_price_usd: string | null;
  cycle_started_at: number | null;
  last_buy_ts: number | null;
  last_sell_ts: number | null;
  last_trade_ts: number | null;
  confidence: number;
}

function dec(value: string | null | undefined): Decimal {
  if (value === null || value === undefined || value === '') return new Decimal(0);
  return new Decimal(value);
}

function rowToCycle(row: PositionRow): PositionCycle {
  return {
    wallet: row.wallet,
    token: row.token,
    cycleNo: row.cycle_no,
    state: row.state,
    costComplete: row.cost_complete === 1,
    boughtAmount: dec(row.bought_amount),
    soldAmount: dec(row.sold_amount),
    boughtUsd: dec(row.bought_usd),
    soldUsd: dec(row.sold_usd),
    avgEntryPriceUsd: row.avg_entry_price_usd ? dec(row.avg_entry_price_usd) : null,
    cycleStartedAt: row.cycle_started_at,
    lastBuyTs: row.last_buy_ts,
    lastSellTs: row.last_sell_ts,
    lastTradeTs: row.last_trade_ts,
    confidence: row.confidence,
  };
}

export function getLatestCycle(db: Db, wallet: string, token: string): PositionCycle | null {
  const row = db
    .prepare(
      'SELECT * FROM wallet_positions WHERE wallet = ? AND token = ? ORDER BY cycle_no DESC LIMIT 1',
    )
    .get(wallet, token) as PositionRow | undefined;
  return row ? rowToCycle(row) : null;
}

export function getOpenPositionsForToken(db: Db, token: string): PositionCycle[] {
  const rows = db
    .prepare(
      "SELECT * FROM wallet_positions WHERE token = ? AND state IN ('open','unknown','incomplete') ORDER BY wallet",
    )
    .all(token) as PositionRow[];
  return rows.map(rowToCycle);
}

/** 周期开始前是否存在明确的零余额证据 */
export function hasZeroCheckpointBefore(db: Db, wallet: string, token: string, ts: number): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM position_checkpoints
       WHERE wallet = ? AND token = ? AND checked_at <= ? AND balance = '0' LIMIT 1`,
    )
    .get(wallet, token, ts) as { ok: number } | undefined;
  return row !== undefined;
}

function deriveCostComplete(
  db: Db,
  wallet: string,
  token: string,
  firstBuyTs: number,
  ctx: PositionContext,
): boolean {
  // 缺口存在时不得授予（数据连续性无法保证）
  if (ctx.hasRecentGap === true) return false;
  // 未修复的缺口标记：普通成交不得恢复资格，只能由可靠重建解除
  if (getKv<boolean>(db, `gap_affected:${token}`) === true) return false;
  if (getKv<boolean>(db, `gap_affected:${token}:${wallet}`) === true) return false;
  // 唯一充分条件：周期开始前存在零余额检查点（完整历史重建走 M2-9 恢复路径）
  return hasZeroCheckpointBefore(db, wallet, token, firstBuyTs);
}

function deriveConfidence(cycle: PositionCycle, ctx: PositionContext): number {
  if (cycle.costComplete) return 1;
  if (cycle.state === 'incomplete') return 0.3;
  if (ctx.hasRecentGap === true) return 0.3;
  if (cycle.state === 'unknown') return 0.3;
  return 0.5;
}

/**
 * 成本完整性重算：仅当存在严格早于周期首笔买入的零余额检查点时才授予；
 * 完整历史重建通过 M2-9 rebuild 路径恢复（重建后由检查点携带 cost_complete）。
 * 缺口一律不授予。
 */
export function recomputeCostCompleteness(
  db: Db,
  token: string,
  ctx: PositionContext,
): number {
  if (ctx.hasRecentGap === true) {
    // 缺口影响：按钱包持久化标记，超时解除阻塞也不恢复完整性（须逐钱包重建）
    const affected = db
      .prepare(
        "SELECT wallet FROM wallet_positions WHERE token = ? AND state = 'open' AND cost_complete = 1",
      )
      .all(token) as Array<{ wallet: string }>;
    const nowSec = Math.floor(Date.now() / 1000);
    for (const row of affected) {
      setKv(db, `gap_affected:${token}:${row.wallet}`, true, nowSec);
    }
    db.prepare(
      `UPDATE wallet_positions SET cost_complete = 0
       WHERE token = ? AND state = 'open' AND cost_complete = 1`,
    ).run(token);
    return 0;
  }
  if (getKv<boolean>(db, `gap_affected:${token}`) === true) return 0;
  const rows = db
    .prepare(
      `SELECT wallet, cycle_no, cycle_started_at FROM wallet_positions
       WHERE token = ? AND state = 'open' AND cost_complete = 0 AND cycle_started_at IS NOT NULL`,
    )
    .all(token) as Array<{ wallet: string; cycle_no: number; cycle_started_at: number }>;
  let granted = 0;
  const update = db.prepare(
    `UPDATE wallet_positions SET cost_complete = 1, confidence = 1
     WHERE wallet = ? AND token = ? AND cycle_no = ?`,
  );
  for (const row of rows) {
    if (getKv<boolean>(db, `gap_affected:${token}:${row.wallet}`) === true) continue;
    if (hasZeroCheckpointBefore(db, row.wallet, token, row.cycle_started_at)) {
      update.run(row.wallet, token, row.cycle_no);
      granted += 1;
    }
  }
  return granted;
}

export function upsertCycle(db: Db, cycle: PositionCycle, nowSec: number): void {
  db.prepare(
    `INSERT INTO wallet_positions (
      wallet, token, cycle_no, state, cost_complete,
      bought_amount, sold_amount, bought_usd, sold_usd, avg_entry_price_usd,
      cycle_started_at, last_buy_ts, last_sell_ts, last_trade_ts, confidence
    ) VALUES (
      @wallet, @token, @cycle_no, @state, @cost_complete,
      @bought_amount, @sold_amount, @bought_usd, @sold_usd, @avg_entry_price_usd,
      @cycle_started_at, @last_buy_ts, @last_sell_ts, @last_trade_ts, @confidence
    ) ON CONFLICT(wallet, token, cycle_no) DO UPDATE SET
      state = excluded.state, cost_complete = excluded.cost_complete,
      bought_amount = excluded.bought_amount, sold_amount = excluded.sold_amount,
      bought_usd = excluded.bought_usd, sold_usd = excluded.sold_usd,
      avg_entry_price_usd = excluded.avg_entry_price_usd,
      cycle_started_at = excluded.cycle_started_at,
      last_buy_ts = excluded.last_buy_ts, last_sell_ts = excluded.last_sell_ts,
      last_trade_ts = excluded.last_trade_ts, confidence = excluded.confidence`,
  ).run({
    wallet: cycle.wallet,
    token: cycle.token,
    cycle_no: cycle.cycleNo,
    state: cycle.state,
    cost_complete: cycle.costComplete ? 1 : 0,
    bought_amount: cycle.boughtAmount.toString(),
    sold_amount: cycle.soldAmount.toString(),
    bought_usd: cycle.boughtUsd.toString(),
    sold_usd: cycle.soldUsd.toString(),
    avg_entry_price_usd: cycle.avgEntryPriceUsd ? cycle.avgEntryPriceUsd.toString() : null,
    cycle_started_at: cycle.cycleStartedAt,
    last_buy_ts: cycle.lastBuyTs,
    last_sell_ts: cycle.lastSellTs,
    last_trade_ts: cycle.lastTradeTs,
    confidence: cycle.confidence,
  });
  void nowSec;
}

function insertCheckpoint(db: Db, cycle: PositionCycle, balance: string, checkedAt: number): void {
  db.prepare(
    `INSERT OR REPLACE INTO position_checkpoints
     (wallet, token, cycle_no, checked_at, balance, bought_amount, sold_amount, bought_usd, sold_usd, cost_complete,
      cycle_started_at, last_buy_ts, last_sell_ts, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'balance_info')`,
  ).run(
    cycle.wallet,
    cycle.token,
    cycle.cycleNo,
    checkedAt,
    balance,
    cycle.boughtAmount.toString(),
    cycle.soldAmount.toString(),
    cycle.boughtUsd.toString(),
    cycle.soldUsd.toString(),
    cycle.costComplete ? 1 : 0,
    cycle.cycleStartedAt,
    cycle.lastBuyTs,
    cycle.lastSellTs,
  );
}

function newCycle(wallet: string, token: string, cycleNo: number): PositionCycle {
  return {
    wallet,
    token,
    cycleNo,
    state: 'open',
    costComplete: false,
    boughtAmount: new Decimal(0),
    soldAmount: new Decimal(0),
    boughtUsd: new Decimal(0),
    soldUsd: new Decimal(0),
    avgEntryPriceUsd: null,
    cycleStartedAt: null,
    lastBuyTs: null,
    lastSellTs: null,
    lastTradeTs: null,
    confidence: 0.5,
  };
}

function recomputeAvgEntry(cycle: PositionCycle): void {
  if (cycle.boughtAmount.gt(0)) {
    cycle.avgEntryPriceUsd = cycle.boughtUsd.div(cycle.boughtAmount);
  }
}

/**
 * 将一笔成交应用到持仓周期（M2-1）：
 * - 清仓后下一笔买入开启新周期
 * - 数量缺失 → 周期标 incomplete
 * - 余量低于灰尘阈值 → 关闭周期
 * - balance 字段落检查点，供成本完整判定与重放
 */
export function applyTrade(db: Db, trade: NormalizedTrade, ctx: PositionContext): PositionCycle {
  const latest = getLatestCycle(db, trade.maker, trade.baseAddress);
  let cycle: PositionCycle;

  if (!latest || latest.state === 'closed') {
    cycle = newCycle(trade.maker, trade.baseAddress, (latest?.cycleNo ?? 0) + 1);
  } else {
    cycle = latest;
  }

  const amount = trade.amountNormalized !== null ? new Decimal(trade.amountNormalized) : null;
  const usd = trade.amountUsd !== null ? new Decimal(trade.amountUsd) : new Decimal(0);

  if (amount === null) {
    cycle.state = 'incomplete';
    cycle.costComplete = false;
  } else if (trade.side === 'buy') {
    if (cycle.cycleStartedAt === null) cycle.cycleStartedAt = trade.timestamp;
    cycle.boughtAmount = cycle.boughtAmount.plus(amount);
    cycle.boughtUsd = cycle.boughtUsd.plus(usd);
    cycle.lastBuyTs = trade.timestamp;
    if (cycle.state !== 'incomplete' && cycle.state !== 'unknown') cycle.state = 'open';
    if (cycle.state !== 'incomplete') {
      cycle.costComplete = deriveCostComplete(
        db,
        cycle.wallet,
        cycle.token,
        cycle.cycleStartedAt,
        ctx,
      );
    }
    recomputeAvgEntry(cycle);
  } else {
    // sell：若从未观测到买入，则持仓未知
    if (cycle.cycleStartedAt === null) cycle.state = 'unknown';
    cycle.soldAmount = cycle.soldAmount.plus(amount);
    cycle.soldUsd = cycle.soldUsd.plus(usd);
    cycle.lastSellTs = trade.timestamp;
    if (cycle.boughtAmount.gt(0)) {
      const remaining = cycle.boughtAmount.minus(cycle.soldAmount);
      const ratio = remaining.div(cycle.boughtAmount);
      if (ratio.lt(ctx.dustRatio)) cycle.state = 'closed';
    } else if (cycle.state !== 'incomplete') {
      cycle.state = 'unknown';
    }
  }

  // follow 明确全平仓是零余额证据；普通公开源的二义标志不能用于此判断。
  if (trade.side === 'sell' && (trade.balance === '0' || (trade.actionHint === 'close' && trade.balance === null))) cycle.state = 'closed';
  cycle.lastTradeTs = trade.timestamp;
  if (trade.amountUsd === null && trade.side === 'buy') {
    cycle.costComplete = false;
    cycle.state = 'incomplete';
  }
  cycle.confidence = deriveConfidence(cycle, ctx);
  upsertCycle(db, cycle, trade.timestamp);

  const observedBalance = trade.balance ?? (trade.side === 'sell' && trade.actionHint === 'close' ? '0' : null);
  if (observedBalance !== null && amount !== null) {
    insertCheckpoint(db, cycle, observedBalance, trade.timestamp);
  }

  return cycle;
}
