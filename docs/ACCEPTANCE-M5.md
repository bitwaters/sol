# M5 验收报告（部署运维）

> 日期：2026-09-13 · 对照：`docs/TASKS.md` M5-1 ~ M5-6

> 2026-09-14 补验：已修复并通过 Docker 原生依赖构建、隔离容器启动、非 root SQLite 读写、SIGTERM 退出与重启保留数据。VPS、真实断网恢复及在途 Telegram 推送仍待验收。详见 `DEBUG-2026-09-14.md`。

## 交付内容

| 任务 | 文件 | 说明 |
|---|---|---|
| M5-1 Docker | `Dockerfile`、`docker-compose.yml`、`.dockerignore` | 多阶段构建、非 root、UTC、卷挂载、restart 策略、日志轮转 |
| M5-2 告警 | `src/ops/alerts.ts` | 心跳丢失 / 缺口 / unknown 堆积 / GMGN 封禁，按 kind 每小时去重 |
| M5-3 备份 | `src/ops/alerts.ts` | `VACUUM INTO` 每日备份，保留 7 天（归档已在 M1-11） |
| M5-4 测试环境部署 | `Dockerfile` + `docker-compose.yml` | 可提前部署；`DRY_RUN=1` 时不启动推送层 |
| M5-5 故障演练 | 见下（单元级） | 断网退避 / 429 封禁零重试 / 重启恢复 sending 任务 |
| M5-6 正式上线门禁 | `docs/GO-LIVE-CHECKLIST.md` | M2-10 / M3-7 / M5-5 + 凭证 + IPv4 全部通过后才启用 |

## 测试结果

`npm test`：**11 文件 / 49 用例全绿**（M5 新增 3 个）

已覆盖的演练项（单元级）：
- **断网**：网关普通错误原样抛出并指数退避（`test/limiter.test.ts`、`test/poller.test.ts`）
- **429 封禁**：映射 `RateLimitedError` + 封禁门等待 + 封禁期零请求（`test/limiter.test.ts`）
- **重启恢复**：`sending` 超时转 `unknown` 后可重试（`test/telegram.test.ts`、pusher 实现）
- 告警去重、备份生成

## 待真实环境演练（需 VPS + 凭证）

| 项 | 步骤 |
|---|---|
| Docker 构建与启动 | `docker compose build && docker compose up -d` |
| 断网演练 | 临时阻断出站，观察退避与恢复后回补 |
| 429 封禁演练 | 压测触发 429，确认封禁期零请求与恢复回补 |
| 重启演练 | 推送中 `docker restart`，确认 `sending` 恢复为 `unknown` 并重试 |
| 告警送达 | 断开心跳来源，确认运维频道收到告警 |

## 说明

- `DRY_RUN=1` 时推送层不启动（采集/评估/回测继续），用于测试环境
- 正式启用推送需通过 `docs/GO-LIVE-CHECKLIST.md` 全部门禁
