import { failureLabels } from '../telegram/delivery-failures.js';
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
  const restart=getKv<{requestedAt:number;startedAt:number}>(db,'last_planned_restart');
  const restartRelated=(from:number|null)=>restart&&from!==null&&from<=restart.startedAt&&from>=restart.requestedAt-60&&nowSec-restart.startedAt<600?'（计划部署重启期间；仍保留数据缺失标记）':'';
  const enabled = getKv<string[]>(db, 'enabled_sources');
  const rows = enabled ? enabled.map((source) => health.find((h) => h.source === source) ?? { source, last_success_at: null, gap_from_ts: null, gap_to_ts: null }) : health;
  for (const row of rows) {
    if (nowSec - started > heartbeatTimeoutSec && (row.last_success_at === null || nowSec - row.last_success_at > heartbeatTimeoutSec)) {
      alerts.push({
        kind: `heartbeat:${row.source}`,
        severity: 'error',
        message: `${sourceLabel(row.source)}采集超时（最近成功：${utcTime(row.last_success_at)}）${restartRelated(row.last_success_at)}`,
      });
    }
    if (row.gap_from_ts !== null) {
      alerts.push({
        kind: `gap:${row.source}`,
        severity: 'warn',
        message: `${sourceLabel(row.source)}存在采集缺口：${utcTime(row.gap_from_ts)} 至 ${utcTime(row.gap_to_ts)}${restartRelated(row.gap_from_ts)}`,
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

  const unconfirmedExit=db.prepare("SELECT COUNT(*) n FROM push_tasks WHERE kind='exit_alert' AND status='unknown' AND tg_message_id IS NULL AND attempts>=max_attempts").get() as {n:number};
  if(unconfirmedExit.n)alerts.push({kind:'exit_delivery_unknown',severity:'error',
    message:`${unconfirmedExit.n} 条首次退出提醒送达结果不明，已停止自动补发以避免刷屏，请管理员核对频道。`});
  const stateUnknown=db.prepare("SELECT COUNT(*) n FROM push_tasks WHERE kind='escalate' AND status='unknown' AND tg_message_id IS NULL AND attempts>=max_attempts").get() as {n:number};
  if(stateUnknown.n)alerts.push({kind:'state_delivery_unknown',severity:'error',
    message:`${stateUnknown.n} 条首次共识状态卡片送达结果不明，已停止该信号的新状态卡片，请管理员核对频道。`});
  const blocked=db.prepare(`SELECT json_extract(k.value,'$.category') category,COUNT(*) n FROM kv k
    JOIN signals s ON s.id=json_extract(k.value,'$.signalId') WHERE k.key GLOB 'reply_block:*'
    AND json_extract(k.value,'$.category')!='delivery_unknown' AND s.sent_at>=? GROUP BY category`).all(nowSec-86400) as {category:string;n:number}[];
  if(blocked.length)alerts.push({kind:'reply_unavailable',severity:'error',message:'回复卡片已停止更新：'+blocked.map(b=>`${failureLabels[b.category]??'目标不可用'} ${b.n} 张`).join('；')+'。不会新发替代卡片，请管理员核对。'});
  const milestoneUnknown = db.prepare("SELECT COUNT(*) n FROM push_tasks WHERE kind='milestone' AND status='unknown' AND attempts>=max_attempts").get() as {n:number};
  if (milestoneUnknown.n) alerts.push({kind:'milestone_delivery_unknown',severity:'error',
    message:`${milestoneUnknown.n} 条倍率汇总送达结果不明，已停止自动补发，请核对频道。`});
  const cleanupFailed = db.prepare("SELECT COUNT(*) n FROM kv WHERE key GLOB 'milestone_cleanup:*' AND json_extract(value,'$.attempts')>=3").get() as {n:number};
  if (cleanupFailed.n) alerts.push({kind:'milestone_cleanup_failed',severity:'error',
    message:`${cleanupFailed.n} 条旧倍率汇总删除失败，已暂停对应信号的新倍率推送，请检查删除权限。`});
  if(getKv(db,'wal_checkpoint_failed')===true)alerts.push({kind:'wal_checkpoint_failed',severity:'warn',
    message:'后台数据库检查点异常，已回退自动检查点，可能增加采集延迟。'});
  const wal=getKv<{at:number;logPages:number;checkpointedPages:number}>(db,'wal_checkpoint');
  if(wal&&wal.logPages-wal.checkpointedPages>65536)alerts.push({kind:'wal_backlog',severity:'warn',message:'数据库日志待回写量较大，请检查长时间读取或磁盘性能。'});
  const derived=db.prepare('SELECT COUNT(*) n,MIN(created_at) oldest FROM position_jobs').get() as {n:number;oldest:number|null};
  if(derived.oldest!==null&&nowSec-derived.oldest>60)alerts.push({kind:'positions_stalled',severity:'warn',
    message:`持仓计算积压 ${derived.n} 项，最早等待 ${nowSec-derived.oldest} 秒；相关信号暂缓，原始采集继续。`});
  const costs=db.prepare('SELECT created_at FROM cost_invalidation_job LIMIT 1').get() as {created_at:number}|undefined;
  if(costs&&nowSec-costs.created_at>60)alerts.push({kind:'cost_revocation_pending',severity:'warn',
    message:'缺口影响仍在后台处理，信号资格判断暂缓，原始采集继续。'});
  const failed = db.prepare("SELECT COUNT(*) AS n FROM push_tasks WHERE status='failed' AND attempts>=max_attempts").get() as { n: number };
  if (failed.n > 0) {
    const details=db.prepare(`SELECT t.id,t.signal_id,json_extract(k.value,'$.category') category FROM push_tasks t
      LEFT JOIN kv k ON k.key='push_failure:'||t.id WHERE t.status='failed' AND t.attempts>=t.max_attempts ORDER BY t.id DESC LIMIT 5`)
      .all() as {id:number;signal_id:number;category:string|null}[];
    alerts.push({kind:'push_exhausted',severity:'error',message:`推送重试已耗尽 ${failed.n} 条\n`+
      details.map(t=>`任务 ${t.id} · 信号 #${t.signal_id.toString(36).toUpperCase()}：${failureLabels[t.category??'']??'历史失败，需核对日志'}`).join('\n')});
  }
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
    await deps.sender.sendMessage(deps.chatId, `✅ 异常已解除：${prior.message}\n确认时间：${utcTime(deps.nowSec)}\n${kind.startsWith('gap:')||kind.startsWith('heartbeat:')?'历史缺口仍保留，不代表历史数据已补齐。':kind.startsWith('push_')||kind.includes('delivery')||kind==='reply_unavailable'?'队列状态已更新；不代表历史失败消息已补发。':'当前检查已不再触发此告警。'}`);
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
