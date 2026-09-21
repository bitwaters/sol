import {afterEach,describe,it,expect,vi} from 'vitest';
import {scenario,config,log} from './review-fixture.js';
import {evaluateToken,revalidateSignalForSend} from '../src/signal/candidate.js';
import {Pusher,loadSignalView} from '../src/telegram/pusher.js';
import {runExitMonitor,exitChanges} from '../src/telegram/exit-monitor.js';
import {getKv,setKv,type Db} from '../src/store/db.js';
import {adminRecipients} from '../src/telegram/routing.js';
import {createBot} from '../src/telegram/bot.js';
import {researchSummary,researchDetails} from '../src/research/summary.js';
import {sendOpsAlerts} from '../src/ops/alerts.js';
import {updateMessage} from '../src/telegram/updates.js';
const dbs:Db[]=[];afterEach(()=>{for(const db of dbs.splice(0))db.close();});
async function setup(){
  const s=scenario();dbs.push(s.db);const at=Math.floor(s.deps.now()/1000);
  let messageId=100;
  const sender={sendMessage:vi.fn(async(..._args:any[])=>({message_id:messageId++})),editMessageText:vi.fn()};
  const initial=await evaluateToken(s.deps,'T');
  const pusher=new Pusher({...s.deps,sender,chatId:'channel',revalidate:id=>revalidateSignalForSend(s.deps,id)});
  expect((await pusher.runOnce()).sent).toBe(1);
  const id=initial.signalId!;sender.sendMessage.mockClear();return {...s,sender,id,at};
}
function queue(s:Awaited<ReturnType<typeof setup>>,payload:object={}){
  const rev=(s.db.prepare('SELECT message_revision n FROM signals WHERE id=?').get(s.id) as {n:number}).n+1;
  s.db.prepare('UPDATE signals SET message_revision=? WHERE id=?').run(rev,s.id);
  s.db.prepare("INSERT INTO push_tasks(signal_id,kind,revision,dedupe_key,payload,status,created_at,updated_at) VALUES (?,'escalate',?,?,?,'pending',?,?)")
    .run(s.id,rev,`update${rev}`,JSON.stringify(payload),s.at,s.at);
}
function close(s:Awaited<ReturnType<typeof setup>>,wallet:string,at:number){s.db.prepare("UPDATE wallet_positions SET state='closed',sold_amount=bought_amount,last_sell_ts=? WHERE wallet=?").run(at,wallet);}
function push(s:Awaited<ReturnType<typeof setup>>,check?:()=>Promise<any>){return new Pusher({...s.deps,sender:s.sender,chatId:'channel',...(check?{revalidateUpdate:check}:{})}).runOnce();}

describe('immutable originals and referenced state events',()=>{
  it.each([10,1900])('sends an independent reply at +%s seconds and keeps original identity and snapshot',async offset=>{
    const s=await setup(),before=s.db.prepare('SELECT tg_message_id,sent_at,send_snapshot FROM signals WHERE id=?').get(s.id);
    s.setNow(s.at+offset);s.db.prepare('UPDATE signals SET wallet_count=5 WHERE id=?').run(s.id);queue(s);
    expect((await push(s)).sent).toBe(1);expect(s.sender.editMessageText).not.toHaveBeenCalled();
    expect(s.sender.sendMessage.mock.calls[0]?.[1]).toContain('达到强共识');
    expect(s.sender.sendMessage.mock.calls[0]?.[2]).toMatchObject({reply_parameters:{message_id:100}});
    expect(s.db.prepare('SELECT tg_message_id,sent_at,send_snapshot FROM signals WHERE id=?').get(s.id)).toEqual(before);
    queue(s);expect((await push(s)).sent).toBe(0); // repeated identical update does not notify
  });
  it('ordinary price movements do not become consensus enhancements',async()=>{
    const s=await setup();s.db.prepare('UPDATE tokens SET price=1.2').run();queue(s);
    expect((await push(s)).sent).toBe(0);
    const v=loadSignalView(s.db,s.id,s.at)!;
    expect(updateMessage({...v,votes:3},{votes:4,holding:v.retentionRatio,condition:'qualified',reason:null},null,s.at,5).text).toContain('共识减弱');
  });
  it('rechecks an enhancement and reports unavailable evidence instead of green consensus',async()=>{
    const s=await setup();s.db.prepare('UPDATE signals SET wallet_count=5 WHERE id=?').run(s.id);queue(s);
    expect((await push(s,async()=>({ok:false,reason:'integrity_gap'}))).sent).toBe(1);
    const text=s.sender.sendMessage.mock.calls[0]?.[1];expect(text).toContain('数据暂不可核验');expect(text).not.toContain('共识增强');
  });
  it('merges concurrent bound and other exits, supersedes the queued enhancement and deduplicates',async()=>{
    const s=await setup();s.setNow(s.at+5);close(s,'w1',s.at+1);
    s.buy('other1',s.at+1);s.buy('other2',s.at+1);close(s,'other1',s.at+2);close(s,'other2',s.at+3);
    queue(s);expect((await push(s)).sent).toBe(1);
    expect(s.sender.sendMessage.mock.calls[0]?.[1]).toContain('本次新增共识退出：1');
    expect(s.sender.sendMessage.mock.calls[0]?.[1]).toContain('本次新增其他钱包退出：2');
    expect(s.sender.sendMessage.mock.calls[0]?.[2]).toMatchObject({reply_parameters:{message_id:100}});
    expect((await push(s)).sent).toBe(0);
    close(s,'w2',s.at+4);expect((await push(s)).sent).toBe(1); // subsequent new exit is not lost
    expect(s.sender.sendMessage.mock.calls[1]?.[1]).toContain('本次新增共识退出：1');
  });
  it('labels late historical closure as correction and preserves immediate genuine exits',async()=>{
    const s=await setup();s.setNow(s.at+4);close(s,'w1',s.at-2);
    expect((await push(s)).sent).toBe(1);expect(s.sender.sendMessage.mock.calls[0]?.[1]).toContain('历史状态更正');
    close(s,'w2',s.at+1);expect((await push(s)).sent).toBe(1);
    expect(s.sender.sendMessage.mock.calls[1]?.[1]).toContain('本次新增共识退出：1');
  });
  it('rebuild reopening before delivery cancels pending exits',async()=>{
    const s=await setup();s.setNow(s.at+5);close(s,'w1',s.at+1);expect(runExitMonitor(s.deps)).toBe(1);
    s.db.prepare("UPDATE wallet_positions SET state='open',sold_amount='0' WHERE wallet='w1'").run();
    expect((await push(s)).sent).toBe(0);expect(s.sender.sendMessage).not.toHaveBeenCalled();
  });
  it('does not publish exits without an original message to reference',async()=>{
    const s=await setup();close(s,'w1',s.at+1);s.db.prepare('UPDATE signals SET tg_message_id=NULL WHERE id=?').run(s.id);
    expect(exitChanges(s.db,s.deps.config,s.id,s.at+3).keys).toEqual([]);
  });
  it('a failed exit send is retried with fresh state and no premature acknowledgement',async()=>{
    const s=await setup();s.setNow(s.at+5);close(s,'w1',s.at+1);s.sender.sendMessage.mockRejectedValueOnce(new Error('network'));
    expect((await push(s)).failed).toBe(1);expect(getKv(s.db,`exit_events:${s.id}`)).toBeNull();
    s.db.prepare("UPDATE wallet_positions SET state='open',sold_amount='0' WHERE wallet='w1'").run();s.setNow(s.at+100);
    expect((await push(s)).sent).toBe(0);
  });
});

it('routes management only to distinct positive admin identities',()=>{
  expect(adminRecipients(['7','7','-100123','bad','8'],'-100123')).toEqual(['7','8']);
  expect(adminRecipients(['7'],'7')).toEqual([]);
});
it('does not reply to commands in channel/group even for an administrator',async()=>{
  const s=await setup();const bot=createBot('fake',{db:s.db,config,logger:log,adminIds:['7']});
  bot.botInfo={id:10,is_bot:true,first_name:'test',username:'test_bot'} as never;
  const calls:string[]=[];bot.api.config.use(async(_,method)=>{calls.push(method);return {ok:true,result:true} as never;});
  await bot.handleUpdate({update_id:1,message:{message_id:1,date:s.at,from:{id:7,is_bot:false,first_name:'a'},chat:{id:-100,type:'supergroup',title:'test'},text:'/stats',entities:[{type:'bot_command',offset:0,length:6}]}});
  expect(calls).toEqual([]);
});
it('research summary selects the active version even before its first sample and separates detail pages',async()=>{
  const s=await setup();setKv(s.db,'active_research_scope',{config_version:'new',rules_version:'new',research_version:'new'});
  const text=researchSummary(s.db,s.at);expect(text).toContain('首次独立代币：0');expect(text).toContain('尚未到期');expect(text.length).toBeLessThan(1500);
  expect(researchDetails(s.db,'history')).toContain('历史版本');expect(researchDetails(s.db,'quality')).toContain('数据质量');
});
it('ops alerts and recovery are deduplicated independently for each administrator',async()=>{
  const s=await setup();setKv(s.db,'service_started_at',s.at-1000);setKv(s.db,'enabled_sources',['smartmoney']);
  const a={db:s.db,sender:s.sender,logger:log,nowSec:s.at};
  expect(await sendOpsAlerts({...a,chatId:'7'})).toBe(1);expect(await sendOpsAlerts({...a,chatId:'8'})).toBe(1);
  expect(await sendOpsAlerts({...a,chatId:'7'})).toBe(0);
  s.db.prepare("INSERT INTO source_health(source,last_success_at) VALUES ('smartmoney',?) ON CONFLICT(source) DO UPDATE SET last_success_at=excluded.last_success_at").run(s.at);
  expect(await sendOpsAlerts({...a,chatId:'7'})).toBe(1);expect(s.sender.sendMessage.mock.calls.at(-1)?.[1]).toContain('异常已解除');
  expect(await sendOpsAlerts({...a,chatId:'7'})).toBe(0);
});

it('unpublished new members are not presented as original consensus exits',async()=>{
  const s=await setup();s.setNow(s.at+5);s.buy('new',s.at+1);close(s,'new',s.at+2);
  s.db.prepare("INSERT INTO signal_wallets(signal_id,wallet,cycle_no,cluster_id,joined_version,joined_at) VALUES (?,'new',1,'c9',1,?)").run(s.id,s.at+1);
  expect(exitChanges(s.db,s.deps.config,s.id,s.at+5).consensus).toBe(0);
  setKv(s.db,`published_member_version:${s.id}`,1);
  expect(exitChanges(s.db,s.deps.config,s.id,s.at+5).consensus).toBe(1);
});
it('an enhancement recheck does not rewrite original membership or first-send data',async()=>{
  const s=await setup(),before=s.db.prepare('SELECT * FROM signal_wallets WHERE signal_id=?').all(s.id);
  const original=s.db.prepare('SELECT tg_message_id,sent_at,send_snapshot FROM signals WHERE id=?').get(s.id);
  expect((await revalidateSignalForSend(s.deps,s.id,true)).ok).toBe(true);
  expect(s.db.prepare('SELECT * FROM signal_wallets WHERE signal_id=?').all(s.id)).toEqual(before);
  expect(s.db.prepare('SELECT tg_message_id,sent_at,send_snapshot FROM signals WHERE id=?').get(s.id)).toEqual(original);
});
