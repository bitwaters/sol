import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/store/db.js';
import { getSourceHealth, upsertSourceHealth } from '../src/store/repo/health.js';
import { countTrades } from '../src/store/repo/trades.js';
import { backfillFollow } from '../src/ingest/backfill.js';
import { createLogger } from '../src/logger.js';
import { Poller } from '../src/ingest/poller.js';
import smartmoneyFixture from './fixtures/smartmoney.json' with { type: 'json' };

const silentLogger = createLogger({ test: true });
silentLogger.info = () => undefined;
silentLogger.warn = () => undefined;
silentLogger.error = () => undefined;

describe('Poller', () => {
  it('首次观测建立水位；整页全新才判缺口；重叠后缺口覆盖', async () => {
    const db = openDatabase({ path: ':memory:' });
    const list = (smartmoneyFixture as { list: Record<string, unknown>[] }).list;
    const baseTs = Math.max(...list.map((i) => Number(i['timestamp'])));
    const shifted = list.map((item, idx) => ({
      ...item,
      timestamp: baseTs + 1000 + idx,
    }));
    const overlapPage = [...list.slice(0, 10), ...shifted.slice(0, 10)];

    let call = 0;
    const poller = new Poller({
      source: 'smartmoney',
      intervalMs: 1000,
      limit: 20,
      fetchPage: async () => {
        call += 1;
        if (call === 1) return { list };
        if (call === 2) return { list: shifted };
        return { list: overlapPage };
      },
      db,
      logger: silentLogger,
    });

    // 首次观测：建立水位，无缺口
    const first = await poller.tick();
    expect(first.fullPage).toBe(true);
    expect(first.gapDetected).toBe(false);
    expect(first.nextIntervalMs).toBe(500); // 打满提频：间隔减半
    expect(getSourceHealth(db, 'smartmoney').watermark_ts).toBe(baseTs);

    // 整页全新：判缺口，水位不推进
    const second = await poller.tick();
    expect(second.gapDetected).toBe(true);
    expect(getSourceHealth(db, 'smartmoney').watermark_ts).toBe(baseTs);
    expect(getSourceHealth(db, 'smartmoney').gap_from_ts).toBe(baseTs);

    // 重叠页回追到水位之前：缺口覆盖
    const third = await poller.tick();
    expect(third.gapCovered).toBe(true);
    const health = getSourceHealth(db, 'smartmoney');
    expect(health.gap_from_ts).toBeNull();
    expect(health.watermark_ts).toBeGreaterThan(baseTs);
    expect(countTrades(db)).toBe(40); // 首批 20 + 新批次 20
    db.close();
  });

  it('限频错误按恢复时间等待', async () => {
    const db = openDatabase({ path: ':memory:' });
    const resetAtMs = Date.now() + 30_000;
    const poller = new Poller({
      source: 'kol',
      intervalMs: 3000,
      limit: 20,
      fetchPage: async () => {
        const err = new Error('rate') as Error & { apiError?: string; resetAtUnix?: number };
        err.apiError = 'RATE_LIMIT_BANNED';
        err.resetAtUnix = Math.floor(resetAtMs / 1000);
        throw err;
      },
      db,
      logger: silentLogger,
    });

    // 非 RateLimitedError 走指数退避
    const result = await poller.tick();
    expect(result.error).toBe('rate');
    expect(result.nextIntervalMs).toBe(6000); // 3000 * 2^1
    db.close();
  });
});

describe('backfillFollow', () => {
  it('按 cursor 回补并覆盖缺口', async () => {
    const db = openDatabase({ path: ':memory:' });
    const list = (smartmoneyFixture as { list: Record<string, unknown>[] }).list;
    // 构造 follow 形状数据：timestamp 递减，模拟向前翻页
    const page1 = list.slice(0, 100).map((item, i) => ({
      ...item,
      transaction_hash: `f${i}`,
      timestamp: 1000 - i,
    }));
    upsertSourceHealth(
      db,
      { source: 'follow', watermark_ts: 2000, gap_from_ts: 1000, gap_to_ts: 1500, backfill_cursor: 'c1' },
      999,
    );

    const result = await backfillFollow({
      db,
      logger: silentLogger,
      limit: 100,
      fetchFollowPage: async () => ({ list: page1, next_page_token: 'c2' }),
    });

    expect(result.pages).toBe(1);
    expect(result.fetched).toBe(page1.length);
    const health = getSourceHealth(db, 'follow');
    expect(health.gap_from_ts).toBeNull(); // minTs=981 <= gap_from=1000 → 缺口覆盖
    expect(health.backfill_cursor).toBeNull();
    db.close();
  });
});
