import {describe,it,expect,vi} from 'vitest';
import {scenario,config,log} from './review-fixture.js';
import {loadResearchConfig,RESEARCH_VERSION} from '../src/research/config.js';
import {freezeSnapshot,pack,unpack,restoreSnapshot} from '../src/research/snapshot.js';
import {diagnose} from '../src/research/diagnostics.js';
import {reserveResearch,collectResearch,type ResearchDeps} from '../src/research/collector.js';
import {compareResearch,researchOverview,registerExperiment} from '../src/research/report.js';
import {replay} from '../src/research/replay.js';
import {evaluateResearchOutcomes,pricePath} from '../src/research/outcomes.js';
import {captureDelivery,replayDelivery} from '../src/research/delivery.js';
import {costRatio} from '../src/research/cost.js';
import {enrichToken} from '../src/enrich/token.js';
import {setKv,applySchema} from '../src/store/db.js';
import {evaluateToken} from '../src/signal/candidate.js';
import {BackgroundBusyError} from '../src/ingest/gateway.js';
const research=loadResearchConfig().config;
async function setup(){
  const s=scenario(),at=Math.floor(s.deps.now()/1000);s.deps.config=structuredClone(config);s.deps.config.push.quietHours.minWallets=1;setKv(s.db,'quality_tracking_started_at',at-7200);
  await enrichToken(s.db,s.deps.gateway,'T',{now:s.deps.now});
  const d:ResearchDeps={...s.deps,research,researchVersion:'test',gateway:{...s.deps.gateway,
    fetchWalletStats:async()=>[],fetchKline:async()=>({list:[]})}};
  const freeze=()=>freezeSnapshot(s.db,'T',Math.floor(s.deps.now()/1000),s.deps.config,research,s.deps.blacklist);
  return {...s,d,at,freeze};
}
describe('research snapshots and independent checks',()=>{
  it('separates closed-wallet behavior from missing cost evidence and freezes gap attribution',async()=>{
    const s=await setup();
    s.db.prepare("UPDATE wallet_positions SET state='closed',cost_complete=0,last_sell_ts=cycle_started_at+30,sold_amount=bought_amount WHERE wallet='w1'").run();
    s.db.prepare("UPDATE wallet_positions SET cost_complete=0 WHERE wallet='w2'").run();
    setKv(s.db,'gap_affected:T:w2',true,s.at);setKv(s.db,'gap_affected_until:T:w2',s.at-10,s.at);
    const f=s.freeze(),d=diagnose(f),closed=d.wallets.find(w=>w.wallet==='w1')!,gap=d.wallets.find(w=>w.wallet==='w2')!;
    expect(closed.behaviorReasons).toEqual(expect.arrayContaining(['已清仓','快进快出']));expect(closed.dataReasons).toEqual([]);
    expect(gap).toMatchObject({costState:'gap_affected',dataReasons:['历史缺口影响成本'],behaviorReasons:[]});
    setKv(s.db,'gap_affected:T:w2',false,s.at);
    expect(diagnose(unpack(pack(f)))).toEqual(d);
    expect(diagnose(s.freeze()).wallets.find(w=>w.wallet==='w2')?.costState).toBe('unverified_cost');
  });
  it('reports remaining full-rule blockers and marks legacy wallet attribution explicitly',async()=>{
    const {exploreResearch}=await import('../src/research/exploration.js');
    const s=await setup();s.db.prepare('UPDATE tokens SET market_cap=1').run();reserveResearch(s.d);await collectResearch(s.d);
    const report=exploreResearch(s.db,research,s.at);
    const cohort=report.factors.find(f=>f.experiment.parameter==='validVotes'&&f.experiment.value===2)!.cohorts[0]!;
    expect(cohort).toMatchObject({factorPass:1,fullPass:0,remainingBlockers:{marketCap:{label:'代币市值',count:1}}});
    expect(report.walletAttribution).toMatchObject({observations:3,clear:3,legacy:0});
    const row=s.db.prepare('SELECT id,diagnostics FROM research_samples').get() as {id:number;diagnostics:string};
    const legacy=JSON.parse(row.diagnostics);for(const w of legacy.wallets){delete w.behaviorReasons;delete w.dataReasons;delete w.costState;}
    s.db.prepare('UPDATE research_samples SET diagnostics=? WHERE id=?').run(JSON.stringify(legacy),row.id);
    expect(exploreResearch(s.db,research,s.at).walletAttribution).toMatchObject({observations:3,clear:0,legacy:3});
  });
  it('reproduces production selection and remains immutable after cache mutations',async()=>{
    const s=await setup(),f=s.freeze(),d=diagnose(f);
    expect(d.eligible).toBe(true);expect(d.productionStatus).toBe('pass');expect(d.validVotes).toBe(3);
    s.db.prepare("UPDATE wallets SET tags='[\"scammer\"]'").run();s.db.prepare('UPDATE tokens SET market_cap=1').run();
    expect(diagnose(unpack(pack(f)))).toEqual(d);expect(diagnose(s.freeze()).eligible).toBe(false);
  });
  it('records downstream metrics and all failures after an earlier vote failure',async()=>{
    const s=await setup();s.db.prepare("UPDATE wallets SET tags='[\"scammer\"]' WHERE address='w3'").run();
    s.db.prepare('UPDATE tokens SET market_cap=1,liquidity=1,top10_rate=.8').run();
    const d=diagnose(s.freeze());expect(d.checks.validVotes?.status).toBe('fail');expect(d.checks.holdingRatio?.value).toBe(1);
    expect(d.checks.marketCap?.status).toBe('fail');expect(d.checks.liquidity?.status).toBe('fail');expect(d.checks.top10?.status).toBe('fail');
    expect(d.wallets.find(w=>w.wallet==='w3')?.reasons).toContain('命中排除标签');
  });
  it('keeps missing fields different from zero and does not drop an invalid first sample',async()=>{
    const s=await setup();s.db.prepare('UPDATE tokens SET top10_rate=NULL').run();expect(diagnose(s.freeze()).checks.top10?.status).toBe('unknown');
    s.db.prepare('UPDATE tokens SET top10_rate=0').run();expect(diagnose(s.freeze()).checks.top10?.status).toBe('pass');
  });
  it('replays window/amount/clustering without modifying production configuration',async()=>{
    const s=await setup(),f=s.freeze();expect(replay(f,{parameter:'minTradeAmount',value:2000}).rawVotes).toBe(0);
    expect(replay(f,{parameter:'windowMinutes',value:1}).rawVotes).toBe(0);
    expect(()=>replay(f,{parameter:'windowMinutes',value:61})).toThrow('window_exceeds_snapshot');
    expect(f.config.tradeFilter.minTradeAmountUsd).toBe(300);
    s.db.prepare("UPDATE wallets SET fund_from_address='shared',wallet_created_at=?").run(s.at-30*86400);
    expect(diagnose(s.freeze()).rawVotes).toBe(1);expect(replay(s.freeze(),{parameter:'clusterMerge',value:false}).rawVotes).toBe(3);
  });
  it('replays dust only with known pre-history zero checkpoints',async()=>{
    const s=await setup();expect(replay(s.freeze(),{parameter:'dustRatio',value:.02}).validVotes).toBe(3);
    s.db.prepare('DELETE FROM position_checkpoints').run();expect(()=>replay(s.freeze(),{parameter:'dustRatio',value:.02})).toThrow('zero_checkpoint');
  });
  it('refuses arbitrary tables in stored snapshots',async()=>{const s=await setup(),f=s.freeze();f.tables['invalid']=[];expect(()=>restoreSnapshot(f)).toThrow('table');});
});
describe('research sampling and budget',()=>{
  it('samples below the production amount floor and respects persistent cadence',async()=>{
    const s=await setup();s.db.prepare('UPDATE trades SET amount_usd=\'100\',amount_usd_num=100').run();
    expect(reserveResearch(s.d)).toBe(1);expect(reserveResearch(s.d)).toBe(0);applySchema(s.db);expect(reserveResearch(s.d)).toBe(0);
    await collectResearch(s.d);expect((s.db.prepare('SELECT state FROM research_samples').get() as {state:string}).state).toBe('ready');
    expect((researchOverview(s.db).totals as {samples:number}).samples).toBe(1);
  });
  it('records capacity-limited selection probability and never exceeds pending limit',async()=>{
    const s=await setup();s.d.research={...research,maxPending:1};expect(reserveResearch(s.d)).toBe(1);
    s.setNow(s.at+research.intervalSec);s.buy('w4',s.at+research.intervalSec);expect(reserveResearch(s.d)).toBe(0);
    const runs=s.db.prepare('SELECT universe,selected FROM research_runs ORDER BY id').all();expect(runs).toEqual([{universe:1,selected:1},{universe:1,selected:0}]);
  });
  it('does not refresh foreground profiles or quotes',async()=>{
    const s=await setup();s.db.prepare('UPDATE wallets SET refreshed_at=0').run();s.d.gateway.fetchWalletStats=async()=>({wallet_address:'w1',common:{created_at:s.at-30*86400,tags:[]}});
    reserveResearch(s.d);await collectResearch(s.d);expect(s.db.prepare("SELECT refreshed_at FROM wallets WHERE address='w1'").get()).toEqual({refreshed_at:0});
  });
  it('yields on background congestion and finalizes original snapshot after deadline',async()=>{
    const s=await setup();s.db.prepare('UPDATE tokens SET price_updated_at=0').run();s.d.gateway.fetchTokenInfo=async()=>{throw new BackgroundBusyError();};
    reserveResearch(s.d);await collectResearch(s.d);expect(s.db.prepare('SELECT state FROM research_samples').get()).toEqual({state:'pending'});
    s.setNow(s.at+121);await collectResearch(s.d);expect(s.db.prepare('SELECT state,anchor_at FROM research_samples').get()).toEqual({state:'unavailable',anchor_at:s.at});
  });
});
describe('research comparison and outcomes',()=>{
  it('includes samples rejected only by the researched rule and has no days gate',async()=>{
    const s=await setup();s.db.prepare('UPDATE tokens SET market_cap=10000').run();reserveResearch(s.d);await collectResearch(s.d);
    const e={parameter:'marketCap' as const,value:5000};const registration=registerExperiment(s.db,e,s.at);
    const report=compareResearch(s.db,e,research,s.at+3600,registration.id);
    expect(report.gates.minimumDays).toBeNull();expect(report.cohorts[0]?.classifications.added).toBe(1);
    expect(report.ready).toBe(false);
    expect(()=>compareResearch(s.db,{...e,value:6000},research,s.at,registration.id)).toThrow('definition_changed');
  });
  it('does not turn repeats into independent tokens or replace an earlier unavailable sample',async()=>{
    const s=await setup();reserveResearch(s.d);await collectResearch(s.d);s.db.prepare("UPDATE research_samples SET state='unavailable'").run();
    s.setNow(s.at+300);reserveResearch(s.d);await collectResearch(s.d);
    const r=compareResearch(s.db,{parameter:'marketCap',value:5000},research,s.at+7200);
    expect(r.cohorts.reduce((n,c)=>n+c.selected,0)).toBe(1);expect(r.freshCoverage).toBe(0);
  });
  it('accepts zero endpoint price and tracks path gaps separately',async()=>{
    const s=await setup();reserveResearch(s.d);await collectResearch(s.d);s.setNow(s.at+301);
    s.d.gateway.fetchKline=async()=>({list:[{time:(s.at+240)*1000,close:'0'}]});await evaluateResearchOutcomes(s.d);
    const row=s.db.prepare('SELECT state,ratio,path FROM research_outcomes WHERE horizon=300').get() as {state:string;ratio:number;path:string};
    expect(row.state).toBe('ready');expect(row.ratio).toBe(0);expect(JSON.parse(row.path).complete).toBe(false);
  });
  it('network failures preserve retry budget; missing candles exhaust after three spaced tries',async()=>{
    const s=await setup();reserveResearch(s.d);await collectResearch(s.d);s.setNow(s.at+301);
    s.d.gateway.fetchKline=async()=>{throw new Error('network');};await evaluateResearchOutcomes(s.d);
    expect(s.db.prepare('SELECT attempts FROM research_outcomes WHERE horizon=300').get()).toEqual({attempts:0});
    s.d.gateway.fetchKline=async()=>({list:[]});for(let i=0;i<3;i++){s.setNow(s.at+601+i*300);await evaluateResearchOutcomes(s.d);}
    expect(s.db.prepare('SELECT attempts,state FROM research_outcomes WHERE horizon=300').get()).toEqual({attempts:3,state:'exhausted'});
  });
  it('requires a contiguous close path and computes explicit cost assumptions',()=>{
    const p=pricePath([{timeMs:0,close:2},{timeMs:60000,close:1}],0,120,60,1);expect(p.complete).toBe(true);expect(p.maxCloseDrawdown).toBe(.5);
    expect(costRatio(1,{notionalUsd:100,buyFee:0,sellFee:0,buySlippage:0,sellSlippage:0,networkUsd:1})).toBe(.99);
    expect(()=>costRatio(1,{notionalUsd:0,buyFee:0,sellFee:0,buySlippage:0,sellSlippage:0,networkUsd:0})).toThrow();
  });
});
describe('isolated delivery replay',()=>{
  it('uses the real executor with a fake sender, and leaves live task state unchanged',async()=>{
    const s=await setup();await evaluateToken(s.deps,'T');captureDelivery(s.d);
    const row=s.db.prepare('SELECT frame,error FROM research_delivery_frames').get() as {frame:Buffer;error:string|null};expect(row.error).toBeNull();
    const result=await replayDelivery(row.frame,{parameter:'maxPerMinute',value:10});expect(result.simulatedSends).toBe(1);expect(result.verifiable).toBe(true);
    expect(s.db.prepare('SELECT status FROM push_tasks').get()).toEqual({status:'pending'});
    const fail=await replayDelivery(row.frame,{parameter:'maxPerMinute',value:10},'429');expect(fail.result.failed).toBe(1);
    const expired=await replayDelivery(row.frame,{parameter:'ttl',value:90},'success',100);expect(expired.result.cancelled).toBe(1);
  });
});
describe('development gates use counts, not elapsed days',()=>{
  it('can pass all sample gates within one day with a previously frozen holdout boundary',async()=>{
    const s=await setup(),e={parameter:'marketCap' as const,value:5000};
    s.db.prepare("INSERT INTO research_runs(id,sampled_at,version,universe,selected,strata) VALUES (1,?,'test',80,80,'[]')").run(s.at);
    const insert=s.db.prepare(`INSERT INTO research_samples(run_id,token,selected_at,anchor_at,stratum,probability,config_version,rules_version,research_version,state,baseline,frozen,diagnostics)
      VALUES (1,?,?,?,3,1,'c','r',?,'ready','1',?,?)`);
    for(let i=0;i<80;i++){
      const f=s.freeze();f.quote!.marketCap=i%2?10000:50000;
      const id=Number(insert.run(`test-token-${i}`,s.at+i,s.at+i,RESEARCH_VERSION,pack(f),JSON.stringify(diagnose(f))).lastInsertRowid);
      s.db.prepare("INSERT INTO research_outcomes(sample_id,horizon,state,next_at,ratio) VALUES (?,3600,'ready',?,1.2)").run(id,s.at+i+3600);
      if(i===39)registerExperiment(s.db,e,s.at+39);
    }
    const id=(s.db.prepare('SELECT id FROM research_experiments').get() as {id:string}).id;
    const report=compareResearch(s.db,e,research,s.at+4000,id);
    expect(report.ready).toBe(true);expect(report.cohorts[0]?.cells.map(c=>c.valid)).toEqual([20,20,20,20]);
  });
  it('source-only replay needs a verifiable observed token start',async()=>{
    const s=await setup();expect(()=>replay(s.freeze(),{parameter:'sources',value:['smartmoney']})).toThrow('observed_zero_start');
    setKv(s.db,'observation_started_at',s.at-7200);
    expect(replay(s.freeze(),{parameter:'sources',value:['smartmoney']}).rawVotes).toBe(3);
  });
});
describe('research review regressions',()=>{
  it('rejects later discovered historical gaps without replacing frozen strategy inputs',async()=>{
    const s=await setup();s.db.prepare('UPDATE tokens SET market_cap=10000').run();reserveResearch(s.d);await collectResearch(s.d);
    const exp={parameter:'marketCap' as const,value:5000};expect(compareResearch(s.db,exp,research,s.at+3600).cohorts[0]?.classifications.added).toBe(1);
    s.db.prepare("INSERT INTO data_gaps(source,from_ts,to_ts,opened_at,state) VALUES ('follow',?,?,?,'recovered')").run(s.at-100,s.at-90,s.at+60);
    expect(compareResearch(s.db,exp,research,s.at+3600).cohorts[0]?.unknown).toBe(1);
  });
  it('classifies missing or stale profiles as missing data, not wallet strategy failures',async()=>{
    const s=await setup();s.db.prepare('UPDATE wallets SET refreshed_at=0').run();const d=diagnose(s.freeze());
    expect(d.checks.freshWallets?.status).toBe('unknown');expect(d.complete).toBe(false);
  });
  it('does not accept a derived dust checkpoint as proof of actual zero balance',async()=>{
    const s=await setup();s.db.prepare("UPDATE position_checkpoints SET source='local_rebuild'").run();
    expect(()=>replay(s.freeze(),{parameter:'dustRatio',value:.02})).toThrow('zero_checkpoint');
  });
});
describe('research scheduler isolation',()=>{
  it('captures while an old outcome is in flight and yields remaining background work to pending captures',async()=>{
    const {createResearchSchedule}=await import('../src/research/scheduler.js');
    let release!:()=>void,pending=false;
    const slow=vi.fn(()=>new Promise<void>(resolve=>{release=resolve;})),next=vi.fn(async()=>{}),collect=vi.fn(async()=>{});
    const schedule=createResearchSchedule({collect,pending:()=>pending,backgroundJobs:[slow,next],onError:()=>{}});
    const running=schedule.measureOnce();pending=true;await schedule.collectOnce();expect(collect).toHaveBeenCalledTimes(1);
    await schedule.measureOnce();expect(slow).toHaveBeenCalledTimes(1);release();await running;expect(next).not.toHaveBeenCalled();
  });
});
it('background wallet enrichment can acquire weight three without exceeding a capacity-five bucket',async()=>{
  const {GmgnGateway}=await import('../src/ingest/gateway.js');
  const {TokenBucket,BanGate}=await import('../src/ingest/limiter.js');
  const bucket=new TokenBucket({ratePerSecond:10,capacity:5});
  const getWalletStats=vi.fn(async()=>({}));
  const gateway=new GmgnGateway({client:{getWalletStats} as never,limiter:bucket,banGate:new BanGate()});
  await gateway.background().fetchWalletStats('test-wallet');
  expect(getWalletStats).toHaveBeenCalledTimes(1);expect(bucket.available).toBeGreaterThanOrEqual(2);expect(bucket.available).toBeLessThan(3);
});

describe('active sampling and measurement remediation',()=>{
  it('reserves a low-amount control stratum and separates candidates with qualified buyers',async()=>{
    const s=await setup();s.db.prepare("UPDATE trades SET base_address='low',amount_usd='100',amount_usd_num=100 WHERE maker='w3'").run();
    expect(reserveResearch(s.d)).toBe(2);
    expect(s.db.prepare('SELECT token,stratum FROM research_samples ORDER BY stratum').all()).toEqual([{token:'low',stratum:0},{token:'T',stratum:2}]);
  });
  it('preserves successful enrichment across background yields without advancing its price timestamp',async()=>{
    const s=await setup();s.db.prepare('DELETE FROM tokens').run();s.db.prepare('UPDATE wallets SET refreshed_at=0').run();
    s.d.gateway.fetchWalletStats=vi.fn(async(address:string)=>({wallet_address:address,common:{created_at:s.at-30*86400,tags:[]}}));
    s.d.gateway.fetchTokenInfo=vi.fn(s.deps.gateway.fetchTokenInfo);
    const security=s.deps.gateway.fetchTokenSecurity;
    s.d.gateway.fetchTokenSecurity=vi.fn().mockRejectedValueOnce(new BackgroundBusyError()).mockImplementation(security);
    reserveResearch(s.d);await collectResearch(s.d);expect(s.db.prepare('SELECT state FROM research_samples').get()).toEqual({state:'pending'});
    s.setNow(s.at+30);await collectResearch(s.d);
    expect(s.d.gateway.fetchTokenInfo).toHaveBeenCalledTimes(1);expect(s.d.gateway.fetchWalletStats).toHaveBeenCalledTimes(2);
    expect(s.db.prepare('SELECT state,anchor_at,price_at FROM research_samples').get()).toEqual({state:'ready',anchor_at:s.at+30,price_at:s.at});
    expect(s.db.prepare('SELECT COUNT(*) n FROM tokens').get()).toEqual({n:0});
  });
  it('ignores dormant tokens and stratifies only the production window while retaining older history',async()=>{
    const s=await setup();s.db.prepare('UPDATE trades SET timestamp=?').run(s.at-1000);
    expect(reserveResearch(s.d)).toBe(0);
    s.setNow(s.at+300);s.buy('active',s.at+299);
    expect(reserveResearch(s.d)).toBe(1);
    const row=s.db.prepare('SELECT stratum,initial FROM research_samples').get() as {stratum:number;initial:Buffer};
    expect(row.stratum).toBe(1);expect(unpack(row.initial).tables.trades).toHaveLength(4);
  });
  it('uses first observations within the new version without rewriting old failed samples',async()=>{
    const s=await setup();reserveResearch(s.d);await collectResearch(s.d);
    s.db.prepare("UPDATE research_samples SET state='unavailable',research_version='old'").run();
    s.setNow(s.at+300);s.buy('w4',s.at+299);reserveResearch(s.d);await collectResearch(s.d);
    const r=compareResearch(s.db,{parameter:'validVotes',value:2},research,s.at+7200);
    expect(r.cohorts.reduce((n,c)=>n+c.selected,0)).toBe(1);expect(r.freshCoverage).toBe(1);
    expect(s.db.prepare("SELECT state FROM research_samples WHERE research_version='old'").get()).toEqual({state:'unavailable'});
  });
  it('classifies missing endpoints without accepting future prices or treating network failure as no market',async()=>{
    const s=await setup();reserveResearch(s.d);await collectResearch(s.d);s.setNow(s.at+301);
    s.d.gateway.fetchKline=vi.fn(async()=>({list:[{time:(s.at+300)*1000,close:2}]}));await evaluateResearchOutcomes(s.d);
    expect(s.db.prepare('SELECT state,last_error,attempts FROM research_outcomes WHERE horizon=300').get())
      .toEqual({state:'pending',last_error:'future_only',attempts:1});
    expect(s.d.gateway.fetchKline).toHaveBeenCalledWith('T','1m',(s.at-120)*1000,(s.at+420)*1000);
    s.setNow(s.at+601);s.d.gateway.fetchKline=async()=>{throw new Error('private request detail');};await evaluateResearchOutcomes(s.d);
    expect(s.db.prepare('SELECT last_error,attempts FROM research_outcomes WHERE horizon=300').get()).toEqual({last_error:'request_error',attempts:1});
    s.setNow(s.at+901);s.d.gateway.fetchKline=async()=>({list:[{time:(s.at-60)*1000,close:1}]});await evaluateResearchOutcomes(s.d);
    expect(s.db.prepare('SELECT last_error,candle_count FROM research_outcomes WHERE horizon=300').get()).toEqual({last_error:'stale_candles',candle_count:1});
  });
  it('prioritizes current retries by due time, and yields to new captures',async()=>{
    const {dueResearchOutcomes}=await import('../src/research/outcomes.js');
    const s=await setup();reserveResearch(s.d);await collectResearch(s.d);s.setNow(s.at+90000);
    s.d.research={...research,maxOutcomeBatch:2};
    s.db.prepare("UPDATE research_outcomes SET attempts=1,next_at=? WHERE horizon=300").run(s.at+300);
    const rows=dueResearchOutcomes(s.d,s.at+90000);expect(rows).toHaveLength(2);
    expect(rows[0]?.attempts).toBe(1);expect(rows[0]?.horizon).toBe(300);expect(rows[1]?.horizon).toBe(3600);
    s.d.gateway.fetchKline=vi.fn(async()=>{s.db.prepare("UPDATE research_samples SET state='pending'").run();return {list:[]};});
    await evaluateResearchOutcomes(s.d);expect(s.d.gateway.fetchKline).toHaveBeenCalledTimes(1);
  });
  it('reserves current-scope retry slots while draining older versions without duplicate work',async()=>{
    const {dueResearchOutcomes}=await import('../src/research/outcomes.js');
    const s=await setup();reserveResearch(s.d);await collectResearch(s.d);
    s.db.prepare("UPDATE research_samples SET config_version='older-config'").run();
    s.db.prepare('UPDATE research_outcomes SET next_at=0').run();
    s.setNow(s.at+300);s.buy('w4',s.at+299);reserveResearch(s.d);await collectResearch(s.d);
    const current=(s.db.prepare('SELECT MAX(id) id FROM research_samples').get() as {id:number}).id;
    s.db.prepare('UPDATE research_outcomes SET attempts=1 WHERE sample_id=?').run(current);
    s.d.research={...research,maxOutcomeBatch:2};
    const rows=dueResearchOutcomes(s.d,s.at+90000);
    expect(rows).toHaveLength(2);expect(rows[0]).toMatchObject({sample_id:current,attempts:1,horizon:300});
    expect(rows[1]?.sample_id).not.toBe(current);
    expect(new Set(rows.map(r=>`${r.sample_id}:${r.horizon}`)).size).toBe(2);
  });
  it('migrates old measurement columns idempotently',async()=>{
    const s=await setup();for(const name of ['last_error','checked_at','candle_count','latest_close_at'])s.db.exec(`ALTER TABLE research_outcomes DROP COLUMN ${name}`);
    s.db.exec('ALTER TABLE research_experiments DROP COLUMN scope');applySchema(s.db);applySchema(s.db);
    expect((s.db.prepare('PRAGMA table_info(research_outcomes)').all() as {name:string}[]).map(r=>r.name)).toContain('last_error');
  });
});
describe('sample-count experiment progression',()=>{
  it('scalar exploration matches full replay, including other simultaneous failures',async()=>{
    const {researchPlan,classifyThreshold}=await import('../src/research/exploration.js');
    const s=await setup();
    for(const changed of [false,true]){
      s.db.prepare('UPDATE wallets SET tags=? WHERE address=?').run(JSON.stringify(changed?['scammer']:['smart_degen']),'w3');
      const f=s.freeze(),d=diagnose(f);
      for(const p of researchPlan)for(const value of p.values){const e={parameter:p.parameter,value};expect(classifyThreshold(d,e).eligible).toBe(replay(f,e).eligible);}
      expect(classifyThreshold(d,{parameter:'validVotes',value:2}).eligible).toBe(true);
    }
    s.db.prepare('UPDATE tokens SET market_cap=1').run();const d=diagnose(s.freeze());
    expect(classifyThreshold(d,{parameter:'validVotes',value:2})).toMatchObject({factorPass:true,eligible:false});
  });
  it('waits for training counts, freezes an idempotent boundary, and requires future holdout counts',async()=>{
    const {advanceResearchExperiments}=await import('../src/research/exploration.js');
    const s=await setup();reserveResearch(s.d);await collectResearch(s.d);
    expect(advanceResearchExperiments(s.db,research,s.at+3600)).toEqual([]);
    s.db.prepare('DELETE FROM research_outcomes').run();s.db.prepare('DELETE FROM research_samples').run();
    const insert=s.db.prepare(`INSERT INTO research_samples(run_id,token,selected_at,anchor_at,stratum,probability,config_version,rules_version,research_version,state,baseline,frozen,diagnostics)
      VALUES (1,?,?,?,3,1,'c','r',?,'ready','1',?,?)`);
    function add(from:number,to:number){for(let i=from;i<to;i++){
      s.db.prepare('UPDATE wallets SET tags=? WHERE address=?').run(JSON.stringify(i%2?['scammer']:['smart_degen']),'w3');
      const f=s.freeze(),id=Number(insert.run(`unique-${i}`,s.at+i,s.at+i,RESEARCH_VERSION,pack(f),JSON.stringify(diagnose(f))).lastInsertRowid);
      s.db.prepare("INSERT INTO research_outcomes(sample_id,horizon,state,next_at,ratio) VALUES (?,3600,'ready',?,1.1)").run(id,s.at+i+3600);
    }}
    add(0,40);const registrations=advanceResearchExperiments(s.db,research,s.at+4000);expect(registrations).toHaveLength(1);
    const r=registrations[0]!;expect(compareResearch(s.db,r.definition,research,s.at+4000,r.id).ready).toBe(false);
    add(40,80);const again=advanceResearchExperiments(s.db,research,s.at+4400);expect(again[0]?.id).toBe(r.id);expect(again[0]?.boundary).toBe(r.boundary);
    expect(compareResearch(s.db,r.definition,research,s.at+4400,r.id).ready).toBe(true);
  });
});
it('keeps complete histories of relevant wallets while excluding unrelated old-wallet snapshots',async()=>{
  const s=await setup();const before=diagnose(s.freeze());
  s.buy('inactive',s.at-7200);s.buy('w1',s.at-7200);
  const f=freezeSnapshot(s.db,'T',s.at,s.deps.config,{...research,maxSnapshotWallets:3},s.deps.blacklist);
  expect(f.tables.trades?.some(t=>t.maker==='inactive')).toBe(false);
  expect(f.tables.wallet_positions?.some(t=>t.wallet==='inactive')).toBe(false);
  expect(f.tables.trades?.filter(t=>t.maker==='w1')).toHaveLength(2);
  expect(Object.keys(f.observedBuys)).toEqual(['w1','w2','w3']);
  expect(diagnose(f).rawVotes).toBe(before.rawVotes);
  expect(()=>freezeSnapshot(s.db,'T',s.at,s.deps.config,{...research,maxSnapshotTrades:3},s.deps.blacklist)).toThrow('snapshot_size_limit');
  // An old same-transaction link between relevant wallets must still be available to clustering.
  s.buy('w2',s.at-7200);s.db.prepare("UPDATE trades SET tx_hash='old-shared' WHERE maker IN ('w1','w2') AND timestamp=?").run(s.at-7200);
  const clustered=s.freeze();expect(diagnose(clustered).rawVotes).toBe(2);
  expect(replay(clustered,{parameter:'clusterMerge',value:false}).rawVotes).toBe(3);
});
