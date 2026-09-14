import { Decimal } from 'decimal.js';
import type { AppConfig } from '../config.js';
import { enrichToken, type EnrichGateway, type TokenSnapshot } from '../enrich/token.js';
import type { Logger } from '../logger.js';
import type { Db } from '../store/db.js';
import { getLatestCycle } from './positions.js';
import type { WalletWindowStat } from './window.js';

export type TokenStatus = 'pass' | 'warn' | 'invalidated' | 'blocked_price' | 'deferred';

export interface TokenValidationInput {
  db: Db;
  config: AppConfig;
  gateway: EnrichGateway;
  token: string;
  nowSec: number;
  validWallets: WalletWindowStat[];
  logger?: Logger;
}

export interface TokenValidationResult {
  status: TokenStatus;
  reason: string | null;
  snapshot: TokenSnapshot | null;
  priceRatio: Decimal | null;
  avgEntry: Decimal | null;
  warn: boolean;
}

interface Range {
  min: number | null;
  max: number | null;
}

function checkRange(value: number | null, range: Range, label: string): string | null {
  if (range.min === null && range.max === null) return null;
  if (value === null || !Number.isFinite(value)) return `${label}_missing`;
  if (range.min !== null && value < range.min) return `${label}_below_min`;
  if (range.max !== null && value > range.max) return `${label}_above_max`;
  return null;
}

/**
 * 代币层校验（M2-6，§7.4 步骤 9-11）：
 * 富化（失败退避重验）→ 硬过滤（缺失值决策表）→ 追高校验（周期∩窗口均价）
 */
export async function validateToken(input: TokenValidationInput): Promise<TokenValidationResult> {
  const { db, config, gateway, token, nowSec, validWallets, logger } = input;

  let snapshot: TokenSnapshot;
  try {
    snapshot = await enrichToken(db, gateway, token, { logger, now: () => nowSec * 1000 });
  } catch (err) {
    logger?.warn('富化失败', { token, error: err });
    try {
      snapshot = await enrichToken(db, gateway, token, { logger, force: true, now: () => nowSec * 1000 });
    } catch (err2) {
      logger?.warn('富化重试仍失败', { token, error: err2 });
      return {
        status: 'deferred',
        reason: 'suppressed_enrich_failed',
        snapshot: null,
        priceRatio: null,
        avgEntry: null,
        warn: false,
      };
    }
  }

  return validateTokenSnapshot(input, snapshot);
}

/** 富化后的同步判定，供最终窗口/持仓复核使用，避免沿用旧成员的成本均价。 */
export function validateTokenSnapshot(input: TokenValidationInput, snapshot: TokenSnapshot): TokenValidationResult {
  const { db, config, token, nowSec, validWallets } = input;
  const tf = config.tokenFilter;
  const ageMinutes =
    snapshot.createdAt !== null ? Math.floor((nowSec - snapshot.createdAt) / 60) : null;

  const checks: Array<[string, number | null, Range]> = [
    ['age', ageMinutes, tf.ageMinutes],
    ['market_cap', snapshot.marketCap, tf.marketCapUsd],
    ['holder_count', snapshot.holderCount, tf.holderCount],
    ['liquidity', snapshot.liquidity, tf.liquidityUsd],
  ];
  for (const [label, value, range] of checks) {
    const failure = checkRange(value, range, label);
    if (failure) return deferredOrInvalid(failure, snapshot, failure.endsWith('_missing'));
  }

  const hardChecks: Array<[string, number | null, number, boolean]> = [
    ['top10', snapshot.top10Rate, tf.maxTop10HolderRate, true],
    ['bundler', snapshot.bundlerRate, tf.maxBundlerRate, true],
    ['insider', snapshot.insiderRate, tf.maxInsiderRate, true],
    ['entrapment', snapshot.entrapmentRate, tf.maxEntrapmentRate, true],
    ['bot_degen', snapshot.botDegenRate, tf.maxBotDegenRate, true],
    ['fresh_wallet', snapshot.freshWalletRate, tf.maxFreshWalletRate, true],
    ['dev_hold', snapshot.devHoldRate, tf.maxDevTeamHoldRate, true],
    ['sniper_count', snapshot.sniperCount, tf.maxSniperCount, true],
  ];
  for (const [label, value, max, enabled] of hardChecks) {
    if (!enabled) continue;
    if (value === null || !Number.isFinite(value) || value < 0) return deferredOrInvalid(`${label}_missing`, snapshot, true);
    if (value > max) return deferredOrInvalid(`${label}_above_max`, snapshot, false);
  }

  if (tf.excludeHoneypot && snapshot.honeypot !== null && snapshot.honeypot !== 0) {
    return deferredOrInvalid('honeypot', snapshot, false);
  }
  if (tf.requireRenouncedMint) {
    if (snapshot.renouncedMint === null) return deferredOrInvalid('renounced_mint_missing', snapshot, true);
    if (!snapshot.renouncedMint) return deferredOrInvalid('mint_not_renounced', snapshot, true);
  }
  if (tf.requireRenouncedFreeze) {
    if (snapshot.renouncedFreeze === null)
      return deferredOrInvalid('renounced_freeze_missing', snapshot, true);
    if (!snapshot.renouncedFreeze) return deferredOrInvalid('freeze_not_renounced', snapshot, true);
  }
  if (tf.requireSocial && !snapshot.hasSocial) {
    return deferredOrInvalid('social_missing', snapshot, true);
  }

  // 追高校验：周期∩窗口均价（只取可核验钱包）
  let usdSum = new Decimal(0);
  let amountSum = new Decimal(0);
  for (const stat of validWallets) {
    const cycle = getLatestCycle(db, stat.wallet, token);
    if (!cycle || cycle.state !== 'open' || !cycle.costComplete) continue;
    for (const buy of stat.buys) {
      if (buy.qualifying === false || buy.amountUsd.lt(config.tradeFilter.minTradeAmountUsd)) continue;
      if (buy.amount === null) continue;
      // 周期 ∩ 窗口：窗口内属于已关闭旧周期的买入不参与均价
      if (cycle.cycleStartedAt !== null && buy.timestamp < cycle.cycleStartedAt) continue;
      usdSum = usdSum.plus(buy.amountUsd);
      amountSum = amountSum.plus(buy.amount);
    }
  }
  if (amountSum.lte(0) || usdSum.lte(0) || snapshot.price === null || !Number.isFinite(Number(snapshot.price)) || Number(snapshot.price) <= 0) {
    return {
      status: 'deferred',
      reason: 'avg_entry_unavailable',
      snapshot,
      priceRatio: null,
      avgEntry: null,
      warn: false,
    };
  }
  const avgEntry = usdSum.div(amountSum);
  const priceRatio = new Decimal(snapshot.price).div(avgEntry);
  if (priceRatio.gt(config.signalValidation.blockPriceAboveEntry)) {
    return {
      status: 'blocked_price',
      reason: `price_above_entry(${priceRatio.toFixed(2)}x)`,
      snapshot,
      priceRatio,
      avgEntry,
      warn: false,
    };
  }
  const warn = priceRatio.gt(config.signalValidation.warnPriceAboveEntry);
  return {
    status: warn ? 'warn' : 'pass',
    reason: warn ? `price_warn(${priceRatio.toFixed(2)}x)` : null,
    snapshot,
    priceRatio,
    avgEntry,
    warn,
  };
}

function deferredOrInvalid(
  reason: string,
  snapshot: TokenSnapshot,
  defer: boolean,
): TokenValidationResult {
  return {
    status: defer ? 'deferred' : 'invalidated',
    reason,
    snapshot,
    priceRatio: null,
    avgEntry: null,
    warn: false,
  };
}
