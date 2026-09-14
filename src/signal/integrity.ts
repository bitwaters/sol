import { deleteKv, getKv } from '../store/db.js';
import { getSourceHealth, upsertSourceHealth } from '../store/repo/health.js';
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
    deleteKv(db, `gap_since:${source}`);
    accepted.push({
      source,
      gapFrom: health.gap_from_ts,
      gapTo: health.gap_to_ts,
      updatedAt: health.updated_at ?? nowSec,
      ageSec,
    });
    upsertSourceHealth(
      db,
      {
        source,
        watermark_ts: Math.max(health.watermark_ts ?? 0, health.gap_to_ts),
        gap_from_ts: null,
        gap_to_ts: null,
      },
      nowSec,
    );
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
