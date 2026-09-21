import { describe, expect, it } from 'vitest';
import { loadConfig, type LoadedConfig } from '../src/config.js';
import { normalizeTrackItem } from '../src/ingest/normalize.js';
import { openDatabase } from '../src/store/db.js';
import { setKv, type Db } from '../src/store/db.js';
import { upsertWalletProfile } from '../src/enrich/wallet.js';
import { upsertTrades } from '../src/store/repo/trades.js';
import { upsertSourceHealth } from '../src/store/repo/health.js';
import { buildClusters } from '../src/signal/cluster.js';
import { evaluateToken } from '../src/signal/candidate.js';
import { applyTrade, getLatestCycle, hasZeroCheckpointBefore } from '../src/signal/positions.js';
import { rebuildWalletToken } from '../src/signal/rebuild.js';
import { validateWallets } from '../src/signal/validate-wallet.js';
import { computeWindow } from '../src/signal/window.js';
import { createLogger } from '../src/logger.js';

const silent = createLogger({ test: true });
silent.info = () => undefined;
silent.warn = () => undefined;
silent.error = () => undefined;
silent.debug = () => undefined;

const loaded: LoadedConfig = loadConfig({
  skipDotenv: true,
  env: { GMGN_API_KEY: 'test' },
});

interface TradeSeed {
  maker: string;
  token: string;
  side: 'buy' | 'sell';
  usd: number;
  amount: number;
  ts: number;
  tx: string;
  tags?: string[];
}

function insertTrade(db: Db, seed: TradeSeed): void {
  const raw = {
    transaction_hash: seed.tx,
    maker: seed.maker,
    base_address: seed.token,
    side: seed.side,
    timestamp: seed.ts,
    token_amount: String(seed.amount),
    quote_amount: '1',
    amount_usd: seed.usd,
    price_usd: '1',
    is_open_or_close: 0,
    balance: '0',
    base_token: { symbol: 'TST', total_supply: '1000000' },
    maker_info: { tags: seed.tags ?? ['smart_degen'] },
  };
  const trade = normalizeTrackItem('smartmoney', raw);
  if (!trade) throw new Error('normalize failed');
  upsertTrades(db, 'smartmoney', [trade]);
}

function seedWallet(db: Db, address: string, opts: { ageDays: number; funder?: string; tags?: string[] }): void {
  const now = Math.floor(Date.now() / 1000);
  upsertWalletProfile(db, {
    address,
    name: null,
    twitter: null,
    tags: opts.tags ?? ['smart_degen'],
    fundFrom: null,
    fundFromAddress: opts.funder ?? null,
    walletCreatedAt: now - opts.ageDays * 86_400,
    refreshedAt: now,
  });
}

const blacklist = { entries: new Map() };
const dust = { tokenCreatedAt: null, observationStartedAt: null, hasRecentGap: false, dustRatio: 0.01 };

describe('M2-1 持仓周期', () => {
  it('清仓后重买开启新周期；灰尘阈值判清仓', () => {
    const db = openDatabase({ path: ':memory:' });
    insertTrade(db, { maker: 'w1', token: 't1', side: 'buy', usd: 100, amount: 100, ts: 1000, tx: 'a' });
    applyTrade(db, normalizeTrackItem('smartmoney', {
      transaction_hash: 'a', maker: 'w1', base_address: 't1', side: 'buy', timestamp: 1000,
      token_amount: '100', quote_amount: '1', amount_usd: 100, balance: '100',
    })!, dust);
    applyTrade(db, normalizeTrackItem('smartmoney', {
      transaction_hash: 'b', maker: 'w1', base_address: 't1', side: 'sell', timestamp: 1100,
      token_amount: '99.5', quote_amount: '1', amount_usd: 99, balance: '0.5',
    })!, dust);
    expect(getLatestCycle(db, 'w1', 't1')?.state).toBe('closed');

    applyTrade(db, normalizeTrackItem('smartmoney', {
      transaction_hash: 'c', maker: 'w1', base_address: 't1', side: 'buy', timestamp: 1200,
      token_amount: '50', quote_amount: '1', amount_usd: 60, balance: '50.5',
    })!, dust);
    const cycle = getLatestCycle(db, 'w1', 't1');
    expect(cycle?.cycleNo).toBe(2);
    expect(cycle?.state).toBe('open');
    db.close();
  });

  it('零余额检查点之前买入 → cost_complete；余额一致但无检查点 → 不完整', () => {
    const db = openDatabase({ path: ':memory:' });
    db.prepare(
      `INSERT INTO position_checkpoints (wallet, token, cycle_no, checked_at, balance, bought_amount, sold_amount, bought_usd, sold_usd, cost_complete, source)
       VALUES ('w2','t2',1,900,'0','0','0','0','0',1,'balance_info')`,
    ).run();
    applyTrade(db, normalizeTrackItem('smartmoney', {
      transaction_hash: 'd', maker: 'w2', base_address: 't2', side: 'buy', timestamp: 1000,
      token_amount: '10', quote_amount: '1', amount_usd: 10, balance: '10',
    })!, dust);
    expect(hasZeroCheckpointBefore(db, 'w2', 't2', 1000)).toBe(true);
    expect(getLatestCycle(db, 'w2', 't2')?.costComplete).toBe(true);

    applyTrade(db, normalizeTrackItem('smartmoney', {
      transaction_hash: 'e', maker: 'w3', base_address: 't2', side: 'buy', timestamp: 1000,
      token_amount: '10', quote_amount: '1', amount_usd: 10, balance: '10',
    })!, dust);
    expect(getLatestCycle(db, 'w3', 't2')?.costComplete).toBe(false);
    db.close();
  });

  it('数量缺失 → incomplete 且不参与计算', () => {
    const db = openDatabase({ path: ':memory:' });
    applyTrade(db, normalizeTrackItem('smartmoney', {
      transaction_hash: 'f', maker: 'w4', base_address: 't3', side: 'buy', timestamp: 1000,
      quote_amount: '1', amount_usd: 10,
    })!, dust);
    const cycle = getLatestCycle(db, 'w4', 't3');
    expect(cycle?.state).toBe('incomplete');
    expect(cycle?.costComplete).toBe(false);
    db.close();
  });
});

describe('M2-2 关联钱包合并', () => {
  it('同资金来源+创建时间接近合并；CEX 资金来源不合并；同 tx 合并', () => {
    const db = openDatabase({ path: ':memory:' });
    const now = Math.floor(Date.now() / 1000);
    seedWallet(db, 'a1', { ageDays: 30, funder: 'F' });
    seedWallet(db, 'a2', { ageDays: 30, funder: 'F' });
    db.prepare(
      `UPDATE wallets SET wallet_created_at = ? WHERE address IN ('a1','a2')`,
    ).run(now - 10 * 60);
    seedWallet(db, 'a3', { ageDays: 30, funder: 'CEX' });
    seedWallet(db, 'a4', { ageDays: 30, funder: 'CEX' });

    const clusters = buildClusters(db, 't1', ['a1', 'a2', 'a3', 'a4'], {
      blacklist: { entries: new Map([['CEX', { address: 'CEX', label: 'binance', type: 'cex' }]]) },
      sameFunder: true,
      creationTimeDeltaMinutes: 60,
      excludeFunderLabels: ['cex'],
    });
    expect(clusters.clusterOf.get('a1')).toBe(clusters.clusterOf.get('a2'));
    expect(clusters.clusterOf.get('a3')).not.toBe(clusters.clusterOf.get('a4'));

    // 同 tx 多钱包
    insertTrade(db, { maker: 'b1', token: 't9', side: 'buy', usd: 500, amount: 1, ts: 1000, tx: 'same' });
    insertTrade(db, { maker: 'b2', token: 't9', side: 'buy', usd: 500, amount: 1, ts: 1000, tx: 'same' });
    const c2 = buildClusters(db, 't9', ['b1', 'b2'], {
      blacklist,
      sameFunder: true,
      creationTimeDeltaMinutes: 60,
      excludeFunderLabels: ['cex'],
    });
    expect(c2.clusterOf.get('b1')).toBe(c2.clusterOf.get('b2'));
    db.close();
  });
});

describe('M2-3 窗口聚合', () => {
  it('计票按金额门槛、净流入含全部买卖', () => {
    const db = openDatabase({ path: ':memory:' });
    const now = Math.floor(Date.now() / 1000);
    insertTrade(db, { maker: 'w1', token: 'tw', side: 'buy', usd: 500, amount: 500, ts: now - 60, tx: 'w1a' });
    const belowFloor = loaded.config.tradeFilter.minTradeAmountUsd / 2;
    insertTrade(db, { maker: 'w2', token: 'tw', side: 'buy', usd: belowFloor, amount: belowFloor, ts: now - 50, tx: 'w2a' });
    insertTrade(db, { maker: 'w2', token: 'tw', side: 'sell', usd: 50, amount: 50, ts: now - 40, tx: 'w2b' });

    const clusters = buildClusters(db, 'tw', ['w1', 'w2'], {
      blacklist,
      sameFunder: true,
      creationTimeDeltaMinutes: 60,
      excludeFunderLabels: ['cex'],
    });
    const win = computeWindow(db, 'tw', now, loaded.config, clusters);
    expect(win.votes).toBe(1); // w2 的买入金额低于当前计票门槛
    expect(win.netInflowUsd.toNumber()).toBe(500 + belowFloor - 50); // 小额买入和卖出仍计入净流入
    db.close();
  });
});

describe('M2-5 钱包层校验', () => {
  function baseScenario(db: Db) {
    const now = Math.floor(Date.now() / 1000);
    setKv(db, 'observation_started_at', now - 7200, now);
    for (const [w, usd] of [['s1', 1500], ['s2', 1500], ['s3', 1500]] as const) {
      seedWallet(db, w, { ageDays: 30, tags: ['smart_degen'] });
      insertTrade(db, { maker: w, token: 'tx', side: 'buy', usd, amount: usd, ts: now - 120, tx: `tx-${w}` });
      db.prepare(
        `INSERT INTO position_checkpoints (wallet, token, cycle_no, checked_at, balance, bought_amount, sold_amount, bought_usd, sold_usd, cost_complete, source)
         VALUES (?, 'tx', 1, ?, '0', '0', '0', '0', '0', 1, 'balance_info')`,
      ).run(w, now - 200);
      applyTrade(db, normalizeTrackItem('smartmoney', {
        transaction_hash: `tx-${w}`, maker: w, base_address: 'tx', side: 'buy', timestamp: now - 120,
        token_amount: String(usd), quote_amount: '1', amount_usd: usd, balance: String(usd),
      })!, { ...dust, tokenCreatedAt: now - 7000, observationStartedAt: now - 7200 });
    }
    return now;
  }

  it('通过：3 票、有建仓、有聪明钱、净流入达标、保留率 100%', () => {
    const db = openDatabase({ path: ':memory:' });
    const now = baseScenario(db);
    const clusters = buildClusters(db, 'tx', ['s1', 's2', 's3'], {
      blacklist, sameFunder: true, creationTimeDeltaMinutes: 60, excludeFunderLabels: ['cex'],
    });
    const win = computeWindow(db, 'tx', now, loaded.config, clusters);
    const result = validateWallets({ db, config: loaded.config, window: win, clusters, hasRecentGap: false, nowSec: now });
    expect(result.status).toBe('pass');
    expect(result.verifiableCount).toBe(3);
    db.close();
  });

  it('可核验钱包不足 → deferred；快进快出 → 剔除', () => {
    const db = openDatabase({ path: ':memory:' });
    const now = baseScenario(db);
    // s2/s3 周期改为不可核验 → 可核验仅 1 个 < minVerifiableWallets(2)
    db.prepare(
      "UPDATE wallet_positions SET cost_complete = 0, state = 'unknown' WHERE wallet IN ('s2','s3')",
    ).run();
    const clusters = buildClusters(db, 'tx', ['s1', 's2', 's3'], {
      blacklist, sameFunder: true, creationTimeDeltaMinutes: 60, excludeFunderLabels: ['cex'],
    });
    const win = computeWindow(db, 'tx', now, loaded.config, clusters);
    const result = validateWallets({ db, config: loaded.config, window: win, clusters, hasRecentGap: false, nowSec: now });
    expect(result.status).toBe('deferred');
    expect(result.verifiableCount).toBe(1);
    db.close();
  });
});

describe('M2-9 周期重建', () => {
  it('迟到事件早于检查点 → 从更早检查点重放；无可靠起点 → 保持 unknown', () => {
    const db = openDatabase({ path: ':memory:' });
    insertTrade(db, { maker: 'r1', token: 'tr', side: 'buy', usd: 100, amount: 100, ts: 2000, tx: 'r1a' });
    // 检查点在 1500，迟到事件在 1800
    db.prepare(
      `INSERT INTO position_checkpoints (wallet, token, cycle_no, checked_at, balance, bought_amount, sold_amount, bought_usd, sold_usd, cost_complete, source)
       VALUES ('r1','tr',1,1500,'0','0','0','0','0',1,'balance_info')`,
    ).run();
    const result = rebuildWalletToken(db, 'r1', 'tr', 1800, { ...dust, tokenCreatedAt: null, observationStartedAt: null });
    expect(result.rebuilt).toBe(true);
    expect(result.replayedTrades).toBe(1);
    expect(getLatestCycle(db, 'r1', 'tr')?.boughtAmount.toString()).toBe('100');

    const noStart = rebuildWalletToken(db, 'r2', 'tr', 1800, { ...dust });
    expect(noStart.rebuilt).toBe(false);
    expect(noStart.reason).toBe('no_reliable_start');
    db.close();
  });
});

describe('M2-4/M2-7/M2-8 候选评估', () => {
  it('完整性门禁：近期缺口 → deferred 且不创建推送任务', async () => {
    const db = openDatabase({ path: ':memory:' });
    const now = Math.floor(Date.now() / 1000);
    setKv(db, 'observation_started_at', now - 7200, now);
    for (const [w, usd] of [['g1', 1500], ['g2', 1500], ['g3', 1500]] as const) {
      seedWallet(db, w, { ageDays: 30 });
      insertTrade(db, { maker: w, token: 'tg', side: 'buy', usd, amount: usd, ts: now - 120, tx: `tg-${w}` });
    }
    upsertSourceHealth(db, { source: 'smartmoney', gap_from_ts: now - 300, gap_to_ts: now - 100 }, now);

    const gateway = {
      fetchTokenInfo: async () => ({ price: { price: '1' } }),
      fetchTokenSecurity: async () => ({}),
      fetchWalletStats: async () => [],
    };
    const result = await evaluateToken(
      { db, config: loaded.config, gateway, logger: silent, configVersion: 'c', rulesVersion: 'r', blacklist, now: () => now * 1000 },
      'tg',
    );
    expect(result.status).toBe('deferred');
    expect(result.reason).toBe('integrity_gap');
    const tasks = db.prepare('SELECT COUNT(*) AS n FROM push_tasks').get() as { n: number };
    expect(tasks.n).toBe(0);
    db.close();
  });
});
