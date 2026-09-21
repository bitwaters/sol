import { getKv, setKv } from '../store/db.js';
import { getSourceHealth, staleSources, upsertSourceHealth } from '../store/repo/health.js';
import type { Db } from '../store/db.js';

/** 缺口阻塞窗口：超过该时长的缺口按"不可观测"接受（§5.2） */
export const GAP_BLOCK_WINDOW_SEC = 600;

export interface GapInfo {
  source: string;
  gapFrom: number;
  gapTo: number;
  updatedAt: number;
  ageSec: number;
}

export interface IntegrityResult {
  blocked: boolean;
  recentGaps: GapInfo[];
  acceptedGaps: GapInfo[];
}

/** 把过期缺口按不可观测接受：推进水位到缺口末端并清除 */
export function resolveStaleGaps(
  db: Db,
  nowSec: number,
  maxAgeSec = GAP_BLOCK_WINDOW_SEC,
): GapInfo[] {
  const sources = ['smartmoney', 'kol', 'follow'];
  const accepted: GapInfo[] = [];
  for (const source of sources) {
    const health = getSourceHealth(db, source);
    if (health.gap_from_ts === null || health.gap_to_ts === null) continue;
    const since = getKv<number>(db, `gap_since:${source}`) ?? health.updated_at ?? nowSec;
    const ageSec = nowSec - since;
    if (ageSec <= maxAgeSec) continue;
    // After accepting lost history, resume at the newest event already observed.
    // Using only the oldest overlapping row makes the next latest-100 page reopen
    // the same gap forever as that row rolls out of the page.
    const newest = db.prepare(`SELECT MAX(t.timestamp) AS ts FROM trades t
      JOIN trade_sources s ON s.event_id=t.event_id WHERE s.source=? AND t.timestamp<=?`)
      .get(source, nowSec) as { ts: number | null };
    const resumeAt = Math.max(health.watermark_ts ?? 0, health.head_ts??0,health.gap_to_ts, newest.ts ?? 0);
    accepted.push({
      source,
      gapFrom: health.gap_from_ts,
      gapTo: health.gap_to_ts,
      updatedAt: health.updated_at ?? nowSec,
      ageSec,
    });
    db.transaction(() => {
      // Retain the actual lost interval; resuming at the latest head does not make the intervening pages missing.
      setKv(db, `last_accepted_gap:${source}`, { from: health.gap_from_ts, to: health.gap_to_ts,
        acceptedAt: nowSec, recovered: false }, nowSec);
      setKv(db, `accepted_gap_count:${source}`, (getKv<number>(db, `accepted_gap_count:${source}`) ?? 0) + 1, nowSec);
      db.prepare("UPDATE data_gaps SET state='accepted',closed_at=? WHERE source=? AND state='open'").run(nowSec, source);
      upsertSourceHealth(db, { source, watermark_ts: resumeAt, head_ts:resumeAt,gap_from_ts: null,
        gap_to_ts: null, backfill_cursor: null }, nowSec);
    })();
  }
  return accepted;
}

/** 数据完整性门禁：近期缺口未修复 → 阻塞信号 */
export function checkIntegrity(
  db: Db,
  sources: string[],
  nowSec: number,
  maxAgeSec = GAP_BLOCK_WINDOW_SEC,
): IntegrityResult {
  const recentGaps: GapInfo[] = [];
  // A source that has stopped cannot age out of the safety gate after ten minutes.
  for (const row of staleSources(db, nowSec)) recentGaps.push({ source: row.source, gapFrom: row.from,
    gapTo: nowSec, updatedAt: nowSec, ageSec: nowSec - row.from });
  const acceptedGaps: GapInfo[] = [];
  for (const source of [...new Set(sources)]) {
    const health = getSourceHealth(db, source);
    if (health.gap_from_ts === null || health.gap_to_ts === null) continue;
    const since = getKv<number>(db, `gap_since:${source}`) ?? health.updated_at ?? nowSec;
    const ageSec = nowSec - since;
    const info: GapInfo = {
      source,
      gapFrom: health.gap_from_ts,
      gapTo: health.gap_to_ts,
      updatedAt: health.updated_at ?? nowSec,
      ageSec,
    };
    if (ageSec <= maxAgeSec) recentGaps.push(info);
    else acceptedGaps.push(info);
  }
  return { blocked: recentGaps.length > 0, recentGaps, acceptedGaps };
}
