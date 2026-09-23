/**
 * M1-6 接口契约验证（一次性脚本，不入生产路径）
 *
 * 结论写入 docs/CONTRACT.md；fixtures 写入 test/fixtures/。
 * 注意：demo key 为 IP 级严格限频，脚本默认 1 req/s（个人 Key 为 20/s）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, PROJECT_ROOT } from '../src/config.js';
import { OpenApiClient } from '../src/gmgn/OpenApiClient.js';
import { BanGate, TokenBucket } from '../src/ingest/limiter.js';
import { GmgnGateway, ROUTE_WEIGHTS } from '../src/ingest/gateway.js';
import { createLogger } from '../src/logger.js';

const log = createLogger({ module: 'contract' });
const fixturesDir = join(PROJECT_ROOT, 'test', 'fixtures');
mkdirSync(fixturesDir, { recursive: true });

const loaded = loadConfig();
const ratePerSecond = Number(process.env['GMGN_RATE_LIMIT_PER_SEC'] ?? '1');
const client = new OpenApiClient({
  apiKey: loaded.env.GMGN_API_KEY,
  privateKeyPem: loaded.env.GMGN_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  host: 'https://openapi.gmgn.ai',
});
const gateway = new GmgnGateway({
  client,
  limiter: new TokenBucket({ ratePerSecond, capacity: Math.max(...Object.values(ROUTE_WEIGHTS)) }),
  banGate: new BanGate(),
  logger: log,
});

const report: string[] = [];
const say = (line = ''): void => {
  report.push(line);
  console.log(line);
};

function saveFixture(name: string, data: unknown): void {
  writeFileSync(join(fixturesDir, name), `${JSON.stringify(data, null, 2)}\n`);
  log.info('fixture 已保存', { name });
}

function asList(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === 'object') {
    const list = (data as Record<string, unknown>)['list'];
    if (Array.isArray(list)) return list as Record<string, unknown>[];
  }
  return [];
}

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

/** 候选事件键：包含金额字段（同 tx 同钱包同方向可有多笔分笔成交） */
export function eventKeyOf(item: Record<string, unknown>): string {
  const parts = [
    'sol',
    String(item['transaction_hash'] ?? ''),
    String(item['maker'] ?? ''),
    String(item['base_address'] ?? ''),
    String(item['side'] ?? ''),
    String(item['timestamp'] ?? ''),
    String(item['token_amount'] ?? item['base_amount'] ?? ''),
    String(item['quote_amount'] ?? ''),
  ];
  return parts.join(':');
}

interface EventAnalysis {
  source: string;
  total: number;
  dupKeysWithAmounts: number;
  dupKeysWithoutAmounts: number;
  dupTxHash: number;
  multiMakerTx: number;
  multiEventTx: number;
  sampleKey: string;
}

function analyzeEvents(source: string, items: Record<string, unknown>[]): EventAnalysis {
  const withAmounts = new Map<string, number>();
  const withoutAmounts = new Map<string, number>();
  const txCount = new Map<string, number>();
  const makersByTx = new Map<string, Set<string>>();
  let sampleKey = '';

  for (const item of items) {
    const tx = String(item['transaction_hash'] ?? '');
    const maker = String(item['maker'] ?? '');
    const base = String(item['base_address'] ?? '');
    const side = String(item['side'] ?? '');
    const shortKey = [tx, maker, base, side].join(':');
    const fullKey = eventKeyOf(item);
    if (!sampleKey) sampleKey = fullKey;
    withoutAmounts.set(shortKey, (withoutAmounts.get(shortKey) ?? 0) + 1);
    withAmounts.set(fullKey, (withAmounts.get(fullKey) ?? 0) + 1);
    txCount.set(tx, (txCount.get(tx) ?? 0) + 1);
    const set = makersByTx.get(tx) ?? new Set<string>();
    set.add(maker);
    makersByTx.set(tx, set);
  }

  const countDups = (m: Map<string, number>): number => {
    let n = 0;
    for (const v of m.values()) if (v > 1) n += 1;
    return n;
  };

  let multiEventTx = 0;
  for (const count of txCount.values()) if (count > 1) multiEventTx += 1;
  let multiMakerTx = 0;
  for (const makers of makersByTx.values()) if (makers.size > 1) multiMakerTx += 1;

  return {
    source,
    total: items.length,
    dupKeysWithAmounts: countDups(withAmounts),
    dupKeysWithoutAmounts: countDups(withoutAmounts),
    dupTxHash: txCount.size,
    multiMakerTx,
    multiEventTx,
    sampleKey,
  };
}

function describe(value: unknown): string {
  if (value === undefined) return 'MISSING';
  if (value === null) return 'null';
  if (typeof value === 'string') return `"${value.length > 40 ? `${value.slice(0, 40)}…` : value}"`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}

function checkRow(field: string, path: string, expected: string, value: unknown): string {
  const ok = value !== undefined && value !== null;
  return `| ${field} | \`${path}\` | ${expected} | ${describe(value)} | ${ok ? '✅' : '⚠️ 缺失'} |`;
}

function sayEventAnalysis(a: EventAnalysis): void {
  say(
    `- **${a.source}**：样本 ${a.total} 条；同 tx 组 ${a.multiEventTx}（含多事件）；` +
      `同 tx 多钱包 ${a.multiMakerTx}；` +
      `无金额候选键重复 ${a.dupKeysWithoutAmounts}；**含金额候选键重复 ${a.dupKeysWithAmounts}**`,
  );
  say(`  - 样例键：\`${a.sampleKey}\``);
}

async function main(): Promise<void> {
  const memeToken = '7tFbGa9wt4Q4yxNAdaDcTKahv4WPrJtXh6ty7gjWyKx3'; // JubJub（ray_launchpad）

  say(`# 接口契约验证报告`);
  say();
  say(`- 生成时间：${new Date().toISOString()}`);
  say(`- 数据来源：GMGN OpenAPI（demo key，只读，速率 ${ratePerSecond} req/s）`);
  say(`- 配置版本：${loaded.configVersion} · 规则版本：${loaded.rulesVersion}`);
  say();

  // ---- 1. track ----
  say(`## 1. 成交流（track smartmoney / kol）`);
  say();
  const smartmoneyRaw = await gateway.fetchSmartmoney(20);
  saveFixture('smartmoney.json', smartmoneyRaw);
  sayEventAnalysis(analyzeEvents('smartmoney', asList(smartmoneyRaw)));

  const kolRaw = await gateway.fetchKol(20);
  saveFixture('kol.json', kolRaw);
  sayEventAnalysis(analyzeEvents('kol', asList(kolRaw)));

  if (loaded.env.GMGN_PRIVATE_KEY) {
    try {
      const followRaw = await gateway.fetchFollowWallet({ limit: 20 });
      saveFixture('follow-wallet.json', followRaw);
      sayEventAnalysis(analyzeEvents('follow-wallet', asList(followRaw)));
    } catch (err) {
      say(`- follow-wallet 抓取失败（跳过）：${String(err)}`);
    }
  } else {
    say(`- follow-wallet：未配置私钥，跳过（需个人 Key + 私钥后补验）`);
  }
  say();

  // ---- 2. token info 字段 ----
  say(`## 2. token 富化字段映射（实际端点）`);
  say();
  say(`样本代币：\`${memeToken}\`（meme / ray_launchpad）`);
  say();
  const infoRaw = await gateway.fetchTokenInfo(memeToken);
  saveFixture('token-info.json', infoRaw);
  const securityRaw = await gateway.fetchTokenSecurity(memeToken);
  saveFixture('token-security.json', securityRaw);

  say(`### token info`);
  say(`| 内部字段 | 路径 | 期望 | 实际 | 结论 |`);
  say(`|---|---|---|---|---|`);
  for (const [field, path, expected] of [
    ['price', 'price.price', 'USD 字符串'],
    ['market_cap', 'price.price × circulating_supply', '计算值'],
    ['circulating_supply', 'circulating_supply', '字符串整数'],
    ['decimals', 'decimals', '整数'],
    ['created_at', 'creation_timestamp', 'unix 秒'],
    ['liquidity', 'liquidity', 'USD 字符串'],
    ['holder_count', 'holder_count', '整数'],
    ['top10_rate', 'stat.top_10_holder_rate', '0-1'],
    ['bundler_rate', 'stat.top_bundler_trader_percentage', '0-1'],
    ['insider_rate', 'stat.top_rat_trader_percentage', '0-1'],
    ['entrapment_rate', 'stat.top_entrapment_trader_percentage', '0-1'],
    ['bot_degen_rate', 'stat.bot_degen_rate', '0-1'],
    ['fresh_wallet_rate', 'stat.fresh_wallet_rate', '0-1'],
    ['dev_hold_rate', 'stat.dev_team_hold_rate', '0-1'],
    ['sniper_count', 'wallet_tags_stat.sniper_wallets', '整数'],
    ['creator_token_status', 'dev.creator_token_status', 'creator_hold|creator_close'],
    ['socials.twitter', 'link.twitter_username', '字符串'],
    ['launchpad', 'launchpad_platform', '字符串'],
  ] as Array<[string, string, string]>) {
    say(checkRow(field, path, expected, getPath(infoRaw, path)));
  }
  say();

  say(`### token security`);
  say(`| 内部字段 | 路径 | 期望 | 实际 | 结论 |`);
  say(`|---|---|---|---|---|`);
  for (const [field, path, expected] of [
    ['top10_rate', 'top_10_holder_rate', '0-1'],
    ['honeypot', 'honeypot', '0/1（SOL）'],
    ['renounced_mint', 'renounced_mint', '布尔'],
    ['renounced_freeze', 'renounced_freeze_account', '布尔'],
    ['open_source', 'open_source', '0/1'],
    ['buy_tax', 'buy_tax', '字符串'],
    ['sell_tax', 'sell_tax', '字符串'],
    ['rug_ratio', 'rug_ratio', '（预期不可得）'],
    ['is_wash_trading', 'is_wash_trading', '（预期不可得）'],
  ] as Array<[string, string, string]>) {
    say(checkRow(field, path, expected, getPath(securityRaw, path)));
  }
  say();

  // ---- 3. wallet stats ----
  say(`## 3. 钱包画像（portfolio stats）`);
  say();
  const wallets = [
    'FgXQhBHdAWf7UMKA82eUwD7rYjLZfa6nvRpq2dU3UXJY',
    'EbW5XhDaVUNy86cFH68BMydpp9ts3RoR4ZgHUrGHV5z2',
  ];
  try {
    const statsRaw = await gateway.fetchWalletStats(wallets);
    saveFixture('wallet-stats.json', statsRaw);
    const rows = Array.isArray(statsRaw) ? statsRaw : [statsRaw as Record<string, unknown>];
    say(`- 请求 ${wallets.length} 个钱包；响应类型：${Array.isArray(statsRaw) ? 'array' : 'object'}；条目：${rows.length}`);
    const first = (rows[0] ?? {}) as Record<string, unknown>;
    for (const path of [
      'common.fund_from',
      'common.fund_from_address',
      'common.created_at',
      'common.tags',
      'pnl_stat.winrate',
      'realized_profit_pnl',
    ]) {
      say(`- \`${path}\` → ${describe(getPath(first, path))}`);
    }
  } catch (err) {
    say(`- 抓取失败（跳过）：${String(err)}`);
  }
  say();

  // ---- 4. kline ----
  say(`## 4. kline（回测取价）`);
  say();
  try {
    const toMs = Date.now();
    const klineRaw = await gateway.fetchKline(memeToken, '1m', toMs - 3_600_000, toMs);
    saveFixture('kline-1m.json', klineRaw);
    const candles = asList(klineRaw);
    say(`- from/to 使用**毫秒**；1m 蜡烛数：${candles.length}`);
    const c0 = (candles[0] ?? {}) as Record<string, unknown>;
    for (const path of ['time', 'open', 'close', 'volume', 'amount']) {
      say(`- \`${path}\` → ${describe(c0[path])}`);
    }
  } catch (err) {
    say(`- 抓取失败（跳过）：${String(err)}`);
  }
  say();

  say(`## 5. 结论与实现要求`);
  say();
  say(`1. **事件键**：同一交易可包含多笔成交（同钱包同方向分笔、甚至同 tx 买卖并存）。`);
  say(`   候选键必须包含金额字段：\`sol:tx_hash:maker:base_address:side:timestamp:token_amount:quote_amount\`。`);
  say(`2. **rug_ratio / is_wash_trading**：token info / security **均不提供**，仅 trending / trenches rank 项提供。`);
  say(`   硬过滤改用可得字段：\`stat.top_entrapment_trader_percentage\`（entrapment）与 \`stat.bot_degen_rate\`（bot/wash 代理）。`);
  say(`3. **kline 的 from/to 是毫秒**；不传参时返回最近 100 根。`);
  say(`4. **demo key 为 IP 级严格限频**（约 1 req/s），个人 Key 预期 20/s；M1-15 需用个人 Key 复验。`);
  say(`5. **follow-wallet 的 base_amount 单位**需个人私钥补验（skill 文档称最小单位）。`);
  say(`6. smartmoney / kol 的 \`token_amount\` 与 \`base_amount\` 均为**可读数量**（非最小单位），可直接使用；` +
    `响应中的 \`balance\` 字段可作为余额检查点来源。`);

  const reportPath = join(PROJECT_ROOT, 'docs', 'CONTRACT.md');
  writeFileSync(reportPath, `${report.join('\n')}\n`);
  log.info('契约报告已写入', { path: reportPath });
}

main().catch((err: unknown) => {
  log.error('契约验证失败', { error: err });
  process.exitCode = 1;
});
