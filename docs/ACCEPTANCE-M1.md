# M1 验收报告（采集与存储）

> 日期：2026-09-13 · 规则版本：m1-2026-09-13.1
> 对照：`docs/TASKS.md` M1-15 与 `docs/DEVELOPMENT.md` §11

> 2026-09-14 补验：个人 Key 签名入库、follow 可读数量、逐钱包画像已验证，详见 `CONTRACT.md` §7。最终修复版 10 分钟联调入库 744 个事件、0 次 429、1 次采集失败后恢复（`DEBUG-2026-09-14.md`）。下表保留初验记录；30 分钟连续运行与真实分页回补仍未通过。

## 初验结果

| 验收项 | 结果 | 证据 |
|---|---|---|
| 单元测试全绿 | ✅ 24/24 | `npm test`（7 个测试文件） |
| 事件去重正确（含金额键） | ✅ | `test/ingest.test.ts`；真实样本重复键为 0 |
| 契约验证结论落盘 | ✅ | `docs/CONTRACT.md` + `test/fixtures/*.json` |
| 字段路径/类型/单位逐项验证 | ✅ | CONTRACT.md §3（token info 18 项、security 9 项） |
| 限流器单测（容量/速率/权重/封禁门） | ✅ | `test/limiter.test.ts` |
| 429 / 封禁恢复模拟 | ✅ | `test/limiter.test.ts`（RateLimitedError + 封禁记录 + 等待恢复） |
| 30 分钟连续运行 | ⏳ 待个人 Key | 已用 demo key 完成 16 tick 冒烟（见下）；完整 30min 需个人 Key 复验 |
| follow-wallet 签名入库 | ⏳ 待私钥 | 代码已就绪（无私钥自动禁用）；需 P1 私钥后补验 |
| 归档 → 校验 → 清理链路 | ✅ | `test/archive.test.ts`（校验失败不清理） |
| 水位 / 缺口判定 | ✅ | `test/poller.test.ts`（首次观测、整页全新、重叠覆盖） |

## 冒烟运行（demo key，1 req/s）

```
cycles: 8 · ticks: 16 · fetched: 800
inserted: 114 · trades: 114 · tradeSources: 114
rateLimited: 0 · errors: 0 · gaps: 0
watermark 正常推进，gap 为空
```

> 首次冒烟暴露"整页 = 缺口"误判（smartmoney/kol 持续整页返回导致水位永不推进），已改为**重叠检测**并在 §5.2 回写规则。

## 已知限制与后续

| 项 | 说明 | 处理 |
|---|---|---|
| demo key 限频 | IP 级约 1 req/s，个人 Key 预期 20/s | `GMGN_RATE_LIMIT_PER_SEC` 控制；M1-15 用个人 Key 复验 |
| follow-wallet | 需 Ed25519 私钥（P1） | 私钥配置后自动启用，补验签名与分页 |
| `rug_ratio` / `is_wash_trading` | token info/security 不可得 | 硬过滤改用 `maxEntrapmentRate` / `maxBotDegenRate`（已回写 §6.2/§8） |
| kline `from/to` | 单位为毫秒（实测） | 已回写 §10；M4 实现按毫秒 |
| wallet stats 批量形状 | demo key 限频未完成批量验证 | M1-13 用个人 Key 复验（当前兼容单对象/数组） |

## 交付物

- `src/gmgn/`（vendored client + MIT 署名）
- `src/ingest/`（limiter / gateway / normalize / poller / backfill / archive）
- `src/store/`（schema 12 表 / db / repo: trades·health·evaluations）
- `src/enrich/`（token 分层缓存 / wallet 画像 / CEX 黑名单）
- `src/config.ts`、`src/logger.ts`、`src/index.ts`
- `scripts/verify-contract.ts`、`scripts/smoke.ts`
- `docs/CONTRACT.md`、`test/fixtures/*.json`
