import type { Db } from '../store/db.js';
import { getKv } from '../store/db.js';
import { gapStatus, QUALITY_VERSION, type SampleFeatures } from './features.js';
import { validPrice } from './quality.js';

export interface Measurement {
  id: number; token: string; status: string; anchor: number; price: string | null;
  outcome_5m: number | null; outcome_1h: number | null; outcome_24h: number | null;
  method: string; state: string; config_version: string | null; rules_version: string | null;
  features: SampleFeatures | null;
}
export function measurements(db: Db): Measurement[] {
  const rows = db.prepare(`SELECT s.id,s.token,s.status,COALESCE(sent_at,triggered_at) anchor,
    COALESCE(price_at_send,price_at_trigger) price,outcome_5m,outcome_1h,outcome_24h,
    COALESCE(q.method,'legacy') method,COALESCE(q.state,'unknown') state,q.config_version,q.rules_version,q.features
    FROM signals s LEFT JOIN sample_quality q ON q.signal_id=s.id AND q.anchor_ts=COALESCE(sent_at,triggered_at)
      AND q.anchor_price IS COALESCE(price_at_send,price_at_trigger)
    WHERE s.status IN ('pushed','control','invalidated','blocked_price','expired')`).all() as Array<Omit<Measurement, 'features'> & { features: string | null }>;
  return rows.map(row => {
    let features: SampleFeatures | null = null;
    try { const parsed = JSON.parse(row.features ?? 'null') as SampleFeatures | null;
      if (parsed?.qualityVersion === QUALITY_VERSION) features = parsed;
    } catch { /* Unknown stays unknown. */ }
    return { ...row, features };
  });
}
export function comparable(db: Db, row: Measurement): boolean {
  return row.method === 'live' && row.state === 'ready' && validPrice(row.price)
    && row.config_version !== null && row.rules_version !== null && row.features?.eligible === true
    && gapStatus(db, row.features.windowStart, row.anchor) === 'clean';
}
const horizons = [ ['outcome_5m', 300], ['outcome_1h', 3600], ['outcome_24h', 86400] ] as const;
export function qualityOverview(db: Db, now = Math.floor(Date.now() / 1000)) {
  const rows = measurements(db);
  return ['pushed', 'control', 'intercepted'].map(group => {
    const selected = rows.filter(row => group === 'intercepted'
      ? !['pushed', 'control'].includes(row.status) : row.status === group);
    const cohorts = ['live', 'historical', 'legacy', 'pending'].map(method => {
      const subset = selected.filter(row => row.method === method);
      return { method, total: subset.length, horizons: horizons.map(([field, seconds]) => {
        const mature = subset.filter(row => row.anchor + seconds <= now);
        const valid = mature.filter(row => validPrice(row.price) && row[field] !== null && Number.isFinite(row[field]));
        const missingBaseline = mature.filter(row => !validPrice(row.price));
        const withoutOutcome = mature.filter(row => validPrice(row.price) && row[field] === null);
        const exhausted = withoutOutcome.filter(row => getKv(db, `backtest_giveup:${row.id}:${field}`) === true).length;
        const missingMarket = withoutOutcome.filter(row => {
          const record = db.prepare(`SELECT state FROM outcome_quality WHERE signal_id=? AND horizon=? AND anchor_ts=? AND anchor_price=?`)
            .get(row.id, field, row.anchor, row.price) as { state: string } | undefined;
          return record?.state === 'no_market' || record?.state === 'exhausted';
        }).length;
        return { field, mature: mature.length, immature: subset.length - mature.length, valid: valid.length,
          uniqueTokens: new Set(valid.map(row => row.token)).size,
          missingBaseline: missingBaseline.length,
          baselineExhausted: missingBaseline.filter(row => row.state === 'exhausted').length,
          missingMarket, waiting: withoutOutcome.length - exhausted, exhausted,
          coverage: mature.length ? valid.length / mature.length : null };
      }) };
    });
    return { group, total: selected.length, uniqueTokens: new Set(selected.map(row => row.token)).size, cohorts };
  });
}
export function qualityReportLines(db: Db, now = Math.floor(Date.now() / 1000)): string[] {
  const groupNames: Record<string, string> = { pushed: '推送', control: '对照', intercepted: '拦截' };
  const methodNames: Record<string, string> = { live: '实时', historical: '历史重建', legacy: '旧版未知', pending: '待补基准' };
  const lines = ['🧪 数据质量（覆盖率分母仅含已到期样本）'];
  for (const group of qualityOverview(db, now)) {
    lines.push(`${groupNames[group.group]}：${group.total} 条 / ${group.uniqueTokens} 个代币`);
    for (const cohort of group.cohorts.filter(c => c.total > 0)) {
      lines.push(`· ${methodNames[cohort.method]} ${cohort.total} 条`);
      for (const [i, h] of cohort.horizons.entries()) {
        lines.push(`  ${['5分钟','1小时','24小时'][i]}：到期 ${h.mature} / 未到期 ${h.immature} / 有效 ${h.valid}（${h.uniqueTokens}币）/ 覆盖 ${h.coverage === null ? '—' : (h.coverage * 100).toFixed(0) + '%'}`);
        if (h.mature !== h.valid) lines.push(`  缺基准 ${h.missingBaseline}（耗尽 ${h.baselineExhausted}）/ 缺行情 ${h.missingMarket} / 待评估或重试 ${h.waiting} / 行情重试耗尽 ${h.exhausted}`);
      }
    }
  }
  lines.push('缺行情与待重试/耗尽有重叠；旧版、历史重建与实时样本不混合验证参数。');
  return lines;
}
