import { describe, expect, it, vi } from 'vitest';
import { applySchema, getKv, openDatabase, setKv } from '../src/store/db.js';
import { config, log, scenario } from './review-fixture.js';
import { sampleControls } from '../src/backtest/control.js';
import { repairBaselines } from '../src/backtest/repair.js';
import { getQuality, saveLiveQuality, syncQuality } from '../src/backtest/quality.js';
import { captureFeatures, fresh, gapStatus } from '../src/backtest/features.js';
import { evaluateOutcomes } from '../src/backtest/evaluate.js';
import { qualityOverview } from '../src/backtest/quality-report.js';
import { compareSamples } from '../src/backtest/compare.js';
import { upsertSourceHealth } from '../src/store/repo/health.js';
import { resolveStaleGaps } from '../src/signal/integrity.js';
import { enrichToken } from '../src/enrich/token.js';
import { BackgroundBusyError, GmgnGateway, RateLimitedError } from '../src/ingest/gateway.js';
import { BanGate, TokenBucket } from '../src/ingest/limiter.js';
import type { OpenApiClient } from '../src/gmgn/OpenApiClient.js';

const blacklist = { entries: new Map() };
const instant = 2_000_000_000;
function legacy(price: string | null = null) {
  const db = openDatabase({ path: ':memory:' });
  db.prepare("INSERT INTO signals(token,status,triggered_at,price_at_trigger) VALUES ('T','control',?,?)").run(instant - 7200, price);
  const fetchKline = vi.fn(async (_address: string, _resolution: string, _from: number, _to: number) => ({ list: [{ time: (instant - 7260) * 1000, close: '2' }] }));
  const fetchTokenInfo = vi.fn(async () => ({ price: { price: '999' } }));
  const deps = { db, config, blacklist, logger: log, configVersion: 'c', rulesVersion: 'r', now: () => instant * 1000,
    gateway: { fetchKline, fetchTokenInfo, fetchTokenSecurity: async () => ({}) } };
  return { db, deps, fetchKline, fetchTokenInfo };
}

describe('measurement schema and gaps', () => {
  it('upgrades idempotently and never assigns present-day features to legacy history', () => {
    const s = legacy('1');
    applySchema(s.db); syncQuality(s.db, instant); syncQuality(s.db, instant);
    expect(getQuality(s.db, 1)).toMatchObject({ method: 'legacy', state: 'ready', price_ts: null, features: null, rules_version: null });
    expect(s.db.prepare('SELECT COUNT(*) n FROM sample_quality').get()).toEqual({ n: 1 });
    expect(gapStatus(s.db, 1, 2)).toBe('unknown');
  });
  it('retains all accepted intervals across new gaps and restarts', () => {
    const s = legacy(); setKv(s.db, 'quality_tracking_started_at', instant - 20000);
    upsertSourceHealth(s.db, { source: 'smartmoney', gap_from_ts: instant - 1000, gap_to_ts: instant - 800 }, instant - 1000);
    resolveStaleGaps(s.db, instant);
    expect(gapStatus(s.db, instant - 950, instant - 900)).toBe('affected');
    upsertSourceHealth(s.db, { source: 'smartmoney', gap_from_ts: instant + 10, gap_to_ts: instant + 20 }, instant + 30);
    upsertSourceHealth(s.db, { source: 'smartmoney', gap_from_ts: null, gap_to_ts: null }, instant + 40);
    applySchema(s.db);
    expect(s.db.prepare('SELECT state FROM data_gaps ORDER BY id').all()).toEqual([{ state: 'accepted' }, { state: 'recovered' }]);
  });
});

describe('baseline repair', () => {
  it('uses only a past completed candle, logs provenance, and reopens missing-baseline horizons', async () => {
    const s = legacy(); setKv(s.db, 'backtest_giveup:1:outcome_1h', true);
    s.fetchKline.mockResolvedValue({ list: [ { time: (instant - 7260) * 1000, close: '2' }, { time: (instant - 7200) * 1000, close: '999' } ] });
    expect((await repairBaselines(s.deps)).historical).toBe(1);
    expect(s.fetchTokenInfo).not.toHaveBeenCalled();
    expect(getQuality(s.db, 1)).toMatchObject({ method: 'historical', anchor_ts: instant - 7200, price_ts: instant - 7200, anchor_price: '2', features: 'null' });
    expect(getKv(s.db, 'backtest_giveup:1:outcome_1h')).toBeNull();
    expect(s.db.prepare('SELECT method,deviation_sec FROM baseline_repairs').get()).toEqual({ method: 'historical', deviation_sec: 0 });
    await repairBaselines(s.deps); expect(s.fetchKline).toHaveBeenCalledTimes(1);
  });
  it('leaves valid-baseline market exhaustion alone', async () => {
    const s = legacy('1'); setKv(s.db, 'backtest_giveup:1:outcome_1h', true);
    await repairBaselines(s.deps);
    expect(s.fetchKline).not.toHaveBeenCalled(); expect(getKv(s.db, 'backtest_giveup:1:outcome_1h')).toBe(true);
  });
  it('keeps no-market failures in the denominator, and uses bounded spaced retries', async () => {
    const s = legacy(); s.fetchKline.mockResolvedValue({ list: [] });
    for (let i = 0; i < 3; i++) {
      s.deps.now = () => (instant + i * 300) * 1000;
      await repairBaselines(s.deps);
      await repairBaselines(s.deps);
    }
    expect(s.fetchKline).toHaveBeenCalledTimes(3);
    expect(getQuality(s.db, 1)).toMatchObject({ attempts: 3, state: 'exhausted', last_error: 'no_completed_baseline_candle' });
    expect(qualityOverview(s.db, instant)[1]!.cohorts.find(c => c.method === 'pending')!.horizons[1]).toMatchObject({ mature: 1, missingBaseline: 1, baselineExhausted: 1, coverage: 0 });
  });
  it.each([new Error('network'), new BackgroundBusyError()])('transient errors do not exhaust missing-market attempts: %s', async error => {
    const s = legacy(); s.fetchKline.mockRejectedValue(error);
    await repairBaselines(s.deps);
    expect(getQuality(s.db, 1)).toMatchObject({ attempts: 0, state: 'pending' });
  });
  it('rejects out-of-tolerance, zero and malformed baseline candles', async () => {
    for (const list of [[{ time: (instant - 7500) * 1000, close: '2' }], [{ time: (instant - 7260) * 1000, close: '0' }], [{ time: null, close: true }]]) {
      const s = legacy(); s.fetchKline.mockResolvedValue({ list: list as never });
      await repairBaselines(s.deps); expect(getQuality(s.db, 1)?.anchor_price).toBeNull();
    }
  });
  it('does not overwrite a baseline changed while awaiting the API', async () => {
    const s = legacy(); s.fetchKline.mockImplementation(async () => {
      s.db.prepare("UPDATE signals SET status='pushed',sent_at=?,price_at_send='5'").run(instant);
      return { list: [{ time: (instant - 7260) * 1000, close: '2' }] };
    });
    await repairBaselines(s.deps);
    expect(s.db.prepare('SELECT price_at_send FROM signals').get()).toEqual({ price_at_send: '5' });
    expect(s.db.prepare('SELECT COUNT(*) n FROM baseline_repairs').get()).toEqual({ n: 0 });
  });
  it('preserves stale-price controls then moves the fresh quote and feature window together', async () => {
    const s = scenario(); const t = Math.floor(s.deps.now() / 1000);
    s.db.prepare("DELETE FROM trade_sources WHERE event_id IN (SELECT event_id FROM trades WHERE maker='w3')").run();
    s.db.prepare("DELETE FROM trades WHERE maker='w3'").run();
    await enrichToken(s.db, s.deps.gateway, 'T', { now: s.deps.now });
    s.db.prepare('UPDATE tokens SET price_updated_at=?').run(t - 61);
    sampleControls({ ...s.deps, targetVotes: 2 });
    expect(getQuality(s.db, 1)?.state).toBe('pending');
    const oldFeatures = getQuality(s.db, 1)!.initial_features;
    s.setNow(t + 10);
    const deps = { ...s.deps, gateway: { ...s.deps.gateway, fetchKline: vi.fn(async () => ({ list: [] })) } };
    const result = await repairBaselines(deps);
    expect(result.live).toBe(1);
    expect(getQuality(s.db, 1)).toMatchObject({ anchor_ts: t + 10, selection_ts: t, initial_features: oldFeatures });
    expect(JSON.parse(getQuality(s.db, 1)!.features!).windowEnd).toBe(t + 10);
    expect(s.db.prepare('SELECT price_updated_at FROM tokens').get()).toEqual({ price_updated_at: t - 61 });
  });
  it('does not attach a new quote to an old selection after the window loses its votes', async () => {
    const s = scenario(); const t = Math.floor(s.deps.now() / 1000);
    // Sample all three votes as a control fixture; all buys expire before refresh completes.
    sampleControls({ ...s.deps, targetVotes: 3 });
    s.setNow(t + 100);
    const original = s.deps.gateway.fetchTokenInfo;
    const deps = { ...s.deps, gateway: { ...s.deps.gateway, fetchTokenInfo: async () => {
      s.db.prepare('DELETE FROM trade_sources').run(); s.db.prepare('DELETE FROM trades').run(); return original();
    }, fetchKline: async () => ({ list: [{ time: (t - 60) * 1000, close: '0.8' }] }) } };
    expect((await repairBaselines(deps)).historical).toBe(1);
    expect(getQuality(s.db, 1)?.anchor_ts).toBe(t);
  });
});

describe('outcomes, cohorts and gates', () => {
  it('missing baseline is recoverable, and zero terminal prices are valid outcomes', async () => {
    const s = legacy(); await evaluateOutcomes({ ...s.deps, maxPerRun: 1 });
    expect(getKv(s.db, 'backtest_giveup:1:outcome_1h')).toBeNull();
    await repairBaselines(s.deps);
    s.fetchKline.mockImplementation(async (_address, _resolution, _from, to) => ({ list: [{ time: to - 300_000 - 300_000, close: '0' }] }));
    // Dedicated one-hour fixture avoids assuming both resolutions have identical candle durations.
    s.db.prepare('UPDATE signals SET outcome_5m=1').run();
    await evaluateOutcomes(s.deps);
    expect(s.db.prepare('SELECT outcome_1h FROM signals').get()).toEqual({ outcome_1h: 0 });
    expect(s.db.prepare("SELECT state FROM outcome_quality WHERE horizon='outcome_1h'").get()).toEqual({ state: 'complete' });
  });
  it('excludes immature samples from coverage denominators', () => {
    const s = legacy('1'); s.db.prepare('UPDATE signals SET outcome_1h=1.1').run();
    s.db.prepare("INSERT INTO signals(token,status,triggered_at,price_at_trigger) VALUES ('NEW','control',?,'1')").run(instant - 30);
    syncQuality(s.db, instant);
    expect(qualityOverview(s.db, instant)[1]!.cohorts.find(c => c.method === 'legacy')!.horizons[1]).toMatchObject({ mature: 1, immature: 1, valid: 1, coverage: 1 });
  });
  it('rejects tiny cohorts and never replaces a failed first token sample with a later winner', () => {
    const s = scenario(); const t = Math.floor(s.deps.now() / 1000);
    setKv(s.db, 'quality_tracking_started_at', t - 20000);
    const features = captureFeatures(s.db, config, blacklist, 'T', t);
    features.complete = true; features.eligible = true;
    for (let i = 0; i < 2; i++) {
      const id = Number(s.db.prepare("INSERT INTO signals(token,status,triggered_at,price_at_trigger,outcome_1h) VALUES ('T','control',?,'1',?)")
        .run(t + i, i ? 9 : null).lastInsertRowid);
      saveLiveQuality(s.db, id, t + i, '1', t + i, { ...features, sampledAt: t + i, windowEnd: t + i }, 'c', 'r', t + i);
    }
    const report = compareSamples(s.db, 'validVotes', 3, t + 7200);
    expect(report.ready).toBe(false);
    expect(report.cohorts[0]).toMatchObject({ uniqueTokens: 1, mature: 1, valid: 0 });
    expect(report.conclusion).toContain('拒绝');
  });
  it('freshness rejects missing and future timestamps', () => {
    expect(fresh(null, instant, 60)).toBe(false); expect(fresh(instant + 1, instant, 60)).toBe(false);
    expect(fresh(instant - 60, instant, 60)).toBe(true); expect(fresh(instant - 61, instant, 60)).toBe(false);
  });
});

describe('background budget', () => {
  it('shares the global budget and reserves follow-feed capacity', async () => {
    const bucket = new TokenBucket({ ratePerSecond: 10, capacity: 5 });
    const client = { getTokenKline: vi.fn(async () => ({})) } as unknown as OpenApiClient;
    const gateway = new GmgnGateway({ client, limiter: bucket, banGate: new BanGate() });
    await gateway.background().fetchKline('T', '1m', 1, 2);
    expect(bucket.available).toBeGreaterThanOrEqual(3); expect(bucket.available).toBeLessThan(4);
  });
  it('does not call the API while banned and propagates a new 429 to foreground work', async () => {
    const gate = new BanGate(); gate.banUntil(Date.now() + 60000, 'test');
    const client = { getTokenKline: vi.fn(async () => { throw Object.assign(new Error('limited'), { status: 429 }); }) } as unknown as OpenApiClient;
    const gateway = new GmgnGateway({ client, limiter: new TokenBucket({ ratePerSecond: 10, capacity: 5 }), banGate: gate });
    await expect(gateway.background().fetchKline('T', '1m', 1, 2)).rejects.toBeInstanceOf(BackgroundBusyError);
    expect(client.getTokenKline).not.toHaveBeenCalled();
    const second = new GmgnGateway({ client, limiter: new TokenBucket({ ratePerSecond: 10, capacity: 5 }), banGate: new BanGate() });
    await expect(second.background().fetchKline('T', '1m', 1, 2)).rejects.toBeInstanceOf(RateLimitedError);
    expect(second.isBanned).toBe(true);
  });
});

it('does not repair an active candidate before its observation becomes terminal', async () => {
  const s = legacy(); syncQuality(s.db, instant);
  s.db.prepare("UPDATE signals SET status='candidate'").run();
  await repairBaselines(s.deps);
  expect(s.fetchKline).not.toHaveBeenCalled();
});

it('admits a sufficiently sized cohort but revokes eligibility for subsequently recorded gaps', () => {
  const s = scenario(); const t = Math.floor(s.deps.now() / 1000);
  setKv(s.db, 'quality_tracking_started_at', t - 20000);
  const template = captureFeatures(s.db, config, blacklist, 'T', t);
  template.complete = true; template.eligible = true;
  for (let i = 0; i < 144; i++) {
    const ts = t + i * 4 * 3600;
    const id = Number(s.db.prepare('INSERT INTO signals(token,status,triggered_at,price_at_trigger,outcome_1h) VALUES (?,?,?,\'1\',1.1)')
      .run(`T${i}`, i % 2 ? 'pushed' : 'control', ts).lastInsertRowid);
    saveLiveQuality(s.db, id, ts, '1', ts, { ...template, sampledAt: ts, windowStart: ts - 900, windowEnd: ts,
      validVotes: i % 2 ? 3 : 2 }, 'c', 'r', ts);
  }
  expect(compareSamples(s.db, 'validVotes', 3, t + 25 * 86400).ready).toBe(true);
  upsertSourceHealth(s.db, { source: 'follow', gap_from_ts: t - 1, gap_to_ts: t + 25 * 86400 }, t + 25 * 86400);
  expect(compareSamples(s.db, 'validVotes', 3, t + 25 * 86400).ready).toBe(false);
});

it('background acquisition yields to existing foreground requests and supports cancellation by ban', async () => {
  vi.useFakeTimers();
  try {
    const bucket = new TokenBucket({ ratePerSecond: 10, capacity: 5 });
    bucket.tryAcquire(5);
    const order: string[] = [];
    const front = bucket.acquire(3).then(() => { order.push('foreground'); });
    const gate = new BanGate();
    const client = { getTokenKline: vi.fn(async () => { order.push('background'); return {}; }) } as unknown as OpenApiClient;
    const gateway = new GmgnGateway({ client, limiter: bucket, banGate: gate });
    const back = gateway.background().fetchKline('T', '1m', 1, 2);
    await vi.advanceTimersByTimeAsync(300);
    expect(order).toEqual(['foreground']);
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([front, back]);
    expect(order).toEqual(['foreground','background']);
    const pending = gateway.background().fetchKline('T', '1m', 1, 2);
    const rejected = expect(pending).rejects.toBeInstanceOf(BackgroundBusyError);
    gate.banUntil(Date.now() + 60000, 'test');
    await vi.advanceTimersByTimeAsync(250);
    await rejected;
    expect(client.getTokenKline).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});


it('treats malformed numeric-prefix prices as recoverable, not ready legacy baselines', async () => {
  const s = legacy('1bad');
  syncQuality(s.db, instant);
  expect(getQuality(s.db, 1)?.state).toBe('pending');
  expect((await repairBaselines(s.deps)).historical).toBe(1);
  expect(getQuality(s.db, 1)?.anchor_price).toBe('2');
});
