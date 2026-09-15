import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeMetrics } from '../src/ops/metrics.js';
import { EvaluationScheduler } from '../src/signal/scheduler.js';
import { resolveStaleGaps } from '../src/signal/integrity.js';
import { getSourceHealth, upsertSourceHealth } from '../src/store/repo/health.js';
import { getKv, openDatabase } from '../src/store/db.js';
import { Poller } from '../src/ingest/poller.js';
import { scenario, log } from './review-fixture.js';
import { evaluateToken, revalidateSignalForSend } from '../src/signal/candidate.js';
import { Pusher } from '../src/telegram/pusher.js';
import { TelegramDeliveryUnknownError, TelegramRateLimitError } from '../src/telegram/types.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fixture from './fixtures/smartmoney.json' with { type: 'json' };
import { OpenApiClient } from '../src/gmgn/OpenApiClient.js';

afterEach(() => vi.useRealTimers());

it('a 429 reset_at in the body is honored even when the reset header is absent or earlier', async () => {
  for (const header of [undefined, '2000000000']) {
    const client = new OpenApiClient({ apiKey: 'test', host: 'https://example.invalid', autoRetryOnRateLimit: false });
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ code: 429,
      error: 'RATE_LIMIT_BANNED', reset_at: 2000000020 }), { status: 429,
      headers: header ? { 'x-ratelimit-reset': header } : {} }));
    try { await expect(client.getSmartMoney('sol', 1)).rejects.toMatchObject({ resetAtUnix: 2000000020 }); }
    finally { fetch.mockRestore(); }
  }
});

it('keeps bounded percentile samples and cumulative counts without invalid durations', () => {
  const m = new RuntimeMetrics(3);
  for (const v of [10, 20, 30, 40, NaN, -1]) m.observe('request', v);
  expect(m.snapshot().request).toEqual({ count: 4, meanMs: 25, maxMs: 40, sampleCount: 3, p50Ms: 30, p95Ms: 40 });
});

it('a trade arriving during evaluation triggers one final rerun, without parallel same-token runs', async () => {
  vi.useFakeTimers();
  const releases: Array<() => void> = [];
  const run = vi.fn(() => new Promise<void>(resolve => releases.push(resolve)));
  const scheduler = new EvaluationScheduler({ concurrency: 2, delayMs: 250, run, onError: vi.fn() });
  scheduler.schedule('a');
  await vi.advanceTimersByTimeAsync(250);
  scheduler.schedule('a'); scheduler.schedule('a');
  expect(run).toHaveBeenCalledTimes(1);
  releases.shift()!();
  await vi.advanceTimersByTimeAsync(0);
  expect(run).toHaveBeenCalledTimes(2);
  scheduler.stop(); releases.shift()!();
  await vi.advanceTimersByTimeAsync(1000);
  expect(run).toHaveBeenCalledTimes(2);
});

it('accepting a historical gap does not reopen it when oldest overlapping rows leave the page', async () => {
  const db = openDatabase({ path: ':memory:' });
  try {
    const list = fixture.list;
    let now = Math.max(...list.map(row => row.timestamp)) + 1;
    let page = list;
    const poller = new Poller({ source: 'smartmoney', intervalMs: 1500, limit: list.length,
      db, logger: log, now: () => now * 1000, fetchPage: async () => ({ list: page }) });
    await poller.tick();
    const oldWatermark = getSourceHealth(db, 'smartmoney').watermark_ts!;
    now += 1000;
    page = list.map((row, i) => ({ ...row, timestamp: now - list.length + i }));
    expect((await poller.tick()).gapDetected).toBe(true);
    now += 601;
    const latest = Math.max(...page.map(row => row.timestamp));
    resolveStaleGaps(db, now);
    expect(getSourceHealth(db, 'smartmoney').watermark_ts).toBe(latest);
    const gapEnd = Math.min(...page.map(row => row.timestamp));
    expect(getKv(db, 'last_accepted_gap:smartmoney')).toMatchObject({ from: oldWatermark, to: gapEnd, recovered: false });
    expect(db.prepare('SELECT to_ts,state FROM data_gaps').get()).toEqual({ to_ts: gapEnd, state: 'accepted' });
    page = page.slice(3);
    expect((await poller.tick()).gapDetected).toBe(false);
    expect(getSourceHealth(db, 'smartmoney').gap_from_ts).toBeNull();
    expect(getKv(db, 'accepted_gap_count:smartmoney')).toBe(1);
  } finally { db.close(); }
});

it('network failure preserves ingestion data and resumes at the same source watermark', async () => {
  const db = openDatabase({ path: ':memory:' });
  try {
    let disconnected = false;
    const poller = new Poller({ source: 'kol', db, logger: log, intervalMs: 3000, limit: 100,
      fetchPage: async () => { if (disconnected) throw new TypeError('fetch failed'); return fixture; } });
    await poller.tick();
    const before = getSourceHealth(db, 'kol');
    disconnected = true;
    expect(await poller.tick()).toMatchObject({ error: 'fetch failed', nextIntervalMs: 6000 });
    expect(getSourceHealth(db, 'kol')).toEqual(before);
    disconnected = false;
    expect(await poller.tick()).toMatchObject({ insertedEvents: 0, gapDetected: false });
  } finally { db.close(); }
});

it('transport uncertainty persists as unknown, respects retry time and stops at the attempt limit', async () => {
  const s = scenario();
  try {
    const result = await evaluateToken(s.deps, 'T');
    expect(result.pushTaskCreated).toBe(true);
    let now = s.deps.now();
    const sendMessage = vi.fn(async () => { throw new TelegramDeliveryUnknownError(); });
    const pusher = new Pusher({ db: s.db, config: s.deps.config, chatId: 'test-only', logger: log,
      sender: { sendMessage, editMessageText: vi.fn() }, now: () => now });
    await pusher.runOnce();
    expect(s.db.prepare('SELECT status, attempts FROM push_tasks').get()).toMatchObject({ status: 'unknown', attempts: 1 });
    await pusher.runOnce(); expect(sendMessage).toHaveBeenCalledTimes(1);
    now += 60_000;
    await pusher.runOnce(); expect(sendMessage).toHaveBeenCalledTimes(2);
    // Refresh qualification time, but never reset retry attempts.
    now += 120_000;
    s.db.prepare('UPDATE push_tasks SET payload=?').run(JSON.stringify({ evaluatedAt: now / 1000 }));
    await pusher.runOnce(); expect(sendMessage).toHaveBeenCalledTimes(3);
    now += 1000_000;
    await pusher.runOnce(); expect(sendMessage).toHaveBeenCalledTimes(3);
  } finally { s.db.close(); }
});

it('Telegram 429 waits for retry_after, then performs the complete send recheck', async () => {
  const s = scenario();
  try {
    await evaluateToken(s.deps, 'T');
    let now = s.deps.now();
    const sendMessage = vi.fn().mockRejectedValueOnce(new TelegramRateLimitError(5)).mockResolvedValue({ message_id: 77 });
    const revalidate = vi.fn((id: number) => revalidateSignalForSend(s.deps, id));
    const pusher = new Pusher({ db: s.db, config: s.deps.config, chatId: 'test-only', logger: log,
      sender: { sendMessage, editMessageText: vi.fn() }, now: () => now, revalidate });
    await pusher.runOnce(); now += 4999;
    await pusher.runOnce(); expect(sendMessage).toHaveBeenCalledTimes(1);
    now += 1;
    expect((await pusher.runOnce()).sent).toBe(1);
    expect(revalidate).toHaveBeenCalledTimes(2);
  } finally { s.db.close(); }
});

it('a persisted in-flight task resumes after reopening its database', async () => {
  const s = scenario();
  const dir = mkdtempSync(join(tmpdir(), 'sol-restart-'));
  let reopened: ReturnType<typeof openDatabase> | undefined;
  try {
    await evaluateToken(s.deps, 'T');
    const now = s.deps.now();
    s.db.prepare("UPDATE push_tasks SET status='sending', updated_at=?").run(now / 1000 - 11);
    await s.db.backup(join(dir, 'restart.sqlite'));
    s.db.close();
    reopened = openDatabase({ path: join(dir, 'restart.sqlite') });
    const sendMessage = vi.fn(async () => ({ message_id: 88 }));
    const pusher = new Pusher({ db: reopened, config: s.deps.config, chatId: 'test-only', logger: log,
      sender: { sendMessage, editMessageText: vi.fn() }, now: () => now });
    expect((await pusher.runOnce()).sent).toBe(1);
    expect(reopened.prepare('SELECT status FROM push_tasks').get()).toEqual({ status: 'sent' });
    expect((await pusher.runOnce()).sent).toBe(0);
  } finally { if (s.db.open) s.db.close(); reopened?.close(); rmSync(dir, { recursive: true, force: true }); }
});
