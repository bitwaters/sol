import { Bot, HttpError, type Context } from 'grammy';
import { buildStatsReport, splitReportText } from '../backtest/report.js';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { setKv, type Db } from '../store/db.js';
import { BOT_COMMANDS, HELP_KEYBOARD, helpText, statusText, configText, walletsText } from './commands.js';
import { TelegramDeliveryUnknownError, TelegramRateLimitError, type SendMessageOptions, type TelegramApi } from './types.js';

function toTelegramError(err: unknown): never {
  if (err instanceof HttpError || (err instanceof Error && ['TimeoutError', 'AbortError'].includes(err.name))) {
    throw new TelegramDeliveryUnknownError();
  }
  if (err === null || typeof err !== 'object') throw err;
  const candidate = err as { error_code?: number; parameters?: { retry_after?: number }; error?: { error_code?: number; parameters?: { retry_after?: number } } };
  const code = candidate.error_code ?? candidate.error?.error_code;
  const retryAfter = candidate.parameters?.retry_after ?? candidate.error?.parameters?.retry_after;
  if (code === 429 && typeof retryAfter === 'number') {
    throw new TelegramRateLimitError(retryAfter);
  }
  throw err;
}

export interface BotDeps {
  db: Db;
  config: AppConfig;
  logger: Logger;
  adminIds: string[];
  alertChatId?: string;
  now?: () => number;
}

export function isAdmin(userId: number | undefined, adminIds: string[]): boolean {
  return userId !== undefined && adminIds.includes(String(userId));
}

/** grammY 适配为项目内 TelegramApi（测试可替换） */
export function grammySender(bot: Bot): TelegramApi {
  return {
    async sendMessage(chatId: string, text: string, options?: SendMessageOptions) {
      try {
        const msg = await bot.api.sendMessage(chatId, text, options as never);
        return { message_id: msg.message_id };
      } catch (err) {
        toTelegramError(err);
      }
    },
    async editMessageText(
      chatId: string,
      messageId: number,
      text: string,
      options?: SendMessageOptions,
    ) {
      try {
        await bot.api.editMessageText(chatId, messageId, text, options as never);
      } catch (err) {
        if (err instanceof Error && /message is not modified/i.test(err.message)) return;
        toTelegramError(err);
      }
    },
    async answerCallbackQuery(callbackId: string, text?: string) {
      await bot.api.answerCallbackQuery(callbackId, text ? { text } : undefined);
    },
  };
}

/** Install the same command catalog shown by /help into Telegram's native menu. */
export async function registerBotCommands(bot: Bot): Promise<void> {
  await bot.api.setMyCommands(BOT_COMMANDS);
  await bot.api.setChatMenuButton({ menu_button: { type: 'commands' } });
}

/** 命令与回调统一鉴权；/pause 只停新信号，采集/退出监控/告警继续 */
export function createBot(token: string, deps: BotDeps): Bot {
  const { db, config, logger } = deps;
  const now = (): number => Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const bot = new Bot(token);

  bot.use(async (ctx, next) => {
    if (!isAdmin(ctx.from?.id, deps.adminIds)) {
      logger.warn('拒绝非管理员操作', { userId: ctx.from?.id, update: ctx.update.update_id });
      if (ctx.callbackQuery) await ctx.answerCallbackQuery('⛔ 仅授权管理员可操作').catch(() => undefined);
      else if (ctx.chat) await ctx.reply('⛔ 仅授权管理员可使用此机器人。').catch(() => undefined);
      return;
    }
    await next();
  });

  const queries: Record<string, (ctx: Context) => Promise<void>> = {
    help: async ctx => { await ctx.reply(helpText(), { reply_markup: HELP_KEYBOARD }); },
    status: async ctx => { await ctx.reply(statusText(db, now())); },
    config: async ctx => { for (const text of splitReportText(configText(config))) await ctx.reply(text); },
    stats: async ctx => { for (const text of splitReportText(buildStatsReport(db, config).text)) await ctx.reply(text); },
    wallets: async ctx => { await ctx.reply(walletsText(db, now())); },
    test: async ctx => { await ctx.reply('✅ 机器人在线，指令接收与回复正常。此测试不代表已产生合格信号或完成信号推送。'); },
  };
  for (const [name, handler] of Object.entries(queries)) bot.command(name, handler);
  bot.command('start', queries['help']!);

  bot.command('pause', async (ctx) => {
    setKv(db, 'paused', true, now());
    await ctx.reply('⏸ 已暂停新信号及跟进消息；采集、评估、退出提醒与告警继续。发送 /resume 恢复。');
  });

  bot.command('resume', async (ctx) => {
    setKv(db, 'paused', false, now());
    await ctx.reply('▶️ 已恢复新信号及跟进消息，仍按最新策略复核后发送。');
  });

  bot.command('mute', async (ctx) => {
    const [ca, hoursRaw] = (ctx.match ?? '').trim().split(/\s+/);
    if (!ca) {
      await ctx.reply('用法：/mute 合约地址 [小时数]（省略小时数则永久屏蔽）');
      return;
    }
    const hours = hoursRaw ? Number(hoursRaw) : null;
    if (hours !== null && (!Number.isFinite(hours) || hours <= 0)) {
      await ctx.reply('小时数必须是正数');
      return;
    }
    setKv(db, `mute:${ca}`, hours === null ? true : { until: now() + hours * 3600 }, now());
    await ctx.reply(`🔕 已屏蔽 ${ca}${hours === null ? '（永久）' : `（${hours} 小时）`}`);
  });

  bot.command('unmute', async (ctx) => {
    const ca = (ctx.match ?? '').trim();
    if (!ca) {
      await ctx.reply('用法：/unmute 合约地址');
      return;
    }
    setKv(db, `mute:${ca}`, { until: 0 }, now());
    await ctx.reply(`🔔 已解除屏蔽 ${ca}`);
  });

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const [action, token] = data.split(':');
    if (action === 'command') {
      const handler = token && Object.hasOwn(queries, token) ? queries[token] : undefined;
      await ctx.answerCallbackQuery(handler ? undefined : '此快捷按钮已失效，请使用 /help');
      if (handler) await handler(ctx);
      return;
    }
    if (action === 'mute' && token) {
      setKv(db, `mute:${token}`, true, now());
      await ctx.answerCallbackQuery('已屏蔽该币');
      return;
    }
    if (action === 'refresh') {
      await ctx.answerCallbackQuery('刷新将在下一轮评估更新');
      return;
    }
    await ctx.answerCallbackQuery('未知操作');
  });

  bot.catch((err) => {
    logger.error('Bot 错误', { error: err.error });
  });

  return bot;
}
