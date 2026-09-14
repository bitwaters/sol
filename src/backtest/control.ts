import { captureFeatures, fresh } from './features.js';
import { saveLiveQuality, validPrice } from './quality.js';
import { CACHE_TTL, getCachedToken } from '../enrich/token.js';
import type { AppConfig } from '../config.js';
import type { CexBlacklist } from '../enrich/wallet.js';
import type { Logger } from '../logger.js';
import { computeWindow } from '../signal/window.js';
import { buildClusters } from '../signal/cluster.js';
import { getKv, setKv, type Db } from '../store/db.js';

export interface ControlDeps {
  db: Db;
  config: AppConfig;
  logger: Logger;
  blacklist: CexBlacklist;
  now?: () => number;
  configVersion?: string;
  rulesVersion?: string;
  /** 采样间隔（秒），默认 15 分钟 */
  intervalSec?: number;
  /** 采样目标：窗口内恰好达到 2 票的 token */
  targetVotes?: number;
}

/**
 * 对照组采样（M4-2）：
 * 对"未达到触发门槛但接近"的候选按固定间隔采样，写入 signals(status='control')，
 * 与信号组使用同一数据覆盖标准，供假设验证比较。
 */
export function sampleControls(deps: ControlDeps): number {
  const { db, config, logger } = deps;
  const nowSec = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const intervalSec = deps.intervalSec ?? 900;
  const targetVotes = deps.targetVotes ?? config.signal.minDistinctWallets - 1;

  const lastSample = getKv<number>(db, 'control_last_sample_at') ?? 0;
  if (nowSec - lastSample < intervalSec) return 0;

  const windowStart = nowSec - config.signal.windowMinutes * 60;
  const minAmount = config.tradeFilter.minTradeAmountUsd;

  const rows = db
    .prepare(
      `SELECT base_address AS token,
              COUNT(DISTINCT maker) AS wallets,
              SUM(CAST(amount_usd AS REAL)) AS buy_usd,
              GROUP_CONCAT(DISTINCT maker) AS makers
       FROM trades
       WHERE side = 'buy' AND timestamp >= ? AND timestamp <= ?
         AND CAST(COALESCE(amount_usd,'0') AS REAL) >= ?
       GROUP BY base_address`,
    )
    .all(windowStart, nowSec, minAmount) as Array<{
    token: string;
    wallets: number;
    buy_usd: number | null;
    makers: string;
  }>;

  let created = 0;
  const insert = db.prepare(
    `INSERT INTO signals (token, triggered_at, window_start, window_end, wallet_count, net_inflow_usd, status, price_at_trigger, snapshot)
     VALUES (?, ?, ?, ?, ?, ?, 'control', ?, ?)`,
  );
  for (const row of rows) {
    // 与信号组同口径：关联合并后计票
    const clusters = buildClusters(db, row.token, row.makers.split(','), {
      blacklist: deps.blacklist,
      enabled: config.signal.clusterMerge,
      sameFunder: config.walletFilter.cluster.sameFunder,
      creationTimeDeltaMinutes: config.walletFilter.cluster.creationTimeDeltaMinutes,
      excludeFunderLabels: config.walletFilter.cluster.excludeFunderLabels,
    });
    const window = computeWindow(db, row.token, nowSec, config, clusters);
    if (window.votes !== targetVotes) continue;

    const exists = db
      .prepare(
        `SELECT 1 AS ok FROM signals WHERE token = ? AND status = 'control' AND triggered_at >= ? LIMIT 1`,
      )
      .get(row.token, windowStart) as { ok: number } | undefined;
    if (exists) continue;
    const token = getCachedToken(db, row.token);
    const price = validPrice(token?.price) && fresh(token?.price_updated_at, nowSec, CACHE_TTL.price) ? token!.price : null;
    const features = captureFeatures(db, config, deps.blacklist, row.token, nowSec, targetVotes);
    db.transaction(() => {
      const result = insert.run(row.token, nowSec, windowStart, nowSec, window.votes,
        window.netInflowUsd.toNumber(), price, JSON.stringify({ control: true, ...features }));
      saveLiveQuality(db, Number(result.lastInsertRowid), nowSec, price, price === null ? null : token!.price_updated_at,
        features, deps.configVersion ?? null, deps.rulesVersion ?? null, nowSec);
    })();
    created += 1;
  }

  setKv(db, 'control_last_sample_at', nowSec, nowSec);
  if (created > 0) logger.info('对照组采样完成', { created, targetVotes });
  return created;
}
