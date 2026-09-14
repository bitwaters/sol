# M4 验收报告（回测与统计）

> 本报告记录 M4 初次验收；2026-09-14 后的测量质量、调度与调参门槛以 [MEASUREMENT-QUALITY.md](MEASUREMENT-QUALITY.md) 为准。

> 日期：2026-09-13 · 对照：`docs/TASKS.md` M4-1 ~ M4-6 与 `docs/DEVELOPMENT.md` §10

## 交付内容

| 任务 | 文件 | 说明 |
|---|---|---|
| M4-1 kline 回测 | `src/backtest/evaluate.ts` | 触发/发送价分离、已完成 K 线、按分辨率容差、缺行情统计、outcome 写入 |
| M4-2 对照组采样 | `src/backtest/control.ts` | 2 票候选定时采样（`signals.status='control'`），同覆盖标准 |
| M4-3 /stats 与分组 | `src/backtest/report.ts` | 覆盖率优先、分组中位数、对照不足标记"无法验证"、不报告胜率 |
| M4-4 /wallets 与每日报告 | `src/telegram/bot.ts`、`src/backtest/report.ts` | follow 列表（截断地址）、UTC 08:00 每日报告 |
| M4-5 RPC 多跳 | — | 可选，未实现（M2 聚类仍为 1 跳） |
| M4-6 验收 | `test/backtest.test.ts` | 3 个场景 |

## 测试结果

`npm test`：**10 文件 / 46 用例全绿**（M4 新增 4 个）

覆盖场景：
- 已完成 K 线选择 + 容差外标记缺行情
- 已推送信号按 `sent_at` 取价并写入 `outcome_5m`
- 对照组对恰好 2 票 token 采样一次（间隔内不重复）
- 对照样本不足时报告"无法验证"且不报告胜率

## 接入

- 回测评估：每 5 分钟，单批最多 5 条（控制 kline 权重预算）
- 对照采样：每 15 分钟
- 每日报告：UTC 08:00 发送到主频道（需 TG 凭证）
- `/stats`：随时查看

## 已知限制

- 未实现成本模型（手续费/滑点/gas）前不报告策略胜率（符合 §10）
- 对照组阈值（≥20 个有效样本）为初始值，后续按实际调整
- `M4-5` RPC 多跳资金来源为可选项，未实现
