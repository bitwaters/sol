import { asCandles, pickCompletedCandle } from '../backtest/evaluate.js';
import { BackgroundBusyError } from '../ingest/gateway.js';
import type { ResearchDeps } from './collector.js';

export interface PricePath { resolutionSec:number; expected:number; received:number; complete:boolean;
  maxCloseRatio:number|null; minCloseRatio:number|null; maxCloseDrawdown:number|null; closes:Array<[number,number]>; }
export function pricePath(candles:ReturnType<typeof asCandles>,anchor:number,target:number,step:number,baseline:number):PricePath {
  const closes=[...new Map(candles.filter(c=>c.timeMs/1000>=anchor&&c.timeMs/1000+step<=target)
    .map(c=>[c.timeMs,c])).values()].sort((a,b)=>a.timeMs-b.timeMs).map(c=>[c.timeMs/1000+step,c.close] as [number,number]);
  const expected=Math.max(0,Math.floor(target/step)-Math.ceil(anchor/step));
  const complete=expected>0&&closes.length===expected&&closes.every(([t],i)=>t===(Math.ceil(anchor/step)+i+1)*step);
  let peak=baseline,dd=0;
  for(const [,p] of closes){peak=Math.max(peak,p);if(peak>0)dd=Math.max(dd,(peak-p)/peak);}
  return {resolutionSec:step,expected,received:closes.length,complete,
    maxCloseRatio:closes.length?Math.max(baseline,...closes.map(c=>c[1]))/baseline:null,
    minCloseRatio:closes.length?Math.min(baseline,...closes.map(c=>c[1]))/baseline:null,
    maxCloseDrawdown:closes.length?dd:null,closes};
}
const running=new WeakSet<ResearchDeps['db']>();
export async function evaluateResearchOutcomes(d:ResearchDeps) {
  if(!d.research.enabled||running.has(d.db))return;
  running.add(d.db);
  const now=()=>Math.floor((d.now?.()??Date.now())/1000);
  try{
    const rows=d.db.prepare(`SELECT o.*,s.token,s.anchor_at,s.baseline FROM research_outcomes o JOIN research_samples s ON s.id=o.sample_id
      WHERE o.state='pending' AND o.next_at<=? AND s.state='ready' ORDER BY o.next_at,o.sample_id,o.horizon LIMIT ?`)
      .all(now(),d.research.maxPerBatch) as {sample_id:number;horizon:number;attempts:number;token:string;anchor_at:number;baseline:string}[];
    for(const row of rows){
      const step=row.horizon===86400?300:60,target=row.anchor_at+row.horizon;
      try{
        const raw=await d.gateway.fetchKline(row.token,step===300?'5m':'1m',(row.anchor_at-step*2)*1000,target*1000);
        const candles=asCandles(raw),end=pickCompletedCandle(candles,target*1000,step*1000,step*1000);
        const ratio=end?end.close/Number(row.baseline):null;
        if(end&&ratio!==null&&Number.isFinite(ratio))d.db.prepare(`UPDATE research_outcomes SET state='ready',ratio=?,candle_at=?,path=? WHERE sample_id=? AND horizon=? AND state='pending'`)
          .run(ratio,end.timeMs/1000+step,JSON.stringify(pricePath(candles,row.anchor_at,target,step,Number(row.baseline))),row.sample_id,row.horizon);
        else d.db.prepare(`UPDATE research_outcomes SET attempts=attempts+1,state=CASE WHEN attempts+1>=3 THEN 'exhausted' ELSE 'pending' END,next_at=? WHERE sample_id=? AND horizon=?`)
          .run(now()+300,row.sample_id,row.horizon);
      }catch(e){d.db.prepare('UPDATE research_outcomes SET next_at=? WHERE sample_id=? AND horizon=?').run(now()+(e instanceof BackgroundBusyError?5:300),row.sample_id,row.horizon);}
    }
  }finally{running.delete(d.db);}
}
