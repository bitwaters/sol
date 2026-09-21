import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { normalizeTrackItem } from '../src/ingest/normalize.js';
import { applySchema, openDatabase, type Db } from '../src/store/db.js';
import { upsertTrades } from '../src/store/repo/trades.js';
import { upsertWalletProfile } from '../src/enrich/wallet.js';
import { applyTrade } from '../src/signal/positions.js';
import { rebuildWalletToken } from '../src/signal/rebuild.js';
import { evaluateToken } from '../src/signal/candidate.js';
import { runExitMonitor } from '../src/telegram/exit-monitor.js';

const config = loadConfig({ skipDotenv: true, env: { GMGN_API_KEY: 'test' } }).config;
const logger = createLogger({ test: true });
logger.info = logger.warn = logger.error = logger.debug = () => undefined;
const ctx = { dustRatio: 0.01 };
const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const db = openDatabase({ path: ':memory:' });
  databases.push(db);
  const now = Math.floor(Date.now() / 1000);
  function trade(tx: string, offset: number, side: 'buy' | 'sell', amount: number, balance: number, late = false) {
    const event = normalizeTrackItem('smartmoney', {
      transaction_hash: tx, maker: 'w', base_address: 'T', side,
      timestamp: now + offset, token_amount: String(amount), amount_usd: amount, balance: String(balance),
    })!;
    upsertTrades(db, 'smartmoney', [event]);
    if (!late) applyTrade(db, event, ctx);
    return event;
  }
  function bind(offset: number, cycle: number, anchor?: string, joinedVersion = 0, status = 'pushed') {
    const id = Number(db.prepare(
      'INSERT INTO signals(token,status,triggered_at,sent_at) VALUES (?,?,?,?)',
    ).run('T', status, now + offset, now + offset).lastInsertRowid);
    db.prepare(
      `INSERT INTO signal_wallets(signal_id,wallet,cycle_no,cluster_id,joined_version,joined_at,joined_event_id)
       VALUES (?,'w',?,'c0',?,?,?)`,
    ).run(id, cycle, joinedVersion, anchor ? now + offset : null, anchor ?? null);
    if(status==='pushed')db.prepare('UPDATE signals SET tg_message_id=? WHERE id=?').run(id,id);
    return id;
  }
  const binding = (id: number) => (db.prepare('SELECT cycle_no FROM signal_wallets WHERE signal_id = ?').get(id) as { cycle_no: number }).cycle_no;
  const rebuild = (offset: number) => rebuildWalletToken(db, 'w', 'T', now + offset, ctx, logger);
  const exits = (offset = 0) => runExitMonitor({ db, config, logger, now: () => (now + offset) * 1000 });
  return { db, now, trade, bind, binding, rebuild, exits };
}

describe('重建按成员加入成交恢复周期绑定', () => {
  it.each(['pushed', 'sending', 'candidate'])('同一旧周期拆分后，%s 成员按各自加入成交映射', (status) => {
    const s = fixture();
    const first = s.trade('first', -300, 'buy', 100, 100);
    const second = s.trade('second', -100, 'buy', 100, 100);
    const early = s.bind(-250, 1, first.eventId, 0, status);
    const later = s.bind(-90, 1, second.eventId, 0, status);
    s.trade('late-close', -200, 'sell', 100, 0, true);
    expect(s.rebuild(-200).rebuilt).toBe(true);
    expect(s.binding(early)).toBe(1);
    expect(s.binding(later)).toBe(2);
    if (status === 'pushed') {
      expect(s.exits()).toBe(1); // 只有首次建仓时加入的信号清仓。
      expect(s.db.prepare('SELECT signal_id FROM push_tasks').all()).toEqual([{ signal_id: early }]);
      s.trade('actual-close', 10, 'sell', 100, 0);
      expect(s.exits(20)).toBe(1);
      expect(s.db.prepare('SELECT signal_id FROM push_tasks ORDER BY id').all()).toEqual([{ signal_id: early }, { signal_id: later }]);
    }
  });

  it('旧绑定缺少锚点时，按首次加入时间恢复，并在再次重建时保持一致', () => {
    const s = fixture();
    s.trade('first', -300, 'buy', 100, 100);
    const second = s.trade('second', -100, 'buy', 100, 100);
    const id = s.bind(-90, 1);
    s.trade('late-close', -200, 'sell', 100, 0, true);
    s.rebuild(-200);
    expect(s.binding(id)).toBe(2);
    expect(s.db.prepare('SELECT joined_event_id FROM signal_wallets WHERE signal_id = ?').get(id)).toEqual({ joined_event_id: second.eventId });
    s.trade('late-add', -50, 'buy', 10, 110, true);
    s.rebuild(-50);
    expect(s.binding(id)).toBe(2);
    expect(s.exits()).toBe(0);
  });

  it('旧升级成员使用加入版本的时间，而不是原信号触发时间', () => {
    const s = fixture();
    s.trade('first', -300, 'buy', 100, 100);
    s.trade('second', -100, 'buy', 100, 100);
    const id = s.bind(-250, 1, undefined, 1);
    s.db.prepare(
      `INSERT INTO push_tasks(signal_id,kind,revision,dedupe_key,payload,status,created_at,updated_at)
       VALUES (?,'escalate',1,'upgrade','{}','sent',?,?)`,
    ).run(id, s.now - 90, s.now - 90);
    s.trade('late-close', -200, 'sell', 100, 0, true);
    s.rebuild(-200);
    expect(s.binding(id)).toBe(2);
    expect(s.exits()).toBe(0);
  });

  it('以清仓检查点重放后续买入，保留此前信号的历史周期', () => {
    const s = fixture();
    const first = s.trade('first', -300, 'buy', 100, 100);
    s.trade('close', -200, 'sell', 100, 0);
    s.trade('rebuy', -100, 'buy', 50, 60);
    const id = s.bind(-250, 1, first.eventId);
    s.trade('late-buy', -150, 'buy', 10, 10, true);
    s.rebuild(-150);
    expect(s.binding(id)).toBe(1);
    expect(s.exits()).toBe(1);
  });

  it.each([false, true])('周期中途检查点保留真实起点和绑定（旧检查点=%s）', (legacy) => {
    const s = fixture();
    s.trade('first', -600, 'buy', 100, 100);
    s.trade('close', -500, 'sell', 100, 0);
    const rebuy = s.trade('rebuy', -400, 'buy', 100, 100);
    s.trade('add', -200, 'buy', 50, 150);
    s.trade('last', 0, 'buy', 50, 210);
    const id = s.bind(-300, 2, rebuy.eventId);
    if (legacy) s.db.prepare('UPDATE position_checkpoints SET cycle_started_at=NULL,last_buy_ts=NULL,last_sell_ts=NULL').run();
    s.trade('late', -100, 'buy', 10, 160, true);
    s.rebuild(-100);
    expect(s.binding(id)).toBe(2);
    expect(s.db.prepare('SELECT cycle_started_at,bought_amount FROM wallet_positions WHERE cycle_no=2').get()).toEqual({
      cycle_started_at: s.now - 400, bought_amount: '210',
    });
    expect(s.exits()).toBe(0);
  });
});

it('候选首次绑定保存加入成交，后续评估不覆盖原成员的加入依据', async () => {
  const s = fixture();
  for (const w of ['a', 'b', 'c']) {
    upsertWalletProfile(s.db, { address: w, name: null, twitter: null, tags: ['smart_degen'], fundFrom: null,
      fundFromAddress: null, walletCreatedAt: s.now - 30 * 86400, refreshedAt: s.now });
    s.db.prepare(`INSERT INTO position_checkpoints(wallet,token,cycle_no,checked_at,balance,bought_amount,sold_amount,bought_usd,sold_usd,cost_complete,source)
      VALUES (?,'T',0,?,'0','0','0','0','0',1,'balance_info')`).run(w, s.now - 300);
    const event = normalizeTrackItem('smartmoney', { transaction_hash: w, maker: w, base_address: 'T', side: 'buy',
      timestamp: s.now - 120, token_amount: '1500', amount_usd: 1500, balance: '1500' })!;
    upsertTrades(s.db, 'smartmoney', [event]);
    applyTrade(s.db, event, ctx);
  }
  const deps = { db: s.db, config, logger, blacklist: { entries: new Map() }, configVersion: 'test', rulesVersion: 'test', now: () => s.now * 1000,
    gateway: {
      fetchTokenInfo: async () => ({ symbol: 'T', price: { price: '1' }, circulating_supply: 50000, creation_timestamp: s.now - 3600,
        liquidity: 30000, holder_count: 500, stat: { top_10_holder_rate: .1, top_bundler_trader_percentage: .1, top_rat_trader_percentage: .1,
          top_entrapment_trader_percentage: .1, bot_degen_rate: .1, fresh_wallet_rate: .1, dev_team_hold_rate: .01 }, wallet_tags_stat: { sniper_wallets: 1 } }),
      fetchTokenSecurity: async () => ({ honeypot: 0, renounced_mint: true, renounced_freeze_account: true }), fetchWalletStats: async () => [],
    } };
  expect((await evaluateToken(deps, 'T')).pushTaskCreated).toBe(true);
  const original = s.db.prepare('SELECT wallet,joined_at,joined_event_id FROM signal_wallets ORDER BY wallet').all();
  expect(original).toHaveLength(3);
  for (const row of original as Array<{ joined_at: number; joined_event_id: string }>) {
    expect(row.joined_at).toBe(s.now);
    expect(row.joined_event_id).toBeTruthy();
  }
  deps.now = () => (s.now + 10) * 1000;
  await evaluateToken(deps, 'T');
  expect(s.db.prepare('SELECT wallet,joined_at,joined_event_id FROM signal_wallets ORDER BY wallet').all()).toEqual(original);
});

it('升级旧数据库保留记录，重复应用 schema 安全', () => {
  const db = new Database(':memory:');
  databases.push(db);
  db.exec(`CREATE TABLE position_checkpoints(wallet TEXT,token TEXT,cycle_no INTEGER,checked_at INTEGER,balance TEXT,
    bought_amount TEXT,sold_amount TEXT,bought_usd TEXT,sold_usd TEXT,cost_complete INTEGER,source TEXT);
    INSERT INTO position_checkpoints VALUES ('w','T',1,100,'10','10','0','10','0',1,'balance_info');
    CREATE TABLE signal_wallets(signal_id INTEGER,wallet TEXT,cycle_no INTEGER,cluster_id TEXT,joined_version INTEGER);
    INSERT INTO signal_wallets VALUES (1,'w',1,'c0',0);`);
  applySchema(db);
  applySchema(db);
  expect(db.prepare('SELECT wallet,balance,cycle_started_at FROM position_checkpoints').get()).toEqual({ wallet: 'w', balance: '10', cycle_started_at: null });
  expect(db.prepare('SELECT signal_id,joined_at,joined_event_id FROM signal_wallets').get()).toEqual({ signal_id: 1, joined_at: null, joined_event_id: null });
});
