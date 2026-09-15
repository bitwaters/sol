import { expect, it } from 'vitest';
import { applySchema, getKv, openDatabase } from '../src/store/db.js';
import { getSourceHealth, upsertSourceHealth } from '../src/store/repo/health.js';
import { Poller } from '../src/ingest/poller.js';
import { resolveStaleGaps } from '../src/signal/integrity.js';
import { log, scenario } from './review-fixture.js';
import fixture from './fixtures/smartmoney.json' with { type: 'json' };

it('persists latest-page continuity across restarts without widening a real historical hole', async () => {
  const db = openDatabase({ path: ':memory:' });
  try {
    const base = Math.max(...fixture.list.map(r => r.timestamp));
    let now = base + 1, page = fixture.list;
    const makePoller = () => new Poller({ db, source: 'smartmoney', intervalMs: 1000, limit: page.length,
      logger: log, now: () => now * 1000, fetchPage: async () => ({ list: page }) });
    const p = makePoller(); await p.tick();
    page = fixture.list.map((r, i) => ({ ...r, timestamp: base + 100 + i })); now += 130;
    expect((await p.tick()).gapDetected).toBe(true);
    const gap = getSourceHealth(db, 'smartmoney');
    expect(gap).toMatchObject({ watermark_ts: base, head_ts: base + 119, gap_to_ts: base + 100 });
    // Simulate the first upgrade from a schema that did not persist a page head.
    db.exec('ALTER TABLE source_health DROP COLUMN head_ts'); applySchema(db); applySchema(db);
    page = [...page.slice(5), ...fixture.list.slice(0, 5).map((r, i) => ({ ...r, timestamp: base + 120 + i }))];
    expect((await makePoller().tick()).gapDetected).toBe(false);
    expect(getSourceHealth(db, 'smartmoney')).toMatchObject({ watermark_ts: base, head_ts: base + 124, gap_to_ts: base + 100 });
    expect(getKv(db, 'gap_since:smartmoney')).toBe(gap.updated_at);
    // A stale page below the lower bound cannot prove the full hole was filled.
    page = fixture.list.slice(0, 5);
    expect((await makePoller().tick()).gapCovered).toBe(false);
    expect(getSourceHealth(db, 'smartmoney').gap_to_ts).toBe(base + 100);
    // Another truly disjoint full page must extend the lost range.
    page = fixture.list.map((r, i) => ({ ...r, timestamp: base + 200 + i })); now += 100;
    expect((await makePoller().tick()).gapDetected).toBe(true);
    expect(getSourceHealth(db, 'smartmoney')).toMatchObject({ gap_from_ts: base, gap_to_ts: base + 200, head_ts: base + 219 });
    resolveStaleGaps(db, now + 601);
    expect(db.prepare('SELECT from_ts,to_ts,state FROM data_gaps').get())
      .toEqual({ from_ts: base, to_ts: base + 200, state: 'accepted' });
    expect(getSourceHealth(db, 'smartmoney')).toMatchObject({ watermark_ts: base + 219, head_ts: base + 219 });
  } finally { db.close(); }
});

it('revokes affected positions once per new or extended gap, preserving maximum cross-source boundary', () => {
  const s = scenario(), at = s.deps.now() / 1000;
  try {
    s.db.prepare("UPDATE wallet_positions SET cycle_started_at=? WHERE wallet='w3'").run(at + 10);
    upsertSourceHealth(s.db, { source: 'smartmoney', gap_from_ts: at - 20, gap_to_ts: at }, at);
    expect(getKv(s.db, 'gap_affected:T:w1')).toBe(true);
    expect(getKv(s.db, 'gap_affected_until:T:w1')).toBe(at);
    expect(getKv(s.db, 'gap_affected:T:w3')).toBeNull();
    const changes = (s.db.prepare('SELECT total_changes() n').get() as {n:number}).n;
    upsertSourceHealth(s.db, { source: 'smartmoney', last_success_at: at + 1 }, at + 1);
    expect((s.db.prepare('SELECT total_changes() n').get() as {n:number}).n - changes).toBe(2); // health + gap, no position/kv scan
    upsertSourceHealth(s.db, { source: 'kol', gap_from_ts: at - 30, gap_to_ts: at - 10 }, at + 2);
    expect(getKv(s.db, 'gap_affected_until:T:w1')).toBe(at);
    upsertSourceHealth(s.db, { source: 'smartmoney', gap_to_ts: at + 20 }, at + 20);
    expect(getKv(s.db, 'gap_affected_until:T:w3')).toBe(at + 20);
    resolveStaleGaps(s.db, at + 700);
    expect(s.db.prepare('SELECT DISTINCT cost_complete FROM wallet_positions').all()).toEqual([{ cost_complete: 0 }]);
  } finally { s.db.close(); }
});

it('rolls back the page head and bulk invalidation when ingestion fails', async () => {
  const s = scenario(), at = s.deps.now() / 1000;
  try {
    upsertSourceHealth(s.db, { source: 'smartmoney', watermark_ts: at - 100, head_ts: at - 100 }, at);
    const before = getSourceHealth(s.db, 'smartmoney');
    const p = new Poller({ db: s.db, source: 'smartmoney', intervalMs: 1000, limit: 1, logger: log,
      fetchPage: async () => ({ list: [{ ...fixture.list[0]!, timestamp: at }] }),
      onTrades: () => { throw new Error('rollback'); } });
    expect((await p.tick()).error).toBe('rollback');
    expect(getSourceHealth(s.db, 'smartmoney')).toEqual(before);
    expect(getKv(s.db, 'gap_affected:T:w1')).toBeNull();
    expect(s.db.prepare('SELECT DISTINCT cost_complete FROM wallet_positions').all()).toEqual([{ cost_complete: 1 }]);
  } finally { s.db.close(); }
});
