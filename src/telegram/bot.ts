import { Bot, HttpError } from 'grammy';
import { buildStatsReport, splitReportText } from '../backtest/report.js';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { getKv, setKv, type Db } from '../store/db.js';
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

function startOfUtcDay(nowSec: number): number {
  const d = new Date(nowSec * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
}

/** 命令与回调统一鉴权；/pause 只停新信号，采集/退出监控/告警继续 */
export function createBot(token: string, deps: BotDeps): Bot {
  const { db, config, logger } = deps;
  const now = (): number => Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const bot = new Bot(token);

  bot.use(async (ctx, next) => {
    if (!isAdmin(ctx.from?.id, deps.adminIds)) {
      logger.warn('拒绝非管理员操作', { userId: ctx.from?.id, update: ctx.update.update_id });
      if (ctx.chat) await ctx.reply('⛔ 无权限').catch(() => undefined);
      return;
    }
    await next();
  });

  bot.command('status', async (ctx) => {
    const health = db
      .prepare('SELECT source, last_success_at, watermark_ts, gap_from_ts FROM source_health')
      .all() as Array<Record<string, unknown>>;
    const today = db
      .prepare("SELECT COUNT(*) AS n FROM signals WHERE status = 'pushed' AND sent_at >= ?")
      .get(startOfUtcDay(now())) as { n: number };
    const pending = db
      .prepare("SELECT COUNT(*) AS n FROM push_tasks WHERE status IN ('pending','failed','sending')")
      .get() as { n: number };
    const paused = getKv<boolean>(db, 'paused') === true;
    const lines = [
      `📊 状态（${new Date(now() * 1000).toISOString()}）`,
      `暂停：${paused ? '是' : '否'} · 今日信号：${today.n} · 待发送：${pending.n}`,
      '',
      ...health.map(
        (h) =>
          `· ${h['source']}：水位 ${h['watermark_ts'] ?? '—'} · 缺口 ${h['gap_from_ts'] ?? '无'}`,
      ),
    ];
    await ctx.reply(lines.join('\n'));
  });

  bot.command('pause', async (ctx) => {
    setKv(db, 'paused', true, now());
    await ctx.reply('⏸ 已暂停新信号（采集与退出监控继续）');
  });

  bot.command('resume', async (ctx) => {
    setKv(db, 'paused', false, now());
    await ctx.reply('▶️ 已恢复新信号');
  });

  bot.command('mute', async (ctx) => {
    const [ca, hoursRaw] = (ctx.match ?? '').trim().split(/\s+/);
    if (!ca) {
      await ctx.reply('用法：/mute <CA> [小时数]（省略=永久）');
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
      await ctx.reply('用法：/unmute <CA>');
      return;
    }
    setKv(db, `mute:${ca}`, { until: 0 }, now());
    await ctx.reply(`🔔 已解除屏蔽 ${ca}`);
  });

  bot.command('config', async (ctx) => {
    const summary = {
      windowMinutes: config.signal.windowMinutes,
      minWallets: config.signal.minDistinctWallets,
      strongWallets: config.signal.strongWallets,
      minTradeAmountUsd: config.tradeFilter.minTradeAmountUsd,
      netInflowMin: config.tradeFilter.netInflowUsd.min,
      holdingRatioMin: config.signalValidation.minConsensusHoldingRatio,
      warnPriceAboveEntry: config.signalValidation.warnPriceAboveEntry,
      blockPriceAboveEntry: config.signalValidation.blockPriceAboveEntry,
      quietHours: config.push.quietHours,
    };
    await ctx.reply(`⚙️ 当前生效阈值\n<pre>${JSON.stringify(summary, null, 2)}</pre>`, {
      parse_mode: 'HTML',
    });
  });

  bot.command('test', async (ctx) => {
    await ctx.reply('✅ 测试消息：Bot 在线，推送链路正常');
  });

  bot.command('stats', async (ctx) => {
    const report = buildStatsReport(db, config);
    for (const text of splitReportText(report.text)) await ctx.reply(text);
  });

  bot.command('wallets', async (ctx) => {
    const rows = db
      .prepare(
        `SELECT DISTINCT t.maker FROM trades t
         JOIN trade_sources s ON s.event_id = t.event_id
         WHERE s.source = 'follow' AND t.timestamp >= ?
         ORDER BY t.maker LIMIT 50`,
      )
      .all(now() - 30 * 86_400) as Array<{ maker: string }>;
    if (rows.length === 0) {
      await ctx.reply('📋 暂无 follow 成交（未配置私钥或列表为空）');
      return;
    }
    const list = rows
      .map((r) => `${r.maker.slice(0, 6)}…${r.maker.slice(-4)}`)
      .join('\n');
    await ctx.reply(`📋 Follow 列表（近 30 天出现，${rows.length} 个）\n${list}`);
  });

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const [action, token] = data.split(':');
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
