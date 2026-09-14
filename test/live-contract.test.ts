import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type Db } from '../src/store/db.js';
import { normalizeTrackItem } from '../src/ingest/normalize.js';
import { countTrades, ingestBatch, readStoredTrade, upsertTrades } from '../src/store/repo/trades.js';
import { getSourceHealth, upsertSourceHealth } from '../src/store/repo/health.js';
import { applyIngestedTrades } from '../src/signal/ingest.js';
import { getLatestCycle } from '../src/signal/positions.js';
import { backfillFollow } from '../src/ingest/backfill.js';
import { extractFollowNextToken, Poller } from '../src/ingest/poller.js';
import { GmgnGateway } from '../src/ingest/gateway.js';
import { BanGate, TokenBucket } from '../src/ingest/limiter.js';
import type { OpenApiClient } from '../src/gmgn/OpenApiClient.js';
import { log } from './review-fixture.js';

// 复现个人 Key 实测的字段/精度差异，地址和交易均为虚构。
const publicRow = (extra = {}) => ({ transaction_hash: 'tx', maker: 'wallet', base_address: 'token',
  side: 'buy', timestamp: 100, token_amount: '1234.56789', base_amount: '1234.56789',
  quote_amount: '1.23456789', amount_usd: '123.456789', price_usd: '.1', balance: '1234.56789', ...extra });
const followRow = (extra = {}) => ({ ...publicRow(), token_amount: 0, base_amount: 1234.5679,
  quote_amount: 1.2345679, quote_address: 'quote-token', amount_usd: 123.45679, balance: undefined,
  balance_info: null, is_open_or_close: 1, ...extra });
const databases: Db[] = [];
function database() { const db = openDatabase({ path: ':memory:' }); databases.push(db); return db; }
afterEach(() => databases.splice(0).forEach(db => db.close()));

describe('个人 Key 实测契约回归', () => {
  it('follow 的 token_amount=0 不覆盖可读 base_amount，无需 decimals 换算', () => {
    const trade = normalizeTrackItem('follow', followRow())!;
    expect(trade.amountNormalized).toBe('1234.5679');
    expect(trade.rawAmountUnit).toBe('human');
    expect(trade.balance).toBeNull();
  });

  it.each([true, false])('跨源浮点差异合并、重复轮询幂等（follow 先到=%s）', followFirst => {
    const db = database();
    const publicTrade = normalizeTrackItem('kol', publicRow())!;
    const followTrade = normalizeTrackItem('follow', followRow())!;
    const first = followFirst ? followTrade : publicTrade;
    upsertTrades(db, followFirst ? 'follow' : 'kol', [first]);
    const result = upsertTrades(db, followFirst ? 'kol' : 'follow', [followFirst ? publicTrade : followTrade]);
    expect(result.insertedEvents).toBe(0);
    expect(result.updatedTrades).toHaveLength(1);
    expect(countTrades(db)).toBe(1);
    expect(readStoredTrade(db, first.eventId)).toMatchObject({ actionHint: 'full_open', balance: '1234.56789' });
    expect(upsertTrades(db, 'follow', [followTrade]).newSourceObservations).toBe(0);
    expect(upsertTrades(db, 'kol', [publicTrade]).insertedEvents).toBe(0);
  });

  it('同一交易分笔金额不同不会合并，多个近似候选也不会强行匹配', () => {
    const db = database();
    const leg1 = normalizeTrackItem('kol', publicRow())!;
    const leg2 = normalizeTrackItem('kol', publicRow({ token_amount: '2469.13578', quote_amount: '2.46913578', amount_usd: '246.913578' }))!;
    upsertTrades(db, 'kol', [leg1, leg2]);
    expect(upsertTrades(db, 'follow', [normalizeTrackItem('follow', followRow())!]).insertedEvents).toBe(0);
    expect(countTrades(db)).toBe(2);
    const other = database();
    upsertTrades(other, 'kol', [leg1, normalizeTrackItem('kol', publicRow({ token_amount: '1234.56788' }))!]);
    expect(upsertTrades(other, 'follow', [normalizeTrackItem('follow', followRow())!]).insertedEvents).toBe(1);
  });

  it('成交归档清理时来源别名级联删除', () => {
    const db = database();
    upsertTrades(db, 'follow', [normalizeTrackItem('follow', followRow())!]);
    upsertTrades(db, 'kol', [normalizeTrackItem('kol', publicRow())!]);
    expect(db.prepare('SELECT COUNT(*) n FROM trade_event_aliases').get()).toEqual({ n: 2 });
    db.prepare('DELETE FROM trades').run();
    expect(db.prepare('SELECT COUNT(*) n FROM trade_event_aliases').get()).toEqual({ n: 0 });
  });

  it('两来源明确提供不同报价币时不合并', () => {
    const db = database();
    upsertTrades(db, 'kol', [normalizeTrackItem('kol', publicRow({ quote_address: 'other-quote' }))!]);
    expect(upsertTrades(db, 'follow', [normalizeTrackItem('follow', followRow())!]).insertedEvents).toBe(1);
  });

  it('后到的 follow 全平信息参与重放，但金额不再累计；下一周期获得零余额起点', () => {
    const db = database();
    const ingest = (source: 'kol' | 'follow', raw: Record<string, unknown>) => ingestBatch(db, source,
      [normalizeTrackItem(source, raw)!], { source }, 200, items => applyIngestedTrades(db, items, .01, log));
    // 从半途观测到卖出：起初没有可靠建仓成本。
    ingest('kol', publicRow({ side: 'sell', balance: undefined }));
    ingest('follow', followRow({ side: 'sell' }));
    expect(countTrades(db)).toBe(1);
    expect(getLatestCycle(db, 'wallet', 'token')?.state).toBe('closed');
    expect(getLatestCycle(db, 'wallet', 'token')?.soldAmount.toString()).toBe('1234.56789');
    ingest('follow', followRow({ transaction_hash: 'new-cycle', timestamp: 101 }));
    expect(getLatestCycle(db, 'wallet', 'token')).toMatchObject({ cycleNo: 2, costComplete: true });
  });

  it('后到公开源补充的余额检查点不会在重放时丢失', () => {
    const db = database();
    const ingest = (source: 'kol' | 'follow', raw: Record<string, unknown>) => ingestBatch(db, source,
      [normalizeTrackItem(source, raw)!], { source }, 200, items => applyIngestedTrades(db, items, .01, log));
    ingest('follow', followRow({ side: 'sell', is_open_or_close: 0 }));
    ingest('kol', publicRow({ side: 'sell', balance: '0' }));
    expect(db.prepare('SELECT balance FROM position_checkpoints').get()).toEqual({ balance: '0' });
    expect(countTrades(db)).toBe(1);
    expect(getLatestCycle(db, 'wallet', 'token')?.state).toBe('closed');
    ingest('follow', followRow({ transaction_hash: 'after-public-zero', timestamp: 101 }));
    expect(getLatestCycle(db, 'wallet', 'token')).toMatchObject({ cycleNo: 2, costComplete: true });
  });

  it('钱包画像逐地址请求，每个地址分别消耗权重，重复地址去重', async () => {
    const getWalletStats = vi.fn(async (_chain, addresses: string[]) => ({ address: addresses[0] }));
    const limiter = new TokenBucket({ ratePerSecond: 20, capacity: 20 });
    const acquire = vi.spyOn(limiter, 'acquire');
    const gateway = new GmgnGateway({ client: { getWalletStats } as unknown as OpenApiClient, limiter, banGate: new BanGate() });
    expect(await gateway.fetchWalletStats(['one', 'two', 'one'])).toEqual([{ address: 'one' }, { address: 'two' }]);
    expect(getWalletStats.mock.calls.map(call => call[1])).toEqual([['one'], ['two']]);
    expect(acquire.mock.calls).toEqual([[3], [3]]);
  });
});

describe('真实分页边界', () => {
  it('旧配置 limit=200 按实测 100 上限请求，满页无重叠保留缺口', async () => {
    const db = database();
    upsertSourceHealth(db, { source: 'kol', watermark_ts: 50 });
    const fetchPage = vi.fn(async () => ({ list: Array.from({ length: 100 }, (_, i) => publicRow({ transaction_hash: `tx-${i}` })) }));
    const result = await new Poller({ source: 'kol', limit: 200, intervalMs: 3000, db, logger: log, fetchPage }).tick();
    expect(fetchPage).toHaveBeenCalledWith({ limit: 100 });
    expect(result).toMatchObject({ fullPage: true, gapDetected: true, nextIntervalMs: 1500 });
    expect(getSourceHealth(db, 'kol').watermark_ts).toBe(50);
  });

  it('游标返回相同首页时停止翻页，不清除缺口', async () => {
    const db = database();
    upsertSourceHealth(db, { source: 'follow', watermark_ts: 50 });
    const fetchPage = vi.fn(async () => ({ list: [followRow()], next_page_token: 'same' }));
    const result = await new Poller({ source: 'follow', limit: 1, intervalMs: 3000, db, logger: log, fetchPage,
      paginate: true, extractNextToken: extractFollowNextToken }).tick();
    expect(result).toMatchObject({ pages: 2, fetched: 1, paginationStalled: true, gapDetected: true });
    expect(getSourceHealth(db, 'follow')).toMatchObject({ watermark_ts: 50, gap_from_ts: 50, backfill_cursor: null });
  });

  it('回补真正覆盖缺口后，水位推进到该来源已收录的最新事件', async () => {
    const db = database();
    upsertTrades(db, 'follow', [normalizeTrackItem('follow', followRow({ timestamp: 200 }))!]);
    upsertSourceHealth(db, { source: 'follow', watermark_ts: 50, gap_from_ts: 50, gap_to_ts: 80, backfill_cursor: 'older' });
    const result = await backfillFollow({ db, logger: log, limit: 1,
      fetchFollowPage: async () => ({ list: [followRow({ transaction_hash: 'old', timestamp: 40 })], next_page_token: 'older' }) });
    expect(result.done).toBe(true);
    expect(getSourceHealth(db, 'follow')).toMatchObject({ watermark_ts: 200, gap_from_ts: null, backfill_cursor: null });
  });

  it('后台回补遇到相同游标停止，不能推进缺口水位', async () => {
    const db = database();
    upsertSourceHealth(db, { source: 'follow', watermark_ts: 50, gap_from_ts: 50, gap_to_ts: 80, backfill_cursor: 'same' });
    const result = await backfillFollow({ db, logger: log, limit: 1, fetchFollowPage: async () => ({ list: [followRow()], next_page_token: 'same' }) });
    expect(result).toMatchObject({ pages: 1, done: false, paginationStalled: true, cursor: null });
    expect(getSourceHealth(db, 'follow')).toMatchObject({ watermark_ts: 50, gap_from_ts: 50, backfill_cursor: null });
  });
});
