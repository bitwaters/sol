import { Decimal } from 'decimal.js';
import type { AppConfig } from '../config.js';
import { getWalletProfile } from '../enrich/wallet.js';
import type { Db } from '../store/db.js';
import type { ClusterResult } from './cluster.js';
import { getLatestCycle } from './positions.js';
import type { WalletWindowStat, WindowMetrics } from './window.js';

export type WalletStatus = 'pass' | 'invalidated' | 'deferred';

export interface WalletValidationInput {
  db: Db;
  config: AppConfig;
  window: WindowMetrics;
  clusters: ClusterResult;
  hasRecentGap: boolean;
  nowSec: number;
}

export interface WalletValidationResult {
  status: WalletStatus;
  reason: string | null;
  validWallets: WalletWindowStat[];
  retentionRatio: Decimal | null;
  verifiableCount: number;
  openActionCount: number;
  smartMoneyVotes: number;
}

/**
 * 钱包层校验（M2-5，§7.4 步骤 1-8）：
 * 快进快出/清仓/画像过滤 → 有效票 → 建仓要求 → 聪明钱要求 → 净流入 → 可核验门槛+保留率
 */
export function validateWallets(input: WalletValidationInput): WalletValidationResult {
  const { db, config, window: win, clusters, nowSec } = input;
  const valid: WalletWindowStat[] = [];
  const excludeTags = new Set(config.walletFilter.excludeTags);
  const fastFlipSec = config.signalValidation.fastFlipMinutes * 60;
  const minWalletAgeDays = config.walletFilter.minWalletAgeDays;

  for (const stat of win.wallets) {
    if (!stat.qualifyingBuyUsd.gt(0)) continue; // 无合格买入不参与计票

    const cycle = getLatestCycle(db, stat.wallet, win.token);

    // 步骤 2：已清仓
    if (cycle?.state === 'closed') continue;

    // 步骤 1：快进快出
    if (
      cycle &&
      cycle.cycleStartedAt !== null &&
      cycle.lastSellTs !== null &&
      cycle.boughtAmount.gt(0) &&
      cycle.lastSellTs - cycle.cycleStartedAt <= fastFlipSec &&
      cycle.soldAmount.div(cycle.boughtAmount).gte(config.signalValidation.fastFlipSellRatio)
    ) {
      continue;
    }

    // 步骤 3：画像与钱包过滤
    const profile = getWalletProfile(db, stat.wallet);
    if (!profile || profile.walletCreatedAt === null) continue; // 画像缺失不能凑有效票
    if (profile.tags.some((tag) => excludeTags.has(tag))) continue;
    if (nowSec - profile.walletCreatedAt < minWalletAgeDays * 86_400) continue;

    const observed = db.prepare("SELECT COUNT(*) AS n FROM trades WHERE maker = ? AND side = 'buy' AND timestamp <= ?").get(stat.wallet, nowSec) as { n: number };
    if (observed.n < config.walletFilter.minObservedBuys) continue;
    valid.push({ ...stat, tags: profile.tags });
  }

  const votes = new Set(valid.map((s) => clusters.clusterOf.get(s.wallet) ?? s.wallet)).size;
  if (votes < Math.max(config.signal.minDistinctWallets, config.signalValidation.minValidWallets)) {
    return {
      status: 'invalidated',
      reason: `votes_below_min(${votes})`,
      validWallets: valid,
      retentionRatio: null,
      verifiableCount: 0,
      openActionCount: 0,
      smartMoneyVotes: 0,
    };
  }

  if (config.tradeFilter.walletCount.max !== null && votes > config.tradeFilter.walletCount.max) {
    return { status: 'invalidated', reason: 'wallet_count_above_max', validWallets: valid,
      retentionRatio: null, verifiableCount: 0, openActionCount: 0, smartMoneyVotes: 0 };
  }
  if (config.tradeFilter.netInflowUsd.max !== null && win.netInflowUsd.gt(config.tradeFilter.netInflowUsd.max)) {
    return { status: 'invalidated', reason: 'net_inflow_above_max', validWallets: valid,
      retentionRatio: null, verifiableCount: 0, openActionCount: 0, smartMoneyVotes: 0 };
  }
  const openActionCount = valid.filter((s) => s.openInWindow).length;
  if (config.signal.requireOpenAction && openActionCount < 1) {
    return {
      status: 'invalidated',
      reason: 'require_open_action',
      validWallets: valid,
      retentionRatio: null,
      verifiableCount: 0,
      openActionCount,
      smartMoneyVotes: 0,
    };
  }

  const smartMoneyVotes = new Set(
    valid
      .filter((s) => s.tags.includes('smart_degen') || s.sources.includes('smartmoney'))
      .map((s) => clusters.clusterOf.get(s.wallet) ?? s.wallet),
  ).size;
  if (config.signal.requireAtLeastOneSmartMoney && smartMoneyVotes < 1) {
    return {
      status: 'invalidated',
      reason: 'require_smart_money',
      validWallets: valid,
      retentionRatio: null,
      verifiableCount: 0,
      openActionCount,
      smartMoneyVotes,
    };
  }

  if (config.tradeFilter.netInflowUsd.min !== null && win.netInflowUsd.lt(config.tradeFilter.netInflowUsd.min)) {
    return {
      status: 'invalidated',
      reason: 'net_inflow_below_min',
      validWallets: valid,
      retentionRatio: null,
      verifiableCount: 0,
      openActionCount,
      smartMoneyVotes,
    };
  }

  // 步骤 8：可核验门槛与保留率（只汇总 state=open 且 cost_complete=1 的钱包）
  let verifiableBought = new Decimal(0);
  let verifiableRemaining = new Decimal(0);
  let verifiableCount = 0;
  for (const stat of valid) {
    const cycle = getLatestCycle(db, stat.wallet, win.token);
    if (!cycle || cycle.state !== 'open' || !cycle.costComplete) continue;
    verifiableCount += 1;
    verifiableBought = verifiableBought.plus(cycle.boughtAmount);
    verifiableRemaining = verifiableRemaining.plus(cycle.boughtAmount.minus(cycle.soldAmount));
  }

  if (verifiableCount < config.signalValidation.minVerifiableWallets) {
    return {
      status: 'deferred',
      reason: `verifiable_below_min(${verifiableCount})`,
      validWallets: valid,
      retentionRatio: null,
      verifiableCount,
      openActionCount,
      smartMoneyVotes,
    };
  }

  const retentionRatio = verifiableBought.gt(0)
    ? verifiableRemaining.div(verifiableBought)
    : null;
  if (
    retentionRatio !== null &&
    retentionRatio.lt(config.signalValidation.minConsensusHoldingRatio)
  ) {
    return {
      status: 'invalidated',
      reason: `holding_ratio_below_min(${retentionRatio.toFixed(4)})`,
      validWallets: valid,
      retentionRatio,
      verifiableCount,
      openActionCount,
      smartMoneyVotes,
    };
  }

  return {
    status: 'pass',
    reason: null,
    validWallets: valid,
    retentionRatio,
    verifiableCount,
    openActionCount,
    smartMoneyVotes,
  };
}
