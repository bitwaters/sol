import { derivedPending } from '../store/derived-work.js';
import { createHash } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { getKv, type Db } from '../store/db.js';
import { buildClusters } from '../signal/cluster.js';
import type { CexBlacklist } from '../enrich/wallet.js';

export interface ExitMonitorDeps {db:Db;config:AppConfig;logger:Logger;now?:()=>number;blacklist?:CexBlacklist;}
export interface ExitChanges {keys:string[];consensus:number;other:number;corrections:number;eventAt:number|null;}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex').slice(0,24);
/** Fresh closure events, tied to the monitored position cycle rather than current wallet balance. */
export function exitChanges(db:Db,config:AppConfig,signalId:number,now:number,blacklist:CexBlacklist={entries:new Map()}, includeAcknowledged=false):ExitChanges {
  const empty:ExitChanges={keys:[],consensus:0,other:0,corrections:0,eventAt:null};
  const signal=db.prepare(`SELECT s.token,s.sent_at,t.created_at FROM signals s LEFT JOIN tokens t ON t.address=s.token
    WHERE s.id=? AND s.status='pushed' AND s.tg_message_id IS NOT NULL`).get(signalId) as {token:string;sent_at:number|null;created_at:number|null}|undefined;
  if(!signal||derivedPending(db,signal.token)||signal.sent_at===null||now-signal.sent_at>86400||(signal.created_at!==null&&now-signal.created_at>86400))return empty;
  type Row={wallet:string;cycle_no:number;cluster_id:string|null;joined_at:number|null;state:string|null;last_sell_ts:number|null};
  const rows=db.prepare(`SELECT sw.wallet,sw.cycle_no,sw.cluster_id,sw.joined_at,p.state,p.last_sell_ts
    FROM signal_wallets sw LEFT JOIN wallet_positions p ON p.wallet=sw.wallet AND p.token=? AND p.cycle_no=sw.cycle_no
    WHERE sw.signal_id=? AND COALESCE(sw.joined_version,0)<=?`).all(signal.token,signalId,getKv<number>(db,`published_member_version:${signalId}`)??0) as Row[];
  const acknowledged=new Set(includeAcknowledged?[]:getKv<string[]>(db,`exit_events:${signalId}`)??[]);
  const grouped=new Map<string,Row[]>();for(const r of rows){const k=r.cluster_id??r.wallet;grouped.set(k,[...(grouped.get(k)??[]),r]);}
  const closed=[...grouped.values()].filter(g=>g.every(r=>r.state==='closed'&&(r.last_sell_ts===null||r.last_sell_ts<=now)));
  const out={...empty,keys:[] as string[]};
  const add=(members:Row[],kind:'consensus'|'other')=>{
    // Missing or pre-publication event timestamps are corrections, never fresh exits.
    const correction=members.some(r=>r.last_sell_ts===null||r.last_sell_ts<=Math.max(signal.sent_at!,r.joined_at??signal.sent_at!));
    const keys=members.map(r=>hash(kind+':'+`${r.wallet}:${r.cycle_no}:${r.last_sell_ts??'unknown'}`)).filter(k=>!acknowledged.has(k));
    if(!keys.length)return;
    out.keys.push(...keys);out[correction?'corrections':kind]++;
    for(const r of members)if(r.last_sell_ts!==null)out.eventAt=Math.max(out.eventAt??0,r.last_sell_ts);
  };
  if(config.signalValidation.postPushExitAlert.enabled&&closed.length>=config.signalValidation.postPushExitAlert.minWallets)
    for(const group of closed)add(group,'consensus');
  if(config.exitAlerts.enabled){
    const bound=new Set(rows.map(r=>`${r.wallet}:${r.cycle_no}`));
    const others=(db.prepare(`SELECT wallet,cycle_no,last_sell_ts FROM wallet_positions WHERE token=? AND state='closed'
      AND last_sell_ts>? AND last_sell_ts<=?`).all(signal.token,signal.sent_at,now) as Row[]).filter(r=>!bound.has(`${r.wallet}:${r.cycle_no}`));
    const clusters=buildClusters(db,signal.token,[...new Set(others.map(r=>r.wallet))],{blacklist,enabled:config.signal.clusterMerge,...config.walletFilter.cluster});
    if(clusters.clusterCount>=config.exitAlerts.minWallets)for(const members of clusters.clusterMembers.values())
      add(others.filter(r=>members.includes(r.wallet)),'other');
  }
  return out;
}
export interface ExitMessage {messageId:number;chatId:string|null;updatedAt:number;signature?:string;}
/** Reuse the earliest confirmed exit reply, including replies published before this upgrade. */
export function exitMessage(db:Db,signalId:number):ExitMessage|null {
  const saved=getKv<ExitMessage>(db,`exit_message:${signalId}`);if(saved)return saved;
  const row=db.prepare(`SELECT t.tg_message_id messageId,s.tg_chat_id chatId,t.updated_at updatedAt
    FROM push_tasks t JOIN signals s ON s.id=t.signal_id WHERE t.signal_id=? AND t.kind='exit_alert'
    AND t.status='sent' AND t.tg_message_id IS NOT NULL AND t.tg_message_id!=s.tg_message_id ORDER BY t.id LIMIT 1`)
    .get(signalId) as ExitMessage|undefined;
  return row??null;
}
export function exitSignature(changes:ExitChanges):string {
  return hash(JSON.stringify([changes.keys.slice().sort(),changes.consensus,changes.other,changes.corrections]));
}
/** Coalesce pending changes; the first exit reply is sent once, then edited in place. */
export function runExitMonitor(deps:ExitMonitorDeps):number {
  const {db,config}=deps,now=Math.floor((deps.now?.()??Date.now())/1000);
  const signals=db.prepare(`SELECT s.id,s.token FROM signals s LEFT JOIN tokens t ON t.address=s.token
    WHERE s.status='pushed' AND s.sent_at>=? AND s.tg_message_id IS NOT NULL AND (t.created_at IS NULL OR t.created_at>=?)`).all(now-86400,now-86400) as {id:number;token:string}[];
  let created=0;
  for(const {id,token} of signals){
    if(derivedPending(db,token))continue;
    const changes=exitChanges(db,config,id,now,deps.blacklist,true),anchor=exitMessage(db,id);
    if((!changes.keys.length&&!anchor)||anchor?.signature===exitSignature(changes))continue;
    const res=db.prepare(`INSERT INTO push_tasks(signal_id,kind,alert_type,revision,dedupe_key,payload,status,created_at,updated_at)
      VALUES (?,'exit_alert','state_change',0,?,?,'pending',?,?) ON CONFLICT(dedupe_key) DO UPDATE SET
      status='pending',payload=excluded.payload,attempts=0,next_retry_at=NULL,updated_at=excluded.updated_at
      WHERE push_tasks.status IN ('sent','cancelled')`)
      .run(id,`${id}:exit:status`,JSON.stringify(changes),now,now);
    created+=res.changes;
  }
  return created;
}
/** 非绑定周期的退出簇数量；排队和实际发送共用同一判定。 */
export function countOtherExitedClusters(
  db: Db, config: AppConfig, token: string, sentAt: number,
  wallets: Array<{ wallet: string; cycleNo: number | null }>,
  blacklist: CexBlacklist,
): number {
  const bound = new Set(wallets.map((w) => `${w.wallet}:${w.cycleNo}`));
  const otherClosed = db.prepare(`SELECT wallet, cycle_no FROM wallet_positions
    WHERE token = ? AND state = 'closed' AND last_sell_ts >= ?`)
    .all(token, sentAt) as Array<{ wallet: string; cycle_no: number }>;
  const others = [...new Set(otherClosed.filter(row => !bound.has(`${row.wallet}:${row.cycle_no}`)).map(row => row.wallet))];
  return buildClusters(db, token, others, {
    blacklist, enabled: config.signal.clusterMerge,
    sameFunder: config.walletFilter.cluster.sameFunder,
    creationTimeDeltaMinutes: config.walletFilter.cluster.creationTimeDeltaMinutes,
    excludeFunderLabels: config.walletFilter.cluster.excludeFunderLabels,
  }).clusterCount;
}
