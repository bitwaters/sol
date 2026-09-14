# 代码复核修复记录（Round 2）

> 日期：2026-09-13 · 对照：复核 13 项（基线 `15e6ed9`）
> 验证：`npm test` 12 文件 / 53 用例全绿；`tsc` 与 `build` 通过

## 已修复

| # | 问题 | 修复 |
|---|---|---|
| 1 | 同日多次归档丢数据 | 仅归档**完整过期日**（day_end ≤ cutoff），每天只处理一次 |
| 2 | Docker 缺 copy-assets 脚本 | Dockerfile 复制 `scripts/`，`.dockerignore` 不再排除 |
| 3 | 发送前未完整复核 | 新增 `revalidateSignalForSend`（缺口/票数/钱包层/代币层），推送器强制要求 `evaluatedAt` 并调用复核 |
| 4 | 重建误用 kol 单位 | 改为按已存储的规范化字段与单位重放；未验证单位保持 `incomplete` |
| 5 | 有缺口仍授予完整性 | `deriveCostComplete` 缺口直接拒绝；重算遇缺口**撤销**已授予标记 |
| 6 | 升级后簇 ID 碰撞 | `persistSignalWallets` 改为事务内删除+全量重写，簇映射原子协调 |
| 7 | 重验不刷新任务 TTL | 首次任务改为 upsert：pending/failed/unknown 更新 payload 与 `evaluatedAt` |
| 8 | 降级仍绿色且绕过节流 | 标题渲染 `🟡 共识减弱`；降级走统一节流与内容检查；推送器透传 downgraded |
| 9 | 非共识退出按钱包计数 | 复用 `buildClusters` 按独立簇计数 |
| 10 | 回测遗漏旧样本 | 查询改升序 + 扩大扫描窗口（maxPerRun×20），到期筛选后按最早到期处理 |
| 11 | 冷却放在无效分支 | 新候选创建前统一检查重新触发冷却 |
| 12 | 分组用可变字段 | 快照补存 `priceRatio`/`warn`，报告分组读取快照 |
| 13 | 脚本限流永久等待 | verify-contract / smoke 容量改为 `max(rate, 5)` |

## 说明

- `#1` 采用"完整过期日"分片：跨日推进 cutoff 不会产生同日二次归档；重写仍先清空文件，校验通过才删除 DB 记录。
- `#3` 的复核为本地计算 + 必要富化刷新（价格 60s 缓存），不额外占用轮询预算。

**结论：本轮 13 项全部处理。正式群推送仍需按 `docs/GO-LIVE-CHECKLIST.md` 完成真实凭证与环境验收。**
