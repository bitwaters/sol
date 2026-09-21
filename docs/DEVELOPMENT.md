# Meme 信号 Bot 开发文档

> 状态：设计定稿，待开发（M1 未开始）
> 最后更新：2026-09-13

---

## 1. 项目概述

**目标**：监控 Solana meme 币的聪明钱（Smart Money）/ KOL / 自选钱包共同买入行为，经过持仓与价格校验后，向 Telegram 频道推送信号。

**定位**：筛选 + 风控工具，**不是自动跟单引擎**。第一阶段不做任何交易执行。

**设计原则**：

- 所有过滤条件为**二元判断或数值区间**，不引入加权评分系统
- 宁可漏报，不可错报（研究显示基础率极低，噪声极大）
- 推送的信号必须回答："谁还在拿、成本在哪、现价离成本多远"

**非目标**（本阶段）：

- 多链支持（仅 Solana）
- 自动买入 / 条件单
- 复杂评分、机器学习排序
- 多群独立订阅（先做单群固定参数）

---

## 2. 研究结论摘要（阈值依据）

### 2.1 基础率与存活

| 指标 | 数值 | 来源 |
|---|---|---|
| pump.fun 毕业率（2026 年样本） | 0.198%（约 6 分钟观察窗口下界）~ 1% | arXiv:2607.02823 |
| 代币流动性 <$1,000 的比例 | 98.6% | Solidus Labs 2025 |
| 迁移代币中高风险占比 | 84.13% | arXiv:2602.13480 (MELT) |
| 当天死亡（同天最后一笔交易） | 68.67% | CoinGecko 2026-06 |
| 毕业中位时间 | 4.4 分钟 | arXiv:2602.14860 |

### 2.2 成功代币的早期特征

- 初始市值 >30 SOL 是毕业率**最强单因子**（Cox HR 4.51）
- 有 Telegram 社群的代币毕业率 1.485% vs 无社群 0.166%（**8.94 倍**）
- 毕业线约 85 SOL 储备 / 约 $69k 市值
- "少量交易快速拉满 bonding curve" 是最强毕业预测因子

### 2.3 风险与操纵

| 风险类型 | 数据 | 来源 |
|---|---|---|
| holder < 100 的代币 | 95% 为高风险 | arXiv:2602.13480 |
| 协调账户持有供应量 | 平均 36.5% | arXiv:2602.13480 |
| bundler 掩盖的 top10 集中度 | 高风险盘合并后 +24pp | arXiv:2602.13480 |
| wash trading 占交易笔数 | 17% | arXiv:2609.10246 |
| sniper 入场时间 | 创建后 0.4~2 秒 | arXiv:2601.08641 |
| 协同钱包簇对净流入的因果效应 | +6.3%（置信区间跨 0，**不显著**） | arXiv:2607.02795 |

### 2.4 跟单的机械损耗（关键警告）

- 在 WWW'26 的**模型筛选样本**中，聪明钱自身平均收益 **14%/币**，跟单者仅 **3%/币**（78% 损耗，bonding curve 价格冲击 + 延迟）；该数字不是全市场平均值
- 97% 的 leader 盈利，但仅约 43% 的 follower 盈利（YieldFund/Arkham 引用的多交易所样本）
- 来源：WWW'26 arXiv:2601.08641、Arkham/YieldFund

> **结论**：共同买入信号必须叠加资金流质量过滤与持仓校验，且 bot 需明确告知用户这是筛选工具而非收益保证。

### 2.5 结论适用范围与限制

| 结论 | 限制 |
|---|---|
| 毕业率 0.198% | 对应发行后约 6 分钟观察窗口，是全天毕业率的**下界**，不可外推为全天/全市场毕业率 |
| 14% vs 3% 跟单损耗 | 来自特定模型筛选样本的实验结果，非全市场普遍平均值；仅作方向性参考 |
| 协同簇效应（+16.1% 买家数 / 净流入不显著） | 单作者预印本，需谨慎引用 |
| 各风险阈值（bundler / top10 等） | 部分为行业经验值，缺少学术验证，按 §8 待验证假设处理 |
| 毕业成功 / 价格上涨 / 可实际获得收益 | 三个不同概念，不可混用；回测先报告价格变化与覆盖率（§10） |

---

## 3. 系统架构

```
                    ┌─────────────────────────────────────┐
                    │           GMGN OpenAPI              │
                    └──────────────┬──────────────────────┘
                                   │ HTTPS (IPv4 only)
                    ┌──────────────▼──────────────────────┐
                    │  Pollers（全局 Token Bucket 20/s）    │
                    │  smartmoney 1.5s / kol 3s / follow 3s│
                    └──────────────┬──────────────────────┘
                                   │ 归一化 + 事件去重（验证键）
                    ┌──────────────▼──────────────────────┐
                    │        SQLite (WAL)                 │
                    │  trades / wallet_positions / ...    │
                    └──────────────┬──────────────────────┘
                                   │ 15min 滚动窗口聚合
                    ┌──────────────▼──────────────────────┐
                    │          Signal Engine              │
                    │  关联合并 → 计数 → 候选状态机         │
                    └──────────────┬──────────────────────┘
                                   │ 第一层：钱包层校验（本地）
                                   │ 画像/快进快出/清仓剔除 → 净流入/保留率/建仓要求
                    ┌──────────────▼──────────────────────┐
                    │  Token 富化（价格新鲜度 ≤60s）        │
                    │  硬过滤 + 追高校验（第二层）          │
                    └──────┬───────────────┬──────────────┘
                           │ 通过          │ 不通过（不推送，记录 signals）
                    ┌──────▼───────┐  ┌────▼─────────────────┐
                    │ Telegram 推送 │  │ 记录 signals          │
                    │ 升级/退出提醒 │  │ status=invalidated/...│
                    └──────────────┘  └──────────────────────┘
```

**模块划分**

| 模块 | 职责 |
|---|---|
| `src/gmgn` | vendored OpenApiClient + Ed25519 signer（来自 gmgn-skills，MIT） |
| `src/ingest` | 三个 poller、去重、429 退避、心跳 |
| `src/signal` | 滑动窗口聚合、关联合并、持仓跟踪、推送前校验、冷却 |
| `src/enrich` | token info/security 富化（分层缓存：价格 60s / 风险指标 5min / 基础资料 30min）、钱包画像（每日批量刷新 + 候选时按需补拉） |
| `src/telegram` | 消息模板、推送、状态提示去重、退出监控、命令 |
| `src/store` | better-sqlite3、schema、数据保留 |
| `src/backtest` | （M4）信号后价格评估 |
| `src/config.ts` | 配置加载与校验 |

---

## 4. GMGN API 接入

### 4.1 认证

| 类型 | 说明 |
|---|---|
| exist auth | 仅 API Key；`track smartmoney` / `track kol` / `portfolio activity` / `portfolio stats` |
| signed auth | API Key + Ed25519 私钥签名；`track follow-wallet`、`portfolio holdings`、交易类 |

- API Key 在 https://gmgn.ai/ai 用 Ed25519 公钥申请
- **私钥必须与申请时的公钥配对**，本地 `.env` 保存，权限 600
- **仅支持 IPv4**，出站 IPv6 会导致 401/403
- 开发期可用官方 demo key `gmgn_solbscbaseethmonadtron` 调只读接口

### 4.2 限频

Leaky bucket：每秒补充 20 权重（`rate=20`）、突发容量 20（`capacity=20`），按路由权重消耗。

| 端点 | 权重 | 用途 |
|---|---|---|
| `GET /v1/user/smartmoney` | 1 | 聪明钱实时成交（买卖双边） |
| `GET /v1/user/kol` | 1 | KOL 实时成交（买卖双边） |
| `GET /v1/trade/follow_wallet` | 3 | 关注列表成交（signed，支持 next_page_token） |
| `GET /v1/user/wallet_activity` | 3 | 单钱包成交（备用） |
| `POST /v1/market/token_signal` | 3 | 服务端信号流（交叉验证用） |
| `portfolio stats`（逐地址） | 3 | 钱包画像（fund_from / created_at / tags） |
| `token info` | 1 | 价格 / 市值 / 年龄 / 持有人 / 社交 |
| `token security` | 1 | rug / bundler / insider / 权限 / wash |
| `token pool` | 1 | 流动性池明细 |
| `market kline` | 2 | 回测评估 |

> token 端点权重来自官方 skill 文档（`gmgn-token`）；以最新文档为准。
> **限频实测**：demo key 为 IP 级严格限频（约 1 req/s，超出即 429）；个人 Key 预期 20/s。
> 本项目用 `GMGN_RATE_LIMIT_PER_SEC` 控制限流速率（默认 20，demo key 建议 1）。

**429 处理**：读取 `X-RateLimit-Reset` / body `reset_at`，退避等待；封禁期**零重试**（重试会延长封禁最多 5 分钟）；恢复后 follow-wallet 按 cursor 回补。

### 4.3 字段语义陷阱

`is_open_or_close` 在不同端点含义相反：

| 端点 | `0` | `1` |
|---|---|---|
| `follow-wallet` | 部分加仓 / 部分减仓 | **全仓开仓 / 全仓平仓** |
| `kol` / `smartmoney` | 开仓 / 加仓 | 平仓 / 减仓 |

> `track kol/smartmoney` 的 `--side` 是**客户端过滤**，poller 直接拉全量（买卖都要），无需额外请求。

---

## 5. 数据采集

### 5.1 轮询计划

| 任务 | 频率 | limit | 权重/次 |
|---|---|---|---|
| smartmoney | 1.5s | 100 | 1 |
| kol | 3s | 100 | 1 |
| follow-wallet | 3s | 100 | 3 |

个人 Key 实测 smartmoney / KOL 请求 200 也只返回 100，按 100 判断满页。当前 follow 游标未能推进，见 `CONTRACT.md` §7；重复页停止翻页，缺口仍需保留。

基准间隔平均消耗约 2.0 权重/秒（smartmoney 0.67 + kol 0.33 + follow 1.0），远低于 20/s 上限，剩余预算给富化与画像。

### 5.2 采集规则

**事件去重（含个人 Key 跨来源补验）**

- 同一交易可能包含多个成交事件（bundler 多钱包、同钱包多笔）；同一事件也可能出现在多个来源（钱包同时带 smartmoney 与 kol 标签）
- 去重键（**M1-6 已用真实响应验证，见 `docs/CONTRACT.md`**）：
  `chain + tx_hash + maker + base_address + side + timestamp + token_amount + quote_amount`
  同一交易可包含多笔成交（同钱包同方向分笔、同 tx 内买卖并存），前五段不足以保证唯一
- 验证数据：smartmoney / kol 各 20 条样本中，含金额键重复均为 0
- 个人 Key 补验发现跨来源浮点差异：原始金额键作为来源别名，再以同交易／钱包／代币／方向／秒和数量、quote、USD 的唯一近似匹配关联规范事件，详见 `CONTRACT.md` §1。
- 金额/数量只按事件累计一次；`source` 不做主键，改存 `trade_sources` 表累计来源标签，不重复计金额

**缺口与水位**

- 每个来源记录：最近成功时间、已确认成交时间水位、最近观测页头 `head_ts`、已知缺口区间、回补 cursor（`source_health` 表）
- 影响当前信号的数据缺口未修复时，暂停该信号推送（§7.4 数据完整性门禁）
- 启用来源超过60秒无成功响应时，另记 `source_outages` 停采区间并阻止资格确认；不因来源已消失于当前窗口而忽略，也不能按普通缺口超时接受。历史停采区间永久参与研究完整性校验，恢复不重写旧样本。独立监测和请求截止时间详见 `DEPLOYMENT.md`。
- 回补按成交时间顺序处理；成交流水写入、持仓更新与 cursor 推进在同一事务内完成
- **迟到事件处理**：若事件时间早于已处理的后续事件，选择**严格早于最早受影响事件**的有效检查点重放，重建持仓周期
- 无更早检查点时，从已确认的零余额周期起点重放；两者都无 → 保持 `unknown`，不恢复计算资格
- 重建期间暂停依赖该持仓的新信号推送；重建完成后校正 `signal_wallets` 的周期绑定并记录
- 用"新增记录数 / 相邻批次重叠度 / 时间覆盖度"判断采集压力，不只依赖是否打满 limit
- **水位与缺口判定（M1-15 冒烟修正）**：
  - 首次成功观测以本页最大时间为观测起点，历史数据不计缺口
  - 存在已入库事件且回追到确认水位之前 → 连续；已有缺口时还必须覆盖其上界，才能清除缺口并推进确认水位
  - 已有缺口时，确认水位停留在缺口之前；后续页面与 `head_ts` 之前已观测事件重叠，表示近期连续，不因此扩大旧缺口
  - 部分重叠但未追到最近页头 → 缺口 `[head_ts, 回追点]`
  - 整页全新且无重叠 → 可能缺口 `[head_ts, 本页最早时间]`（高流量溢出）；已有缺口时保守合并区间
  - `head_ts` 随观测推进并持久化；旧库尚无该值时，用已保存的来源成交及确认水位初始化，不回写历史缺口范围
  - **高流量源（smartmoney / kol）会持续整页返回，不得用"整页 = 缺口"，必须用重叠检测**
  - 缺口超过 10 分钟仍未修复 → 按"不可观测"接受，恢复水位到最新已观测成交，但历史缺口只保留实际记录的范围，不扩展到恢复时间，也不恢复受影响旧周期的成本资格

**其他**

- 打满 `limit` 时临时提频，**设频率上限**（如 2 倍基准）；连续 3 次不打满或水位追上实时后恢复基准频率
- 卖出数据**全量入库**（用于净流入、持仓跟踪、退出监控）
- 心跳：每个 poller 记录最后成功时间，>60s 未更新触发运维告警
- 进程重启后：水位、缺口、冷却状态从 DB 恢复，窗口数据直接复用 trades 表
- follow-wallet 单次 100 条打满时按 `next_page_token` 循环翻页（每页权重 3，预算内）
- 未配置 `GMGN_PRIVATE_KEY` 时 follow-wallet 源自动降级跳过，不阻塞其他数据源

---

## 6. 数据模型（SQLite）

```sql
-- 成交事件（买卖双边；金额/数量按事件只累计一次）
CREATE TABLE trades (
  event_id TEXT PRIMARY KEY,        -- 候选键 = chain:tx_hash:maker:base_address:side[:event_index]
                                    -- M1 用真实响应验证唯一性后再定案（§5.2）
  chain TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  maker TEXT NOT NULL,
  side TEXT NOT NULL,               -- buy | sell
  base_address TEXT NOT NULL,
  symbol TEXT,
  raw_amount TEXT,                  -- 接口原样数量（字符串，不丢精度）
  raw_amount_unit TEXT,             -- human（可读枚数）| base_unit（最小单位）
  raw_decimals INTEGER,             -- 代币 decimals；缺失时该周期标 incomplete
  amount_normalized TEXT,           -- 统一换算后的十进制数量（字符串）
  amount_usd TEXT,                  -- 权威金额（十进制字符串，§6.1）
  amount_usd_num REAL,              -- 冗余，仅用于 SQL 粗过滤/排序
  price_usd TEXT,                   -- 权威价格（十进制字符串）
  action_hint TEXT,                 -- 归一化行为提示：full_open | partial_add | close | reduce | null
  timestamp INTEGER NOT NULL,       -- unix 秒
  raw JSON,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_trades_token_ts ON trades(base_address, timestamp);
CREATE INDEX idx_trades_maker_ts ON trades(maker, timestamp);
CREATE INDEX idx_trades_tx ON trades(tx_hash);

-- 同一事件的多来源观测（只累计来源标签，不重复计金额）
CREATE TABLE trade_sources (
  event_id TEXT NOT NULL,
  source TEXT NOT NULL,             -- smartmoney | kol | follow
  raw_is_open_or_close INTEGER,     -- 该来源的原始行为字段（语义按来源解释）
  raw JSON,                         -- 该来源的原始响应
  first_seen_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, source)
);

-- 采集健康与缺口
CREATE TABLE source_health (
  source TEXT PRIMARY KEY,
  last_success_at INTEGER,
  watermark_ts INTEGER,             -- 已完整处理到的成交时间水位
  head_ts INTEGER,                  -- 最近观测页头，旧缺口存在时仍可推进
  gap_from_ts INTEGER,              -- 已知缺口起点（null = 无缺口）
  gap_to_ts INTEGER,
  backfill_cursor TEXT,
  updated_at INTEGER
);

-- 代币富化缓存
CREATE TABLE tokens (
  address TEXT PRIMARY KEY,
  symbol TEXT, name TEXT, launchpad TEXT,
  created_at INTEGER,
  price TEXT,                       -- 最新价（十进制字符串）
  price_updated_at INTEGER,         -- 价格刷新时间（新鲜度 ≤60s）
  risk_updated_at INTEGER,          -- 风险字段刷新时间（≤5min）
  basic_updated_at INTEGER,         -- 基础资料刷新时间（≤30min）
  market_cap REAL, liquidity REAL, holder_count INTEGER,
  top10_rate REAL, bundler_rate REAL, insider_rate REAL,
  sniper_hold_rate REAL, sniper_count INTEGER, fresh_wallet_rate REAL,
  dev_hold_rate REAL, creator_token_status TEXT,
  rug_ratio REAL,
  is_wash INTEGER, is_honeypot INTEGER,
  has_social INTEGER, socials JSON,
  enriched_at INTEGER,
  raw JSON
);

-- 钱包画像（每日批量刷新 + 候选时按需补拉）
CREATE TABLE wallets (
  address TEXT PRIMARY KEY,
  name TEXT, twitter TEXT, tags JSON,
  fund_from TEXT, fund_from_address TEXT,
  wallet_created_at INTEGER,
  refreshed_at INTEGER
);

-- 持仓周期（由 trades 增量更新；当前周期 = max(cycle_no)）
CREATE TABLE wallet_positions (
  wallet TEXT NOT NULL,
  token TEXT NOT NULL,
  cycle_no INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'open', -- open | closed | unknown | incomplete
  cost_complete INTEGER DEFAULT 0,    -- 1=成本完整（参与均价/保留率的唯一资格）
  bought_amount TEXT DEFAULT '0',     -- 十进制字符串，避免浮点误差
  sold_amount TEXT DEFAULT '0',
  bought_usd TEXT DEFAULT '0',        -- 十进制字符串
  sold_usd TEXT DEFAULT '0',
  avg_entry_price_usd TEXT,
  cycle_started_at INTEGER,           -- 本周期首次买入时间
  last_buy_ts INTEGER,
  last_sell_ts INTEGER,
  last_trade_ts INTEGER,
  confidence REAL DEFAULT 0,          -- 仅分析字段，不用于参与资格判定（§7.3）
  PRIMARY KEY (wallet, token, cycle_no)
);

-- 持仓检查点（核验余额 + 支持从早于迟到事件的位置重放恢复周期状态）
CREATE TABLE position_checkpoints (
  wallet TEXT NOT NULL,
  token TEXT NOT NULL,
  cycle_no INTEGER NOT NULL,
  checked_at INTEGER NOT NULL,
  balance TEXT NOT NULL,            -- 当前剩余量（十进制字符串）
  bought_amount TEXT NOT NULL,      -- 重放所需的周期累计
  sold_amount TEXT NOT NULL,
  bought_usd TEXT NOT NULL,
  sold_usd TEXT NOT NULL,
  cost_complete INTEGER NOT NULL,   -- 该检查点是否基于成本完整周期
  cycle_started_at INTEGER,         -- 真实周期起点，不能用 checked_at 替代
  last_buy_ts INTEGER,
  last_sell_ts INTEGER,
  source TEXT NOT NULL,             -- balance_info | local_rebuild
  PRIMARY KEY (wallet, token, cycle_no, checked_at)
);

-- 信号记录（含回测字段）
CREATE TABLE signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL,
  symbol TEXT,
  triggered_at INTEGER NOT NULL,
  window_start INTEGER,             -- = triggered_at - windowMinutes
  window_end INTEGER,               -- = triggered_at
  wallet_count INTEGER,             -- 关联合并后的计票数
  net_inflow_usd REAL,              -- 窗口内该 token 全部被追踪成交：Σ买入USD − Σ卖出USD
  holding_ratio REAL,               -- 发送前为当前有效成员，发送后为固定绑定周期的数量保留率
  price_ratio REAL,                 -- 现价 / 有效票钱包窗口内加权平均入场价
  status TEXT,                      -- candidate | sending | pushed | invalidated | blocked_price
                                    -- | suppressed_enrich_failed | expired | muted
  reason TEXT,
  tg_chat_id TEXT, tg_message_id INTEGER,
  escalated_count INTEGER DEFAULT 0, -- 成员版本号（成员加入时递增）
  message_revision INTEGER DEFAULT 0, -- 消息修订号（任何可见内容变化递增）
  price_at_trigger TEXT,            -- 首次触发时价格
  price_at_send TEXT,               -- 确认送达时价格
  sent_at INTEGER,                  -- 确认送达时间（冷却起算）
  outcome_5m REAL, outcome_1h REAL, outcome_24h REAL,
  snapshot JSON,                    -- 初始成员快照（写入后不可覆盖）
  display_wallets JSON,             -- 当前有效成员展示，与退出监控固定成员分离
  send_snapshot JSON                -- 首次送达指标、来源与分组快照；用于回测
);
CREATE INDEX idx_signals_token ON signals(token, triggered_at);

-- 信号涉及的钱包明细（绑定持仓周期，原周期关闭后不被新周期覆盖）
CREATE TABLE signal_wallets (
  signal_id INTEGER NOT NULL,
  wallet TEXT NOT NULL,
  cycle_no INTEGER NOT NULL,        -- 加入时的持仓周期
  cluster_id TEXT,                  -- 簇标识（同一信号内）
  joined_version INTEGER DEFAULT 0, -- 加入时的信号版本（= 当时 escalated_count）
  joined_at INTEGER,                -- 成员首次加入时间，后续评估不覆盖
  joined_event_id TEXT,             -- 加入时对应的买入成交，重放后用于校正周期绑定
  active INTEGER NOT NULL DEFAULT 1, -- 当前展示资格；失效不删除已推送成员的周期绑定
  source TEXT, tags JSON,
  amount_usd TEXT, action TEXT,     -- open | add | reduce | close
  entry_price_usd TEXT,
  holding_state_at_push TEXT,       -- holding | partial | closed
  holding_state_now TEXT,
  PRIMARY KEY (signal_id, wallet, cycle_no)
);

-- 运行状态：冷却、cursor、心跳
CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value JSON,
  updated_at INTEGER
);

-- 持久化发送任务（处理"已送达但响应丢失"）
CREATE TABLE push_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id INTEGER NOT NULL,
  kind TEXT NOT NULL,               -- signal | escalate | exit_alert（summary 暂不实现）
  alert_type TEXT,                  -- exit_alert 专用：consensus_exit | other_cluster_exit
  revision INTEGER DEFAULT 0,       -- escalate 专用：消息修订号（= 当时的 message_revision）
  dedupe_key TEXT NOT NULL UNIQUE,  -- signal: signal_id+signal
                                    -- escalate: signal_id+escalate+revision
                                    -- exit_alert: signal_id+exit+alert_type（不含修订）
  payload JSON NOT NULL,
  status TEXT NOT NULL,             -- pending | sending | sent | unknown | failed | cancelled
  attempts INTEGER DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_retry_at INTEGER,            -- failed 等待重试的下次时间（重启恢复用）
  tg_message_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_push_tasks_status ON push_tasks(status, updated_at);

-- 不可变评估记录（M1 起保留；状态怎么变都不覆盖历史）
CREATE TABLE signal_evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id INTEGER NOT NULL,
  evaluated_at INTEGER NOT NULL,
  stage TEXT NOT NULL,              -- wallet_layer | token_layer | send_recheck
  config_version TEXT NOT NULL,
  rules_version TEXT NOT NULL,
  input_snapshot JSON NOT NULL,
  result TEXT NOT NULL,             -- pass | fail
  reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_evaluations_signal ON signal_evaluations(signal_id, evaluated_at);
```

**数据保留**：`trades` 滚动保留 30 天（回放所需数据另行压缩归档，§10）；`signals` / `signal_wallets` / `signal_evaluations` / `push_tasks` 永久。

### 6.1 字段映射与精度规则

各接口数量字段单位不同，**必须先归一化再计算**：

| 来源 | 原始字段 | 单位 | 转换 | 空值/缺失处理 |
|---|---|---|---|---|
| `track kol` / `smartmoney` | `token_amount`（= `base_amount`） | **可读数量（枚）**（M1-6 实测） | 直接作为数量 | 缺失 → 该笔不参与成本/保留率计算 |
| `track kol` / `smartmoney` | `balance` | 成交后钱包余额（枚） | 余额检查点（§7.3） | 缺失 → 不使用该检查点 |
| `track kol` / `smartmoney` | `amount_usd` / `price_usd` | USD | 直接用 | 缺失 → 该笔不参与金额指标 |
| `track follow-wallet` | `base_amount`（优先于可能为 0 的 `token_amount`） | **可读数量（枚）**（2026-09-14 实测） | 直接作为数量 | 数量缺失或无效 → incomplete |
| `track follow-wallet` | `quote_amount` | 报价币可读数量（同笔公开源交叉验证） | 不作 lamports 换算 | 缺失 → 不用于近似去重 |
| `track follow-wallet` | `amount_usd` / `price_usd` | USD | 直接用 | 缺失 → 该笔不参与金额指标 |
| token info | `decimals` / `total_supply` | — | 换算依据 | 缺失 → 标记数量未知 |

- 原始值**按接口原样存字符串**并记录单位（`raw_amount` + `raw_amount_unit`）；可读数量（human）需先取得 decimals 才能换算为最小单位整数
- 统一换算后的数量存 `amount_normalized`（十进制字符串）；代码层使用十进制运算库（如 decimal.js），禁止二进制浮点直接比较
- 金额/价格权威值以十进制字符串保存（`amount_usd` / `price_usd`）；两位小数仅用于展示；`amount_usd_num` 冗余列仅供 SQL 粗过滤
- **任一成交数量缺失或无效时，该钱包的当前持仓周期标记为 `incomplete`**（已验证的可读数量不依赖 decimals）（不是忽略该笔）：该周期不参与均价、保留率与清仓判定
- 清仓判定不用"等于 0"，用余量阈值：`余量 / 本周期买入量 < positionDustRatio`（默认 1%）视为清仓
- **行为字段归一化**：`trades.action_hint` 由多来源观测合成——**follow-wallet 的明确全开/全平证据优先**，其次 kol/smartmoney 的 0/1 映射；后续观测可修正 `action_hint`，但持仓与金额按 `event_id` 幂等更新，不重复累计
- 字段单位以 **M1-6 真实响应验证为准**（见 `docs/CONTRACT.md`）：smartmoney/kol 的 `token_amount` 为可读数量；follow-wallet 的 `base_amount` 也为可读数量（个人 Key 补验）

### 6.2 token 富化字段映射（实际端点，M1-6 实测）

**不同端点是不同契约，禁止混用同名字段**。以下路径均经真实响应验证（样本见 `test/fixtures/`）。

**token info（权重 1）**

| 内部字段 | JSON 路径 | 单位 / 公式 | 缺失行为 |
|---|---|---|---|
| `price` | `price.price` | USD 字符串 | 暂缓（§7.4） |
| `market_cap` | **计算**：`price.price × circulating_supply` | USD | 暂缓 |
| `circulating_supply` | `circulating_supply` | 字符串整数 | 暂缓 |
| `decimals` | `decimals` | 整数（数量换算必需） | 周期标 incomplete |
| `created_at` | `creation_timestamp` | unix 秒 | 暂缓 |
| `liquidity` | `liquidity` | USD 字符串 | 暂缓 |
| `holder_count` | `holder_count` | 整数 | 暂缓 |
| `top10_rate` | `stat.top_10_holder_rate` | 0–1 | 暂缓 |
| `bundler_rate` | `stat.top_bundler_trader_percentage` | 0–1 | 暂缓 |
| `insider_rate` | `stat.top_rat_trader_percentage` | 0–1 | 暂缓 |
| `entrapment_rate` | `stat.top_entrapment_trader_percentage` | 0–1 | 暂缓 |
| `bot_degen_rate` | `stat.bot_degen_rate` | 0–1 | 暂缓 |
| `fresh_wallet_rate` | `stat.fresh_wallet_rate` | 0–1 | 暂缓 |
| `dev_hold_rate` | `stat.dev_team_hold_rate` | 0–1 | 暂缓 |
| `sniper_count` | `wallet_tags_stat.sniper_wallets` | 整数 | 暂缓 |
| `creator_token_status` | `dev.creator_token_status` | `creator_hold` / `creator_close` | 暂缓 |
| `socials` | `link.twitter_username` / `link.telegram` / `link.website` | 字符串 | 仅展示 |
| `launchpad` | `launchpad_platform` | 字符串 | 仅展示 |

**token security（权重 1）**

| 内部字段 | JSON 路径 | 单位 | 缺失行为 |
|---|---|---|---|
| `top10_rate` | `top_10_holder_rate` | 0–1 | 暂缓 |
| `honeypot` | `honeypot` | `0` / `1`（SOL 恒 0；`is_honeypot` 为 null） | SOL 恒通过 |
| `renounced_mint` | `renounced_mint` | 布尔（SOL） | 暂缓 |
| `renounced_freeze` | `renounced_freeze_account` | 布尔（SOL） | 暂缓 |
| `open_source` | `open_source` | `0` / `1` | 仅展示 |
| `buy_tax` / `sell_tax` | `buy_tax` / `sell_tax` | 字符串小数 | 仅展示 |

**不可得字段（仅 trending / trenches rank 项提供，禁止在富化路径引用）**：

- `rug_ratio`、`is_wash_trading` → 硬过滤改用可得代理：`entrapment_rate`、`bot_degen_rate`（§8）
- `top70_sniper_hold_rate` → 用 `sniper_count` 替代

> M1-6 结论与样本：`docs/CONTRACT.md`、`test/fixtures/*.json`

---

## 7. 信号引擎

### 7.1 窗口聚合与候选状态机

**指标口径表**（每项指标明确钱包集合、成交集合、时间范围，避免口径漂移）：

| 指标 | 钱包集合 | 成交集合 | 时间范围 |
|---|---|---|---|
| 计票数 | 关联合并后的簇 | 满足 `minTradeAmountUsd` 的买入 | 窗口（本次评估时间往前 15 分钟） |
| 净流入 | 全部被追踪钱包 | 全部买入与卖出（**不设金额门槛**） | 窗口 |
| 共识买入额 | 有效票钱包 | 属于当前周期且满足门槛的买入 | 窗口 |
| 加权均价 | 有效票成本完整钱包 | 属于当前周期且满足门槛的买入 | 窗口 |
| 持仓保留 | 有效票钱包且 `state=open`、`cost_complete=1` | 当前周期累计 | 至本次评估时间 |

- **计票口径**：下文所有"票数/钱包数"均指关联合并后的计票数（一个关联簇 = 1 票）；金额与数量指标按簇内钱包逐笔汇总
- **周期 ∩ 窗口**：均价与建仓证据只取"当前持仓周期与滚动窗口的交集"；窗口内已关闭周期的买入不计入均价 / 建仓，但**净流入仍统计窗口内全部买卖**（口径不变）
- `minTradeAmountUsd` **仅用于买入计票资格**，不影响净流入计算
- **触发即校验**：计票数达到阈值的那一刻进入两层校验，不等待窗口结束
- 触发后窗口继续滚动：新增计票 → 独立状态提示（受 §7.5 节流约束）；钱包卖出 → 退出监控

**时间基准**：首次触发时间只用于追溯与统计；**每次校验都按当前评估时间**计算代币年龄、滚动窗口与数据新鲜度（`年龄 = now − created_at`，`窗口 = [now − windowMinutes, now]`）。`signalTtlSeconds` 从**最近一次校验通过的时刻**起算。

**候选状态机**（内存 + kv；每轮候选 = `signals` 一行，候选 ID = `signals.id`）：

```
watching（< minDistinctWallets 票）→ candidate（≥ minDistinctWallets 票，进入校验）
  ├─ 有效票不足 / 净流入不足 → invalidated；新增买入时重验（同一轮原地更新）
  ├─ 年龄不足门槛 → invalidated；到达门槛时定时重验（按评估时间计算年龄）
  ├─ 硬过滤失败（wash/dev/rug 等）→ invalidated；进入 10 分钟禁止重验期（固定截止，不被新买入延长）
  │      截止后按当前数据重新评估（风险指标可能已改善）
  ├─ 价格过高 → blocked_price；每 60s 有限重验，直到过期
  ├─ 富化失败 → suppressed_enrich_failed；30s / 60s / 120s 退避重试
  └─ 通过 → sending：原子创建发送任务（dedupe_key 规则见 §9.5）
            确认送达 → pushed（写入消息 ID、发送价格与 sent_at，冷却自此起算）
            发送 unknown/failed → 由 push_tasks 重试，最终失败告警
生命周期（适用于 `status ∈ {candidate, sending, invalidated, blocked_price, suppressed_enrich_failed}`）：
  满足任一即 expired——
  ① 自首次触发起超过 60 分钟（硬上限，不因新买入延长）
  ② now − 最后一笔计票买入 > windowMinutes（窗口内已无有效买入）
  过期后停止所有定时重验，并原子取消该信号尚未发出的首次推送任务（§9.5）
pushed 信号不适用过期规则，保持 pushed；监控何时结束按 §7.6 单独判断
重新触发：expired 后需"距上轮候选结束 ≥5 分钟 + 窗口内再次达到计票阈值"才建立新候选（新 ID）；
已推送信号需冷却结束后才允许建立新候选
同一轮内状态原地更新；每次校验追加 signal_evaluations（不覆盖历史）
```

### 7.2 关联钱包合并（伪共识检测）

**目标**：庄家用多个钱包制造"假共识"时，只计 1 票。

**合并规则**（union-find）：

1. 两个钱包的 `fund_from_address` 相同 **且** 创建时间相差 <60 分钟 → 合并
2. 同一笔交易中出现多个买入钱包（bundler 特征）→ 合并（只能覆盖已追踪钱包之间的同 tx，未追踪的钱包无法发现）
3. 当资金来源地址命中 CEX / 跨链桥 / 已知服务黑名单时，**不据此合并**（`fund_from` 标签判定）
4. 资金来源追踪深度：GMGN 数据只支持 **1 跳**（`fund_from_address`）；多跳追踪需要链上 RPC（Helius 等），列为 M4 可选增强

**防误合并**：

- CEX 热钱包黑名单必须人工维护（漏一个会把大量独立用户合并）
- 初期策略：宁可少合并（放过部分伪共识），不可错合并
- 簇内做"最坏单点删除"连通性检查（M4 增强，初期可省略）

**画像缺失时的规则**：

- 进入 candidate 校验时，对缺失画像的钱包按应用批次补拉（最多 100 个/批）；网关逐地址调用 `portfolio stats`，每地址独立消耗权重 3
- 补拉完成后**重新过滤、重新聚类、重新计票**，再进入代币层校验
- 补拉失败，或补拉成功但 `created_at` / `tags` 仍缺失 → 不能用于凑足有效票
- `fund_from` / `fund_from_address` 缺失 → 不参与合并（按独立簇处理），不影响计票资格
- `requireAtLeastOneSmartMoney` 判定：`source=smartmoney` 或 `maker_info.tags` 含 `smart_degen`

**计票**：每个合并后的簇计 1 票（不做 sqrt 衰减，保持简单）。

### 7.3 持仓周期与行为分类

**持仓周期**：确认清仓后旧周期结束；下一次买入开启新周期（`cycle_no + 1`）。建仓、成本、快进快出、持仓保留率**均按当前周期计算**，历史周期仅用于分析。

| 行为 | 判定（当前周期） |
|---|---|
| 建仓 | buy 且当前周期无买入记录（开启新周期） |
| 加仓 | buy 且当前周期已有买入记录 |
| 减仓 | sell 且周期余量 > 灰尘阈值 |
| 清仓 | sell 后 `余量 / 周期买入量 < positionDustRatio`（默认 1%），或 follow-wallet **sell** + `is_open_or_close=1` → 关闭周期 |

> **open 判定**（`requireOpenAction` 使用）：action=open（新周期首笔买入）；follow-wallet 来源的 `is_open_or_close=1` 买入可直接判定为 open。

**持仓状态**：`state = open | closed | unknown | incomplete`，由**两个独立维度**决定：

| 维度 | 含义 | 来源 |
|---|---|---|
| 成本完整 | 周期起点为已核验零余额，或完整历史重建，且期间无采集缺口 | 零余额检查点 / 重放 |
| 余额核验 | 当前剩余量已知 | `balance_info` 或本地重建 |

- `open`：周期开放；只有 **`cost_complete=1`** 的 `open` 钱包参与均价与保留率计算
- `closed`：余量低于阈值（本地计算，或余额核验为 0）→ 关闭周期
- `incomplete`：周期内存在数量 / decimals 缺失的成交（§6.1）→ 不参与计算；补齐缺失事件并重算后可恢复
- `unknown`：周期起点前已有持仓且无法重建 → 不参与计算
- 单次 `balance_info` 只能核验**当前余额**（用于清仓判定），**不能证明历史成本完整**
- `unknown` / `incomplete` 钱包可作为票参与共识，但有效票中 `cost_complete=1` 的钱包数必须达到 `minVerifiableWallets`，否则不推送（§7.4）

**零余额起点确认**（成本完整的唯一充分条件）：

1. **周期开始前存在明确的零余额证据**（检查点 `balance=0`，时间早于周期首笔买入），且此后记录完整、无采集缺口
2. **完整历史重建**：通过 `portfolio activity` 等回补，从代币创建或已确认零余额点至今全部事件重建周期

说明：

- "首次观测到买入"**不能**证明此前无持仓；"当前余额与本地净持仓一致"**不能**排除等量的漏记买卖
- 余额一致性仅用于**对账**（不一致时标记数据质量问题），不单独作为成本完整的证明
- 无法确认零余额起点 → `state=unknown` / `cost_complete=0`，不参与均价与保留率

**恢复规则**：迟到事件回补后（§5.2），选择**严格早于最早受影响事件**的有效检查点重放、重建周期；重建后 `cost_complete=1` 的周期可恢复参与计算，并同步校正 `signal_wallets` 的周期绑定。无更早检查点且无零余额起点 → 保持 `unknown`，不恢复计算资格。

**confidence 定义**（**仅分析字段**，不用于参与资格判定）：

| 值 | 条件 |
|---|---|
| 1.0 | 零余额起点已确认（检查点 / 完整重建），且期间无采集缺口 |
| 0.5 | 无零余额起点，但周期内买卖覆盖连续（期初余额未知） |
| 0.3 | 存在未修复采集缺口，或仅观测到卖出 |
| unknown | 期初余额无法核验且无任何检查点 |

### 7.4 推送前校验（防追高，核心）

候选信号分两层校验，全部通过才推送。**校验在触发瞬间立即执行，不做任何等待**——等待会放大追高（毕业中位时间仅 4.4 分钟，延迟 3 分钟可能吃掉大部分行情）。

**第一层：钱包层校验（纯本地，无 API 调用）**

```
候选信号（关联合并后计票数 ≥3，触发瞬间校验）
 ├─ 0. 数据完整性门禁：涉及的来源存在未修复缺口 → 暂缓推送（有限重试）；缺口修复后重新校验
 ├─ 1. 剔除"快进快出"钱包：**当前周期**首笔买入后 3 分钟内已卖出 ≥50%（占周期买入量）→ 不计票
 │      买入不足 3 分钟且尚未卖出的钱包无法判定，正常计票；
 │      其后续卖出由推送后退出监控兜底
 ├─ 2. 剔除已清仓钱包（周期已关闭）→ 不计票
 ├─ 3. 剔除命中 walletFilter 的钱包（scammer 标签 / 钱包年龄 <7 天 / 无本地买入记录 / 画像补拉失败）→ 不计票
 ├─ 4. 有效票数 < minValidWallets(3) → 信号失效（status=invalidated）
 ├─ 5. requireOpenAction：有效票中至少 1 个钱包的**当前周期首笔买入在窗口内**（action=open；簇内任一钱包满足即算）→ 不满足则失效
 ├─ 6. requireAtLeastOneSmartMoney：至少 1 票来自 smartmoney（簇内任一钱包满足即算）→ 不满足则失效
 ├─ 7. 窗口净流入（口径见 §7.1，含全部大小额买卖）≥ netInflowUsd.min(500) → 不满足则失效
 └─ 8. 可核验性门槛：有效票中 `state=open` 且 `cost_complete=1` 的钱包数
        < minVerifiableWallets(2) → 暂缓推送（有限重试）；窗口过期仍不足 → expired
        通过后计算持仓保留率 = Σ(周期买入量 − 周期卖出量) / Σ(周期买入量)
        （仅汇总上述可核验钱包，当前周期口径）
        < 60% → 信号失效（status=invalidated）
        ※ 数量口径，与价格涨跌无关：测的是"卖没卖"，不是"浮盈浮亏"
```

> 边界说明：快进快出只能回溯"已发生"的卖出；买入不足 3 分钟就砸盘的钱包无法提前识别，这正是推送后退出监控存在的意义。若未来回测证明短暂确认延迟（如 30s）有正收益，再作为可选配置引入，默认 0。

**第二层：代币层校验（需要富化，价格新鲜度 ≤60s）**

```
 ├─ 9. 富化 token（info/security/pool）：单次校验内失败重试 1 次；
 │      仍失败 → 本轮标记 suppressed_enrich_failed，候选按 §7.1 退避重验
 ├─ 10. 硬过滤（阈值见 config.tokenFilter）：holder / 市值 / 年龄（按本次评估时间计算）/
 │      流动性 / top10 / bundler / insider / entrapment / bot degen / sniper /
 │      fresh wallet / dev / honeypot（SOL 恒通过）/ 增发与冻结权限
 │      不通过 → 不推（status=invalidated）
 └─ 11. 追高校验：均价 = Σ(周期∩窗口买入 USD) / Σ(周期∩窗口买入数量)，只取成本完整钱包
        — 均价不可计算（分母为 0 / 覆盖不足）→ 暂缓推送，重试仍不可计算 → expired
        — 价格比 = 现价 / 均价
          > 1.5x → 通过但消息顶部加"⚠️ 已上涨XX%，追高风险"
          > 2.0x → 不推（status=blocked_price）
```

- 加权平均入场价 = Σ(周期∩窗口买入 USD) / Σ(周期∩窗口买入数量)，只统计有效票**成本完整**钱包
- **发送前复核按任务类型区分**：
  - `kind=signal`（新信号）：执行完整入选校验（有效票 / 可核验性 / 保留率 / 价格 / 新鲜度），距最近一次校验通过超过 `signalTtlSeconds`（默认 90s）则重新评估或取消
  - `kind=escalate`（升级 / 降级）：按当前状态更新内容，**不因跌破门槛取消**；跌破门槛时渲染"共识减弱"
  - `kind=exit_alert`（退出提醒）：只核验绑定周期确实退出；**不因票数不足、保留率过低或缺少最新价格而取消**
- **缓存期限**：价格 60s、流动性/风险指标 5min、基础资料 30min；各类缓存独立记录更新时间（`price_updated_at` / `risk_updated_at` / `basic_updated_at`），互不覆盖；风控字段不使用过期缓存
- **按 token 串行处理**状态变化，防止旧校验结果覆盖新状态
- 所有被丢弃的候选仍写入 `signals` 表（status 区分原因）并追加 `signal_evaluations`，便于回测验证拦截是否正确

**缺失值决策表**（按已启用过滤逐项执行；未启用的过滤不阻塞）：

| 过滤项 | 依赖字段 | 缺失时行为 |
|---|---|---|
| `holderCount` | `holder_count` | 暂缓推送，有限重试；仍缺失 → `suppressed_enrich_failed` |
| `marketCapUsd` | `market_cap` | 同上 |
| `ageMinutes` | `created_at` | 同上 |
| `liquidityUsd` | `liquidity` | 同上 |
| `maxTop10HolderRate` | `top_10_holder_rate` | 同上 |
| `maxBundlerRate` | `stat.top_bundler_trader_percentage` | 同上 |
| `maxInsiderRate` | `stat.top_rat_trader_percentage` | 同上 |
| `maxEntrapmentRate` | `stat.top_entrapment_trader_percentage` | 同上 |
| `maxBotDegenRate` | `stat.bot_degen_rate` | 同上 |
| `maxSniperCount` | `wallet_tags_stat.sniper_wallets` | 同上 |
| `requireRenouncedMint` | `renounced_mint` | 缺失或非 true → 暂缓，重试仍不满足 → `suppressed_enrich_failed` |
| `requireRenouncedFreeze` | `renounced_freeze_account` | 同上 |
| `maxFreshWalletRate` | `stat.fresh_wallet_rate` | 同上 |
| `maxDevTeamHoldRate` | `stat.dev_team_hold_rate` | 同上 |
| `excludeHoneypot` | `honeypot` | SOL 恒通过；EVM 缺失时同上 |
| `requireSocial`（默认关） | 社交字段（`link.*`） | 仅展示；启用时缺失 → 暂缓 |
| 代币当前价 | `price` | 暂缓推送，有限重试；仍缺失 → `suppressed_enrich_failed` |
| 单笔数量 / decimals | `raw_amount` / `raw_decimals` | 对应持仓周期标 `incomplete`（§6.1），不阻塞信号 |
| 展示字段（logo / 名称等） | — | 允许缺失，不阻塞推送 |

缺口新增或扩大时，即在同一采集事务内批量撤销周期起点不晚于缺口末端（或起点未知）的开放/未知/不完整持仓的成本完整性，并持久化 `gap_affected:<token>:<wallet>` 及跨来源最大缺口末端时间。范围未变的健康更新不再逐钱包重复撤销；缺口期间新到成交仍沿用保守标记规则。10 分钟超时只解除新信号的完整性门禁，不恢复已有持仓资格；仅重排当前数据库中的成交也不能证明缺失成交已补齐。缺口后的可靠零余额/成本完整检查点可作为重建恢复依据；仍有活跃缺口时不恢复。

### 7.5 首次信号与后续状态

- 首次满足全部规则且通过发送前复核即发布；首次消息、发送时间、消息 ID 和发送快照保持不变，禁止编辑。
- 同一代币已发布信号在24小时内承接后续状态，全部提示独立回复首次消息。原30分钟编辑截止参数仅兼容旧配置，不控制新通知。
- 后续区分共识增强、达到强共识、共识减弱、恢复、风险失效和数据暂不可核验；普通价格波动不标为增强。
- 任务修订号用于丢弃过时排队项；与成员加入版本独立。评估最小通知间隔30秒，按上次成功发布状态去重。
- 增强提示发送前重新核验；已有清仓事件时，合并到退出提示并取消冲突的增强排队项。
- 全局上限10条/分钟由首次信号和状态提示共享；退出状态优先。
- 暂停会停止首次信号和常规状态提示，退出及数据更正继续。

### 7.6 推送后退出监控

- 监控对象为信号绑定的成员集合：`signal_wallets(signal_id, wallet, cycle_no, cluster_id, joined_version)`
- **周期绑定**：每个成员绑定加入时的 `cycle_no`；该周期关闭后不被后续新周期覆盖（钱包清仓后重新买入 = 新周期，与原信号无关）
- 重建按成员的 `joined_event_id` 对应成交恢复周期归属，同一旧周期拆分后允许不同信号映射到不同周期。旧记录缺少成交依据时，首次成员使用信号触发时间、升级成员使用对应版本任务创建时间恢复；时间或成交不可恢复则保留原绑定并记录告警，不猜测最新周期。检查点保存真实周期起点及最后买卖时间，旧检查点优先沿用重建前未受影响的周期起点。
- **簇退出**：簇内全部有效成员**绑定的周期**清仓才算该票退出（部分成员退出记为"减弱"，仅更新 `holding_state_now`）
- 两类退出任务在实际发送前再次检查配置、监控期限和最新清仓条件；条件已失效则取消，后续再次满足时允许重新排队。
- 推送后保留率使用固定成员集合计算；已清仓成员的剩余量按 0 计，**不得剔除成员**（剔除会让保留率反而升高）
- `postPushExitAlert`：**信号共识簇**完整退出（阈值 1 个簇）→ 回复原信号消息发送"🔴 退出提醒"
- `exitAlerts`：**非共识簇**（信号未包含的簇）≥2 个完整退出时触发，作为补充退出信号
- **去重**：按信号、持仓周期与清仓事件去重，成功送达后确认。同一轮共识簇与其他簇退出合并为一条；后续新清仓仍可提醒。清仓时间早于首次发送/成员加入或无法核验时，标为历史数据更正。
- **监控终止**：token 年龄 >24h 或确认送达后24h；期间保留重建纠正后的再次核验。

---

## 8. 筛选配置（config.jsonc）

当前实现会在启动时拒绝未支持的配置：`prePushRecheck`、`dropFullyExitedWallets` 固定为 `true`，`maxHops` 固定为 `1`；入口 `sides` 仅支持 `buy`，`actions` 支持 `open`、`add`（可选其中一种）；两类退出提醒的 `actions` 仅支持 `close`。`clusterMerge=false` 会同时关闭同资金来源和同交易合并。`walletCount.max`、净流入上下限和 `minObservedBuys` 实际参与校验，范围的 `null` 表示不设该边界。静默时间必须是合法的 24 小时时刻。


```jsonc
{
  "chain": "sol",

  "signal": {
    "windowMinutes": 15,              // 研究建议 15~30min
    "minDistinctWallets": 3,          // 关联合并后计票
    "strongWallets": 5,               // ≥5 标强信号，静默时段放行
    "requireOpenAction": true,        // 有效票中至少 1 个 action=open（建仓）
    "requireAtLeastOneSmartMoney": true, // 纯 KOL 共识不推（KOL ≠ alpha）
    "cooldownMinutes": 30,
    "clusterMerge": true
  },

  "tradeFilter": {
    "sides": ["buy"],                 // 仅买入触发信号；卖出全量入库用于持仓跟踪与退出监控
    "actions": ["open", "add"],       // 计入共识的买入行为（open=建仓，add=加仓）
    "minTradeAmountUsd": 50,          // 仅用于买入计票资格；净流入不设金额门槛
    "netInflowUsd": { "min": 500, "max": null },  // 窗口净流入（全部买卖，Σ买入−Σ卖出）
    "walletCount": { "max": null }    // 计票数上限；下限由 signal.minDistinctWallets 控制
  },

  "signalValidation": {
    "prePushRecheck": true,
    "fastFlipMinutes": 3,             // 回溯判定（不等待）：首次买入后 3min 内已卖出 ≥50% 或清仓 → 剔除
    "fastFlipSellRatio": 0.5,
    "dropFullyExitedWallets": true,
    "minValidWallets": 3,             // 钱包层校验后的推送下限（触发阈值见 signal.minDistinctWallets）
    "minVerifiableWallets": 2,        // 有效票中必须具备可核验持仓/成本的钱包数下限
    "minConsensusHoldingRatio": 0.6,  // 数量口径持仓保留率（当前持仓周期）
    "positionDustRatio": 0.01,        // 余量/周期买入量低于此值视为清仓
    "signalTtlSeconds": 90,           // 最近一次校验通过到实际发送的最长有效期，超期重评估
    "warnPriceAboveEntry": 1.5,       // 现价/均价 >1.5x → 警告
    "blockPriceAboveEntry": 2.0,      // >2.0x → 拦截
    "postPushExitAlert": {
      "enabled": true,
      "actions": ["close"],
      "minWallets": 1                 // 1 个簇完整退出即提醒
    }
  },

  "tokenFilter": {
    "ageMinutes":      { "min": 5, "max": 360 },
    "marketCapUsd":    { "min": 15000, "max": 200000 },
    "holderCount":     { "min": 100, "max": null },
    "liquidityUsd":    { "min": 10000, "max": null },
    "maxTop10HolderRate": 0.35,
    "maxBundlerRate": 0.30,
    "maxInsiderRate": 0.30,
    "maxEntrapmentRate": 0.30,
    "maxBotDegenRate": 0.30,
    "maxSniperCount": 20,
    "maxFreshWalletRate": 0.30,
    "maxDevTeamHoldRate": 0.10,
    "excludeHoneypot": true,
    "requireRenouncedMint": true,     // SOL：增发权限必须已放弃
    "requireRenouncedFreeze": true,   // SOL：冻结权限必须已放弃
    "requireSocial": false            // 有 TG/X 在消息里标徽章，不硬卡
  },

  "walletFilter": {
    "excludeTags": ["scammer"],
    "minWalletAgeDays": 7,
    "minObservedBuys": 1,             // 本地观测到的买入次数下限（排除只卖不买的出货钱包）
    "cluster": {
      "sameFunder": true,
      "creationTimeDeltaMinutes": 60,
      "maxHops": 1,                   // GMGN 数据仅支持 1 跳；多跳需 RPC（M4 可选）
      "excludeFunderLabels": ["cex", "bridge", "service"]
    }
  },

  "exitAlerts": {                     // 非共识簇 ≥2 个完整退出时补充提醒（M3+）
    "enabled": true,
    "actions": ["close"],
    "minWallets": 2
  },

  "polling": {
    "smartmoney": { "intervalMs": 1500, "limit": 100 },
    "kol":        { "intervalMs": 3000, "limit": 100 },
    "followWallet": { "intervalMs": 3000, "limit": 100 }
  },

  "push": {
    "language": "zh",
    "maxPerMinute": 10,
    "editThrottleSec": 30,
    "stopEditAfterMinutes": 30,  // 旧版兼容；首次消息不编辑，状态跟踪24小时
    "links": ["gmgn", "photon", "trojan", "bullx"],  // 消息底部链接平台
    "buyButton": "photon",                           // 一键买入按钮平台
    "quietHours": { "start": "02:00", "end": "08:00", "minWallets": 5 }
  },

  "retention": { "tradesDays": 30 }
}
```

**阈值职责说明**（避免调参漂移）：

- `signal.minDistinctWallets`：触发阈值（关联合并后的计票数，校验前）
- `tradeFilter.walletCount.max`：计票数上限过滤（下限同 `signal.minDistinctWallets`）
- `signalValidation.minValidWallets`：钱包层校验剔除后的推送下限（票数）
- `tradeFilter.actions` 决定哪些行为计票；`signal.requireOpenAction` 要求有效票中至少 1 个建仓

**阈值调整原则**：所有值都可通过回测闭环（M4）按实际数据调整。研究明确指出公开数据不足以确定 5min/30min/1h 分桶的最优值，初始配置是起点而非终点。

**待验证策略假设**（初始阈值是假设，不是结论；回测按此表验证）：

| 阈值 | 验证数据 | 通过标准（示例） |
|---|---|---|
| `windowMinutes: 15` | 2 周信号按窗口分桶 | 15min 桶的 1h 价格变化中位数 > 5min/30min 桶 |
| `minDistinctWallets: 3` | 按票数分桶 | ≥3 票显著优于 2 票；3 票与 4+ 票差距可接受 |
| `minTradeAmountUsd: 50` | 单笔金额分桶 | 比较不同小额过滤门槛下的信号表现 |
| `ageMinutes: 5~360` | 年龄分桶 | 5~60min 桶最好；>6h 桶无 alpha 则收紧 |
| `marketCapUsd: 15K~200K` | 市值分桶 | 区间内表现显著优于区间外 |
| `maxEntrapmentRate` / `maxBotDegenRate` | 按诱捕/机器人占比分桶 | 高占比组表现显著更差则收紧 |
| `warn/blockPriceAboveEntry` | 按价格比分桶 | 1.5x 以上组表现转负则收紧 |
| `minConsensusHoldingRatio: 0.6` | 按保留率分桶 | <60% 组显著更差 |

所有"通过标准"先看价格变化与样本覆盖率；对照数据缺失时报告"无法验证"（§10）；在明确进出场与成本模型之前，不报告策略胜率。

---

## 9. Telegram 推送设计

### 9.1 信号消息模板

**隐私原则：不展示任何钱包地址、X 账号等身份信息；钱包只按来源聚合展示。**

**来源分项互斥规则**：总票数始终按簇去重；分项按互斥组合展示（如"仅 Smart Money" / "Smart Money＋KOL" / "仅自选"），保证分项合计 = 总票数。钱包内部完整标签只入库，不展示。

普通共识（3~4 票）：

```
🟢 共识信号 #2N9C
$PEPE2 · Pump.fun · 22 分钟
━━━━━━━━━━━━━━━━━━
市值 $180K · 流动性 $42K · 持有人 1,240

👥 15 分钟共识：4 票
🟡 仅 Smart Money ×2 · $5,200（建仓×2）
🟡🟠 Smart Money＋KOL ×1 · $3,000（建仓）
⭐ 仅自选 ×1 · $3,000（建仓）
💰 合计买入 $11,200 · 净流入 +$9,800
📊 持仓保留 82% · 现价 $0.00025 / 均价 $0.00021（+18%）
ℹ️ 部分持仓未经余额核验
🛡 Rug 0.05 · Top10 18% · Bundler 6% · Insider 3% · 无 Wash · Dev 已清仓
🌐 TG · X

`AbC...xYz`
🔗 GMGN · Photon · Trojan · BullX
━━━━━━━━━━━━━━━━━━
⚠️ 信号仅供参考，非投资建议
```

追高警告变体（价格比 >1.5x，插在标题下方）：

```
🟢 共识信号 #2N9C
⚠️ 已较共识均价上涨 62%，追高风险
$PEPE2 · Pump.fun · 22 分钟
...
```

- 强共识（≥5 票）：标题改为 `🟢 强共识信号 #2N9C`
- 标签：🟡 Smart Money / 🟠 KOL / ⭐ 自选；括号内为建仓/加仓构成（`requireOpenAction` 保证至少 1 个建仓）
- 数据质量提示：存在 `state=unknown/incomplete` 钱包时追加 `ℹ️ 部分持仓未经余额核验`；该提示不替代 §7.4 的可核验性门槛
- 指标口径：`持仓保留` 为数量口径（当前周期，卖没卖与浮盈浮亏无关）；`均价` 为有效票钱包窗口内加权平均入场价
- 代币 CA 独立成行并渲染为 code 块（点击复制），不用截断
- 信号 ID：`#{id.toString(36).toUpperCase()}`（如 id=123456 → `#2N9C`）
- 链接平台与买入按钮在 config `push.links` / `push.buyButton` 配置

**Inline 按钮**：

| 按钮 | 行为 |
|---|---|
| 📈 图表 | 打开 GMGN 该代币页面 |
| ⚡ 一键买入 | 跳转 GMGN |
| 🔁 刷新 | 机器人私聊中查看状态；不编辑首次信号 |
| 🔕 屏蔽该币 | 等价 `/mute <CA>` |

### 9.2 状态提示（独立回复首次消息）

```text
🔔 达到强共识 #2N9C
有效票数：3 → 5
持仓保留率：80% → 85%
原因：达到强共识
评估时间：2026-09-21 15:00:00 UTC
本提示关联首次信号；原始消息保持不变。
```

只展示变化前后、原因和时间，不重复整张信号卡片；已发布原消息不再编辑。

### 9.3 退出提醒（回复原消息）

```
🔴 退出提醒 #2N9C
$PEPE2 · Pump.fun · 47 分钟
━━━━━━━━━━━━━━━━━━
2 个簇完整清仓（🟡 仅 Smart Money ×1 · 🟠 仅 KOL ×1）
📊 持仓保留 38% · 现价 $0.00031 / 均价 $0.00021（+48%）
⚠️ 共识正在瓦解，注意风险
```

- 独立消息回复原信号（编辑不触发通知，§7.6）

### 9.4 命令

| 命令 | 说明 |
|---|---|
| `/status` | poller 心跳、限频余量、今日信号数、待处理队列 |
| `/pause` / `/resume` | 暂停 / 恢复推送 |
| `/mute <CA> [时长]` | 屏蔽指定代币（省略时长 = 永久） |
| `/unmute <CA>` | 解除屏蔽 |
| `/config` | 显示当前生效阈值（只读） |
| `/stats` | 信号表现与分组统计（M4；未含成本模型前不报胜率） |
| `/wallets` | 显示 follow 列表（只读，M4） |
| `/test` | 发送一条测试消息 |

**权限与状态语义**：

- 命令与 inline 按钮回调**统一鉴权**：仅 `TG_ADMIN_IDS` 可执行
- 改变全局状态的操作（屏蔽/解除屏蔽、暂停、刷新）仅管理员可用；刷新按钮做节流（如每 token 30s 一次）
- `/pause` 只暂停**新信号推送**；采集、持仓跟踪、已推送信号的退出提醒、运维告警**继续运行**

### 9.5 推送可靠性

**持久化发送任务（`push_tasks`）状态机**：

| 状态 | 含义 | 处理 |
|---|---|---|
| pending | 待发送 | 后台任务领取 |
| sending | 发送中 | 超时（如 10s）视为 unknown |
| sent | 已确认送达 | 按任务类型回调（见下） |
| unknown | 结果不确定（超时/进程退出） | 有限重试（最多 2 次）；候选过期后不再重试 |
| failed | 明确失败（API 返回错误） | 指数退避重试至 `max_attempts`；`next_retry_at` 持久化；候选过期后不再重试 |
| cancelled | 已取消（候选过期，未发出） | 终态：不发送、不重试 |

- 校验通过时**原子创建发送任务**，`dedupe_key` 规则：
  - `kind=signal`：`signal_id + signal`（防重复首次推送）
  - `kind=escalate`：`signal_id + escalate + revision`（每次消息修订一个任务）
  - `kind=exit_alert`：`signal_id + exit + alert_type`（不含版本，同类型退出只提醒一次）
- **发送成功回调按任务类型区分**：
  - `kind=signal`（首次）：写 `signals.tg_message_id` / `price_at_send` / `sent_at`，状态置 `pushed`，冷却起算
  - `kind=escalate`：只更新该任务记录与消息内容，**不改动**原信号的 `tg_message_id` / `sent_at` / `price_at_send` / 冷却
  - `kind=exit_alert`：只更新该任务记录；退出提醒为独立消息，不覆盖原信号消息 ID
- **不承诺绝对不重复**：结果不确定时宁可重发（带稳定信号 ID）也不漏发
- **任务取消（终态 `cancelled`）**：候选过期时**原子取消**该信号 `kind=signal` 的未发出任务（`pending` / 等待重试的 `unknown` / `failed`），禁止后续重发；已在途的 `sending` 接收最终结果——确认送达则正常回调 `pushed`，超时/失败后不再重试，置 `cancelled`
- 进程重启恢复：扫描 `pending / sending / unknown` 以及**仍可重试的 `failed`**（`attempts < max_attempts` 且 `next_retry_at` 已到），再检查对应候选是否已过期——已过期则取消，不重新入队
- 优先级：退出提醒 > 新信号/升级；退出提醒不占新信号限流额度
- 超限信号进入持久化队列逐条发送，发送前按 `signalTtlSeconds` 重验，过期则置任务 `cancelled` 并记录
- **第一版不实现汇总消息**（多条信号关联、编辑与回复规则复杂）；`push_tasks.kind` 的 `summary` 枚举保留但不用
- 3 轮仍失败 → 管理员私聊告警（`TG_ADMIN_IDS`），任务保留可人工补发

---

## 10. 回测与评估闭环（数据记录 M1 起，统计分析 M4）

> 2026-09-14 整改：[宽范围研究与回放](RESEARCH-REMEDIATION.md)。开发阶段按独立样本数量与质量准入，无最短天数门槛；原有时间跨度描述不再作为开发准入条件。

**数据准备（M1/M2 起）**

- 评估所需数据从 M1 开始保留，不等 M4：`signal_evaluations` 不可变追加（配置版本、规则版本、输入快照、失败原因、触发时间、发送时间）
- 实时 `trades` 表滚动清理；回放所需数据另行压缩归档（按天导出，含事件键与原始响应）
- 同一候选的历史校验过程可完整还原（为什么被拦截、当时输入是什么）

**评估规则（M4）**

- 分别记录**触发价格**（首次校验时）与**发送价格**（确认送达时）及各自时间（`price_at_trigger` / `price_at_send` / `sent_at`）
- 已推送信号以**发送时点**为基准评估；被拦截/失效候选以**评估时点**为基准评估
- K 线选取：**收盘时间不晚于目标时点的最近一根已完成 K 线**；按分辨率设置允许偏差：
  - 5m 目标 → 1m 蜡烛，偏差 ≤2 分钟
  - 1h 目标 → 1m/5m 蜡烛，偏差 ≤5 分钟
  - 24h 目标 → 1h 蜡烛，偏差 ≤60 分钟（需要更高精度时改用 5m 蜡烛，收紧到 ≤5 分钟）
- `market kline` 的 `from` / `to` 为**毫秒**（M1-6 实测；用秒会返回空数组）
- 记录实际取价时间与偏差；超过对应容差 → 标记缺行情
- 不同分辨率/容差的结果在统计中分开报告，不混用
- 缺行情样本单独统计，不参与收益率计算（报告覆盖率）
- 被拦截/失效的候选同样评估价格走势，验证拦截规则是否正确
- **对照组**：对未达到触发门槛的 token 采样记录（如对达到 2 票的候选按固定间隔采样），或明确完整离线重放方案；对照组与信号组使用同一时间段与数据覆盖标准
- 缺少对照组数据时，假设验证报告"无法验证"，不得据此调整阈值
- **先报告价格变化与覆盖率**；在明确进出场规则与成本模型（手续费、滑点、gas）之前，不报告策略胜率
- 分组统计维度：信号来源组合、票数、代币年龄、市值区间、是否触发追高警告
- 输出：`/stats` 命令 + 每日报告
- 目标：独立样本数量及质量达标后验证 §8 假设，不设置最短运行天数

---

## 11. 里程碑与验收

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| **M1 采集与存储** | 项目骨架、vendored GMGN client（含 MIT 署名）、Token Bucket、三个 poller（**含 Ed25519 签名与 follow-wallet**，无私钥时该源禁用）、事件去重键验证、token 富化字段映射验证（§6.2）、`source_health` 缺口跟踪、SQLite schema、评估记录（`signal_evaluations`）、配置加载、DRY_RUN | 默认必测：连续运行 30min、事件去重正确、字段路径/类型/单位逐项验证通过、限流器单测、模拟 429/封禁恢复（共享预算 / 封禁期零请求 / 恢复后回补）、DRY_RUN；配置凭证后必测：follow-wallet 签名通过且数据入库 |
| **M2 信号引擎** | 候选状态机（含重验/过期规则）、窗口聚合、持仓周期跟踪、关联钱包合并（1 跳）、画像按需补拉与重新聚类、迟到事件重放与周期重建、两层推送前校验、数据完整性门禁 | 固定输入回放：同交易多事件、跨来源重复、清仓后重买、卖出先到、分页重复、窗口过期、画像补拉后重聚类、同 tx 多钱包合并、迟到事件回补后周期重建；输出与预期一致（周期划分与 `signal_wallets` 绑定正确，非仅成交总数） |
| **M3 推送** | grammY 推送、`push_tasks` 发送状态机、消息模板、状态提示去重、更新复核、退出监控、命令与回调鉴权 | 测试群收到信号/升级/退出提醒；模拟发送超时→unknown→有限重试；独立引用和状态去重生效；按钮权限与 `/pause` 语义符合 §9.4 |
| **M4 回测与统计** | kline 回测、`/stats`、分组统计、假设验证报告、（可选）RPC 多跳资金来源 | 回放数据完整可还原拦截原因；价格变化与覆盖率报告可查；按 §8 假设表输出验证结果 |
| **M5 部署运维** | Docker、日志、告警、备份、故障演练 | 断网 / 429 封禁 / 进程重启（含发送中任务恢复）三个演练通过；告警送达运维频道 |

---

## 12. 部署与运维

### 12.1 VPS 预检

```bash
node -v                                                             # >= 22.19.0
curl -4 ip.me                                                       # 必须返回 IPv4
curl -s -o /dev/null -w "%{http_code}" https://api.telegram.org     # 200/302
```

### 12.2 环境变量（.env，权限 600）

```env
GMGN_API_KEY=
GMGN_PRIVATE_KEY=        # M1 起可选（follow-wallet 签名需要；无私钥该源禁用）
TG_BOT_TOKEN=
TG_CHAT_ID=
TG_ADMIN_IDS=            # 命令白名单，逗号分隔
TG_ALERT_CHAT_ID=        # 旧版兼容，不用于管理消息路由
DRY_RUN=0                # 1=只打印不推送
# 可选逃生通道
# GMGN_PROXY=http://127.0.0.1:7890  # 支持 HTTP/HTTPS 代理，不支持 SOCKS
```

### 12.3 运行

- Docker + `restart: unless-stopped`；单容器，SQLite 挂载卷
- 时区 UTC；日志输出 JSON 便于检索
- SQLite 每日备份（`VACUUM INTO` 或文件快照）到独立目录/对象存储

### 12.4 告警（推送至运维频道）

- poller 心跳丢失 >60s
- 连续 429 / 进入封禁
- Telegram 发送连续失败
- `push_tasks` 中 unknown 状态堆积（超过阈值）
- 单次轮询返回打满 limit（可能漏数据）

---

## 13. 风险与局限（必须对用户明示）

1. **跟单机械损耗**：模型筛选样本中聪明钱 14%/币 vs 跟单者 3%/币，信号不保证收益
2. **共同买入信号效应弱**：学术上对净流入的因果效应不显著，多数"共识"可能已被消化或是协同机器人
3. **冷启动盲区**：本地持仓跟踪在观察初期不完整，建仓/清仓判断可能有误
4. **CEX 合并风险**：资金来源聚类依赖人工维护的 CEX 黑名单，漏维护会误合并
5. **API 依赖**：GMGN OpenAPI 无 HA 承诺、可能随时变更、仅 IPv4、限频按套餐分档
6. **追高风险只能缓解不能消除**：15 分钟窗口 + 校验与富化的处理耗时天然滞后（无人工等待）
7. **不是投资建议**：每条推送固定附免责声明

---

## 14. 开工前检查清单

- [ ] GMGN API Key 已申请，**Ed25519 私钥文件仍在**（M1 签名与 follow-wallet 需要；丢失需重新申请）
- [ ] 自选钱包已在 gmgn.ai 网站上关注（follow-wallet 数据来源）
- [ ] Telegram Bot Token（@BotFather）与目标频道/群 chat id
- [ ] VPS 三条预检命令通过
- [ ] 确认出站为 IPv4（GMGN 不支持 IPv6）

---

## 附录 A：GMGN 端点字段速查

### track smartmoney / kol 返回字段（关键）

| 字段 | 说明 |
|---|---|
| `transaction_hash` | 事件键组成部分（候选键见 §5.2，M1 验证） |
| `maker` | 钱包地址 |
| `side` | buy / sell |
| `base_address` | 代币地址 |
| `base_token.symbol` | 代币符号 |
| `amount_usd` | 成交额（USD） |
| `token_amount` | 代币数量 |
| `price_usd` | 成交时价格 |
| `is_open_or_close` | 0=开/加，1=平/减（kol/smartmoney 语义） |
| `timestamp` | unix 秒 |
| `maker_info.tags` | 钱包标签（如 `["smart_degen"]`） |
| `maker_info.twitter_username` | KOL 的 X 账号 |

### follow-wallet 额外字段

| 字段 | 说明 |
|---|---|
| `next_page_token` | 分页 cursor（可回补历史） |
| `base_amount` / `quote_amount` | 个人 Key 实测为可读数量，不作 decimals 换算（§6.1） |
| `amount_usd` | 成交额（USD） |
| `price_now` / `price_change` | 当前价 / 相对成交时倍数 |
| `is_open_or_close` | 1=全开/全平，0=部分（语义与上面相反） |
| `balance_info` | 钱包余额信息（可能为 null） |
| `maker_info.tag_rank` | 标签内排名 |

### token 富化字段（趋势/trenches/token info）

> 字段来源以 **§6.2 映射表**为准（不同端点契约不同）；本节仅为速查。

| 字段 | 用途 |
|---|---|
| `holder_count` | holder 下限过滤 |
| `market_cap`（token info 需计算 `price.price × circulating_supply`；trending 直接返回） | 市值区间过滤 |
| `liquidity` | 流动性过滤 |
| `top_10_holder_rate` | 集中度过滤 |
| `stat.top_bundler_trader_percentage`（token info） | bundler 过滤 |
| `stat.top_rat_trader_percentage`（token info） | insider 过滤 |
| `stat.top_entrapment_trader_percentage`（token info） | entrapment 过滤 |
| `stat.bot_degen_rate`（token info） | bot / wash 代理过滤 |
| `wallet_tags_stat.sniper_wallets`（token info） | sniper 过滤 |
| `stat.fresh_wallet_rate`（token info） | 新钱包过滤 |
| `stat.dev_team_hold_rate` / `dev.creator_token_status`（token info） | dev 状态过滤 |
| `honeypot`（token security，SOL 恒 0） | 风险硬拒 |
| `rug_ratio` / `is_wash_trading` | **仅 trending / trenches 提供，富化路径不可得** |
| `renounced_mint` / `renounced_freeze_account`（token security） | SOL 权限检查 |
| `link.twitter_username` / `link.telegram` / `link.website` | 社交徽章 |

## 附录 B：研究来源清单

- arXiv:2607.02823 — pump.fun graduation regime windows — https://arxiv.org/abs/2607.02823
- arXiv:2602.14860 — Predicting token success (Marino et al.) — https://arxiv.org/abs/2602.14860
- arXiv:2602.13480 — MELT: bundler / coordinated accounts — https://arxiv.org/abs/2602.13480
- arXiv:2609.10246 — Meme Coin Factories (CCS'26) — https://arxiv.org/abs/2609.10246
- arXiv:2601.08641 — Resisting manipulative bots / imitation penalty (WWW'26) — https://arxiv.org/abs/2601.08641
- arXiv:2607.02795 — Coordinated sniper cohorts — https://arxiv.org/abs/2607.02795
- arXiv:2608.20271 — Catching the Rug — https://arxiv.org/abs/2608.20271
- Solidus Labs 2025 Rug Pull Report — https://www.soliduslabs.com/reports/solana-rug-pulls-pump-dumps-crypto-compliance
- CoinGecko pump.fun token lifespan research (2026-06) — https://www.coingecko.com/research/publications/average-lifespan-of-pumpfun-tokens
- GMGN 官方文档 — https://docs.gmgn.ai / https://github.com/GMGNAI/gmgn-skills

## 2026-09-21 消息路由与研究摘要

- 频道只接收首次信号及其增强、减弱、退出、失效、数据更正提示。全部后续消息引用首次消息，原消息永久不编辑。
- 运维告警、恢复通知、每日摘要仅发往 `TG_ADMIN_IDS` 的管理员私聊。旧 `TG_ALERT_CHAT_ID` 不再决定路由；无有效管理员或私发失败时记录错误，不回退到频道。
- 管理指令只允许授权管理员在私聊中使用；频道/群组按钮仅弹出私聊指引，不在频道发送管理回复。
- `/stats` 默认展示正式信号概览，详细统计按按钮查询；`/research` 默认展示当前配置、规则、研究版本的首次独立样本摘要，拦截/质量/参数/历史分页面按需读取。
- 未到期与缺行情分开显示；历史版本不混入当前准入统计。参数比较为只读诊断，不自动登记实验或修改生产阈值。
