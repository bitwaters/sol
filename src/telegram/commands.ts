import type { AppConfig } from '../config.js';
import type { Db } from '../store/db.js';
import { getKv } from '../store/db.js';
import { sourceLabel, utcTime } from './labels.js';

export const BOT_COMMANDS = [
  { command: 'help', description: '查看指令说明与快捷按钮' },
  { command: 'start', description: '打开机器人使用指南' },
  { command: 'status', description: '查看采集状态、信号和发送队列' },
  { command: 'config', description: '查看当前策略阈值与采集设置' },
  { command: 'stats', description: '查看信号表现与未推送原因' },
  { command: 'research', description: '查看当前版本研究进度与调参条件' },
  { command: 'wallets', description: '查看近30天观测到的关注钱包' },
  { command: 'test', description: '检查机器人指令回复是否正常' },
  { command: 'pause', description: '暂停新信号及跟进消息，保留退出提醒' },
  { command: 'resume', description: '恢复新信号及跟进消息' },
  { command: 'mute', description: '屏蔽代币：/mute 合约地址 [小时数]' },
  { command: 'unmute', description: '解除屏蔽：/unmute 合约地址' },
] as const;

export const HELP_KEYBOARD = { inline_keyboard: [
  [{ text: '📊 运行状态', callback_data: 'command:status' }, { text: '⚙️ 策略配置', callback_data: 'command:config' }],
  [{ text: '📈 信号表现', callback_data: 'command:stats' }, { text: '📋 关注钱包', callback_data: 'command:wallets' }],
  [{ text: '🔬 研究进度', callback_data: 'command:research' }],
  [{ text: '✅ 回复测试', callback_data: 'command:test' }, { text: '❓ 使用帮助', callback_data: 'command:help' }],
] };

export function helpText(): string {
  return ['📖 指令帮助', '仅授权管理员在机器人私聊中使用。可点击下方查询按钮，或从 Telegram 命令菜单选择。', '',
    ...BOT_COMMANDS.map(item => `/${item.command} — ${item.description}`), '',
    '屏蔽用法：/mute 合约地址 2（屏蔽2小时）；省略小时数则永久屏蔽。',
    '解除屏蔽：/unmute 合约地址。将“合约地址”替换为实际 Solana 代币地址。',
    '暂停后采集、评估、退出提醒及运维告警继续；恢复不会保证补发已过期信号。',
    '消息按钮：打开 GMGN 查看代币；刷新提示等待下一轮状态评估；屏蔽该币会永久屏蔽新信号。',
    '关注钱包页面仅展示本服务观测到的成交钱包，不代表完整关注名单。',
    '所有时间均为 UTC。机器人只推送信息，不执行交易。',
  ].join('\n');
}

export function statusText(db: Db, now: number): string {
  const today = Math.floor(now / 86400) * 86400;
  const pushed = db.prepare("SELECT COUNT(*) AS n FROM signals WHERE sent_at >= ?").get(today) as { n: number };
  const queue = db.prepare(`SELECT
    SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
    SUM(CASE WHEN status='sending' THEN 1 ELSE 0 END) AS sending,
    SUM(CASE WHEN status IN ('failed','unknown') AND attempts < max_attempts THEN 1 ELSE 0 END) AS retry,
    SUM(CASE WHEN status IN ('failed','unknown') AND attempts >= max_attempts THEN 1 ELSE 0 END) AS exhausted
    FROM push_tasks`).get() as Record<string, number | null>;
  const health = db.prepare('SELECT source,last_success_at,watermark_ts,gap_from_ts,gap_to_ts FROM source_health').all() as Array<{
    source: string; last_success_at: number | null; watermark_ts: number | null; gap_from_ts: number | null; gap_to_ts: number | null;
  }>;
  const sources = getKv<string[]>(db, 'enabled_sources') ?? ['smartmoney', 'kol', 'follow'];
  return ['📊 运行状态', `查询时间：${utcTime(now)}`, '监测链：Solana',
    `新信号推送：${getKv<boolean>(db, 'paused') === true ? '已暂停' : '未暂停'}`,
    `今日首次推送：${pushed.n} 条`,
    `发送队列：待发送 ${queue.pending ?? 0} · 发送中 ${queue.sending ?? 0} · 待重试 ${queue.retry ?? 0} · 重试耗尽 ${queue.exhausted ?? 0}`, '',
    ...sources.flatMap(source => {
      const row = health.find(item => item.source === source);
      return [`【${sourceLabel(source)}】`,
        `最近成功采集：${utcTime(row?.last_success_at)}`,
        `最新已处理成交：${utcTime(row?.watermark_ts)}`,
        `采集缺口：${row?.gap_from_ts == null ? '当前未记录' : `${utcTime(row.gap_from_ts)} 至 ${utcTime(row.gap_to_ts)}`}`];
    }), '', '未记录缺口不代表历史成交完整。/help 查看全部指令。',
  ].join('\n');
}

export function configText(c: AppConfig): string {
  const on = (value: boolean) => value ? '是' : '否';
  const pct = (value: number) => `${Number((value * 100).toFixed(2))}%`;
  const range = (r: { min: number | null; max: number | null }, unit: string) => `${r.min === null ? '不限' : r.min + unit} ～ ${r.max === null ? '不限' : r.max + unit}`;
  return ['⚙️ 当前策略配置', '监测链：Solana · 金额单位：美元 · 时间：UTC', '',
    '【信号条件】', `共识统计窗口：${c.signal.windowMinutes} 分钟`,
    `触发最低票数：${c.signal.minDistinctWallets} 票 · 校验最低有效票数：${c.signalValidation.minValidWallets} 票`,
    `强共识门槛：${c.signal.strongWallets} 票 · 同源钱包合并计票：${on(c.signal.clusterMerge)}`,
    `要求新建仓买入：${on(c.signal.requireOpenAction)} · 要求聪明钱参与：${on(c.signal.requireAtLeastOneSmartMoney)}`,
    `同币推送冷却：${c.signal.cooldownMinutes} 分钟`, '',
    '【买入与持仓】', `计票买入类型：${c.tradeFilter.actions.map(a => a === 'open' ? '建仓' : '加仓').join('、')}`,
    `单笔买入最低金额：${c.tradeFilter.minTradeAmountUsd} 美元`,
    `净流入范围：${range(c.tradeFilter.netInflowUsd, ' 美元')}`,
    `有效钱包票数上限：${c.tradeFilter.walletCount.max ?? '不限'}`,
    `最低可核验钱包：${c.signalValidation.minVerifiableWallets} 个`,
    `共识持仓最低保留率：${pct(c.signalValidation.minConsensusHoldingRatio)}`,
    `快进快出过滤：${c.signalValidation.fastFlipMinutes} 分钟内卖出至少 ${pct(c.signalValidation.fastFlipSellRatio)}`,
    `剔除已清仓钱包：${on(c.signalValidation.dropFullyExitedWallets)} · 残余持仓阈值：${pct(c.signalValidation.positionDustRatio)}`,
    `追高警告：现价超过共识均价 ${c.signalValidation.warnPriceAboveEntry} 倍`,
    `追高拦截：现价超过共识均价 ${c.signalValidation.blockPriceAboveEntry} 倍`, '',
    '【代币筛选】', `代币年龄：${range(c.tokenFilter.ageMinutes, ' 分钟')}`,
    `市值：${range(c.tokenFilter.marketCapUsd, ' 美元')}`, `流动性：${range(c.tokenFilter.liquidityUsd, ' 美元')}`,
    `持有人数：${range(c.tokenFilter.holderCount, ' 人')}`,
    `前十持有人占比上限：${pct(c.tokenFilter.maxTop10HolderRate)}`,
    `捆绑交易占比上限：${pct(c.tokenFilter.maxBundlerRate)} · 内幕交易占比上限：${pct(c.tokenFilter.maxInsiderRate)}`,
    `诱导交易占比上限：${pct(c.tokenFilter.maxEntrapmentRate)} · 机器人交易占比上限：${pct(c.tokenFilter.maxBotDegenRate)}`,
    `新钱包占比上限：${pct(c.tokenFilter.maxFreshWalletRate)} · 开发团队持仓占比上限：${pct(c.tokenFilter.maxDevTeamHoldRate)}`,
    `狙击钱包数上限：${c.tokenFilter.maxSniperCount} 个`,
    `排除蜜罐：${on(c.tokenFilter.excludeHoneypot)} · 要求社交信息：${on(c.tokenFilter.requireSocial)}`,
    `要求放弃增发权限：${on(c.tokenFilter.requireRenouncedMint)} · 要求放弃冻结权限：${on(c.tokenFilter.requireRenouncedFreeze)}`, '',
    '【钱包与采集】', `钱包最低年龄：${c.walletFilter.minWalletAgeDays} 天 · 最低已观测买入：${c.walletFilter.minObservedBuys} 笔`,
    ...(['smartmoney', 'kol', 'follow'] as const).map(source => {
      const poll = c.polling[source === 'follow' ? 'followWallet' : source];
      return `${sourceLabel(source)}：基础等待 ${poll.intervalMs / 1000} 秒，每页最多 ${poll.limit} 笔成交`;
    }), '上述为每轮完成后的基础等待时间，满页时会提频，实际周期含网络与排队耗时。', '',
    '【发送与提醒】', `发送前复核：${on(c.signalValidation.prePushRecheck)} · 发送有效期：${c.signalValidation.signalTtlSeconds} 秒`,
    `每分钟最多推送：${c.push.maxPerMinute} 条 · 状态评估通知最小间隔：${c.push.editThrottleSec} 秒`,
    '首次信号永久保留；退出提醒仅发一条，后续最多每30秒更新该条。',
    `静默时段：${c.push.quietHours.start}–${c.push.quietHours.end} UTC（${c.push.quietHours.start === c.push.quietHours.end ? '未启用' : `仅初次推送至少 ${c.push.quietHours.minWallets} 票的信号`}）`,
    `推送后清仓提醒：${on(c.signalValidation.postPushExitAlert.enabled)} · 最少 ${c.signalValidation.postPushExitAlert.minWallets} 票`,
    `共识退出提醒：${on(c.exitAlerts.enabled)} · 最少 ${c.exitAlerts.minWallets} 票`,
    `成交保留时间：${c.retention.tradesDays} 天 · 交易链接：GMGN`,
    '', '此页面仅查看配置，不能直接修改策略。',
  ].join('\n');
}

export function walletsText(db: Db, now: number): string {
  const since = now - 30 * 86400;
  const sql = `FROM trades t JOIN trade_sources s ON s.event_id=t.event_id WHERE s.source='follow' AND t.timestamp>=?`;
  const total = (db.prepare(`SELECT COUNT(DISTINCT t.maker) AS n ${sql}`).get(since) as { n: number }).n;
  const rows = db.prepare(`SELECT DISTINCT t.maker ${sql} ORDER BY t.maker LIMIT 50`).all(since) as Array<{ maker: string }>;
  return ['📋 已观测的关注钱包', `统计范围：近30天，共 ${total} 个，展示 ${rows.length} 个（最多50个）`,
    '仅统计本服务采集到成交的钱包，并非 GMGN 完整关注名单。', '',
    ...(rows.length ? rows.map((row, i) => `${i + 1}. ${row.maker.slice(0, 6)}…${row.maker.slice(-4)}`) : ['暂无关注钱包成交记录。请结合 /status 检查采集状态。']),
  ].join('\n');
}
