// Consume Docker JSON logs on stdin; output allowlisted, aggregate-only evidence.
import { createInterface } from 'node:readline';
const sources = Object.fromEntries(['smartmoney', 'kol', 'follow'].map(source => [source,
  { batches: 0, inserted: 0, gapBatches: 0, firstAt: null, lastAt: null, maxIntervalMs: 0, lastWatermark: null, watermarkRegressions: 0 }]));
const totals = { errors: 0, limited: 0, starts: 0, paginationStalls: 0, ignoredLines: 0 };
let firstAt = null, lastAt = null, latestMetrics = null;
for await (const line of createInterface({ input: process.stdin })) {
  let row;
  try { row = JSON.parse(line); } catch { totals.ignoredLines++; continue; }
  const at = Date.parse(row.ts);
  if (!Number.isFinite(at)) { totals.ignoredLines++; continue; }
  firstAt ??= row.ts; lastAt = row.ts;
  if (row.level === 'error') totals.errors++;
  if (row.msg === 'GMGN 限频封禁') totals.limited++;
  if (row.msg === '配置加载完成') totals.starts++;
  if (row.msg?.includes('分页未前进')) totals.paginationStalls++;
  if (row.msg === '运行耗时汇总') latestMetrics = { timestamp: row.timestamp, metrics: row.metrics };
  if (row.msg !== '采集批次完成' || !Object.hasOwn(sources, row.source)) continue;
  const s = sources[row.source];
  s.batches++; s.inserted += Number.isFinite(row.insertedEvents) ? row.insertedEvents : 0;
  if (row.gapDetected) s.gapBatches++;
  if (s.lastAt !== null) s.maxIntervalMs = Math.max(s.maxIntervalMs, at - Date.parse(s.lastAt));
  s.firstAt ??= row.ts; s.lastAt = row.ts;
  if (Number.isFinite(row.watermarkTs)) {
    if (s.lastWatermark !== null && row.watermarkTs < s.lastWatermark) s.watermarkRegressions++;
    s.lastWatermark = row.watermarkTs;
  }
}
console.log(JSON.stringify({ firstAt, lastAt, spanSeconds: firstAt && lastAt ? (Date.parse(lastAt) - Date.parse(firstAt)) / 1000 : 0,
  totals, sources, latestMetrics }));
