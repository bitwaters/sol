import {afterEach,it,expect,vi} from 'vitest';
import {GmgnGateway,ROUTE_WEIGHTS,BackgroundBusyError,type GatewayLimitState} from '../src/ingest/gateway.js';
import {BanGate,TokenBucket} from '../src/ingest/limiter.js';
import {OpenApiClient} from '../src/gmgn/OpenApiClient.js';
import {getKv,setKv,openDatabase} from '../src/store/db.js';
const epoch=2_000_000_000_000;
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
const limited=(resetAtUnix=epoch/1000+5,apiError='RATE_LIMIT_EXCEEDED')=>Object.assign(new Error('limited'),{status:429,apiError,resetAtUnix});
function setup(client:unknown,options:Partial<ConstructorParameters<typeof GmgnGateway>[0]>={}){
  vi.useFakeTimers();vi.setSystemTime(epoch);
  const gate=new BanGate(),bucket=new TokenBucket({ratePerSecond:10,capacity:10});
  return {gate,bucket,gateway:new GmgnGateway({client:client as OpenApiClient,limiter:bucket,banGate:gate,...options})};
}
it('charges ten units per follow page and spaces the next request by its actual cost',async()=>{
  const starts:Array<[string,number]>=[];
  const s=setup({getFollowWallet:async()=>{starts.push(['follow',Date.now()-epoch]);return [];},getSmartMoney:async()=>{starts.push(['smart',Date.now()-epoch]);return [];}});
  expect(ROUTE_WEIGHTS.followWallet).toBe(10);
  const follow=s.gateway.fetchFollowWallet({}),smart=s.gateway.fetchSmartmoney(100);
  await vi.advanceTimersByTimeAsync(0);expect(starts).toEqual([['follow',0]]);
  await vi.advanceTimersByTimeAsync(999);expect(starts).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);expect(starts).toEqual([['follow',0],['smart',1000]]);await Promise.all([follow,smart]);
});
it('does not release accumulated requests together after an event-loop stall',async()=>{
  const starts:number[]=[];const s=setup({getFollowWallet:async()=>{starts.push(Date.now()-epoch);return [];}});
  const requests=[s.gateway.fetchFollowWallet({}),s.gateway.fetchFollowWallet({}),s.gateway.fetchFollowWallet({})];
  await vi.advanceTimersByTimeAsync(0);vi.setSystemTime(epoch+10_000);
  await vi.advanceTimersByTimeAsync(1000);expect(starts).toEqual([0,11000]);
  await vi.advanceTimersByTimeAsync(999);expect(starts).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);expect(starts).toEqual([0,11000,12000]);await Promise.all(requests);
});
it('stops queued foreground and background traffic throughout the full ban',async()=>{
  const send=vi.fn().mockRejectedValueOnce(limited()).mockResolvedValue([]);
  const s=setup({getSmartMoney:send,getTokenInfo:send});
  const first=s.gateway.fetchSmartmoney(100).catch(e=>e),second=s.gateway.fetchSmartmoney(100);
  await vi.advanceTimersByTimeAsync(0);expect(s.gateway.limitState.effectiveRate).toBe(8);
  await expect(s.gateway.background().fetchTokenInfo('test')).rejects.toBeInstanceOf(BackgroundBusyError);
  await vi.advanceTimersByTimeAsync(5999);expect(send).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);expect(send).toHaveBeenCalledTimes(2);await Promise.all([first,second]);
});
it('restores the remaining cooldown and reduced budget across gateway restarts',async()=>{
  const db=openDatabase({path:':memory:'});
  try{
    const s=setup({getSmartMoney:async()=>{throw limited();}},{saveLimitState:state=>setKv(db,'gmgn_limit_state',state)});
    await expect(s.gateway.fetchSmartmoney(1)).rejects.toMatchObject({name:'RateLimitedError'});
    const saved=getKv<GatewayLimitState>(db,'gmgn_limit_state')!,send=vi.fn(async()=>[]);
    const next=new GmgnGateway({client:{getSmartMoney:send} as never,limiter:new TokenBucket({ratePerSecond:10,capacity:10}),banGate:new BanGate(),savedLimitState:saved});
    const request=next.fetchSmartmoney(1);await vi.advanceTimersByTimeAsync(5999);expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);await request;expect(next.limitState.effectiveRate).toBe(8);
  }finally{db.close();}
});
it('extends the ban from concurrent in-flight responses without repeated budget cuts',async()=>{
  let rejectA!:(e:unknown)=>void,rejectB!:(e:unknown)=>void;
  const client={getSmartMoney:()=>new Promise((_,r)=>{rejectA=r;}),getKol:()=>new Promise((_,r)=>{rejectB=r;})};
  const s=setup(client);const a=s.gateway.fetchSmartmoney(1).catch(e=>e),b=s.gateway.fetchKol(1).catch(e=>e);
  await vi.advanceTimersByTimeAsync(100);rejectA(limited());await vi.advanceTimersByTimeAsync(0);
  rejectB(limited(epoch/1000+10,'RATE_LIMIT_BANNED'));await Promise.all([a,b]);
  expect(s.gateway.limitState.effectiveRate).toBe(8);expect(s.gateway.bannedUntil).toBe(epoch+11000);
});
it('honors late 429 responses even after the caller deadline has elapsed',async()=>{
  let reject!:(e:unknown)=>void;
  const s=setup({getSmartMoney:()=>new Promise((_,r)=>{reject=r;})},{requestTimeoutMs:50});
  const result=s.gateway.fetchSmartmoney(1).catch(e=>e);await vi.advanceTimersByTimeAsync(50);
  expect(await result).toMatchObject({name:'DeadlineError'});reject(limited());await vi.advanceTimersByTimeAsync(0);
  expect(s.gateway.isBanned).toBe(true);expect(s.gateway.limitState.effectiveRate).toBe(8);
});
it('rejects impossible capacity promptly and releases background reservation on admission failure',async()=>{
  const send=vi.fn(async()=>[]),s=setup({getFollowWallet:send,getTokenInfo:send},{limiter:new TokenBucket({ratePerSecond:10,capacity:5})});
  await expect(s.gateway.fetchFollowWallet({})).rejects.toThrow('capacity must be at least 10');
  expect(send).not.toHaveBeenCalled();await s.gateway.background().fetchTokenInfo('test');expect(send).toHaveBeenCalledTimes(1);
});
it('handles synchronous transport failures and never disables pacing for the next request',async()=>{
  const send=vi.fn().mockImplementationOnce(()=>{throw limited();}).mockResolvedValue([]);
  const s=setup({getSmartMoney:send});await expect(s.gateway.fetchSmartmoney(1)).rejects.toMatchObject({name:'RateLimitedError'});
  const pending=s.gateway.fetchSmartmoney(1);await vi.advanceTimersByTimeAsync(6000);await pending;expect(send).toHaveBeenCalledTimes(2);
});
it.each(['null','not-json'])('preserves 429 and Retry-After for %s bodies',async body=>{
  vi.useFakeTimers();vi.setSystemTime(epoch);
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(body,{status:429,headers:{'retry-after':'30','x-ratelimit-reset':String(epoch/1000+10)}})));
  const client=new OpenApiClient({apiKey:'fake',host:'https://example.invalid',autoRetryOnRateLimit:false});
  await expect(client.getSmartMoney('sol',1)).rejects.toMatchObject({status:429,resetAtUnix:epoch/1000+30});
});
it('recognizes business code 429 and enforces a future cooldown for stale reset timestamps',async()=>{
  const s=setup({getSmartMoney:async()=>{throw Object.assign(new Error('limited'),{status:200,apiCode:429,resetAtUnix:epoch/1000-30});}});
  await expect(s.gateway.fetchSmartmoney(1)).rejects.toMatchObject({name:'RateLimitedError'});
  expect(s.gateway.bannedUntil).toBe(epoch+1000);
});

it('admits background work behind existing traffic before newly arriving foreground traffic',async()=>{
  const starts:Array<[string,number]>=[];
  const s=setup({getFollowWallet:async()=>{starts.push(['follow',Date.now()-epoch]);return [];},getTokenKline:async()=>{starts.push(['background',Date.now()-epoch]);return [];}});
  const first=s.gateway.fetchFollowWallet({});
  const back=s.gateway.background().fetchKline('test','1m',0,1);
  const later=Array.from({length:12},()=>s.gateway.fetchFollowWallet({}));
  await vi.advanceTimersByTimeAsync(1000);
  expect(starts).toEqual([['follow',0],['background',1000]]);
  await vi.advanceTimersByTimeAsync(13000);await Promise.all([first,back,...later]);
  expect(starts[2]).toEqual(['follow',1200]);
});
it('cancels an expired background slot without allowing successors to bypass preceding requests',async()=>{
  const times:number[]=[],kline=vi.fn(async()=>[]);
  const s=setup({getFollowWallet:async()=>{times.push(Date.now()-epoch);return [];},getTokenKline:kline});
  const before=Array.from({length:13},()=>s.gateway.fetchFollowWallet({}));
  const back=s.gateway.background().fetchKline('test','1m',0,1).catch(e=>e);
  const after=s.gateway.fetchFollowWallet({});
  await vi.advanceTimersByTimeAsync(10000);expect(await back).toBeInstanceOf(BackgroundBusyError);
  await vi.advanceTimersByTimeAsync(4000);await Promise.all([...before,after]);
  expect(kline).not.toHaveBeenCalled();expect(times).toEqual(Array.from({length:14},(_,i)=>i*1000));
  await s.gateway.background().fetchKline('test','1m',0,1);expect(kline).toHaveBeenCalledTimes(1);
});
it('retains the background one-weight-per-second ceiling across fair admissions',async()=>{
  const times:number[]=[];const s=setup({getTokenKline:async()=>{times.push(Date.now()-epoch);return [];}});
  await s.gateway.background().fetchKline('test','1m',0,1);
  const second=s.gateway.background().fetchKline('test','1m',0,1);
  await vi.advanceTimersByTimeAsync(1999);expect(times).toEqual([0]);
  await vi.advanceTimersByTimeAsync(1);await second;expect(times).toEqual([0,2000]);
});
