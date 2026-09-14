# 正式上线检查清单（M5-6 门禁）

> 全部勾选后才可对正式群开启推送（`DRY_RUN=0` 且配置 `TG_CHAT_ID`）。

## 一、凭证与网络

- [x] `GMGN_API_KEY` 为个人 Key（非 demo），`GMGN_RATE_LIMIT_PER_SEC=20`
- [x] `GMGN_PRIVATE_KEY` 已配置且与申请 Key 的公钥配对（follow-wallet 签名）
- [x] 自选钱包已在 gmgn.ai 关注（follow 数据源）
- [ ] 出站为 IPv4：`curl -4 ip.me` 返回 IPv4
- [ ] 可直连 `api.telegram.org`：`curl -s -o /dev/null -w "%{http_code}" https://api.telegram.org` 返回 200/302
- [x] `TG_BOT_TOKEN` / `TG_CHAT_ID` / `TG_ADMIN_IDS` / `TG_ALERT_CHAT_ID` 已配置

## 二、里程碑验收

- [x] M2-10 回放单测全绿（含余额一致无检查点、迟到事件无起点两条边界）
- [ ] M3-7 推送验收通过：测试群三类消息、超时→unknown、旧修订丢弃、退出提醒不受门槛阻断、静默时段
- [ ] M5-5 故障演练通过：断网 / 429 封禁 / 重启（含在途任务）
- [x] `npm test` 全绿（2026-09-14：116 用例）

## 三、真实环境补验（个人凭证）

- [x] follow-wallet 签名与数量单位验证（2026-09-14，个人 Key）
- [ ] follow-wallet 分页验证：当前游标返回首页，尚未通过（`docs/CONTRACT.md` §7）
- [ ] 30 分钟连续运行无 429，水位正常推进、无缺口
- [x] wallet stats 响应形状确认：逐地址请求，两个画像均匹配（M1-13）
- [ ] 消息链接模板（Photon/Trojan/BullX）人工核验可跳转

## 四、运营准备

- [ ] 正式群公告免责声明（信号仅供参考，非投资建议）
- [ ] 管理员熟悉命令：`/status` `/pause` `/resume` `/mute` `/unmute` `/stats` `/config` `/test`
- [ ] 运维告警频道可收到测试告警
- [ ] 备份目录 `data/backups` 可写且已产生首份备份

## 五、回滚

- [ ] 保留上一版本镜像/代码 tag
- [ ] `/pause` 可即时停止新信号（退出提醒与告警继续）
- [ ] 回滚后数据库向后兼容（schema 仅新增表/列）
