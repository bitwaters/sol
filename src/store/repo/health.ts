import type { Db } from '../db.js';
import { deleteKv, getKv, setKv } from '../db.js';

export interface SourceHealth {
  source: string;
  last_success_at: number | null;
  watermark_ts: number | null;
  gap_from_ts: number | null;
  gap_to_ts: number | null;
  backfill_cursor: string | null;
  updated_at: number | null;
}

export function getSourceHealth(db: Db, source: string): SourceHealth {
  const row = db.prepare('SELECT * FROM source_health WHERE source = ?').get(source) as
    | SourceHealth
    | undefined;
  return (
    row ?? {
      source,
      last_success_at: null,
      watermark_ts: null,
      gap_from_ts: null,
      gap_to_ts: null,
      backfill_cursor: null,
      updated_at: null,
    }
  );
}

export function upsertSourceHealth(
  db: Db,
  patch: Partial<SourceHealth> & { source: string },
  now = Math.floor(Date.now() / 1000),
): void {
  db.transaction(() => {
    const current = getSourceHealth(db, patch.source);
    const next: SourceHealth = {
      ...current,
      ...patch,
      source: patch.source,
      updated_at: now,
    };
    db.prepare(
      `INSERT INTO source_health (source, last_success_at, watermark_ts, gap_from_ts, gap_to_ts, backfill_cursor, updated_at)
       VALUES (@source, @last_success_at, @watermark_ts, @gap_from_ts, @gap_to_ts, @backfill_cursor, @updated_at)
       ON CONFLICT(source) DO UPDATE SET
         last_success_at = excluded.last_success_at,
         watermark_ts = excluded.watermark_ts,
         gap_from_ts = excluded.gap_from_ts,
         gap_to_ts = excluded.gap_to_ts,
         backfill_cursor = excluded.backfill_cursor,
         updated_at = excluded.updated_at`,
    ).run(next);
    const gapKey = `gap_since:${patch.source}`;
    if (next.gap_from_ts !== null && next.gap_to_ts !== null) {
      db.prepare(`INSERT INTO data_gaps(source,from_ts,to_ts,opened_at,state) VALUES (?,?,?,?,'open')
        ON CONFLICT(source) WHERE state='open' DO UPDATE SET
        from_ts=MIN(from_ts,excluded.from_ts),to_ts=MAX(to_ts,excluded.to_ts)`)
        .run(patch.source, next.gap_from_ts, next.gap_to_ts, now);
      // 立即撤销所有在持仓周期的完整性，不能等候选评估才传播缺口。
      const affected = db.prepare("SELECT DISTINCT wallet, token FROM wallet_positions WHERE state IN ('open','unknown','incomplete')")
        .all() as Array<{ wallet: string; token: string }>;
      for (const { wallet, token } of affected) {
        setKv(db, `gap_affected:${token}:${wallet}`, true, now);
        const key = `gap_affected_until:${token}:${wallet}`;
        setKv(db, key, Math.max(getKv<number>(db, key) ?? 0, next.gap_to_ts), now);
      }
      db.prepare("UPDATE wallet_positions SET cost_complete = 0, confidence = 0.3 WHERE state IN ('open','unknown','incomplete')").run();
      if (current.gap_from_ts === null || getKv(db, gapKey) === null) {
        setKv(db, gapKey, now, now);
      }
    } else {
      db.prepare("UPDATE data_gaps SET state='recovered',closed_at=? WHERE source=? AND state='open'").run(now, patch.source);
      deleteKv(db, gapKey);
    }
  })();
}
