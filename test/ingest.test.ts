import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/store/db.js';
import { normalizeTrackResponse } from '../src/ingest/normalize.js';
import { countTradeSources, countTrades, upsertTrades } from '../src/store/repo/trades.js';
import smartmoneyFixture from './fixtures/smartmoney.json' with { type: 'json' };
import kolFixture from './fixtures/kol.json' with { type: 'json' };

describe('normalizeTrackResponse', () => {
  it('归一化 smartmoney fixture 且事件键唯一', () => {
    const trades = normalizeTrackResponse('smartmoney', smartmoneyFixture);
    expect(trades.length).toBeGreaterThan(0);
    const keys = new Set(trades.map((t) => t.eventId));
    expect(keys.size).toBe(trades.length);
  });

  it('保留可读数量与行为提示', () => {
    const trades = normalizeTrackResponse('smartmoney', smartmoneyFixture);
    const sample = trades[0];
    expect(sample?.rawAmountUnit).toBe('human');
    expect(sample?.amountNormalized).toBe(sample?.rawAmount);
    expect(sample?.chain).toBe('sol');
    // kol/smartmoney 的 is_open_or_close 二义 → action_hint 为 null
    expect(sample?.actionHint).toBeNull();
  });

  it('follow 来源行为提示按全开/全平映射', () => {
    const trades = normalizeTrackResponse('follow', {
      list: [
        {
          transaction_hash: 'tx1',
          maker: 'm1',
          side: 'buy',
          base_address: 't1',
          timestamp: 100,
          token_amount: '10',
          quote_amount: '1',
          is_open_or_close: 1,
        },
        {
          transaction_hash: 'tx2',
          maker: 'm1',
          side: 'sell',
          base_address: 't1',
          timestamp: 200,
          token_amount: '5',
          quote_amount: '1',
          is_open_or_close: 0,
        },
      ],
    });
    expect(trades[0]?.actionHint).toBe('full_open');
    expect(trades[1]?.actionHint).toBe('reduce');
  });
});

describe('upsertTrades（去重与多来源）', () => {
  it('重复写入不重复计金额，跨来源只追加观测', () => {
    const db = openDatabase({ path: ':memory:' });
    const smart = normalizeTrackResponse('smartmoney', smartmoneyFixture);
    const first = upsertTrades(db, 'smartmoney', smart);
    expect(first.insertedEvents).toBe(smart.length);
    expect(countTrades(db)).toBe(smart.length);
    expect(countTradeSources(db)).toBe(smart.length);

    // 同批重复写入 → 无新增
    const again = upsertTrades(db, 'smartmoney', smart);
    expect(again.insertedEvents).toBe(0);
    expect(again.newSourceObservations).toBe(0);

    // 另一来源写入 → 事件不重复，来源观测增加
    const kol = normalizeTrackResponse('kol', kolFixture);
    const kolResult = upsertTrades(db, 'kol', kol);
    expect(kolResult.newSourceObservations).toBe(kol.length);
    expect(countTrades(db)).toBe(smart.length + kolResult.insertedEvents);
    expect(countTradeSources(db)).toBe(smart.length + kol.length);
    db.close();
  });
});
