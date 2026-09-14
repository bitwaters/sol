import { Decimal } from 'decimal.js';
import { boundHoldingRatio } from './members.js';
import type { AppConfig } from '../config.js';
import { enrichToken, type EnrichGateway, type TokenSnapshot } from '../enrich/token.js';
import {
  enrichWallets,
  getWalletProfile,
  type CexBlacklist,
  type WalletGateway,
} from '../enrich/wallet.js';
import type { Logger } from '../logger.js';
import { getKv, setKv, type Db } from '../store/db.js';
import { recordEvaluation } from '../store/repo/evaluations.js';
import { buildClusters, type ClusterResult } from './cluster.js';
import { checkIntegrity, resolveStaleGaps } from './integrity.js';
import { getLatestCycle, recomputeCostCompleteness } from './positions.js';
import { validateToken, validateTokenSnapshot } from './validate-token.js';
import { validateWallets } from './validate-wallet.js';
import { computeWindow, type WindowMetrics } from './window.js';

export interface EngineDeps {
  db: Db;
  config: AppConfig;
  gateway: EnrichGateway & WalletGateway;
  logger: Logger;
  configVersion: string;
  rulesVersion: string;
  blacklist: CexBlacklist;
  now?: () => number;
}

export type CandidateStatus =
  | 'watching'
  | 'candidate'
  | 'sending'
  | 'invalidated'
  | 'blocked_price'
  | 'suppressed_enrich_failed'
  | 'expired'
  | 'pushed'
  | 'cooldown'
  | 'deferred';

export interface EvaluateResult {
  token: string;
  status: CandidateStatus;
  signalId: number | null;
  reason: string | null;
  votes: number;
  netInflowUsd: string;
  retentionRatio: string | null;
  priceRatio: string | null;
  pushTaskCreated: boolean;
}

export const CANDIDATE_MAX_AGE_SEC = 3600;
const REUSABLE_STATUSES = [
  'candidate',
  'sending',
  'invalidated',
  'blocked_price',
  'suppressed_enrich_failed',
];

interface SignalRow {
  id: number;
  token: string;
  status: string;
  triggered_at: number;
  snapshot: string | null;
}

function findReusableSignal(db: Db, token: string, nowSec: number): SignalRow | null {
  const placeholders = REUSABLE_STATUSES.map(() => '?').join(',');
  const row = db
    .prepare(
      `SELECT id, token, status, triggered_at, snapshot
       FROM signals
       WHERE token = ? AND status IN (${placeholders}) AND triggered_at >= ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(token, ...REUSABLE_STATUSES, nowSec - CANDIDATE_MAX_AGE_SEC) as SignalRow | undefined;
  return row ?? null;
}

function findPushedInCooldown(
  db: Db,
  token: string,
  nowSec: number,
  cooldownMinutes: number,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM signals
       WHERE token = ? AND status = 'pushed' AND sent_at IS NOT NULL AND sent_at >= ? LIMIT 1`,
    )
    .get(token, nowSec - cooldownMinutes * 60) as { ok: number } | undefined;
  return row !== undefined;
}

/**
 * 候选生命周期（§7.1）：
 * - 超过 60 分钟 → expired
 * - 窗口内无有效买入 → expired
 * - 过期时原子取消尚未发出的首次推送任务
 * pushed 信号不适用（监控按 §7.6）
 */
/** 导出供定时维护调用：过期 + 取消 pending 首次推送任务 */
export function runCandidateMaintenance(
  db: Db,
  token: string,
  nowSec: number,
  windowMinutes: number,
  minTradeAmountUsd: number,
): number {
  return expireStaleCandidates(db, token, nowSec, windowMinutes, minTradeAmountUsd);
}

function expireStaleCandidates(
  db: Db,
  token: string,
  nowSec: number,
  windowMinutes: number,
  minTradeAmountUsd: number,
): number {
  const placeholders = REUSABLE_STATUSES.map(() => '?').join(',');
  const lastTrade = db
    .prepare(
      `SELECT MAX(timestamp) AS ts FROM trades
       WHERE base_address = ? AND side = 'buy'
         AND CAST(COALESCE(amount_usd,'0') AS REAL) >= ?`,
    )
    .get(token, minTradeAmountUsd) as { ts: number | null };
  const inactive =
    lastTrade.ts !== null && nowSec - lastTrade.ts > windowMinutes * 60;

  const run = db.transaction((): number => {
    const ids = db
      .prepare(
        `SELECT id FROM signals
         WHERE token = ? AND status IN (${placeholders})
           AND (triggered_at < ? ${inactive ? 'OR 1=1' : ''})`,
      )
      .all(token, ...REUSABLE_STATUSES, nowSec - CANDIDATE_MAX_AGE_SEC) as Array<{ id: number }>;
    if (ids.length === 0) return 0;
    const idList = ids.map((r) => r.id);
    const idPlaceholders = idList.map(() => '?').join(',');
    db.prepare(
      `UPDATE signals SET status = 'expired',
         reason = CASE WHEN reason IS NULL OR reason = '' THEN ? ELSE reason END
       WHERE id IN (${idPlaceholders})`,
    ).run(inactive ? 'window_inactive' : 'lifecycle_expired', ...idList);
    db.prepare(
      `UPDATE push_tasks SET status = 'cancelled', updated_at = ?
       WHERE signal_id IN (${idPlaceholders}) AND kind = 'signal' AND status = 'pending'`,
    ).run(nowSec, ...idList);
    // 候选结束后的重新触发冷却（5 分钟）
    setKv(db, `retrigger:${token}`, nowSec + 300, nowSec);
    return ids.length;
  });
  return run();
}

interface PushedRow {
  id: number;
  message_revision: number;
  escalated_count: number;
  wallet_count: number | null;
}

function findPushedSignal(
  db: Db,
  token: string,
  nowSec: number,
  editMinutes: number,
): PushedRow | null {
  const row = db
    .prepare(
      `SELECT id, message_revision, wallet_count,
              MAX(COALESCE(escalated_count,0), COALESCE((SELECT MAX(joined_version) FROM signal_wallets WHERE signal_id=signals.id),0)) AS escalated_count
       FROM signals
       WHERE token = ? AND status = 'pushed' AND sent_at >= ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(token, nowSec - editMinutes * 60) as PushedRow | undefined;
  return row ?? null;
}

/** 创建升级/降级编辑任务（消息修订号递增，按 revision 去重） */
function createEscalateTask(
  db: Db,
  signalId: number,
  revision: number,
  payload: Record<string, unknown>,
  patch: Record<string, unknown>,
  nowSec: number,
): boolean {
  const run = db.transaction((): boolean => {
    const res = db
      .prepare(
        `INSERT OR IGNORE INTO push_tasks (signal_id, kind, revision, dedupe_key, payload, status, created_at, updated_at)
         VALUES (?, 'escalate', ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(signalId, revision, `${signalId}:escalate:${revision}`, JSON.stringify(payload), nowSec, nowSec);
    if (res.changes > 0) {
      setKv(db, `warn:${signalId}`, payload['warn'] === true, nowSec);
      setKv(db, `downgrade:${signalId}`, payload['downgraded'] === true, nowSec);
      updateSignal(db, signalId, { message_revision: revision, ...patch });
    }
    return res.changes > 0;
  });
  return run();
}

/** 编辑节流 + 可见内容变化检查（§7.5） */
function shouldEscalate(
  db: Db,
  signalId: number,
  next: {
    votes: number;
    retention: number | null;
    priceRatio: number | null;
    warn: boolean;
    partial: boolean;
    downgrade?: boolean;
    displayWallets?: string;
  },
  throttleSec: number,
  nowSec: number,
): boolean {
  const lastEdit = getKv<number>(db, `edit_last:${signalId}`) ?? 0;
  if (nowSec - lastEdit < throttleSec) return false;
  const row = db
    .prepare('SELECT wallet_count, holding_ratio, price_ratio, display_wallets FROM signals WHERE id = ?')
    .get(signalId) as
    | { wallet_count: number | null; holding_ratio: number | null; price_ratio: number | null; display_wallets: string | null }
    | undefined;
  if (!row) return false;
  const priceBucket = (v: number | null): number => (v === null ? -1 : Math.floor(v * 10));
  const lastPartial = getKv<boolean>(db, `partial:${signalId}`) ?? false;
  return (
    (next.displayWallets !== undefined && row.display_wallets !== next.displayWallets) ||
    (row.wallet_count ?? 0) !== next.votes ||
    Math.abs((row.holding_ratio ?? 0) - (next.retention ?? 0)) > 0.05 ||
    priceBucket(row.price_ratio) !== priceBucket(next.priceRatio) ||
    (getKv<boolean>(db, `warn:${signalId}`) ?? false) !== next.warn ||
    (getKv<boolean>(db, `downgrade:${signalId}`) ?? false) !== (next.downgrade ?? false) ||
    lastPartial !== next.partial
  );
}

function markEdited(db: Db, signalId: number, partial: boolean, nowSec: number): void {
  setKv(db, `edit_last:${signalId}`, nowSec, nowSec);
  setKv(db, `partial:${signalId}`, partial, nowSec);
}

/** 首次推送与升级时持久化成员/簇/周期绑定（初始快照保持不可变） */
function persistSignalWallets(
  db: Db,
  signalId: number,
  token: string,
  wallets: Array<{
    wallet: string;
    tags: string[];
    sources: string[];
    action: 'open' | 'add' | null;
    qualifyingBuyUsd: { toString(): string };
  }>,
  clusters: ClusterResult,
  joinedVersion: number,
  joinedAt: number,
): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO signal_wallets
     (signal_id, wallet, cycle_no, cluster_id, joined_version, source, tags, amount_usd, action, joined_at, joined_event_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const existingRows = db
    .prepare('SELECT wallet, cycle_no, cluster_id FROM signal_wallets WHERE signal_id = ?')
    .all(signalId) as Array<{ wallet: string; cycle_no: number; cluster_id: string | null }>;
  const existing = new Map(existingRows.map((row) => [row.wallet, row.cycle_no]));
  const existingCluster = new Map(existingRows.map((row) => [row.wallet, row.cluster_id]));
  const usedClusterIds = new Set(existingRows.map((row) => row.cluster_id).filter((v): v is string => Boolean(v)));
  let nextClusterIndex = 0;
  const allocateClusterId = (): string => {
    while (usedClusterIds.has(`c${nextClusterIndex}`)) nextClusterIndex += 1;
    const id = `c${nextClusterIndex}`;
    usedClusterIds.add(id);
    nextClusterIndex += 1;
    return id;
  };
  const clusterIdFor = new Map<string, string>();
  const assignedClusterIds = new Set<string>();
  for (const members of clusters.clusterMembers.values()) {
    let clusterId = members.map((m) => existingCluster.get(m)).find((v): v is string => Boolean(v));
    if (!clusterId || assignedClusterIds.has(clusterId)) clusterId = allocateClusterId();
    assignedClusterIds.add(clusterId);
    for (const m of members) clusterIdFor.set(m, clusterId);
  }
  const updateCluster = db.prepare(
    'UPDATE signal_wallets SET cluster_id = ?, active = 1, source = ?, tags = ?, amount_usd = ?, action = ? WHERE signal_id = ? AND wallet = ?',
  );
  const run = db.transaction((): void => {
    db.prepare('UPDATE signal_wallets SET active = 0 WHERE signal_id = ?').run(signalId);
    for (const w of wallets) {
      const clusterId = clusterIdFor.get(w.wallet) ?? allocateClusterId();
      if (!existing.has(w.wallet)) {
        const cycle = getLatestCycle(db, w.wallet, token);
        const anchor = db.prepare(
          `SELECT event_id FROM trades WHERE maker = ? AND base_address = ? AND side = 'buy'
           AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp DESC, event_id DESC LIMIT 1`,
        ).get(w.wallet, token, cycle?.cycleStartedAt ?? 0, joinedAt) as { event_id: string } | undefined;
        insert.run(
          signalId,
          w.wallet,
          cycle?.cycleNo ?? 1,
          clusterId,
          joinedVersion,
          w.sources.join(','),
          JSON.stringify(w.tags),
          w.qualifyingBuyUsd.toString(),
          w.action,
          joinedAt,
          anchor?.event_id ?? null,
        );
      } else {
        // 保留原成员的加入版本与周期绑定，仅协调簇映射
        updateCluster.run(clusterId, w.sources.join(','), JSON.stringify(w.tags), w.qualifyingBuyUsd.toString(), w.action, signalId, w.wallet);
      }
    }
  });
  run();
}

function updateSignalIfReusable(db: Db, id: number, patch: Record<string, unknown>): number {
  const keys = Object.keys(patch);
  if (keys.length === 0) return 0;
  const sets = keys.map((k) => `${k} = @${k}`).join(', ');
  const placeholders = REUSABLE_STATUSES.map(() => '?').join(',');
  const res = db
    .prepare(`UPDATE signals SET ${sets} WHERE id = @id AND status IN (${placeholders})`)
    .run({ ...patch, id }, ...REUSABLE_STATUSES);
  return res.changes;
}

function updateSignal(db: Db, id: number, patch: Record<string, unknown>): void {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE signals SET ${sets} WHERE id = @id`).run({ ...patch, id });
}

/** 发送前完整资格复核（供推送器调用）：缺口/票数/钱包层/代币层 */
export async function revalidateSignalForSend(
  deps: EngineDeps,
  signalId: number,
): Promise<{
  ok: boolean;
  reason?: string;
  priceRatio?: number | null;
  holdingRatio?: number | null;
  votes?: number;
  warn?: boolean;
  partialHoldings?: boolean;
}> {
  const { db, config, gateway, blacklist } = deps;
  const now = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const signal = db.prepare('SELECT token, status FROM signals WHERE id = ?').get(signalId) as
    | { token: string; status: string }
    | undefined;
  if (!signal || signal.status !== 'sending') return { ok: false, reason: 'not_sending' };

  const gaps = checkIntegrity(db, ['smartmoney', 'kol', 'follow'], now);
  if (gaps.blocked) return { ok: false, reason: 'integrity_gap' };

  const walletsInWindow = db
    .prepare('SELECT DISTINCT maker FROM trades WHERE base_address = ? AND timestamp >= ?')
    .all(signal.token, now - config.signal.windowMinutes * 60) as Array<{ maker: string }>;
  const clusters = buildClusters(
    db,
    signal.token,
    walletsInWindow.map((r) => r.maker),
    {
      blacklist,
      enabled: config.signal.clusterMerge,
      sameFunder: config.walletFilter.cluster.sameFunder,
      creationTimeDeltaMinutes: config.walletFilter.cluster.creationTimeDeltaMinutes,
      excludeFunderLabels: config.walletFilter.cluster.excludeFunderLabels,
    },
  );
  const win = computeWindow(db, signal.token, now, config, clusters);
  if (win.votes < config.signal.minDistinctWallets) {
    return { ok: false, reason: `votes_below_min(${win.votes})` };
  }
  const walletResult = validateWallets({
    db,
    config,
    window: win,
    clusters,
    hasRecentGap: false,
    nowSec: now,
  });
  if (walletResult.status !== 'pass') {
    return { ok: false, reason: walletResult.reason ?? 'wallet_invalid' };
  }
  const tokenResult = await validateToken({
    db,
    config,
    gateway,
    token: signal.token,
    nowSec: now,
    validWallets: walletResult.validWallets,
    logger: deps.logger,
  });
  if (tokenResult.snapshot === null) {
    return { ok: false, reason: tokenResult.reason ?? 'token_deferred' };
  }
  // 异步富化完成后重新获取时间，统一用于缺口/窗口/钱包校验与有效期判断
  const nowAfter = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const statusNow = db.prepare('SELECT triggered_at, status FROM signals WHERE id = ?').get(signalId) as
    | { triggered_at: number; status: string }
    | undefined;
  if (!statusNow || statusNow.status !== 'sending') {
    return { ok: false, reason: 'candidate_not_sending' };
  }
  if (nowAfter - statusNow.triggered_at > 3600) {
    return { ok: false, reason: 'candidate_expired' };
  }
  const integrityNow = checkIntegrity(db, ['smartmoney', 'kol', 'follow'], nowAfter);
  if (integrityNow.blocked) {
    return { ok: false, reason: 'integrity_gap' };
  }
  // 富化期间持仓/窗口可能变化：用最新时间再次校验
  const walletsNow = db
    .prepare('SELECT DISTINCT maker FROM trades WHERE base_address = ? AND timestamp >= ?')
    .all(signal.token, nowAfter - config.signal.windowMinutes * 60) as Array<{ maker: string }>;
  const clustersNow = buildClusters(db, signal.token, walletsNow.map((r) => r.maker), {
    blacklist,
    enabled: config.signal.clusterMerge,
      sameFunder: config.walletFilter.cluster.sameFunder,
    creationTimeDeltaMinutes: config.walletFilter.cluster.creationTimeDeltaMinutes,
    excludeFunderLabels: config.walletFilter.cluster.excludeFunderLabels,
  });
  const winNow = computeWindow(db, signal.token, nowAfter, config, clustersNow);
  if (winNow.votes < config.signal.minDistinctWallets) {
    return { ok: false, reason: 'send_recheck_votes' };
  }
  const recheck = validateWallets({
    db,
    config,
    window: winNow,
    clusters: clustersNow,
    hasRecentGap: integrityNow.blocked,
    nowSec: nowAfter,
  });
  if (recheck.status !== 'pass') {
    return { ok: false, reason: recheck.reason ?? 'send_recheck_failed' };
  }
  const finalToken = validateTokenSnapshot({ db, config, gateway, token: signal.token, nowSec: nowAfter,
    validWallets: recheck.validWallets, logger: deps.logger }, tokenResult.snapshot!);
  if (finalToken.status !== 'pass' && finalToken.status !== 'warn') return { ok: false, reason: finalToken.reason ?? 'token_recheck_failed' };
  const effectiveVotesNow = new Set(recheck.validWallets.map((w) => clustersNow.clusterOf.get(w.wallet) ?? w.wallet)).size;
  // 尚未首次发送：显示成员和退出监控成员必须与本次完整复核一致。
  db.transaction(() => {
    db.prepare('DELETE FROM signal_wallets WHERE signal_id = ?').run(signalId);
    persistSignalWallets(db, signalId, signal.token, recheck.validWallets, clustersNow, 0, nowAfter);
    db.prepare('UPDATE signals SET net_inflow_usd = ?, display_wallets = ? WHERE id = ?').run(winNow.netInflowUsd.toNumber(), displayWallets(recheck.validWallets, clustersNow), signalId);
  })();
  return { ok: true, priceRatio: finalToken.priceRatio?.toNumber() ?? null,
    holdingRatio: recheck.retentionRatio?.toNumber() ?? null, votes: effectiveVotesNow, warn: finalToken.warn,
    partialHoldings: recheck.verifiableCount < recheck.validWallets.length };
}

function displayWallets(wallets: Array<{ wallet: string; tags: string[]; sources: string[]; action: 'open' | 'add' | null; qualifyingBuyUsd: { toString(): string } }>, clusters: ClusterResult): string {
  return JSON.stringify(wallets.map((w) => ({ wallet: w.wallet, clusterId: clusters.clusterOf.get(w.wallet) ?? w.wallet,
    tags: w.tags, sources: w.sources, action: w.action, qualifyingBuyUsd: w.qualifyingBuyUsd.toString() })));
}

function buildSnapshot(
  db: Db,
  token: string,
  win: WindowMetrics,
  clusters: ClusterResult,
  tokenSnapshot: TokenSnapshot | null,
  extra: { priceRatio: string | null; warn: boolean },
  validWallets: Array<{ wallet: string; tags: string[]; sources: string[]; action: 'open' | 'add' | null; qualifyingBuyUsd: { toString(): string } }>,
): unknown {
  return {
    token,
    windowStart: win.windowStart,
    windowEnd: win.windowEnd,
    votes: win.votes,
    netInflowUsd: win.netInflowUsd.toString(),
    priceRatio: extra.priceRatio,
    warn: extra.warn,
    wallets: validWallets.map((w) => ({
      wallet: w.wallet,
      clusterId: clusters.clusterOf.get(w.wallet) ?? w.wallet,
      cycleNo: getLatestCycle(db, w.wallet, token)?.cycleNo ?? null,
      tags: w.tags,
      sources: w.sources,
      action: w.action,
      qualifyingBuyUsd: w.qualifyingBuyUsd.toString(),
    })),
    tokenMetrics: tokenSnapshot
      ? {
          price: tokenSnapshot.price,
          marketCap: tokenSnapshot.marketCap,
          liquidity: tokenSnapshot.liquidity,
          holderCount: tokenSnapshot.holderCount,
          createdAt: tokenSnapshot.createdAt,
        }
      : null,
  };
}

/**
 * 候选评估（M2-4 ~ M2-8）：
 * 完整性门禁 → 富化 → 成本完整性重算 → 窗口聚合 → 关联合并
 * → 钱包层校验 → 代币层校验 → 状态落库 → sending + push_tasks 原子创建
 */
const evaluationsInFlight = new WeakMap<Db, Map<string, Promise<EvaluateResult>>>();
export async function evaluateToken(deps: EngineDeps, token: string): Promise<EvaluateResult> {
  let inFlight = evaluationsInFlight.get(deps.db);
  if (!inFlight) { inFlight = new Map(); evaluationsInFlight.set(deps.db, inFlight); }
  const previous = inFlight.get(token);
  if (previous) return previous;
  const run = evaluateTokenOnce(deps, token).finally(() => inFlight!.delete(token));
  inFlight.set(token, run);
  return run;
}

async function evaluateTokenOnce(deps: EngineDeps, token: string): Promise<EvaluateResult> {
  const { db, config, gateway, logger, blacklist } = deps;
  let now = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  resolveStaleGaps(db, now);
  expireStaleCandidates(db, token, now, config.signal.windowMinutes, config.tradeFilter.minTradeAmountUsd);

  const base: EvaluateResult = {
    token,
    status: 'watching',
    signalId: null,
    reason: null,
    votes: 0,
    netInflowUsd: '0',
    retentionRatio: null,
    priceRatio: null,
    pushTaskCreated: false,
  };

  if (getKv<boolean>(db, `rebuild_paused:${token}`) === true) {
    return { ...base, status: 'deferred', reason: 'rebuild_in_progress' };
  }
  // 硬过滤禁验期（固定截止，不被新买入延长）
  const hardblockUntil = getKv<number>(db, `hardblock:${token}`) ?? 0;
  if (now < hardblockUntil) {
    return { ...base, status: 'deferred', reason: 'hard_filter_cooldown' };
  }
  let retriggerUntil = getKv<number>(db, `retrigger:${token}`) ?? 0;

  let existing = findReusableSignal(db, token, now);
  let pushed = existing
    ? null
    : findPushedSignal(db, token, now, config.push.stopEditAfterMinutes);
  if (
    !existing &&
    pushed === null &&
    findPushedInCooldown(db, token, now, config.signal.cooldownMinutes)
  ) {
    return { ...base, status: 'cooldown', reason: 'cooldown_active' };
  }

  const evaluate = (
    signalId: number | null,
    stage: 'wallet_layer' | 'token_layer' | 'send_recheck',
    result: 'pass' | 'fail',
    reason: string | null,
    inputSnapshot: unknown,
  ): void => {
    if (signalId === null) return;
    recordEvaluation(db, {
      signalId,
      stage,
      configVersion: deps.configVersion,
      rulesVersion: deps.rulesVersion,
      inputSnapshot,
      result,
      reason,
    });
  };

  // 富化（失败 → suppressed）
  let tokenSnapshot: TokenSnapshot;
  try {
    tokenSnapshot = await enrichToken(db, gateway, token, { logger, now: deps.now });
  } catch (err) {
    logger.warn('候选富化失败', { token, error: err });
    if (existing) {
      updateSignalIfReusable(db, existing.id, {
        status: 'suppressed_enrich_failed',
        reason: 'enrich_failed',
      });
      evaluate(existing.id, 'token_layer', 'fail', 'enrich_failed', { token });
      return {
        ...base,
        status: 'suppressed_enrich_failed',
        signalId: existing.id,
        reason: 'enrich_failed',
      };
    }
    return { ...base, status: 'suppressed_enrich_failed', reason: 'enrich_failed' };
  }

  // 成本完整性重算（仅零余额检查点可授予；缺口传播）
  const earlyGap = checkIntegrity(db, ['smartmoney', 'kol', 'follow'], now);
  recomputeCostCompleteness(db, token, {
    tokenCreatedAt: tokenSnapshot.createdAt,
    observationStartedAt: getKv<number>(db, 'observation_started_at'),
    hasRecentGap: earlyGap.blocked,
    dustRatio: config.signalValidation.positionDustRatio,
  });

  // 窗口 + 聚类
  const walletsInWindow = db
    .prepare('SELECT DISTINCT maker FROM trades WHERE base_address = ? AND timestamp >= ?')
    .all(token, now - config.signal.windowMinutes * 60) as Array<{ maker: string }>;
  // 画像按需补拉（§7.2）：补拉完成后重新过滤/聚类/计票
  const missingProfiles = walletsInWindow
    .map((r) => r.maker)
    .filter((wallet) => { const profile = getWalletProfile(db, wallet); return !profile || now - profile.refreshedAt > 1800; });
  if (missingProfiles.length > 0) {
    try {
      await enrichWallets(db, gateway, missingProfiles, { logger, now: deps.now });
    } catch (err) {
      logger.warn('钱包画像补拉失败', { token, count: missingProfiles.length, error: err });
    }
  }

  // 所有异步富化完成后，以最新时刻、窗口和生命周期做同步判定。
  try {
    tokenSnapshot = await enrichToken(db, gateway, token, { logger, now: deps.now });
  } catch {
    return { ...base, status: 'suppressed_enrich_failed', signalId: existing?.id ?? null, reason: 'enrich_failed' };
  }
  now = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  expireStaleCandidates(db, token, now, config.signal.windowMinutes, config.tradeFilter.minTradeAmountUsd);
  retriggerUntil = getKv<number>(db, `retrigger:${token}`) ?? 0;
  existing = findReusableSignal(db, token, now);
  pushed = existing ? null : findPushedSignal(db, token, now, config.push.stopEditAfterMinutes);
  if (!existing && !pushed && findPushedInCooldown(db, token, now, config.signal.cooldownMinutes)) {
    return { ...base, status: 'cooldown', reason: 'cooldown_active' };
  }
  recomputeCostCompleteness(db, token, {
    tokenCreatedAt: tokenSnapshot.createdAt,
    observationStartedAt: getKv<number>(db, 'observation_started_at'),
    hasRecentGap: checkIntegrity(db, ['smartmoney', 'kol', 'follow'], now).blocked,
    dustRatio: config.signalValidation.positionDustRatio,
  });
  const finalWallets = db.prepare('SELECT DISTINCT maker FROM trades WHERE base_address = ? AND timestamp >= ? AND timestamp <= ?')
    .all(token, now - config.signal.windowMinutes * 60, now) as Array<{ maker: string }>;
  const clusters = buildClusters(
    db,
    token,
    finalWallets.map((r) => r.maker),
    {
      blacklist,
      enabled: config.signal.clusterMerge,
      sameFunder: config.walletFilter.cluster.sameFunder,
      creationTimeDeltaMinutes: config.walletFilter.cluster.creationTimeDeltaMinutes,
      excludeFunderLabels: config.walletFilter.cluster.excludeFunderLabels,
    },
  );
  const win = computeWindow(db, token, now, config, clusters);

  if (win.votes < config.signal.minDistinctWallets && pushed === null) {
    if (existing) {
      const reason = `votes_below_min(${win.votes})`;
      updateSignalIfReusable(db, existing.id, { status: 'invalidated', reason });
      evaluate(existing.id, 'wallet_layer', 'fail', reason, { votes: win.votes });
      return {
        ...base,
        status: 'invalidated',
        signalId: existing.id,
        reason,
        votes: win.votes,
        netInflowUsd: win.netInflowUsd.toString(),
      };
    }
    // 候选结束后的重新触发冷却（5 分钟）
    if (now < retriggerUntil) {
      return { ...base, status: 'watching', reason: 'retrigger_cooldown', votes: win.votes };
    }
    return { ...base, votes: win.votes, netInflowUsd: win.netInflowUsd.toString() };
  }

  // 完整性门禁
  const sources = new Set<string>();
  for (const w of win.wallets) for (const s of w.sources) sources.add(s);
  if (sources.size === 0) for (const s of ['smartmoney', 'kol', 'follow']) sources.add(s);
  const integrity = checkIntegrity(db, [...sources], now);
  if (integrity.blocked) {
    if (existing) {
      evaluate(existing.id, 'wallet_layer', 'fail', 'integrity_gap', {
        gaps: integrity.recentGaps,
      });
    }
    return {
      ...base,
      status: 'deferred',
      signalId: existing?.id ?? null,
      reason: 'integrity_gap',
      votes: win.votes,
    };
  }

  // 新候选创建前统一检查重新触发冷却（已有候选更新不受影响）
  if (existing === null && pushed === null && now < retriggerUntil) {
    return { ...base, status: 'deferred', reason: 'retrigger_cooldown', votes: win.votes };
  }

  // 候选行（升级场景复用已推送信号，不新建行）
  let signalId = existing?.id ?? null;
  if (signalId === null && pushed !== null) {
    signalId = pushed.id;
  }
  if (signalId === null) {
    const res = db
      .prepare(
        `INSERT INTO signals (token, symbol, triggered_at, window_start, window_end, wallet_count, net_inflow_usd, status, price_at_trigger)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'candidate', ?)`,
      )
      .run(
        token,
        tokenSnapshot.symbol,
        now,
        win.windowStart,
        win.windowEnd,
        win.votes,
        win.netInflowUsd.toNumber(),
        tokenSnapshot.price,
      );
    signalId = Number(res.lastInsertRowid);
  }

  // 钱包层
  const walletResult = validateWallets({
    db,
    config,
    window: win,
    clusters,
    hasRecentGap: integrity.recentGaps.length > 0,
    nowSec: now,
  });
  const nextDisplay = displayWallets(walletResult.validWallets, clusters);
  if (!pushed) db.prepare('UPDATE signals SET display_wallets = ? WHERE id = ?').run(nextDisplay, signalId);
  if (pushed) {
    const ratio = boundHoldingRatio(db, pushed.id);
    walletResult.retentionRatio = ratio === null ? null : new Decimal(ratio);
  }
  const effectiveVotes = new Set(
    walletResult.validWallets.map((w) => clusters.clusterOf.get(w.wallet) ?? w.wallet),
  ).size;
  if (walletResult.status !== 'pass') {
    const deferred = walletResult.status === 'deferred';
    if (!deferred && pushed === null) {
      updateSignalIfReusable(db, signalId, { status: 'invalidated', reason: walletResult.reason });
    }
    if (!deferred && pushed !== null) {
      const changed = shouldEscalate(
        db,
        pushed.id,
        {
          votes: effectiveVotes,
          displayWallets: nextDisplay,
          retention: walletResult.retentionRatio?.toNumber() ?? null,
          priceRatio: null,
          warn: false,
          partial: false,
          downgrade: true,
        },
        config.push.editThrottleSec,
        now,
      );
      if (changed) {
        createEscalateTask(
          db,
          pushed.id,
          pushed.message_revision + 1,
          { downgraded: true },
          {
            wallet_count: effectiveVotes, display_wallets: nextDisplay,
            net_inflow_usd: win.netInflowUsd.toNumber(),
            holding_ratio: walletResult.retentionRatio?.toNumber() ?? null,
          },
          now,
        );
        markEdited(db, pushed.id, false, now);
      }
    }
    evaluate(signalId, 'wallet_layer', 'fail', walletResult.reason, {
      votes: effectiveVotes,
      verifiableCount: walletResult.verifiableCount,
      retentionRatio: walletResult.retentionRatio?.toString() ?? null,
    });
    return {
      ...base,
      status: deferred ? 'deferred' : 'invalidated',
      signalId,
      reason: walletResult.reason,
      votes: effectiveVotes,
      netInflowUsd: win.netInflowUsd.toString(),
      retentionRatio: walletResult.retentionRatio?.toString() ?? null,
    };
  }

  // 代币层
  const tokenResult = validateTokenSnapshot({
    db,
    config,
    gateway,
    token,
    nowSec: now,
    validWallets: walletResult.validWallets,
    logger,
  }, tokenSnapshot);

  if (tokenResult.status === 'deferred' || tokenResult.status === 'invalidated') {
    const deferred = tokenResult.status === 'deferred';
    if (!deferred && pushed === null) {
      updateSignalIfReusable(db, signalId, {
        status: 'invalidated',
        reason: tokenResult.reason,
      });
      // 硬过滤失败：固定 10 分钟禁验期
      setKv(db, `hardblock:${token}`, now + 600, now);
    }
    if (!deferred && pushed !== null) {
      const changed = shouldEscalate(
        db,
        pushed.id,
        {
          votes: effectiveVotes,
          displayWallets: nextDisplay,
          retention: null,
          priceRatio: null,
          warn: false,
          partial: false,
          downgrade: true,
        },
        config.push.editThrottleSec,
        now,
      );
      if (changed) {
        createEscalateTask(
          db,
          pushed.id,
          pushed.message_revision + 1,
          { downgraded: true },
          { wallet_count: effectiveVotes, display_wallets: nextDisplay, net_inflow_usd: win.netInflowUsd.toNumber() },
          now,
        );
        markEdited(db, pushed.id, false, now);
      }
    }
    evaluate(signalId, 'token_layer', 'fail', tokenResult.reason, {
      reason: tokenResult.reason,
    });
    return {
      ...base,
      status: deferred ? 'deferred' : 'invalidated',
      signalId,
      reason: tokenResult.reason,
      votes: effectiveVotes,
      netInflowUsd: win.netInflowUsd.toString(),
      retentionRatio: walletResult.retentionRatio?.toString() ?? null,
      priceRatio: tokenResult.priceRatio?.toString() ?? null,
    };
  }

  if (tokenResult.status === 'blocked_price') {
    // 已推送信号保持 pushed（退出监控依赖该状态），仅渲染降级
    if (pushed === null) {
      updateSignalIfReusable(db, signalId, { status: 'blocked_price', reason: tokenResult.reason });
    } else if (
      shouldEscalate(
        db,
        pushed.id,
        {
          votes: effectiveVotes,
          displayWallets: nextDisplay,
          retention: walletResult.retentionRatio?.toNumber() ?? null,
          priceRatio: tokenResult.priceRatio?.toNumber() ?? null,
          warn: true,
          partial: false,
          downgrade: true,
        },
        config.push.editThrottleSec,
        now,
      )
    ) {
      createEscalateTask(
        db,
        pushed.id,
        pushed.message_revision + 1,
        { downgraded: true, priceRatio: tokenResult.priceRatio?.toString() ?? null },
        {
          wallet_count: effectiveVotes, display_wallets: nextDisplay,
          price_ratio: tokenResult.priceRatio?.toNumber() ?? null,
        },
        now,
      );
      markEdited(db, pushed.id, false, now);
    }
    evaluate(pushed?.id ?? signalId, 'token_layer', 'fail', tokenResult.reason, {
      priceRatio: tokenResult.priceRatio?.toString() ?? null,
    });
    return {
      ...base,
      status: 'blocked_price',
      signalId: pushed?.id ?? signalId,
      reason: tokenResult.reason,
      votes: effectiveVotes,
      priceRatio: tokenResult.priceRatio?.toString() ?? null,
    };
  }

  // 通过 → 已推送信号走升级编辑，否则创建首次推送任务
  evaluate(signalId, 'token_layer', 'pass', tokenResult.reason, {
    priceRatio: tokenResult.priceRatio?.toString() ?? null,
    warn: tokenResult.warn,
  });

  const partialHoldings = walletResult.verifiableCount < walletResult.validWallets.length;

  if (pushed !== null) {
    const next = {
      votes: effectiveVotes,
      displayWallets: nextDisplay,
      retention: walletResult.retentionRatio?.toNumber() ?? null,
      priceRatio: tokenResult.priceRatio?.toNumber() ?? null,
      warn: tokenResult.warn,
      partial: partialHoldings,
    };
    const boundMembers = new Set((db.prepare('SELECT wallet FROM signal_wallets WHERE signal_id=?').all(pushed.id) as Array<{ wallet: string }>).map(row => row.wallet));
    const memberVersion = pushed.escalated_count + (walletResult.validWallets.some(wallet => !boundMembers.has(wallet.wallet)) ? 1 : 0);
    let created = false;
    if (shouldEscalate(db, pushed.id, next, config.push.editThrottleSec, now)) {
      created = createEscalateTask(
        db,
        pushed.id,
        pushed.message_revision + 1,
        { warn: tokenResult.warn, partialHoldings, evaluatedAt: now },
        {
          wallet_count: effectiveVotes, display_wallets: nextDisplay,
          escalated_count: memberVersion,
          net_inflow_usd: win.netInflowUsd.toNumber(),
          holding_ratio: walletResult.retentionRatio?.toNumber() ?? null,
          price_ratio: tokenResult.priceRatio?.toNumber() ?? null,
        },
        now,
      );
      if (created) {
        persistSignalWallets(
          db,
          pushed.id,
          token,
          walletResult.validWallets,
          clusters,
          memberVersion,
          now,
        );
        updateSignal(db, pushed.id, { holding_ratio: boundHoldingRatio(db, pushed.id) });
        markEdited(db, pushed.id, partialHoldings, now);
        logger.info('信号升级编辑已入队', { signalId: pushed.id, token, votes: effectiveVotes });
      }
    }
    return {
      ...base,
      status: 'sending',
      signalId: pushed.id,
      reason: tokenResult.reason,
      votes: effectiveVotes,
      netInflowUsd: win.netInflowUsd.toString(),
      retentionRatio: walletResult.retentionRatio?.toString() ?? null,
      priceRatio: tokenResult.priceRatio?.toString() ?? null,
      pushTaskCreated: created,
    };
  }

  const snapshot = existing?.snapshot
    ? null
    : JSON.stringify(
        buildSnapshot(
          db,
          token,
          { ...win, votes: effectiveVotes },
          clusters,
          tokenResult.snapshot,
          { priceRatio: tokenResult.priceRatio?.toString() ?? null, warn: tokenResult.warn },
          walletResult.validWallets,
        ),
      );

  const tx = db.transaction((): boolean => {
    const current = db.prepare('SELECT status FROM signals WHERE id = ?').get(signalId) as
      | { status: string }
      | undefined;
    if (!current || !REUSABLE_STATUSES.includes(current.status)) {
      return false; // 已送达/已终结：禁止覆盖发送终态
    }
    updateSignal(db, signalId, {
      status: 'sending',
      reason: tokenResult.reason,
      wallet_count: effectiveVotes, display_wallets: nextDisplay,
      net_inflow_usd: win.netInflowUsd.toNumber(),
      holding_ratio: walletResult.retentionRatio?.toNumber() ?? null,
      price_ratio: tokenResult.priceRatio?.toNumber() ?? null,
      price_at_trigger: (db.prepare('SELECT price_at_trigger FROM signals WHERE id = ?').get(signalId) as { price_at_trigger: string | null }).price_at_trigger ?? tokenResult.snapshot?.price ?? null,
      ...(snapshot !== null ? { snapshot } : {}),
    });
    const res = db
      .prepare(
        `INSERT INTO push_tasks (signal_id, kind, revision, dedupe_key, payload, status, created_at, updated_at)
         VALUES (?, 'signal', 0, ?, ?, 'pending', ?, ?)
         ON CONFLICT(dedupe_key) DO UPDATE SET
           payload = excluded.payload,
           status = CASE WHEN push_tasks.status = 'cancelled' THEN 'pending' ELSE push_tasks.status END,
           attempts = CASE WHEN push_tasks.status = 'cancelled' THEN 0 ELSE push_tasks.attempts END,
           next_retry_at = CASE WHEN push_tasks.status = 'cancelled' THEN NULL ELSE push_tasks.next_retry_at END,
           updated_at = excluded.updated_at
         WHERE push_tasks.status IN ('pending','failed','unknown','cancelled')`,
      )
      .run(
        signalId,
        `${signalId}:signal`,
        JSON.stringify({
          signalId,
          token,
          warn: tokenResult.warn,
          partialHoldings,
          evaluatedAt: now,
          priceRatio: tokenResult.priceRatio?.toString() ?? null,
        }),
        now,
        now,
      );
    return res.changes > 0;
  });
  const pushTaskCreated = tx();
  if ((db.prepare('SELECT status FROM signals WHERE id = ?').get(signalId) as { status: string }).status === 'sending') {
    persistSignalWallets(db, signalId, token, walletResult.validWallets, clusters, 0, now);
  }

  logger.info('候选校验通过，进入发送队列', {
    signalId,
    token,
    votes: effectiveVotes,
    warn: tokenResult.warn,
    pushTaskCreated,
  });

  return {
    ...base,
    status: 'sending',
    signalId,
    reason: tokenResult.reason,
    votes: effectiveVotes,
    netInflowUsd: win.netInflowUsd.toString(),
    retentionRatio: walletResult.retentionRatio?.toString() ?? null,
    priceRatio: tokenResult.priceRatio?.toString() ?? null,
    pushTaskCreated,
  };
}
