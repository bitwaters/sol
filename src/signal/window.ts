import { Decimal } from 'decimal.js';
import type { Db } from '../store/db.js';
import type { AppConfig } from '../config.js';
import type { ClusterResult } from './cluster.js';
import { getLatestCycle } from './positions.js';

export interface WindowTrade {
  eventId: string;
  wallet: string;
  side: 'buy' | 'sell';
  amountUsd: Decimal;
  amount: Decimal | null;
  timestamp: number;
  sources: string[];
  tags: string[];
  qualifying?: boolean;
}

export interface WalletWindowStat {
  wallet: string;
  clusterId: string;
  tags: string[];
  sources: string[];
  buys: WindowTrade[];
  sells: WindowTrade[];
  qualifyingBuyUsd: Decimal;
  qualifyingBuyAmount: Decimal;
  netInflowUsd: Decimal;
  /** 当前周期首笔买入是否在窗口内（建仓证据） */
  openInWindow: boolean;
  action: 'open' | 'add' | null;
}

export interface WindowMetrics {
  token: string;
  windowStart: number;
  windowEnd: number;
  wallets: WalletWindowStat[];
  /** 计票数（关联合并后，满足金额门槛的买入钱包所在簇数） */
  votes: number;
  /** 窗口内全部买卖净流入（不设门槛） */
  netInflowUsd: Decimal;
  /** 有效票钱包的合格买入总额（由校验层筛选后使用） */
  qualifyingBuyUsd: Decimal;
  qualifyingBuyAmount: Decimal;
  /** 参与计票的钱包（有合格买入） */
  votingWallets: string[];
}

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

interface TradeQueryRow {
  event_id: string;
  maker: string;
  side: 'buy' | 'sell';
  amount_usd: string | null;
  amount_normalized: string | null;
  timestamp: number;
  sources: string | null;
  raw: string | null;
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { maker_info?: { tags?: unknown } };
    const tags = parsed.maker_info?.tags;
    return Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 窗口聚合（M2-3，§7.1 指标口径）：
 * - 计票数：关联合并后、满足 minTradeAmountUsd 的买入钱包所在簇数
 * - 净流入：窗口内全部买卖（不设金额门槛）
 * - 建仓证据：当前周期首笔买入在窗口内
 */
export function computeWindow(
  db: Db,
  token: string,
  nowSec: number,
  config: AppConfig,
  clusters: ClusterResult,
): WindowMetrics {
  const windowStart = nowSec - config.signal.windowMinutes * 60;
  const windowEnd = nowSec;
  const rows = db
    .prepare(
      `SELECT t.event_id, t.maker, t.side, t.amount_usd, t.amount_normalized, t.timestamp, t.raw,
              (SELECT json_group_array(s.source) FROM trade_sources s WHERE s.event_id = t.event_id) AS sources
       FROM trades t
       WHERE t.base_address = ? AND t.timestamp >= ? AND t.timestamp <= ?
       ORDER BY t.timestamp`,
    )
    .all(token, windowStart, windowEnd) as TradeQueryRow[];

  const walletMap = new Map<string, WalletWindowStat>();
  let netInflow = new Decimal(0);
  const minAmount = new Decimal(config.tradeFilter.minTradeAmountUsd);
  const cycles = new Map<string, ReturnType<typeof getLatestCycle>>();
  const firstBuys = new Map<string, string | null>();
  for (const wallet of new Set(rows.map(row => row.maker))) {
    const cycle = getLatestCycle(db, wallet, token);
    cycles.set(wallet, cycle);
    const first = cycle?.cycleStartedAt == null ? undefined : db.prepare(`SELECT event_id FROM trades
      WHERE maker=? AND base_address=? AND side='buy' AND timestamp=? ORDER BY event_id LIMIT 1`)
      .get(wallet, token, cycle.cycleStartedAt) as { event_id: string } | undefined;
    firstBuys.set(wallet, first?.event_id ?? null);
  }

  for (const row of rows) {
    const usd = row.amount_usd !== null ? new Decimal(row.amount_usd) : new Decimal(0);
    const amount = row.amount_normalized !== null ? new Decimal(row.amount_normalized) : null;
    const clusterId = clusters.clusterOf.get(row.maker) ?? row.maker;
    let stat = walletMap.get(row.maker);
    if (!stat) {
      const cycle = cycles.get(row.maker) ?? null;
      const openInWindow = cycle?.cycleStartedAt != null && cycle.cycleStartedAt >= windowStart && cycle.cycleStartedAt <= nowSec;
      stat = {
        wallet: row.maker,
        clusterId,
        tags: [],
        sources: [],
        buys: [],
        sells: [],
        qualifyingBuyUsd: new Decimal(0),
        qualifyingBuyAmount: new Decimal(0),
        netInflowUsd: new Decimal(0),
        openInWindow,
        action: openInWindow ? 'open' : cycle !== null ? 'add' : null,
      };
      walletMap.set(row.maker, stat);
    }

    const trade: WindowTrade = {
      eventId: row.event_id,
      wallet: row.maker,
      side: row.side,
      amountUsd: usd,
      amount,
      timestamp: row.timestamp,
      sources: parseJsonArray(row.sources),
      tags: parseTags(row.raw),
    };
    const sources = new Set(stat.sources);
    for (const s of trade.sources) sources.add(s);
    stat.sources = [...sources].sort();
    const tags = new Set(stat.tags);
    for (const t of trade.tags) tags.add(t);
    stat.tags = [...tags].sort();

    if (row.side === 'buy') {
      stat.buys.push(trade);
      const cycle = cycles.get(row.maker) ?? null;
      const action = cycle === null ? null : firstBuys.get(row.maker) === row.event_id ? 'open' : 'add';
      trade.qualifying = usd.gte(minAmount) && config.tradeFilter.sides.includes('buy') &&
        (action === null ? config.tradeFilter.actions.includes('open') && config.tradeFilter.actions.includes('add') : config.tradeFilter.actions.includes(action)) &&
        (cycle?.cycleStartedAt == null || row.timestamp >= cycle.cycleStartedAt);
      if (trade.qualifying) {
        stat.qualifyingBuyUsd = stat.qualifyingBuyUsd.plus(usd);
        if (amount !== null) stat.qualifyingBuyAmount = stat.qualifyingBuyAmount.plus(amount);
      }
      stat.netInflowUsd = stat.netInflowUsd.plus(usd);
      netInflow = netInflow.plus(usd);
    } else {
      stat.sells.push(trade);
      stat.netInflowUsd = stat.netInflowUsd.minus(usd);
      netInflow = netInflow.minus(usd);
    }
  }

  const wallets = [...walletMap.values()].sort((a, b) => a.wallet.localeCompare(b.wallet));
  const votingClusters = new Set<string>();
  const votingWallets: string[] = [];
  for (const stat of wallets) {
    if (stat.qualifyingBuyUsd.gt(0)) {
      votingClusters.add(stat.clusterId);
      votingWallets.push(stat.wallet);
    }
  }

  return {
    token,
    windowStart,
    windowEnd,
    wallets,
    votes: votingClusters.size,
    netInflowUsd: netInflow,
    qualifyingBuyUsd: new Decimal(0),
    qualifyingBuyAmount: new Decimal(0),
    votingWallets,
  };
}
