# MCP 客户端编排：传输、认证与本地进程生命周期

> Wayfinder 研究票 [#19](https://github.com/Lumichelka/career-agent/issues/19)，父地图 [#12](https://github.com/Lumichelka/career-agent/issues/12)。
> 调研时间：2026-10-25。以 MCP 规范、官方安全文档、TypeScript SDK 文档与源码为准；只记决策事实，不写实现。
> 仓库现状：本地 Node Web、局域网、单服务多登录用户、按用户数据目录隔离；已装 `@modelcontextprotocol/sdk` **1.32.1**（[package.json](../../package.json)），并已有一个 stdio 方向的 MCP Server（[src/platform/mcp.mjs](../../src/platform/mcp.mjs)）。

## 0. 结论速览

- **先选协议时代，再选传输。** 现行规范是 **2026-07-28**（无会话、无握手、无服务端主动请求、无断流续传）；**2025-11-25 及更早是 legacy**（`initialize` 握手 + `Mcp-Session-Id`）。仓库钉的 SDK 1.32.1 属 v1 维护线，**只实现到 2025-11-25**；要讲 2026-07-28 必须换 v2 包（`@modelcontextprotocol/client` / `@modelcontextprotocol/server`，当前 2.4.0）。
- **本地/局域网优先 stdio，远程才用 Streamable HTTP。** stdio 没有授权层，凭证来自环境变量，进程即信任边界；HTTP 才需要令牌、Origin/Host 校验和 OAuth。
- **多用户隔离靠“每请求认证”，不靠 session。** 规范明确服务端**不得**把会话当认证；身份只来自校验过的 token（`authInfo`），客户端传来的 userId/taskId 一律不可信。
- **stdio 下“每用户一进程”是唯一可靠的凭证隔离方式**，但 2026-07-28 明确不建议把进程生命周期绑到单个任务/会话上。
- **取消有两条真实路径**：stdio 发 `notifications/cancelled`；2026 的 Streamable HTTP 直接关闭该请求的响应流即取消。**2026 起不能续传**，断流即失败，重试由客户端发起。
- 仓库现有“stdio 暴露平台工具给外部 AI”的方向与“作为客户端调用外部 Agent”可以并存，但**两者不能共用 token**，也**不能互相代传 token**。

## 1. 两个协议时代：这是第一决策

| 维度 | legacy（2024-10-07…2025-11-25） | modern（2026-07-28 起） |
| --- | --- | --- |
| 连接建立 | `initialize` 握手 + `notifications/initialized` | 无握手；每个请求在 `_meta` 带版本/能力（[Versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)） |
| 会话 | 服务端可发 `Mcp-Session-Id`；404 后重新初始化；DELETE 终止 | **无协议级会话**，`Mcp-Session-Id` 被移除（[changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)） |
| 服务端主动请求 | SSE 流上发 `sampling`/`elicitation`/`roots` 请求 | 改为 **MRTR**：服务端返回 `InputRequiredResult`，客户端带 `inputResponses` 重试（[MRTR](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr)） |
| 通知 | 客户端开 GET/SSE 流接收 | 只能通过 `subscriptions/listen` 主动订阅（[subscriptions](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions)） |
| 断流恢复 | 支持 `Last-Event-ID` 续传 | **取消续传**；断流=请求丢失，客户端用新 id 重发 |
| 健康检查 | `ping` | `ping` 已移除；靠真实请求探测 |
| 认证 | HTTP 上 OAuth 2.1 资源服务器 | 同左，且按请求校验；无会话可依赖 |

判断时代的方法也写在规范里：stdio 用 `server/discover` 探测，HTTP 先发一个 modern 请求，看 400 响应体里是不是“可识别的 modern JSON-RPC 错误”，再决定是否回退 `initialize`（[stdio 兼容](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio#backward-compatibility)、[HTTP 兼容](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#backward-compatibility)）。

**SDK 事实（决定能否用 2026-07-28）**

- v1 自述：“implements the MCP spec up to 2025-11-25. Support for the 2026-07-28 spec is not planned for v1.x: it is in v2” —— v1 在 v2 发布（2026-07-27）后至少 6 个月继续收 bug/安全修复（[v1 README](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x)，本仓库同版本见 [node_modules/.../README.md](../../node_modules/@modelcontextprotocol/sdk/README.md)）。
- v2 当前版本 2.4.0（[server](https://www.npmjs.com/package/@modelcontextprotocol/server)、[client](https://www.npmjs.com/package/@modelcontextprotocol/client)）；同一套 `Client` 可双时代，`createMcpHandler` 默认 “modern + legacy stateless”（[Protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.html)、[Legacy clients](https://ts.sdk.modelcontextprotocol.io/v2/serving/legacy-clients.html)）。
- v2 默认客户端的版本协商是 **legacy**（跑 `initialize`）；要 modern 得显式 `versionNegotiation: { mode: 'auto' }` 或 pin（同上）。

## 2. 传输选择

### (a) 出站：Web 应用按任务调用外部 MCP Agent

| 传输 | 适用 | 代价/限制 |
| --- | --- | --- |
| **stdio** | Agent 是**同机可执行进程**（CLI、本地脚本、npx 包）；凭证走环境变量；不需要跨机器 | 无认证层，进程即身份；stdout 只能放协议消息，日志必须走 stderr；Windows 无 SIGTERM，需 `TerminateProcess`/Job Object（[stdio 规范](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)） |
| **Streamable HTTP** | 远程 Agent（HTTPS），或局域网内独立服务；需要按请求认证、多客户端共用一个端点 | 必须处理令牌、Origin 校验；2026 无会话、无续传；需要自己承担超时/重试语义（[HTTP 规范](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)） |
| HTTP+SSE（2024-11-05） | 只为兼容旧服务 | 已弃用，新实现不要采用（同页与 [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)） |

架构上，MCP 是 host/client/server 三层：**一个 host 可以开多个 client，每个 client 只对一个 server**（[Architecture](https://modelcontextprotocol.io/specification/2026-07-28/architecture)）。对照本应用：Web 服务就是 host，每个“用户 × 外部 Agent”是一条独立 client 连接，而不是共享一条连接再在协议里区分用户。

### (b) 入站：把应用工具暴露成 MCP Server 给外部 AI

| 方式 | 适用 | 认证 |
| --- | --- | --- |
| **stdio**（现有 [src/platform/mcp.mjs](../../src/platform/mcp.mjs) 就走这条） | 外部 AI 与本机同机，由 AI 宿主 spawn 本应用 | 无协议认证；靠进程权限 + 环境变量里的本机 token（规范建议本地服务优先用 stdio 限制访问范围，[Security best practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices#local-mcp-server-compromise)） |
| **Streamable HTTP + bearer token**（绑 127.0.0.1） | 局域网设备、或本机另一个进程要通过 HTTP 访问 | 每请求校验 token → `authInfo`；Origin 校验失败必须 403；建议只监听回环 |
| **Streamable HTTP + OAuth 2.1** | 需要给“不特定外部 AI 客户端”发访问权（公网/云端接入） | 应用成为 OAuth 资源服务器：发布 RFC 9728 元数据、校验 audience、PKCE；令牌签发交给现成 IdP |

规范把最小安全线写死了：Streamable HTTP 服务端**必须**校验 `Origin`（无效就 403），本地运行**应**只绑 `127.0.0.1`，并**应**对所有连接做认证；否则会被 DNS rebinding 打穿（[HTTP 规范 Security & Endpoint](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#security-%26-endpoint)）。SDK v2 的框架适配器（`createMcpExpressApp` 等）默认在回环绑定上启用 Host/Origin 校验（[Serve over HTTP](https://ts.sdk.modelcontextprotocol.io/v2/serving/http.html)）。

2026-07-28 还新增了请求头契约：每个 POST 必须带 `MCP-Protocol-Version`、`Mcp-Method`、`Mcp-Name`（`tools/call`/`resources/read`/`prompts/get`），服务端**必须**校验头与 body 一致，不一致回 400 `HeaderMismatch`。若在应用前面加 nginx/网关，要么让它原样转发这些头，要么不要按头做路由/限流（[Request Metadata](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#request-metadata)）。

## 3. 多用户认证与会话隔离

### 3.1 角色先分清

- 作为**客户端**：应用是 OAuth client，替某个用户去访问外部 MCP Server；令牌属于那个用户。
- 作为**服务端**：应用是 OAuth **资源服务器（resource server）**，只校验别人签发的令牌，**从不签发令牌**（[Require authorization](https://ts.sdk.modelcontextprotocol.io/v2/serving/authorization.html)、[Authorization 规范](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)）。
- 不要自己造授权服务器；v1 里的授权服务器辅助件已冻结进 `@modelcontextprotocol/server-legacy/auth`，官方建议新服务用独立 IdP（同上）。

### 3.2 出站：每个用户、每个任务各自的连接与凭证

- 每个用户的每条外部连接用**独立的 Client + transport + authProvider**；令牌按用户存储（服务端加密存储或系统钥匙串），`saveTokens` 的目标必须是“这个用户”，不能是全局变量（[Authenticate a user with OAuth](https://ts.sdk.modelcontextprotocol.io/v2/clients/oauth.html)）。
- OAuth 客户端凭据**必须按 issuer 分键**，不能把 A 授权服务器注册的 client_id 发给 B（规范要求，v2 示例显式按 `ctx.issuer` 存）。
- 只想用“用户自带的 Key/令牌”时，实现 `AuthProvider.token()` 即可，transport 每次请求前调用它（[Machine auth](https://ts.sdk.modelcontextprotocol.io/v2/clients/machine-auth.html)）。这正是“每用户自带 Key”的落点。
- stdio 的凭证只能来自环境变量（规范明确 stdio **不应**走 OAuth，凭证从环境读）：因此**不能**用一个常驻子进程服务多个用户，除非该进程自身按请求接收并校验用户 token——而那等于把认证责任搬进 Agent，不推荐。

### 3.3 入站：会话不是身份

- 2026-07-28：每请求独立，服务端从校验后的令牌得到身份；SDK v2 的 per-request factory 接收 `authInfo`，可以**按调用者构建不同的工具集**（[Serve over HTTP](https://ts.sdk.modelcontextprotocol.io/v2/serving/http.html)）。注意“列表不再随连接变化”只否定了连接级状态，按请求的调用者裁剪工具仍然成立。
- 需要跨请求状态时，用**服务端签发的显式句柄**（如任务 id），并且**必须**服务端绑定 `<user_id>:<handle>`；**不得**把“持有句柄”当作认证（[State Handle Hijacking](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices#state-handle-hijacking)）。
- 2025-11-25 的 `Mcp-Session-Id` 仍可用，但安全文档要求：**不得用会话做认证**、会话 ID 必须不可预测、绑定到用户身份（`<user_id>:<session_id>`）、可轮换/过期（[Session Hijacking](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices#session-hijacking)）。
- 若坚持用 2025 的有状态模式：一个 transport 实例就是一个会话，需要“会话表 + 空闲回收 + 未知会话 404 / 缺会话 400”（[Sessions, state, and scaling](https://ts.sdk.modelcontextprotocol.io/v2/serving/sessions-state-scaling.html)）。
- 反向禁止项：**不得**把客户端传来的 userId/账号名当身份；**不得**让一个用户的任务句柄被另一个用户使用。

### 3.4 OAuth 2.1 什么时候才真的需要

只在“HTTP 入站 + 不特定客户端”时需要。规范要点（[Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)、[Authorization Security Considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)）：

- 服务端**必须**实现 RFC 9728 受保护资源元数据；客户端**必须**用它发现授权服务器。
- 客户端**必须**带 RFC 8707 `resource` 参数；服务端**必须**校验令牌的 audience 是它自己。
- **禁止 token passthrough**：服务端不能接受/转交不是发给它的令牌（[Token Passthrough](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices#token-passthrough)）。
- PKCE 必须 S256；重定向 URI 只允许 localhost 或 HTTPS；必须校验 `iss`（RFC 9207）防 mix-up。
- 客户端凭据/注册信息按 issuer 绑定；DCR（RFC 7591）已被降级为兼容手段，优先 Client ID Metadata Documents。

对本地应用的含义：如果外部 AI 只在本机/局域网，**先不要引入 OAuth**，用 stdio（本机）或回环 + bearer token（局域网）即可；只有要接云端 AI 时才付 OAuth 的代价。

## 4. 进程生命周期、超时、取消、重连

### 4.1 stdio 进程

- 关闭顺序（规范建议）：关 stdin → 等退出 → 强制终止；POSIX 是 SIGTERM→SIGKILL，Windows 用 `TerminateProcess` 或 Job Object（[stdio Shutdown](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio#shutdown)）。
- SDK v1 的 `StdioClientTransport.close()` 就是这条链：`stdin.end()` → 等 2s → `SIGTERM` → 等 2s → `SIGKILL`（[stdio.js:150-175](../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js)）。注意它只杀直接子进程；`npx`/shell 包装器产生的孙进程需要额外的进程组/Job Object 处理（**这是仓库在 Windows 上的真实风险**）。
- 规范立场：客户端**不应**把单个任务/会话当成 stdio 进程的生命周期边界；进程崩溃后**应**重启，正在进行的请求会丢，客户端可对新进程重试（[Statelessness](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#statelessness)、[Unexpected Termination](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio#unexpected-termination)）。
- 因此“每任务 spawn 一个进程”在规范意义上是要避免的反模式；“每用户一个常驻进程池 + 显式任务句柄”才是被建议的形状。

### 4.2 超时

- SDK v1 默认单请求超时 **60s**（`DEFAULT_REQUEST_TIMEOUT_MSEC`，[protocol.js:8](../../node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js)），可按请求覆盖。
- SDK v2 每请求可给 `timeout`、`onprogress`、`resetTimeoutOnProgress`、`maxTotalTimeout`；有进度可重置计时，但必须有总上限（[Calling tools](https://ts.sdk.modelcontextprotocol.io/v2/clients/calling.html)）。
- 规范要求实现**应**为所有请求设超时，并**应**始终有最大超时（[Cancellation §Timeouts](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/cancellation#timeouts)）。
- 对“截图 → 视觉模型”这类长任务：需要“单步超时 + 任务总超时 + 进度续命”三层，且 UI 要能区分“还在跑”和“已失联”。

### 4.3 取消

| 传输 | 取消信号 | 备注 |
| --- | --- | --- |
| stdio | `notifications/cancelled`（带原请求 id） | 服务端**应**尽快停，且**不得**再发该请求的任何消息 |
| Streamable HTTP（2026） | **关闭该请求的 SSE 响应流** | 服务端**必须**把断连视为取消；不期望 `notifications/cancelled` |
| Streamable HTTP（2025） | 显式发 `notifications/cancelled` | 断连**不**等于取消 |

（[Cancellation](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/cancellation)、[HTTP 规范 Cancellation](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#cancellation)）
SDK v2 服务端把取消/断连落到 `ctx.mcpReq.signal`（AbortSignal），handler 要自己检查并传给 `fetch` 等 I/O；SDK 不会为已取消请求回包（[Logging, progress, and cancellation](https://ts.sdk.modelcontextprotocol.io/v2/servers/logging-progress-cancellation.html)）。v1 客户端则是 abort 传 `signal` → 发 `notifications/cancelled`（[protocol.js:705,737](../../node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js)）。

### 4.4 重连与恢复

- 2026：**没有** `Last-Event-ID`、没有事件 id、没有重放；流一断，请求就算丢，客户端用**新 id** 重发（[changelog 第 9 条](https://modelcontextprotocol.io/specification/2026-07-28/changelog)、[HTTP 规范](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#receiving-messages)）。意味着**工具调用要幂等或可去重**，否则重试会重复写入。
- 2025：可续传。v1 客户端默认重连策略是 1s 起、1.5 倍、上限 30s、最多 2 次，用 `Last-Event-ID` 续流（[streamableHttp.js:8-11,148-160](../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js)）。GET 通知流默认可重连；**POST 请求流只有在服务端先发过带 event id 的 priming 事件后才重连**，否则断流即请求失败（[streamableHttp.js:229-258](../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js)）。
- 进程重启后，`subscriptions/listen` 的订阅流必须重新建立（[stdio 规范](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio#unexpected-termination)）。
- 发现结果（server/discover）可以缓存以避免每次探测，但**不能跨用户共享**：它是“那个凭证看到的广告”，共享会误导能力判断（[Gateways](https://ts.sdk.modelcontextprotocol.io/v2/advanced/gateway.html)）。

### 4.5 长任务与确认

- 进度：请求内 `notifications/progress`；v2 服务端用 `ctx.mcpReq.notify`，客户端用 `onprogress`；进度值必须单调递增（[Progress](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/progress)、[Logging, progress, and cancellation](https://ts.sdk.modelcontextprotocol.io/v2/servers/logging-progress-cancellation.html)）。
- 敏感操作确认：2026 走 `input_required` + elicitation，客户端重试原请求并带 `inputResponses`；**若外部 AI 客户端不支持 elicitation，本应用不能指望用它做确认**，只能在自己的 Web UI 里先确认再发起（[input_required](https://ts.sdk.modelcontextprotocol.io/v2/servers/input-required.html)、[MRTR](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr)）。
- 2025 时代的 `sampling`/`roots`/`logging` 已在 2026-07-28 被标记 **deprecated**（至少 12 个月窗口），新实现不要采用（[changelog §Deprecated](https://modelcontextprotocol.io/specification/2026-07-28/changelog)）。

## 5. 客户端方向与服务端方向如何共存

1. **两个方向互不依赖**：出站 client 的凭证、超时、取消策略，与入站 server 的 token 校验、Origin 校验是两套配置，不要复用同一份令牌或同一个 transport 实例。
2. **一个进程可以既是 host 又是 server**：MCP 架构本身就是 host 管理多个 client，同时被别的 host 连接；但每个连接的信任边界独立（[Architecture](https://modelcontextprotocol.io/specification/2026-07-28/architecture)）。
3. **工具定义只维护一份**：本仓库已有 `src/tools/registry.mjs` 作为统一注册表，[mcp.mjs](../../src/platform/mcp.mjs) 从注册表生成工具；入站/出站都应从同一注册表生成，避免两套描述漂移（[08-工具与能力清单](../plan/08-工具与能力清单.md) 也这么要求）。
4. **不要做“透明代理”**：如果本应用把外部 Agent 的工具再转给外部 AI，就变成了 MCP proxy。proxy 有额外义务：按 client 做同意（confused deputy）、绝不转发上游 token、自己校验 audience（[Confused Deputy](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices#confused-deputy-problem)、[Token Passthrough](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices#token-passthrough)）。
5. **能力差异要显式处理**：2026 的 server 不能主动请求客户端，所以“让外部 AI 反向调用本应用工具”时，本应用只能作为 server 被动响应；反过来本应用作为 client 调外部 Agent 时，也不能假设对方会主动要确认。需要人确认的环节留在本应用 UI。

## 6. 风险与未知

- **SDK 版本风险（高）**：仓库钉在 v1 1.32.1 = 2025-11-25。若要用 2026-07-28 的新特性（无会话、MRTR、subscriptions/listen），必须升级到 v2 并接受包名/API 迁移；v1 只是“至少 6 个月”维护窗口，不是长期方案。
- **Windows 进程树（中高）**：SIGTERM/SIGKILL 对 `npx`/`cmd` 包装器可能只杀一层，规范点名 Job Object；现有 SDK 的 close 不解决孙进程。需要决策层面的兜底（超时强杀 + 进程组/Job），否则会留孤儿进程。
- **断流重试的重复副作用（中高）**：2026 无续传，重试是客户端责任；写操作（投递记录、批量导入）必须幂等或带去重键，否则“网络抖动”会变成“重复写入”。
- **多用户入站的令牌发放（未知）**：局域网里“外部 AI”怎么拿到某个用户的令牌，规范没有答案（它假设有 OAuth AS）。可选路径：每用户一次性配对码换 token、只允许本机 stdio、或引入 IdP；这需要地图层面拍板。
- **外部 AI 的宿主能力（未知）**：对方是否支持 elicitation/input_required、是否支持 2026-07-28、是否会保留长连接，都不由本应用决定；确认流程不能依赖对方能力。
- **云端 AI 的可达性（结构性约束）**：回环地址只有本机进程可达；云端/网页版 AI 要接本应用，需要公网可达的 HTTPS 端点（按规范还应做 OAuth 资源服务器），这与地图“本地 + 局域网、不含云端多租户”的边界直接冲突。
- **弃用窗口（低）**：sampling/roots/logging 有至少 12 个月弃用期；若现有实现依赖它们，需要迁移计划（日志改 stderr / OTel）。

## 7. 对地图意味着什么

- **协议时代必须先定**：现状（SDK 1.32.1）等于锁在 2025-11-25；2026-07-28 的能力（无会话、MRTR、按请求工厂）要 v2 2.4.0 才有。这不是实现细节，是 13 号票“适配契约”的前提。
- **出站建议“每用户常驻 stdio 进程池 + 显式任务句柄 + 单任务/总超时”**；不要按任务 spawn（规范不建议把进程绑到任务），也不要用一个进程服务多个用户（stdio 没有按请求身份）。
- **入站先走 stdio（现有桥）或回环 HTTP + 每请求 bearer token + Origin/Host 校验**；OAuth 2.1 只在“要接不特定/云端 AI”时引入，否则是纯负担。
- **多用户隔离写成不变量**：identity 只来自校验后的 token；状态句柄 `<user_id>:<handle>`；会话（若用 2025）不得当认证；token 不得代传。
- **长任务语义单独定**：进度用请求内 progress 流，取消用 abort/断流，断流后“重发”而非“续传”，所以写操作必须幂等或去重；敏感确认留在本应用 UI，不依赖外部 AI 的 elicitation。
- **双向共存但边界清晰**：同一注册表生成两边的工具定义；若将来做聚合/代理，先接受 confused-deputy 与“不转发 token”的额外约束。

### 地图需要拍板的决策

1. **D1 协议时代 / SDK 版本**：继续 2025-11-25（v1，短期省事）还是升级 v2 双时代（要 2026 能力、接受迁移）？
2. **D2 入站受众与位置**：外部 AI 只在本机（stdio）、局域网（回环/内网 + token）、还是要公网（必须 OAuth）？这决定是否引入 OAuth 2.1。
3. **D3 出站进程生命周期**：每用户常驻池（推荐）还是每任务短进程？并发上限与孤儿进程回收策略？
4. **D4 是否做聚合/代理**：只做 client 调外部 Agent，还是也把外部 Agent 的工具转给外部 AI（后者触发 proxy 安全义务）？
5. **D5 长任务恢复语义**：断流后重发的前提是幂等键/去重表；是否把它列为 15 号票（审计与批量撤销）的前置？

## 主要来源

- 规范 2026-07-28：<https://modelcontextprotocol.io/specification/2026-07-28>（[transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)、[stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)、[Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)、[authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)、[versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)、[changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)、[cancellation](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/cancellation)、[MRTR](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr)）
- 规范 2025-11-25：<https://modelcontextprotocol.io/specification/2025-11-25>（[lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)、[session management](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management)）
- 安全：[Security Best Practices 2026-07-28](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)、[2025-11-25 Session Hijacking](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices#session-hijacking)、[Authorization Security Considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)
- TypeScript SDK v2 文档：<https://ts.sdk.modelcontextprotocol.io/v2/>（[Serve over HTTP](https://ts.sdk.modelcontextprotocol.io/v2/serving/http.html)、[Sessions/state/scaling](https://ts.sdk.modelcontextprotocol.io/v2/serving/sessions-state-scaling.html)、[Require authorization](https://ts.sdk.modelcontextprotocol.io/v2/serving/authorization.html)、[Legacy clients](https://ts.sdk.modelcontextprotocol.io/v2/serving/legacy-clients.html)、[OAuth](https://ts.sdk.modelcontextprotocol.io/v2/clients/oauth.html)、[Calling](https://ts.sdk.modelcontextprotocol.io/v2/clients/calling.html)、[Protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.html)、[Gateway](https://ts.sdk.modelcontextprotocol.io/v2/advanced/gateway.html)）
- SDK v1（仓库当前）：[README](../../node_modules/@modelcontextprotocol/sdk/README.md)、[protocol.js](../../node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js)、[stdio.js](../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js)、[streamableHttp.js](../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js)
