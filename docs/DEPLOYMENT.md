# SEA deployment

代码仓库：`https://github.com/bitwaters/sol.git`；服务器检出目录：`/www/wwwroot/sol`。

所有代码、受 Git 管理的配置、脚本和文档，只能在本地修改并通过 GitHub 部署。禁止在 SEA 上编辑这些文件。服务器仅执行拉取、构建、容器操作与运行诊断。

## 目录与首次配置

- `/www/wwwroot/sol`：GitHub 检出的代码。
- `/etc/sol/sol.env`：从本地 `.env` 经 SSH 安全传输的凭证，root 所有、权限 600；父目录权限 700。
- `/var/lib/sol`：数据库、归档、备份和 CEX 黑名单；容器用户 UID/GID 1000，目录权限 700。

凭证和运行数据放在 Web 根目录之外。SSH 主机、端口和私钥路径使用本地连接配置，不写入公开仓库。

首次部署将空目录检出 `origin/main`；若目录已有仓库，应核验远端地址和未提交改动，不能覆盖未知文件。凭证文件从本地传输，不通过 GitHub，也不在服务器上手改。联调沿用 `DRY_RUN=1`。

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

## 回滚

记录部署前后 Git 提交和容器镜像。代码回滚也从本地生成回退提交推送 GitHub，再在 SEA 快进拉取部署。数据库应先备份并核验兼容性，不以旧代码覆盖数据库文件。
