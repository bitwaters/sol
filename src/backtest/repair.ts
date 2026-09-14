import type { AppConfig } from '../config.js';
import { CACHE_TTL, enrichToken, type EnrichGateway } from '../enrich/token.js';
import type { CexBlacklist } from '../enrich/wallet.js';
import { BackgroundBusyError } from '../ingest/gateway.js';
import type { Logger } from '../logger.js';
import type { Db } from '../store/db.js';
import { asCandles, pickCompletedCandle, type KlineGateway } from './evaluate.js';
import { captureFeatures, fresh, QUALITY_VERSION, type SampleFeatures } from './features.js';
import { resetMissingBaselineOutcomes, syncQuality, validPrice, type QualityRow } from './quality.js';

interface RepairDeps {
  db: Db; config: AppConfig; gateway: KlineGateway & EnrichGateway; blacklist: CexBlacklist; logger: Logger;
  configVersion: string; rulesVersion: string; now?: () => number; maxPerRun?: number;
}
const running = new WeakSet<Db>();
export async function repairBaselines(deps: RepairDeps) {
  const result = { repaired: 0, live: 0, historical: 0, missing: 0, deferred: 0 };
  if (running.has(deps.db)) return result;
  const { db, gateway } = deps;
  const now = () => Math.floor((deps.now?.() ?? Date.now()) / 1000);
  running.add(db);
  try {
    syncQuality(db, now());
    const rows = db.prepare(`SELECT q.*,s.token,s.status FROM sample_quality q JOIN signals s ON s.id=q.signal_id
      WHERE q.state='pending' AND q.next_retry_at<=?
        AND s.status IN ('pushed','control','invalidated','blocked_price','expired')
      ORDER BY CASE WHEN q.selection_ts>=? AND q.method='pending' THEN 0 ELSE 1 END,q.next_retry_at,q.signal_id LIMIT ?`)
      .all(now(), now() - 120, deps.maxPerRun ?? 4) as Array<QualityRow & { token: string; status: string }>;
    for (const row of rows) {
      const current = () => db.prepare(`SELECT 1 FROM signals s JOIN sample_quality q ON q.signal_id=s.id
        WHERE s.id=? AND COALESCE(s.sent_at,s.triggered_at)=? AND COALESCE(s.price_at_send,s.price_at_trigger) IS ?
          AND q.state='pending' AND q.anchor_ts=? AND q.anchor_price IS ?`)
        .get(row.signal_id, row.anchor_ts, row.anchor_price, row.anchor_ts, row.anchor_price);
      if (!current()) continue;
      try {
        let features: SampleFeatures | null = null;
        try { features = row.features ? JSON.parse(row.features) as SampleFeatures : null; } catch { /* legacy */ }
        let method: 'live' | 'historical' = 'historical';
        let price: string | null = null;
        let priceTs: number | null = null;
        let anchor = row.anchor_ts;
        // Only newly reserved controls may move their baseline; recompute their window and filters together.
        if (row.status === 'control' && features?.qualityVersion === QUALITY_VERSION
          && row.config_version === deps.configVersion && row.rules_version === deps.rulesVersion
          && now() >= row.selection_ts && now() - row.selection_ts <= 120) {
          const quote = await enrichToken(db, gateway, row.token, { now: deps.now, logger: deps.logger, persist: false });
          if (!current()) continue;
          const captured = now();
          const nextFeatures = captureFeatures(db, deps.config, deps.blacklist, row.token, captured, features.analysisVoteFloor, quote);
          if (captured - row.selection_ts <= 120 && nextFeatures.rawVotes === features.analysisVoteFloor
            && validPrice(quote.price) && fresh(quote.priceUpdatedAt, captured, CACHE_TTL.price)) {
            method = 'live'; price = quote.price; priceTs = quote.priceUpdatedAt; anchor = captured;
            features = nextFeatures;
          }
        }
        if (price === null) {
          const raw = await gateway.fetchKline(row.token, '1m', row.anchor_ts * 1000 - 10 * 60_000, row.anchor_ts * 1000);
          if (!current()) continue;
          const candle = pickCompletedCandle(asCandles(raw), row.anchor_ts * 1000, 60_000, 120_000);
          if (candle && validPrice(candle.close)) {
            price = String(candle.close); priceTs = (candle.timeMs + 60_000) / 1000;
          }
        }
        if (!current()) continue;
        if (price === null || priceTs === null) {
          db.prepare(`UPDATE sample_quality SET attempts=attempts+1,state=CASE WHEN attempts+1>=3 THEN 'exhausted' ELSE 'pending' END,
            next_retry_at=?,last_error='no_completed_baseline_candle' WHERE signal_id=?`).run(now() + 300, row.signal_id);
          result.missing++;
          continue;
        }
        db.transaction(() => {
          // All outcomes are invalid for the previous missing/invalid baseline.
          db.prepare(`UPDATE signals SET price_at_trigger=CASE WHEN sent_at IS NULL THEN ? ELSE price_at_trigger END,
            price_at_send=CASE WHEN sent_at IS NOT NULL THEN ? ELSE price_at_send END,
            triggered_at=CASE WHEN sent_at IS NULL THEN ? ELSE triggered_at END,
            window_start=CASE WHEN ?='live' THEN ? ELSE window_start END,
            window_end=CASE WHEN ?='live' THEN ? ELSE window_end END,
            snapshot=CASE WHEN ?='live' THEN ? ELSE snapshot END,
            wallet_count=CASE WHEN ?='live' THEN ? ELSE wallet_count END,
            net_inflow_usd=CASE WHEN ?='live' THEN ? ELSE net_inflow_usd END,
            outcome_5m=NULL,outcome_1h=NULL,outcome_24h=NULL WHERE id=?`)
            .run(price, price, anchor, method, features?.windowStart ?? null, method, anchor,
              method, JSON.stringify({ control: true, ...features }), method, features?.rawVotes ?? null,
              method, features?.netInflowUsd ?? null, row.signal_id);
          db.prepare(`UPDATE sample_quality SET anchor_ts=?,anchor_price=?,price_ts=?,captured_at=?,method=?,state='ready',
            features=?,last_error=NULL,next_retry_at=0 WHERE signal_id=?`)
            .run(anchor, price, priceTs, now(), method, JSON.stringify(features), row.signal_id);
          db.prepare(`INSERT INTO baseline_repairs(signal_id,repaired_at,old_anchor_ts,new_anchor_ts,price,price_ts,method,deviation_sec)
            VALUES (?,?,?,?,?,?,?,?)`).run(row.signal_id, now(), row.anchor_ts, anchor, price, priceTs, method, anchor - priceTs);
          resetMissingBaselineOutcomes(db, row.signal_id);
        })();
        result.repaired++; result[method]++;
      } catch (error) {
        if (!current()) continue;
        const busy = error instanceof BackgroundBusyError;
        db.prepare('UPDATE sample_quality SET next_retry_at=?,last_error=? WHERE signal_id=?')
          .run(now() + (busy ? 5 : 300), busy ? 'background_busy' : 'request_error', row.signal_id);
        result.deferred++;
        if (busy) break;
        deps.logger.warn('基准价补齐请求失败，保留重试', { signalId: row.signal_id, error });
      }
    }
  } finally { running.delete(db); }
  if (result.repaired || result.missing) deps.logger.info('基准价修复批次完成', result);
  return result;
}
