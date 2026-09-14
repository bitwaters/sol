# M3 验收报告（Telegram 推送）

> 日期：2026-09-13 · 对照：`docs/TASKS.md` M3-1 ~ M3-7 与 `docs/DEVELOPMENT.md` §9

> 2026-09-14 更新：SEA 已获一次性发送授权并完成信号、升级编辑、退出提醒和运维测试告警的真实 API 验收。网络失败→unknown、有限重试、持久化在途任务恢复及命令/回调鉴权已有自动化覆盖。正式 Bot 仍未常驻开启；在线交互和真实在途请求中断核对不在一次性发送范围内。详见 `RUNTIME-DEBUG-2026-09-14.md`；下文保留初验记录。

## 交付内容

| 任务 | 文件 | 说明 |
|---|---|---|
| M3-1 Bot 与命令 | `src/telegram/bot.ts` | grammY 适配、命令与回调统一鉴权、/pause 语义、静默/屏蔽命令 |
| M3-2 推送执行器 | `src/telegram/pusher.ts` | 状态机、优先级、限流、重试/`next_retry_at`、`cancelled`、重启恢复 |
| M3-3 消息模板 | `src/telegram/format.ts` | signal/escalate/exit 三模板、互斥来源分项、质量提示、CA code 块、链接与按钮 |
| M3-4 冷却与修订 | `pusher.ts` + `candidate.ts` | `message_revision`、最新修订检查、升级/降级编辑任务 |
| M3-5 静默与节奏 | `pusher.ts` | 静默时段普通信号抑制、强信号放行、每分钟限流、退出提醒豁免 |
| M3-6 退出监控 | `src/telegram/exit-monitor.ts` | 簇周期绑定、共识/非共识退出、按 signal+类型去重、监控终止 |
| M3-7 验收 | `test/telegram.test.ts` | 9 个场景 |

## 测试结果

`npm test`：**9 文件 / 42 用例全绿**（M3 新增 9 个）

覆盖场景：
- 来源分项互斥且合计 = 总票数
- 消息不含钱包地址；含 CA/免责声明/追高警告
- 首次推送成功写回 `pushed`/消息 ID/`sent_at`（冷却基准）
- 发送失败 → `failed` + 重试时间；暂停时不处理新信号
- **旧修订编辑任务被丢弃**（边界验收）
- 静默时段普通信号延迟、强信号放行
- **退出提醒不受暂停影响且优先处理**（边界验收）
- 共识簇全部绑定周期清仓 → 创建退出提醒；重复运行去重
- `loadSignalView` 均价计算

## Review 发现与修复

| 问题 | 修复 |
|---|---|
| 崩溃时 `sending` 任务卡死 | 执行器启动先恢复：`sending` 超 10s → `unknown`（可重试） |
| 代币元数据可含 HTML（攻击者可控） | 模板对 symbol/launchpad/dev 状态做 HTML 转义 |
| Bot API 7 已移除 `reply_to_message_id` | 改用 `reply_parameters: { message_id }` |

## 待真实验收（需 P3 凭证）

| 项 | 说明 |
|---|---|
| 测试群三类消息 | 配置 `TG_BOT_TOKEN`/`TG_CHAT_ID` 后运行，验证格式与按钮 |
| 按钮权限与 `/pause` 语义 | 非管理员操作被拒；暂停后退出提醒仍到达 |
| 超时 → unknown → 有限重试 | 可用网络故障注入验证 |

## 已知限制

- 链接模板（Photon/Trojan/BullX）为常见格式，需上线前人工核验
- 升级编辑的触发依赖冷却窗口内的再次评估（新成交驱动）
- 告警频道（`TG_ALERT_CHAT_ID`）尚未接入（M5-2）
