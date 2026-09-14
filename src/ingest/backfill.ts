import type { Logger } from '../logger.js';
import type { Db } from '../store/db.js';
import { getSourceHealth, type SourceHealth } from '../store/repo/health.js';
import { ingestBatch } from '../store/repo/trades.js';
import { applyIngestedTrades } from '../signal/ingest.js';
import { normalizeTrackResponse, type NormalizedTrade } from './normalize.js';
import { extractFollowNextToken } from './poller.js';

export interface BackfillDeps {
  db: Db;
  logger: Logger;
  /** follow-wallet 单页抓取 */
  fetchFollowPage: (params: { limit: number; nextPageToken?: string }) => Promise<unknown>;
  limit?: number;
  maxPages?: number;
  now?: () => number;
  /** 清仓灰尘阈值（透传给重建） */
  dustRatio?: number;
  onTrades?: (trades: NormalizedTrade[]) => void;
}

export interface BackfillResult {
  pages: number;
  fetched: number;
  insertedEvents: number;
  done: boolean;
  cursor: string | null;
  paginationStalled?: boolean;
}

/**
 * follow-wallet 分页回补（M1-10）：
 * - 使用 source_health.backfill_cursor 向前翻页
 * - 页面不满 / 覆盖缺口 / 达到页数上限 时结束
 * - 每页写入与 cursor 推进在同一事务内（ingestBatch）
 */
const running = new WeakSet<Db>();
export async function backfillFollow(deps: BackfillDeps): Promise<BackfillResult> {
  if (running.has(deps.db)) return { pages: 0, fetched: 0, insertedEvents: 0, done: false, cursor: getSourceHealth(deps.db, 'follow').backfill_cursor };
  running.add(deps.db);
  try { return await runBackfill(deps); } finally { running.delete(deps.db); }
}

async function runBackfill(deps: BackfillDeps): Promise<BackfillResult> {
  const { db, logger, fetchFollowPage, limit = 100, maxPages = 5 } = deps;
  const now = deps.now ?? (() => Date.now());

  const health = getSourceHealth(db, 'follow');
  let cursor = health.backfill_cursor;
  if (!cursor) {
    return { pages: 0, fetched: 0, insertedEvents: 0, done: true, cursor: null };
  }

  let pages = 0;
  let fetched = 0;
  let insertedEvents = 0;
  let done = false;
  let paginationStalled = false;
  const seenCursors = new Set<string>([cursor]);
  const seenEvents = new Set<string>();

  while (pages < maxPages) {
    const data = await fetchFollowPage({ limit, nextPageToken: cursor });
    pages += 1;
    const currentHealth = getSourceHealth(db, 'follow');
    if (currentHealth.backfill_cursor !== cursor) return { pages, fetched, insertedEvents, done: false, cursor: currentHealth.backfill_cursor };
    const trades = normalizeTrackResponse('follow', data);
    const repeatedPage = trades.length > 0 && trades.every(trade => seenEvents.has(trade.eventId));
    for (const trade of trades) seenEvents.add(trade.eventId);
    fetched += trades.length;
    const timestamps = trades.map((t) => t.timestamp);
    const minTs = timestamps.length > 0 ? Math.min(...timestamps) : null;
    const maxTs = timestamps.length > 0 ? Math.max(...timestamps) : null;
    const fullPage = trades.length >= limit;
    const nextToken = extractFollowNextToken(data);
    paginationStalled = repeatedPage || (nextToken !== null && seenCursors.has(nextToken));
    if (nextToken) seenCursors.add(nextToken);
    const nowSec = Math.floor(now() / 1000);

    const patch: Partial<SourceHealth> & { source: string } = { source: 'follow' };
    if (maxTs !== null && currentHealth.gap_from_ts === null) {
      patch.watermark_ts = Math.max(currentHealth.watermark_ts ?? 0, maxTs);
    }
    const gapFrom = currentHealth.gap_from_ts;
    const gapCovered = gapFrom !== null && minTs !== null && minTs <= gapFrom;
    if (gapCovered) {
      const newest = db.prepare("SELECT MAX(t.timestamp) AS ts FROM trades t JOIN trade_sources s ON s.event_id=t.event_id WHERE s.source='follow'").get() as { ts: number | null };
      patch.watermark_ts = Math.max(currentHealth.watermark_ts ?? 0, newest.ts ?? 0, maxTs ?? 0);
      patch.gap_from_ts = null;
      patch.gap_to_ts = null;
    }
    patch.backfill_cursor = fullPage && !gapCovered && !paginationStalled ? nextToken : null;

    const ingest = ingestBatch(
      db,
      'follow',
      trades,
      patch,
      nowSec,
      (items) => {
        if (deps.onTrades) deps.onTrades(items);
        else applyIngestedTrades(db, items, deps.dustRatio ?? 0.01, logger);
      },
    );
    insertedEvents += ingest.insertedEvents;

    logger.info('回补页完成', {
      page: pages,
      fetched: trades.length,
      insertedEvents: ingest.insertedEvents,
      fullPage,
      gapCovered,
    });

    if (paginationStalled && !gapCovered) {
      logger.warn('回补分页未前进，停止翻页并保留缺口');
      cursor = null;
      break;
    }
    if (!fullPage || gapCovered || !nextToken) {
      done = true;
      break;
    }
    cursor = nextToken;
  }

  return { pages, fetched, insertedEvents, done, cursor: done ? null : cursor, paginationStalled };
}
