import { checkIntegrity } from './integrity.js';
import type { NormalizedTrade } from '../ingest/normalize.js';
import { getKv, setKv, type Db } from '../store/db.js';
import { readStoredTrade } from '../store/repo/trades.js';
import { applyIngestedTrades } from './ingest.js';
import { drainCostInvalidation } from '../store/repo/health.js';
import { positionsPending } from '../store/derived-work.js';
import { runtimeMetrics } from '../ops/metrics.js';
import type { Logger } from '../logger.js';

export function enqueuePositions(db: Db, trades: NormalizedTrade[], now: number): void {
  const insert = db.prepare(`INSERT INTO position_jobs(wallet,token,from_ts,created_at) VALUES (?,?,?,?)
    ON CONFLICT(wallet,token) DO UPDATE SET from_ts=MIN(from_ts,excluded.from_ts)`);
  const gaps=checkIntegrity(db,['smartmoney','kol','follow'],now);
  const boundaries=[...gaps.recentGaps,...gaps.acceptedGaps].map(g=>g.gapTo);
  for (const trade of trades) {
    insert.run(trade.maker,trade.baseAddress,trade.timestamp,now);
    if(boundaries.length){
      setKv(db,`gap_affected:${trade.baseAddress}:${trade.maker}`,true,now);
      const key=`gap_affected_until:${trade.baseAddress}:${trade.maker}`;
      setKv(db,key,Math.max(getKv<number>(db,key)??0,...boundaries),now);
    }
  }
}

/** One wallet/token transaction per turn; timers and network callbacks run between turns. */
export function drainPositions(db: Db, dustRatio: number, logger: Logger, now: number): string | null {
  const job=db.prepare('SELECT * FROM position_jobs WHERE next_at<=? ORDER BY next_at,created_at LIMIT 1').get(now) as
    {wallet:string;token:string;from_ts:number;created_at:number;attempts:number}|undefined;
  if(!job)return null;
  const started=performance.now();
  try {
    db.transaction(()=>{
      const events=db.prepare('SELECT event_id FROM trades WHERE maker=? AND base_address=? AND timestamp>=? ORDER BY timestamp,event_id')
        .all(job.wallet,job.token,job.from_ts) as {event_id:string}[];
      applyIngestedTrades(db,events.map(r=>readStoredTrade(db,r.event_id)),dustRatio,logger);
      db.prepare('DELETE FROM position_jobs WHERE wallet=? AND token=?').run(job.wallet,job.token);
    })();
    runtimeMetrics.observe('derived.position.queue',Math.max(0,(now-job.created_at)*1000));
    return positionsPending(db,job.token)?null:job.token;
  }catch {
    db.prepare('UPDATE position_jobs SET attempts=attempts+1,next_at=? WHERE wallet=? AND token=?')
      .run(now+Math.min(300,5*(job.attempts+1)),job.wallet,job.token);
    logger.error('持仓后台处理失败，保留任务并阻止相关信号');
    return null;
  }finally{runtimeMetrics.observe('derived.position.run',performance.now()-started);}
}

export function startDerivedWorker(db: Db, dustRatio: number, logger: Logger, onReady: (token:string)=>void): ()=>void {
  setKv(db,'deferred_ingest',true);
  let stopped=false;
  let timer:NodeJS.Timeout;
  const turn=()=>{
    if(stopped)return;
    try {
      const started=performance.now();
      const invalidated=drainCostInvalidation(db,100);
      if(invalidated)runtimeMetrics.observe('derived.cost.run',performance.now()-started);
      // Keep cost revocation bounded and ahead of position restoration.
      if(!invalidated){const token=drainPositions(db,dustRatio,logger,Math.floor(Date.now()/1000));if(token)onReady(token);}
    }catch {logger.error('后台派生队列处理失败，保留待处理状态');}
    timer=setTimeout(turn,5);
  };
  timer=setTimeout(turn,0);
  return ()=>{stopped=true;clearTimeout(timer);};
}
