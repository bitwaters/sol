/** Read-only operational snapshot. Never outputs addresses, credentials or raw API data. */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig, PROJECT_ROOT } from '../config.js';
import { getKv } from '../store/db.js';

const loaded = loadConfig();
const dbPath = join(PROJECT_ROOT, 'data', 'meme.sqlite');
if (!existsSync(dbPath)) {
  console.log(JSON.stringify({ ready: false, reason: 'database_not_created' }));
  process.exitCode = 1;
} else {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const now = Math.floor(Date.now() / 1000);
    const started = getKv<number>(db, 'service_started_at');
    const backupDir = join(PROJECT_ROOT, 'data', 'backups');
    console.log(JSON.stringify({
      ready: true,
      timestamp: now,
      rulesVersion: loaded.rulesVersion,
      configVersion: loaded.configVersion,
      dryRun: loaded.dryRun,
      ratePerSecond: loaded.env.GMGN_RATE_LIMIT_PER_SEC,
      runtimeMetrics: getKv(db, 'runtime_metrics'),
      acceptedGaps: ['smartmoney', 'kol', 'follow'].map(source => ({ source,
        count: getKv<number>(db, `accepted_gap_count:${source}`) ?? 0,
        last: getKv(db, `last_accepted_gap:${source}`) })),
      uptimeSeconds: started === null ? null : now - started,
      enabledSources: getKv<string[]>(db, 'enabled_sources'),
      sourceHealth: db.prepare(`SELECT source, ? - last_success_at AS last_success_age_seconds,
        watermark_ts, gap_from_ts, gap_to_ts FROM source_health ORDER BY source`).all(now),
      trades: db.prepare('SELECT COUNT(*) AS count FROM trades').get(),
      observations: db.prepare('SELECT source,COUNT(*) AS count FROM trade_sources GROUP BY source').all(),
      positions: db.prepare('SELECT state,cost_complete,COUNT(*) AS count FROM wallet_positions GROUP BY state,cost_complete').all(),
      signals: db.prepare('SELECT status,COUNT(*) AS count FROM signals GROUP BY status').all(),
      pushTasks: db.prepare('SELECT status,COUNT(*) AS count FROM push_tasks GROUP BY status').all(),
      evaluations: db.prepare('SELECT COUNT(*) AS count FROM signal_evaluations').get(),
      backups: existsSync(backupDir) ? readdirSync(backupDir).filter(name => name.endsWith('.sqlite')).length : 0,
      databaseCheck: db.pragma('quick_check', { simple: true }),
    }));
  } finally { db.close(); }
}
