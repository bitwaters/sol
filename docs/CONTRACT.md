# 接口契约验证报告（M1-6）

> 初验：2026-09-13（demo key）；补验：2026-09-14（个人 Key + Ed25519 签名，只读）
> 样本文件：`test/fixtures/*.json`（公开接口响应的脱敏版本；钱包／交易标识及社交信息为合成数据，不含凭证）

## 1. 事件唯一键（结论：必须包含金额字段）

**候选键（最终）**：

```
sol:{transaction_hash}:{maker}:{base_address}:{side}:{timestamp}:{token_amount}:{quote_amount}
```

验证数据：

| 来源 | 样本 | 同 tx 多事件组 | 同 tx 多钱包 | 无金额键重复 | 含金额键重复 |
|---|---|---|---|---|---|
| smartmoney | 20 | 5–7 | 0 | 有 | **0** |
| kol | 20 | 7 | 0 | 有 | **0** |

关键事实：

- 同一交易可包含**多笔成交**：同一钱包同方向的分笔（金额不同）、甚至同 tx 内买卖并存
- `tx_hash + maker + base_address + side` **不唯一**，必须追加 `timestamp + token_amount + quote_amount`
- 接口不提供交易内事件序号；金额字段是当前可用的最可靠区分维度
- 金额用原始响应值（字符串化）形成来源别名；跨来源还需匹配规范事件，不能仅按原始金额键去重。
- 个人 Key 实测：100 条 follow 与 100 条 KOL 中有 19 笔同事件，金额存在约 `1e-7` 的相对误差；公开源无 `quote_address`。现按同链、交易、钱包、代币、方向、秒，再同时比较代币数量、quote 数量及 USD 金额（相对容差 `1e-6`）。仅唯一且尚未收录该来源的候选可合并；两边报价币地址均存在时须一致。
- `trade_event_aliases` 保存来源原始键到规范事件的映射；同来源不同分笔、多个近似候选不强行合并。这是缺少交易内事件序号时的保守策略，不能证明所有成交绝对唯一。

## 2. 成交流字段（track smartmoney / kol，实测）

| 字段 | 实测 | 说明 |
|---|---|---|
| `transaction_hash` / `maker` / `base_address` / `side` | ✅ | 键组成部分 |
| `token_amount` / `base_amount` | ✅ | **可读数量**（两者相等，非最小单位） |
| `quote_amount` | ✅ | 报价币数量（SOL 可读值） |
| `amount_usd` / `buy_cost_usd` | ✅ | USD 金额 |
| `price` / `price_usd` | ✅ | 成交价 |
| `is_open_or_close` | ✅ | 语义按来源解释（§4.3） |
| `balance` | ✅ | **成交后钱包余额快照**，可用于余额核验（§7.3 检查点） |
| `base_token.launchpad` / `symbol` / `total_supply` | ✅ | 代币元信息 |
| `maker_info.tags` / `twitter_username` / `name` | ✅ | 钱包标签与身份 |
| `timestamp` | ✅ | unix 秒 |

## 3. token 富化字段映射（实测路径）

### token info（`GET /v1/token/info`，权重 1）

| 内部字段 | JSON 路径 | 实测 |
|---|---|---|
| price | `price.price` | ✅ `"0.0015962726"` |
| market_cap | **计算** `price.price × circulating_supply` | ✅ |
| circulating_supply | `circulating_supply` | ✅ `"999987239"` |
| decimals | `decimals` | ✅ `6` |
| created_at | `creation_timestamp` | ✅ unix 秒 |
| liquidity | `liquidity` | ✅ USD 字符串 |
| holder_count | `holder_count` | ✅ |
| top10_rate | `stat.top_10_holder_rate` | ✅ 0–1 |
| bundler_rate | `stat.top_bundler_trader_percentage` | ✅ 0–1 |
| insider_rate | `stat.top_rat_trader_percentage` | ✅ 0–1 |
| entrapment_rate | `stat.top_entrapment_trader_percentage` | ✅ 0–1 |
| bot_degen_rate | `stat.bot_degen_rate` | ✅ 0–1 |
| fresh_wallet_rate | `stat.fresh_wallet_rate` | ✅ 0–1 |
| dev_hold_rate | `stat.dev_team_hold_rate` | ✅ 0–1 |
| sniper_count | `wallet_tags_stat.sniper_wallets` | ✅ 整数 |
| creator_token_status | `dev.creator_token_status` | ✅ `creator_hold` / `creator_close` |
| socials | `link.twitter_username` / `link.telegram` / `link.website` | ✅ |
| launchpad | `launchpad_platform` | ✅ |

### token security（`GET /v1/token/security`，权重 1）

| 内部字段 | JSON 路径 | 实测 |
|---|---|---|
| top10_rate | `top_10_holder_rate` | ✅ 0–1 |
| honeypot | `honeypot` | ✅ `0`（SOL 恒 0；`is_honeypot` 为 null） |
| renounced_mint | `renounced_mint` | ✅ 布尔 |
| renounced_freeze | `renounced_freeze_account` | ✅ 布尔 |
| open_source | `open_source` | ✅ `0`/`1` |
| buy_tax / sell_tax | `buy_tax` / `sell_tax` | ✅ 字符串小数 |
| **rug_ratio** | — | ❌ **不提供** |
| **is_wash_trading** | — | ❌ **不提供** |

### 结论：rug_ratio / is_wash_trading 不可得

两个字段**仅存在于 trending / trenches 的 rank 项**，token info / security 均不返回。
硬过滤改用可得代理字段：

- `maxEntrapmentRate` ← `stat.top_entrapment_trader_percentage`（诱捕交易占比）
- `maxBotDegenRate` ← `stat.bot_degen_rate`（机器人活动占比，作为 wash 代理）

## 4. 钱包画像（portfolio stats，权重 3）

- 响应为**单个对象**。2026-09-14 传入两个 `wallet_address` 实测仅返回第一个；网关改为逐地址请求，每个地址消耗权重 3，应用层再聚合结果。修复后请求两个不同钱包，返回两个画像且地址均匹配。
- 实测可用路径：`common.fund_from_address`、`common.created_at`、`common.tags`、`pnl_stat.winrate`、`realized_profit_pnl`

## 5. kline（`GET /v1/market/token_kline`，权重 2）

- **`from` / `to` 单位为毫秒**（用秒会返回空数组）
- 不传 from/to 时返回最近 100 根
- 字段：`time`（毫秒）、`open` / `close` / `high` / `low`（字符串）、`volume`（USD）、`amount`（代币数量）

## 6. 限频现实（重要）

- **demo key 为 IP 级严格限频**（实测约 1 req/s，超出即 429，封禁约 30s 起）
- 官方文档的 `rate=20 / capacity=20` 适用于个人 API Key
- 本项目：`GMGN_RATE_LIMIT_PER_SEC` 环境变量控制限流速率（默认 20；demo key 建议 1）
- **M1-15 必须用个人 Key 复验 20/s 预算与 429/封禁恢复**

## 7. 个人 Key 补验（2026-09-14）

| 项目 | 结果与处理 |
|---|---|
| follow 签名 | 配对 Key + Ed25519 私钥请求成功；只读接口也要求签名，不是监控钱包的资产私钥 |
| follow 数量 | 100 条样本中 `token_amount=0`，实际数量在 `base_amount`，为可读枚数；`base_amount × price_usd / amount_usd` 范围约 `0.9999999084–1.0000000941`，另由跨来源同笔成交交叉确认。不可再除以 `10^decimals` |
| follow 余额 | 样本 `balance_info` 均为 null，不猜测其结构；后到公开源的 `balance` 须保留用于重放；明确全平提示可提供后续周期的零余额起点 |
| 实际页容量 | smartmoney / KOL 请求 200，均只返回 100；配置改为 100，poller 对旧配置也按 100 判定满页 |
| follow 分页 | `next_page_token` 请求第二页返回相同首页；额外测试 `page_token` / `cursor` / `next` 也未前进。**尚未通过分页回补验收**；保留缺口，检测重复页／重复游标并停止无效翻页，不能声称完整覆盖关注钱包交易 |
| wallet stats | 单地址调用验证通过，两个地址分别请求后均得到对应画像 |

实际响应仅保存在被 Git 忽略的 `data/debug/`，不提交私人关注列表；仓库内 `test/live-contract.test.ts` 使用虚构地址复现实测字段和精度差异。

后续：确认服务端有效分页契约、用同一最终版本连续运行 30 分钟，并完成故障恢复与 Telegram 测试群验收。短时联调不替代这些门禁。
