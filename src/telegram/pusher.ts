import { measureAsync, runtimeMetrics } from '../ops/metrics.js';
import { measureTelegram } from './telemetry.js';
import { TelegramDeliveryUnknownError } from './types.js';
import type { CexBlacklist } from '../enrich/wallet.js';
import { countOtherExitedClusters } from './exit-monitor.js';
import { boundHoldingRatio, closedBoundClusters } from '../signal/members.js';
import { Decimal } from 'decimal.js';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { getKv, setKv, type Db } from '../store/db.js';
import {
  buildKeyboard,
  formatExitAlert,
  formatSignalMessage,
  type ExitView,
  type FormatWallet,
  type SignalView,
} from './format.js';
import { TelegramRateLimitError, type TelegramApi } from './types.js';

export interface PusherDeps {
  blacklist?: CexBlacklist;
  db: Db;
  config: AppConfig;
  sender: TelegramApi;
  chatId: string;
  logger: Logger;
  now?: () => number;
  /** 发送前完整资格复核（返回最新发送数据，ok=false 时取消任务） */
  revalidate?: (signalId: number) => Promise<{
    ok: boolean;
    reason?: string;
    priceRatio?: number | null;
    holdingRatio?: number | null;
    votes?: number;
    warn?: boolean;
    partialHoldings?: boolean;
  }>;
}

export interface PushRunResult {
  processed: number;
  sent: number;
  deferred: number;
  cancelled: number;
  failed: number;
}

interface TaskRow {
  id: number;
  created_at: number;
  signal_id: number;
  kind: 'signal' | 'escalate' | 'exit_alert';
  alert_type: string | null;
  revision: number;
  payload: string;
  status: string;
  attempts: number;
  max_attempts: number;
  next_retry_at: number | null;
  tg_message_id: number | null;
}

interface SignalRow {
  id: number;
  token: string;
  symbol: string | null;
  status: string;
  wallet_count: number | null;
  net_inflow_usd: number | null;
  holding_ratio: number | null;
  price_ratio: number | null;
  message_revision: number;
  tg_message_id: number | null;
  snapshot: string | null;
  display_wallets: string | null;
  sent_at: number | null;
  triggered_at: number;
}

interface TokenRow {
  address: string;
  symbol: string | null;
  launchpad: string | null;
  created_at: number | null;
  price: string | null;
  market_cap: number | null;
  liquidity: number | null;
  holder_count: number | null;
  top10_rate: number | null;
  bundler_rate: number | null;
  insider_rate: number | null;
  creator_token_status: string | null;
  socials: string | null;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function loadSignalView(db: Db, signalId: number, nowSec: number): SignalView | null {
  const signal = db.prepare('SELECT * FROM signals WHERE id = ?').get(signalId) as SignalRow | undefined;
  if (!signal) return null;
  const token = db.prepare('SELECT * FROM tokens WHERE address = ?').get(signal.token) as
    | TokenRow
    | undefined;
  const snapshot = parseJson<{
    wallets?: Array<{
      wallet: string;
      clusterId: string;
      tags: string[];
      sources: string[];
      action: 'open' | 'add' | null;
      qualifyingBuyUsd: string;
    }>;
  }>(signal.snapshot, {});

  const wallets: FormatWallet[] = (() => {
    if (signal.display_wallets !== null && signal.display_wallets !== undefined) return parseJson<FormatWallet[]>(signal.display_wallets, []);
    const bound = db
      .prepare(
        `SELECT wallet, cluster_id, tags, source, amount_usd, action
         FROM signal_wallets WHERE signal_id = ? AND active = 1 ORDER BY wallet`,
      )
      .all(signal.id) as Array<{
      wallet: string;
      cluster_id: string | null;
      tags: string | null;
      source: string | null;
      amount_usd: string | null;
      action: string | null;
    }>;
    if (bound.length > 0) {
      return bound.map((row) => ({
        clusterId: row.cluster_id ?? row.wallet,
        tags: parseJson<string[]>(row.tags, []),
        sources: (row.source ?? '').split(',').filter(Boolean),
        action: row.action === 'open' || row.action === 'add' ? row.action : null,
        qualifyingBuyUsd: row.amount_usd ?? '0',
      }));
    }
    return (snapshot.wallets ?? []).map((w) => ({
      clusterId: w.clusterId,
      tags: w.tags,
      sources: w.sources,
      action: w.action,
      qualifyingBuyUsd: w.qualifyingBuyUsd,
    }));
  })();
  const totalBuyUsd = wallets
    .reduce((sum, w) => sum.plus(w.qualifyingBuyUsd), new Decimal(0))
    .toString();

  const currentPrice = token?.price ?? null;
  const avgEntryPrice =
    currentPrice && signal.price_ratio && signal.price_ratio > 0
      ? new Decimal(currentPrice).div(signal.price_ratio).toFixed(10)
      : null;

  return {
    signalId: signal.id,
    token: signal.token,
    symbol: signal.symbol ?? token?.symbol ?? null,
    launchpad: token?.launchpad ?? null,
    tokenAgeMinutes:
      token?.created_at != null ? Math.floor((nowSec - token.created_at) / 60) : null,
    marketCap: token?.market_cap ?? null,
    liquidity: token?.liquidity ?? null,
    holderCount: token?.holder_count ?? null,
    votes: signal.wallet_count ?? 0,
    windowMinutes: 15,
    wallets,
    totalBuyUsd,
    netInflowUsd: String(signal.net_inflow_usd ?? 0),
    retentionRatio: signal.status === 'pushed' ? boundHoldingRatio(db, signal.id) : signal.holding_ratio,
    priceRatio: signal.price_ratio,
    currentPrice,
    avgEntryPrice,
    top10Rate: token?.top10_rate ?? null,
    bundlerRate: token?.bundler_rate ?? null,
    insiderRate: token?.insider_rate ?? null,
    devStatus: token?.creator_token_status ?? null,
    socials: parseJson<{ twitter?: string; telegram?: string; website?: string }>(
      token?.socials ?? null,
      {},
    ),
    partialHoldings: false,
  };
}

function loadExitView(db: Db, task: TaskRow, nowSec: number): ExitView | null {
  const view = loadSignalView(db, task.signal_id, nowSec);
  if (!view) return null;
  const payload = parseJson<{
    exitedClusters?: number;
    clusterBreakdown?: Array<{ label: string; count: number }>;
  }>(task.payload, {});
  return {
    signalId: view.signalId,
    token: view.token,
    symbol: view.symbol,
    launchpad: view.launchpad,
    tokenAgeMinutes: view.tokenAgeMinutes,
    exitedClusters: payload.exitedClusters ?? 1,
    clusterBreakdown: payload.clusterBreakdown ?? [{ label: '共识', count: payload.exitedClusters ?? 1 }],
    retentionRatio: view.retentionRatio,
    priceRatio: view.priceRatio,
    currentPrice: view.currentPrice,
    avgEntryPrice: view.avgEntryPrice,
  };
}

function inQuietHours(config: AppConfig, nowSec: number): boolean {
  const date = new Date(nowSec * 1000);
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  const [sh, sm] = config.push.quietHours.start.split(':').map(Number) as [number, number];
  const [eh, em] = config.push.quietHours.end.split(':').map(Number) as [number, number];
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  if (start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

function isMuted(db: Db, token: string, nowSec: number): boolean {
  const raw = getKv<{ until?: number } | true>(db, `mute:${token}`);
  if (raw === null) return false;
  if (raw === true) return true;
  if (typeof raw === 'object' && raw.until != null) return raw.until > nowSec;
  return true;
}

/**
 * push_tasks 执行器（M3-2/M3-4/M3-5）：
 * - 状态机：pending → sending → sent / unknown / failed / cancelled
 * - 优先级：退出提醒 > 新信号/升级；退出提醒不占限流额度
 * - 静默时段只放行强信号；暂停只影响新信号/升级
 * - 发送成功回调按任务类型区分（仅 kind=signal 写原信号发送信息）
 */
export class Pusher {
  private readonly now: () => number;
  private running = false;

  constructor(private readonly deps: PusherDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  async runOnce(): Promise<PushRunResult> {
    const { db, config, logger } = this.deps;
    const empty: PushRunResult = { processed: 0, sent: 0, deferred: 0, cancelled: 0, failed: 0 };
    if (this.running) return empty;
    this.running = true;
    try {
      return await this.runBatch();
    } finally {
      this.running = false;
    }
  }

  private async runBatch(): Promise<PushRunResult> {
    const { db, config, logger } = this.deps;
    const nowSec = Math.floor(this.now() / 1000);
    const result: PushRunResult = { processed: 0, sent: 0, deferred: 0, cancelled: 0, failed: 0 };

    // 重启/崩溃恢复：卡在 sending 超过 10s 的任务转 unknown（可重试）
    db.prepare(
      `UPDATE push_tasks SET status = 'unknown', updated_at = ?
       WHERE status = 'sending' AND updated_at < ?`,
    ).run(nowSec, nowSec - 10);

    const sentRecently = db
      .prepare(
        `SELECT COUNT(*) AS n FROM push_tasks
         WHERE status = 'sent' AND kind IN ('signal','escalate') AND updated_at >= ?`,
      )
      .get(nowSec - 60) as { n: number };
    let budget = Math.max(0, config.push.maxPerMinute - sentRecently.n);

    const tasks = db
      .prepare(
        `SELECT t.* FROM push_tasks t
         LEFT JOIN signals s ON s.id = t.signal_id
         WHERE t.status = 'pending'
            OR (t.status IN ('failed','unknown') AND t.attempts < t.max_attempts
                AND (t.next_retry_at IS NULL OR t.next_retry_at <= ?))
         ORDER BY CASE t.kind WHEN 'exit_alert' THEN 0 WHEN 'escalate' THEN 1 ELSE 2 END,
                  CASE WHEN s.wallet_count >= ? THEN 0 ELSE 1 END,
                  t.created_at, t.id
         LIMIT 200`,
      )
      .all(nowSec, config.push.quietHours.minWallets) as TaskRow[];

    const paused = getKv<boolean>(db, 'paused') === true;

    for (const task of tasks) {
      result.processed += 1;
      const isExit = task.kind === 'exit_alert';
      if (!isExit && paused) {
        result.deferred += 1;
        continue;
      }
      if (!isExit && budget <= 0) {
        result.deferred += 1;
        continue;
      }
      if (!isExit && task.kind === 'signal') {
        const view = loadSignalView(db, task.signal_id, nowSec);
        if (view && inQuietHours(config, nowSec) && view.votes < config.push.quietHours.minWallets) {
          result.deferred += 1;
          continue;
        }
        if (view && isMuted(db, view.token, nowSec)) {
          this.cancelTask(task, nowSec, 'muted');
          // 结束原候选，解除屏蔽后按冷却规则重新触发
          db.prepare(
            `UPDATE signals SET status = 'expired', reason = 'muted' WHERE id = ? AND status = 'sending'`,
          ).run(task.signal_id);
          setKv(db, `retrigger:${view.token}`, nowSec + 300, nowSec);
          result.cancelled += 1;
          continue;
        }
      }
      // 原子领取：只有成功从 pending/failed/unknown 转为 sending 才发送
      const claimed = db
        .prepare(
          `UPDATE push_tasks SET status = 'sending', updated_at = ?
           WHERE id = ? AND status IN ('pending','failed','unknown')`,
        )
        .run(nowSec, task.id);
      if (claimed.changes === 0) {
        result.deferred += 1;
        continue;
      }
      runtimeMetrics.observe(`push.queue.${task.kind}`, Math.max(0, this.now() - task.created_at * 1000));
      const outcome = await measureAsync(`push.process.${task.kind}`, () => this.processTask(task, nowSec));
      if (outcome === 'sent') {
        result.sent += 1;
        if (!isExit) budget -= 1;
      } else if (outcome === 'cancelled') result.cancelled += 1;
      else if (outcome === 'failed') result.failed += 1;
      else result.deferred += 1;
    }

    if (result.processed > 0) logger.debug('推送批次完成', { ...result });
    return result;
  }

  private cancelTask(task: TaskRow, nowSec: number, reason: string): void {
    this.deps.db
      .prepare(`UPDATE push_tasks SET status = 'cancelled', updated_at = ? WHERE id = ?`)
      .run(nowSec, task.id);
    this.deps.logger.info('推送任务取消', { taskId: task.id, kind: task.kind, reason });
  }

  private async processTask(task: TaskRow, nowSec: number): Promise<'sent' | 'failed' | 'cancelled' | 'deferred'> {
    const { db, config, chatId, logger } = this.deps;
    const sender = measureTelegram(this.deps.sender);

    try {
      if (task.kind === 'signal' || task.kind === 'escalate') {
        const signal = db
          .prepare('SELECT * FROM signals WHERE id = ?')
          .get(task.signal_id) as SignalRow | undefined;
        if (!signal) {
          this.cancelTask(task, nowSec, 'signal_missing');
          return 'cancelled';
        }
        const payload = parseJson<{
          warn?: boolean;
          partialHoldings?: boolean;
          downgraded?: boolean;
          evaluatedAt?: number;
        }>(task.payload, {});

        // 发送前复核（按任务类型）
        if (task.kind === 'signal') {
          if (signal.status !== 'sending') {
            this.cancelTask(task, nowSec, `signal_not_sending(${signal.status})`);
            return 'cancelled';
          }
          if (nowSec - signal.triggered_at > 3600) {
            db.prepare(
              `UPDATE signals SET status = 'expired', reason = 'lifecycle_expired' WHERE id = ?`,
            ).run(signal.id);
            this.cancelTask(task, nowSec, 'candidate_expired');
            return 'cancelled';
          }
          if (payload.evaluatedAt === undefined) {
            this.cancelTask(task, nowSec, 'missing_evaluated_at');
            db.prepare(
              `UPDATE signals SET status = 'expired', reason = 'missing_evaluated_at' WHERE id = ? AND status = 'sending'`,
            ).run(signal.id);
            return 'cancelled';
          }
          if (nowSec - payload.evaluatedAt > config.signalValidation.signalTtlSeconds) {
            this.cancelTask(task, nowSec, 'ttl_expired');
            db.prepare(
              `UPDATE signals SET status = 'expired', reason = 'ttl_expired' WHERE id = ? AND status = 'sending'`,
            ).run(signal.id);
            setKv(db, `retrigger:${signal.token}`, nowSec + 300, nowSec);
            return 'cancelled';
          }
          // 完整资格复核（票数/持仓/缺口/价格）
          if (this.deps.revalidate) {
            const check = await measureAsync('push.revalidate', () => this.deps.revalidate!(signal.id));
            nowSec = Math.floor(this.now() / 1000);
            const current = db.prepare('SELECT status, triggered_at FROM signals WHERE id = ?').get(signal.id) as { status: string; triggered_at: number } | undefined;
            if (!current || current.status !== 'sending' || nowSec - current.triggered_at > 3600) {
              this.cancelTask(task, nowSec, 'candidate_changed_during_recheck');
              return 'cancelled';
            }
            if (check.partialHoldings !== undefined) payload.partialHoldings = check.partialHoldings;
            if (check.ok) {
              // 用复核得到的最新数据刷新消息指标（价格比/保留率/票数/警告）
              db.prepare(
                `UPDATE signals SET price_ratio = COALESCE(?, price_ratio),
                   holding_ratio = COALESCE(?, holding_ratio),
                   wallet_count = COALESCE(?, wallet_count)
                 WHERE id = ?`,
              ).run(
                check.priceRatio ?? null,
                check.holdingRatio ?? null,
                check.votes ?? null,
                signal.id,
              );
              if (check.warn !== undefined) {
                const payloadNow = parseJson<Record<string, unknown>>(task.payload, {});
                payloadNow['warn'] = check.warn;
                db.prepare('UPDATE push_tasks SET payload = ? WHERE id = ?').run(
                  JSON.stringify(payloadNow),
                  task.id,
                );
              }
            }
            const nowAfter = Math.floor(this.now() / 1000);
            if (
              check.ok &&
              inQuietHours(config, nowAfter) &&
              (check.votes ?? 0) < config.push.quietHours.minWallets
            ) {
              // 复核后进入静默或降为弱信号：恢复待处理并延后
              db.prepare("UPDATE push_tasks SET status = 'pending', updated_at = ? WHERE id = ?").run(
                nowAfter,
                task.id,
              );
              return 'deferred';
            }
            if (!check.ok) {
              this.cancelTask(task, nowSec, `revalidate:${check.reason ?? 'failed'}`);
              db.prepare(
                `UPDATE signals SET status = 'expired', reason = ? WHERE id = ? AND status = 'sending'`,
              ).run(`send_recheck:${check.reason ?? 'failed'}`, signal.id);
              setKv(db, `retrigger:${signal.token}`, nowSec + 300, nowSec);
              return 'cancelled';
            }
          }
        }
        if (task.kind === 'escalate' && signal.message_revision !== task.revision) {
          this.cancelTask(task, nowSec, 'stale_revision');
          return 'cancelled';
        }
        const view = loadSignalView(db, task.signal_id, nowSec);
        if (!view) {
          this.cancelTask(task, nowSec, 'view_missing');
          return 'cancelled';
        }
        nowSec = Math.floor(this.now() / 1000);
        if (getKv<boolean>(db, 'paused') === true || (task.kind === 'signal' && isMuted(db, view.token, nowSec))) {
          db.prepare("UPDATE push_tasks SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'sending'").run(nowSec, task.id);
          return 'deferred';
        }
        const text = formatSignalMessage(
          {
            ...view,
            windowMinutes: config.signal.windowMinutes,
            upgraded: task.kind === 'escalate' && !payload.downgraded,
            downgraded: payload.downgraded === true,
            partialHoldings: payload.partialHoldings ?? false,
          },
          { links: config.push.links, buyButton: config.push.buyButton, strongWallets: config.signal.strongWallets, warnPriceAboveEntry: config.signalValidation.warnPriceAboveEntry },
        );
        const keyboard = buildKeyboard(view.token, {
          links: config.push.links,
          buyButton: config.push.buyButton,
        });

        if (task.kind === 'signal') {
          const sent = await sender.sendMessage(chatId, text, {
            parse_mode: 'HTML',
            reply_markup: keyboard,
            disable_web_page_preview: true,
          });
          nowSec = Math.floor(this.now() / 1000);
          const tx = db.transaction((): void => {
            db.prepare(
              `UPDATE push_tasks SET status = 'sent', tg_message_id = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?`,
            ).run(sent.message_id, nowSec, task.id);
            db.prepare(
              `UPDATE signals SET status = 'pushed', tg_message_id = ?, sent_at = ?, price_at_send = ?,
                 outcome_5m=NULL, outcome_1h=NULL, outcome_24h=NULL, send_snapshot=? WHERE id = ?`,
            ).run(sent.message_id, nowSec, view.currentPrice, JSON.stringify({
              votes: view.votes, priceRatio: view.priceRatio,
              sources: [...new Set(view.wallets.flatMap(wallet => wallet.sources))].sort(),
              warn: view.priceRatio !== null && view.priceRatio > config.signalValidation.warnPriceAboveEntry,
              tokenMetrics: { createdAt: view.tokenAgeMinutes === null ? null : nowSec - view.tokenAgeMinutes * 60, marketCap: view.marketCap },
            }), task.signal_id);
            for (const field of ['outcome_5m','outcome_1h','outcome_24h']) {
              db.prepare('DELETE FROM kv WHERE key IN (?,?)').run(`backtest_attempts:${task.signal_id}:${field}`, `backtest_giveup:${task.signal_id}:${field}`);
            }

          });
          tx();
          logger.info('信号已推送', { signalId: task.signal_id, token: view.token });
        } else {
          if (signal.tg_message_id === null) {
            this.cancelTask(task, nowSec, 'no_original_message');
            return 'cancelled';
          }
          const editWindowSec = config.push.stopEditAfterMinutes * 60;
          const sentAt = signal.sent_at ?? 0;
          if (nowSec - sentAt > editWindowSec) {
            // 超过编辑窗口：改为跟进消息，不动原消息
            const followUp = await sender.sendMessage(chatId, text, {
              parse_mode: 'HTML',
              reply_markup: keyboard,
              disable_web_page_preview: true,
            });
            db.prepare(
              `UPDATE push_tasks SET status = 'sent', tg_message_id = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?`,
            ).run(followUp.message_id, nowSec, task.id);
            logger.info('信号跟进消息已发送', { signalId: task.signal_id, revision: task.revision });
          } else {
            await sender.editMessageText(chatId, signal.tg_message_id, text, {
              parse_mode: 'HTML',
              reply_markup: keyboard,
              disable_web_page_preview: true,
            });
            db.prepare(
              `UPDATE push_tasks SET status = 'sent', attempts = attempts + 1, updated_at = ? WHERE id = ?`,
            ).run(nowSec, task.id);
            logger.info('信号已更新', { signalId: task.signal_id, revision: task.revision });
          }
        }
        return 'sent';
      }

      const exitSignal = db.prepare(`SELECT s.token, s.sent_at, t.created_at FROM signals s
        LEFT JOIN tokens t ON t.address=s.token WHERE s.id=?`).get(task.signal_id) as
        { token: string; sent_at: number | null; created_at: number | null } | undefined;
      const exitNow = Math.floor(this.now() / 1000);
      const monitoringExpired = !exitSignal || exitSignal.sent_at === null || exitNow - exitSignal.sent_at > 86400 ||
        (exitSignal.created_at !== null && exitNow - exitSignal.created_at > 86400);
      let stillEligible = false;
      if (exitSignal && !monitoringExpired) {
        if (task.alert_type === 'consensus_exit') {
          stillEligible = config.signalValidation.postPushExitAlert.enabled &&
            closedBoundClusters(db, task.signal_id) >= config.signalValidation.postPushExitAlert.minWallets;
        } else if (task.alert_type === 'other_cluster_exit') {
          const bound = db.prepare('SELECT wallet, cycle_no AS cycleNo FROM signal_wallets WHERE signal_id=?')
            .all(task.signal_id) as Array<{ wallet: string; cycleNo: number }>;
          stillEligible = config.exitAlerts.enabled && countOtherExitedClusters(db, config, exitSignal.token,
            exitSignal.sent_at!, bound, this.deps.blacklist ?? { entries: new Map() }) >= config.exitAlerts.minWallets;
        }
      }
      if (!stillEligible) {
        this.cancelTask(task, exitNow, 'exit_conditions_changed');
        db.prepare('DELETE FROM kv WHERE key = ?').run(`exit_done:${task.signal_id}`);
        return 'cancelled';
      }
      // exit_alert：独立消息回复原信号，不覆盖原消息 ID
      const signal = db
        .prepare('SELECT tg_message_id FROM signals WHERE id = ?')
        .get(task.signal_id) as { tg_message_id: number | null } | undefined;
      const view = loadExitView(db, task, nowSec);
      if (!view) {
        this.cancelTask(task, nowSec, 'exit_view_missing');
        return 'cancelled';
      }
      const sent = await sender.sendMessage(chatId, formatExitAlert(view), {
        parse_mode: 'HTML',
        ...(signal?.tg_message_id != null
          ? { reply_parameters: { message_id: signal.tg_message_id } }
          : {}),
        disable_web_page_preview: true,
      });
      db.prepare(
        `UPDATE push_tasks SET status = 'sent', tg_message_id = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?`,
      ).run(sent.message_id, nowSec, task.id);
      logger.info('退出提醒已推送', { signalId: task.signal_id, alertType: task.alert_type });
      return 'sent';
    } catch (err) {
      nowSec = Math.floor(this.now() / 1000);
      const attempts = task.attempts + 1;
      if (err instanceof TelegramRateLimitError) {
        const retryAt = nowSec + Math.max(err.retryAfterSec, 1);
        db.prepare(
          `UPDATE push_tasks SET status = 'failed', attempts = ?, next_retry_at = ?, updated_at = ? WHERE id = ?`,
        ).run(attempts, retryAt, nowSec, task.id);
        logger.warn('推送被限频', { taskId: task.id, retryAt });
        return 'failed';
      }
      const exhausted = attempts >= task.max_attempts;
      const retryAt = exhausted ? null : nowSec + 60 * attempts;
      const status = err instanceof TelegramDeliveryUnknownError ? 'unknown' : 'failed';
      db.prepare(
        `UPDATE push_tasks SET status = ?, attempts = ?, next_retry_at = ?, updated_at = ? WHERE id = ?`,
      ).run(status, attempts, retryAt, nowSec, task.id);
      logger.error('推送失败', { taskId: task.id, attempts, exhausted, error: err });
      return 'failed';
    }
  }
}
