import { readStoredTrade } from '../store/repo/trades.js';
import { Decimal } from 'decimal.js';
import type { Logger } from '../logger.js';
import { getKv, setKv, type Db } from '../store/db.js';
import { applyTrade, upsertCycle, type PositionContext, type PositionCycle } from './positions.js';

export interface RebuildResult {
  rebuilt: boolean;
  reason: string | null;
  replayedTrades: number;
}

interface CheckpointRow {
  wallet: string;
  token: string;
  cycle_no: number;
  checked_at: number;
  balance: string;
  bought_amount: string;
  sold_amount: string;
  bought_usd: string;
  sold_usd: string;
  cost_complete: number;
  cycle_started_at: number | null;
  last_buy_ts: number | null;
  last_sell_ts: number | null;
}

interface StoredTradeRow {
  event_id: string;
  raw: string | null;
  timestamp: number;
  tx_hash: string;
  side: 'buy' | 'sell';
  raw_amount: string | null;
  raw_amount_unit: string | null;
  raw_decimals: number | null;
  amount_normalized: string | null;
  amount_usd: string | null;
  price_usd: string | null;
  is_open_or_close: number | null;
}

interface CycleTimes {
  cycle_started_at: number | null;
  last_buy_ts: number | null;
  last_sell_ts: number | null;
}

function seedFromCheckpoint(db: Db, cp: CheckpointRow, previous?: CycleTimes): PositionCycle {
  // 兼容旧检查点：沿用未受迟到事件影响的真实起点，不把核验时间当作建仓时间。
  const previousStart = previous?.cycle_started_at ?? null;
  const startedAt = cp.cycle_started_at ??
    (previousStart !== null && previousStart <= cp.checked_at ? previousStart : null);
  const lastTrades = db.prepare(
    `SELECT MAX(CASE WHEN side = 'buy' THEN timestamp END) AS last_buy_ts,
            MAX(CASE WHEN side = 'sell' THEN timestamp END) AS last_sell_ts
     FROM trades WHERE maker = ? AND base_address = ? AND timestamp >= ? AND timestamp <= ?`,
  ).get(cp.wallet, cp.token, startedAt ?? cp.checked_at, cp.checked_at) as CycleTimes;
  const cycle: PositionCycle = {
    wallet: cp.wallet,
    token: cp.token,
    cycleNo: cp.cycle_no,
    // 零余额检查点表示该周期已关闭；后续买入会开启新周期
    state: cp.balance === '0' ? 'closed' : 'open',
    costComplete: cp.cost_complete === 1,
    boughtAmount: new Decimal(cp.bought_amount),
    soldAmount: new Decimal(cp.sold_amount),
    boughtUsd: new Decimal(cp.bought_usd),
    soldUsd: new Decimal(cp.sold_usd),
    avgEntryPriceUsd: null,
    cycleStartedAt: startedAt,
    lastBuyTs: cp.last_buy_ts ?? lastTrades.last_buy_ts,
    lastSellTs: cp.last_sell_ts ?? lastTrades.last_sell_ts,
    lastTradeTs: cp.checked_at,
    confidence: 1,
  };
  if (cycle.boughtAmount.gt(0)) {
    cycle.avgEntryPriceUsd = cycle.boughtUsd.div(cycle.boughtAmount);
  }
  upsertCycle(db, cycle, cp.checked_at);
  return cycle;
}

/**
 * 周期重建与重放（M2-9）：
 * - 选择严格早于最早受影响事件的有效检查点重放
 * - 无更早检查点时，从已确认的零余额周期起点（新代币 + 观测起点 + 无缺口）重放
 * - 两者都无 → 保持 unknown，不恢复计算资格
 * - 重建期间暂停该 token 的新信号
 */
export function rebuildWalletToken(
  db: Db,
  wallet: string,
  token: string,
  affectedFromTs: number,
  ctx: PositionContext,
  logger?: Logger,
): RebuildResult {
  const nowSec = Math.floor(Date.now() / 1000);
  setKv(db, `rebuild_paused:${token}`, true, nowSec);

  try {
    const checkpoint = db
      .prepare(
        `SELECT * FROM position_checkpoints
         WHERE wallet = ? AND token = ? AND checked_at < ?
         ORDER BY checked_at DESC LIMIT 1`,
      )
      .get(wallet, token, affectedFromTs) as CheckpointRow | undefined;

    const zeroStartConfirmed =
      ctx.tokenCreatedAt != null &&
      ctx.observationStartedAt != null &&
      ctx.tokenCreatedAt >= ctx.observationStartedAt &&
      ctx.hasRecentGap !== true;

    const observedOnly = !checkpoint && !zeroStartConfirmed;
    if (observedOnly && !db.prepare('SELECT 1 FROM trades WHERE maker=? AND base_address=? LIMIT 1').get(wallet, token)) {
      db.prepare(
        `UPDATE wallet_positions SET cost_complete = 0,
           state = CASE WHEN state IN ('open','incomplete') THEN 'unknown' ELSE state END
         WHERE wallet = ? AND token = ?`,
      ).run(wallet, token);
      logger?.warn('重建缺少可靠起点，保持 unknown', { wallet, token });
      return { rebuilt: false, reason: 'no_reliable_start', replayedTrades: 0 };
    }

    const replayFromTs = checkpoint ? checkpoint.checked_at : 0;

    const run = db.transaction((): number => {
      const previous = checkpoint ? db.prepare(
        'SELECT cycle_started_at, last_buy_ts, last_sell_ts FROM wallet_positions WHERE wallet = ? AND token = ? AND cycle_no = ?',
      ).get(wallet, token, checkpoint.cycle_no) as CycleTimes | undefined : undefined;
      const minCycle = checkpoint ? checkpoint.cycle_no : 0;
      // 仅替换受影响范围（检查点及之后），保留更早的历史周期（可能被信号/退出监控引用）
      db.prepare('DELETE FROM wallet_positions WHERE wallet = ? AND token = ? AND cycle_no >= ?').run(
        wallet,
        token,
        minCycle,
      );
      // 失效检查点之后的旧累计快照，避免后续重建复用过期数据
      if (checkpoint) {
        db.prepare(
          'DELETE FROM position_checkpoints WHERE wallet = ? AND token = ? AND checked_at > ?',
        ).run(wallet, token, checkpoint.checked_at);
      } else {
        db.prepare('DELETE FROM position_checkpoints WHERE wallet = ? AND token = ?').run(wallet, token);
      }
      if (checkpoint) seedFromCheckpoint(db, checkpoint, previous);

      const rows = db
        .prepare(
          `SELECT event_id, raw, timestamp, tx_hash, side, raw_amount, raw_amount_unit, raw_decimals,
                  amount_normalized, amount_usd, price_usd, is_open_or_close
           FROM trades
           WHERE maker = ? AND base_address = ? AND timestamp > ?
           ORDER BY timestamp, event_id`,
        )
        .all(wallet, token, replayFromTs) as StoredTradeRow[];

      let replayed = 0;
      const eventCycles = new Map<string, number>();
      for (const row of rows) {
        const trade = readStoredTrade(db, row.event_id);
        const cycle = applyTrade(db, trade, ctx);
        eventCycles.set(row.event_id, cycle.cycleNo);
        replayed += 1;
      }

      // 成员按加入时的成交映射；同一旧周期拆分后，不同信号可属于不同的新周期。
      const affectedBindings = db
        .prepare(
          `SELECT sw.signal_id, sw.cycle_no, sw.joined_event_id,
                  COALESCE(sw.joined_at, CASE WHEN COALESCE(sw.joined_version, 0) = 0 THEN s.triggered_at
                    ELSE (SELECT t.created_at FROM push_tasks t WHERE t.signal_id = s.id
                          AND t.kind = 'escalate' AND t.revision = sw.joined_version LIMIT 1)
                  END) AS joined_at
           FROM signal_wallets sw JOIN signals s ON s.id = sw.signal_id
           WHERE sw.wallet = ? AND s.token = ?`,
        )
        .all(wallet, token) as Array<{
          signal_id: number; cycle_no: number; joined_at: number | null; joined_event_id: string | null;
        }>;
      const updateBinding = db.prepare(
        `UPDATE signal_wallets SET cycle_no = ?, joined_at = ?, joined_event_id = ?
         WHERE signal_id = ? AND wallet = ? AND cycle_no = ?`,
      );
      for (const binding of affectedBindings) {
        // 旧版本未保存成交锚点：仅在能恢复成员加入时间时补齐，升级成员不得使用首次触发时间。
        const anchor = binding.joined_event_id ?? (binding.joined_at === null ? null : (
          db.prepare(
            `SELECT event_id FROM trades WHERE maker = ? AND base_address = ? AND side = 'buy'
             AND timestamp <= ? ORDER BY timestamp DESC, event_id DESC LIMIT 1`,
          ).get(wallet, token, binding.joined_at) as { event_id: string } | undefined
        )?.event_id ?? null);
        if (anchor === null) {
          logger?.warn('成员加入成交不可恢复，保留原周期绑定', { signalId: binding.signal_id, wallet, token });
          continue;
        }
        // 检查点及之前的成交不参与重放，其周期编号保持不变。
        const mappedCycle = eventCycles.get(anchor) ?? binding.cycle_no;
        updateBinding.run(mappedCycle, binding.joined_at, anchor, binding.signal_id, wallet, binding.cycle_no);
        if (mappedCycle !== binding.cycle_no) {
          logger?.info('重建校正成员周期绑定', {
            signalId: binding.signal_id, wallet, token, fromCycle: binding.cycle_no, toCycle: mappedCycle, anchor,
          });
        }
      }
      return replayed;
    });

    const replayedTrades = run();
    if (observedOnly) {
      // 可重排已观测成交，但没有零余额起点的周期仍不具备成本完整性。
      db.prepare("UPDATE wallet_positions SET state='unknown', confidence=0.3 WHERE wallet=? AND token=? AND cost_complete=0 AND state='open'").run(wallet, token);
    }
    const affectedUntil = getKv<number>(db, `gap_affected_until:${token}:${wallet}`);
    const gapRecovered = ctx.hasRecentGap !== true && (affectedUntil === null ||
      (checkpoint !== undefined && checkpoint.checked_at >= affectedUntil &&
        (checkpoint.balance === '0' || checkpoint.cost_complete === 1)));
    if (gapRecovered) {
      setKv(db, `gap_affected:${token}`, false, nowSec);
      setKv(db, `gap_affected:${token}:${wallet}`, false, nowSec);
    } else {
      // 重放顺序正确不代表缺失成交已找回；没有缺口后的可靠证据不能恢复资格。
      db.prepare("UPDATE wallet_positions SET cost_complete = 0, confidence = 0.3 WHERE wallet = ? AND token = ? AND state <> 'closed'").run(wallet, token);
    }
    logger?.info('周期重建完成', {
      wallet,
      token,
      replayedTrades,
      fromCheckpoint: checkpoint !== undefined,
    });
    return { rebuilt: true, reason: observedOnly ? 'observed_history_only' : null, replayedTrades };
  } finally {
    setKv(db, `rebuild_paused:${token}`, false, nowSec);
  }
}
