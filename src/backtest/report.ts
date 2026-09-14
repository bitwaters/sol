import { qualityOverview, qualityReportLines } from './quality-report.js';
import { compareSamples } from './compare.js';
import { reasonLabel, sourceLabel } from '../telegram/labels.js';
import type { AppConfig } from '../config.js';
import type { Db } from '../store/db.js';
import type { TelegramApi } from '../telegram/types.js';

export interface StatsReport {
  text: string;
  pushedCount: number;
  controlCount: number;
  coverage: number;
  controlSufficient: boolean;
}

interface OutcomeRow {
  id: number;
  token: string;
  status: string;
  wallet_count: number | null;
  price_ratio: number | null;
  reason: string | null;
  outcome_5m: number | null;
  outcome_1h: number | null;
  outcome_24h: number | null;
  triggered_at: number;
  age_minutes: number | null;
  market_cap: number | null;
  warn_snapshot?: boolean | null;
  votes_snapshot?: number | null;
  sources: string[];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function fmt(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(2)}x`;
}

const CONTROL_MIN_SAMPLES = 20;

/** /stats 与每日报告共用（M4-3）：先报告价格变化与覆盖率 */
export function buildStatsReport(db: Db, config: AppConfig): StatsReport {
  const raw = db
    .prepare(
      `SELECT id, token, status, wallet_count, price_ratio, reason,
              outcome_5m, outcome_1h, outcome_24h, COALESCE(sent_at,triggered_at) AS triggered_at, COALESCE(send_snapshot,snapshot) AS snapshot
       FROM signals WHERE status IN ('pushed','control','invalidated','blocked_price','expired')`,
    )
    .all() as Array<{
    id: number;
    token: string;
    status: string;
    wallet_count: number | null;
    price_ratio: number | null;
    reason: string | null;
    outcome_5m: number | null;
    outcome_1h: number | null;
    outcome_24h: number | null;
    triggered_at: number;
    snapshot: string | null;
  }>;

  // 分组使用发送时（未推送候选使用触发时）的不可变快照，避免随时间漂移
  const rows: OutcomeRow[] = raw.map((row) => {
    let createdAt: number | null = null;
    let marketCap: number | null = null;
    let snapPriceRatio: number | null = null;
    let snapWarn: boolean | null = null;
    let snapVotes: number | null = null;
    let sources: string[] = [];
    if (row.snapshot) {
      try {
        const snap = JSON.parse(row.snapshot) as {
          tokenMetrics?: { createdAt?: number | null; marketCap?: number | null };
          votes?: number;
          priceRatio?: number | null;
          warn?: boolean;
          sources?: string[];
          wallets?: Array<{ sources?: string[] }>;
        };
        createdAt = snap.tokenMetrics?.createdAt ?? null;
        marketCap = snap.tokenMetrics?.marketCap ?? null;
        const ratio = snap.priceRatio == null ? NaN : Number(snap.priceRatio);
        snapPriceRatio = Number.isFinite(ratio) ? ratio : null;
        snapWarn = typeof snap.warn === 'boolean' ? snap.warn : null;
        snapVotes = typeof snap.votes === 'number' ? snap.votes : null;
        sources = [...new Set(snap.sources ?? snap.wallets?.flatMap(wallet => wallet.sources ?? []) ?? [])].sort();
      } catch {
        // 忽略快照解析失败
      }
    }
    return {
      ...row,
      price_ratio: snapPriceRatio ?? row.price_ratio,
      warn_snapshot: snapWarn,
      votes_snapshot: snapVotes,
      sources,
      age_minutes: createdAt !== null ? Math.floor((row.triggered_at - createdAt) / 60) : null,
      market_cap: marketCap,
    };
  });

  const pushed = rows.filter((r) => r.status === 'pushed');
  const control = rows.filter((r) => r.status === 'control');
  const intercepted = rows.filter(
    (r) =>
      r.status === 'invalidated' || r.status === 'blocked_price' || r.status === 'expired',
  );
  const pushedQuality = qualityOverview(db).find(group => group.group === 'pushed')!;
  const matured = pushedQuality.cohorts.reduce((sum, cohort) => sum + cohort.horizons[1]!.mature, 0);
  const evaluated = pushedQuality.cohorts.reduce((sum, cohort) => sum + cohort.horizons[1]!.valid, 0);
  const coverage = matured > 0 ? evaluated / matured : 0;

  const lines: string[] = qualityReportLines(db);
  lines.push('', '以下全量价格描述含不同数据版本，不用于验证参数。');
  lines.push('📈 信号表现（价格变化倍数，1.00x = 持平）');
  lines.push(
    `样本：已推送 ${pushed.length} · 对照 ${control.length} · 1小时 覆盖率 ${(coverage * 100).toFixed(0)}%`,
  );
  lines.push('');
  lines.push(
    `全量 5分钟/1小时/24小时 中位数：${fmt(median(pushed.map((r) => r.outcome_5m).filter((v): v is number => v !== null)))} / ${fmt(
      median(pushed.map((r) => r.outcome_1h).filter((v): v is number => v !== null)),
    )} / ${fmt(median(pushed.map((r) => r.outcome_24h).filter((v): v is number => v !== null)))}`,
  );

  const groups: Array<[string, (r: OutcomeRow) => boolean]> = [
    ['票数 3-4', (r) => r.votes_snapshot !== null && r.votes_snapshot !== undefined && r.votes_snapshot >= 3 && r.votes_snapshot <= 4],
    ['票数 ≥5', (r) => (r.votes_snapshot ?? 0) >= 5],
    ['追高警告', (r) => r.warn_snapshot === true || (r.warn_snapshot === null && r.price_ratio !== null && r.price_ratio > config.signalValidation.warnPriceAboveEntry)],
    ['无警告', (r) => r.warn_snapshot === false || (r.warn_snapshot === null && r.price_ratio !== null && r.price_ratio <= config.signalValidation.warnPriceAboveEntry)],
    ['代币年龄 <1小时', (r) => r.age_minutes !== null && r.age_minutes < 60],
    ['市值 <5万美元', (r) => r.market_cap !== null && r.market_cap < 50_000],
    ['市值 ≥5万美元', (r) => r.market_cap !== null && r.market_cap >= 50_000],
  ];
  for (const key of [...new Set(pushed.map(row => row.sources.join(',')))].filter(Boolean).sort()) {
    groups.push([`来源 ${key.split(',').map(source => sourceLabel(source)).join('＋')}`, row => row.sources.join(',') === key]);
  }
  lines.push('');
  lines.push('分组 1小时 中位数（样本数）：');
  for (const [label, predicate] of groups) {
    const subset = pushed.filter(predicate);
    const values = subset.map((r) => r.outcome_1h).filter((v): v is number => v !== null);
    lines.push(`· ${label}：${fmt(median(values))}（${values.length}）`);
  }

  const controlValues = control
    .map((r) => r.outcome_1h)
    .filter((v): v is number => v !== null);
  lines.push('');
  lines.push(`对照组 1小时 中位数：${fmt(median(controlValues))}（${controlValues.length}）`);

  const controlSufficient = controlValues.length >= CONTROL_MIN_SAMPLES && compareSamples(db).ready;
  if (!controlSufficient) {
    lines.push('⚠️ 对照样本不足，无法验证阈值；或质量、覆盖率、独立代币及时间留出门槛未达标，不据此调整参数。');
  }

  // 被拦截候选：验证过滤是否错杀
  if (intercepted.length > 0) {
    lines.push('');
    lines.push(`未推送候选 1小时 中位数（共 ${intercepted.length}）：`);
    const byReason = new Map<string, OutcomeRow[]>();
    for (const row of intercepted) {
      const reason = reasonLabel(row.reason);
      const list = byReason.get(reason) ?? [];
      list.push(row);
      byReason.set(reason, list);
    }
    for (const [reason, list] of [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const values = list.map((r) => r.outcome_1h).filter((v): v is number => v !== null);
      lines.push(`· ${reason}：${fmt(median(values))}（${values.length}/${list.length}）`);
    }
  }
  lines.push('ℹ️ 未含成本模型（手续费/滑点/网络费用）前不报告策略胜率。');

  return {
    text: lines.join('\n'),
    pushedCount: pushed.length,
    controlCount: control.length,
    coverage,
    controlSufficient,
  };
}

export interface DailyReportDeps {
  db: Db;
  config: AppConfig;
  sender: TelegramApi;
  chatId: string;
  logger?: { info(msg: string, fields?: Record<string, unknown>): void };
}

/** 按 UTF-16 长度保守分段，优先在换行处分开，不截断代理对。 */
export function splitReportText(text: string, limit = 4000): string[] {
  if (!Number.isInteger(limit) || limit < 2) throw new Error('report chunk limit must be at least 2');
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let end = rest.lastIndexOf('\n', limit - 1);
    if (end <= 0) end = limit;
    else end += 1;
    const last = rest.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    chunks.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export async function sendDailyReport(deps: DailyReportDeps): Promise<StatsReport> {
  const report = buildStatsReport(deps.db, deps.config);
  for (const text of splitReportText(report.text)) {
    await deps.sender.sendMessage(deps.chatId, text, { disable_web_page_preview: true });
  }
  deps.logger?.info('每日报告已发送', {
    pushed: report.pushedCount,
    control: report.controlCount,
  });
  return report;
}
