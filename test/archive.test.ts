import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { archiveAndPrune } from '../src/ingest/archive.js';
import { openDatabase } from '../src/store/db.js';
import { normalizeTrackResponse } from '../src/ingest/normalize.js';
import { upsertTrades } from '../src/store/repo/trades.js';
import smartmoneyFixture from './fixtures/smartmoney.json' with { type: 'json' };

describe('archiveAndPrune', () => {
  it('归档校验通过后删除过期记录', () => {
    const db = openDatabase({ path: ':memory:' });
    const trades = normalizeTrackResponse('smartmoney', smartmoneyFixture);
    const nowSec = Math.floor(Date.now() / 1000);
    // 把样本时间改到 40 天前
    const old = trades.map((t) => ({ ...t, timestamp: nowSec - 40 * 86_400 }));
    upsertTrades(db, 'smartmoney', old, nowSec - 40 * 86_400);

    const dir = mkdtempSync(join(tmpdir(), 'meme-archive-'));
    const result = archiveAndPrune(db, { archiveDir: dir, retentionDays: 30, now: Date.now() });

    expect(result.days).toBe(1);
    expect(result.archivedTrades).toBe(old.length);
    expect(result.deletedTrades).toBe(old.length);
    expect(result.files.length).toBe(1);
    expect(existsSync(result.files[0]!)).toBe(true);

    const content = gunzipSync(readFileSync(result.files[0]!)).toString('utf8');
    const lines = content.trimEnd().split('\n');
    expect(lines.length).toBe(old.length);
    const first = JSON.parse(lines[0]!) as { sources: string[] };
    expect(first.sources).toContain('smartmoney');

    const remaining = db.prepare('SELECT COUNT(*) AS n FROM trades').get() as { n: number };
    expect(remaining.n).toBe(0);
    db.close();
  });

  it('未过保留期的记录不清理', () => {
    const db = openDatabase({ path: ':memory:' });
    const trades = normalizeTrackResponse('smartmoney', smartmoneyFixture);
    upsertTrades(db, 'smartmoney', trades);
    const dir = mkdtempSync(join(tmpdir(), 'meme-archive-'));
    const result = archiveAndPrune(db, { archiveDir: dir, retentionDays: 30 });
    expect(result.days).toBe(0);
    expect(result.deletedTrades).toBe(0);
    db.close();
  });
});
