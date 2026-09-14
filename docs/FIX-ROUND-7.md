# 代码复核修复记录（Round 7）

> 日期：2026-09-13 · 对照：全链路复核 13 项（基线 `0a34abf`）
> 验证：`npm test` 12 文件 / 54 用例全绿；`tsc` 与 `build` 通过

## 已修复

| # | 问题 | 修复 |
|---|---|---|
| 1 | 评估把已推送信号改回 sending | 任务创建事务内**先读状态**，仅 `candidate/sending` 允许写入；已送达/终结直接跳过 |
| 2 | 跨批次迟到成交未重建 | 主流程 `onTrades` 检测 `trade.timestamp < 持仓 lastTradeTs` → 按最早受影响时间调用 `rebuildWalletToken` |
| 3 | 清仓检查点重建重开旧周期 | 检查点 `balance='0'` 时恢复为 `closed` 周期，后续买入自动开启新周期 |
| 4 | 缺口年龄被心跳刷新 | 缺口首次发现时间存入 `gap_since:{source}`（kv），与心跳 `updated_at` 分离；覆盖时清除 |
| 5 | 复核新价格未同步消息 | 复核返回最新 `priceRatio/holdingRatio/votes/warn`；推送器发送前写回 signals 与任务 payload |
| 6 | 消息/强信号用过滤前票数 | 新增 `effectiveVotes`（过滤后独立簇数），落库、快照、强弱与静默放行统一使用 |
| 7 | 缺失字段误判为硬过滤失败 | 改为 `failure.endsWith('_missing')` 判定，缺失进入暂缓而非禁验 |
| 8 | 真实 Telegram 429 未用 retry_after | grammY 适配层转换：`error_code===429` → `TelegramRateLimitError(retry_after)`，发送与编辑同处理 |
| 9 | 静默弱信号堵住强信号 | 单轮扫描上限 20 → 200（缓解固定前缀阻塞；分页调度待后续迭代） |
| 10 | 解除屏蔽后候选卡 sending | 屏蔽取消任务时置信号 `expired` + 重新触发冷却 |
| 11 | 被拦截候选过期退出回测/报告 | 回测与报告纳入 `expired`，按拦截原因分组保留统计归属 |
| 12 | 关闭开关仍生成退出提醒 | 共识退出分支增加 `postPushExitAlert.enabled` 检查 |
| 13 | 已推送信号无窗口过期重评 | 维护任务将编辑有效期内的 `pushed` 信号纳入定时重评 |

## 说明

- `#9` 采用扩大扫描窗口的缓解方案（200 条），未实现真正的分页调度；已记录为后续迭代项。
- 其余 12 项为完整修复。

**结论：本轮 13 项已处理（1 项为缓解方案）。正式群推送仍需按 `docs/GO-LIVE-CHECKLIST.md` 完成真实凭证与环境验收。**
