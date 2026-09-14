import Database from 'better-sqlite3';
import { compareSamples, type ComparisonParameter } from '../backtest/compare.js';
import { qualityOverview } from '../backtest/quality-report.js';

const args = process.argv.slice(2);
const path = args[0];
const parameter = args[1] ?? 'validVotes';
const threshold = Number(args[2] ?? (parameter === 'marketCap' ? 50000 : parameter === 'ageMinutes' ? 60 : 3));
if (!path || !['validVotes', 'marketCap', 'ageMinutes'].includes(parameter) || args.length > 3) {
  throw new Error('Usage: node dist/ops/tuning-report.js DATABASE [validVotes|marketCap|ageMinutes] [threshold]');
}
const db = new Database(path, { readonly: true, fileMustExist: true });
try {
  const report = db.transaction(() => ({ generatedAt: new Date().toISOString(), quality: qualityOverview(db),
    comparison: compareSamples(db, parameter as ComparisonParameter, threshold) }))();
  console.log(JSON.stringify(report, null, 2));
} finally { db.close(); }
