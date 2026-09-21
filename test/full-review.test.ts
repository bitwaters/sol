import { computeWindow } from '../src/signal/window.js';
import { validateTokenSnapshot } from '../src/signal/validate-token.js';
import { enrichToken } from '../src/enrich/token.js';
import { gzipSync } from 'node:zlib';
import { archiveAndPrune } from '../src/ingest/archive.js';
import { parseTokenInfo } from '../src/enrich/token.js';
import { parseWalletStats } from '../src/enrich/wallet.js';
import { resolveStaleGaps } from '../src/signal/integrity.js';
import { getLatestCycle, recomputeCostCompleteness } from '../src/signal/positions.js';
import { rebuildWalletToken } from '../src/signal/rebuild.js';
import { runExitMonitor } from '../src/telegram/exit-monitor.js';
import { buildClusters } from '../src/signal/cluster.js';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scenario, config, baseNow, log } from './review-fixture.js';
import { evaluateToken, revalidateSignalForSend } from '../src/signal/candidate.js';
import { Pusher } from '../src/telegram/pusher.js';
import { loadConfig } from '../src/config.js';
import { normalizeTrackItem, normalizeTrackResponse } from '../src/ingest/normalize.js';
import { openDatabase, getKv, setKv, type Db } from '../src/store/db.js';
import { upsertSourceHealth, getSourceHealth } from '../src/store/repo/health.js';
import { backfillFollow } from '../src/ingest/backfill.js';
import { Poller } from '../src/ingest/poller.js';
import { BanGate, TokenBucket } from '../src/ingest/limiter.js';
import { OpenApiClient } from '../src/gmgn/OpenApiClient.js';
import { GmgnGateway, RateLimitedError } from '../src/ingest/gateway.js';
import { collectOpsAlerts } from '../src/ops/alerts.js';
import { buildStatsReport, splitReportText, sendDailyReport } from '../src/backtest/report.js';
import { evaluateOutcomes } from '../src/backtest/evaluate.js';
import { upsertTrades } from '../src/store/repo/trades.js';
import { applyIngestedTrades } from '../src/signal/ingest.js';
import { boundHoldingRatio } from '../src/signal/members.js';

const dbs: Db[] = [];
function setup() { const s = scenario(); dbs.push(s.db); return s; }
function db() { const value = openDatabase({ path: ':memory:' }); dbs.push(value); return value; }
afterEach(() => { vi.unstubAllGlobals(); for (const d of dbs.splice(0)) d.close(); });
const sender = () => ({ sendMessage: vi.fn(async () => ({ message_id: 1 })), editMessageText: vi.fn(async () => undefined) });

it('封禁等待期间延长封禁，必须等待新的截止时间', async () => {
  let now = 0;
  const waits: number[] = [];
  const gate = new BanGate({ now: () => now, sleep: async (ms) => { waits.push(ms); now += ms; if (waits.length === 1) gate.banUntil(3000, 'extended'); } });
  gate.banUntil(1000, 'initial');
  await gate.waitIfBanned();
  expect(waits).toEqual([1000, 2000]);
  expect(gate.isBanned).toBe(false);
});

it('无法补满的限流权重和非法速率立即报错，不会永久排队', () => {
  expect(() => new TokenBucket({ ratePerSecond: 0, capacity: 5 })).toThrow();
  const bucket = new TokenBucket({ ratePerSecond: 1, capacity: 1 });
  expect(() => bucket.acquire(2)).toThrow();
  expect(() => bucket.tryAcquire(-1)).toThrow();
});

it.each(['plain 429', 'business 429'])('%s 进入全局封禁，不在 client 内绕过预算重试', async (kind) => {
  const fetch = vi.fn(async () => new Response(kind === 'plain 429' ? 'Too many requests' : JSON.stringify({ code: 1, error: 'ERROR_RATE_LIMIT_BLOCKED' }), { status: 429 }));
  vi.stubGlobal('fetch', fetch);
  const gateway = new GmgnGateway({ client: new OpenApiClient({ apiKey: 'fake', host: 'https://test.invalid' }), limiter: new TokenBucket({ ratePerSecond: 20, capacity: 20 }), banGate: new BanGate() });
  await expect(gateway.fetchSmartmoney(10)).rejects.toBeInstanceOf(RateLimitedError);
  expect(gateway.isBanned).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]).toBeDefined();
});

it('坏行和非法数字不会使整批归一化崩溃或取得计算资格', () => {
  const row = { transaction_hash: 'bad', maker: 'w', base_address: 'T', side: 'buy', timestamp: baseNow, token_amount: 'NaN', amount_usd: 'bad' };
  const list = normalizeTrackResponse('smartmoney', [null, [], row]);
  expect(list).toHaveLength(1);
  expect(list[0]!.amountNormalized).toBeNull();
  expect(list[0]!.amountUsd).toBeNull();
  expect(normalizeTrackItem('smartmoney', { ...row, timestamp: -1 })).toBeNull();
});

it('回补重建失败时成交、持仓、cursor 和缺口起点一起回滚', async () => {
  const d = db();
  upsertSourceHealth(d, { source: 'follow', backfill_cursor: 'first', gap_from_ts: baseNow - 50, gap_to_ts: baseNow }, baseNow);
  const before = getKv(d, 'gap_since:follow');
  await expect(backfillFollow({ db: d, logger: log, fetchFollowPage: async () => ({ list: [{ transaction_hash: 'late', maker: 'w', base_address: 'T', side: 'buy', timestamp: baseNow - 100, base_amount: '10', amount_usd: 10 }] }),
    onTrades: (trades) => { applyIngestedTrades(d, trades, .01); throw new Error('rollback'); },
  })).rejects.toThrow('rollback');
  expect(d.prepare('SELECT COUNT(*) n FROM trades').get()).toEqual({ n: 0 });
  expect(d.prepare('SELECT COUNT(*) n FROM wallet_positions').get()).toEqual({ n: 0 });
  expect(getSourceHealth(d, 'follow').backfill_cursor).toBe('first');
  expect(getKv(d, 'gap_since:follow')).toBe(before);
});

it('采集回调失败时不能残留新缺口时钟', async () => {
  const d = db();
  upsertSourceHealth(d, { source: 'smartmoney', watermark_ts: baseNow - 100 }, baseNow);
  const p = new Poller({ db: d, logger: log, source: 'smartmoney', limit: 1, intervalMs: 1000,
    fetchPage: async () => [{ transaction_hash: 'new', maker: 'w', base_address: 'T', side: 'buy', timestamp: baseNow, token_amount: '1', amount_usd: 1 }],
    onTrades: () => { throw new Error('rollback'); } });
  expect((await p.tick()).error).toBe('rollback');
  expect(getKv(d, 'gap_since:smartmoney')).toBeNull();
  expect(getSourceHealth(d, 'smartmoney').gap_from_ts).toBeNull();
});

it('同一 token 的并发评估只产生一个候选和首次发送任务', async () => {
  const s = setup();
  const [first, second] = await Promise.all([evaluateToken(s.deps, 'T'), evaluateToken(s.deps, 'T')]);
  expect(first.signalId).toBe(second.signalId);
  expect(s.db.prepare('SELECT COUNT(*) n FROM signals').get()).toEqual({ n: 1 });
  expect(s.db.prepare('SELECT COUNT(*) n FROM push_tasks').get()).toEqual({ n: 1 });
});

it('发送前复核同步成员列表、有效票数和分项', async () => {
  const s = setup(); s.buy('w4'); s.buy('w5');
  await evaluateToken(s.deps, 'T');
  s.db.prepare(`UPDATE wallets SET tags='["scammer"]' WHERE address IN ('w4','w5')`).run();
  const send = sender();
  const p = new Pusher({ ...s.deps, chatId: 'test', sender: send, revalidate: id => revalidateSignalForSend(s.deps, id) });
  expect((await p.runOnce()).sent).toBe(1);
  expect(s.db.prepare('SELECT wallet FROM signal_wallets ORDER BY wallet').all()).toEqual([{ wallet: 'w1' }, { wallet: 'w2' }, { wallet: 'w3' }]);
  expect(s.db.prepare('SELECT wallet_count FROM signals').get()).toEqual({ wallet_count: 3 });
});

it('富化期间有效成员变化，追高均价必须按最终成员重新计算', async () => {
  const s = setup();
  s.db.prepare("UPDATE trades SET amount_normalized='15000' WHERE maker IN ('w1','w2','w3')").run();
  s.db.prepare("UPDATE wallet_positions SET bought_amount='15000' WHERE wallet IN ('w1','w2','w3')").run();
  s.buy('w4'); s.buy('w5'); s.setPrice('.3');
  const evaluation = await evaluateToken(s.deps, 'T');
  expect(evaluation.pushTaskCreated).toBe(true);
  s.db.prepare('UPDATE tokens SET price_updated_at=0').run();
  const original = s.deps.gateway.fetchTokenInfo;
  s.deps.gateway.fetchTokenInfo = async () => { s.db.prepare(`UPDATE wallets SET tags='["scammer"]' WHERE address IN ('w4','w5')`).run(); return original(); };
  const check = await revalidateSignalForSend(s.deps, evaluation.signalId!);
  expect(check.ok).toBe(false);
  expect(check.reason).toContain('price_above_entry');
});

it('发送复核期间管理员暂停，不得发送已领取任务', async () => {
  const s = setup(); await evaluateToken(s.deps, 'T');
  const send = sender();
  const p = new Pusher({ ...s.deps, chatId: 'test', sender: send,
    revalidate: async id => { const check = await revalidateSignalForSend(s.deps, id); setKv(s.db, 'paused', true); return check; } });
  expect((await p.runOnce()).sent).toBe(0);
  expect(send.sendMessage).not.toHaveBeenCalled();
});

it('发送成功重置发送前回测结果，并冻结发送时票数快照', async () => {
  const s = setup(); await evaluateToken(s.deps, 'T');
  s.db.prepare('UPDATE signals SET outcome_5m=9').run();
  setKv(s.db, 'backtest_giveup:1:outcome_1h', true);
  const p = new Pusher({ ...s.deps, chatId: 'test', sender: sender(), revalidate: id => revalidateSignalForSend(s.deps, id) });
  expect((await p.runOnce()).sent).toBe(1);
  expect(s.db.prepare('SELECT outcome_5m FROM signals').get()).toEqual({ outcome_5m: null });
  expect(getKv(s.db, 'backtest_giveup:1:outcome_1h')).toBeNull();
  const row = s.db.prepare('SELECT send_snapshot FROM signals').get() as { send_snapshot: string };
  expect(JSON.parse(row.send_snapshot).votes).toBe(3);
});

it('固定成员保留率包含清仓成员，不随钱包重新买入恢复', async () => {
  const s = setup(); await evaluateToken(s.deps, 'T');
  s.db.prepare("UPDATE wallet_positions SET state='closed', sold_amount=bought_amount WHERE wallet='w1'").run();
  expect(boundHoldingRatio(s.db, 1)).toBeCloseTo(2 / 3);
});

it.each(['walletCount', 'netInflow', 'observedBuys'])('配置 %s 上下限实际参与资格判断', async (option) => {
  const s = setup(); s.deps.config = structuredClone(config);
  if (option === 'walletCount') s.deps.config.tradeFilter.walletCount.max = 2;
  if (option === 'netInflow') s.deps.config.tradeFilter.netInflowUsd.max = 4000;
  if (option === 'observedBuys') s.deps.config.walletFilter.minObservedBuys = 2;
  expect((await evaluateToken(s.deps, 'T')).status).toBe('invalidated');
});

it('未观测到任何成交时也能报告已启用采集源心跳丢失和封禁', () => {
  const d = db(); setKv(d, 'service_started_at', baseNow - 100); setKv(d, 'enabled_sources', ['smartmoney']);
  expect(collectOpsAlerts(d, { nowSec: baseNow, gatewayBannedUntilMs: (baseNow + 100) * 1000 }).map(a => a.kind)).toEqual(expect.arrayContaining(['heartbeat:smartmoney', 'gmgn_ban']));
});

it('回测等待接口期间基准改变，不得把旧结果覆盖新基准', async () => {
  const d = db(); d.prepare("INSERT INTO signals(token,status,triggered_at,price_at_trigger) VALUES ('T','invalidated',?,'1')").run(baseNow - 400);
  await evaluateOutcomes({ db: d, config, logger: log, now: () => baseNow * 1000, gateway: { fetchKline: async () => {
    d.prepare("UPDATE signals SET status='pushed',sent_at=?,price_at_send='2'").run(baseNow);
    return { list: [{ time: (baseNow - 160) * 1000, close: '10' }] };
  } } });
  expect(d.prepare('SELECT outcome_5m FROM signals').get()).toEqual({ outcome_5m: null });
});

it('非法时刻和未支持的配置不能静默接受', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meme-config-review-'));
  const original = JSON.parse(readFileSync('config.jsonc', 'utf8'));
  try {
    original.push.quietHours.start = '25:99';
    writeFileSync(join(dir, 'config.jsonc'), JSON.stringify(original));
    expect(() => loadConfig({ root: dir, skipDotenv: true, env: { GMGN_API_KEY: 'test' } })).toThrow('quietHours');
    original.push.quietHours.start = '02:00'; original.walletFilter.cluster.maxHops = 2;
    writeFileSync(join(dir, 'config.jsonc'), JSON.stringify(original));
    expect(() => loadConfig({ root: dir, skipDotenv: true, env: { GMGN_API_KEY: 'test' } })).toThrow('maxHops');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


it('缺口期间未做候选评估，超时解除门禁仍不得恢复已有持仓成本资格', () => {
  const s = setup();
  upsertSourceHealth(s.db, { source: 'smartmoney', gap_from_ts: baseNow - 30, gap_to_ts: baseNow }, baseNow);
  resolveStaleGaps(s.db, baseNow + 601);
  recomputeCostCompleteness(s.db, 'T', { hasRecentGap: false, dustRatio: .01 });
  expect(getKv(s.db, 'gap_affected:T:w1')).toBe(true);
  expect(getLatestCycle(s.db, 'w1', 'T')!.costComplete).toBe(false);
  rebuildWalletToken(s.db, 'w1', 'T', baseNow - 120, { hasRecentGap: false, dustRatio: .01 });
  recomputeCostCompleteness(s.db, 'T', { hasRecentGap: false, dustRatio: .01 });
  expect(getLatestCycle(s.db, 'w1', 'T')!.costComplete).toBe(false);
});

it('缺口仍活跃时重建不能清除持久化的缺口标记', () => {
  const s = setup();
  upsertSourceHealth(s.db, { source: 'smartmoney', gap_from_ts: baseNow - 30, gap_to_ts: baseNow }, baseNow);
  expect(rebuildWalletToken(s.db, 'w1', 'T', baseNow - 120, { hasRecentGap: true, dustRatio: .01 }).rebuilt).toBe(true);
  expect(getKv(s.db, 'gap_affected:T:w1')).toBe(true);
  expect(getLatestCycle(s.db, 'w1', 'T')!.costComplete).toBe(false);
});

it('缺口之后取得零余额检查点，重建可恢复新周期资格', () => {
  const s = setup();
  upsertSourceHealth(s.db, { source: 'smartmoney', gap_from_ts: baseNow - 30, gap_to_ts: baseNow }, baseNow);
  resolveStaleGaps(s.db, baseNow + 601);
  s.buy('w1', baseNow + 700);
  rebuildWalletToken(s.db, 'w1', 'T', baseNow + 700, { hasRecentGap: false, dustRatio: .01 });
  recomputeCostCompleteness(s.db, 'T', { hasRecentGap: false, dustRatio: .01 });
  expect(getKv(s.db, 'gap_affected:T:w1')).toBe(false);
  expect(getLatestCycle(s.db, 'w1', 'T')!.costComplete).toBe(true);
});

it.each(['{not json}\n', '{"event_id":"old"}\n'])('损坏的已有归档阻止该日清理，数据库和原归档均保留 (%s)', (line) => {
  const d = db(); const old = baseNow - 40 * 86400;
  upsertTrades(d, 'smartmoney', [normalizeTrackItem('smartmoney', { transaction_hash: 'old', maker: 'w', base_address: 'T', side: 'buy', timestamp: old, token_amount: '1', amount_usd: 1 })!]);
  const dir = mkdtempSync(join(tmpdir(), 'meme-corrupt-archive-'));
  const file = join(dir, `trades-${new Date(old * 1000).toISOString().slice(0, 10)}.jsonl.gz`);
  const corrupt = gzipSync(line);
  try {
    writeFileSync(file, corrupt);
    expect(archiveAndPrune(d, { archiveDir: dir, retentionDays: 30, now: baseNow * 1000 }).deletedTrades).toBe(0);
    expect(d.prepare('SELECT COUNT(*) n FROM trades').get()).toEqual({ n: 1 });
    expect(readFileSync(file)).toEqual(corrupt);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('富化等待跨过窗口边界，不得按旧时间创建信号', async () => {
  const s = setup(); const original = s.deps.gateway.fetchTokenInfo;
  s.deps.gateway.fetchTokenInfo = async () => { s.setNow(baseNow + config.signal.windowMinutes * 60 + 1); return original(); };
  expect((await evaluateToken(s.deps, 'T')).pushTaskCreated).toBe(false);
  expect(s.db.prepare('SELECT COUNT(*) n FROM push_tasks').get()).toEqual({ n: 0 });
});

it('回测旧基准请求返回缺行情，不能消耗新基准重试次数', async () => {
  const d = db(); d.prepare("INSERT INTO signals(token,status,triggered_at,price_at_trigger) VALUES ('T','invalidated',?,'1')").run(baseNow - 400);
  await evaluateOutcomes({ db: d, config, logger: log, now: () => baseNow * 1000, gateway: { fetchKline: async () => {
    d.prepare("UPDATE signals SET status='pushed',sent_at=?,price_at_send='2'").run(baseNow);
    return { list: [] };
  } } });
  expect(getKv(d, 'backtest_attempts:1:outcome_5m')).toBeNull();
});

it('代币超过 24 小时不再创建退出提醒', async () => {
  const s = setup(); await evaluateToken(s.deps, 'T');
  s.db.prepare("UPDATE signals SET status='pushed',sent_at=?").run(baseNow);
  s.db.prepare("UPDATE tokens SET created_at=?").run(baseNow - 86401);
  s.db.prepare("UPDATE wallet_positions SET state='closed', sold_amount=bought_amount").run();
  expect(runExitMonitor(s.deps)).toBe(0);
});

it('补充退出提醒排队后重建纠正清仓，发送前应取消', async () => {
  const s = setup(); await evaluateToken(s.deps, 'T');
  s.db.prepare("UPDATE push_tasks SET status='sent'").run();
  s.db.prepare("UPDATE signals SET status='pushed', sent_at=?, tg_message_id=1").run(baseNow);
  for (let i = 0; i < config.exitAlerts.minWallets; i++) s.buy(`other${i}`);
  s.db.prepare("UPDATE wallet_positions SET state='closed',sold_amount=bought_amount,last_sell_ts=? WHERE wallet LIKE 'other%'").run(baseNow);
  s.setNow(baseNow+1);
  s.db.prepare("UPDATE wallet_positions SET last_sell_ts=? WHERE wallet LIKE 'other%'").run(baseNow+1);
  expect(runExitMonitor(s.deps)).toBe(1);
  s.db.prepare("UPDATE wallet_positions SET state='open',sold_amount='0' WHERE wallet LIKE 'other%'").run();
  const send = sender();
  expect((await new Pusher({ ...s.deps, chatId: 'test', sender: send }).runOnce()).cancelled).toBe(1);
  expect(send.sendMessage).not.toHaveBeenCalled();
});

it('关闭聚类时，同源钱包也应分别计票', () => {
  const s = setup();
  s.db.prepare("UPDATE wallets SET fund_from_address='same',wallet_created_at=?").run(baseNow - 10000);
  const options = { blacklist: { entries: new Map() }, sameFunder: true, creationTimeDeltaMinutes: 10, excludeFunderLabels: [] };
  expect(buildClusters(s.db, 'T', ['w1','w2','w3'], { ...options, enabled: true }).clusterCount).toBe(1);
  expect(buildClusters(s.db, 'T', ['w1','w2','w3'], { ...options, enabled: false }).clusterCount).toBe(3);
});

it('接口部分坏行不丢弃其他钱包，非法价格及溢出市值保持缺失', () => {
  expect(parseWalletStats([null, [], { wallet_address: 'valid', common: {} }]).map(w => w.address)).toEqual(['valid']);
  expect(parseTokenInfo({ price: { price: 'NaN' }, circulating_supply: 10 }).price).toBeNull();
  expect(parseTokenInfo({ price: { price: '1e300' }, circulating_supply: 1e300 }).marketCap).toBeNull();
});

it('发送快照的警告分组互斥，不受随后修改阈值影响', () => {
  const d = db();
  d.prepare("INSERT INTO signals(token,status,triggered_at,outcome_1h,send_snapshot) VALUES ('T','pushed',?,2,?)")
    .run(baseNow, JSON.stringify({ votes: 3, priceRatio: '1.8', warn: false }));
  expect(buildStatsReport(d, config).text).toContain('追高警告：—（0）');
  expect(buildStatsReport(d, config).text).toContain('无警告：2.00x（1）');
});

it('长统计报告按消息上限分段，完整保留内容与表情', async () => {
  const d = db();
  const insert = d.prepare("INSERT INTO signals(token,status,triggered_at,reason) VALUES ('T','invalidated',?,?)");
  for (let i = 0; i < 180; i++) insert.run(baseNow, `votes_below_min(${i})`);
  const send = sender(); const texts: string[] = [];
  const report = await sendDailyReport({ db: d, config, chatId: 'test', sender: { ...send, sendMessage: async (_chat, text) => { texts.push(text); return { message_id: 1 }; } } });
  expect(texts.length).toBeGreaterThan(1);
  expect(texts.every(text => text.length <= 4000)).toBe(true);
  expect(texts.join('')).toBe(report.text);
  expect(splitReportText('abc🧪def', 4)).toEqual(['abc', '🧪de', 'f']);
});


it('只统计加仓时，票数金额和追高均价共同排除建仓成交', async () => {
  const s = setup();
  const cfg = structuredClone(config); cfg.tradeFilter.actions = ['add']; cfg.signal.requireOpenAction = false;
  const initial = buildClusters(s.db, 'T', ['w1','w2','w3'], { blacklist: { entries: new Map() }, sameFunder: false, creationTimeDeltaMinutes: 10, excludeFunderLabels: [] });
  expect(computeWindow(s.db, 'T', baseNow, cfg, initial).votes).toBe(0);
  const additions = ['w1','w2','w3'].map(maker => normalizeTrackItem('smartmoney', {
    transaction_hash: `add-${maker}`, maker, base_address: 'T', side: 'buy', timestamp: baseNow - 10,
    token_amount: '750', amount_usd: 1500,
  })!);
  upsertTrades(s.db, 'smartmoney', additions);
  applyIngestedTrades(s.db, additions, .01);
  const window = computeWindow(s.db, 'T', baseNow, cfg, initial);
  expect(window.votes).toBe(3);
  expect(window.wallets.map(w => w.qualifyingBuyUsd.toNumber())).toEqual([1500,1500,1500]);
  const snapshot = await enrichToken(s.db, s.deps.gateway, 'T', { now: s.deps.now });
  const result = validateTokenSnapshot({ db: s.db, config: cfg, gateway: s.deps.gateway, token: 'T', nowSec: baseNow, validWallets: window.wallets }, snapshot);
  expect(result.avgEntry?.toNumber()).toBe(2);
});

it('同秒跨批次乱序与一次性按事件顺序重放得到相同持仓', () => {
  const s = setup();
  const make = (tx: string, side: string, amount: string) => normalizeTrackItem('smartmoney', {
    transaction_hash: tx, maker: 'w1', base_address: 'T', side, timestamp: baseNow - 5,
    token_amount: amount, amount_usd: amount,
  })!;
  const events = [make('same-buy','buy','500'), make('same-sell','sell','2000')]
    .sort((a,b) => a.eventId.localeCompare(b.eventId));
  for (const event of [...events].reverse()) {
    upsertTrades(s.db, 'smartmoney', [event]); applyIngestedTrades(s.db, [event], .01);
  }
  const columns = 'cycle_no,state,bought_amount,sold_amount';
  const actual = s.db.prepare(`SELECT ${columns} FROM wallet_positions WHERE wallet='w1' ORDER BY cycle_no`).all();
  rebuildWalletToken(s.db, 'w1', 'T', baseNow - 5, { dustRatio: .01, hasRecentGap: false });
  expect(s.db.prepare(`SELECT ${columns} FROM wallet_positions WHERE wallet='w1' ORDER BY cycle_no`).all()).toEqual(actual);
});

it('已推送信号跌破票数门槛时，展示分项同步移除过期成员', async () => {
  const s = setup(); await evaluateToken(s.deps, 'T');
  s.db.prepare("UPDATE signals SET status='pushed',sent_at=?,tg_message_id=1").run(baseNow);
  s.db.prepare("UPDATE trades SET timestamp=? WHERE maker='w3'").run(baseNow - config.signal.windowMinutes * 60 - 1);
  await evaluateToken(s.deps, 'T');
  const row = s.db.prepare('SELECT wallet_count,display_wallets FROM signals').get() as { wallet_count: number; display_wallets: string };
  expect(row.wallet_count).toBe(2);
  expect(JSON.parse(row.display_wallets)).toHaveLength(2);
});


it('社交缺失和权限尚未放弃按缺失值决策表暂缓，不进入硬过滤禁验期', async () => {
  const s = setup(); const cfg = structuredClone(config); cfg.tokenFilter.requireSocial = true;
  const snapshot = await enrichToken(s.db, s.deps.gateway, 'T', { now: s.deps.now });
  const input = { db: s.db, config: cfg, gateway: s.deps.gateway, token: 'T', nowSec: baseNow, validWallets: [] };
  expect(validateTokenSnapshot(input, snapshot)).toMatchObject({ status: 'deferred', reason: 'social_missing' });
  expect(validateTokenSnapshot(input, { ...snapshot, renouncedMint: false })).toMatchObject({ status: 'deferred', reason: 'mint_not_renounced' });
  expect(validateTokenSnapshot(input, { ...snapshot, renouncedFreeze: false })).toMatchObject({ status: 'deferred', reason: 'freeze_not_renounced' });
});

it('来源分组固定使用发送快照，后续成员变更不污染分组', () => {
  const d = db();
  d.prepare("INSERT INTO signals(token,status,triggered_at,outcome_1h,send_snapshot) VALUES ('T','pushed',?,2,?)")
    .run(baseNow, JSON.stringify({ sources: ['smartmoney','kol'], votes: 3 }));
  expect(buildStatsReport(d, config).text).toContain('来源 意见领袖＋聪明钱：2.00x（1）');
});

it('同票数成员替换也触发升级，成员版本独立于价格修订', async () => {
  const s = setup(); await evaluateToken(s.deps, 'T');
  await new Pusher({ ...s.deps, chatId: 'test', sender: sender(), revalidate: id => revalidateSignalForSend(s.deps, id) }).runOnce();
  const revisions = () => s.db.prepare('SELECT message_revision,escalated_count FROM signals').get();
  s.setNow(baseNow + 31); s.setPrice('1.2'); s.db.prepare('UPDATE tokens SET price_updated_at=0').run();
  await evaluateToken(s.deps, 'T');
  expect(revisions()).toEqual({ message_revision: 1, escalated_count: 0 });
  s.setNow(baseNow + 62); s.buy('w4');
  s.db.prepare(`UPDATE wallets SET tags='["scammer"]' WHERE address='w3'`).run();
  expect((await evaluateToken(s.deps, 'T')).pushTaskCreated).toBe(true);
  expect(revisions()).toEqual({ message_revision: 2, escalated_count: 1 });
  expect(s.db.prepare("SELECT joined_version FROM signal_wallets WHERE wallet='w4'").get()).toEqual({ joined_version: 1 });
});

it('被编辑节流延后的成员变化保留待更新状态，下一次评估仍会入队', async () => {
  const s = setup(); await evaluateToken(s.deps, 'T');
  await new Pusher({ ...s.deps, chatId: 'test', sender: sender(), revalidate: id => revalidateSignalForSend(s.deps, id) }).runOnce();
  setKv(s.db, 'edit_last:1', baseNow);
  s.setNow(baseNow + 10); s.buy('w4');
  expect((await evaluateToken(s.deps, 'T')).pushTaskCreated).toBe(false);
  const row = s.db.prepare('SELECT wallet_count,display_wallets FROM signals').get() as { wallet_count: number; display_wallets: string };
  expect(row.wallet_count).toBe(3); expect(JSON.parse(row.display_wallets)).toHaveLength(3);
  s.setNow(baseNow + 31);
  expect((await evaluateToken(s.deps, 'T')).pushTaskCreated).toBe(true);
  expect(s.db.prepare('SELECT wallet_count FROM signals').get()).toEqual({ wallet_count: 4 });
});
