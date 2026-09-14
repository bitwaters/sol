import { createHash } from 'node:crypto';
import { gzipSync,gunzipSync } from 'node:zlib';
import { configSchema, type AppConfig } from '../config.js';
import type { Db } from '../store/db.js';
import { Pusher } from '../telegram/pusher.js';
import { runExitMonitor } from '../telegram/exit-monitor.js';
import { evaluateToken,revalidateSignalForSend,runCandidateMaintenance } from '../signal/candidate.js';
import { TelegramRateLimitError, TelegramDeliveryUnknownError } from '../telegram/types.js';
import { freezeSnapshot,restoreSnapshot,type FrozenSnapshot } from './snapshot.js';
import type { ResearchDeps } from './collector.js';

interface DeliveryFrame {at:number;config:AppConfig;configVersion:string;rulesVersion:string;snapshots:FrozenSnapshot[];
  tables:FrozenSnapshot['tables'];}
/** Bounded diagnostic frames before the real executor. Snapshot failures must never stop delivery. */
export function captureDelivery(d:ResearchDeps){
  if(!d.research.enabled)return;
  const db=d.db,at=Math.floor((d.now?.()??Date.now())/1000);
  const pending=db.prepare("SELECT * FROM push_tasks WHERE status IN ('pending','sending') OR (status IN ('failed','unknown') AND attempts<max_attempts) ORDER BY id LIMIT 201").all() as Array<Record<string,string|number|null>>;
  if(!pending.length)return;
  const digest=createHash('sha256').update(JSON.stringify([pending.map(p=>[p.id,p.status,p.attempts,p.updated_at]),Math.floor(at/60)])).digest('hex');
  if(db.prepare('SELECT 1 FROM research_delivery_frames WHERE digest=?').get(digest))return;
  let packed:Buffer|null=null,error:string|null=null;
  try{
    if(pending.length>200)throw new Error('frame_task_limit');
    const signalIds=[...new Set(pending.map(p=>p.signal_id!))];
    const marks=signalIds.map(()=>'?').join(',');
    const signals=db.prepare(`SELECT * FROM signals WHERE id IN (${marks})`).all(...signalIds) as FrozenSnapshot['tables'][string];
    const tokens=[...new Set(signals.map(s=>String(s.token)))];
    if(tokens.length>4)throw new Error('frame_token_limit');
    const snapshots=tokens.map(t=>freezeSnapshot(db,t,at,d.config,d.research,d.blacklist));
    const related=db.prepare(`SELECT * FROM signals WHERE token IN (${tokens.map(()=>'?').join(',')}) ORDER BY id LIMIT 1001`).all(...tokens) as typeof signals;
    if(related.length>1000)throw new Error('frame_signal_limit');
    for(const snapshot of snapshots)for(const signal of related) {
      const keys=['edit_last','warn','downgrade','partial','exit_done'].map(k=>`${k}:${signal.id}`);
      snapshot.tables.kv!.push(...db.prepare(`SELECT * FROM kv WHERE key IN (${keys.map(()=>'?').join(',')})`).all(...keys) as typeof signals);
    }
    const relatedIds=related.map(s=>s.id!),relatedMarks=relatedIds.map(()=>'?').join(',');
    const tasks=db.prepare(`SELECT * FROM push_tasks WHERE signal_id IN (${relatedMarks})
      OR (status='sent' AND kind IN ('signal','escalate') AND updated_at>=?) LIMIT 2001`).all(...relatedIds,at-60) as FrozenSnapshot['tables'][string];
    if(tasks.length>2000)throw new Error('frame_history_limit');
    // Recent sent tasks count against the same global budget. Their unrelated signals are not needed.
    const tables:FrozenSnapshot['tables']={signals:related,push_tasks:tasks,
      signal_wallets:db.prepare(`SELECT * FROM signal_wallets WHERE signal_id IN (${relatedMarks})`).all(...relatedIds) as FrozenSnapshot['tables'][string],
      signal_evaluations:db.prepare(`SELECT * FROM signal_evaluations WHERE id IN (SELECT MAX(id) FROM signal_evaluations WHERE signal_id IN (${relatedMarks}) GROUP BY signal_id,stage)`).all(...relatedIds) as FrozenSnapshot['tables'][string]};
    const frame:DeliveryFrame={at,config:d.config,configVersion:d.configVersion,rulesVersion:d.rulesVersion,snapshots,tables};
    packed=gzipSync(JSON.stringify(frame));if(packed.length>2_000_000)throw new Error('frame_byte_limit');
  }catch(e){packed=null;error=e instanceof Error?e.message:'capture_unavailable';}
  db.prepare('INSERT INTO research_delivery_frames(captured_at,digest,frame,error) VALUES (?,?,?,?)').run(at,digest,packed,error);
}
export type DeliveryExperiment={parameter:'maxPerMinute'|'quietMinVotes'|'ttl'|'editThrottle'|'stopEditAfter'|'cooldown'|'consensusExit'|'otherExit';value:number};
export async function replayDelivery(data:Buffer,exp:DeliveryExperiment,transport:'success'|'429'|'unknown'='success',advanceSec=0){
  if(!Number.isFinite(advanceSec)||advanceSec<0)throw new Error('invalid_advance');
  const frame=JSON.parse(gunzipSync(data).toString('utf8')) as DeliveryFrame;
  if(!frame.snapshots.length)throw new Error('empty_frame');
  const config=structuredClone(frame.config);
  switch(exp.parameter){
    case 'maxPerMinute':config.push.maxPerMinute=exp.value;break;
    case 'quietMinVotes':config.push.quietHours.minWallets=exp.value;break;
    case 'ttl':config.signalValidation.signalTtlSeconds=exp.value;break;
    case 'editThrottle':config.push.editThrottleSec=exp.value;break;
    case 'stopEditAfter':config.push.stopEditAfterMinutes=exp.value;break;
    case 'cooldown':config.signal.cooldownMinutes=exp.value;break;
    case 'consensusExit':config.signalValidation.postPushExitAlert.minWallets=exp.value;break;
    case 'otherExit':config.exitAlerts.minWallets=exp.value;break;
    default:throw new Error('unsupported_delivery_parameter');
  }
  configSchema.parse(config);
  const joined=structuredClone(frame.snapshots[0]!);
  for(const s of frame.snapshots.slice(1))for(const [table,rows] of Object.entries(s.tables))(joined.tables[table]??=[]).push(...rows);
  // Restore only explicit table names; no SQL is loaded from the frame.
  const db=restoreSnapshot(joined);
  try{
    for(const [table,rows] of Object.entries(frame.tables)){
      if(!['signals','push_tasks','signal_wallets','signal_evaluations'].includes(table))throw new Error('invalid_delivery_table');
      const cols=new Set((db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(r=>r.name));
      for(const row of rows){const keys=Object.keys(row);if(keys.some(k=>!cols.has(k)))throw new Error('invalid_delivery_column');
        db.prepare(`INSERT OR REPLACE INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k]!));}
    }
    let requests=0, sends=0,edits=0,id=1000000;
    const observed=Object.assign({},...frame.snapshots.map(s=>s.observedBuys)) as Record<string,number>;
    for(const [wallet,count] of Object.entries(observed)){
      const present=(db.prepare("SELECT COUNT(*) n FROM trades WHERE maker=? AND side='buy' AND timestamp<=?").get(wallet,frame.at) as {n:number}).n;
      // Match the saved global-count threshold without inventing token positions or prices.
      const needed=Math.max(0,Math.min(count,config.walletFilter.minObservedBuys)-present);
      if(needed>100){requests++;continue;}
      for(let i=0;i<needed;i++)db.prepare("INSERT INTO trades(event_id,chain,tx_hash,maker,side,base_address,timestamp,created_at) VALUES (?,'sol','research-count',?,'buy','research-outside-token',?,?)")
        .run(`research-count:${wallet}:${i}`,wallet,frame.at,frame.at);
    }
    const unavailable=async()=>{requests++;throw new Error('snapshot_requires_unavailable_refresh');};
    const logger={info:()=>{},warn:()=>{},error:()=>{},debug:()=>{},child(){return this;}} as unknown as ResearchDeps['logger'];
    const at=frame.at+advanceSec;
    const deps={db,config,configVersion:frame.configVersion,rulesVersion:frame.rulesVersion,logger,now:()=>at*1000,
      blacklist:{entries:new Map(joined.blacklist.map(e=>[e.address,e]))},
      gateway:{fetchTokenInfo:unavailable,fetchTokenSecurity:unavailable,fetchWalletStats:unavailable}};
    const fail=()=>{if(transport==='429')throw new TelegramRateLimitError(30);if(transport==='unknown')throw new TelegramDeliveryUnknownError();};
    if(exp.parameter==='cooldown'||exp.parameter==='editThrottle') for(const snapshot of frame.snapshots) {
      runCandidateMaintenance(db,snapshot.token,at,config.signal.windowMinutes,config.tradeFilter.minTradeAmountUsd);
      await evaluateToken(deps,snapshot.token);
    }
    if(exp.parameter==='consensusExit'||exp.parameter==='otherExit')runExitMonitor(deps);
    const result=await new Pusher({...deps,chatId:'offline',revalidate:s=>revalidateSignalForSend(deps,s),sender:{
      sendMessage:async()=>{fail();sends++;return {message_id:id++};},editMessageText:async()=>{fail();edits++;},
    }}).runOnce();
    const states=db.prepare('SELECT kind,status,COUNT(*) n FROM push_tasks GROUP BY kind,status').all();
    return {capturedAt:frame.at,evaluatedAt:at,experiment:exp,transport,verifiable:requests===0,missingRefreshRequests:requests,
      simulatedSends:sends,simulatedEdits:edits,result,states,
      limitation:'孤立时点的真实执行器回放；传输结果为指定情景。时间推进不补造新行情或成交，需刷新时结果标为不可验证。'};
  }finally{db.close();}
}
