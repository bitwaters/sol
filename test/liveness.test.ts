import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenApiClient } from '../src/gmgn/OpenApiClient.js';
import { GmgnGateway } from '../src/ingest/gateway.js';
import { BanGate, TokenBucket } from '../src/ingest/limiter.js';
import { Poller } from '../src/ingest/poller.js';
import { getKv, setKv, openDatabase } from '../src/store/db.js';
import { recordSourceOutages, staleSources, upsertSourceHealth } from '../src/store/repo/health.js';
import { checkIntegrity, resolveStaleGaps } from '../src/signal/integrity.js';
import { gapStatus } from '../src/backtest/features.js';
import { backupDatabaseOnline, collectOpsAlerts } from '../src/ops/alerts.js';
import { loadResearchConfig } from '../src/research/config.js';
import { reserveResearch, collectResearch, type ResearchDeps } from '../src/research/collector.js';
import { evaluateResearchOutcomes } from '../src/research/outcomes.js';
import { freezeSnapshot, restoreSnapshot } from '../src/research/snapshot.js';
import { enrichToken } from '../src/enrich/token.js';
import { scenario, log } from './review-fixture.js';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it('expires an uncooperative fetch and ignores its late response', async () => {
  vi.useFakeTimers();
  const client = new OpenApiClient({apiKey:'test',host:'https://example.invalid',timeoutMs:20});
  let finish!: (r:Response)=>void;
  const text = vi.fn(async ()=>'{}'), cancel = vi.fn(async ()=>{});
  const fetch = vi.spyOn(globalThis,'fetch').mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}))
    .mockResolvedValue(new Response(JSON.stringify({code:0,data:{list:[]}})));
  const pending = expect(client.getKol('sol',1)).rejects.toThrow('request_deadline_exceeded');
  await vi.advanceTimersByTimeAsync(20); await pending;
  expect((fetch.mock.calls[0]![1]!.signal as AbortSignal).aborted).toBe(true);
  finish({text,body:{cancel}} as unknown as Response);
  await vi.advanceTimersByTimeAsync(0);
  expect(cancel).toHaveBeenCalledOnce(); expect(text).not.toHaveBeenCalled();
  await expect(client.getKol('sol',1)).resolves.toEqual({list:[]});
});

it('bounds response-body reading even when the body does not honor abort', async () => {
  vi.useFakeTimers();
  const client = new OpenApiClient({apiKey:'test',host:'https://example.invalid',timeoutMs:20});
  vi.spyOn(globalThis,'fetch').mockResolvedValue({headers:new Headers(),text:()=>new Promise(()=>{}),body:null} as unknown as Response);
  const pending = expect(client.getKol('sol',1)).rejects.toThrow('request_deadline_exceeded');
  await vi.advanceTimersByTimeAsync(20); await pending;
});

it('a hung foreground request releases the poller for the next tick without late ingestion', async () => {
  vi.useFakeTimers();
  const db=openDatabase({path:':memory:'});
  const client={getKol:vi.fn().mockImplementationOnce(()=>new Promise(()=>{})).mockResolvedValue({list:[]})};
  const gateway=new GmgnGateway({client:client as never,limiter:new TokenBucket({ratePerSecond:10,capacity:5}),banGate:new BanGate(),requestTimeoutMs:20});
  const poller=new Poller({db,source:'kol',logger:log,intervalMs:1000,limit:100,fetchPage:()=>gateway.fetchKol(100)});
  try {
    const pending=poller.tick();await vi.advanceTimersByTimeAsync(20);
    expect((await pending).error).toBe('request_deadline_exceeded');
    expect((await poller.tick()).error).toBeUndefined();
    expect(client.getKol).toHaveBeenCalledTimes(2);
  } finally {db.close();}
});

it('a hung kline releases the background budget and outcome lock without consuming a market-miss attempt', async () => {
  vi.useFakeTimers();
  const s=scenario(), at=s.deps.now()/1000, research=loadResearchConfig().config;
  s.deps.config=structuredClone(s.deps.config);setKv(s.db,'quality_tracking_started_at',at-7200);
  await enrichToken(s.db,s.deps.gateway,'T',{now:s.deps.now});
  const client={getTokenKline:vi.fn().mockImplementationOnce(()=>new Promise(()=>{})).mockResolvedValue({list:[]})};
  const gw=new GmgnGateway({client:client as never,limiter:new TokenBucket({ratePerSecond:10,capacity:5}),banGate:new BanGate(),requestTimeoutMs:20});
  const d:ResearchDeps={...s.deps,research,researchVersion:'test',gateway:{...s.deps.gateway,fetchKline:gw.background().fetchKline}};
  try {
    reserveResearch(d);await collectResearch(d);s.setNow(at+301);
    const pending=evaluateResearchOutcomes(d);await vi.advanceTimersByTimeAsync(20);await pending;
    expect(s.db.prepare('SELECT attempts,last_error FROM research_outcomes WHERE horizon=300').get()).toEqual({attempts:0,last_error:'request_error'});
    s.setNow(at+602);await vi.advanceTimersByTimeAsync(3000);await evaluateResearchOutcomes(d);
    expect(client.getTokenKline).toHaveBeenCalledTimes(2);
    expect(s.db.prepare('SELECT attempts,last_error FROM research_outcomes WHERE horizon=300').get()).toEqual({attempts:1,last_error:'empty_response'});
  } finally {s.db.close();}
});

it('records missing-source history, blocks beyond ten minutes, and never restores old cost eligibility on recovery', () => {
  const s=scenario(),at=s.deps.now()/1000;
  try {
    setKv(s.db,'service_started_at',at);setKv(s.db,'quality_tracking_started_at',at-7200);
    upsertSourceHealth(s.db,{source:'kol',last_success_at:at},at);setKv(s.db,'enabled_sources',['kol']);
    recordSourceOutages(s.db,at+61);recordSourceOutages(s.db,at+120);
    resolveStaleGaps(s.db,at+1000);
    expect(checkIntegrity(s.db,[],at+1000).blocked).toBe(true); // Missing source is not in the observed-token source set.
    expect(getKv(s.db,'gap_affected:T:w1')).toBe(true);
    const f=freezeSnapshot(s.db,'T',at+120,s.deps.config,loadResearchConfig().config,s.deps.blacklist);
    const restored=restoreSnapshot(f);
    expect(gapStatus(restored,at+60,at+120)).toBe('affected');restored.close();
    upsertSourceHealth(s.db,{source:'kol',last_success_at:at+1001},at+1001);
    expect(checkIntegrity(s.db,[],at+1001).blocked).toBe(false);
    expect(s.db.prepare('SELECT source,from_ts,to_ts,recovered_at FROM source_outages').all())
      .toEqual([{source:'kol',from_ts:at,to_ts:at+1001,recovered_at:at+1001}]);
    expect(gapStatus(s.db,at+60,at+120)).toBe('affected'); // Later recovery cannot rehabilitate old comparisons.
    expect(gapStatus(s.db,at+1002,at+1010)).toBe('clean');
    expect(getKv(s.db,'gap_affected_until:T:w1')).toBe(at+1001);
    expect(s.db.prepare('SELECT DISTINCT cost_complete FROM wallet_positions').all()).toEqual([{cost_complete:0}]);
  } finally {s.db.close();}
});

it('catches an outage at the first recovery poll even before the monitor runs, and rolls it back atomically', () => {
  const s=scenario(),at=s.deps.now()/1000;
  try {
    setKv(s.db,'service_started_at',at);upsertSourceHealth(s.db,{source:'follow',last_success_at:at},at);
    setKv(s.db,'enabled_sources',['follow']);
    expect(()=>s.db.transaction(()=>{upsertSourceHealth(s.db,{source:'follow',last_success_at:at+100},at+100);throw new Error('rollback');})()).toThrow();
    expect(s.db.prepare('SELECT COUNT(*) n FROM source_outages').get()).toEqual({n:0});
    expect(getKv(s.db,'gap_affected:T:w1')).toBeNull();
    upsertSourceHealth(s.db,{source:'follow',last_success_at:at+100},at+100);
    expect(s.db.prepare('SELECT recovered_at FROM source_outages').get()).toEqual({recovered_at:at+100});
    setKv(s.db,'enabled_sources',[]);expect(staleSources(s.db,at+999)).toEqual([]);
  } finally {s.db.close();}
});

it('alerts on measurement stagnation even if repeated budget-busy checks have newer timestamps', () => {
  const s=scenario(),at=s.deps.now()/1000;
  try {
    setKv(s.db,'service_started_at',at-1000);setKv(s.db,'research_enabled',true);
    s.db.prepare("INSERT INTO research_runs VALUES (1,?,'v',1,1,'[]')").run(at);
    s.db.prepare("INSERT INTO research_samples(id,run_id,token,selected_at,stratum,probability,config_version,rules_version,research_version,state) VALUES (1,1,'T',?,1,1,'c','r','v','ready')").run(at-1000);
    s.db.prepare("INSERT INTO research_outcomes(sample_id,horizon,state,next_at,checked_at,last_error) VALUES (1,300,'pending',?,?, 'background_busy')").run(at-1,at);
    expect(collectOpsAlerts(s.db,{nowSec:at}).map(a=>a.kind)).toContain('research_stalled');
    s.db.prepare("UPDATE research_outcomes SET last_error='empty_response'").run();
    expect(collectOpsAlerts(s.db,{nowSec:at}).map(a=>a.kind)).not.toContain('research_stalled');
  } finally {s.db.close();}
});

it('online backups yield to timers and expose only a completed consistent database', async () => {
  const db=openDatabase({path:':memory:'}),dir=mkdtempSync(join(tmpdir(),'sol-online-backup-'));
  try {
    db.exec('CREATE TABLE padding(data BLOB); INSERT INTO padding VALUES (zeroblob(2097152))');
    setKv(db,'test',42);let progressed=false;
    setImmediate(()=>{progressed=true;});
    const path=await backupDatabaseOnline(db,dir);
    expect(progressed).toBe(true);expect(readdirSync(dir)).toHaveLength(1);
    const copy=openDatabase({path});expect(copy.pragma('quick_check',{simple:true})).toBe('ok');expect(getKv(copy,'test')).toBe(42);copy.close();
  } finally {db.close();rmSync(dir,{recursive:true,force:true});}
});

it('does not label an enabled source that has never responded as healthy after startup grace', () => {
  const db=openDatabase({path:':memory:'});
  try {
    setKv(db,'enabled_sources',['kol']);setKv(db,'service_started_at',1000);
    expect(checkIntegrity(db,[],1060).blocked).toBe(false);
    expect(checkIntegrity(db,[],1061).blocked).toBe(true);
    recordSourceOutages(db,1061);
    expect(db.prepare('SELECT from_ts,to_ts FROM source_outages').get()).toEqual({from_ts:1000,to_ts:1061});
  } finally {db.close();}
});
