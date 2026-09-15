import { expect, it } from 'vitest';
import { createBot, registerBotCommands } from '../src/telegram/bot.js';
import { BOT_COMMANDS, HELP_KEYBOARD, configText, helpText, statusText, walletsText } from '../src/telegram/commands.js';
import { developerStatus, reasonLabel } from '../src/telegram/labels.js';
import { openDatabase, getKv } from '../src/store/db.js';
import { upsertSourceHealth } from '../src/store/repo/health.js';
import { buildStatsReport } from '../src/backtest/report.js';
import { config, log } from './review-fixture.js';

function harness() {
  const db = openDatabase({ path: ':memory:' });
  const bot = createBot('test-token', { db, config, logger: log, adminIds: ['7'], now: () => 2000000 });
    bot.botInfo = { id: 10, is_bot: true, first_name: 'Test', username: 'test_bot', can_join_groups: true,
      can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false,
      has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false };
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: true } as never;
  });
  let id = 1;
  const user = (who: number) => ({ id: who, is_bot: false as const, first_name: 'test' });
  const chat = { id: 100, type: 'private' as const, first_name: 'test' };
  const command = (text: string, who = 7) => bot.handleUpdate({ update_id: id++, message: {
    message_id: id, date: 2000, from: user(who), chat, text,
    entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }],
  } });
  const callback = (data: string, who = 7) => bot.handleUpdate({ update_id: id++, callback_query: {
    id: String(id), from: user(who), chat_instance: 'test', data, message: { message_id: id, date: 2000, chat },
  } });
  return { db, bot, calls, command, callback };
}

it('every advertised command is handled, and help and native menu use the same catalog', async () => {
  const h = harness();
  try {
    const args: Record<string, string> = { mute: ' SYNTHETIC 2', unmute: ' SYNTHETIC' };
    for (const item of BOT_COMMANDS) {
      const before = h.calls.length;
      await h.command('/' + item.command + (args[item.command] ?? ''));
      expect(h.calls.slice(before).some(call => call.method === 'sendMessage'), item.command).toBe(true);
      expect(helpText()).toContain('/' + item.command);
    }
    expect(getKv(h.db, 'paused')).toBe(false);
    await registerBotCommands(h.bot);
    expect(h.calls.find(call => call.method === 'setMyCommands')?.payload.commands).toEqual(BOT_COMMANDS);
    expect(h.calls.find(call => call.method === 'setChatMenuButton')?.payload.menu_button).toEqual({ type: 'commands' });
    const configReply = h.calls.find(call => String(call.payload.text).startsWith('⚙️ 当前策略配置'));
    expect(configReply?.payload.text).toContain('共识持仓最低保留率：60%');
    expect(configReply?.payload.text).not.toContain('windowMinutes');
    expect(h.calls.some(call => String(call.payload.text).includes('不代表已产生合格信号'))).toBe(true);
  } finally { h.db.close(); }
});

it('help shortcuts execute the same read-only handlers and reject unauthorized or forged callbacks', async () => {
  const h = harness();
  try {
    for (const button of HELP_KEYBOARD.inline_keyboard.flat()) {
      h.calls.length = 0;
      await h.callback(button.callback_data);
      expect(h.calls[0]?.method).toBe('answerCallbackQuery');
      expect(h.calls.some(call => call.method === 'sendMessage')).toBe(true);
      h.calls.length = 0;
      await h.callback(button.callback_data, 8);
      expect(h.calls.map(call => call.method)).toEqual(['answerCallbackQuery']);
      expect(h.calls[0]?.payload.text).toContain('仅授权管理员');
    }
    for (const key of ['pause', 'toString', '__proto__']) {
      h.calls.length = 0; await h.callback('command:' + key);
      expect(h.calls.map(call => call.method)).toEqual(['answerCallbackQuery']);
    }
    expect(getKv(h.db, 'paused')).toBeNull();
    h.calls.length = 0; await h.command('/help', 8);
    expect(h.calls[0]?.payload.text).toContain('仅授权管理员');
  } finally { h.db.close(); }
});

it('status renders source names, UTC dates, empty data and uncertain/exhausted queue counts', () => {
  const h = harness();
  try {
    upsertSourceHealth(h.db, { source: 'follow', last_success_at: 1800, watermark_ts: 1790, gap_from_ts: 1700, gap_to_ts: 1780 }, 2000);
    for (const [i, status, attempts] of [[1, 'pending', 0], [2, 'sending', 1], [3, 'unknown', 1], [4, 'failed', 3], [5, 'sent', 1]] as const) {
      h.db.prepare("INSERT INTO push_tasks(signal_id,kind,dedupe_key,payload,status,attempts,created_at,updated_at) VALUES (1,'signal',?,'{}',?,?,1000,1000)").run(String(i), status, attempts);
    }
    const text = statusText(h.db, 2000);
    expect(text).toContain('【关注钱包】'); expect(text).toContain('1970-01-01 00:30:00 UTC');
    expect(text).toContain('待发送 1 · 发送中 1 · 待重试 1 · 重试耗尽 1');
    expect(text).toContain('暂无记录'); expect(text).not.toMatch(/follow|smartmoney|watermark|unknown/);
  } finally { h.db.close(); }
});

it('reason labels cover dynamic thresholds, token ranges, nested rechecks and safe unknown values', () => {
  expect(reasonLabel('send_recheck:votes_below_min(2)')).toBe('发送前复核：有效票数不足（当前 2 票）');
  expect(reasonLabel('raw_votes_below_min(2)')).toBe('过滤前聚类票数不足（当前 2 票）');
  expect(reasonLabel('raw_addresses_below_min(1)')).toBe('达到买入金额门槛的钱包数不足（当前 1 个）');
  expect(reasonLabel('holding_ratio_below_min(0.3456)')).toContain('34.56%');
  expect(reasonLabel('price_above_entry(2.30x)')).toContain('2.3 倍');
  for (const field of ['age', 'market_cap', 'holder_count', 'liquidity', 'top10', 'bundler', 'insider', 'entrapment', 'bot_degen', 'fresh_wallet', 'dev_hold', 'sniper_count']) {
    for (const suffix of ['missing', 'above_max', 'below_min']) expect(reasonLabel(field + '_' + suffix)).not.toContain('待排查');
  }
  expect(reasonLabel('unrecognized_PRIVATE_PAYLOAD')).toBe('其他原因（待排查）');
  expect(reasonLabel(null)).toBe('未记录原因');
  expect(reasonLabel('constructor')).toBe('其他原因（待排查）');
  expect(developerStatus('__proto__')).toBe('状态待确认');
  expect(developerStatus('creator_close')).toBe('已清仓');
  expect(developerStatus('unrecognized')).toBe('状态待确认');
});

it('stats translate and aggregate unknown reasons without changing stored reason codes', () => {
  const h = harness();
  try {
    for (const reason of ['integrity_gap', 'send_recheck:market_cap_above_max', 'unknown_one', 'unknown_two']) {
      h.db.prepare("INSERT INTO signals(token,status,triggered_at,reason) VALUES ('T','invalidated',1000,?)").run(reason);
    }
    const text = buildStatsReport(h.db, config).text;
    expect(text).toContain('采集存在缺口'); expect(text).toContain('发送前复核：代币市值超过上限');
    expect(text).toContain('其他原因（待排查）：—（0/2）');
    expect(text).not.toMatch(/integrity_gap|market_cap|unknown_one|unknown_two/);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM signals WHERE reason='integrity_gap'").get()).toEqual({ n: 1 });
  } finally { h.db.close(); }
});

it('config uses units and null bounds, and wallets distinguish observed totals from display limits', () => {
  const h = harness();
  try {
    const c = structuredClone(config); c.tradeFilter.netInflowUsd = { min: null, max: null };
    expect(configText(c)).toContain('净流入范围：不限 ～ 不限');
    expect(configText(c)).not.toMatch(/windowMinutes|quietHours|strongWallets|true|false|null/);
    expect(walletsText(h.db, 2000)).toContain('暂无关注钱包成交记录');
    expect(walletsText(h.db, 2000)).not.toContain('私钥');
    for (let i = 0; i < 55; i++) {
      h.db.prepare("INSERT INTO trades(event_id,chain,tx_hash,maker,base_address,side,timestamp,created_at) VALUES (?,'sol',?,?,'T','buy',1000,1000)").run('event' + i, 'tx' + i, 'wallet' + i);
      h.db.prepare("INSERT INTO trade_sources(event_id,source,first_seen_at) VALUES (?,'follow',1000)").run('event' + i);
    }
    const text = walletsText(h.db, 2000);
    expect(text).toContain('共 55 个，展示 50 个');
    expect(text).toContain('并非 GMGN 完整关注名单');
  } finally { h.db.close(); }
});
