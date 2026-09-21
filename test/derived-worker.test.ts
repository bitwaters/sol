import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase,getKv,setKv,type Db} from '../src/store/db.js';
import {ingestBatch} from '../src/store/repo/trades.js';
import {upsertSourceHealth,drainCostInvalidation} from '../src/store/repo/health.js';
import {normalizeTrackItem} from '../src/ingest/normalize.js';
import {enqueuePositions,drainPositions,startDerivedWorker} from '../src/signal/derived-worker.js';
import {derivedPending,positionsPending,costsPending} from '../src/store/derived-work.js';
import {getLatestCycle} from '../src/signal/positions.js';
import {evaluateToken,revalidateSignalForSend} from '../src/signal/candidate.js';
import {Pusher} from '../src/telegram/pusher.js';
import {freezeSnapshot} from '../src/research/snapshot.js';
import {diagnose} from '../src/research/diagnostics.js';
import {loadResearchConfig} from '../src/research/config.js';
import {resolveStaleGaps} from '../src/signal/integrity.js';
import {collectOpsAlerts} from '../src/ops/alerts.js';
import {scenario,log} from './review-fixture.js';
const dbs:Db[]=[];afterEach(()=>{vi.useRealTimers();for(const db of dbs.splice(0))db.close();});
function trade(at:number,side='buy',amount=10){return normalizeTrackItem('smartmoney',{
 transaction_hash:`tx-${at}-${side}-${amount}`,maker:'w1',base_address:'T',side,timestamp:at,
 token_amount:String(amount),amount_usd:amount,quote_amount:String(amount),balance:side==='sell'?'0':String(amount),
})!;}
function ingest(db:Db,at:number,items=[trade(at)]){return ingestBatch(db,'smartmoney',items,{source:'smartmoney',last_success_at:at},at,
 trades=>enqueuePositions(db,trades,at));}

it('commits raw data, heartbeat and durable work together without updating positions inline',()=>{
 const db=openDatabase({path:':memory:'});dbs.push(db);ingest(db,100);
 expect(db.prepare('SELECT COUNT(*) n FROM trades').get()).toEqual({n:1});
 expect(db.prepare('SELECT last_success_at FROM source_health').get()).toEqual({last_success_at:100});
 expect(getLatestCycle(db,'w1','T')).toBeNull();expect(derivedPending(db,'T')).toBe(true);
 expect(derivedPending(db,'other')).toBe(false);
 drainPositions(db,.01,log,101);expect(getLatestCycle(db,'w1','T')?.boughtAmount.toNumber()).toBe(10);
 expect(derivedPending(db,'T')).toBe(false);
 ingest(db,102,[trade(100)]);expect(positionsPending(db,'T')).toBe(false);
});
it('rolls back queue creation along with raw data and health if the ingest transaction fails',()=>{
 const db=openDatabase({path:':memory:'});dbs.push(db);
 expect(()=>ingestBatch(db,'smartmoney',[trade(100)],{source:'smartmoney',last_success_at:100},100,items=>{
  enqueuePositions(db,items,100);throw new Error('rollback');
 })).toThrow();
 for(const table of ['trades','position_jobs','source_health'])expect(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({n:0});
});
it('resumes jobs after reopening the database and coalesces later arrivals without double counting',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sol-derived-'));let db=openDatabase({path:join(dir,'db')});
 try{ingest(db,100);db.close();db=openDatabase({path:join(dir,'db')});ingest(db,102,[trade(102)]);
 expect(db.prepare('SELECT COUNT(*) n FROM position_jobs').get()).toEqual({n:1});
 drainPositions(db,.01,log,103);expect(getLatestCycle(db,'w1','T')?.boughtAmount.toNumber()).toBe(20);
 drainPositions(db,.01,log,104);expect(getLatestCycle(db,'w1','T')?.boughtAmount.toNumber()).toBe(20);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
it('replays late events from the earliest affected point and preserves close/reopen cycles',()=>{
 const db=openDatabase({path:':memory:'});dbs.push(db);ingest(db,100);drainPositions(db,.01,log,100);
 ingest(db,120,[trade(120)]);drainPositions(db,.01,log,120);
 ingest(db,125,[trade(110,'sell')]);drainPositions(db,.01,log,125);
 expect(db.prepare('SELECT cycle_no,state,bought_amount FROM wallet_positions ORDER BY cycle_no').all())
 .toEqual([{cycle_no:1,state:'closed',bought_amount:'10'},{cycle_no:2,state:'open',bought_amount:'10'}]);
});
it('retains a failed job with backoff and no partial position writes',()=>{
 const db=openDatabase({path:':memory:'});dbs.push(db);ingest(db,100);
 db.exec("CREATE TRIGGER fail_position BEFORE INSERT ON wallet_positions BEGIN SELECT RAISE(ABORT,'failure'); END");
 drainPositions(db,.01,log,101);expect(getLatestCycle(db,'w1','T')).toBeNull();
 expect(db.prepare('SELECT attempts,next_at FROM position_jobs').get()).toEqual({attempts:1,next_at:106});
 db.exec('DROP TRIGGER fail_position');drainPositions(db,.01,log,105);expect(positionsPending(db,'T')).toBe(true);
 drainPositions(db,.01,log,106);expect(positionsPending(db,'T')).toBe(false);
});
it('revokes costs in bounded chunks and keeps the pending gate until all chunks commit',()=>{
 const s=scenario();dbs.push(s.db);const at=s.deps.now()/1000;setKv(s.db,'deferred_ingest',true);
 upsertSourceHealth(s.db,{source:'smartmoney',gap_from_ts:at-20,gap_to_ts:at},at);
 expect(s.db.prepare('SELECT SUM(cost_complete) n FROM wallet_positions').get()).toEqual({n:3});
 expect(derivedPending(s.db,'T')).toBe(true);expect(derivedPending(s.db,'other')).toBe(true);
 expect(drainCostInvalidation(s.db,1)).toBe(1);
 expect(s.db.prepare('SELECT SUM(cost_complete) n FROM wallet_positions').get()).toEqual({n:2});
 upsertSourceHealth(s.db,{source:'smartmoney',gap_to_ts:at+10},at+10);
 expect(s.db.prepare('SELECT cursor FROM cost_invalidation_job').get()).toEqual({cursor:0});
 while(costsPending(s.db))drainCostInvalidation(s.db,1);
 expect(getKv(s.db,'gap_affected_until:T:w1')).toBe(at+10);
 expect(s.db.prepare('SELECT SUM(cost_complete) n FROM wallet_positions').get()).toEqual({n:0});
});
it('retains gap exposure on queued trades even if the gap ages out before position processing',()=>{
 const db=openDatabase({path:':memory:'});dbs.push(db);setKv(db,'deferred_ingest',true);
 upsertSourceHealth(db,{source:'smartmoney',gap_from_ts:90,gap_to_ts:100},100);
 ingest(db,105);while(costsPending(db))drainCostInvalidation(db);
 resolveStaleGaps(db,800);drainPositions(db,.01,log,800);
 expect(getKv(db,'gap_affected:T:w1')).toBe(true);expect(getLatestCycle(db,'w1','T')?.costComplete).toBe(false);
});
it('blocks evaluation and sending against pending positions, then resumes',async()=>{
 const s=scenario();dbs.push(s.db);const at=s.deps.now()/1000;
 const initial=await evaluateToken(s.deps,'T');
 ingest(s.db,at,[trade(at,'buy',1500)]);
 expect((await evaluateToken(s.deps,'T')).reason).toBe('derived_pending');
 expect((await revalidateSignalForSend(s.deps,initial.signalId!)).reason).toBe('derived_pending');
 const sender={sendMessage:vi.fn(async()=>({message_id:100})),editMessageText:vi.fn()};
 const p=new Pusher({...s.deps,sender,chatId:'test',revalidate:id=>revalidateSignalForSend(s.deps,id)});
 expect((await p.runOnce()).sent).toBe(0);expect(sender.sendMessage).not.toHaveBeenCalled();
 drainPositions(s.db,.01,log,at);
 expect((await evaluateToken(s.deps,'T')).reason).not.toBe('derived_pending');
});
it('defers a push if newer raw trades arrive during asynchronous revalidation',async()=>{
 const s=scenario();dbs.push(s.db);const at=s.deps.now()/1000;await evaluateToken(s.deps,'T');
 const sender={sendMessage:vi.fn(async()=>({message_id:100})),editMessageText:vi.fn()};
 const p=new Pusher({...s.deps,sender,chatId:'test',revalidate:async()=>{ingest(s.db,at);return {ok:true};}});
 expect((await p.runOnce()).deferred).toBeGreaterThan(0);expect(sender.sendMessage).not.toHaveBeenCalled();
 expect(s.db.prepare("SELECT status FROM push_tasks WHERE kind='signal'").get()).toEqual({status:'pending'});
});
it('frozen research records pending positions as incomplete rather than eligible',async()=>{
 const s=scenario();dbs.push(s.db);const at=s.deps.now()/1000;await evaluateToken(s.deps,'T');ingest(s.db,at);
 const snapshot=freezeSnapshot(s.db,'T',at,s.deps.config,loadResearchConfig().config,s.deps.blacklist);
 const result=diagnose(snapshot);expect(result.complete).toBe(false);expect(result.eligible).toBe(false);
 expect(result.productionReason).toBe('derived_pending');
});
it('alerts on derived backlog separately from collection heartbeat and the worker yields to timers',async()=>{
 vi.useFakeTimers();const db=openDatabase({path:':memory:'});dbs.push(db);const now=Math.floor(Date.now()/1000);ingest(db,now-70);
 expect(collectOpsAlerts(db,{nowSec:now}).map(a=>a.kind)).toContain('positions_stalled');
 const ready=vi.fn(),stop=startDerivedWorker(db,.01,log,ready);
 expect(positionsPending(db,'T')).toBe(true);await vi.advanceTimersByTimeAsync(1);
 expect(ready).toHaveBeenCalledWith('T');stop();
});

it('uses the active-state index for bounded invalidation rather than sorting all historical cycles',()=>{
 const db=openDatabase({path:':memory:'});dbs.push(db);
 const plan=db.prepare('EXPLAIN QUERY PLAN SELECT rowid,wallet,token FROM wallet_positions WHERE state=? AND rowid>? ORDER BY rowid LIMIT ?').all('open',0,100) as {detail:string}[];
 expect(plan.some(r=>r.detail.includes('idx_wallet_positions_state'))).toBe(true);
 expect(plan.some(r=>r.detail.includes('TEMP B-TREE'))).toBe(false);
});
it('labels planned restart related gaps without suppressing the integrity alert',()=>{
 const db=openDatabase({path:':memory:'});dbs.push(db);setKv(db,'last_planned_restart',{requestedAt:100,startedAt:110});
 upsertSourceHealth(db,{source:'kol',gap_from_ts:99,gap_to_ts:111},112);
 expect(collectOpsAlerts(db,{nowSec:120}).find(a=>a.kind==='gap:kol')?.message).toContain('计划部署重启');
 expect(collectOpsAlerts(db,{nowSec:800}).find(a=>a.kind==='gap:kol')?.message).not.toContain('计划部署重启');
});
