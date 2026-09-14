# Vendored GMGN OpenAPI client

- 来源：https://github.com/GMGNAI/gmgn-skills （MIT License，见同目录 `LICENSE`）
- 文件：`OpenApiClient.ts`、`signer.ts`，复制自上游 `src/client/`
- 本地修改（仅一处）：
  - `OpenApiError` 增加 `export`，供本项目限流器按类型识别 429 / 封禁
- 升级方式：从上游重新复制后重放上述补丁
- 已知限制：
  - 上游 client 使用全局 `fetch`，不自带代理；本项目在启动时可通过 `undici` 的
    `setGlobalDispatcher(ProxyAgent)` 支持 HTTP(S) 代理（不支持 SOCKS）
  - 上游自带 429 自动重试（默认最多等 5s）；本项目设置
    `GMGN_RATE_LIMIT_AUTO_RETRY_MAX_WAIT_MS=0` 关闭它，由自有 Token Bucket + BanGate 统一处理
