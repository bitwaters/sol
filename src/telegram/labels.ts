/** Display labels only; persistent API values and reason codes remain unchanged. */
function ownLabel(labels: Record<string, string>, key: string): string | undefined {
  return Object.hasOwn(labels, key) ? labels[key] : undefined;
}
export function sourceLabel(source: string): string {
  return ownLabel({ smartmoney: '聪明钱', kol: '意见领袖', follow: '关注钱包' }, source) ?? '其他来源';
}

export function utcTime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '暂无记录';
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? '暂无记录' : date.toISOString().replace('T', ' ').replace('.000Z', ' UTC');
}

export function developerStatus(value: string | null): string {
  if (!value) return '暂无数据';
  return ownLabel({ creator_hold: '仍持有', creator_close: '已清仓' }, value) ?? '状态待确认';
}

const reasons: Record<string, string> = {
  integrity_gap: '采集存在缺口', require_open_action: '缺少新建仓买入', require_smart_money: '缺少聪明钱参与',
  avg_entry_unavailable: '无法核验共识买入均价', honeypot: '疑似蜜罐风险',
  renounced_mint_missing: '缺少增发权限数据', mint_not_renounced: '尚未放弃增发权限',
  renounced_freeze_missing: '缺少冻结权限数据', freeze_not_renounced: '尚未放弃冻结权限',
  social_missing: '缺少社交信息', enrich_failed: '资料补查失败',
  suppressed_enrich_failed: '资料补查失败', window_inactive: '统计窗口内无近期有效买入',
  lifecycle_expired: '候选信号已到期', candidate_expired: '候选信号已到期', ttl_expired: '信号发送有效期已过',
  missing_evaluated_at: '缺少有效评估时间', muted: '代币已被屏蔽',
  wallet_invalid: '钱包校验未通过', token_deferred: '代币资料待核验', token_recheck_failed: '代币复核未通过',
  send_recheck_votes: '发送前有效票数不足', send_recheck_failed: '发送前复核未通过', failed: '校验未通过',
  not_sending: '信号已不处于待发送状态', candidate_not_sending: '候选状态已变化',
  candidate_changed_during_recheck: '复核期间候选已变化', signal_missing: '信号记录缺失',
  signal_not_sending: '信号已不处于待发送状态', stale_revision: '消息版本已过期', view_missing: '消息数据缺失',
  no_original_message: '缺少原始推送消息', exit_conditions_changed: '退出条件已变化', exit_view_missing: '退出提醒数据缺失',
  rebuild_in_progress: '持仓历史重建中', hard_filter_cooldown: '过滤后暂缓重试', cooldown_active: '信号冷却中',
  retrigger_cooldown: '等待再次触发', no_reliable_start: '缺少可靠的持仓起点', observed_history_only: '仅有已观测历史',
};
const fields: Record<string, string> = {
  age: '代币年龄', market_cap: '代币市值', holder_count: '持有人数', liquidity: '流动性',
  top10: '前十持有人占比', bundler: '捆绑交易占比', insider: '内幕交易占比', entrapment: '诱导交易占比',
  bot_degen: '机器人交易占比', fresh_wallet: '新钱包占比', dev_hold: '开发团队持仓占比', sniper_count: '狙击钱包数',
  wallet_count: '有效钱包票数', net_inflow: '净流入金额',
};

export function reasonLabel(raw: string | null): string {
  if (!raw) return '未记录原因';
  // Prefixes can be nested; bounded parsing avoids echoing raw diagnostics into messages.
  let code = raw;
  let rechecked = false;
  for (let i = 0; i < 4 && /^(send_recheck|revalidate):/.test(code); i++) {
    code = code.slice(code.indexOf(':') + 1); rechecked = true;
  }
  const match = /^([a-z_0-9]+)(?:\(([^()]*)\))?$/.exec(code);
  const key = match?.[1] ?? '';
  const value = match?.[2];
  const parsedNumber = value !== undefined && /^\d+(?:\.\d+)?x?$/.test(value) ? Number(value.replace(/x$/, '')) : null;
  const numeric = parsedNumber !== null && Number.isFinite(parsedNumber) ? parsedNumber : null;
  let label = ownLabel(reasons, key);
  if (key === 'votes_below_min') label = `有效票数不足${numeric === null ? '' : `（当前 ${numeric} 票）`}`;
  if (key === 'raw_votes_below_min') label = `过滤前聚类票数不足${numeric === null ? '' : `（当前 ${numeric} 票）`}`;
  if (key === 'raw_addresses_below_min') label = `达到买入金额门槛的钱包数不足${numeric === null ? '' : `（当前 ${numeric} 个）`}`;
  if (key === 'verifiable_below_min') label = `可核验持仓的钱包不足${numeric === null ? '' : `（当前 ${numeric} 个）`}`;
  if (key === 'holding_ratio_below_min') label = `共识持仓保留率不足${numeric === null ? '' : `（当前 ${(numeric * 100).toFixed(2)}%）`}`;
  if (key === 'price_above_entry' || key === 'price_warn') label = `${key === 'price_warn' ? '触发追高警告' : '价格超过追高拦截阈值'}${numeric === null ? '' : `（现价为共识均价的 ${numeric} 倍）`}`;
  if (!label) {
    const range = /^(.*)_(missing|below_min|above_max)$/.exec(key);
    const field = range?.[1] ? ownLabel(fields, range[1]) : undefined;
    if (field) label = field + ({ missing: '数据缺失', below_min: '低于下限', above_max: '超过上限' } as Record<string, string>)[range![2]!];
  }
  return `${rechecked ? '发送前复核：' : ''}${label ?? '其他原因（待排查）'}`;
}
