import { Decimal } from 'decimal.js';
import { fresh } from '../backtest/features.js';
import { getQuality, validPrice } from '../backtest/quality.js';
import { deleteKv, getKv, setKv, type Db } from '../store/db.js';
import type { Logger } from '../logger.js';
import { TelegramDeliveryUnknownError, TelegramRateLimitError, type TelegramApi } from './types.js';

export const MILESTONE_INTERVAL_SEC = 60;
// A jump records every crossed tier as one interval, without allocating a row per integer.
export interface MilestoneRange { from: number; to: number; observedAt: number; priceTs: number; price: string; }
export interface MilestoneProgress { baseline: string; sentAt: number; highest: number; ranges: MilestoneRange[]; }
export interface MilestoneMessage { messageId: number; chatId: string; multiple: number; updatedAt: number; }
interface Cleanup { signalId: number; oldId: number; newId: number; chatId: string; attempts: number; nextAt: number; }
interface Signal { id: number; token: string; symbol: string | null; sent_at: number; price_at_send: string | null;
  tg_message_id: number; tg_chat_id: string | null; price: string | null; price_updated_at: number | null; }

export function milestoneProgress(db: Db, id: number): MilestoneProgress | null {
  return getKv<MilestoneProgress>(db, `milestone_progress:${id}`);
}
export function milestoneMessage(db: Db, id: number): MilestoneMessage | null {
  return getKv<MilestoneMessage>(db, `milestone_message:${id}`);
}

/** Observe only fresh quotes after publication. Older history is never reconstructed as a first hit. */
export function observeMilestones(db: Db, now: number): void {
  const signals = db.prepare(`SELECT s.id,s.sent_at,s.price_at_send,t.price,t.price_updated_at
    FROM signals s JOIN tokens t ON t.address=s.token WHERE s.status='pushed'
    AND s.tg_message_id IS NOT NULL AND s.sent_at BETWEEN ? AND ?`).all(now - 86400, now) as Signal[];
  db.transaction(() => {
    for (const s of signals) {
      let baseline = getKv<{price: string | null; sentAt: number}>(db, `milestone_baseline:${s.id}`);
      if (!baseline) {
        const quality = getQuality(db, s.id);
        baseline = { price: validPrice(s.price_at_send) && quality?.method !== 'historical' ? s.price_at_send : null, sentAt: s.sent_at };
        setKv(db, `milestone_baseline:${s.id}`, baseline, now);
      }
      if (!baseline.price || baseline.sentAt !== s.sent_at || baseline.price !== s.price_at_send) continue;
      const saved = milestoneProgress(db, s.id);
      if (!validPrice(s.price_at_send) || !validPrice(s.price) || !fresh(s.price_updated_at, now, 60)
        || s.price_updated_at! <= s.sent_at) continue;
      // Preserve the original baseline even if another maintenance process later repairs a missing price.
      if (saved && (saved.baseline !== s.price_at_send || saved.sentAt !== s.sent_at)) continue;
      const progress: MilestoneProgress = saved ?? { baseline: s.price_at_send!, sentAt: s.sent_at, highest: 1, ranges: [] };
      if (!saved) setKv(db, `milestone_progress:${s.id}`, progress, now);
      const ratio = new Decimal(s.price!).div(progress.baseline);
      const tier = ratio.gte(2) ? ratio.floor().toNumber() : ratio.gte(1.5) ? 1.5 : 1;
      if (!Number.isSafeInteger(tier) && tier !== 1.5) continue;
      if (tier > progress.highest) {
        progress.ranges.push({ from: progress.highest === 1 ? 1.5 : Math.floor(progress.highest) + 1,
          to: tier, observedAt: now, priceTs: s.price_updated_at!, price: s.price! });
        progress.highest = tier;
        setKv(db, `milestone_progress:${s.id}`, progress, now);
      }
      if (progress.highest <= (milestoneMessage(db, s.id)?.multiple ?? 1)) continue;
      db.prepare(`INSERT INTO push_tasks(signal_id,kind,dedupe_key,payload,status,created_at,updated_at)
        VALUES (?,'milestone',?,'{}','pending',?,?) ON CONFLICT(dedupe_key) DO UPDATE SET
        status='pending',attempts=0,next_retry_at=NULL,updated_at=excluded.updated_at
        WHERE push_tasks.status IN ('sent','cancelled')`).run(s.id, `${s.id}:milestone`, now, now);
    }
  })();
}

export function milestoneElapsed(progress: MilestoneProgress, tier: number): number | null {
  const range = progress.ranges.find(r => r.from <= tier && r.to >= tier);
  return range ? range.observedAt - progress.sentAt : null;
}
function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
  return `${Math.floor(seconds / 3600)}小时${Math.floor(seconds % 3600 / 60)}分`;
}
export function milestoneText(id: number, symbol: string | null, progress: MilestoneProgress): string {
  const tiers: number[] = [];
  for (let tier = progress.highest; tier >= 2 && tiers.length < 4; tier--) tiers.unshift(tier);
  if (tiers.length < 4) tiers.unshift(1.5);
  const label = (symbol ?? '代币').replace(/[\r\n]/g, ' ').slice(0, 64);
  return [`🚀 ${label} · 已观测达到 ${progress.highest}× #${id.toString(36).toUpperCase()}`,
    tiers.map(t => `${t}× · ${duration(milestoneElapsed(progress, t)!)}`).join('｜'),
    '相对原信号发送价格；用时从发布至首次观测达标。',
    ...(progress.highest > 4 ? ['显示最近4档，完整达标记录已保存。'] : [])].join('\n');
}

/** Called inside the pusher's claim/retry lifecycle. Only this feature's own summary is replaced. */
export async function deliverMilestone(db: Db, sender: TelegramApi, id: number, defaultChat: string,
  now: () => number): Promise<'sent' | 'cancelled' | 'deferred'> {
  const at = Math.floor(now() / 1000);
  const s = db.prepare(`SELECT s.*,t.price,t.price_updated_at FROM signals s JOIN tokens t ON t.address=s.token
    WHERE s.id=? AND s.status='pushed'`).get(id) as Signal | undefined;
  const progress = milestoneProgress(db, id), previous = milestoneMessage(db, id);
  if (!s || !s.tg_message_id || !progress || at - s.sent_at > 86400
    || progress.baseline !== s.price_at_send || progress.sentAt !== s.sent_at
    || progress.highest <= (previous?.multiple ?? 1)) return 'cancelled';
  if (getKv(db, 'paused') === true || getKv(db, `milestone_cleanup:${id}`)
    || (previous && at - previous.updatedAt < MILESTONE_INTERVAL_SEC)
    || !validPrice(s.price) || !fresh(s.price_updated_at, at, 60)) return 'deferred';
  const mute = getKv<true | { until: number }>(db, `mute:${s.token}`);
  if (mute === true || (mute && mute.until > at)) return 'deferred';
  if (!sender.deleteMessage) throw new Error('Telegram summary replacement requires deleteMessage');
  if (previous?.messageId === s.tg_message_id) throw new Error('Invalid milestone message anchor');
  const chatId = previous?.chatId ?? s.tg_chat_id ?? defaultChat;
  const sent = await sender.sendMessage(chatId, milestoneText(id, s.symbol, progress), {
    reply_parameters: { message_id: s.tg_message_id }, disable_web_page_preview: true,
  });
  const completed = Math.floor(now() / 1000);
  try { db.transaction(() => {
    setKv(db, `milestone_message:${id}`, { messageId: sent.message_id, chatId, multiple: progress.highest, updatedAt: completed }, completed);
    if (previous) setKv(db, `milestone_cleanup:${id}`, { signalId: id, oldId: previous.messageId,
      newId: sent.message_id, chatId, attempts: 0, nextAt: completed } satisfies Cleanup, completed);
  })(); } catch { throw new TelegramDeliveryUnknownError(); }
  return 'sent';
}

/** Persist deletion retries separately so a failed deletion never causes another send. */
export async function cleanupMilestones(db: Db, sender: TelegramApi, now: () => number, logger: Logger): Promise<void> {
  const at = Math.floor(now() / 1000);
  const rows = db.prepare(`SELECT key,value FROM kv WHERE key GLOB 'milestone_cleanup:*'
    AND json_extract(value,'$.attempts')<3 AND json_extract(value,'$.nextAt')<=? ORDER BY updated_at LIMIT 10`)
    .all(at) as { key: string; value: string }[];
  for (const row of rows) {
    const cleanup = JSON.parse(row.value) as Cleanup;
    try {
      const original = db.prepare('SELECT tg_message_id FROM signals WHERE id=?').get(cleanup.signalId) as { tg_message_id: number } | undefined;
      const current = milestoneMessage(db, cleanup.signalId);
      if (!original || cleanup.oldId === original.tg_message_id || cleanup.oldId === cleanup.newId
        || current?.messageId !== cleanup.newId || current.chatId !== cleanup.chatId) throw new Error('Invalid milestone cleanup anchor');
      if (!sender.deleteMessage) throw new Error('Telegram deleteMessage unavailable');
      await sender.deleteMessage(cleanup.chatId, cleanup.oldId);
      deleteKv(db, row.key);
    } catch (err) {
      cleanup.attempts++;
      const failedAt = Math.floor(now() / 1000);
      cleanup.nextAt = failedAt + (err instanceof TelegramRateLimitError ? Math.max(1, err.retryAfterSec) : 60 * cleanup.attempts);
      setKv(db, row.key, cleanup, failedAt);
      logger.warn('旧倍率汇总清理失败，暂停该信号新倍率推送', { signalId: cleanup.signalId, attempts: cleanup.attempts });
    }
  }
}

export function milestoneStats(db: Db): string {
  const rows = db.prepare(`SELECT json_extract(value,'$.highest') highest FROM kv WHERE key GLOB 'milestone_progress:*'`).all() as { highest: number }[];
  return '倍率达标（上线后累计）：' + [1.5, 2, 3, 5].map(t => `${t}× ${rows.filter(r => r.highest >= t).length}条`).join(' · ');
}
