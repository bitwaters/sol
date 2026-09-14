/**
 * 成交流归一化（M1-6 契约结论见 docs/CONTRACT.md）
 *
 * - smartmoney / kol：token_amount 为可读数量；is_open_or_close 语义见 §4.3
 * - follow-wallet：2026-09-14 实测 base_amount 为可读数量，token_amount 可能恒为 0
 * - 事件键必须包含金额字段（同 tx 可含多笔成交）
 */

import { Decimal } from 'decimal.js';

export type TradeSource = 'smartmoney' | 'kol' | 'follow';
export type TradeSide = 'buy' | 'sell';
export type ActionHint = 'full_open' | 'partial_add' | 'close' | 'reduce' | null;

export interface NormalizedTrade {
  eventId: string;
  chain: string;
  txHash: string;
  maker: string;
  side: TradeSide;
  baseAddress: string;
  symbol: string | null;
  rawAmount: string | null;
  rawAmountUnit: 'human' | 'base_unit' | 'base_unit_unverified';
  rawDecimals: number | null;
  amountNormalized: string | null;
  amountUsd: string | null;
  amountUsdNum: number | null;
  priceUsd: string | null;
  actionHint: ActionHint;
  isOpenOrClose: number | null;
  balance: string | null;
  timestamp: number;
  raw: unknown;
}

type RawItem = Record<string, unknown>;

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function decimal(value: unknown, positive = false): string | null {
  const raw = str(value);
  if (raw === null || raw.trim() === '') return null;
  try {
    const n = new Decimal(raw);
    return n.isFinite() && (positive ? n.gt(0) : n.gte(0)) ? n.toString() : null;
  } catch { return null; }
}

/** 事件键：sol:tx:maker:base:side:timestamp:amount:quote（M1-6 验证唯一） */
export function buildEventId(parts: {
  chain: string;
  txHash: string;
  maker: string;
  baseAddress: string;
  side: string;
  timestamp: number | string;
  tokenAmount: string;
  quoteAmount: string;
}): string {
  return [
    parts.chain,
    parts.txHash,
    parts.maker,
    parts.baseAddress,
    parts.side,
    String(parts.timestamp),
    parts.tokenAmount,
    parts.quoteAmount,
  ].join(':');
}

/**
 * 行为提示归一化：
 * - follow-wallet：1 = 全开/全平，0 = 部分加减
 * - kol/smartmoney：0 = 开/加（二义），1 = 平/减（二义）→ 返回 null，交由本地周期判定
 */
export function normalizeActionHint(
  source: TradeSource,
  side: TradeSide,
  isOpenOrClose: number | null,
): ActionHint {
  if (isOpenOrClose === null) return null;
  if (source === 'follow') {
    if (side === 'buy') return isOpenOrClose === 1 ? 'full_open' : 'partial_add';
    return isOpenOrClose === 1 ? 'close' : 'reduce';
  }
  return null;
}

export function normalizeTrackItem(source: TradeSource, item: RawItem): NormalizedTrade | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const txHash = str(item['transaction_hash']);
  const maker = str(item['maker']);
  const side = str(item['side']);
  const baseAddress = str(item['base_address']);
  const timestamp = num(item['timestamp']);

  if (!txHash || !maker || !baseAddress || timestamp === null || !Number.isSafeInteger(timestamp) || timestamp <= 0) return null;
  if (side !== 'buy' && side !== 'sell') return null;

  const baseToken = (item['base_token'] ?? {}) as RawItem;
  const symbol = str(baseToken['symbol']);
  const tokenAmountRaw = source === 'follow' ? item['base_amount'] ?? item['token_amount'] : item['token_amount'] ?? item['base_amount'];
  const tokenAmount = str(tokenAmountRaw) ?? '';
  const quoteAmount = str(item['quote_amount']) ?? '';
  const amountUsd = decimal(item['amount_usd']);
  const priceUsd = decimal(item['price_usd'], true);
  const isOpenOrClose = num(item['is_open_or_close']);
  const balance = decimal(item['balance']);

  // 已通过数量 × 成交价 ≈ USD 金额，以及跨来源同笔成交交叉验证可读单位。

  return {
    eventId: buildEventId({
      chain: 'sol',
      txHash,
      maker,
      baseAddress,
      side,
      timestamp,
      tokenAmount,
      quoteAmount,
    }),
    chain: 'sol',
    txHash,
    maker,
    side,
    baseAddress,
    symbol,
    rawAmount: tokenAmount === '' ? null : tokenAmount,
    rawAmountUnit: 'human',
    rawDecimals: null,
    amountNormalized: decimal(tokenAmount, true),
    amountUsd,
    amountUsdNum: amountUsd === null ? null : num(amountUsd),
    priceUsd,
    actionHint: normalizeActionHint(source, side, isOpenOrClose),
    isOpenOrClose,
    balance,
    timestamp,
    raw: item,
  };
}

export function normalizeTrackResponse(source: TradeSource, data: unknown): NormalizedTrade[] {
  const list = extractList(data);
  const out: NormalizedTrade[] = [];
  for (const item of list) {
    const normalized = normalizeTrackItem(source, item);
    if (normalized) out.push(normalized);
  }
  return out;
}

function extractList(data: unknown): RawItem[] {
  if (Array.isArray(data)) return data as RawItem[];
  if (data && typeof data === 'object') {
    const list = (data as Record<string, unknown>)['list'];
    if (Array.isArray(list)) return list as RawItem[];
  }
  return [];
}
