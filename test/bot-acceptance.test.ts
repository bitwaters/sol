import { expect, it, vi } from 'vitest';
import { HttpError } from 'grammy';
import type { Update } from 'grammy/types';
import { createBot, grammySender } from '../src/telegram/bot.js';
import { TelegramDeliveryUnknownError } from '../src/telegram/types.js';
import { getKv, openDatabase } from '../src/store/db.js';
import { config, log } from './review-fixture.js';
import { buildKeyboard } from '../src/telegram/format.js';

it('the trading link uses the official Trojan bot without an invented token-start contract', () => {
  const keyboard = buildKeyboard('SYNTHETIC', { links: ['trojan'], buyButton: 'trojan' });
  expect(keyboard.inline_keyboard[0]?.[1]).toEqual({ text: '⚡ 打开交易机器人', url: 'https://t.me/solana_trojanbot' });
});

it('admin commands and callback mutations use the same authorization middleware', async () => {
  const db = openDatabase({ path: ':memory:' });
  try {
    const bot = createBot('test-token', { db, config, logger: log, adminIds: ['7'] });
    bot.botInfo = { id: 10, is_bot: true, first_name: 'Test', username: 'test_bot', can_join_groups: true,
      can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false,
      has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false };
    const calls: string[] = [];
    bot.api.config.use(async (_previous, method) => {
      calls.push(method);
      // All outbound API calls terminate here; no Telegram network access.
      return { ok: true, result: true } as never;
    });
    let updateId = 1;
    const command = async (user: number, text: string) => bot.handleUpdate({ update_id: updateId++, message: {
      message_id: updateId, date: 1000, from: { id: user, is_bot: false, first_name: 'test' },
      chat: { id: 100, type: 'private', first_name: 'test' }, text,
      entities: [{ type: 'bot_command', offset: 0, length: text.indexOf(' ') < 0 ? text.length : text.indexOf(' ') }],
    } });
    await command(8, '/pause'); expect(getKv(db, 'paused')).toBeNull();
    await command(7, '/pause'); expect(getKv(db, 'paused')).toBe(true);
    await command(7, '/resume'); expect(getKv(db, 'paused')).toBe(false);
    const callback = (user: number): Update => ({ update_id: updateId++, callback_query: { id: 'callback-test',
      from: { id: user, is_bot: false, first_name: 'test' }, chat_instance: 'test', data: 'mute:SYNTHETIC',
      message: { message_id: 1, date: 1000, chat: { id: 100, type: 'private', first_name: 'test' } },
    } });
    await bot.handleUpdate(callback(8)); expect(getKv(db, 'mute:SYNTHETIC')).toBeNull();
    await bot.handleUpdate(callback(7)); expect(getKv(db, 'mute:SYNTHETIC')).toBe(true);
    expect(calls).toContain('answerCallbackQuery');
  } finally { db.close(); }
});

it('grammy network errors are classified as uncertain delivery without copying transport payloads', async () => {
  const db = openDatabase({ path: ':memory:' });
  try {
    const bot = createBot('test-token', { db, config, logger: log, adminIds: [] });
    const failure = new HttpError('test transport message', new Error('synthetic request payload'));
    vi.spyOn(bot.api, 'sendMessage').mockRejectedValue(failure);
    await expect(grammySender(bot).sendMessage('test-chat', 'test')).rejects.toBeInstanceOf(TelegramDeliveryUnknownError);
    await expect(grammySender(bot).sendMessage('test-chat', 'test')).rejects.not.toThrow('synthetic request payload');
  } finally { db.close(); }
});
