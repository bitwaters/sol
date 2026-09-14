import { BackgroundBusyError } from '../ingest/gateway.js';
import { syncQuality } from './quality.js';
import { Decimal } from 'decimal.js';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { deleteKv, getKv, setKv, type Db } from '../store/db.js';

export interface KlineGateway {
  fetchKline(address: string, resolution: string, fromMs: number, toMs: number): Promise<unknown>;
}

export interface BacktestDeps {
  db: Db;
  config: AppConfig;
  gateway: KlineGateway;
  logger: Logger;
  now?: () => number;
  /** 单次最多评估的信号数（控制限频预算） */
  maxPerRun?: number;
}

export interface BacktestResult {
  evaluated: number;
  missingSamples: number;
  skipped: number;
}

interface SignalRow {
  id: number;
  token: string;
  status: string;
  sent_at: number | null;
  triggered_at: number;
  price_at_send: string | null;
  price_at_trigger: string | null;
  outcome_5m: number | null;
  outcome_1h: number | null;
  outcome_24h: number | null;
}

interface Candle {
  timeMs: number;
  close: number;
}

const TARGETS = [
  { field: 'outcome_5m', offsetSec: 300, resolution: '1m', resolutionMs: 60_000, toleranceMs: 2 * 60_000 },
  { field: 'outcome_1h', offsetSec: 3600, resolution: '5m', resolutionMs: 5 * 60_000, toleranceMs: 5 * 60_000 },
  { field: 'outcome_24h', offsetSec: 86_400, resolution: '1h', resolutionMs: 3_600_000, toleranceMs: 60 * 60_000 },
] as const;

export function asCandles(raw: unknown): Candle[] {
  const list =
    raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>)['list'])
      ? ((raw as Record<string, unknown>)['list'] as Record<string, unknown>[])
      : [];
  return list
    .filter((item) => item && typeof item === 'object' && ['close','time'].every(key =>
      typeof item[key] === 'number' || (typeof item[key] === 'string' && item[key].trim() !== '')))
    .map((item) => ({
      timeMs: Number(item['time']),
      close: Number(item['close']),
    }))
    .filter((c) => Number.isFinite(c.timeMs) && c.timeMs >= 0 && Number.isFinite(c.close) && c.close >= 0)
    .sort((a, b) => a.timeMs - b.timeMs);
}

/** 记录缺行情次数；连续 3 次放弃该期限（终止状态） */
function recordMissing(db: Db, signalId: number, field: string, nowSec: number): void {
  const key = `backtest_attempts:${signalId}:${field}`;
  const attempts = (getKv<number>(db, key) ?? 0) + 1;
  setKv(db, key, attempts, nowSec);
  if (attempts >= 3) {
    setKv(db, `backtest_giveup:${signalId}:${field}`, true, nowSec);
  }
}

/** 收盘时间不晚于目标时点的最近一根已完成 K 线 */
export function pickCompletedCandle(
  candles: Candle[],
  targetMs: number,
  resolutionMs: number,
  toleranceMs: number,
): Candle | null {
  let best: Candle | null = null;
  for (const candle of candles) {
    const closeMs = candle.timeMs + resolutionMs;
    if (closeMs <= targetMs && (best === null || candle.timeMs > best.timeMs)) {
      best = candle;
    }
  }
  if (!best) return null;
  const deviation = targetMs - (best.timeMs + resolutionMs);
  return deviation <= toleranceMs ? best : null;
}

/**
 * 回测评估（M4-1）：
 * - 已推送/被拦截/对照均纳入；基准时间为 sent_at ?? triggered_at，基准价为 price_at_send ?? price_at_trigger
 * - 按"最早到期的缺失期限"排序，避免旧样本的头阻塞
 * - 同一期限连续 3 次缺行情后放弃（终止状态）
 */
const running = new WeakSet<Db>();
export async function evaluateOutcomes(deps: BacktestDeps): Promise<BacktestResult> {
  if (running.has(deps.db)) return { evaluated: 0, missingSamples: 0, skipped: 0 };
  running.add(deps.db);
  try { return await runEvaluation(deps); } finally { running.delete(deps.db); }
}

async function runEvaluation(deps: BacktestDeps): Promise<BacktestResult> {
  const { db, gateway, logger } = deps;
  const nowSec = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const maxPerRun = deps.maxPerRun ?? 10;
  if (maxPerRun <= 0) return { evaluated: 0, missingSamples: 0, skipped: 0 };
  syncQuality(db, nowSec);
  const result: BacktestResult = { evaluated: 0, missingSamples: 0, skipped: 0 };

  // 分页扫描全部到期样本后排序，避免较新样本的短期评估被旧样本挤出额度。
  const scanStmt = db.prepare(
    `SELECT id, token, status, sent_at, triggered_at, price_at_send, price_at_trigger,
            outcome_5m, outcome_1h, outcome_24h
     FROM signals
     WHERE status IN ('pushed','control','invalidated','blocked_price','expired')
       AND (outcome_5m IS NULL OR outcome_1h IS NULL OR outcome_24h IS NULL)
       AND COALESCE(sent_at, triggered_at) <= ?
     ORDER BY COALESCE(sent_at, triggered_at) ASC
     LIMIT ? OFFSET ?`,
  );
  const pageSize = maxPerRun * 20;
  const due: Array<{ signal: SignalRow; baseTs: number; targets: typeof TARGETS[number][] }> = [];
  let offset = 0;
  while (true) {
    const batch = scanStmt.all(nowSec - 300, pageSize, offset) as SignalRow[];
    if (batch.length === 0) break;
    offset += batch.length;
    for (const signal of batch) {
      const baseTs = signal.sent_at ?? signal.triggered_at;
      const targets = TARGETS.filter((target) => {
        if (signal[target.field] !== null) return false;
        if ((getKv<number>(db, `backtest_next_retry:${signal.id}:${target.field}`) ?? 0) > nowSec) return false;
        if (baseTs + target.offsetSec > nowSec) return false;
        if (getKv<boolean>(db, `backtest_giveup:${signal.id}:${target.field}`) === true) return false;
        return true;
      });
      if (targets.length === 0) continue;
      const baseline = Number(signal.price_at_send ?? signal.price_at_trigger);
      if (!Number.isFinite(baseline) || baseline <= 0) {
        // Pending baseline repair is recoverable and does not consume market retries.
        result.skipped += 1;
        continue;
      }
      due.push({ signal, baseTs, targets });

    }
    if (batch.length < pageSize) break;
  }
  due.sort(
    (a, b) =>
      Math.min(...a.targets.map((t) => a.baseTs + t.offsetSec)) -
      Math.min(...b.targets.map((t) => b.baseTs + t.offsetSec)),
  );

  for (const { signal, baseTs, targets } of due.slice(0, maxPerRun)) {
    const basePriceRaw = signal.price_at_send ?? signal.price_at_trigger;
    if (basePriceRaw === null) {
      result.skipped += 1;
      continue;
    }
    const basePrice = new Decimal(basePriceRaw);
    let evaluatedAny = false;
    let missing = 0;

    for (const target of targets) {
      const targetSec = baseTs + target.offsetSec;
      const targetMs = targetSec * 1000;
      try {
        const raw = await gateway.fetchKline(
          signal.token,
          target.resolution,
          targetMs - 2 * 3600_000,
          targetMs + target.toleranceMs,
        );
        const baselineStillCurrent = db.prepare(`SELECT 1 FROM signals WHERE id = ?
          AND COALESCE(sent_at, triggered_at) = ? AND COALESCE(price_at_send, price_at_trigger) = ?`)
          .get(signal.id, baseTs, basePriceRaw);
        if (!baselineStillCurrent) break;
        const candle = pickCompletedCandle(
          asCandles(raw),
          targetMs,
          target.resolutionMs,
          target.toleranceMs,
        );
        if (candle === null) {
          recordMissing(db, signal.id, target.field, nowSec);
          setKv(db, `backtest_next_retry:${signal.id}:${target.field}`, nowSec + 300, nowSec);
          db.prepare(`INSERT OR REPLACE INTO outcome_quality
            (signal_id,horizon,anchor_ts,anchor_price,target_ts,recorded_at,state) VALUES (?,?,?,?,?,?,?)`)
            .run(signal.id, target.field, baseTs, basePriceRaw, targetSec, nowSec,
              getKv(db, `backtest_giveup:${signal.id}:${target.field}`) === true ? 'exhausted' : 'no_market');
          missing += 1;
          continue;
        }
        const ratio = new Decimal(candle.close).div(basePrice).toNumber();
        if (!Number.isFinite(ratio)) throw new Error('nonfinite outcome');
        db.transaction(() => {
          db.prepare(`UPDATE signals SET ${target.field}=? WHERE id=?`).run(ratio, signal.id);
          db.prepare(`INSERT OR REPLACE INTO outcome_quality
            (signal_id,horizon,anchor_ts,anchor_price,target_ts,candle_close_ts,recorded_at,state)
            VALUES (?,?,?,?,?,?,?,'complete')`).run(signal.id, target.field, baseTs, basePriceRaw,
              targetSec, (candle.timeMs + target.resolutionMs) / 1000, nowSec);
          deleteKv(db, `backtest_next_retry:${signal.id}:${target.field}`);
        })();
        evaluatedAny = true;
      } catch (err) {
        if (err instanceof BackgroundBusyError) {
          if (evaluatedAny) result.evaluated += 1;
          result.missingSamples += missing;
          return result;
        }
        logger.warn('回测取价失败', { signalId: signal.id, resolution: target.resolution, error: err });
        const current = db.prepare(`SELECT 1 FROM signals WHERE id=? AND COALESCE(sent_at,triggered_at)=?
          AND COALESCE(price_at_send,price_at_trigger)=?`).get(signal.id, baseTs, basePriceRaw);
        if (!current) break;
        setKv(db, `backtest_next_retry:${signal.id}:${target.field}`, nowSec + 300, nowSec);
        db.prepare(`INSERT OR REPLACE INTO outcome_quality
          (signal_id,horizon,anchor_ts,anchor_price,target_ts,recorded_at,state) VALUES (?,?,?,?,?,?,'request_error')`)
          .run(signal.id, target.field, baseTs, basePriceRaw, targetSec, nowSec);
        // 请求错误不等同于缺行情，网络/限频恢复后仍可补齐。
        missing += 1;
      }
    }

    if (evaluatedAny) result.evaluated += 1;
    result.missingSamples += missing;
  }

  if (result.evaluated > 0 || result.missingSamples > 0) {
    logger.info('回测批次完成', { ...result });
  }
  return result;
}
