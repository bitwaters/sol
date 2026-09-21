import { derivedPending } from '../store/derived-work.js';
import type { AppConfig } from '../config.js';
import { CACHE_TTL, getCachedToken, rowToSnapshot, type TokenSnapshot } from '../enrich/token.js';
import { getWalletProfile, WALLET_PROFILE_TTL_SEC, type CexBlacklist } from '../enrich/wallet.js';
import { buildClusters } from '../signal/cluster.js';
import { validateTokenSnapshot } from '../signal/validate-token.js';
import { validateWallets } from '../signal/validate-wallet.js';
import { computeWindow } from '../signal/window.js';
import { getKv, type Db } from '../store/db.js';
import { staleSources } from '../store/repo/health.js';

export const QUALITY_VERSION = 'measurement-2026-09-14.2';
export function fresh(timestamp: number | null | undefined, now: number, ttl: number): boolean {
  return timestamp != null && timestamp <= now && now - timestamp <= ttl;
}
export function gapStatus(db: Db, start: number, end: number): 'clean' | 'affected' | 'unknown' {
  // Conservatively exclude any source gap, even if recovered after this sample was selected.
  const gap = db.prepare('SELECT 1 FROM data_gaps WHERE from_ts<=? AND to_ts>=? LIMIT 1').get(end, start);
  if (gap) return 'affected';
  if (db.prepare('SELECT 1 FROM source_outages WHERE from_ts<=? AND to_ts>=? LIMIT 1').get(end,start)) return 'affected';
  if (staleSources(db,end).some(s=>s.from<=end)) return 'affected';
  const since = getKv<number>(db, 'quality_tracking_started_at');
  return since !== null && start >= since ? 'clean' : 'unknown';
}

/** Freeze the exact current window. Never call this to reconstruct historical features. */
export function captureFeatures(db: Db, config: AppConfig, blacklist: CexBlacklist, token: string, now: number,
  voteFloor = Math.max(config.signal.minDistinctWallets, config.signalValidation.minValidWallets), quote?: TokenSnapshot) {
  const makers = db.prepare(`SELECT DISTINCT maker FROM trades WHERE base_address=? AND side='buy'
    AND timestamp BETWEEN ? AND ? AND CAST(COALESCE(amount_usd,'0') AS REAL)>=?`)
    .all(token, now - config.signal.windowMinutes * 60, now, config.tradeFilter.minTradeAmountUsd) as Array<{ maker: string }>;
  const clusters = buildClusters(db, token, makers.map(row => row.maker), {
    blacklist, enabled: config.signal.clusterMerge, sameFunder: config.walletFilter.cluster.sameFunder,
    creationTimeDeltaMinutes: config.walletFilter.cluster.creationTimeDeltaMinutes,
    excludeFunderLabels: config.walletFilter.cluster.excludeFunderLabels,
  });
  const window = computeWindow(db, token, now, config, clusters);
  const analysisConfig = structuredClone(config);
  // Coupled floors only for counterfactual control eligibility. The live config stays unchanged.
  analysisConfig.signal.minDistinctWallets = voteFloor;
  analysisConfig.signalValidation.minValidWallets = voteFloor;
  const gap = gapStatus(db, window.windowStart, now);
  const wallets = validateWallets({ db, config: analysisConfig, window, clusters, hasRecentGap: gap !== 'clean', nowSec: now });
  const row = getCachedToken(db, token);
  const snapshot = quote ?? (row ? rowToSnapshot(row) : null);
  const tokenResult = snapshot ? validateTokenSnapshot({ db, config: analysisConfig, token, nowSec: now,
    validWallets: wallets.validWallets, gateway: {
      fetchTokenInfo: async () => { throw new Error('snapshot only'); },
      fetchTokenSecurity: async () => { throw new Error('snapshot only'); },
    } }, snapshot) : null;
  const profiles = window.votingWallets.map(wallet => getWalletProfile(db, wallet));
  const complete = !derivedPending(db,token) && snapshot !== null && fresh(snapshot.priceUpdatedAt, now, CACHE_TTL.price)
    && fresh(snapshot.riskUpdatedAt, now, CACHE_TTL.risk) && fresh(snapshot.basicUpdatedAt, now, CACHE_TTL.basic)
    && profiles.every(profile => profile && profile.walletCreatedAt !== null && fresh(profile.refreshedAt, now, WALLET_PROFILE_TTL_SEC));
  return {
    qualityVersion: QUALITY_VERSION, sampledAt: now, windowStart: window.windowStart, windowEnd: now,
    votes: window.votes, rawVotes: window.votes,
    validVotes: new Set(wallets.validWallets.map(wallet => clusters.clusterOf.get(wallet.wallet) ?? wallet.wallet)).size,
    analysisVoteFloor: voteFloor, sources: [...new Set(window.wallets.flatMap(wallet => wallet.sources))].sort(),
    netInflowUsd: window.netInflowUsd.toNumber(),
    holdingRatio: wallets.retentionRatio?.toNumber() ?? null,
    verifiableCount: wallets.verifiableCount, priceRatio: tokenResult?.priceRatio?.toNumber() ?? null,
    warn: tokenResult?.warn ?? null, tokenMetrics: snapshot,
    walletFilter: { status: wallets.status, reason: wallets.reason },
    tokenFilter: { status: tokenResult?.status ?? 'deferred', reason: tokenResult?.reason ?? 'snapshot_missing' },
    complete, gap,
    eligible: complete && gap === 'clean' && wallets.status === 'pass'
      && (tokenResult?.status === 'pass' || tokenResult?.status === 'warn'),
  };
}
export type SampleFeatures = ReturnType<typeof captureFeatures>;
