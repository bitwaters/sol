import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { backupDatabase, collectOpsAlerts, sendOpsAlerts } from '../src/ops/alerts.js';
import { openDatabase, setKv } from '../src/store/db.js';
import { upsertSourceHealth } from '../src/store/repo/health.js';
import { createLogger } from '../src/logger.js';

const silent = createLogger({ test: true });
silent.info = () => undefined;
silent.warn = () => undefined;
silent.error = () => undefined;
silent.debug = () => undefined;

describe('M5-2 运维告警', () => {
  it('心跳丢失 / 缺口 / unknown 堆积 / 封禁 均产生告警', () => {
    const db = openDatabase({ path: ':memory:' });
    const nowSec = Math.floor(Date.now() / 1000);
    setKv(db, 'observation_started_at', nowSec - 3600, nowSec);
    upsertSourceHealth(db, { source: 'smartmoney', last_success_at: nowSec - 300 }, nowSec);
    upsertSourceHealth(db, { source: 'kol', last_success_at: nowSec, gap_from_ts: 100, gap_to_ts: 200 }, nowSec);
    for (let i = 0; i < 6; i += 1) {
      db.prepare(
        `INSERT INTO push_tasks (signal_id, kind, revision, dedupe_key, payload, status, created_at, updated_at)
         VALUES (?, 'signal', 0, ?, '{}', 'unknown', ?, ?)`,
      ).run(i + 1, `t${i}`, nowSec, nowSec);
    }
    const alerts = collectOpsAlerts(db, {
      nowSec,
      gatewayBannedUntilMs: (nowSec + 60) * 1000,
    });
    const kinds = alerts.map((a) => a.kind);
    expect(alerts.map(a => a.message).join('\n')).not.toMatch(/poller|smartmoney|push_tasks|unknown/);
    expect(alerts.map(a => a.message).join('\n')).toContain('UTC');
    expect(kinds).toContain('heartbeat:smartmoney');
    expect(kinds).toContain('gap:kol');
    expect(kinds).toContain('push_unknown');
    expect(kinds).toContain('gmgn_ban');
    db.close();
  });

  it('告警按 kind 每小时去重', async () => {
    const db = openDatabase({ path: ':memory:' });
    const nowSec = Math.floor(Date.now() / 1000);
    setKv(db, 'observation_started_at', nowSec - 3600, nowSec);
    upsertSourceHealth(db, { source: 'smartmoney', last_success_at: nowSec - 300 }, nowSec);
    const sent: string[] = [];
    const sender = {
      async sendMessage(_chatId: string, text: string) {
        sent.push(text);
        return { message_id: 1 };
      },
    };
    const first = await sendOpsAlerts({ db, sender, chatId: 'alert', logger: silent, nowSec });
    const second = await sendOpsAlerts({ db, sender, chatId: 'alert', logger: silent, nowSec });
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(0);
    db.close();
  });
});

describe('M5-3 数据库备份', () => {
  it('VACUUM INTO 生成备份文件并清理过期备份', () => {
    const db = openDatabase({ path: ':memory:' });
    db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('k','1',1)").run();
    const dir = mkdtempSync(join(tmpdir(), 'meme-backup-'));
    const path = backupDatabase(db, dir, { retentionDays: 7 });
    expect(existsSync(path)).toBe(true);
    expect(readdirSync(dir).length).toBe(1);
    db.close();
  });
});
