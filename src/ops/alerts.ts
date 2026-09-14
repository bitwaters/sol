import { readdirSync, statSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../logger.js';
import type { Db } from '../store/db.js';
import { getKv, setKv } from '../store/db.js';

export interface OpsAlert {
  kind: string;
  severity: 'warn' | 'error';
  message: string;
}

export interface OpsCheckOptions {
  nowSec: number;
  heartbeatTimeoutSec?: number;
  unknownPileupThreshold?: number;
  gatewayBannedUntilMs?: number | null;
}

/** 运维告警检查（M5-2）：心跳丢失 / 封禁 / unknown 堆积 / 近期缺口 */
export function collectOpsAlerts(db: Db, options: OpsCheckOptions): OpsAlert[] {
  const {
    nowSec,
    heartbeatTimeoutSec = 60,
    unknownPileupThreshold = 5,
    gatewayBannedUntilMs = null,
  } = options;
  const alerts: OpsAlert[] = [];
  const started = getKv<number>(db, 'service_started_at') ?? getKv<number>(db, 'observation_started_at') ?? nowSec;

  const health = db
    .prepare('SELECT source, last_success_at, gap_from_ts, gap_to_ts FROM source_health')
    .all() as Array<{
    source: string;
    last_success_at: number | null;
    gap_from_ts: number | null;
    gap_to_ts: number | null;
  }>;
  const enabled = getKv<string[]>(db, 'enabled_sources');
  const rows = enabled ? enabled.map((source) => health.find((h) => h.source === source) ?? { source, last_success_at: null, gap_from_ts: null, gap_to_ts: null }) : health;
  for (const row of rows) {
    if (nowSec - started > heartbeatTimeoutSec && (row.last_success_at === null || nowSec - row.last_success_at > heartbeatTimeoutSec)) {
      alerts.push({
        kind: `heartbeat:${row.source}`,
        severity: 'error',
        message: `poller ${row.source} 心跳丢失（最后成功 ${row.last_success_at ?? '—'}）`,
      });
    }
    if (row.gap_from_ts !== null) {
      alerts.push({
        kind: `gap:${row.source}`,
        severity: 'warn',
        message: `poller ${row.source} 存在采集缺口 [${row.gap_from_ts}, ${row.gap_to_ts}]`,
      });
    }
  }

  if (gatewayBannedUntilMs !== null && gatewayBannedUntilMs > nowSec * 1000) {
    alerts.push({
      kind: 'gmgn_ban',
      severity: 'error',
      message: `GMGN 封禁中，恢复时间 ${new Date(gatewayBannedUntilMs).toISOString()}`,
    });
  }

  const unknown = db
    .prepare("SELECT COUNT(*) AS n FROM push_tasks WHERE status = 'unknown'")
    .get() as { n: number };
  if (unknown.n > unknownPileupThreshold) {
    alerts.push({
      kind: 'push_unknown',
      severity: 'warn',
      message: `push_tasks unknown 堆积 ${unknown.n} 条（阈值 ${unknownPileupThreshold}）`,
    });
  }

  const failed = db.prepare("SELECT COUNT(*) AS n FROM push_tasks WHERE status='failed' AND attempts>=max_attempts").get() as { n: number };
  if (failed.n > 0) alerts.push({ kind: 'push_exhausted', severity: 'error', message: `推送重试已耗尽 ${failed.n} 条` });
  return alerts;
}

export interface AlertSender {
  sendMessage(chatId: string, text: string): Promise<{ message_id: number }>;
}

/** 发送告警（按 kind 每小时去重，避免刷屏） */
export async function sendOpsAlerts(deps: {
  db: Db;
  sender: AlertSender;
  chatId: string;
  logger: Logger;
  nowSec: number;
  gatewayBannedUntilMs?: number | null;
}): Promise<number> {
  const alerts = collectOpsAlerts(deps.db, {
    nowSec: deps.nowSec,
    ...(deps.gatewayBannedUntilMs !== undefined
      ? { gatewayBannedUntilMs: deps.gatewayBannedUntilMs }
      : {}),
  });
  let sent = 0;
  const bucket = Math.floor(deps.nowSec / 3600);
  for (const alert of alerts) {
    const key = `ops_alert:${alert.kind}:${bucket}`;
    if (getKv<boolean>(deps.db, key) === true) continue;
    const prefix = alert.severity === 'error' ? '🚨' : '⚠️';
    await deps.sender.sendMessage(deps.chatId, `${prefix} ${alert.message}`);
    setKv(deps.db, key, true, deps.nowSec);
    sent += 1;
  }
  return sent;
}

/** SQLite 每日备份（VACUUM INTO），保留最近 N 天 */
export function backupDatabase(
  db: Db,
  backupDir: string,
  options: { now?: Date; retentionDays?: number; logger?: Logger } = {},
): string {
  const now = options.now ?? new Date();
  const retentionDays = options.retentionDays ?? 7;
  mkdirSync(backupDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const path = join(backupDir, `meme-${stamp}.sqlite`);
  db.prepare('VACUUM INTO ?').run(path);
  options.logger?.info('数据库备份完成', { path });

  const cutoff = now.getTime() - retentionDays * 86_400_000;
  for (const file of readdirSync(backupDir)) {
    if (!file.endsWith('.sqlite')) continue;
    const full = join(backupDir, file);
    try {
      if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
    } catch {
      // 忽略清理失败
    }
  }
  return path;
}
