import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const SCHEMA_PATH = fileURLToPath(new URL('./schema.sql', import.meta.url));

export type Db = Database.Database;

export interface OpenDatabaseOptions {
  /** 文件路径或 ':memory:' */
  path: string;
  /** 打印 SQL（调试用） */
  verbose?: boolean;
}

export function applySchema(db: Db): void {
  const sql = readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(sql);
  // CREATE TABLE IF NOT EXISTS 不会升级已存在的表；新增字段允许旧记录为空。
  db.transaction(() => {
    for (const [table, columns] of Object.entries({
      signals: { send_snapshot: 'TEXT', display_wallets: 'TEXT' },
      position_checkpoints: { cycle_started_at: 'INTEGER', last_buy_ts: 'INTEGER', last_sell_ts: 'INTEGER' },
      signal_wallets: { joined_at: 'INTEGER', joined_event_id: 'TEXT', active: 'INTEGER NOT NULL DEFAULT 1' },
    })) {
      const existing = new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name),
      );
      for (const [column, type] of Object.entries(columns)) {
        if (!existing.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      }
    }
    // Idempotent provenance start; older history cannot be declared gap-free.
    const started = getKv<number>(db, 'quality_tracking_started_at');
    if (started === null) {
      const now = Math.floor(Date.now() / 1000);
      setKv(db, 'quality_tracking_started_at', now, now);
      for (const source of ['smartmoney', 'kol', 'follow']) {
        const gap = getKv<{ from: number; to: number; acceptedAt: number }>(db, `last_accepted_gap:${source}`);
        if (gap && Number.isFinite(gap.from) && Number.isFinite(gap.to)) {
          db.prepare("INSERT INTO data_gaps(source,from_ts,to_ts,opened_at,closed_at,state) VALUES (?,?,?,?,?,'accepted')")
            .run(source, gap.from, gap.to, gap.acceptedAt, gap.acceptedAt);
        }
      }
    }
    db.prepare(`INSERT OR IGNORE INTO data_gaps(source,from_ts,to_ts,opened_at,state)
      SELECT source,gap_from_ts,gap_to_ts,COALESCE(updated_at,unixepoch()),'open'
      FROM source_health WHERE gap_from_ts IS NOT NULL AND gap_to_ts IS NOT NULL`).run();
  })();
}

export function openDatabase(options: OpenDatabaseOptions): Db {
  const db = new Database(options.path, options.verbose ? { verbose: console.log } : undefined);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  applySchema(db);
  return db;
}

export function getKv<T = unknown>(db: Db, key: string): T | null {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export function deleteKv(db: Db, key: string): void {
  db.prepare('DELETE FROM kv WHERE key = ?').run(key);
}

export function setKv(db: Db, key: string, value: unknown, now = Math.floor(Date.now() / 1000)): void {
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), now);
}
