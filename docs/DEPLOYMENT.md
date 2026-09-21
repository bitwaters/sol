# SEA deployment

代码仓库：`https://github.com/bitwaters/sol.git`；服务器检出目录：`/www/wwwroot/sol`。

所有代码、受 Git 管理的配置、脚本和文档，只能在本地修改并通过 GitHub 部署。禁止在 SEA 上编辑这些文件。服务器仅执行拉取、构建、容器操作与运行诊断。

## 目录与首次配置

- `/www/wwwroot/sol`：GitHub 检出的代码。
- `/etc/sol/sol.env`：在本地生成部署凭证子集后经 SSH 安全传输的凭证，root 所有、权限 600；父目录权限 700。
- `/var/lib/sol`：数据库、归档、备份和 CEX 黑名单；容器用户 UID/GID 1000，目录权限 700。

凭证和运行数据放在 Web 根目录之外。SSH 主机、端口和私钥路径使用本地连接配置，不写入公开仓库。

首次只读联调先在本地执行 `node scripts/prepare-sea-env.mjs`，生成被 Git 忽略的 `data/deployment/sea.env`（权限 600）。该文件仅包含 GMGN API Key、签名私钥、限流参数和 `DRY_RUN=1`，不含 Telegram 凭证。本地确认授权传输范围后再经 SSH 安装到上述受限路径，不能把凭证提交 GitHub。

正式推送获用户明确授权后，在本地执行 `node scripts/prepare-sea-env.mjs --live`。它只在部署文件中设定 `DRY_RUN=0`，并加入 `TG_BOT_TOKEN`、`TG_CHAT_ID`、`TG_ADMIN_IDS`；不会修改本地 `.env`。将该文件通过 SSH 原子替换到 `/etc/sol/sol.env` 后，以 Compose 重建容器加载配置，再检查 Bot 启动日志、paused 状态及目标聊天权限。不要用 `docker run --env-file` 直接加载此带引号的 dotenv 文件；一次性诊断可在 root 只读容器内挂载为 `/app/.env`，由 dotenv 解析，不放宽宿主机文件权限。

首次部署将空目录检出 `origin/main`；若目录已有仓库，应核验远端地址和未提交改动，不能覆盖未知文件。凭证文件从本地传输，不通过 GitHub，也不在服务器上手改。联调沿用 `DRY_RUN=1`。

SEA 初始联调使用每秒 10 权重、突发容量 5。启动时先按本地买入钱包数量做候选预筛选，跨代币最多并发 2 个评估；封禁期间取得的旧额度不能在解禁后集中使用。限流配置在本地准备，再随已授权的保密配置更新，不手改服务器文件。

## 更新步骤

本地：

```sh
npm test
npm run typecheck
npm run build
git diff --check
# 检查待提交内容不包含凭证和原始业务数据后，提交并推送 main。
git push origin main
```

SEA：

```sh
cd /www/wwwroot/sol
git status --short
git fetch origin main
git merge --ff-only origin/main
bash scripts/deploy.sh
```

部署脚本拒绝受 Git 管理文件有改动的检出目录。构建成功后才更新 `sol` Compose 项目的容器，避免构建失败先中断现有服务。业务数据目录不会被清空。`deploy.sh` 不执行远端代码编辑或 Git 强制覆盖。

## 运行诊断

```sh
cd /www/wwwroot/sol
SOL_ENV_FILE=/etc/sol/sol.env SOL_DATA_DIR=/var/lib/sol \
  docker compose -p sol exec -T bot node dist/ops/status.js
```

输出仅含版本、运行时长、各源心跳／水位／缺口、行数、状态分布、备份数量和数据库检查结果。原始日志可能包含钱包信息，只能做本地脱敏汇总后分享，不得上传公开仓库。

发现问题后返回本地修复，重新测试、提交、推送，再从 GitHub 拉取部署。需更改凭证时先更新本地保密文件，再通过 SSH 重新传输。没有明确的 Telegram 发送授权时保持 `DRY_RUN=1`。

不能用“容器仍运行”或“最近没有错误”替代来源健康检查。每个启用来源超过60秒无成功响应即视为失活，独立健康检查每30秒记录停采历史和状态变化；已有的每5分钟 Telegram 告警继续按小时去重。研究行情有到期任务且超过10分钟未完成一次实际检查时另行告警，预算繁忙的让路记录不算补采进展。

GMGN 请求截止时间覆盖请求头及响应正文，超时主动取消并独立结束等待；网关另有20秒兜底，释放后台占用后按现有退避继续。关闭信号未被底层及时执行时，迟到响应不会写入业务数据。接口限流预算和429退避保持原值。

UTC 09:00 的自动备份使用 SQLite 在线备份，每批64页后让出执行权，避免同步 `VACUUM INTO` 长时间阻塞采集和超时处理。备份期间禁止重复启动；先写 `.partial`，完成后再原子改名为 `.sqlite`，失败不宣称备份成功，成功后保留最近7天。原同步工具仅供离线或独立维护进程使用。数据库较大时按覆盖索引分批查询统计，完整数据库校验另作维护任务。

## 回滚

记录部署前后 Git 提交和容器镜像。代码回滚也从本地生成回退提交推送 GitHub，再在 SEA 快进拉取部署。数据库应先备份并核验兼容性，不以旧代码覆盖数据库文件。

### 2026-09-21 通知路由

信号频道使用 `TG_CHAT_ID`。管理通知改为直接私发 `TG_ADMIN_IDS` 中的有效管理员用户 ID；管理员必须先私聊机器人。旧 `TG_ALERT_CHAT_ID` 即便与频道相同也不再被运行时使用，无需为本次升级复制凭证。运维发送失败不回退频道。首次信号不编辑；普通状态变更独立回复首次信号；退出提醒首次回复原信号，后续编辑同一条退出汇总。部署验收只读核对目标类型、配置和运行状态，合成消息测试使用本地假发送器，避免在正式频道制造测试信号。

退出汇总升级验收：读取 `exit_message:<signal_id>`，确认定位到已发送的退出消息且与首次信号 ID 不同；观察编辑后状态更新，新退出任务不增加独立消息 ID。首次发送成功后持久化定位，后续编辑失败不自动另发。

### 倍率汇总部署验收

上线前只读检查机器人具备频道发帖及删除自己消息的权限。倍率状态使用现有 `kv` 和 `push_tasks`，无表结构迁移。上线后核验 `milestone_baseline`、`milestone_progress` 与原始发送价格/时间一致，`milestone_message` 始终指向回复原信号的最新汇总。新发确认后才清理旧倍率消息；核对 `telegram.send`/`telegram.delete` 指标及 `milestone_cleanup` 重试状态。正式频道不发送合成倍率测试消息，无自然达标时如实说明发送/删除链路仅完成本地模拟验证。
