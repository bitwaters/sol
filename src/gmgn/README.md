# Vendored GMGN OpenAPI client

- 来源：https://github.com/GMGNAI/gmgn-skills （MIT License，见同目录 `LICENSE`）
- 文件：`OpenApiClient.ts`、`signer.ts`，复制自上游 `src/client/`
- 本地补丁（升级时必须保留）：
  - 导出 `OpenApiError`，供网关识别限流。
  - 普通 HTTP 429 和业务限流统一交给网关，不在客户端绕过共享额度重试。
  - 同时读取响应头与响应体 `reset_at`，采用更晚的恢复时间。
  - 请求超时及实际接口字段/参数适配；覆盖前须比较当前文件差异并运行契约、限流与故障演练。
- 升级方式：从上游重新复制后重放上述补丁
- 已知限制：
  - 上游 client 使用全局 `fetch`，不自带代理；本项目在启动时可通过 `undici` 的
    `setGlobalDispatcher(ProxyAgent)` 支持 HTTP(S) 代理（不支持 SOCKS）
  - 上游自带 429 自动重试；本项目构造客户端时明确传入
    `autoRetryOnRateLimit: false`，由自有 Token Bucket + BanGate 统一处理

- 2026-09-23：429 响应支持 Retry-After，正文不可读或不是合法对象时仍保留限频分类；实际发送节奏、端点权重和跨重启冷却由共享网关管理。
