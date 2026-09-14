# M2 验收报告（信号引擎）

> 日期：2026-09-13 · 规则版本：m1-2026-09-13.1
> 对照：`docs/TASKS.md` M2-1 ~ M2-10 与 `docs/DEVELOPMENT.md` §7

## 交付内容

| 任务 | 文件 | 说明 |
|---|---|---|
| M2-1 持仓周期 | `src/signal/positions.ts` | cycle_no、cost_complete、灰尘阈值、零余额检查点、成本完整性重算 |
| M2-2 关联合并 | `src/signal/cluster.ts` | union-find：同源+时间接近 / 同 tx bundler / CEX 排除 |
| M2-3 窗口聚合 | `src/signal/window.ts` | §7.1 指标口径：计票、净流入、合格买入、建仓证据 |
| M2-4 候选状态机 | `src/signal/candidate.ts` | 状态转换、复用/过期、生命周期、评估记录、发送衔接 |
| M2-5 钱包层校验 | `src/signal/validate-wallet.ts` | 快进快出/清仓/画像过滤/建仓/聪明钱/净流入/可核验门槛+保留率 |
| M2-6 代币层校验 | `src/signal/validate-token.ts` | 硬过滤（含 SOL 权限）、缺失值决策、周期∩窗口追高 |
| M2-7 完整性门禁 | `src/signal/integrity.ts` | 近期缺口阻塞、过期缺口按不可观测接受 |
| M2-8 发送衔接 | `src/signal/candidate.ts` | `sending` + `push_tasks` 原子创建（dedupe_key） |
| M2-9 周期重建 | `src/signal/rebuild.ts` | 严格早于受影响事件的检查点重放；无起点保持 unknown |
| M2-10 回放单测 | `test/signal.test.ts` | 9 个场景（见下） |

## 测试结果

`npm test`：**8 文件 / 33 用例全绿**（M2 新增 9 个）

覆盖场景：
- 清仓后重买开启新周期；灰尘阈值判清仓
- 零余额检查点 → `cost_complete=1`；**余额一致但无检查点 → 0**（边界验收）
- 数量缺失 → `incomplete` 不参与计算
- 同源+时间接近合并；CEX 资金来源不合并；同 tx 多钱包合并
- 计票按金额门槛；净流入含全部买卖
- 钱包层通过（3 票/建仓/聪明钱/保留率 100%）；可核验不足 → deferred
- **迟到事件早于检查点 → 从更早检查点重放；无可靠起点 → unknown**（边界验收）
- 近期缺口 → deferred 且不创建推送任务

## Review 发现与修复

| 问题 | 修复 |
|---|---|
| 候选评估前未做画像按需补拉（§7.2），有效票永远不足 | 评估流程中加入缺失画像批量补拉（失败降级记录） |
| 候选过期逻辑缺失（60min/窗口无买入） | `expireStaleCandidates`：过期 + 原子取消 pending 首次推送任务 |
| decimal.js 在 NodeNext 下的导入类型错误 | 统一改为命名导入 `{ Decimal }` |

## 已知限制（后续里程碑）

| 项 | 说明 | 处理 |
|---|---|---|
| 持仓更新在 ingest 事务之外 | 崩溃窗口可能丢一次持仓更新 | M2-9 重建可修复；M5 演练验证 |
| 升级/降级编辑、冷却期升级 | 需要消息修订号与编辑任务 | M3-4 |
| 退出监控 | 簇周期绑定、postPushExitAlert | M3-6 |
| 候选过期/取消的边界单测 | 逻辑已实现，测试待补 | M3-7 验收一并覆盖 |

## 交付物

- `src/signal/`（positions / cluster / window / integrity / validate-wallet / validate-token / candidate / rebuild）
- `src/index.ts` 接入：成交流 → 持仓 → 候选评估（防抖）
- `test/signal.test.ts`
