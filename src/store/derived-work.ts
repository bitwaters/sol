import type { Db } from './db.js';

/** Raw trades may be newer than their derived positions. Never evaluate that token meanwhile. */
export function positionsPending(db: Db, token: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM position_jobs WHERE token=? LIMIT 1').get(token));
}
export function costsPending(db: Db): boolean {
  return Boolean(db.prepare('SELECT 1 FROM cost_invalidation_job LIMIT 1').get());
}
export function derivedPending(db: Db, token: string): boolean {
  return costsPending(db) || positionsPending(db, token);
}
