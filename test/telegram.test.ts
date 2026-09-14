import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { setKv, openDatabase } from '../src/store/db.js';
import { formatSignalMessage, groupBySource, signalShortId } from '../src/telegram/format.js';
import { loadSignalView, Pusher } from '../src/telegram/pusher.js';
import { runExitMonitor } from '../src/telegram/exit-monitor.js';
import type { SendMessageOptions, TelegramApi } from '../src/telegram/types.js';
import { createLogger } from '../src/logger.js';

const silent = createLogger({ test: true });
silent.info = () => undefined;
silent.warn = () => undefined;
silent.error = () => undefined;
silent.debug = () => undefined;

const loaded = loadConfig({ skipDotenv: true, env: { GMGN_API_KEY: 'test' } });

function seedSignal(
  db: ReturnType<typeof openDatabase>,
  opts: {
    status?: string;
    sentAt?: number | null;
    messageRevision?: number;
    walletCount?: number;
    snapshot?: unknown;
  } = {},
): number {
  const res = db
    .prepare(
      `INSERT INTO signals (token, symbol, triggered_at, wallet_count, net_inflow_usd, holding_ratio, price_ratio, status, message_revision, sent_at, snapshot)
       VALUES ('TOKEN', 'TST', 1000, ?, 9000, 0.82, 1.18, ?, ?, ?, ?)`,
    )
    .run(
      opts.walletCount ?? 4,
      opts.status ?? 'sending',
      opts.messageRevision ?? 0,
      opts.sentAt ?? null,
      JSON.stringify(
        opts.snapshot ?? {
          wallets: [
            {
              wallet: 'wallet-secret-address',
              clusterId: 'c0',
              tags: ['smart_degen'],
              sources: ['smartmoney'],
              action: 'open',
              qualifyingBuyUsd: '5200',
            },
            {
              wallet: 'wallet-secret-2',
              clusterId: 'c1',
              tags: ['renowned'],
              sources: ['kol'],
              action: 'open',
              qualifyingBuyUsd: '3000',
            },
          ],
        },
      ),
    );
  return Number(res.lastInsertRowid);
}

function fakeSender(behavior?: { fail?: boolean }): TelegramApi & {
  sent: Array<{ chatId: string; text: string; options?: SendMessageOptions }>;
  edited: Array<{ messageId: number; text: string }>;
} {
  const state = {
    sent: [] as Array<{ chatId: string; text: string; options?: SendMessageOptions }>,
    edited: [] as Array<{ messageId: number; text: string }>,
    async sendMessage(chatId: string, text: string, options?: SendMessageOptions) {
      if (behavior?.fail) throw new Error('telegram down');
      state.sent.push({ chatId, text, options });
      return { message_id: 42 };
    },
    async editMessageText(_chatId: string, messageId: number, text: string) {
      state.edited.push({ messageId, text });
    },
  };
  return state;
}

describe('M3-3 消息模板', () => {
  it('来源分项互斥且合计 = 总票数', () => {
    const groups = groupBySource([
      { clusterId: 'c0', tags: ['smart_degen'], sources: ['smartmoney'], action: 'open', qualifyingBuyUsd: '100' },
      { clusterId: 'c1', tags: ['renowned'], sources: ['kol'], action: 'open', qualifyingBuyUsd: '200' },
      { clusterId: 'c2', tags: ['smart_degen', 'renowned'], sources: ['smartmoney', 'kol'], action: 'open', qualifyingBuyUsd: '300' },
    ]);
    const total = groups.reduce((sum, g) => sum + g.count, 0);
    expect(total).toBe(3);
  });

  it('消息不包含钱包地址，含 CA/免责声明/追高警告', () => {
    const text = formatSignalMessage(
      {
        signalId: 123456,
        token: 'CA-ADDRESS-XYZ',
        symbol: 'TST',
        launchpad: 'Pump.fun',
        tokenAgeMinutes: 22,
        marketCap: 180000,
        liquidity: 42000,
        holderCount: 1240,
        votes: 4,
        windowMinutes: 15,
        wallets: [
          { clusterId: 'c0', tags: ['smart_degen'], sources: ['smartmoney'], action: 'open', qualifyingBuyUsd: '5200' },
        ],
        totalBuyUsd: '5200',
        netInflowUsd: '9800',
        retentionRatio: 0.82,
        priceRatio: 1.62,
        currentPrice: '0.00025',
        avgEntryPrice: '0.00021',
        top10Rate: 0.18,
        bundlerRate: 0.06,
        insiderRate: 0.03,
        devStatus: 'creator_close',
        socials: { telegram: 't.me/x', twitter: 'x' },
        partialHoldings: true,
      },
      { links: ['gmgn', 'photon'], buyButton: 'photon' },
    );
    expect(text).toContain('CA-ADDRESS-XYZ');
    expect(text).toContain(signalShortId(123456));
    expect(text).toContain('追高风险');
    expect(text).toContain('部分持仓未经余额核验');
    expect(text).toContain('非投资建议');
    expect(text).not.toContain('wallet-secret');
    expect(text).toContain('https://gmgn.ai/sol/token/CA-ADDRESS-XYZ');
    expect(text).not.toContain('photon');
  });
});

describe('M3-2/M3-4/M3-5 推送执行器', () => {
  it('首次推送成功：写回 signals 发送信息与冷却基准', async () => {
    const db = openDatabase({ path: ':memory:' });
    const signalId = seedSignal(db);
    db.prepare(
      `INSERT INTO push_tasks (signal_id, kind, revision, dedupe_key, payload, status, created_at, updated_at)
       VALUES (?, 'signal', 0, ?, ?, 'pending', 1000, 1000)`,
    ).run(signalId, `${signalId}:signal`, JSON.stringify({ evaluatedAt: 2000 }));

    const sender = fakeSender();
    const pusher = new Pusher({ db, config: loaded.config, sender, chatId: 'chat', logger: silent, now: () => 2000_000 });
    const result = await pusher.runOnce();
    expect(result.sent).toBe(1);

    const signal = db.prepare('SELECT * FROM signals WHERE id = ?').get(signalId) as {
      status: string;
      tg_message_id: number;
      sent_at: number;
    };
    expect(signal.status).toBe('pushed');
    expect(signal.tg_message_id).toBe(42);
    expect(signal.sent_at).toBe(2000);
    expect(sender.sent.length).toBe(1);
    db.close();
  });

  it('发送失败：进入 failed 并安排重试；暂停时延迟', async () => {
    const db = openDatabase({ path: ':memory:' });
    const signalId = seedSignal(db);
    db.prepare(
      `INSERT INTO push_tasks (signal_id, kind, revision, dedupe_key, payload, status, created_at, updated_at)
       VALUES (?, 'signal', 0, ?, ?, 'pending', 1000, 1000)`,
    ).run(signalId, `${signalId}:signal`, JSON.stringify({ evaluatedAt: 2000 }));

    const failing = fakeSender({ fail: true });
    const pusher = new Pusher({ db, config: loaded.config, sender: failing, chatId: 'chat', logger: silent, now: () => 2000_000 });
    const result = await pusher.runOnce();
    expect(result.failed).toBe(1);
    const task = db.prepare('SELECT * FROM push_tasks WHERE signal_id = ?').get(signalId) as {
      status: string;
      attempts: number;
      next_retry_at: number;
    };
    expect(task.status).toBe('failed');
    expect(task.attempts).toBe(1);
    expect(task.next_retry_at).toBeGreaterThan(2000);

    db.prepare("INSERT INTO signal_wallets(signal_id,wallet,cycle_no,cluster_id) VALUES (?,'exited',1,'c0')").run(signalId);
    db.prepare("INSERT INTO wallet_positions(wallet,token,cycle_no,state,cost_complete,bought_amount,sold_amount) VALUES ('exited','TOKEN',1,'closed',1,'100','100')").run();
    setKv(db, 'paused', true, 2000);
    const paused = await pusher.runOnce();
    expect(paused.processed).toBe(0);
    db.close();
  });

  it('旧修订的编辑任务被丢弃', async () => {
    const db = openDatabase({ path: ':memory:' });
    const signalId = seedSignal(db, { status: 'pushed', sentAt: 1500, messageRevision: 2 });
    db.prepare('UPDATE signals SET tg_message_id = 7 WHERE id = ?').run(signalId);
    db.prepare(
      `INSERT INTO push_tasks (signal_id, kind, revision, dedupe_key, payload, status, created_at, updated_at)
       VALUES (?, 'escalate', 1, ?, '{}', 'pending', 1600, 1600)`,
    ).run(signalId, `${signalId}:escalate:1`);

    const sender = fakeSender();
    const pusher = new Pusher({ db, config: loaded.config, sender, chatId: 'chat', logger: silent, now: () => 2000_000 });
    const result = await pusher.runOnce();
    expect(result.cancelled).toBe(1);
    expect(sender.edited.length).toBe(0);
    db.close();
  });

  it('静默时段普通信号延迟、强信号放行', async () => {
    const db = openDatabase({ path: ':memory:' });
    const quietNow = Date.UTC(2026, 8, 13, 3, 0, 0); // 03:00 UTC 静默时段
    const weakId = seedSignal(db, { walletCount: 3 });
    const strongId = seedSignal(db, { walletCount: 6 });
    for (const [id, dedupe] of [
      [weakId, `${weakId}:signal`],
      [strongId, `${strongId}:signal`],
    ] as const) {
      db.prepare(
        `INSERT INTO push_tasks (signal_id, kind, revision, dedupe_key, payload, status, created_at, updated_at)
         VALUES (?, 'signal', 0, ?, ?, 'pending', 1000, 1000)`,
      ).run(id, dedupe, JSON.stringify({ evaluatedAt: Math.floor(quietNow / 1000) }));
    }
    db.prepare('UPDATE signals SET triggered_at = ?').run(Math.floor(quietNow / 1000) - 60);
    const sender = fakeSender();
    const pusher = new Pusher({ db, config: loaded.config, sender, chatId: 'chat', logger: silent, now: () => quietNow });
    const result = await pusher.runOnce();
    expect(result.sent).toBe(1); // 仅强信号
    const weak = db.prepare('SELECT status FROM push_tasks WHERE signal_id = ?').get(weakId) as { status: string };
    expect(weak.status).toBe('pending');
    db.close();
  });

  it('退出提醒优先级且不受暂停影响', async () => {
    const db = openDatabase({ path: ':memory:' });
    const signalId = seedSignal(db, { status: 'pushed', sentAt: 1500 });
    db.prepare('UPDATE signals SET tg_message_id = 9 WHERE id = ?').run(signalId);
    db.prepare(
      `INSERT INTO push_tasks (signal_id, kind, alert_type, revision, dedupe_key, payload, status, created_at, updated_at)
       VALUES (?, 'exit_alert', 'consensus_exit', 0, ?, '{"exitedClusters":1}', 'pending', 1600, 1600)`,
    ).run(signalId, `${signalId}:exit:consensus_exit`);
    db.prepare("INSERT INTO signal_wallets(signal_id,wallet,cycle_no,cluster_id) VALUES (?,'exited',1,'c0')").run(signalId);
    db.prepare("INSERT INTO wallet_positions(wallet,token,cycle_no,state,cost_complete,bought_amount,sold_amount) VALUES ('exited','TOKEN',1,'closed',1,'100','100')").run();
    setKv(db, 'paused', true, 2000);

    const sender = fakeSender();
    const pusher = new Pusher({ db, config: loaded.config, sender, chatId: 'chat', logger: silent, now: () => 2000_000 });
    const result = await pusher.runOnce();
    expect(result.sent).toBe(1);
    expect(sender.sent[0]?.text).toContain('退出提醒');
    db.close();
  });
});

describe('M3-6 退出监控', () => {
  it('共识簇全部绑定周期清仓 → 创建退出提醒并按 signal+类型去重', () => {
    const db = openDatabase({ path: ':memory:' });
    const signalId = seedSignal(db, {
      status: 'pushed',
      sentAt: 1900,
      snapshot: {
        wallets: [
          { wallet: 'w1', clusterId: 'c0', cycleNo: 1, tags: ['smart_degen'], sources: ['smartmoney'] },
          { wallet: 'w2', clusterId: 'c0', cycleNo: 1, tags: ['smart_degen'], sources: ['smartmoney'] },
        ],
      },
    });
    db.prepare(
      `INSERT INTO wallet_positions (wallet, token, cycle_no, state) VALUES ('w1','TOKEN',1,'closed'), ('w2','TOKEN',1,'closed')`,
    ).run();

    const created = runExitMonitor({ db, config: loaded.config, logger: silent, now: () => 2000_000 });
    expect(created).toBe(1);
    const tasks = db.prepare("SELECT * FROM push_tasks WHERE kind = 'exit_alert'").all() as Array<{
      alert_type: string;
      dedupe_key: string;
    }>;
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.alert_type).toBe('consensus_exit');

    const again = runExitMonitor({ db, config: loaded.config, logger: silent, now: () => 2000_000 });
    expect(again).toBe(0);
    db.close();
  });
});

describe('loadSignalView', () => {
  it('可加载并计算均价', () => {
    const db = openDatabase({ path: ':memory:' });
    const signalId = seedSignal(db, { status: 'pushed', sentAt: 1900 });
    db.prepare(
      `INSERT INTO tokens (address, symbol, price, created_at) VALUES ('TOKEN','TST','0.00025', 1000)`,
    ).run();
    const view = loadSignalView(db, signalId, 2000);
    expect(view?.currentPrice).toBe('0.00025');
    expect(view?.avgEntryPrice).not.toBeNull();
    db.close();
  });
});
