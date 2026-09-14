# 待确认：follow_wallet 的有效分页请求参数

日期：2026-09-14。该文档仅为可转交的脱敏问题描述，尚未向 GMGN 发送。

## 现象

使用个人 API Key 和匹配的 Ed25519 签名，通过 `GET /v1/trade/follow_wallet` 查询 `chain=sol&limit=100` 成功，响应包含 `list` 和 `next_page_token`。

等待 3 秒后，将原样 token 放入下一次请求的 `next_page_token` 参数：

- 第一页 100 条；第二页 100 条。
- 两页事件重叠 100 条，没有更旧记录。
- 第二页返回的 token 未变化。
- 第二次请求耗时约 198ms，没有返回错误或 429。

较早的补验还尝试过 `page_token` / `cursor` / `next`，同样没有推进；未据此修改生产参数。

## 需要确认

1. `/v1/trade/follow_wallet` 是否支持个人 Key 的历史分页？是否受套餐限制？
2. 正确的请求参数名称、编码方式及 token 来源是什么？
3. 是否需要使用最后一条记录的 `id`，而不是顶层 `next_page_token`？
4. 是否存在时间范围、排序或分页保留时间要求？

## 参考

- [官方 track 文档](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-track/SKILL.md) 的响应字段说明包含 `next_page_token`，记录 `id` 也提到游标用途。
- [官方 CLI 实现](https://github.com/GMGNAI/gmgn-skills/blob/main/src/commands/track.ts) 的 follow-wallet 命令没有分页输入选项。
- 本项目的 `src/ops/probe-follow.ts` 可执行同样的两次只读验证，仅输出数量与重叠统计。

## 当前保护

采集器识别重复页面或不前进游标后停止本轮翻页，保留缺口。运行稳定及到期接受历史缺口，都不作为历史回补成功的证据。本问题未解决前不能承诺关注钱包逐笔无遗漏覆盖。

不要附带 API Key、私钥、原始关注列表、完整 token 或原始响应到公开问题中。

## 2026-09-14 正式推送前补验

重新查阅官方文档与 CLI 后，在 SEA 停止其他采集请求的短窗口内，使用相同账号进行 5 次请求（间隔 3 秒）：

| 输入来源 | 请求参数 | 第二页条数 | 与首页重叠 | 更旧条数 |
|---|---|---:|---:|---:|
| 顶层 next_page_token | next_page_token | 100 | 100 | 0 |
| 首页最后记录 id | cursor | 100 | 98 | 0 |
| 首页最后记录 id | next_page_token | 100 | 98 | 0 |
| 首页最后记录 id | page_token | 100 | 98 | 0 |

后面三次有 2 条首页新增记录，所以游标变化不能当作历史翻页成功。四次后续请求耗时 151–165ms，无错误或 429。尚无可验证的分页调用契约，问题未解决，未向供应方发送消息。
