import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/store/db.js';
import { normalizeTrackItem } from '../src/ingest/normalize.js';
import { upsertTrades } from '../src/store/repo/trades.js';
import { evaluateOutcomes, pickCompletedCandle } from '../src/backtest/evaluate.js';
import { sampleControls } from '../src/backtest/control.js';
import { buildStatsReport } from '../src/backtest/report.js';
import { createLogger } from '../src/logger.js';

const silent = createLogger({ test: true });
silent.info = () => undefined;
silent.warn = () => undefined;
silent.error = () => undefined;
silent.debug = () => undefined;

const loaded = loadConfig({ skipDotenv: true, env: { GMGN_API_KEY: 'test' } });

describe('M4-1 回测取价', () => {
  it('取收盘时间不晚于目标时点的最近已完成 K 线，并应用容差', () => {
    const candles = [
      { timeMs: 1_000_000, close: 1.0 },
      { timeMs: 1_060_000, close: 1.1 },
    ];
    // 目标 1_120_000，1m 分辨率：最近已收盘 = 1_060_000+60_000=1_120_000，偏差 0
    const picked = pickCompletedCandle(candles, 1_120_000, 60_000, 120_000);
    expect(picked?.close).toBe(1.1);
    // 目标远超最近收盘且偏差超过容差 → 视为缺行情
    const far = pickCompletedCandle(candles, 1_500_000, 60_000, 120_000);
    expect(far).toBeNull();
  });

  it('已推送信号按 sent_at 取价并写入 outcome', async () => {
    const db = openDatabase({ path: ':memory:' });
    const nowSec = Math.floor(Date.now() / 1000);
    const sentAt = nowSec - 400;
    db.prepare(
      `INSERT INTO signals (token, triggered_at, sent_at, status, price_at_send)
       VALUES ('TK', ?, ?, 'pushed', '1')`,
    ).run(sentAt - 60, sentAt);

    const targetMs = (sentAt + 300) * 1000;
    const gateway = {
      fetchKline: async (_a: string, resolution: string) => {
        if (resolution !== '1m') return { list: [] };
        return {
          list: [{ time: targetMs - 60_000, close: '1.25' }],
        };
      },
    };
    const result = await evaluateOutcomes({ db, config: loaded.config, gateway, logger: silent, now: () => nowSec * 1000 });
    expect(result.evaluated).toBe(1);
    const row = db.prepare('SELECT outcome_5m FROM signals').get() as { outcome_5m: number | null };
    expect(row.outcome_5m).toBeCloseTo(1.25);
    db.close();
  });
});

describe('M4-2 对照采样', () => {
  it('对恰好 2 票的 token 采样一次', () => {
    const db = openDatabase({ path: ':memory:' });
    const nowSec = Math.floor(Date.now() / 1000);
    for (const [maker, tx] of [['w1', 'c1'], ['w2', 'c2']] as const) {
      const trade = normalizeTrackItem('smartmoney', {
        transaction_hash: tx,
        maker,
        base_address: 'CTRL',
        side: 'buy',
        timestamp: nowSec - 60,
        token_amount: '1000',
        quote_amount: '1',
        amount_usd: 1000,
      });
      upsertTrades(db, 'smartmoney', [trade!]);
    }
    db.prepare("INSERT INTO tokens (address, price) VALUES ('CTRL', '0.5')").run();

    const created = sampleControls({
      db,
      config: loaded.config,
      logger: silent,
      blacklist: { entries: new Map() },
      now: () => nowSec * 1000,
    });
    expect(created).toBe(1);
    const again = sampleControls({
      db,
      config: loaded.config,
      logger: silent,
      blacklist: { entries: new Map() },
      now: () => nowSec * 1000,
    });
    expect(again).toBe(0); // 采样间隔内不重复
    const row = db.prepare("SELECT status, price_at_trigger FROM signals WHERE status='control'").get() as {
      status: string;
      price_at_trigger: string;
    };
    expect(row.price_at_trigger).toBe('0.5');
    db.close();
  });
});

describe('M4-3 统计报告', () => {
  it('对照不足时明确"无法验证"，且不报告胜率', () => {
    const db = openDatabase({ path: ':memory:' });
    db.prepare(
      `INSERT INTO signals (token, triggered_at, status, wallet_count, outcome_1h)
       VALUES ('A', 1000, 'pushed', 4, 1.4)`,
    ).run();
    const report = buildStatsReport(db, loaded.config);
    expect(report.text).toContain('对照样本不足，无法验证');
    expect(report.text).toContain('不报告策略胜率');
    expect(report.controlSufficient).toBe(false);
    expect(report.coverage).toBeCloseTo(1);
    db.close();
  });
});
