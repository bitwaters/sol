/** Explicit one-shot test; never starts the production pusher or opens its database. */
import { Bot } from 'grammy';
import { loadConfig } from '../config.js';
import { formatSignalMessage, formatExitAlert, type SignalView } from '../telegram/format.js';
const prefix = '🧪 联调测试：以下为虚构数据，非交易信号\n\n';
const sample: SignalView = {
  signalId: 1, token: 'SYNTHETIC_TEST_TOKEN', symbol: 'TEST', launchpad: '测试', tokenAgeMinutes: 30,
  marketCap: 50000, liquidity: 20000, holderCount: 200, votes: 3, windowMinutes: 15,
  wallets: [{ clusterId: 'test', tags: ['smart_degen'], sources: ['smartmoney'], action: 'open', qualifyingBuyUsd: '4500' }],
  totalBuyUsd: '4500', netInflowUsd: '4000', retentionRatio: .8, priceRatio: 1.1,
  currentPrice: '1.1', avgEntryPrice: '1', top10Rate: .1, bundlerRate: .1, insiderRate: .1,
  devStatus: null, socials: {}, partialHoldings: false,
};
const options = { links: [], buyButton: 'none' };
const signal = prefix + formatSignalMessage(sample, options);
const upgrade = prefix + formatSignalMessage({ ...sample, votes: 5, upgraded: true, escalateDelta: 2 }, options);
const exit = prefix + formatExitAlert({ ...sample, exitedClusters: 2, clusterBreakdown: [{ label: '测试', count: 2 }], retentionRatio: .2 });
const alert = '🧪 运维告警通道联调测试：模拟告警，当前没有因此触发的真实故障。';
const mode = process.argv[2] ?? '--preview';
if (mode === '--preview') {
  console.log(JSON.stringify({ productionPusherStarted: false, sends: ['signal', 'exit', 'ops_alert'], edits: ['signal_upgrade'], messages: { signal, upgrade, exit, alert } }, null, 2));
} else {
  if (!['--preflight', '--send-test'].includes(mode)) throw new Error('Unknown mode');
  try {
    const { env } = loadConfig();
    if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID || !env.TG_ALERT_CHAT_ID) throw new Error('Telegram test configuration missing');
    const bot = new Bot(env.TG_BOT_TOKEN);
    const me = await bot.api.getMe();
    const chat = await bot.api.getChat(env.TG_CHAT_ID);
    const alertChat = await bot.api.getChat(env.TG_ALERT_CHAT_ID);
    const member = await bot.api.getChatMember(env.TG_CHAT_ID, me.id);
    const alertMember = await bot.api.getChatMember(env.TG_ALERT_CHAT_ID, me.id);
    if (mode === '--preflight') {
      console.log(JSON.stringify({ bot: me.username, targetType: chat.type,
        targetTitle: 'title' in chat ? chat.title : chat.first_name, targetRole: member.status,
        alertType: alertChat.type, alertTitle: 'title' in alertChat ? alertChat.title : alertChat.first_name,
        alertRole: alertMember.status, messagesSent: 0 }));
    } else {
      const timings: Record<string, number> = {};
      let started = performance.now();
      const sent = await bot.api.sendMessage(env.TG_CHAT_ID, signal, { parse_mode: 'HTML' });
      timings.signalMs = Math.round(performance.now() - started);
      started = performance.now();
      await bot.api.editMessageText(env.TG_CHAT_ID, sent.message_id, upgrade, { parse_mode: 'HTML' });
      timings.upgradeMs = Math.round(performance.now() - started);
      started = performance.now();
      await bot.api.sendMessage(env.TG_CHAT_ID, exit, { parse_mode: 'HTML', reply_parameters: { message_id: sent.message_id } });
      timings.exitMs = Math.round(performance.now() - started);
      started = performance.now();
      await bot.api.sendMessage(env.TG_ALERT_CHAT_ID, alert);
      timings.alertMs = Math.round(performance.now() - started);
      console.log(JSON.stringify({ messagesSent: 3, messagesEdited: 1, productionPusherStarted: false, timings }));
    }
  } catch (error) {
    const err = error as { error_code?: number; name?: string };
    console.log(JSON.stringify({ telegramCheckFailed: true, apiCode: err.error_code,
      errorType: ['GrammyError', 'HttpError'].includes(err.name ?? '') ? err.name : 'Error' }));
    process.exitCode = 1;
  }
}
