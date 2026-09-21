import type { Db } from '../db.js';
import { deleteKv, getKv, setKv } from '../db.js';

export const SOURCE_STALE_SEC = 60;

export function staleSources(db: Db, now: number): Array<{source:string;from:number}> {
  const started = getKv<number>(db, 'service_started_at') ?? getKv<number>(db, 'observation_started_at') ?? now;
  return (getKv<string[]>(db, 'enabled_sources') ?? []).flatMap(source => {
    const from = getSourceHealth(db, source).last_success_at ?? started;
    return now - from > SOURCE_STALE_SEC ? [{ source, from }] : [];
  });
}
/** Bulk revoke once at onset/recovery; incoming trades carry the live outage boundary themselves. */
function invalidateCosts(db: Db, until: number, now: number): void {
  if (getKv(db,'deferred_ingest') === true) {
    db.prepare(`INSERT INTO cost_invalidation_job(id,until_ts,created_at) VALUES (1,?,?)
      ON CONFLICT(id) DO UPDATE SET phase=CASE WHEN excluded.until_ts>until_ts THEN 0 ELSE phase END, cursor=CASE WHEN excluded.until_ts>until_ts THEN 0 ELSE cursor END,
      until_ts=MAX(until_ts,excluded.until_ts)`).run(until,now);
    return;
  }
  const relevant = "state IN ('open','unknown','incomplete') AND (cycle_started_at IS NULL OR cycle_started_at<=?)";
  db.prepare(`INSERT INTO kv(key,value,updated_at)
    SELECT DISTINCT 'gap_affected:'||token||':'||wallet,'true',? FROM wallet_positions WHERE ${relevant}
    ON CONFLICT(key) DO UPDATE SET value='true',updated_at=excluded.updated_at WHERE kv.value!='true'`).run(now, until);
  db.prepare(`INSERT INTO kv(key,value,updated_at)
    SELECT DISTINCT 'gap_affected_until:'||token||':'||wallet,CAST(? AS TEXT),? FROM wallet_positions WHERE ${relevant}
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
      WHERE CAST(kv.value AS INTEGER)<CAST(excluded.value AS INTEGER)`)
    .run(until, now, until);
  db.prepare(`UPDATE wallet_positions SET cost_complete=0,confidence=0.3 WHERE ${relevant}
    AND (cost_complete!=0 OR confidence!=0.3)`).run(until);
}
function recordOutage(db: Db, source: string, from: number, now: number, recovered: boolean): boolean {
  const existing = db.prepare('SELECT 1 FROM source_outages WHERE source=? AND recovered_at IS NULL').get(source);
  db.prepare(`INSERT INTO source_outages(source,from_ts,to_ts) VALUES (?,?,?)
    ON CONFLICT(source) WHERE recovered_at IS NULL DO UPDATE SET from_ts=MIN(from_ts,excluded.from_ts),to_ts=MAX(to_ts,excluded.to_ts)`)
    .run(source, from, now);
  if (recovered) db.prepare('UPDATE source_outages SET recovered_at=? WHERE source=? AND recovered_at IS NULL').run(now, source);
  return !existing;
}
/** Called before polling starts and independently every 30s, even while a request is stuck. */
export function recordSourceOutages(db: Db, now: number): void {
  db.transaction(() => {
    let discovered = false;
    for (const row of staleSources(db, now)) discovered = recordOutage(db, row.source, row.from, now, false) || discovered;
    if (discovered) invalidateCosts(db, now, now);
  })();
}

export interface SourceHealth {
  source: string;
  head_ts: number | null;
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
      head_ts: null,
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
    if (patch.last_success_at != null && (getKv<string[]>(db, 'enabled_sources') ?? []).includes(patch.source)) {
      const from = current.last_success_at ?? getKv<number>(db, 'service_started_at') ?? now;
      const open = db.prepare('SELECT from_ts FROM source_outages WHERE source=? AND recovered_at IS NULL').get(patch.source) as {from_ts:number}|undefined;
      if (open || now - from > SOURCE_STALE_SEC) {
        recordOutage(db, patch.source, open?.from_ts ?? from, now, true);
        // Other stale sources still block every signal. Final recovery revokes through the complete interval once.
        if (!staleSources(db,now).some(s=>s.source!==patch.source)) invalidateCosts(db, now, now);
      }
    }
    const next: SourceHealth = {
      ...current,
      ...patch,
      source: patch.source,
      updated_at: now,
    };
    db.prepare(
      `INSERT INTO source_health (source, head_ts, last_success_at, watermark_ts, gap_from_ts, gap_to_ts, backfill_cursor, updated_at)
       VALUES (@source, @head_ts, @last_success_at, @watermark_ts, @gap_from_ts, @gap_to_ts, @backfill_cursor, @updated_at)
       ON CONFLICT(source) DO UPDATE SET
         head_ts = excluded.head_ts,
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
      // A heartbeat with the same gap must not re-scan/revoke thousands of positions.
      if(current.gap_from_ts===null||current.gap_to_ts===null||next.gap_from_ts<current.gap_from_ts||next.gap_to_ts>current.gap_to_ts){
        invalidateCosts(db, next.gap_to_ts, now);
      }
      if (current.gap_from_ts === null || getKv(db, gapKey) === null) {
        setKv(db, gapKey, now, now);
      }
    } else {
      db.prepare("UPDATE data_gaps SET state='recovered',closed_at=? WHERE source=? AND state='open'").run(now, patch.source);
      deleteKv(db, gapKey);
    }
  })();
}

/** Bounded revocation; the pending marker blocks eligibility until the final chunk commits. */
export function drainCostInvalidation(db: Db, limit=100): number {
  return db.transaction(()=>{
    const job=db.prepare('SELECT until_ts,cursor,phase FROM cost_invalidation_job WHERE id=1').get() as {until_ts:number;cursor:number;phase:number}|undefined;
    if(!job)return 0;
    // Walk rowids instead of scanning the full table on every chunk.
    const state=['open','unknown','incomplete'][job.phase]!;
    const rows=db.prepare('SELECT rowid rid,wallet,token,state,cycle_started_at FROM wallet_positions WHERE state=? AND rowid>? ORDER BY rowid LIMIT ?')
      .all(state,job.cursor,limit) as {rid:number;wallet:string;token:string;state:string;cycle_started_at:number|null}[];
    const now=Math.floor(Date.now()/1000);
    for(const row of rows){
      if(!['open','unknown','incomplete'].includes(row.state)||(row.cycle_started_at!==null&&row.cycle_started_at>job.until_ts))continue;
      setKv(db,`gap_affected:${row.token}:${row.wallet}`,true,now);
      const key=`gap_affected_until:${row.token}:${row.wallet}`;
      setKv(db,key,Math.max(getKv<number>(db,key)??0,job.until_ts),now);
      db.prepare('UPDATE wallet_positions SET cost_complete=0,confidence=0.3 WHERE rowid=?').run(row.rid);
    }
    if(rows.length<limit){
      if(job.phase===2)db.prepare('DELETE FROM cost_invalidation_job WHERE id=1').run();
      else db.prepare('UPDATE cost_invalidation_job SET phase=phase+1,cursor=0 WHERE id=1').run();
    }
    else db.prepare('UPDATE cost_invalidation_job SET cursor=? WHERE id=1').run(rows.at(-1)!.rid);
    return Math.max(1,rows.length);
  })();
}
