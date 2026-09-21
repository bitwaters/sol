import { sourceLabel, utcTime } from '../telegram/labels.js';
import { readdirSync, statSync, unlinkSync, mkdirSync, renameSync } from 'node:fs';
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
        message: `${sourceLabel(row.source)}采集超时（最近成功：${utcTime(row.last_success_at)}）`,
      });
    }
    if (row.gap_from_ts !== null) {
      alerts.push({
        kind: `gap:${row.source}`,
        severity: 'warn',
        message: `${sourceLabel(row.source)}存在采集缺口：${utcTime(row.gap_from_ts)} 至 ${utcTime(row.gap_to_ts)}`,
      });
    }
  }

  if (gatewayBannedUntilMs !== null && gatewayBannedUntilMs > nowSec * 1000) {
    alerts.push({
      kind: 'gmgn_ban',
      severity: 'error',
      message: `GMGN 封禁中，恢复时间 ${utcTime(gatewayBannedUntilMs / 1000)}`,
    });
  }

  const unknown = db
    .prepare("SELECT COUNT(*) AS n FROM push_tasks WHERE status = 'unknown'")
    .get() as { n: number };
  if (unknown.n > unknownPileupThreshold) {
    alerts.push({
      kind: 'push_unknown',
      severity: 'warn',
      message: `送达结果待确认的推送积压 ${unknown.n} 条（告警阈值 ${unknownPileupThreshold} 条）`,
    });
  }

  const failed = db.prepare("SELECT COUNT(*) AS n FROM push_tasks WHERE status='failed' AND attempts>=max_attempts").get() as { n: number };
  if (failed.n > 0) alerts.push({ kind: 'push_exhausted', severity: 'error', message: `推送重试已耗尽 ${failed.n} 条` });
  if (getKv(db, 'research_enabled') === true && nowSec - started > 600) {
    const due = db.prepare("SELECT COUNT(*) n FROM research_outcomes WHERE state='pending' AND next_at<=?").get(nowSec) as {n:number};
    const progress = db.prepare("SELECT MAX(checked_at) at FROM research_outcomes WHERE last_error IS NULL OR last_error!='background_busy'").get() as {at:number|null};
    if (due.n > 0 && nowSec - (progress.at ?? started) > 600) alerts.push({ kind: 'research_stalled', severity: 'error',
      message: `研究行情补采超过10分钟未完成检查，已到期积压 ${due.n} 项（最近检查：${utcTime(progress.at)}）` });
  }
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
  const stateKey = `ops_private_active:${deps.chatId}`;
  const previous = getKv<Record<string,{message:string;sentAt:number}>>(deps.db,stateKey) ?? {};
  const next = {...previous};
  for (const alert of alerts) {
    const prior = previous[alert.kind];
    if (prior && deps.nowSec-prior.sentAt<3600) continue;
    await deps.sender.sendMessage(deps.chatId, `${alert.severity==='error'?'🚨':'⚠️'} ${prior?'异常持续：':''}${alert.message}`);
    next[alert.kind]={message:alert.message,sentAt:deps.nowSec};
    setKv(deps.db,stateKey,next,deps.nowSec); sent++;
  }
  const active = new Set(alerts.map(a=>a.kind));
  for (const [kind,prior] of Object.entries(previous)) {
    if(active.has(kind))continue;
    await deps.sender.sendMessage(deps.chatId, `✅ 异常已解除：${prior.message}\n确认时间：${utcTime(deps.nowSec)}\n历史缺口仍保留，不代表历史数据已补齐。`);
    delete next[kind];setKv(deps.db,stateKey,next,deps.nowSec);sent++;
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

/** Incremental SQLite backup yields between chunks so requests and deadlines keep running. */
export async function backupDatabaseOnline(db: Db, backupDir: string, options: {now?:Date;retentionDays?:number;logger?:Logger} = {}): Promise<string> {
  const now = options.now ?? new Date();
  mkdirSync(backupDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const path = join(backupDir, `meme-${stamp}.sqlite`), partial = `${path}.partial`;
  try {
    await db.backup(partial, { progress: () => 64 });
    renameSync(partial, path);
  } catch (error) {
    try { unlinkSync(partial); } catch { /* no incomplete backup is advertised */ }
    throw error;
  }
  options.logger?.info('数据库在线备份完成', { path });
  const cutoff = now.getTime() - (options.retentionDays ?? 7) * 86_400_000;
  for (const name of readdirSync(backupDir)) {
    if (!name.endsWith('.sqlite')) continue;
    try { const file = join(backupDir,name); if (statSync(file).mtimeMs < cutoff) unlinkSync(file); } catch { /* retry next run */ }
  }
  return path;
}
