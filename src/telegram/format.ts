import { developerStatus } from './labels.js';
import { Decimal } from 'decimal.js';

export interface FormatWallet {
  clusterId: string;
  tags: string[];
  sources: string[];
  action: 'open' | 'add' | null;
  qualifyingBuyUsd: string;
  holdingState?: 'holding' | 'partial' | 'closed';
}

export interface SignalView {
  signalId: number;
  token: string;
  symbol: string | null;
  launchpad: string | null;
  tokenAgeMinutes: number | null;
  marketCap: number | null;
  liquidity: number | null;
  holderCount: number | null;
  votes: number;
  windowMinutes: number;
  wallets: FormatWallet[];
  totalBuyUsd: string;
  netInflowUsd: string;
  retentionRatio: number | null;
  priceRatio: number | null;
  currentPrice: string | null;
  avgEntryPrice: string | null;
  top10Rate: number | null;
  bundlerRate: number | null;
  insiderRate: number | null;
  devStatus: string | null;
  socials: { twitter?: string; telegram?: string; website?: string };
  partialHoldings: boolean;
  upgraded?: boolean;
  downgraded?: boolean;
  escalateDelta?: number;
}

export interface FormatOptions {
  links: string[];
  buyButton: string;
  strongWallets?: number;
  warnPriceAboveEntry?: number;
}

const SOURCE_EMOJI = {
  smartmoney: '🟡',
  kol: '🟠',
  follow: '⭐',
} as const;

export function signalShortId(signalId: number): string {
  return `#${signalId.toString(36).toUpperCase()}`;
}

function money(value: number | null, prefix = '$'): string {
  if (value === null) return '—';
  if (value >= 1_000_000) return `${prefix}${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${prefix}${(value / 1_000).toFixed(1)}K`;
  return `${prefix}${value.toFixed(2)}`;
}

function pct(value: number | null): string {
  if (value === null) return '—';
  return `${(value * 100).toFixed(0)}%`;
}

function categoryOf(wallet: FormatWallet): { label: string; emoji: string } {
  const hasSmart = wallet.sources.includes('smartmoney') || wallet.tags.includes('smart_degen');
  const hasKol = wallet.sources.includes('kol') || wallet.tags.includes('renowned');
  const hasFollow = wallet.sources.includes('follow');
  const parts: string[] = [];
  if (hasSmart) parts.push('聪明钱');
  if (hasKol) parts.push('意见领袖');
  if (hasFollow) parts.push('关注钱包');
  if (parts.length === 0) parts.push('其他');
  const emoji = [hasSmart ? SOURCE_EMOJI.smartmoney : '', hasKol ? SOURCE_EMOJI.kol : '', hasFollow ? SOURCE_EMOJI.follow : '']
    .filter(Boolean)
    .join('');
  return { label: parts.join('＋'), emoji: emoji || '⚪' };
}

/** 来源分项（互斥组合，分项合计 = 总票数） */
export function groupBySource(
  wallets: FormatWallet[],
): Array<{ label: string; emoji: string; count: number; usd: Decimal }> {
  const clusters = new Map<string, FormatWallet[]>();
  for (const wallet of wallets) {
    const list = clusters.get(wallet.clusterId) ?? [];
    list.push(wallet);
    clusters.set(wallet.clusterId, list);
  }

  const groups = new Map<string, { emoji: string; count: number; usd: Decimal }>();
  for (const members of clusters.values()) {
    const merged: FormatWallet = {
      clusterId: members[0]?.clusterId ?? '',
      tags: members.flatMap((m) => m.tags),
      sources: members.flatMap((m) => m.sources),
      action: members.some((m) => m.action === 'open') ? 'open' : members[0]?.action ?? null,
      qualifyingBuyUsd: members
        .reduce((sum, m) => sum.plus(m.qualifyingBuyUsd), new Decimal(0))
        .toString(),
    };
    const { label, emoji } = categoryOf(merged);
    const entry = groups.get(label) ?? { emoji, count: 0, usd: new Decimal(0) };
    entry.count += 1;
    entry.usd = entry.usd.plus(merged.qualifyingBuyUsd);
    groups.set(label, entry);
  }

  return [...groups.entries()].map(([label, value]) => ({ label, ...value }));
}

export function categoryLabel(tags: string[], sources: string[]): string {
  const wallet: FormatWallet = {
    clusterId: '',
    tags,
    sources,
    action: null,
    qualifyingBuyUsd: '0',
  };
  return categoryOf(wallet).label;
}

function esc(value: string | null | undefined): string {
  if (!value) return '—';
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildLinks(token: string, links: string[]): string {
  token = encodeURIComponent(token);
  const urls: Record<string, string> = {
    gmgn: `https://gmgn.ai/sol/token/${token}`,
  };
  return links
    .filter((name) => name === 'gmgn')
    .map((name) => {
      const url = urls[name];
      return url ? `<a href="${url}">${name.toUpperCase()}</a>` : name.toUpperCase();
    })
    .join(' · ');
}

export function buildKeyboard(
  token: string,
  _options: FormatOptions,
): { inline_keyboard: Array<Array<{ text: string; url?: string; callback_data?: string }>> } {
  const url = `https://gmgn.ai/sol/token/${encodeURIComponent(token)}`;
  return {
    inline_keyboard: [
      [{ text: '📈 打开 GMGN', url }],
      [
        { text: '🔁 刷新', callback_data: `refresh:${token}` },
        { text: '🔕 屏蔽该币', callback_data: `mute:${token}` },
      ],
    ],
  };
}

/** 信号消息（§9.1）：不展示钱包地址与身份信息 */
export function formatSignalMessage(view: SignalView, options: FormatOptions): string {
  const strong = view.votes >= (options.strongWallets ?? 5);
  const title = view.downgraded
    ? `🟡 共识减弱 ${signalShortId(view.signalId)}`
    : view.upgraded
      ? `${strong ? '🟢 强共识信号' : '🟢 共识信号'} ${signalShortId(view.signalId)}（已升级）`
      : `${strong ? '🟢 强共识信号' : '🟢 共识信号'} ${signalShortId(view.signalId)}`;

  const lines: string[] = [title];
  if (view.priceRatio !== null && view.priceRatio > (options.warnPriceAboveEntry ?? 1.5)) {
    lines.push(`⚠️ 已较共识均价上涨 ${((view.priceRatio - 1) * 100).toFixed(0)}%，追高风险`);
  }
  lines.push(
    `$${esc(view.symbol)} · ${esc(view.launchpad)} · ${view.tokenAgeMinutes ?? '—'} 分钟`,
  );
  lines.push('━━━━━━━━━━━━━━');
  lines.push(
    `市值 ${money(view.marketCap)} · 流动性 ${money(view.liquidity)} · 持有人 ${view.holderCount ?? '—'}`,
  );
  lines.push('');
  lines.push(`👥 ${view.windowMinutes} 分钟共识：${view.votes} 票`);
  for (const group of groupBySource(view.wallets)) {
    lines.push(`${group.emoji} ${group.label} ×${group.count} · $${group.usd.toFixed(0)}`);
  }
  lines.push(`💰 合计买入 ${money(Number(view.totalBuyUsd))} · 净流入 ${Number(view.netInflowUsd) >= 0 ? '+' : '−'}${money(Math.abs(Number(view.netInflowUsd)))}`);
  const priceLine =
    view.currentPrice && view.avgEntryPrice
      ? `现价 $${esc(view.currentPrice)} / 均价 $${esc(view.avgEntryPrice)}`
      : '现价/均价 —';
  lines.push(`📊 持仓保留 ${pct(view.retentionRatio)} · ${priceLine}`);
  if (view.partialHoldings) lines.push('ℹ️ 部分持仓未经余额核验');
  lines.push(
    `🛡 前十持有人占比 ${pct(view.top10Rate)} · 捆绑交易占比 ${pct(view.bundlerRate)} · 内幕交易占比 ${pct(view.insiderRate)} · 开发者持仓 ${developerStatus(view.devStatus)}`,
  );
  const socials = [
    view.socials.telegram ? 'Telegram' : null,
    view.socials.twitter ? 'X' : null,
    view.socials.website ? '官网' : null,
  ].filter(Boolean);
  if (socials.length > 0) lines.push(`🌐 ${socials.join(' · ')}`);
  lines.push('');
  lines.push(`<code>${esc(view.token)}</code>`);
  lines.push(`🔗 ${buildLinks(view.token, options.links)}`);
  lines.push('━━━━━━━━━━━━━━');
  lines.push('⚠️ 信号仅供参考，非投资建议');
  return lines.join('\n');
}

export interface ExitView {
  signalId: number;
  token: string;
  symbol: string | null;
  launchpad: string | null;
  tokenAgeMinutes: number | null;
  exitedClusters: number;
  clusterBreakdown: Array<{ label: string; count: number }>;
  retentionRatio: number | null;
  priceRatio: number | null;
  currentPrice: string | null;
  avgEntryPrice: string | null;
}

export function formatExitAlert(view: ExitView): string {
  const lines = [
    `🔴 退出提醒 ${signalShortId(view.signalId)}`,
    `$${esc(view.symbol)} · ${esc(view.launchpad)} · ${view.tokenAgeMinutes ?? '—'} 分钟`,
    '━━━━━━━━━━━━━━',
    `${view.exitedClusters} 组独立钱包完整清仓（${view.clusterBreakdown
      .map((b) => `${b.label} ×${b.count}`)
      .join(' · ')}）`,
  ];
  const priceLine =
    view.currentPrice && view.avgEntryPrice
      ? `现价 $${esc(view.currentPrice)} / 均价 $${esc(view.avgEntryPrice)}`
      : '现价/均价 —';
  lines.push(`📊 持仓保留 ${pct(view.retentionRatio)} · ${priceLine}`);
  lines.push('⚠️ 共识正在瓦解，注意风险');
  return lines.join('\n');
}
