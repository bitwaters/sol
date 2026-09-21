import { afterEach, describe, expect, it, vi } from 'vitest';
import { scenario } from './review-fixture.js';
import { evaluateToken, revalidateSignalForSend } from '../src/signal/candidate.js';
import { Pusher } from '../src/telegram/pusher.js';
import { milestoneElapsed, milestoneProgress, milestoneMessage, milestoneText, observeMilestones } from '../src/telegram/milestones.js';
import { getKv, setKv, type Db } from '../src/store/db.js';
import { TelegramDeliveryUnknownError, TelegramRateLimitError } from '../src/telegram/types.js';
import { collectOpsAlerts } from '../src/ops/alerts.js';
import { signalStatsSummary } from '../src/backtest/report.js';
const dbs: Db[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
async function setup() {
  const s = scenario(); s.deps.config = structuredClone(s.deps.config); dbs.push(s.db);
  let messageId = 100;
  const sender = { sendMessage: vi.fn(async (..._args: any[]) => ({ message_id: messageId++ })),
    editMessageText: vi.fn(async (..._args: any[]) => {}), deleteMessage: vi.fn(async (..._args: any[]) => {}) };
  const initial = await evaluateToken(s.deps, 'T');
  const run = () => new Pusher({ ...s.deps, sender, chatId: 'channel', revalidate: id => revalidateSignalForSend(s.deps, id) }).runOnce();
  expect((await run()).sent).toBe(1);
  sender.sendMessage.mockClear();
  const id = initial.signalId!, at = Math.floor(s.deps.now() / 1000);
  const baseline = (s.db.prepare('SELECT price_at_send p FROM signals WHERE id=?').get(id) as {p:string}).p;
  const quote = (multiple: number, elapsed: number, timestamp = at + elapsed) => {
    s.setNow(at + elapsed);
    s.db.prepare('UPDATE tokens SET price=?,price_updated_at=? WHERE address=?').run(String(Number(baseline) * multiple), timestamp, 'T');
  };
  return { ...s, sender, id, at, run, quote };
}

describe('milestone observations and summary replacement', () => {
  it('starts at 1.5, records every integer and elapsed time, replaces only its previous summary', async () => {
    const s = await setup();
    const before = s.db.prepare('SELECT tg_message_id,sent_at,price_at_send,send_snapshot FROM signals WHERE id=?').get(s.id);
    s.quote(1.49, 7); expect((await s.run()).sent).toBe(0);
    s.quote(1.5, 10); expect((await s.run()).sent).toBe(1);
    expect(s.sender.sendMessage.mock.calls[0]?.[2]).toMatchObject({reply_parameters:{message_id:100}});
    expect(s.sender.sendMessage.mock.calls[0]?.[1]).toContain('1.5× · 10秒');
    expect(s.sender.deleteMessage).not.toHaveBeenCalled();
    s.quote(2, 20); expect((await s.run()).sent).toBe(0);
    s.quote(4.2, 30); expect((await s.run()).sent).toBe(0);
    s.quote(3.7, 71); expect((await s.run()).sent).toBe(1);
    expect(s.sender.sendMessage.mock.calls[1]?.[1]).toContain('已观测达到 4×');
    expect(s.sender.deleteMessage).toHaveBeenCalledExactlyOnceWith('channel', 101);
    expect(s.sender.sendMessage.mock.invocationCallOrder[1]).toBeLessThan(s.sender.deleteMessage.mock.invocationCallOrder[0]!);
    expect(milestoneMessage(s.db,s.id)?.messageId).toBe(102);
    const progress = milestoneProgress(s.db,s.id)!;
    expect([1.5,2,3,4].map(t => milestoneElapsed(progress,t))).toEqual([10,20,30,30]);
    expect(s.db.prepare('SELECT tg_message_id,sent_at,price_at_send,send_snapshot FROM signals WHERE id=?').get(s.id)).toEqual(before);
    expect(s.sender.editMessageText).not.toHaveBeenCalled();
    s.quote(4, 200); expect((await s.run()).sent).toBe(0);
    expect(s.sender.sendMessage).toHaveBeenCalledTimes(2);
    expect(signalStatsSummary(s.db,s.at+200)).toContain('3× 1条');
  });
  it('handles a large jump without expanding every integer and keeps the message short', async () => {
    const s = await setup();s.quote(10000,5);await s.run();
    const p=milestoneProgress(s.db,s.id)!;
    expect(p.ranges).toHaveLength(1);
    expect(milestoneElapsed(p,1234)).toBe(5);
    expect(milestoneText(s.id,'T',p)).toContain('9997×');
    expect(milestoneText(s.id,'T',p).length).toBeLessThan(400);
    expect(s.sender.sendMessage).toHaveBeenCalledTimes(1);
  });
  it.each(['0','-1','NaN','Infinity','bad'])('rejects invalid prices %s', async value => {
    const s=await setup();s.quote(2,5);s.db.prepare('UPDATE tokens SET price=?').run(value);
    expect((await s.run()).sent).toBe(0);expect(milestoneProgress(s.db,s.id)?.highest??1).toBe(1);
  });
  it('rejects stale, future and pre-publication prices and stops observing after 24 hours', async () => {
    const s=await setup();
    for (const [elapsed,ts] of [[100,s.at+1],[5,s.at+6],[5,s.at-1],[86401,s.at+86401]]) {
      s.quote(2,elapsed!,ts);expect((await s.run()).sent).toBe(0);
    }
    expect(s.sender.sendMessage).not.toHaveBeenCalled();
  });
  it('does not invent a baseline or change an established baseline', async () => {
    const s=await setup();s.quote(1.5,5);await s.run();
    s.db.prepare("UPDATE signals SET price_at_send='0.01' WHERE id=?").run(s.id);
    s.quote(3,100);expect((await s.run()).sent).toBe(0);expect(milestoneProgress(s.db,s.id)?.highest).toBe(1.5);
    s.db.prepare('DELETE FROM kv WHERE key GLOB ?').run('milestone_*');
    s.db.prepare('UPDATE signals SET price_at_send=NULL WHERE id=?').run(s.id);
    expect((await s.run()).sent).toBe(0);
  });
  it('persists cleanup failure across restart and blocks further sends until deletion succeeds', async () => {
    const s=await setup();s.quote(1.5,5);await s.run();
    s.sender.deleteMessage.mockRejectedValueOnce(new Error('delete denied'));
    s.quote(2,66);await s.run();
    expect(milestoneMessage(s.db,s.id)?.messageId).toBe(102);
    expect(getKv(s.db,`milestone_cleanup:${s.id}`)).toMatchObject({oldId:101,newId:102,attempts:1});
    s.quote(3,80);expect((await s.run()).sent).toBe(0);
    s.quote(3,127);expect((await s.run()).sent).toBe(1);
    expect(s.sender.deleteMessage.mock.calls.map(c=>c[1])).toEqual([101,101,102]);
    expect(getKv(s.db,`milestone_cleanup:${s.id}`)).toBeNull();
    expect(s.sender.sendMessage).toHaveBeenCalledTimes(3);
  });
  it('alerts after bounded deletion retries and never removes the original or exit summary', async () => {
    const s=await setup();setKv(s.db,`exit_message:${s.id}`,{messageId:777,chatId:'channel',updatedAt:s.at});
    s.quote(1.5,5);await s.run();s.sender.deleteMessage.mockRejectedValue(new Error('denied'));
    s.quote(2,66);await s.run();s.quote(3,127);await s.run();s.quote(4,248);await s.run();s.quote(5,500);await s.run();
    expect(s.sender.sendMessage).toHaveBeenCalledTimes(2);
    expect(s.sender.deleteMessage.mock.calls.map(c=>c[1])).toEqual([101,101,101]);
    expect(collectOpsAlerts(s.db,{nowSec:s.at+500}).some(a=>a.kind==='milestone_cleanup_failed')).toBe(true);
  });
  it('a failed replacement send retains the old message and retries after 429', async () => {
    const s=await setup();s.quote(1.5,5);await s.run();
    s.sender.sendMessage.mockRejectedValueOnce(new TelegramRateLimitError(20));
    s.quote(2,66);expect((await s.run()).failed).toBe(1);expect(s.sender.deleteMessage).not.toHaveBeenCalled();
    s.quote(3,70);expect((await s.run()).sent).toBe(0);
    s.quote(3,87);expect((await s.run()).sent).toBe(1);
    expect(s.sender.deleteMessage).toHaveBeenCalledExactlyOnceWith('channel',101);
    expect(milestoneMessage(s.db,s.id)?.multiple).toBe(3);
  });
  it.each([false,true])('never retries an uncertain send (replacement=%s)', async replacement => {
    const s=await setup();if(replacement){s.quote(1.5,5);await s.run();}
    s.sender.sendMessage.mockRejectedValueOnce(new TelegramDeliveryUnknownError());
    s.quote(2,66);await s.run();const calls=s.sender.sendMessage.mock.calls.length;
    s.quote(3,200);await s.run();s.quote(4,400);await s.run();
    expect(s.sender.sendMessage).toHaveBeenCalledTimes(calls);
    expect(s.sender.deleteMessage).not.toHaveBeenCalled();
    expect(collectOpsAlerts(s.db,{nowSec:s.at+400}).some(a=>a.kind==='milestone_delivery_unknown')).toBe(true);
  });
  it('treats interrupted delivery as unknown and does not resend after restart', async () => {
    const s=await setup();s.quote(2,5);observeMilestones(s.db,s.at+5);
    s.db.prepare("UPDATE push_tasks SET status='sending' WHERE kind='milestone'").run();
    s.quote(3,30);await s.run();expect(s.sender.sendMessage).not.toHaveBeenCalled();
    expect(s.db.prepare("SELECT status,attempts=max_attempts exhausted FROM push_tasks WHERE kind='milestone'").get()).toEqual({status:'unknown',exhausted:1});
  });
  it('keeps recording when paused or muted and sends one combined summary after resume', async () => {
    const s=await setup();setKv(s.db,'paused',true);s.quote(2,5);await s.run();
    expect(milestoneProgress(s.db,s.id)?.highest).toBe(2);expect(s.sender.sendMessage).not.toHaveBeenCalled();
    setKv(s.db,'paused',false);setKv(s.db,'mute:T',true);s.quote(3,65);await s.run();expect(s.sender.sendMessage).not.toHaveBeenCalled();
    setKv(s.db,'mute:T',{until:0});s.quote(4,100);await s.run();expect(s.sender.sendMessage).toHaveBeenCalledTimes(1);
  });
});

it('never promotes a missing original baseline after historical repair', async () => {
  const s=await setup();s.db.prepare('UPDATE signals SET price_at_send=NULL WHERE id=?').run(s.id);
  s.db.prepare('DELETE FROM kv WHERE key=?').run(`milestone_baseline:${s.id}`);
  s.quote(2,5);await s.run();
  s.db.prepare("UPDATE signals SET price_at_send='1' WHERE id=?").run(s.id);
  s.quote(3,70);await s.run();expect(s.sender.sendMessage).not.toHaveBeenCalled();
});

it('a pending replacement still counts its last send against the global minute budget', async () => {
  const s=await setup();s.deps.config.push.maxPerMinute=1;
  s.quote(1.5,70);await s.run();
  // Model a second already-observed signal that shares the channel budget.
  s.db.prepare("INSERT INTO signals(id,token,status,triggered_at,sent_at,price_at_send,tg_message_id,tg_chat_id) SELECT 999,token,'pushed',triggered_at,sent_at,price_at_send,999,'channel' FROM signals WHERE id=?").run(s.id);
  s.quote(2,80);await s.run();
  expect(s.sender.sendMessage).toHaveBeenCalledTimes(1);
});

it('blocks deletion when a corrupted cleanup record points to the original signal', async () => {
  const s=await setup();s.quote(1.5,5);await s.run();
  setKv(s.db,`milestone_cleanup:${s.id}`,{signalId:s.id,oldId:100,newId:101,chatId:'channel',attempts:0,nextAt:s.at+5});
  s.quote(2,70);await s.run();
  expect(s.sender.deleteMessage).not.toHaveBeenCalled();expect(s.sender.sendMessage).toHaveBeenCalledTimes(1);
});
