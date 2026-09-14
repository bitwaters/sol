# SEA 持续联调（2026-09-14）

## 范围

保持 DRY_RUN；所有代码通过本地修改、GitHub 推送、SEA 快进部署。真实 Telegram 发送和 Telegram 凭证传输需要用户明确授权，测试脚本不会启动正式推送器。

## 本轮修复

1. 历史缺口按现有策略到期接受后，水位只推进到较旧的重叠记录。该记录滚出最新 100 条后，同一缺口反复开启。现在推进到该来源已经观测到的最新时间，并保存接受区间、次数及 `recovered=false`。受影响持仓的成本资格继续撤销；没有补齐历史交易，也没有清空数据库。
2. 评估执行期间的新成交曾被简单去重丢弃。现在标记代币有更新，当前评估结束后合并为一次重验，同代币仍不并发执行。
3. GMGN 客户端原先只读取限流响应头，忽略响应体 `reset_at`。现读取两者并采用更晚的截止，缺失时才使用网关保守等待策略。
4. Telegram 传输失败缺少确定响应时，现在进入 `unknown`，保留次数和重试时间；确定的 API 错误仍为 `failed`。不保证 Telegram 在不确定重试场景下绝对不重复送达。

## 耗时观测

新增 GMGN 额度排队、请求成功/错误/限流耗时，采集整轮、本地入库、新事件首次观测年龄，代币评估排队/执行/资料补查，以及推送排队/复核/发送/编辑耗时。

- 每 60 秒写一次数值汇总到运行数据库和日志；不记录钱包或凭证标签。
- count/mean/max 自本次进程启动累计；P50/P95 取各项最近最多 2,048 个样本，`sampleCount` 明确标示样本量。
- `poll.event_age` 包含 GMGN 收录及轮询延迟，启动历史页会拉高数值；不等同于纯网络请求耗时。
- `evaluation.result.*` 的 count 是评估结果次数，时间值为 0，不是延迟指标。
- 250ms 是队列启动延迟，最多两个评估并发，不是强制的逐任务间隔。
- DRY_RUN 不产生 Telegram 发送样本；缺少样本时不报告推测的真实送达延迟。

## 验证工具

- `node dist/ops/status.js`：只读运行快照，包含数值耗时和历史缺口接受记录。
- `docker logs --since <UTC时间> sol-bot-1 2>&1 | node scripts/analyze-runtime.mjs`：仅输出白名单汇总，不展示原始成交。
- `node dist/ops/probe-follow.js --run`：最多两次真实只读请求，间隔 3 秒，输出第二页重叠/更旧记录数。429 后停止，不猜测无限分页参数。
- `node dist/ops/fault-drill.js`：本机模拟 HTTP API、断开连接、真实 HTTP 429、封禁后恢复及 SQLite 重开。可在 `--network none` 的隔离容器中执行；不使用真实密钥、不触碰生产数据。
- `node dist/ops/telegram-smoke.js --preview`：预览虚构信号、升级编辑、退出和运维告警。
- `--preflight` 仅查询 Telegram 机器人及目标聊天；`--send-test` 必须获得用户授权后执行，发送 3 条消息并编辑 1 次，不启动正式推送器。

## 验证状态

- 本地 17 个测试文件、129 个用例通过；包含断网恢复、历史缺口不重复开启、评估期间更新、未知送达有限重试、Telegram 429 和持久化在途任务重开。
- 真实 follow 分页及最终版本 30 分钟连续运行待 SEA 复验。官方 [track 接口说明](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-track/SKILL.md) 声明响应含 `next_page_token`，但 [CLI 实现](https://github.com/GMGNAI/gmgn-skills/blob/main/src/commands/track.ts) 没有提供 follow-wallet 的分页输入选项，不能据此证明具体请求参数有效。
- Telegram 真实发送仍待授权；本地直连只读预检返回传输错误，不计作权限验证成功。
