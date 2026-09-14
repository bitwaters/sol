import { openDatabase,setKv } from '../src/store/db.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { normalizeTrackItem } from '../src/ingest/normalize.js';
import { upsertTrades } from '../src/store/repo/trades.js';
import { upsertWalletProfile } from '../src/enrich/wallet.js';
import { upsertSourceHealth } from '../src/store/repo/health.js';
import { applyTrade,getLatestCycle } from '../src/signal/positions.js';
import { evaluateToken,revalidateSignalForSend } from '../src/signal/candidate.js';
import { Pusher } from '../src/telegram/pusher.js';
import { evaluateOutcomes } from '../src/backtest/evaluate.js';
import { buildStatsReport } from '../src/backtest/report.js';
import { runExitMonitor } from '../src/telegram/exit-monitor.js';
const loaded=loadConfig({skipDotenv:true,env:{GMGN_API_KEY:'test'}});
export const config=structuredClone(loaded.config); config.push.quietHours.minWallets=0;
export const log=createLogger({test:true}); for(const k of ['info','warn','error','debug'] as const) log[k]=()=>{};
export const baseNow=Math.floor(Date.now()/1000); const blacklist={entries:new Map()};
const dust={tokenCreatedAt:null,observationStartedAt:null,hasRecentGap:false,dustRatio:.01};
export function scenario(){const db=openDatabase({path:':memory:'}); let now=baseNow; let price='1';
 const gateway={fetchTokenInfo:async()=>({symbol:'T',price:{price},circulating_supply:50000,creation_timestamp:baseNow-3600,liquidity:30000,holder_count:500,stat:{top_10_holder_rate:.1,top_bundler_trader_percentage:.1,top_rat_trader_percentage:.1,top_entrapment_trader_percentage:.1,bot_degen_rate:.1,fresh_wallet_rate:.1,dev_team_hold_rate:.01},wallet_tags_stat:{sniper_wallets:1}}),fetchTokenSecurity:async()=>({honeypot:0,renounced_mint:true,renounced_freeze_account:true,top_10_holder_rate:.1}),fetchWalletStats:async()=>[]};
 const deps={db,config,gateway,logger:log,configVersion:'c',rulesVersion:'r',blacklist,now:()=>now*1000};
 function buy(w: string,ts=now-120,entryPrice=1){upsertWalletProfile(db,{address:w,name:null,twitter:null,tags:['smart_degen'],fundFrom:null,fundFromAddress:null,walletCreatedAt:baseNow-30*86400,refreshedAt:now});
 db.prepare("INSERT INTO position_checkpoints(wallet,token,cycle_no,checked_at,balance,bought_amount,sold_amount,bought_usd,sold_usd,cost_complete,source) VALUES (?,'T',1,?,'0','0','0','0','0',1,'balance_info')").run(w,ts-80);
 const t=normalizeTrackItem('smartmoney',{transaction_hash:`${w}-${ts}`,maker:w,base_address:'T',side:'buy',timestamp:ts,token_amount:String(1500/entryPrice),amount_usd:1500,balance:String(1500/entryPrice),maker_info:{tags:['smart_degen']}})!;upsertTrades(db,'smartmoney',[t]); applyTrade(db,t,dust);}
 for(const w of ['w1','w2','w3'])buy(w);
 return {db,deps,buy,setNow:(n: number)=>now=n,setPrice:(p: string)=>price=p};}
