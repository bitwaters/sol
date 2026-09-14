import type { Db } from '../store/db.js';
import { comparable, measurements, type Measurement } from './quality-report.js';

export type ComparisonParameter = 'validVotes' | 'marketCap' | 'ageMinutes';
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.floor(sorted.length / 2);
  return sorted.length ? sorted.length % 2 ? sorted[i]! : (sorted[i - 1]! + sorted[i]!) / 2 : null;
};
/** Read-only, predeclared single-axis comparison. No live configuration mutation. */
export function compareSamples(db: Db, parameter: ComparisonParameter = 'validVotes', threshold = 3,
  now = Math.floor(Date.now() / 1000)) {
  if (!Number.isFinite(threshold) || threshold < 0) throw new Error('threshold must be finite and nonnegative');
  const all = measurements(db);
  const cohorts = new Map<string, Measurement[]>();
  for (const row of all) {
    if (!row.features || !row.config_version || !row.rules_version) continue;
    // Same measurement method, rules, config and source mix; never pool across these boundaries.
    const key = JSON.stringify([row.config_version, row.rules_version, row.features!.qualityVersion,
      row.features!.sources.join(','), 'live']);
    const list = cohorts.get(key) ?? []; list.push(row); cohorts.set(key, list);
  }
  const reports = [...cohorts.entries()].map(([cohort, rows]) => {
    rows.sort((a, b) => a.anchor - b.anchor || a.id - b.id);
    // Deduplicate BEFORE filtering outcomes, so a failed first sample cannot be replaced by a winner.
    const unique = [...new Map([...rows].reverse().map(row => [row.token, row])).values()].sort((a, b) => a.anchor - b.anchor || a.id - b.id);
    const eligible = unique.filter(row => comparable(db, row));
    const matured = eligible.filter(row => row.anchor + 3600 <= now);
    const valid = matured.filter(row => row.outcome_1h !== null && Number.isFinite(row.outcome_1h));
    const span = (unique.at(-1)?.anchor ?? 0) - (unique[0]?.anchor ?? 0);
    const cutoff = (unique[0]?.anchor ?? 0) + Math.floor(span * 0.7);
    const value = (row: Measurement): number | null => parameter === 'validVotes' ? row.features!.validVotes
      : parameter === 'marketCap' ? row.features!.tokenMetrics?.marketCap ?? null
      : row.features!.tokenMetrics?.createdAt == null ? null : (row.anchor - row.features!.tokenMetrics.createdAt) / 60;
    const cells = ['train', 'holdout'].flatMap(split => ['below', 'atOrAbove'].map(bucket => {
      const subset = matured.filter(row => (split === 'train' ? row.anchor < cutoff : row.anchor >= cutoff)
        && value(row) !== null && (bucket === 'below' ? value(row)! < threshold : value(row)! >= threshold));
      const outcomes = subset.filter(row => row.outcome_1h !== null && Number.isFinite(row.outcome_1h)).map(row => row.outcome_1h!);
      return { split, bucket, mature: subset.length, valid: outcomes.length,
        coverage: subset.length ? outcomes.length / subset.length : 0, median1h: median(outcomes) };
    }));
    const reasons: string[] = [];
    const eligibleSpan = (eligible.at(-1)?.anchor ?? 0) - (eligible[0]?.anchor ?? 0);
    if (eligibleSpan < 14 * 86400) reasons.push('同口径样本跨度不足14天');
    if (valid.filter(row => row.status === 'control').length < 20) reasons.push('有效独立对照代币不足20个');
    if (!matured.length || valid.length / matured.length < 0.9) reasons.push('到期1小时覆盖率不足90%');
    if (cells.some(cell => cell.valid < 20 || cell.coverage < 0.9)) reasons.push('训练/留出及两侧分组样本或覆盖率不足');
    const controls = rows.filter(row => row.status === 'control');
    if (!controls.length || controls.filter(row => row.method === 'live' && row.state === 'ready').length / controls.length < 0.95)
      reasons.push('本版本及来源组的实时对照基准覆盖率不足95%');
    return { cohort, excludedFirstSamples: unique.length - eligible.length, uniqueTokens: unique.length, mature: matured.length, valid: valid.length, cutoff,
      ready: reasons.length === 0, reasons, cells };
  });
  const newControls = all.filter(row => row.status === 'control' && row.features !== null);
  const freshCoverage = newControls.length ? newControls.filter(row => row.method === 'live' && row.state === 'ready').length / newControls.length : 0;
  const gates = freshCoverage < 0.95 ? ['新对照实时基准价覆盖率不足95%'] : [];
  if (reports.length === 0) gates.push('没有符合质量与版本要求的实时可比样本');
  const ready = gates.length === 0 && reports.some(report => report.ready);
  return { parameter, threshold, ready, gates, freshBaselineCoverage: freshCoverage, cohorts: reports,
    conclusion: ready ? '仅允许查看预先指定参数的离线描述性比较；仍需成本模型及独立验证。' : '样本未达标，拒绝给出调参结论。',
    limitations: '同代币仅取首次记录；按时间70%/30%分组；不含手续费、滑点、成交容量；不是全市场反事实回放。' };
}
