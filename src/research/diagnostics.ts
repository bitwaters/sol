import { Decimal } from 'decimal.js';
import type { AppConfig } from '../config.js';
import { CACHE_TTL } from '../enrich/token.js';
import { getWalletProfile, WALLET_PROFILE_TTL_SEC } from '../enrich/wallet.js';
import { fresh, gapStatus } from '../backtest/features.js';
import { buildClusters } from '../signal/cluster.js';
import { computeWindow } from '../signal/window.js';
import { validateWallets } from '../signal/validate-wallet.js';
import { validateTokenSnapshot } from '../signal/validate-token.js';
import { getLatestCycle } from '../signal/positions.js';
import { restoreSnapshot, type FrozenSnapshot } from './snapshot.js';

export interface RuleCheck { label: string; value: number | boolean | null; min?: number | null; max?: number | null;
  status: 'pass' | 'fail' | 'unknown' | 'na'; }
export interface Diagnostics {
  checks: Record<string, RuleCheck>; wallets: { wallet: string; cluster: string; reasons: string[] }[];
  rawVotes: number; validVotes: number; warn: boolean; strong: boolean; sources: string[]; complete: boolean; eligible: boolean;
  productionStatus: string; productionReason: string | null;
}
export function diagnose(snapshot: FrozenSnapshot, config: AppConfig = snapshot.config): Diagnostics {
  if (config.signal.windowMinutes > snapshot.maxWindowMinutes) throw new Error('window_exceeds_snapshot');
  const db = restoreSnapshot(snapshot);
  try {
    const at = snapshot.at, token = snapshot.token, quote = snapshot.quote;
    const makers = db.prepare(`SELECT DISTINCT maker FROM trades WHERE base_address=? AND side='buy' AND timestamp BETWEEN ? AND ?
      AND CAST(COALESCE(amount_usd,'0') AS REAL)>=?`).all(token, at - config.signal.windowMinutes * 60, at, config.tradeFilter.minTradeAmountUsd) as { maker: string }[];
    const clusters = buildClusters(db, token, makers.map(m => m.maker), { blacklist: { entries: new Map(snapshot.blacklist.map(e => [e.address,e])) },
      enabled: config.signal.clusterMerge, ...config.walletFilter.cluster });
    const window = computeWindow(db, token, at, config, clusters);
    const gap = gapStatus(db, window.windowStart, at);
    const input = { db, config, window, clusters, nowSec: at, hasRecentGap: gap !== 'clean', observedBuys: snapshot.observedBuys };
    const original = validateWallets(input);
    // Only downstream aggregate checks are relaxed to compute metrics independently of an earlier failure.
    const relaxed = structuredClone(config);
    relaxed.signal.minDistinctWallets = 0; relaxed.signalValidation.minValidWallets = 0;
    relaxed.signal.requireOpenAction = false; relaxed.signal.requireAtLeastOneSmartMoney = false;
    relaxed.tradeFilter.walletCount.max = null; relaxed.tradeFilter.netInflowUsd = { min: null, max: null };
    relaxed.signalValidation.minVerifiableWallets = 0; relaxed.signalValidation.minConsensusHoldingRatio = 0;
    const wallets = validateWallets({ ...input, config: relaxed });
    const validVotes = new Set(wallets.validWallets.map(w => clusters.clusterOf.get(w.wallet) ?? w.wallet)).size;
    const checks: Record<string, RuleCheck> = {};
    const range = (key: string, label: string, value: number | null | undefined, min: number | null, max: number | null) => {
      const v = value == null || !Number.isFinite(value) ? null : value;
      checks[key] = { label, value: v, min, max, status: min === null && max === null ? 'na' : v === null ? 'unknown'
        : (min !== null && v < min) || (max !== null && v > max) ? 'fail' : 'pass' };
    };
    const flag = (key: string, label: string, value: boolean | null, enabled = true) => {
      checks[key] = { label, value, status: !enabled ? 'na' : value === null ? 'unknown' : value ? 'pass' : 'fail' };
    };
    range('rawVotes','原始聚类票数',window.votes,config.signal.minDistinctWallets,null);
    range('validVotes','有效票数',validVotes,config.signalValidation.minValidWallets,config.tradeFilter.walletCount.max);
    range('openCount','建仓钱包数',wallets.openActionCount,config.signal.requireOpenAction ? 1 : null,null);
    range('smartMoneyVotes','聪明钱有效票数',wallets.smartMoneyVotes,config.signal.requireAtLeastOneSmartMoney ? 1 : null,null);
    range('netInflow','净流入金额',window.netInflowUsd.toNumber(),config.tradeFilter.netInflowUsd.min,config.tradeFilter.netInflowUsd.max);
    range('verifiableCount','可核验钱包数',wallets.verifiableCount,config.signalValidation.minVerifiableWallets,null);
    range('holdingRatio','持仓保留率',wallets.retentionRatio?.toNumber(),config.signalValidation.minConsensusHoldingRatio,null);
    for (const [key,label,value,bounds] of [
      ['ageMinutes','代币年龄（分钟）',quote?.createdAt == null ? null : Math.floor((at - quote.createdAt)/60),config.tokenFilter.ageMinutes],
      ['marketCap','代币市值',quote?.marketCap,config.tokenFilter.marketCapUsd],
      ['holders','持有人数',quote?.holderCount,config.tokenFilter.holderCount],
      ['liquidity','流动性',quote?.liquidity,config.tokenFilter.liquidityUsd],
    ] as const) range(key,label,value,bounds.min,bounds.max);
    for (const [key,label,value,max] of [
      ['top10','前十持有人占比',quote?.top10Rate,config.tokenFilter.maxTop10HolderRate],
      ['bundler','捆绑交易占比',quote?.bundlerRate,config.tokenFilter.maxBundlerRate],
      ['insider','内部人占比',quote?.insiderRate,config.tokenFilter.maxInsiderRate],
      ['entrapment','诱捕占比',quote?.entrapmentRate,config.tokenFilter.maxEntrapmentRate],
      ['bot','机器人占比',quote?.botDegenRate,config.tokenFilter.maxBotDegenRate],
      ['freshWallet','新钱包占比',quote?.freshWalletRate,config.tokenFilter.maxFreshWalletRate],
      ['devHold','开发者持仓占比',quote?.devHoldRate,config.tokenFilter.maxDevTeamHoldRate],
      ['snipers','狙击钱包数',quote?.sniperCount,config.tokenFilter.maxSniperCount],
    ] as const) range(key,label,value == null || value < 0 ? null : value,0,max);
    // Preserve the actual production null-honeypot policy; separately report data completeness.
    flag('honeypot','蜜罐排除',quote ? quote.honeypot === null || quote.honeypot === 0 : null,config.tokenFilter.excludeHoneypot);
    flag('mint','铸币权限放弃',quote?.renouncedMint ?? null,config.tokenFilter.requireRenouncedMint);
    flag('freeze','冻结权限放弃',quote?.renouncedFreeze ?? null,config.tokenFilter.requireRenouncedFreeze);
    flag('social','社交信息',quote?.hasSocial ?? null,config.tokenFilter.requireSocial);
    let cost = new Decimal(0), amount = new Decimal(0);
    for (const w of wallets.validWallets) {
      const cycle = getLatestCycle(db,w.wallet,token);
      if (!cycle || cycle.state !== 'open' || !cycle.costComplete) continue;
      for (const buy of w.buys) if (buy.qualifying !== false && buy.amount !== null && buy.amountUsd.gte(config.tradeFilter.minTradeAmountUsd)
        && (cycle.cycleStartedAt === null || buy.timestamp >= cycle.cycleStartedAt)) { cost = cost.plus(buy.amountUsd); amount = amount.plus(buy.amount); }
    }
    const price = Number(quote?.price);
    const ratio = cost.gt(0) && amount.gt(0) && Number.isFinite(price) && price > 0 ? new Decimal(price).mul(amount).div(cost).toNumber() : null;
    range('priceRatio','现价与入场均价倍数',ratio,0,config.signalValidation.blockPriceAboveEntry);
    flag('gap','窗口无已知数据缺口',gap === 'unknown' ? null : gap === 'clean');
    flag('freshToken','代币资料新鲜',!!quote && fresh(quote.priceUpdatedAt,at,CACHE_TTL.price)
      && fresh(quote.riskUpdatedAt,at,CACHE_TTL.risk) && fresh(quote.basicUpdatedAt,at,CACHE_TTL.basic) ? true : null);
    const details = window.wallets.filter(w => w.qualifyingBuyUsd.gt(0)).map(w => {
      const p = getWalletProfile(db,w.wallet), c = getLatestCycle(db,w.wallet,token), reasons: string[] = [];
      if (!p) reasons.push('缺少钱包画像');
      if (p && !fresh(p.refreshedAt,at,WALLET_PROFILE_TTL_SEC)) reasons.push('钱包画像过期');
      if (p?.walletCreatedAt == null) reasons.push('钱包创建时间未知');
      else if (at - p.walletCreatedAt < config.walletFilter.minWalletAgeDays * 86400) reasons.push('钱包年龄不足');
      if (p?.tags.some(t => config.walletFilter.excludeTags.includes(t))) reasons.push('命中排除标签');
      if ((snapshot.observedBuys[w.wallet] ?? 0) < config.walletFilter.minObservedBuys) reasons.push('已观测买入次数不足');
      if (c?.state === 'closed') reasons.push('已清仓');
      if (c && c.cycleStartedAt !== null && c.lastSellTs !== null && c.boughtAmount.gt(0)
        && c.lastSellTs - c.cycleStartedAt <= config.signalValidation.fastFlipMinutes * 60
        && c.soldAmount.div(c.boughtAmount).gte(config.signalValidation.fastFlipSellRatio)) reasons.push('快进快出');
      if (!c || c.state !== 'open' || !c.costComplete) reasons.push('持仓成本不可核验');
      return { wallet: w.wallet, cluster: clusters.clusterOf.get(w.wallet) ?? w.wallet, reasons };
    });
    flag('freshWallets','钱包画像完整且新鲜',window.votingWallets.every(w => { const p = getWalletProfile(db,w);
      return p && p.walletCreatedAt !== null && fresh(p.refreshedAt,at,WALLET_PROFILE_TTL_SEC); }) ? true : null);
    flag('positionTime','持仓时间可核验', snapshot.tables.wallet_positions!.every(p=>p.last_trade_ts==null||Number(p.last_trade_ts)<=at) ? true : null);
    const tokenResult = quote ? validateTokenSnapshot({ db,config,token,nowSec: at,validWallets: original.validWallets,
      gateway: { fetchTokenInfo: async()=>null,fetchTokenSecurity: async()=>null } },quote) : null;
    // Input quality is independent of a rule-derived metric being unavailable (e.g. no eligible cost basis).
    const inputKeys=['ageMinutes','marketCap','holders','liquidity','top10','bundler','insider','entrapment','bot','freshWallet','devHold','snipers','mint','freeze','positionTime'];
    const complete = inputKeys.every(k=>checks[k]!.status!=='unknown') && checks.freshToken!.status === 'pass' && checks.freshWallets!.status === 'pass';
    return { checks, wallets: details, rawVotes: window.votes, validVotes, warn: ratio !== null && ratio > config.signalValidation.warnPriceAboveEntry, strong: validVotes >= config.signal.strongWallets,
      sources: [...new Set(window.wallets.flatMap(w=>w.sources))].sort(), complete,
      eligible: Object.values(checks).every(c=>c.status==='pass'||c.status==='na'),
      productionStatus: original.status !== 'pass' ? original.status : tokenResult?.status ?? 'deferred',
      productionReason: original.reason ?? tokenResult?.reason ?? null };
  } finally { db.close(); }
}
