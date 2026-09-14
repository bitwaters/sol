import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { archiveAndPrune } from '../src/ingest/archive.js';
import { normalizeTrackItem } from '../src/ingest/normalize.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { applyTrade, getLatestCycle } from '../src/signal/positions.js';
import { openDatabase } from '../src/store/db.js';
import { upsertWalletProfile } from '../src/enrich/wallet.js';
import { ingestBatch } from '../src/store/repo/trades.js';
import { Pusher } from '../src/telegram/pusher.js';
import type { TelegramApi } from '../src/telegram/types.js';

const silent = createLogger({ test: true });
silent.info = () => undefined;
silent.warn = () => undefined;
silent.error = () => undefined;
silent.debug = () => undefined;

const loaded = loadConfig({ skipDotenv: true, env: { GMGN_API_KEY: 'test' } });
const dust = { tokenCreatedAt: null, observationStartedAt: null, hasRecentGap: false, dustRatio: 0.01 };

function trade(overrides: Record<string, unknown> = {}) {
  return normalizeTrackItem('smartmoney', {
    transaction_hash: 'tx1',
    maker: 'W1',
    base_address: 'TOK',
    side: 'buy',
    timestamp: 1000,
    token_amount: '100',
    quote_amount: '1',
    amount_usd: 100,
    balance: '100',
    ...overrides,
  })!;
}

describe('回归：重复采集不重复累计持仓', () => {
  it('同一批事件重复入库，onInserted 只回调一次', () => {
    const db = openDatabase({ path: ':memory:' });
    const t = trade();
    let callbacks = 0;
    for (let i = 0; i < 2; i += 1) {
      ingestBatch(db, 'smartmoney', [t], { source: 'smartmoney' }, 1000, (inserted) => {
        callbacks += 1;
        for (const item of inserted) applyTrade(db, item, dust);
      });
    }
    expect(callbacks).toBe(1);
    expect(getLatestCycle(db, 'W1', 'TOK')?.boughtAmount.toString()).toBe('100');
    db.close();
  });
});

describe('回归：并发发送只成功一次', () => {
  it('两个 runOnce 并发时仅发送一条', async () => {
    const db = openDatabase({ path: ':memory:' });
    const nowSec = Math.floor(Date.now() / 1000);
    const signalId = Number(
      db
        .prepare(
          `INSERT INTO signals (token, symbol, triggered_at, wallet_count, status, snapshot)
           VALUES ('TOK','T', ?, 3, 'sending', '{"wallets":[]}')`,
        )
        .run(nowSec - 30).lastInsertRowid,
    );
    db.prepare(
      `INSERT INTO push_tasks (signal_id, kind, revision, dedupe_key, payload, status, created_at, updated_at)
       VALUES (?, 'signal', 0, ?, ?, 'pending', ?, ?)`,
    ).run(signalId, `${signalId}:signal`, JSON.stringify({ evaluatedAt: nowSec }), nowSec, nowSec);

    const sent: string[] = [];
    const sender: TelegramApi = {
      async sendMessage(_chatId, text) {
        await new Promise((r) => setTimeout(r, 10));
        sent.push(text);
        return { message_id: 1 };
      },
      async editMessageText() {},
    };
    const pusher = new Pusher({ db, config: loaded.config, sender, chatId: 'c', logger: silent });
    await Promise.all([pusher.runOnce(), pusher.runOnce()]);
    expect(sent.length).toBe(1);
    db.close();
  });
});

describe('回归：过期 TTL 任务被取消', () => {
  it('payload.evaluatedAt 超 TTL → cancelled，且信号不被置为 pushed', async () => {
    const db = openDatabase({ path: ':memory:' });
    const nowSec = Math.floor(Date.now() / 1000);
    const signalId = Number(
      db
        .prepare(
          `INSERT INTO signals (token, symbol, triggered_at, wallet_count, status, snapshot)
           VALUES ('TOK','T', ?, 3, 'sending', '{"wallets":[]}')`,
        )
        .run(nowSec - 60).lastInsertRowid,
    );
    db.prepare(
      `INSERT INTO push_tasks (signal_id, kind, revision, dedupe_key, payload, status, created_at, updated_at)
       VALUES (?, 'signal', 0, ?, ?, 'pending', ?, ?)`,
    ).run(
      signalId,
      `${signalId}:signal`,
      JSON.stringify({ evaluatedAt: nowSec - 3600 }),
      nowSec,
      nowSec,
    );

    const sender: TelegramApi = {
      async sendMessage() {
        throw new Error('should not send');
      },
      async editMessageText() {},
    };
    const pusher = new Pusher({ db, config: loaded.config, sender, chatId: 'c', logger: silent });
    const result = await pusher.runOnce();
    expect(result.cancelled).toBe(1);
    const task = db.prepare('SELECT status FROM push_tasks WHERE signal_id = ?').get(signalId) as {
      status: string;
    };
    const signal = db.prepare('SELECT status FROM signals WHERE id = ?').get(signalId) as {
      status: string;
    };
    expect(task.status).toBe('cancelled');
    expect(signal.status).toBe('expired');
    db.close();
  });
});

describe('回归：归档重写不追加', () => {
  it('重复运行后归档行数保持等于事件数', () => {
    const db = openDatabase({ path: ':memory:' });
    const nowSec = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 2; i += 1) {
      const t = trade({
        transaction_hash: `old${i}`,
        timestamp: nowSec - 40 * 86_400,
      });
      ingestBatch(db, 'smartmoney', [t], { source: 'smartmoney' }, nowSec);
    }
    const dir = mkdtempSync(join(tmpdir(), 'meme-archive-'));
    const first = archiveAndPrune(db, { archiveDir: dir, retentionDays: 30 });
    const second = archiveAndPrune(db, { archiveDir: dir, retentionDays: 30 });
    expect(first.deletedTrades).toBe(2);
    expect(second.deletedTrades).toBe(0);
    const content = gunzipSync(readFileSync(first.files[0]!)).toString('utf8');
    expect(content.trimEnd().split('\n').length).toBe(2);
    db.close();
  });
});

describe('回归：等待期间跨出窗口', () => {
  it('富化期间窗口过期 → 发送前复核拒绝', async () => {
    const db = openDatabase({ path: ':memory:' });
    const t0 = Math.floor(Date.now() / 1000);
    const buyTs = t0 - 899; // t0 时在 15min 窗口内，t0+2 时已跨出
    for (const w of ['W1', 'W2', 'W3']) {
      ingestBatch(
        db,
        'smartmoney',
        [
          trade({
            transaction_hash: `t-${w}`,
            maker: w,
            timestamp: buyTs,
            amount_usd: 1500,
            token_amount: '1500',
          }),
        ],
        { source: 'smartmoney' },
        t0,
      );
      upsertWalletProfile(db, {
        address: w,
        name: null,
        twitter: null,
        tags: ['smart_degen'],
        fundFrom: null,
        fundFromAddress: null,
        walletCreatedAt: t0 - 30 * 86400,
        refreshedAt: t0,
      });
      db.prepare(
        `INSERT INTO wallet_positions (wallet, token, cycle_no, state, cost_complete, bought_amount, sold_amount, bought_usd, sold_usd, cycle_started_at)
         VALUES (?, 'TOK', 1, 'open', 1, '1500', '0', '1500', '0', ?)`,
      ).run(w, buyTs);
    }
    db.prepare(
      `INSERT INTO tokens (address, symbol, price, created_at, market_cap, liquidity, holder_count,
        top10_rate, bundler_rate, insider_rate, entrapment_rate, bot_degen_rate, fresh_wallet_rate,
        dev_hold_rate, sniper_count, is_honeypot, renounced_mint, renounced_freeze, socials)
       VALUES ('TOK','T','1',?,100000,50000,1000,0.1,0,0,0,0,0,0,0,0,1,1,'{}')`,
    ).run(t0 - 1800);
    const signalId = Number(
      db
        .prepare(
          `INSERT INTO signals (token, symbol, triggered_at, wallet_count, status, snapshot)
           VALUES ('TOK','T', ?, 3, 'sending', '{"wallets":[]}')`,
        )
        .run(t0 - 60).lastInsertRowid,
    );

    let clockMs = t0 * 1000;
    const info = {
      price: { price: '1' },
      circulating_supply: '100000',
      creation_timestamp: t0 - 1800,
      liquidity: '50000',
      holder_count: 1000,
      stat: {
        top_10_holder_rate: '0.1',
        top_bundler_trader_percentage: '0',
        top_rat_trader_percentage: '0',
        top_entrapment_trader_percentage: '0',
        bot_degen_rate: '0',
        fresh_wallet_rate: '0',
        dev_team_hold_rate: '0',
      },
      wallet_tags_stat: { sniper_wallets: 0 },
      dev: { creator_token_status: 'creator_close' },
      link: {},
    };
    const gateway = {
      fetchTokenInfo: async () => {
        clockMs = (t0 + 2) * 1000; // 富化期间时间推进 2 秒
        return info;
      },
      fetchTokenSecurity: async () => ({ honeypot: 0, renounced_mint: true, renounced_freeze_account: true }),
      fetchWalletStats: async () => [],
    };
    const { revalidateSignalForSend } = await import('../src/signal/candidate.js');
    const result = await revalidateSignalForSend(
      {
        db,
        config: loaded.config,
        gateway,
        logger: silent,
        configVersion: 'c',
        rulesVersion: 'r',
        blacklist: { entries: new Map() },
        now: () => clockMs,
      },
      signalId,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('send_recheck_votes');
    db.close();
  });
});
