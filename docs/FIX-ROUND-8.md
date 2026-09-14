# 代码复核修复记录（Round 8）

> 日期：2026-09-13 · 对照：复核 7 项（基线 `411fbbb`）
> 验证：`npm test` 12 文件 / 54 用例全绿；`tsc` 与 `build` 通过

## 已修复

| # | 问题 | 修复 |
|---|---|---|
| 1 | 状态保护阻止候选恢复 | 守卫改为 `REUSABLE_STATUSES`（candidate/sending/invalidated/blocked_price/suppressed），合法恢复可正常入队；返回结果与落库一致 |
| 2 | 失败分支覆盖已推送状态 | 新增 `updateSignalIfReusable`（带状态条件）；钱包层/代币层/价格拦截/票数不足等所有失败写入统一使用，`pushed` 不可被覆盖 |
| 3 | 复核覆盖有效票数 | 复核按 `recheck.validWallets` + 最新聚类计算 `effectiveVotesNow` 返回，不再用过滤前票数 |
| 4 | 第二次缺口被立即接受 | 缺口结束改为**删除** `gap_since` 键（非置 0）；新缺口必然重新记录首次发现时间 |
| 5 | 重建删除被引用的历史周期 | 仅替换检查点及之后的周期（`cycle_no >= checkpoint`），保留更早历史周期供信号/退出监控引用 |
| 6 | 静默队列仍阻塞强信号 | 任务扫描按 `signals.wallet_count >= quietHours.minWallets` **优先排序**，强信号不再被弱信号前缀占满 |
| 7 | 过期覆盖原拦截原因 | 过期时 `reason` 仅在为空时写入生命周期原因，保留原始拦截原因供报告分组 |

## 说明

- `#5` 的周期替换范围以检查点 `cycle_no` 为界；无检查点的重建仍按零起点全量处理。
- 信号绑定校正（`signal_wallets.cycle_no`）沿用既有重建后协调逻辑。

**结论：本轮 7 项全部处理。正式群推送仍需按 `docs/GO-LIVE-CHECKLIST.md` 完成真实凭证与环境验收。**
