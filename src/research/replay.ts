import { normalizeTrackItem, type TradeSource } from '../ingest/normalize.js';
import { upsertTrades } from '../store/repo/trades.js';
import type { AppConfig } from '../config.js';
import { configSchema } from '../config.js';
import { rebuildWalletToken } from '../signal/rebuild.js';
import { getKv } from '../store/db.js';
import { gapStatus } from '../backtest/features.js';
import { diagnose } from './diagnostics.js';
import { restoreSnapshot, type FrozenSnapshot } from './snapshot.js';

// An experiment changes one declared factor. Coupled vote floors deliberately share one factor.
export const parameters = {
  validVotes:['signal.minDistinctWallets','signalValidation.minValidWallets'],strongWallets:['signal.strongWallets'],
  netInflow:['tradeFilter.netInflowUsd.min'], marketCap:['tokenFilter.marketCapUsd.min'],
  marketCapMax:['tokenFilter.marketCapUsd.max'],ageMinutes:['tokenFilter.ageMinutes.min'],ageMax:['tokenFilter.ageMinutes.max'],
  holders:['tokenFilter.holderCount.min'],liquidity:['tokenFilter.liquidityUsd.min'],
  holdingRatio:['signalValidation.minConsensusHoldingRatio'],verifiableCount:['signalValidation.minVerifiableWallets'],
  priceRatio:['signalValidation.blockPriceAboveEntry'],warnPriceRatio:['signalValidation.warnPriceAboveEntry'],
  top10:['tokenFilter.maxTop10HolderRate'],bundler:['tokenFilter.maxBundlerRate'],insider:['tokenFilter.maxInsiderRate'],
  entrapment:['tokenFilter.maxEntrapmentRate'],bot:['tokenFilter.maxBotDegenRate'],freshWallet:['tokenFilter.maxFreshWalletRate'],
  devHold:['tokenFilter.maxDevTeamHoldRate'],snipers:['tokenFilter.maxSniperCount'],
  windowMinutes:['signal.windowMinutes'],minTradeAmount:['tradeFilter.minTradeAmountUsd'],
  walletAge:['walletFilter.minWalletAgeDays'],observedBuys:['walletFilter.minObservedBuys'],
  fastFlipMinutes:['signalValidation.fastFlipMinutes'],fastFlipRatio:['signalValidation.fastFlipSellRatio'],
  dustRatio:['signalValidation.positionDustRatio'],clusterDelta:['walletFilter.cluster.creationTimeDeltaMinutes'],
  clusterMerge:['signal.clusterMerge'],sameFunder:['walletFilter.cluster.sameFunder'],
  requireOpen:['signal.requireOpenAction'],requireSmartMoney:['signal.requireAtLeastOneSmartMoney'],
  actions:['tradeFilter.actions'], sources:[], excludeTags:['walletFilter.excludeTags'],
  sameFunderExclusions:['walletFilter.cluster.excludeFunderLabels'], netInflowMax:['tradeFilter.netInflowUsd.max'],walletCountMax:['tradeFilter.walletCount.max'],
} as const;
export type Parameter=keyof typeof parameters;
export type Experiment={parameter:Parameter;value:number|boolean|string[]};
export function variant(config:AppConfig,experiment:Experiment):AppConfig{
  if(!Object.hasOwn(parameters,experiment.parameter))throw new Error('unsupported_research_parameter');
  if(experiment.parameter==='sources'&&(!Array.isArray(experiment.value)||!experiment.value.length||experiment.value.some(v=>!['smartmoney','kol','follow'].includes(v))))throw new Error('invalid_sources');
  const next=structuredClone(config);
  for(const path of parameters[experiment.parameter]){
    const keys=path.split('.');let target=next as unknown as Record<string,unknown>;
    for(const key of keys.slice(0,-1))target=target[key] as Record<string,unknown>;
    target[keys.at(-1)!]=experiment.value;
  }
  return configSchema.parse(next);
}
export function replay(snapshot:FrozenSnapshot,experiment:Experiment){
  const config=variant(snapshot.config,experiment);
  let frozen=snapshot;
  if(experiment.parameter==='dustRatio'||experiment.parameter==='sources'){
    const db=restoreSnapshot(snapshot);
    try{
      if(experiment.parameter==='sources'){
        const sources=experiment.value as string[],marks=sources.map(()=>'?').join(',');
        const observations=db.prepare(`SELECT source,raw,first_seen_at FROM trade_sources WHERE source IN (${marks}) ORDER BY first_seen_at,event_id,source`)
          .all(...sources) as {source:TradeSource;raw:string;first_seen_at:number}[];
        db.prepare('DELETE FROM trade_sources').run();db.prepare('DELETE FROM trades').run();
        for(const o of observations){
          const trade=normalizeTrackItem(o.source,JSON.parse(o.raw));
          if(!trade)throw new Error('source_replay_invalid_observation');
          upsertTrades(db,o.source,[trade],o.first_seen_at);
        }
        const created=snapshot.quote?.createdAt, observed=getKv<number>(db,'observation_started_at');
        if(created==null||observed==null||created<observed||created<snapshot.at-snapshot.maxWindowMinutes*60||gapStatus(db,created,snapshot.at)!=='clean')
          throw new Error('source_replay_requires_observed_zero_start');
        // External balance checkpoints may incorporate excluded sources; reconstruct from observed token creation instead.
        db.prepare('DELETE FROM position_checkpoints').run();db.prepare('DELETE FROM wallet_positions').run();
      }
      // Old nonzero checkpoints embed old dust decisions. Only rebuild when a pre-history zero is available.
      for(const wallet of Object.keys(snapshot.observedBuys)){
        const first=db.prepare("SELECT MIN(timestamp) t FROM trades WHERE maker=? AND base_address=?").get(wallet,snapshot.token) as {t:number|null};
        if(first.t===null)continue;
        const zero=db.prepare("SELECT 1 FROM position_checkpoints WHERE wallet=? AND token=? AND balance='0' AND source='balance_info' AND checked_at<? LIMIT 1").get(wallet,snapshot.token,first.t);
        if(!zero&&experiment.parameter==='dustRatio')throw new Error('dust_replay_missing_zero_checkpoint');
        // Remove nonzero checkpoints: they may be consequences of the original dust threshold.
        db.prepare("DELETE FROM position_checkpoints WHERE wallet=? AND token=? AND (balance!='0' OR source!='balance_info')").run(wallet,snapshot.token);
        const result=rebuildWalletToken(db,wallet,snapshot.token,first.t,{dustRatio:config.signalValidation.positionDustRatio,
          tokenCreatedAt:snapshot.quote?.createdAt,observationStartedAt:getKv<number>(db,'observation_started_at'),
          hasRecentGap:gapStatus(db,first.t,snapshot.at)!=='clean'});
        if(!result.rebuilt)throw new Error('dust_replay_unavailable');
      }
      frozen=structuredClone(snapshot);
      for(const table of ['wallet_positions','position_checkpoints','trades','trade_sources'])
        frozen.tables[table]=db.prepare(`SELECT * FROM ${table}`).all() as FrozenSnapshot['tables'][string];
    }finally{db.close();}
  }
  return diagnose(frozen,config);
}
