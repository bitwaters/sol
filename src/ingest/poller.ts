import type { Logger } from '../logger.js';
import type { Db } from '../store/db.js';
import { getSourceHealth, upsertSourceHealth, type SourceHealth } from '../store/repo/health.js';
import { ingestBatch, findCanonicalEventId } from '../store/repo/trades.js';
import { RateLimitedError } from './gateway.js';
import { normalizeTrackResponse, type NormalizedTrade, type TradeSource } from './normalize.js';
import { runtimeMetrics, measureAsync } from '../ops/metrics.js';

export interface PollerDeps {
  source: TradeSource;
  intervalMs: number;
  limit: number;
  fetchPage: (params: { limit: number; nextPageToken?: string }) => Promise<unknown>;
  /** 从响应中提取下一页 token（follow-wallet） */
  extractNextToken?: (data: unknown) => string | null;
  /** 是否循环翻页直到不满页（follow-wallet） */
  paginate?: boolean;
  maxPages?: number;
  db: Db;
  logger: Logger;
  now?: () => number;
  /** 每批成功入库后的回调（M2 信号引擎接入点） */
  onTrades?: (source: TradeSource, trades: NormalizedTrade[]) => void;
}

export interface PollTickResult {
  source: TradeSource;
  pages: number;
  fetched: number;
  insertedEvents: number;
  newSourceObservations: number;
  fullPage: boolean;
  gapDetected: boolean;
  gapCovered: boolean;
  paginationStalled?: boolean;
  nextIntervalMs: number;
  error?: string;
}

const MAX_BACKOFF_MS = 30_000;

export class Poller {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private running = false;
  private consecutiveErrors = 0;
  private readonly now: () => number;

  constructor(private readonly deps: PollerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  get isRunning(): boolean {
    return !this.stopped;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    const due=performance.now()+Math.max(0,delayMs);
    this.timer = setTimeout(() => {
      runtimeMetrics.observe(`poll.schedule_delay.${this.deps.source}`,Math.max(0,performance.now()-due));
      this.timer = null;
      void this.tick().then((result) => this.schedule(result.nextIntervalMs));
    }, Math.max(0, delayMs));
  }

  /** 执行一次采集（测试可直接调用） */
  async tick(): Promise<PollTickResult> {
    if (this.running) {
      return {
        source: this.deps.source,
        pages: 0,
        fetched: 0,
        insertedEvents: 0,
        newSourceObservations: 0,
        fullPage: false,
        gapDetected: false,
        gapCovered: false,
        nextIntervalMs: this.deps.intervalMs,
        error: 'already_running',
      };
    }
    this.running = true;
    const started = performance.now();
    try {
      const result = await this.pollOnce();
      if (!result.error) this.consecutiveErrors = 0;
      return result;
    } catch (err) {
      return this.handleError(err);
    } finally {
      this.running = false;
      runtimeMetrics.observe(`poll.round.${this.deps.source}`, performance.now() - started);
    }
  }

  private async pollOnce(): Promise<PollTickResult> {
    const { source, db, logger, paginate, maxPages = 5 } = this.deps;
    // 个人 Key 实测三个交易端点最多返回 100 条；兼容旧配置的 200。
    const limit = Math.min(this.deps.limit, 100);
    const collected: NormalizedTrade[] = [];
    let pages = 0;
    let fullPage = false;
    let nextToken: string | null = null;
    let paginationStalled = false;
    let pageFailure: {error: unknown} | undefined;
    let lastPageAt: number | undefined;
    const seenEvents = new Set<string>();
    const initialWatermark = getSourceHealth(db, source).watermark_ts;

    do {
      let data: unknown;
      try { data = await measureAsync(`poll.fetch.${source}`,()=>this.deps.fetchPage({
        limit,
        ...(nextToken ? { nextPageToken: nextToken } : {}),
      })); } catch(error) {
        if (collected.length === 0) throw error;
        pageFailure = {error};
        break;
      }
      lastPageAt = Math.floor(this.now() / 1000);
      pages += 1;
      const trades = normalizeTrackResponse(source, data);
      const repeatedPage = trades.length > 0 && trades.every(trade => seenEvents.has(trade.eventId));
      if (repeatedPage) {
        paginationStalled = true;
        nextToken = null;
        logger.warn('分页未前进，保留已获取成交并停止本次翻页', { source, pages });
        break;
      }
      for (const trade of trades) seenEvents.add(trade.eventId);
      collected.push(...trades);
      fullPage = trades.length >= limit;
      nextToken = this.deps.extractNextToken ? this.deps.extractNextToken(data) : null;
      const reachedWatermark = initialWatermark !== null && trades.some(trade =>
        trade.timestamp <= initialWatermark && findCanonicalEventId(db, source, trade) !== null);
      if (!paginate || !fullPage || !nextToken || reachedWatermark) break;
    } while (pages < maxPages);

    const nowSec = Math.floor(this.now() / 1000);
    const prev = getSourceHealth(db, source);
    const sorted = [...collected].sort((a, b) => a.timestamp - b.timestamp);
    const minTs = sorted.length > 0 ? sorted[0]!.timestamp : null;
    const maxTs = sorted.length > 0 ? sorted[sorted.length - 1]!.timestamp : null;
    const prevWatermark = prev.watermark_ts;
    // The confirmed watermark stays before a lost interval; latest-page overlap has a separate cursor.
    const observedHead=prev.head_ts??(prev.gap_from_ts!==null
      ? (db.prepare(`SELECT MAX(t.timestamp) ts FROM trades t JOIN trade_sources s ON s.event_id=t.event_id
          WHERE s.source=? AND t.timestamp<=?`).get(source,nowSec) as {ts:number|null}).ts
      : prevWatermark);
    const priorHead = observedHead === null ? prevWatermark : Math.max(observedHead, prevWatermark ?? observedHead);

    // 重叠检测：找到本页中最早的一个"已入库"事件，作为回追点
    let reachBackTs: number | null = null;
    for (const trade of sorted) {
      if (findCanonicalEventId(db, source, trade) !== null) {
        reachBackTs = trade.timestamp;
        break;
      }
    }

    const patch: Partial<SourceHealth> & { source: string } = {
      source,
      last_success_at: lastPageAt ?? nowSec,
      head_ts: maxTs===null?priorHead:Math.max(priorHead??maxTs,maxTs),
    };
    let gapDetected = false;
    let gapCovered = false;

    if (collected.length === 0) {
      // 无新数据，水位不变
    } else if (prevWatermark === null) {
      // 首次观测：以本页最大时间为观测起点，历史数据不算缺口
      patch.watermark_ts = maxTs;
    } else if (reachBackTs !== null && reachBackTs <= prevWatermark) {
      // 回追到水位之前 → 连续
      if(prev.gap_from_ts===null||maxTs!>=(prev.gap_to_ts??prevWatermark))
        patch.watermark_ts = Math.max(prevWatermark, maxTs ?? prevWatermark,priorHead??prevWatermark);
      if (prev.gap_from_ts !== null && maxTs!>=(prev.gap_to_ts??prevWatermark)) {
        patch.gap_from_ts = null;
        patch.gap_to_ts = null;
        gapCovered = true;
        logger.info('采集缺口已覆盖', { source, gapFrom: prev.gap_from_ts, reachBackTs });
      }
    } else if(reachBackTs!==null&&priorHead!==null&&reachBackTs<=priorHead){
      // Continuous since the last page. Preserve the earlier hole without extending it to the present.
    } else if (reachBackTs !== null) {
      // 部分重叠但未追到水位 → 缺口 [watermark, reachBackTs]
      patch.gap_from_ts = prev.gap_from_ts??priorHead??prevWatermark;
      patch.gap_to_ts = Math.max(prev.gap_to_ts??0,reachBackTs);
      gapDetected = true;
      logger.warn('采集存在缺口（部分重叠）', { source, watermark: prevWatermark, reachBackTs });
    } else if (fullPage) {
      // 整页全新且无重叠 → 可能漏数据（高流量溢出）
      patch.gap_from_ts = prev.gap_from_ts??priorHead??prevWatermark;
      patch.gap_to_ts = Math.max(prev.gap_to_ts??0,minTs!);
      gapDetected = true;
      logger.warn('采集可能缺口（整页全新）', { source, watermark: prevWatermark, pageMinTs: minTs });
    } else {
      // 不满页且无重叠（罕见）：视为连续
      if(prev.gap_from_ts===null)patch.watermark_ts = Math.max(prevWatermark, maxTs ?? prevWatermark);
    }

    if (fullPage && !paginationStalled && (gapDetected || prev.gap_from_ts !== null)) {
      patch.backfill_cursor = nextToken;
    } else {
      patch.backfill_cursor = null;
    }

    // Measure only first-seen canonical events, not repeated rows in latest-100 pages.
    const firstSeen = new Map(collected.filter(trade => findCanonicalEventId(db, source, trade) === null)
      .map(trade => [trade.eventId, trade.timestamp]));
    const ingestStarted = performance.now();
    const ingest = ingestBatch(
      db,
      source,
      collected,
      patch,
      nowSec,
      this.deps.onTrades
        ? (inserted) => this.deps.onTrades?.(source, inserted)
        : undefined,
    );
    runtimeMetrics.observe(`poll.ingest.${source}`, performance.now() - ingestStarted);
    for (const timestamp of firstSeen.values()) {
      runtimeMetrics.observe(`poll.event_age.${source}`, this.now() - timestamp * 1000);
    }

    logger.info('采集批次完成', {
      source,
      pages,
      fetched: collected.length,
      insertedEvents: ingest.insertedEvents,
      newSourceObservations: ingest.newSourceObservations,
      fullPage,
      gapDetected,
      watermarkTs: ingest.health.watermark_ts,
    });

    const failure = pageFailure ? this.handleError(pageFailure.error) : null;
    return {
      source,
      pages,
      fetched: collected.length,
      insertedEvents: ingest.insertedEvents,
      newSourceObservations: ingest.newSourceObservations,
      fullPage,
      gapDetected,
      gapCovered,
      paginationStalled,
      // 打满时提频（间隔减半，下限 250ms）；不满页恢复基准（§5.2）
      ...(failure ? {error: failure.error} : {}),
      nextIntervalMs: failure ? failure.nextIntervalMs : fullPage
        ? Math.max(Math.floor(this.deps.intervalMs / 2), 250)
        : this.deps.intervalMs,
    };
  }

  private handleError(err: unknown): PollTickResult {
    const { source, logger, intervalMs } = this.deps;
    if (err instanceof RateLimitedError) {
      const waitMs = Math.max(err.resetAtMs - this.now(), intervalMs);
      logger.warn('采集被限频，等待恢复', {
        source,
        apiError: err.apiError,
        resetAt: new Date(err.resetAtMs).toISOString(),
        waitMs,
      });
      return {
        source,
        pages: 0,
        fetched: 0,
        insertedEvents: 0,
        newSourceObservations: 0,
        fullPage: false,
        gapDetected: false,
        gapCovered: false,
        nextIntervalMs: waitMs,
        error: err.apiError,
      };
    }

    this.consecutiveErrors += 1;
    const backoff = Math.min(intervalMs * 2 ** this.consecutiveErrors, MAX_BACKOFF_MS);
    logger.error('采集失败，退避重试', { source, error: err, backoffMs: backoff });
    return {
      source,
      pages: 0,
      fetched: 0,
      insertedEvents: 0,
      newSourceObservations: 0,
      fullPage: false,
      gapDetected: false,
      gapCovered: false,
      nextIntervalMs: backoff,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 从 follow-wallet 响应提取 next_page_token */
export function extractFollowNextToken(data: unknown): string | null {
  if (data && typeof data === 'object') {
    const token = (data as Record<string, unknown>)['next_page_token'];
    if (typeof token === 'string' && token.length > 0) return token;
  }
  return null;
}
