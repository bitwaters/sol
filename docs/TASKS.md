# Meme 信号 Bot 任务计划

> 规范依据：[DEVELOPMENT.md](./DEVELOPMENT.md)（设计定稿）
> 状态：代码已实施，真实环境联调中 · 更新：2026-09-14

---

## 1. 现状摘要

2026-09-14 新增研究整改 T1–T10，任务、依赖后的实现和验收见 [RESEARCH-REMEDIATION.md](RESEARCH-REMEDIATION.md)。开发调参移除天数门槛，按独立样本数量与质量准入。

M1–M5 代码与自动化测试已实现。个人凭证签名、关注流入库、数量单位及逐钱包画像已补验；分页回补、最终版本连续 30 分钟运行、Telegram 测试群和 VPS 验收仍未全部完成。下表为原实施任务及依赖，不能据此认定上线门禁已通过；当前进展见 `DEBUG-2026-09-14.md`、`CONTRACT.md` 与 `GO-LIVE-CHECKLIST.md`。

**前置条件与阶段门禁**（本地初始化不阻塞；按门禁点准备即可）

| # | 事项 | 门禁点 |
|---|---|---|
| P1 | GMGN Ed25519 私钥（follow-wallet 签名） | M1-9（follow poller）与 M1-15 签名验收前 |
| P2 | gmgn.ai 关注自选钱包 | M1-9 前 |
| P3 | Telegram Bot Token / chat id / admin ids / 告警频道 | M3-1 前（M1/M2 本地开发不需要） |
| P4 | VPS 预检与测试环境 | M5-4 前（开发期不需要） |

## 2. 目标文件结构

```
meme/
├── package.json / tsconfig.json / config.jsonc / .env.example
├── Dockerfile / docker-compose.yml
├── data/cex-blacklist.json
├── docs/{DEVELOPMENT.md, TASKS.md}
├── src/
│   ├── index.ts / config.ts / logger.ts
│   ├── gmgn/{OpenApiClient.ts, signer.ts, types.ts}   # vendored, MIT
│   ├── ingest/{limiter.ts, normalize.ts, dedupe.ts, poller.ts,
│   │           health.ts, backfill.ts, archive.ts}
│   ├── signal/{positions.ts, cluster.ts, window.ts, candidate.ts,
│   │           validate-wallet.ts, validate-token.ts, state.ts, rebuild.ts}
│   ├── enrich/{token.ts, wallet.ts}
│   ├── telegram/{bot.ts, commands.ts, format.ts, pusher.ts, exit-monitor.ts}
│   ├── store/{db.ts, schema.sql, repo/}
│   ├── backtest/{evaluate.ts, control.ts, report.ts}
│   └── ops/{alerts.ts, backup.ts}
└── test/{fixtures/, replay/, *.test.ts}
```

---

## 3. 任务清单

### M1 采集与存储

| # | 任务 | 涉及文件 | 依赖 | 复杂度 |
|---|---|---|---|---|
| M1-1 | 项目初始化：ESM + TS + node≥22.19.0、依赖（grammY / better-sqlite3 / decimal.js / undici / dotenv / vitest）、npm scripts | `package.json`, `tsconfig.json` | — | S |
| M1-2 | 配置系统：`config.jsonc` 加载校验（按 §8 全量字段）、`.env` 读取、`config_version` 注入 | `src/config.ts`, `config.jsonc`, `.env.example` | M1-1 | S |
| M1-3 | 日志与入口：JSON 日志、DRY_RUN 分支、信号处理、poller 编排 | `src/logger.ts`, `src/index.ts` | M1-1 | S |
| M1-4 | vendor GMGN client：复制 `OpenApiClient.ts` + `signer.ts`（MIT 署名）、类型补全、demo key 冒烟 | `src/gmgn/*` | M1-1 | M |
| M1-5 | 限流器 + 429 退避：rate=20/capacity=20、按端点权重、`X-RateLimit-Reset`/`reset_at`、封禁零重试、恢复回补标记 | `src/ingest/limiter.ts` | M1-4 | M |
| **M1-6** | **接口契约验证**：用真实响应产出脱敏样本（`test/fixtures/`）、确定事件唯一键、逐项验证 track / token / portfolio 字段路径、类型与单位（§6.1/§6.2 及钱包画像字段），结论回写 DEVELOPMENT.md | `test/fixtures/*`, `docs/DEVELOPMENT.md` | M1-4, M1-5 | M |
| M1-7 | SQLite schema：12 张表 + 索引 + WAL | `src/store/db.ts`, `src/store/schema.sql` | M1-1 | M |
| M1-8 | 事件归一化与去重：按 M1-6 结论实现事件键、`trade_sources` 多来源、raw 原样字符串、decimal 换算、`action_hint` 归一化 | `src/ingest/normalize.ts`, `src/ingest/dedupe.ts` | M1-6, M1-7 | M |
| M1-9 | 三个 poller：smartmoney 1.5s/100、kol 3s/100、follow 3s/100（分页、无私钥禁用）、提频上限、心跳、`source_health` 水位/缺口 | `src/ingest/poller.ts`, `src/ingest/health.ts` | M1-5, M1-8 | L |
| M1-10 | 分页回补与缺口记录：`next_page_token` 翻页回补、原始事件入库、缺口区间记录、成交流水+来源观测事务一致性（**不含周期重建**） | `src/ingest/backfill.ts` | M1-9 | M |
| **M1-11** | **成交归档与保留清理**：按天压缩归档（含事件键与原始响应）、归档校验通过后才清理 `trades`（30 天滚动） | `src/ingest/archive.ts` | M1-7, M1-8 | M |
| M1-12 | token 富化：token info/security 调用、§6.2 字段映射、市值计算、分层缓存、缺失处理 | `src/enrich/token.ts` | M1-5, **M1-6**, M1-7 | M |
| M1-13 | 钱包画像：`portfolio stats` 逐地址调用、应用批次聚合、每日刷新 + 候选按需补拉、CEX 黑名单 | `src/enrich/wallet.ts`, `data/cex-blacklist.json` | M1-5, **M1-6**, M1-7 | M |
| M1-14 | 评估记录写入：`signal_evaluations` 不可变追加接口 | `src/store/repo/evaluations.ts` | M1-7 | S |
| M1-15 | M1 集成验收：限流器单测、429/封禁模拟（共享预算/零请求/回补）、30min 连续运行、follow-wallet 签名入库、归档→清理链路 | `test/*` | M1-9…M1-14 | M |

### M2 信号引擎

| # | 任务 | 涉及文件 | 依赖 | 复杂度 |
|---|---|---|---|---|
| M2-1 | 持仓周期跟踪：`cycle_no`、`cost_complete`、`state`、dust 阈值、`position_checkpoints`、零余额确认 | `src/signal/positions.ts` | M1-7, M1-8 | L |
| M2-2 | 关联钱包合并：union-find、同源+60min、CEX 排除、同 tx bundler、画像缺失规则、重新聚类 | `src/signal/cluster.ts` | M1-13 | M |
| M2-3 | 窗口聚合：15min 滚动、§7.1 指标口径表实现（计票/净流入/周期∩窗口均价/保留率） | `src/signal/window.ts` | M2-1 | M |
| M2-4 | 候选状态机：状态转换、重验事件、生命周期双条件、重新触发冷却、`signal_evaluations` 追加、按 token 串行 | `src/signal/candidate.ts` | M2-3, M1-14 | L |
| M2-5 | 钱包层校验：快进快出、清仓剔除、walletFilter、minValidWallets、requireOpenAction、requireSmartMoney、净流入、`cost_complete` 门槛+保留率 | `src/signal/validate-wallet.ts` | M2-2, M2-4 | L |
| M2-6 | 代币层校验：富化、硬过滤（含 SOL 权限）、缺失值决策表、追高（周期∩窗口均价） | `src/signal/validate-token.ts` | M1-12, M2-5 | M |
| M2-7 | 数据完整性门禁：source gap 检测 → 暂缓；修复后重校验 | `src/signal/candidate.ts` | M1-10, M2-4 | S |
| M2-8 | 推送前复核（按任务类型）+ `sending` 状态与 push_tasks 原子创建 | `src/signal/state.ts` | M2-6, **M2-7** | M |
| **M2-9** | **周期重建与重放**：迟到事件处理、检查点选择（严格早于最早受影响事件）、零余额起点重放、周期重建、重建期暂停、校正 `signal_wallets` 绑定 | `src/signal/rebuild.ts` | M2-1, M1-10 | L |
| M2-10 | M2 回放单测：主流程场景 + 边界场景（见 §6 验收对照） | `test/replay/*` | M2-1…M2-9 | L |

### M3 推送

| # | 任务 | 涉及文件 | 依赖 | 复杂度 |
|---|---|---|---|---|
| M3-1 | grammY bot：命令（/status /pause /resume /mute /unmute /config /test）、回调统一鉴权、/pause 语义 | `src/telegram/bot.ts`, `commands.ts` | M2-8 | M |
| M3-2 | push_tasks 执行器：状态机、dedupe_key、`max_attempts`/`next_retry_at`、`cancelled`、重启恢复、优先级与限流 | `src/telegram/pusher.ts` | M2-8 | L |
| M3-3 | 消息模板：signal / escalate / exit 三模板、互斥来源分项、质量提示、CA code 块、链接与按钮、免责声明 | `src/telegram/format.ts` | M3-1 | M |
| M3-4 | 冷却/编辑节流/消息修订：`message_revision`、最新修订检查、30s 节流、30min 停止编辑、跟进消息 | `src/telegram/pusher.ts` | M3-2, M3-3 | M |
| **M3-5** | **静默时段与推送节奏**：`quietHours` 过滤、强信号（≥strongWallets）放行、全局限流、超限队列延后（发送前重验） | `src/telegram/pusher.ts` | M3-2 | M |
| M3-6 | 退出监控：簇周期绑定、postPushExitAlert / exitAlerts、`signal_id+类型` 去重、监控终止、回复消息 | `src/telegram/exit-monitor.ts` | M3-2 | L |
| M3-7 | M3 验收：测试群三类消息、可靠性边界（见 §6 验收对照） | `test/*` | M3-1…M3-6 | M |

### M4 回测与统计

| # | 任务 | 涉及文件 | 依赖 | 复杂度 |
|---|---|---|---|---|
| M4-1 | kline 回测：`price_at_trigger`/`price_at_send`、已完成 K 线规则、按分辨率容差、缺行情统计、outcome 写入 | `src/backtest/evaluate.ts` | M1-12, M3-2 | M |
| M4-2 | 对照组采样：2 票候选定时采样 / 离线重放方案、同覆盖标准 | `src/backtest/control.ts` | M4-1 | M |
| M4-3 | /stats 与分组统计：来源组合/票数/年龄/市值/追高分组、覆盖率、"无法验证"标记 | `src/backtest/report.ts` | M4-1, M4-2 | M |
| **M4-4** | **/wallets 与每日报告**：follow 列表只读命令、每日报告生成与定时调度 | `src/telegram/commands.ts`, `src/backtest/report.ts` | M1-13, M4-3 | M |
| M4-5 | （可选）RPC 多跳资金来源 | `src/signal/cluster.ts` | M4-3 | L |
| M4-6 | M4 验收：回放可还原拦截原因、覆盖率报告、假设表输出、对照缺失时"无法验证" | `test/*` | M4-1…M4-4 | S |

### M5 部署运维

| # | 任务 | 涉及文件 | 依赖 | 复杂度 |
|---|---|---|---|---|
| M5-1 | Docker：多阶段构建、卷挂载、restart policy、UTC | `Dockerfile`, `docker-compose.yml` | M3-7 | S |
| M5-2 | 告警：心跳丢失、429/封禁、TG 失败、push_tasks unknown 堆积、limit 打满 | `src/ops/alerts.ts` | M3-2 | M |
| M5-3 | 数据库备份：每日 `VACUUM INTO`、恢复流程验证（归档已在 M1-11） | `src/ops/backup.ts` | M1-7 | M |
| **M5-4** | **测试环境部署**（可提前）：VPS 预检、部署、DRY_RUN/测试群模式 | `deploy/` | M5-1 | S |
| M5-5 | 故障演练：断网、429 封禁恢复、重启（含在途任务） | 演练脚本 | M5-1…M5-4 | M |
| **M5-6** | **正式启用推送**（上线门禁）：确认 M2-10 / M3-7 / M5-5 全部通过后开启正式群推送 | `deploy/`, 配置 | M2-10, M3-7, M5-5 | S |

---

## 4. 依赖关系（关键路径）

```
【M1 基础】
M1-1 ─→ M1-2 / M1-3 / M1-4 / M1-7
M1-4 ─→ M1-5 ─→ M1-6
【M1 采集与存储】
M1-6 + M1-7 ─→ M1-8
M1-5 + M1-8 ─→ M1-9 ─→ M1-10
M1-7 + M1-8 ─→ M1-11
M1-5 + M1-6 + M1-7 ─→ M1-12 / M1-13
M1-7 ─→ M1-14
M1-9…M1-14 ─→ M1-15
【M2 信号】
M1-7 + M1-8 ─→ M2-1
M2-1 ─→ M2-3
M2-3 + M1-14 ─→ M2-4
M1-13 ─→ M2-2
M2-2 + M2-4 ─→ M2-5
M1-12 + M2-5 ─→ M2-6
M1-10 + M2-4 ─→ M2-7
M2-6 + M2-7 ─→ M2-8
M2-1 + M1-10 ─→ M2-9
M2-1…M2-9 ─→ M2-10
【M3 推送】
M2-8 ─→ M3-1 / M3-2
M3-1 ─→ M3-3
M3-2 + M3-3 ─→ M3-4
M3-2 ─→ M3-5 / M3-6
M3-1…M3-6 ─→ M3-7
【M4 回测】
M1-12 + M3-2 ─→ M4-1 ─→ M4-2 ─→ M4-3
M1-13 + M4-3 ─→ M4-4
M4-3 ─→ M4-5
M4-1…M4-4 ─→ M4-6
【M5 运维】
M3-7 ─→ M5-1 ─→ M5-4 ─→ M5-5
M3-2 ─→ M5-2
M1-7 ─→ M5-3
M2-10 + M3-7 + M5-5 ─→ M5-6
```

- **关键路径**：M1-1 → M1-4 → M1-5 → M1-6 → M1-8 → M2-1 → M2-3 → M2-4 → M2-5 → M2-6 → M2-8 → M3-2 → M3-6 → M3-7 → M5-1 → M5-4 → M5-5 → M5-6
- **并行规则**：每个任务在其**全部前置依赖**完成后即可开始，与同层其他任务并行；依赖关系以 §3 任务表为唯一依据，本图仅作可视化
- 典型并行分组：M1-11 / M1-12 / M1-13 / M1-14（各自前置就绪后）；M2-9 与 M2-2…M2-8；M5-2 / M5-3 与 M3/M4 后期
- P1/P2 门禁：M1-9 需要 Ed25519 私钥与已关注的自选钱包（§1）

## 5. 关键约束（实施时不得违背）

- **仅 IPv4**；429 封禁期**零重试**（重试会延长封禁）
- **事件唯一键**以 M1-6 真实响应验证结论为准，不得先写死
- `is_open_or_close` 语义按来源区分；`action_hint` 归一化时 **follow 证据优先**
- **无评分系统**：所有过滤为二元/区间
- 消息**不含钱包地址/X 账号**；来源分项互斥且合计=总票数
- 第一版**不做汇总消息、不做交易**
- 速率预算基准 2.0 权重/秒；token 端点权重各 1
- 参与均价/保留率的唯一资格：`state=open && cost_complete=1`；`confidence` 仅分析
- 发送前复核**按任务类型区分**；退出提醒不因票数/保留率/价格被取消
- **归档校验成功后才能清理 `trades`**；`signals`/`signal_evaluations`/`push_tasks` 永久

## 6. 验收对照（DEVELOPMENT.md §11）

| 里程碑 | 验收要点 | 任务 |
|---|---|---|
| M1 | 30min 无 429；事件去重正确；契约验证结论落盘；429/封禁模拟；follow-wallet 签名入库；归档→清理链路通过 | M1-5, M1-6, M1-9, M1-11, M1-15 |
| M2 | 固定输入回放全部场景通过，**至少覆盖**：<br>① 同交易多事件、跨来源重复、清仓重买、卖出先到、分页重复、窗口过期、画像重聚类、同 tx 合并<br>② **余额一致但缺少零余额证据 → 不得取得 `cost_complete=1`**<br>③ **迟到事件早于检查点、无可靠重放起点 → 保持 `unknown`，不恢复资格**<br>④ 迟到事件重建后的周期划分与 `signal_wallets` 绑定正确 | M2-10 |
| M3 | 测试群三类消息；**至少覆盖**：<br>① 超时 → unknown → 有限重试<br>② **候选过期与发送回调竞争：已送达→pushed，未送达→cancelled**<br>③ **可重试 `failed` 任务重启后恢复调度**<br>④ **旧消息修订任务被丢弃，不覆盖新内容**<br>⑤ **退出提醒不受新信号门槛阻断**<br>⑥ **静默时段：普通信号抑制、强信号放行**<br>⑦ 按钮权限与 `/pause` 语义 | M3-7 |
| M4 | 回放可还原拦截原因；覆盖率报告；假设表输出；`/wallets` 只读列表与每日报告按时生成；对照缺失时输出"无法验证" | M4-6 |
| M5 | 断网/429/重启演练通过；告警送达；**正式启用前 M2-10 / M3-7 / M5-5 全部通过** | M5-5, M5-6 |

## 7. 执行顺序建议

```
基础配置与客户端 → 接口契约验证 → 采集、存储与归档 →
持仓与周期重建 → 信号校验及完整性门禁 → 推送与可靠性验收 →
回测统计 → 运维演练与正式上线
```

- 设计决策已全部记录在 `DEVELOPMENT.md`，无需再出 proposal/design
- **M1-6 接口契约验证**是所有计算与去重的信任基础，必须在归一化实现前完成
- 凭证按门禁准备：本地初始化不需要 Telegram / VPS；follow 签名验收才需要私钥
- 正式推送（M5-6）必须等 M2-10、M3-7、M5-5 全部通过
