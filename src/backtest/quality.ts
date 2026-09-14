import type { Db } from '../store/db.js';
import { deleteKv } from '../store/db.js';
import type { SampleFeatures } from './features.js';

export interface QualityRow {
  signal_id: number; anchor_ts: number; anchor_price: string | null; selection_ts: number;
  price_ts: number | null; captured_at: number; method: 'live' | 'historical' | 'legacy' | 'pending';
  state: 'ready' | 'pending' | 'exhausted'; config_version: string | null; rules_version: string | null;
  features: string | null; initial_features: string | null; attempts: number; next_retry_at: number; last_error: string | null;
}
export const HORIZONS = ['outcome_5m', 'outcome_1h', 'outcome_24h'] as const;
export function validPrice(value: string | number | null | undefined): boolean {
  return value != null && Number.isFinite(Number(value)) && Number(value) > 0;
}
export function getQuality(db: Db, id: number): QualityRow | undefined {
  return db.prepare('SELECT * FROM sample_quality WHERE signal_id=?').get(id) as QualityRow | undefined;
}

/** Legacy import and changed-anchor invalidation, idempotent and never inventing past metadata. */
export function syncQuality(db: Db, now: number): void {
  db.transaction(() => {
    db.prepare(`DELETE FROM sample_quality WHERE EXISTS (SELECT 1 FROM signals s WHERE s.id=signal_id
      AND (COALESCE(s.sent_at,s.triggered_at)<>anchor_ts OR COALESCE(s.price_at_send,s.price_at_trigger) IS NOT anchor_price))`).run();
    db.prepare(`DELETE FROM outcome_quality WHERE EXISTS (SELECT 1 FROM signals s WHERE s.id=signal_id
      AND (COALESCE(s.sent_at,s.triggered_at)<>anchor_ts OR COALESCE(s.price_at_send,s.price_at_trigger) IS NOT anchor_price))`).run();
    db.prepare(`INSERT OR IGNORE INTO sample_quality
      (signal_id,anchor_ts,anchor_price,selection_ts,captured_at,method,state,config_version,rules_version,features)
      SELECT s.id,COALESCE(sent_at,triggered_at),COALESCE(price_at_send,price_at_trigger),COALESCE(sent_at,triggered_at),?,
        CASE WHEN CAST(COALESCE(price_at_send,price_at_trigger,'0') AS REAL)>0 THEN 'legacy' ELSE 'pending' END,
        CASE WHEN CAST(COALESCE(price_at_send,price_at_trigger,'0') AS REAL)>0 THEN 'ready' ELSE 'pending' END,
        (SELECT config_version FROM signal_evaluations e WHERE e.signal_id=s.id AND e.evaluated_at<=COALESCE(s.sent_at,s.triggered_at) ORDER BY e.evaluated_at DESC,e.id DESC LIMIT 1),
        (SELECT rules_version FROM signal_evaluations e WHERE e.signal_id=s.id AND e.evaluated_at<=COALESCE(s.sent_at,s.triggered_at) ORDER BY e.evaluated_at DESC,e.id DESC LIMIT 1),
        COALESCE(send_snapshot,snapshot)
      FROM signals s WHERE status IN ('pushed','control','invalidated','blocked_price','expired')`).run(now);
    // SQLite CAST accepts numeric prefixes (e.g. '1bad'); JavaScript validation matches evaluation.
    const ready = db.prepare("SELECT signal_id,anchor_price FROM sample_quality WHERE state='ready'").all() as Array<{ signal_id: number; anchor_price: string | null }>;
    for (const row of ready) if (!validPrice(row.anchor_price)) {
      db.prepare("UPDATE sample_quality SET state='pending',method='pending',price_ts=NULL WHERE signal_id=?").run(row.signal_id);
    }
  })();
}
export function saveLiveQuality(db: Db, id: number, anchor: number, price: string | null, priceTs: number | null,
  features: SampleFeatures, configVersion: string | null, rulesVersion: string | null, now: number): void {
  db.prepare(`INSERT OR REPLACE INTO sample_quality
    (signal_id,anchor_ts,anchor_price,selection_ts,price_ts,captured_at,method,state,config_version,rules_version,features,initial_features)
    VALUES (?,?,?,?,?,?,?, ?,?,?,?,?)`).run(id, anchor, price, features.sampledAt, priceTs, now,
      price === null ? 'pending' : 'live', price === null ? 'pending' : 'ready', configVersion, rulesVersion,
      JSON.stringify(features), JSON.stringify(features));
}
export function resetMissingBaselineOutcomes(db: Db, id: number): void {
  // Called only on an invalid -> valid baseline transition. No valid-price market failures are reset.
  for (const field of HORIZONS) {
    deleteKv(db, `backtest_next_retry:${id}:${field}`);
    deleteKv(db, `backtest_attempts:${id}:${field}`);
    deleteKv(db, `backtest_giveup:${id}:${field}`);
  }
  db.prepare('DELETE FROM outcome_quality WHERE signal_id=?').run(id);
}
