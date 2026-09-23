import { afterEach, describe, expect, it, vi } from 'vitest';
import { EvaluationScheduler } from '../src/signal/scheduler.js';
import { GmgnGateway } from '../src/ingest/gateway.js';
import { BanGate, TokenBucket } from '../src/ingest/limiter.js';
import type { OpenApiClient } from '../src/gmgn/OpenApiClient.js';
import { evaluateToken } from '../src/signal/candidate.js';
import { scenario } from './review-fixture.js';

afterEach(() => vi.useRealTimers());

describe('SEA startup regression', () => {
  it('raw wallet upper bound below threshold performs no remote enrichment', async () => {
    const s = scenario();
    try {
      s.db.prepare("DELETE FROM trades WHERE maker <> 'w1'").run();
      const tokenInfo = vi.spyOn(s.deps.gateway, 'fetchTokenInfo');
      const stats = vi.spyOn(s.deps.gateway, 'fetchWalletStats');
      expect(await evaluateToken(s.deps, 'T')).toMatchObject({ status: 'watching', pushTaskCreated: false });
      expect(tokenInfo).not.toHaveBeenCalled();
      expect(stats).not.toHaveBeenCalled();
    } finally { s.db.close(); }
  });

  it('candidate meeting raw threshold still receives full enrichment', async () => {
    const s = scenario();
    try {
      const tokenInfo = vi.spyOn(s.deps.gateway, 'fetchTokenInfo');
      await evaluateToken(s.deps, 'T');
      expect(tokenInfo).toHaveBeenCalled();
    } finally { s.db.close(); }
  });

  it.each([2,4])('coalesces duplicate tokens and bounds evaluations to %i concurrent slots', async concurrency => {
    vi.useFakeTimers();
    const releases = new Map<string, () => void>();
    const started: string[] = [];
    const scheduler = new EvaluationScheduler({ concurrency, delayMs: 250,
      run: token => { started.push(token); return new Promise<void>(resolve => releases.set(token, resolve)); }, onError: vi.fn() });
    const tokens=Array.from({length:concurrency+1},(_,i)=>String(i));
    for(const token of tokens)scheduler.schedule(token);
    scheduler.schedule('0');
    await vi.advanceTimersByTimeAsync(250);
    expect(started).toEqual(tokens.slice(0,concurrency));
    expect(scheduler.snapshot()).toMatchObject({pending:1,active:concurrency});
    releases.get('0')!();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(tokens);
    expect(scheduler.snapshot()).toMatchObject({pending:0,active:concurrency});
    for(const token of tokens.slice(1))releases.get(token)!();
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.snapshot()).toMatchObject({pending:0,active:0});
    scheduler.stop();
  });

  it('a failed evaluation releases its slot; stopping drops queued work', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const run = vi.fn(async (token: string) => { if (token === 'a') throw new Error('test'); });
    const scheduler = new EvaluationScheduler({ concurrency: 1, delayMs: 250, run, onError });
    scheduler.schedule('a'); scheduler.schedule('b');
    await vi.advanceTimersByTimeAsync(250);
    expect(run.mock.calls.map(call => call[0])).toEqual(['a', 'b']);
    expect(onError).toHaveBeenCalledTimes(1);
    scheduler.schedule('c'); scheduler.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('credits acquired during a ban cannot create a recovery burst', async () => {
    vi.useFakeTimers();
    const limiter = new TokenBucket({ ratePerSecond: 1, capacity: 1 });
    const banGate = new BanGate();
    const getSmartMoney = vi.fn(async () => []);
    const gateway = new GmgnGateway({ client: { getSmartMoney } as unknown as OpenApiClient, limiter, banGate });
    limiter.tryAcquire(1);
    const first = gateway.fetchSmartmoney(1);
    const second = gateway.fetchSmartmoney(1);
    await vi.advanceTimersByTimeAsync(0);
    banGate.banUntil(Date.now() + 10_000, 'test');
    await vi.advanceTimersByTimeAsync(9999);
    expect(getSmartMoney).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(getSmartMoney).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([first, second]);
    expect(getSmartMoney).toHaveBeenCalledTimes(2);
  });
});
