import { describe, expect, it } from 'vitest';
import type { OpenApiClient } from '../src/gmgn/OpenApiClient.js';
import { BanGate, TokenBucket } from '../src/ingest/limiter.js';
import { GmgnGateway, RateLimitedError } from '../src/ingest/gateway.js';

describe('TokenBucket', () => {
  it('容量内同步放行', () => {
    const bucket = new TokenBucket({ ratePerSecond: 20, capacity: 20 });
    expect(bucket.tryAcquire(1)).toBe(true);
    expect(bucket.tryAcquire(3)).toBe(true);
    expect(bucket.available).toBeLessThan(17);
  });

  it('超过容量后按速率等待补充', async () => {
    const bucket = new TokenBucket({ ratePerSecond: 50, capacity: 1 });
    const start = Date.now();
    await bucket.acquire(1); // 用掉容量
    await bucket.acquire(1); // 等 ~20ms
    await bucket.acquire(1); // 再等 ~20ms
    expect(Date.now() - start).toBeGreaterThanOrEqual(30);
  });

  it('高权重请求会阻塞后续请求（共享预算）', async () => {
    const bucket = new TokenBucket({ ratePerSecond: 100, capacity: 5 });
    const order: number[] = [];
    const first = bucket.acquire(5).then(() => order.push(1));
    const second = bucket.acquire(1).then(() => order.push(2));
    await Promise.all([first, second]);
    expect(order).toEqual([1, 2]);
  });
});

describe('BanGate', () => {
  it('封禁期内等待到恢复时间', async () => {
    const gate = new BanGate();
    gate.banUntil(Date.now() + 60, 'RATE_LIMIT_BANNED');
    expect(gate.isBanned).toBe(true);
    const start = Date.now();
    await gate.waitIfBanned();
    expect(Date.now() - start).toBeGreaterThanOrEqual(50);
    expect(gate.isBanned).toBe(false);
  });

  it('只延长不缩短', () => {
    const gate = new BanGate();
    const later = Date.now() + 10_000;
    gate.banUntil(later, 'RATE_LIMIT_BANNED');
    gate.banUntil(Date.now() + 1000, 'RATE_LIMIT_EXCEEDED');
    expect(gate.bannedUntil).toBe(later);
  });
});

describe('GmgnGateway', () => {
  it('429 映射为 RateLimitedError 并记录封禁', async () => {
    const resetAtUnix = Math.floor(Date.now() / 1000) + 60;
    const client = {
      getSmartMoney: async () => {
        throw Object.assign(new Error('rate limited'), {
          name: 'OpenApiError',
          apiError: 'RATE_LIMIT_BANNED',
          resetAtUnix,
        });
      },
    } as unknown as OpenApiClient;

    const bucket = new TokenBucket({ ratePerSecond: 20, capacity: 20 });
    const gate = new BanGate();
    const gateway = new GmgnGateway({ client, limiter: bucket, banGate: gate });

    await expect(gateway.fetchSmartmoney(10)).rejects.toBeInstanceOf(RateLimitedError);
    expect(gateway.isBanned).toBe(true);
    expect(gate.bannedUntil).toBe(resetAtUnix * 1000 + 1000);
  });

  it('普通错误原样抛出', async () => {
    const client = {
      getSmartMoney: async () => {
        throw new Error('network down');
      },
    } as unknown as OpenApiClient;

    const gateway = new GmgnGateway({
      client,
      limiter: new TokenBucket({ ratePerSecond: 20, capacity: 20 }),
      banGate: new BanGate(),
    });

    await expect(gateway.fetchSmartmoney(10)).rejects.toThrow('network down');
    expect(gateway.isBanned).toBe(false);
  });
});
