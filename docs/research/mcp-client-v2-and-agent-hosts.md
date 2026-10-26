# MCP 客户端 v2 与外部 Agent 宿主适配契约（事实笔记）

> Wayfinder 研究票 [#13](https://github.com/Lumichelka/career-agent/issues/13)，父地图 [#12](https://github.com/Lumichelka/career-agent/issues/12)。
> 日期：2026-10-25。**只记事实，不写实现、不做产品决策、不改代码。**
> 标注约定：`已验证`＝一手文档/源码/规范写明；`未找到一手依据`＝本轮没取到可引的一手材料（不等于“不存在”）；`推断`＝由一手材料组合推出，已标明。
> 取证环境限制（影响可复现性）：`openai.com` / `developers.openai.com` 返回 Cloudflare 403；`github.com`、`raw.githubusercontent.com`、`cdn.jsdelivr.net` 在本机解析/TLS 校验失败，仓库内容改用 GitHub Contents API（`api.github.com`）与 unpkg 读取；`npmjs.com` 网页 403，版本信息取自 `registry.npmjs.org`。

## 0. 结论速览

1. **主流 Agent CLI 基本都不是 MCP server。** Claude Code、Codex CLI、Gemini CLI、GitHub Copilot CLI、Cursor、Zed、Goose、OpenHands 的现行一手文档里，MCP 一律是**客户端**方向；它们各自的“server 模式”是别的协议：ACP（Copilot `--acp`、Gemini `--experimental-acp`、Goose `goose serve`、OpenHands 的 ACP agent、Zed 把 MCP 转发给 ACP agent）、Codex 私有 `app-server`、Copilot SDK `--server`。
2. **能作为 MCP server 被 Node 应用当 client 连上的，本轮只核到两个非 CLI 产品**：Dify（把已发布应用暴露成 MCP Server，URL 内嵌凭证）与 Coze（官方 `coze-mcp-server`，stdio，`COZE_API_TOKEN`）。**Claude Code 的 `claude mcp serve` 在官方文档中找不到依据**（现行 CLI 参考与 MCP 文档只列客户端子命令）；但本机 2.1.207 二进制确有该隐藏子命令（见 §1.3），仅作实测入口，不作承诺支持。
3. **v2 客户端默认是 legacy**（`initialize`，逐字节等同 2025 行为）；`auto` 才会用 `server/discover` 探测并回退；`{pin}` 不回退，失败抛 `SdkError(ERA_NEGOTIATION_FAILED)`。
4. **`auto` 在 stdio 上有额外成本**：每次 `connect()` 会多 spawn 一个“一次性兄弟进程”跑探测（stderr 丢弃、探完回收），随后会话子进程才 spawn 一次；探测超时在 stdio 视为 legacy、在 HTTP 视为 `SdkError(REQUEST_TIMEOUT)`。
5. **v2 stdio 关闭链没有 Windows 进程树处理**：`stdin.end()` → 等 2s → `SIGTERM` → 等 2s → `SIGKILL`，源码里没有 Job Object / `taskkill /T` / 进程组；Windows 上 Node 的 `SIGTERM`/`SIGKILL` 只强制终止**那一个**进程 → 孙进程不回收（`推断`，见 §3）。
6. **legacy server 收到 modern 请求没有规定形态**：规范明说可能是实现自定义错误、沉默、或按 legacy 语义误处理；v1 SDK 服务端的实际形态是 **HTTP 400 + `-32000 "Bad Request: Server not initialized"`**，它**不是**可识别的 modern 错误，所以恰好触发 `auto` 回退。
7. **`auto` 回退失败面已可枚举**：pin / 无 pre-2026 版本 → `SdkError(ERA_NEGOTIATION_FAILED)`；HTTP 探测超时 → `SdkError(REQUEST_TIMEOUT)`；5xx → `SdkHttpError(ERA_NEGOTIATION_FAILED)`；401/403 → `SdkHttpError(CLIENT_HTTP_AUTHENTICATION/CLIENT_HTTP_FORBIDDEN)`；**同样是“400 + JSON-RPC 错误体”，legacy 连接抛 `SdkHttpError`，modern 连接是 in-band `ProtocolError`**。
8. **MRTR 客户端默认自动代跑**：`input_required` 由 SDK 用已注册的 `setRequestHandler` handler 自动补齐并重试，默认最多 10 轮，超限抛 `INPUT_REQUIRED_ROUNDS_EXCEEDED`；可 `autoFulfill:false`/`maxRounds`/单次 `allowInputRequired` 改行为。

## 1. 真实外部 Agent 的 MCP server 模式

判定口径：只认产品官方文档/官方仓库能证明“能被外部 MCP 客户端连上”的形态。**“Agent 能连 MCP server”不等于“Agent 是 MCP server”。**

| 产品 | 能作为 MCP server？ | 启动方式（官方文档/源码） | 传输 | 认证 | 协议时代（若有声明） |
| --- | --- | --- | --- | --- | --- |
| Claude Code | **未找到一手依据**（文档只有客户端） | 无 `claude mcp serve` 记录；`claude mcp` 子命令为 add/add-json/add-from-claude-desktop/list/get/remove/login/logout | — | — | 其 MCP **客户端** runtime 支持 v2/2026-07-28（`MCP_SDK_GENERATION`、`MCP_PROTOCOL_NEGOTIATION`） |
| Codex CLI | **否**（`codex mcp` 是“管理外部 MCP server”） | `codex app-server`（experimental）是私有协议服务端，非 MCP | app-server：stdio/`--listen stdio://`、`ws://`、`unix://`、`off` | 由 app-server 自身配置（非 MCP 授权） | app-server 与 MCP 协议无关 |
| Gemini CLI | **否** | `gemini mcp add/remove/list` 只管理“Gemini 去连的 server”；`--experimental-acp` 是 ACP 模式 | 客户端侧 stdio/SSE/HTTP | 客户端侧 | `未验证`（文档无 2026-07-28 声明） |
| GitHub Copilot CLI | **否** | `copilot mcp` 管理配置；`--acp`（ACP server）、`--server`（SDK server mode）都不是 MCP | 客户端侧 stdio/HTTP/SSE | 客户端侧 OAuth/静态 header/`oidc` | `未验证` |
| Cursor | **否**（文档只描述 Cursor 去连 server） | 无 server 模式记录 | — | — | `未验证` |
| Zed | **否** | MCP 是客户端；把已配置的 MCP server **经 ACP 转发**给 External Agents | — | — | `未验证` |
| Goose | **否**（`goose mcp <name>` 是“运行一个已启用的 MCP server”供 Goose 自己用；`goose serve` 是 ACP server） | `goose serve`（ACP，带 TLS/共享密钥） | ACP：本地子进程 + 远程 HTTP/HTTPS 后端 | ACP 自身（共享密钥 + 证书指纹） | `未验证` |
| OpenHands | **否**（MCP 是客户端；另提供 ACP **客户端**，spawn 别的 agent CLI） | — | — | — | `未验证` |
| Dify | **是** | 应用 → Access Point → MCP Server 卡片 → 生成唯一 MCP Server 地址 | 文档未写（只给 URL） | **URL 内嵌凭证**（“treat it like an API key”，可 regenerate） | 文档未写 |
| Coze | **是**（官方 `coze-mcp-server`，非 CLI 本体） | `uvx coze-mcp-server` / `python -m coze_mcp_server` / `docker run ghcr.io/coze-dev/coze-mcp-server` | **stdio** | `COZE_API_TOKEN` 环境变量或 `--coze-api-token` | 文档未写 |

### 1.1 逐个取证

- **Claude Code**：MCP 页面把 Claude Code 定义为客户端，只讲如何 `claude mcp add` 别人的 server（[MCP 文档](https://code.claude.com/docs/en/mcp)）；CLI 参考的 `claude mcp` 行也只写 “Configure Model Context Protocol (MCP) servers”，无 serve 子命令（[CLI reference](https://code.claude.com/docs/en/cli-reference)）；Agent SDK 页面同样只讲“给 agent 配 MCP server”（[Agent SDK MCP](https://code.claude.com/docs/en/agent-sdk/mcp)）。文档站点地图里与 MCP 相关的英文页只有 `mcp`、`mcp-quickstart`、`managed-mcp`、`agent-sdk/mcp`（[sitemap](https://code.claude.com/docs/sitemap.xml)）。→ **官方文档里没有 `claude mcp serve` 的一手依据**；二手文章提到它，本轮不作为事实引用；本机 2.1.207 二进制确有该隐藏子命令（见 §1.3）。
- **Codex CLI**：`codex mcp` 的帮助文案是 “Manage external MCP servers for Codex”，即客户端（[codex-rs/cli/src/main.rs](https://github.com/openai/codex/blob/main/codex-rs/cli/src/main.rs)）；MCP 运行时 crate 的 README 只描述“Codex 如何连 MCP server、怎么把 sandbox 元数据塞进 `_meta`”，没有 server 入口（[codex-rs/codex-mcp/README.md](https://github.com/openai/codex/blob/main/codex-rs/codex-mcp/README.md)）。**它自己的服务端是 `codex app-server`（experimental）**，支持 `--stdio` / `--listen stdio://`、`ws://host:port`、`unix://`、`off`（同上 main.rs），协议是 Codex app-server 协议，与 MCP 无关。
- **Gemini CLI**：`gemini mcp add/remove/list` 只用于配置 Gemini 要连的 server（[cli-reference.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/cli-reference.md)）；`--experimental-acp` 是 “Start in ACP (Agent Client Protocol) mode”，不是 MCP（同页）。MCP 文档通篇是“Gemini CLI 作为客户端发现/调用 server”（[mcp-server.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md)）。
- **GitHub Copilot CLI**：`copilot mcp` = “Manage MCP server configurations”（[CLI command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)）；同一页 `--acp` 的说明是 “Start as Agent Client Protocol server”，另有 `--server`（SDK server-mode）与 `--ahp-host`，托管策略说明里把 “interactive、-p、--acp、--ahp-host、--server” 并列为 session-hosting 模式 → **服务端方向存在，但不是 MCP**。
- **Cursor**：MCP 文档只描述 Cursor 连接外部 server（`mcp.json` 的 `url`/`headers`/OAuth），没有“Cursor 作为 MCP server”的入口（[cursor.com/docs/mcp](https://cursor.com/docs/mcp)）。
- **Zed**：文档把 MCP 定位为 Zed 的上下文服务；表格里写 “External Agents：Zed can forward configured MCP servers over ACP”，即 Zed 是 MCP 客户端 + ACP 转发方（[zed.dev/docs/ai/mcp](https://zed.dev/docs/ai/mcp)）。
- **Goose**：CLI 参考的 `mcp` 子命令是 “Run an enabled MCP server specified by `<name>`”（`goose mcp <name>`），是**消费**已有 server；`goose serve` 是 ACP server（“goose Desktop normally runs its own `goose serve` ACP server process”）（[goose-cli-commands.md](https://github.com/block/goose/blob/main/documentation/docs/guides/goose-cli-commands.md)、[remote-goose-server.md](https://github.com/block/goose/blob/main/documentation/docs/guides/remote-goose-server.md)）。
- **OpenHands**：其 MCP 文档只讲 “Agents can discover MCP-provided tools automatically”（[docs.openhands.dev/sdk/guides/mcp](https://docs.openhands.dev/sdk/guides/mcp)）；另有一等公民 ACP：Agent Server 把外部 agent CLI（Claude Code、Codex、Gemini CLI…）当 ACP 子进程 spawn（[docs/ACP_AGENTS.md](https://github.com/All-Hands-AI/OpenHands/blob/main/docs/ACP_AGENTS.md)）。
- **Dify**：明确“exposing your applications as MCP servers”，入口是 Access Point → MCP Server 开关，生成唯一地址；**该 URL 内含认证凭证**，泄漏等同 API key 泄漏；只给了 URL，未写传输类型与协议时代（[publish-mcp](https://docs.dify.ai/en/cloud/use-dify/publish/publish-mcp)）。
- **Coze**：官方仓库 `coze-dev/coze-mcp-server` 提供 `list_workspaces`、`list_bots`、`chat_with_bot`、`chat_with_workflow` 等工具，启动方式是 `uvx coze-mcp-server` / `python -m coze_mcp_server` / docker，**stdio**；令牌取 `COZE_API_TOKEN` 或 `--coze-api-token`（[README](https://github.com/coze-dev/coze-mcp-server)、[server.py](https://github.com/coze-dev/coze-mcp-server/blob/main/src/coze_mcp_server/server.py)）。注意这是“Coze 能力（bot/workflow）的 MCP 包装”，不是把 Coze 的 agent 本体当 MCP server。

### 1.2 由事实组合出的观察（`推断`）

- **Agent ↔ Agent 的事实标准是 ACP，不是 MCP。** Copilot `--acp`、Gemini `--experimental-acp`、Goose `goose serve`、OpenHands 的 ACP 客户端、Zed 的 ACP 转发，五处独立一手材料指向同一形状：宿主 spawn agent CLI，走 stdio JSON-RPC（ACP），而不是让 agent 暴露 MCP server。
- **Codex 走的是自研 app-server 协议（stdio/ws/unix）**，与 MCP 并列而非兼容。
- 因此“本应用作为 MCP 客户端连外部 Agent”在 2026-10 的可落地对象，主要不是 Agent CLI 本身，而是**把 Agent 能力包成 MCP server 的产品/包装器**（Dify 应用、Coze 包装器，或自建包装）。

### 1.3 本机实测补充（2026-10-25，非官方文档）

- 本机 `claude` 版本 **2.1.207**（`C:\Users\cccHaozz\.local\bin\claude.exe`）。`claude mcp --help` 的子命令列表**没有** `serve`，但 `claude mcp serve --help` 返回 `Start the Claude Code MCP server`（选项 `-d/--debug`、`--verbose`）。→ 该入口在 2.1.207 二进制中存在，但属于**未文档化/隐藏**入口；官方文档仍只有客户端方向。首条验收可作为本机实测对象，但不应写成“受支持的外部 Agent”。
- 本机是否可用、最终协商到哪个时代，以 #13 首条验收的实测记录为准；本笔记不预先断言。

## 2. v2 TypeScript SDK 客户端 API 事实

### 2.1 包与入口

- 包名/版本：`@modelcontextprotocol/client` **2.4.0**、`@modelcontextprotocol/server` **2.4.0**（[registry client](https://registry.npmjs.org/@modelcontextprotocol/client)、[registry server](https://registry.npmjs.org/@modelcontextprotocol/server)）。
- `client` 的 `engines.node` 是 **>=20**（registry 元数据），依赖含 `cross-spawn`、`eventsource`、`jose`、`zod@^4`、`@modelcontextprotocol/core`（同源）。
- 根入口是运行时中立的；**`StdioClientTransport` 只在 `@modelcontextprotocol/client/stdio` 子路径**，根入口的模块图不触达 `node:child_process`；v2 共 9 个公开包（client/server/core/node/express/hono/fastify/server-legacy/codemod）（[Packages](https://ts.sdk.modelcontextprotocol.io/v2/get-started/packages.html)）。

### 2.2 `Client` 怎么建、连上后能读什么

```ts
const client = new Client({ name: 'my-client', version: '1.0.0' }, options?);
await client.connect(transport, connectOptions?);
```

- 构造签名：`new Client(implementation, options?)`；`connect(transport, options?)`，`ConnectOptions = RequestOptions & { prior?: PriorDiscovery }`（[Connect](https://ts.sdk.modelcontextprotocol.io/v2/clients/connect.html)、[API: client](https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/client/client/client.html)）。
- 连上后可读：`getServerVersion()`、`getServerCapabilities()`、`getInstructions()`、`getProtocolEra()`（`'modern' | 'legacy'`，`connect()` 前是 `undefined`，之后不再变）、`getDiscoverResult()`（present=modern，absent=legacy）（[Connect](https://ts.sdk.modelcontextprotocol.io/v2/clients/connect.html)、[Protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.html)）。
- HTTP 断开要先 `transport.terminateSession()` 再 `client.close()`；`close()` 会把在途请求以 `CONNECTION_CLOSED` 拒绝（[Connect](https://ts.sdk.modelcontextprotocol.io/v2/clients/connect.html)）。

### 2.3 `versionNegotiation` 与 `probeClassifier`

`ClientOptions.versionNegotiation` 的取值（[Protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.html)、[API: versionNegotiation](https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/client/client/versionNegotiation.html)）：

| 取值 | 行为 |
| --- | --- |
| 缺省 或 `mode:'legacy'` | 跑 2025 `initialize`，**默认值**，无探测 |
| `mode:'auto'` | 先发 `server/discover` 探测；确定现代证据→modern；确定 legacy 或“无法识别”→回退 `initialize` |
| `mode:{ pin:'2026-07-28' }` | 只接受该版本，**永不回退** |

- `probe` 策略：`{ timeoutMs?, maxRetries? }`；`timeoutMs` 缺省继承客户端请求超时；`maxRetries` 缺省 0，**只作用于超时重发**，规范强制的 `-32022` 纠正性续发不计入（[Protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.html)）。
- `ProtocolOptions.supportedProtocolVersions` 决定探测报哪些 modern 版本；列表里**没有 pre-2026 项就没有 legacy 回退**，对 2025-only server 直接 `SdkError(ERA_NEGOTIATION_FAILED)`（同上）。
- `connect(transport, { prior })`：`{kind:'modern', discover}` 零往返采纳；`{kind:'legacy'}` 直接走 `initialize`。缓存 verdict 的“新鲜度”由宿主负责（stale legacy 会静默一直成功）（同上、[API: probeClassifier](https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/client/client/probeClassifier.html)）。
- `-32022` 的 `select-and-continue`：收到带互认 modern 版本的 `-32022` 时，客户端按服务端 `data.supported` 重发一次探测，并对第二次拒绝装 loop guard（[API: probeClassifier](https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/client/client/probeClassifier.html)）。
- **`probeClassifier` 是“导出的纯分类 API”，不是 `ClientOptions` 字段**：提供 `classifyProbeOutcome(outcome, context): ProbeVerdict`，以及 `ProbeOutcome`（`result` / `rpc-error` / `http-error` / `network-error` / `unusable-reply` / `auth-required` / `closed` / `timeout`）、`ProbeVerdict`（`modern` / `legacy` / `corrective` / `error`）、`ProbeClassifierContext`（含 `clientModernVersions`、`fallbackAvailable`、`transportKind`、`environment`）、`PriorDiscovery`（[API: probeClassifier](https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/client/client/probeClassifier.html)）。**未找到把它挂进 `Client` 的一手入口或示例**——v2 文档里没有 `probeClassifier:` 这样的 ClientOption，API 里也没有 `classifyProbeOutcome` 的调用示例。

### 2.4 `StreamableHTTPClientTransport` 选项

`new StreamableHTTPClientTransport(url, opts?)`（[API: streamableHttp](https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/client/client/streamableHttp.html)）：

| 选项 | 事实 |
| --- | --- |
| `requestInit.headers` | 每个请求都发，但**传输托管头优先**：`Authorization`（当 authProvider 给出 token 时）、`mcp-session-id`、`mcp-protocol-version`；因此调用方自带 `Authorization` 只在 provider 无 token 时生效（可作为“静态 API key → 之后升级 OAuth”的过渡） |
| `authProvider` | `AuthProvider \| OAuthClientProvider`；每次请求前调 `token()`；401 → `onUnauthorized()`（若有）刷新后**重试一次**；再 401 → `SdkHttpError(CLIENT_HTTP_AUTHENTICATION)`；未提供 `onUnauthorized` → `UnauthorizedError`；简单 bearer 就是 `{ token: async () => key }` |
| `sessionId` / `protocolVersion` | 复用旧会话时二者一起给；`protocolVersion` 用于继续发 `mcp-protocol-version` 头 |
| `reconnectionOptions` | `initialReconnectionDelay` 1000ms、`maxReconnectionDelay` 30000ms、`reconnectionDelayGrowFactor` 1.5、`maxRetries` 2（默认值） |
| `reconnectionScheduler` | 自定义重连调度器；返回的 cancel 会在 `transport.close()` 时调用 |
| `redirectPolicy` | 默认 `'same-origin'`（跨源或改方法的重定向直接失败）；`'follow'` 交给 fetch |
| `fetch` | 自定义 fetch |
| `onInsufficientScope` / `maxStepUpRetries` | 403 `insufficient_scope` 的 step-up 行为，默认 `'reauthorize'`，重试上限 1 |
| `skipIssuerMetadataValidation` | 仅 OAuthClientProvider 生效，跳过 RFC 8414 §3.3 issuer 回显校验（削弱安全） |

其它事实：`hasPerRequestStream = true`，即每个出站请求一条 POST(+SSE 响应流)，并在 2026 时代**用中止该请求的 SSE 流来表达取消**，而不是 POST `notifications/cancelled`（[API: streamableHttp](https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/client/client/streamableHttp.html)）；`resumeStream(lastEventId)` 与 `Last-Event-ID` 属于 legacy 面（同上）。

### 2.5 `StdioClientTransport` 选项与关闭行为

`StdioServerParameters`（[API: stdio](https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/client/client/stdio.html)、[源码 stdio.mjs](https://unpkg.com/@modelcontextprotocol/client@2.4.0/dist/stdio.mjs)）：

| 字段 | 事实 |
| --- | --- |
| `command`（必填）、`args` | 直接 spawn，`shell:false`；Windows 上 `windowsHide:true` |
| `env` | 未给时用 `getDefaultEnvironment()`：只继承白名单变量；win32 白名单为 `APPDATA/COMSPEC/HOMEDRIVE/HOMEPATH/LOCALAPPDATA/PATH/PATHEXT/PROCESSOR_ARCHITECTURE/PROGRAMDATA/PROGRAMFILES/PROGRAMFILES(X86)/PROGRAMW6432/SYSTEMDRIVE/SYSTEMROOT/TEMP/USERNAME/USERPROFILE/WINDIR`，且跳过以 `()` 开头的值 |
| `stderr` | 默认 `"inherit"`；`"pipe"`/`"overlapped"` 时 `stderr` getter 立刻返回一个 `PassThrough`（可在 start 前挂监听，避免丢早期错误输出）；其余值同 Node `spawn` 语义 |
| `cwd` | 透传 spawn |
| `maxBufferSize` | 读缓冲上限，默认 10MB；单条消息超限 → `onerror` 并 `close()` |
| `pid` / `stderr` getter | start 后可读 |
| `close()` | `stdin.end()` → 等 `close` 事件 **2s** → `SIGTERM` → 再等 **2s** → `SIGKILL`；随后清空 read buffer（stdio.mjs:181-205） |
| `send()` | 未连接时抛 `SdkError(NOT_CONNECTED)`（stdio.mjs:206-213） |

### 2.6 单请求选项：超时、进度、取消

`RequestOptions`（每个 verb 的第二参数）字段（[API: client](https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/client/client/client.html)、[Calling](https://ts.sdk.modelcontextprotocol.io/v2/clients/calling.html)）：

- `onprogress(update)`：接收该请求的 `notifications/progress`，不改变返回类型。
- `resetTimeoutOnProgress`（默认 false）：每收到进度就重置超时。
- `maxTotalTimeout`：绝对上限；**MRTR 自动补齐时它约束整个流程**，每次重试腿只拿到剩余时间。
- `timeout`：缺省 `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000`；超时抛 `SdkError(REQUEST_TIMEOUT)`。
- `signal: AbortSignal`：取消在途请求，`request()` 抛 `AbortError`。
- `allowInputRequired`（默认 false）：把 `input_required` 结果原样交回调用方（手工 MRTR 模式）。
- 另含 `TransportSendOptions`（`relatedRequestId`、`requestSignal` 等）。

取消的传输语义：2026-07-28 的 Streamable HTTP 用**关闭该请求的响应流**当取消信号；legacy（stdio / 2025 HTTP）用 `notifications/cancelled`（[Cancellation](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/cancellation)、[Protocol versions 矩阵](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.html)）。

### 2.7 `tools/list` 与 `server/discover` 的调用方式

- `client.listTools()`：不传 cursor 时 SDK **自动翻页聚合**并去掉 `nextCursor`；`ClientOptions.listMaxPages` 默认 64，翻不完抛 `SdkError(LIST_PAGINATION_EXCEEDED)`，`0` 取消上限；传 `{cursor}` 则只取该页原样返回。`listPrompts/listResources/listResourceTemplates` 同理（[Calling](https://ts.sdk.modelcontextprotocol.io/v2/clients/calling.html)）。
- `client.callTool({name, arguments})`：返回 `content` 与（声明了 `outputSchema` 时）`structuredContent`；`isError` 表示工具级失败；只有协议级失败（未知工具、超时）才抛（同上）。
- 缓存：`cacheMode: 'use'|'refresh'|'bypass'` 作用于四个 list verb 的无 cursor 聚合路径与 `readResource`（[API: client](https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/client/client/client.html)）。
- `client.discover(options?)` → `DiscoverResult`：`server/discover` 是**现代时代**的广告（`supportedVersions`、`capabilities`、`serverInfo`、`instructions`、`ttlMs`、`cacheScope`）；规范要求**服务端 MUST 实现**，客户端**可选**先调用；stdio 上的推荐用法正是“先探测再决定回退”（[Discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)、[Versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)）。

### 2.8 工具 annotations

`Tool.annotations?: ToolAnnotations`，字段与默认值：`title?`、`readOnlyHint?`（默认 false，“true 表示不修改环境”）、`destructiveHint?`（默认 true，**仅在 `readOnlyHint == false` 时有意义**）、`idempotentHint?`（默认 false，同上）、`openWorldHint?`（默认 true，“true 表示可能与开放世界的外部实体交互”）（[Schema §ToolAnnotations](https://modelcontextprotocol.io/specification/2026-07-28/schema#toolannotations)）。

规范的安全立场：**“For trust & safety and security, clients MUST consider tool annotations to be untrusted unless they come from trusted servers.”**（[Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)）——即 annotations 不能当授权依据。

### 2.9 收到 `input_required`（MRTR）时客户端怎么做

- 结果形状：`resultType:"input_required"`，`inputRequests?`（服务端分配、请求内唯一，值只能是 `ElicitRequest`/`CreateMessageRequest`/`ListRootsRequest`）、`requestState?`（不透明字符串）；二者至少有一个（[MRTR](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr)）。
- 规范强制的客户端行为：**MUST** 先构造被请求的输入再重试原请求；`requestState` 存在时**MUST 原样回显**、不得解析/修改；不存在时**MUST NOT** 自己加；两者只作用于“原请求的重试”，不得用于并行的其它请求（同上）。
- v2 SDK 默认行为：用**同一个** `setRequestHandler('elicitation/create' | 'sampling/createMessage' | ...)` 注册的 handler 在 `callTool` 内部自动补齐，然后带 `inputResponses` + **逐字节回显的 `requestState`**、**新请求 id** 重试；`callTool()` 的返回类型不变（[Handle server requests](https://ts.sdk.modelcontextprotocol.io/v2/clients/server-requests.html)、[API: client](https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/client/client/client.html)）。
- 轮次与开关：`ClientOptions.inputRequired = { maxRounds?: 10, autoFulfill?: true }`；超轮次抛 `SdkError(INPUT_REQUIRED_ROUNDS_EXCEEDED)`（`data.rounds`、`data.lastResult`）；`autoFulfill:false` 时首轮就拒，除非该次调用给 `allowInputRequired:true`（后者可用 `withInputRequired()` 同时给两种结果定型）（同上、[API: client](https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/client/client/client.html)）。
- 只对 2026 时代生效；2025 连接没有 `input_required` 词汇（同上）。

### 2.10 协商失败的错误类型/表现

区分三类错误（[API: client](https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/client/client/client.html)、[Protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.html)）：

- `SdkError`（字符串码，本地错误，从不上线）：`ERA_NEGOTIATION_FAILED`、`REQUEST_TIMEOUT`、`CONNECTION_CLOSED`、`METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION`、`INPUT_REQUIRED_ROUNDS_EXCEEDED`、`LIST_PAGINATION_EXCEEDED`、`UNSUPPORTED_RESULT_TYPE` 等。
- `ProtocolError`（数字 JSON-RPC 码，**在线上**，modern 连接上 in-band 送达）。
- `SdkHttpError`（带 HTTP status 的传输层拒绝）：`CLIENT_HTTP_AUTHENTICATION`（401）、`CLIENT_HTTP_FORBIDDEN`（403）、以及 5xx 探测失败时的 `ERA_NEGOTIATION_FAILED`。

pin 失败的原文：`ERA_NEGOTIATION_FAILED: Version negotiation failed: the server did not offer pinned protocol version 2026-07-28 via server/discover (no fallback in pin mode)`（[Protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.html)）。

## 3. Windows 进程树

### 3.1 v2 2.4.0 的事实

- `StdioClientTransport.close()` 只有 `stdin.end → 2s → SIGTERM → 2s → SIGKILL`（[源码 stdio.mjs:181-205](https://unpkg.com/@modelcontextprotocol/client@2.4.0/dist/stdio.mjs)）。`start()` 的 spawn 选项是 `shell:false`、`windowsHide: process.platform==='win32'`（同文件 74-87 行）。
- 在整个 `dist/stdio.mjs` 里搜不到 `taskkill`、`Job Object`、`detached`、进程组、`process.kill(-pid)` 之类的树形回收逻辑；探测兄弟进程的 `_dispose()` 也一样（`stdin.end → SIGTERM → 1s → SIGKILL`，然后 `destroy()` 三条管道，同文件 153-180 行）。
- Node 官方文档：Windows 上 POSIX 信号不存在，`subprocess.kill()` 收到 `SIGKILL`/`SIGTERM`/`SIGINT`/`SIGQUIT` 时**“terminate the process forcefully and abruptly”**（[child_process §subprocess.kill](https://nodejs.org/api/child_process.html#subprocesskillsignal)）——语义是终止**该进程**，不是进程树。
- SDK 用 `cross-spawn` 而不是原生 `spawn`；cross-spawn 在“命令不是可执行文件”（典型是 `node_modules/.bin/*.cmd`、`npx` 的 shim）时会**额外套一层 `cmd.exe /d /s /c "..."`**，即使 `shell:false`（[cross-spawn parse.js](https://unpkg.com/cross-spawn@7.0.6/lib/parse.js) 第 36-58 行）。

### 3.2 结论与缺口

- **已验证**：v2 官方文档、API 参考、源码都没有声称处理 Windows 孙进程，也没有 Job Object 相关代码或开关。
- **推断**：Windows 上以 `npx`/`.cmd` 启动的 MCP server 至少有两层进程（`cmd.exe` → 实际 node/可执行文件），`close()` 只终止直接子进程（常常是 `cmd.exe`），**孙进程会成为孤儿**；POSIX 同理（`SIGTERM` 只发给直接子进程）。这与旧笔记 §4.1 的判断一致（[mcp-client-orchestration.md](mcp-client-orchestration.md)）。
- **缺口（事实陈述）**：规范建议“客户端 SHOULD 关 stdin → 等退出 → 超时再强制终止；POSIX 从 SIGTERM 升级到 SIGKILL；Windows 可用 `TerminateProcess` **or Job Objects**”（[stdio §Shutdown](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio#shutdown)），而 v2 SDK 2.4.0 只实现了前两条里的信号部分、**未实现 Job Object**；即“进程树回收”必须由宿主自己做。

## 4. 降级序列的失败面

### 4.1 规范怎么说（2026-07-28）

- HTTP：客户端**先发一个 modern 请求**，只有 **400 Bad Request** 时才看 body 再决定——body 里是**可识别的 modern JSON-RPC 错误**（`UnsupportedProtocolVersionError`、`MissingRequiredClientCapabilityError`、header 校验失败）就说明对方是现代，**重试/纠正而不是回退**；body 为空或不可识别才回退 `initialize`（[Streamable HTTP §Backward Compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#backward-compatibility)）。
- stdio：用 `server/discover` 探测，**“任何不是可识别 modern 错误的失败”都回退**（[Versioning §Backward Compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)）。
- 兼容矩阵（modern 客户端 × legacy 服务端）原文：**“Fails. The server may reject the request with an implementation-defined error, stay silent, or even process an era-ambiguous method under legacy semantics. On stdio, clients SHOULD send `server/discover` first to fail deterministically; the client then surfaces an actionable error to the user.”**（同上）
- 现代时代的头校验：缺 `MCP-Protocol-Version`/`Mcp-Method`/`Mcp-Name` 或头体不一致 → **400 + `-32020 HeaderMismatch`**（[Request Metadata](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#request-metadata)）。这是一个“可识别的现代错误”，**不能**被当成回退信号。
- modern-only 服务端收到 `initialize` 时**SHOULD** 在错误里列出自己支持的版本（legacy 客户端没有 fall-forward）（[Versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)）。

### 4.2 legacy server 实际会返回什么

- **已验证（v1 SDK 1.32.1，本仓库 node_modules）**：`webStandardStreamableHttp.js` 对“未初始化就发非初始化请求”的响应是 **HTTP 400 + JSON-RPC `-32000` `Bad Request: Server not initialized`**（`createJsonErrorResponse(400, -32000, ...)`）。`-32000` 落在 JSON-RPC 规定的“实现自定义服务端错误”区间 `-32000…-32099`（[JSON-RPC 2.0 §5.1](https://www.jsonrpc.org/specification#error_object)），**不是**规范 2026-07-28 列出的现代错误 → 恰好符合“不可识别 → 回退”的判据。
- **推断**：这是 v1 SDK 的形状；其他 legacy 实现可能回别的实现自定义错误、直接沉默（HTTP 上等价于超时）、或把 `initialize` 之外的请求按 legacy 语义误处理；规范不保证统一形态。

### 4.3 SDK v2 在 `auto` 下的失败面（可直接写进契约）

| 场景 | 客户端看到 |
| --- | --- |
| stdio 探测超时 / 子进程退出 | 视为 legacy，回退 `initialize`（[Protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.html)） |
| stdio 探测被“不认 pre-initialize 请求”的 server 拒绝（rmcp/Rust SDK 会退出） | 同上，视为 legacy |
| HTTP 探测超时 | `SdkError(REQUEST_TIMEOUT)`（不误报 legacy） |
| HTTP 探测 2xx 但 body 不可用（非 JSON、裸 204、content-type 不对） | `SdkError(ERA_NEGOTIATION_FAILED)`，message 含 `unusable reply` |
| HTTP 探测 5xx | `SdkHttpError(ERA_NEGOTIATION_FAILED)` 并带 status |
| HTTP 探测 401 / 403 | `SdkHttpError(CLIENT_HTTP_AUTHENTICATION)` / `SdkHttpError(CLIENT_HTTP_FORBIDDEN)`；**403 `insufficient_scope`** 走 step-up，无 provider 时 `InsufficientScopeError` |
| 浏览器 CORS `TypeError` | 回退 legacy（唯一一个“网络错误当 legacy”的例外） |
| pin 模式、或 `supportedProtocolVersions` 无 pre-2026 项 | `SdkError(ERA_NEGOTIATION_FAILED)`，不回退 |
| 已建立 legacy 连接后，服务端回 **400 + JSON-RPC 错误体** | `SdkHttpError`（矩阵中 legacy 行的定义） |
| 已建立 modern 连接后，服务端回 **400 + JSON-RPC 错误体** | `ProtocolError`，**in-band** 送达（矩阵中 modern 行的定义） |
| 向 2025 peer 发 `server/discover`、向 modern peer 发 `ping` | 本地抛 `SdkError(METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION)`，`data` 带 `method`/`era`（矩阵里的 “Era-mismatched spec method (outbound)”） |

（上表来源：[Protocol versions 矩阵](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.html)、[2026-07-28 迁移指南](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28.html)、[API: probeClassifier](https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/client/client/probeClassifier.html)、[API: client](https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/client/client/client.html)）

### 4.4 额外事实（写契约时容易踩）

- **探测请求本身已带 `_meta` 信封**（protocolVersion/clientInfo/clientCapabilities），**在时代确定之前**。因此“看到 `_meta` 就判定 modern”是错的：legacy 回退路径也是从一个带信封的探测开始的；判定要以 `getProtocolEra()` / `getDiscoverResult()` 为准（[2026-07-28 迁移指南](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28.html)）。
- stdio 的“额外进程”是探测专用的兄弟进程：stderr 丢弃、探完回收；**会话子进程只 spawn 一次**，其线上永远不会出现 `server/discover`（同上、[Protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.html)）。
- SDK 文档明确不建议把“每次调用都 spawn 的 CLI 工具”默认成 `'auto'`：legacy server 不答未知 pre-initialize 请求时会把 `connect()` 卡满探测超时，并多一次 spawn（同上）。

## 主要来源

规范（2026-07-28）

- 版本与兼容：[Versioning and Compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
- [server/discover](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)
- [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)（含 Backward Compatibility、Request Metadata、`-32020`）
- [stdio transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)
- [Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)、[Schema §ToolAnnotations](https://modelcontextprotocol.io/specification/2026-07-28/schema#toolannotations)
- [MRTR（input_required）](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr)
- [Cancellation](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/cancellation)

TypeScript SDK v2（2.4.0）

- 文档：[Packages](https://ts.sdk.modelcontextprotocol.io/v2/get-started/packages.html)、[Connect](https://ts.sdk.modelcontextprotocol.io/v2/clients/connect.html)、[Calling](https://ts.sdk.modelcontextprotocol.io/v2/clients/calling.html)、[Handle server requests](https://ts.sdk.modelcontextprotocol.io/v2/clients/server-requests.html)、[Protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.html)、[2026-07-28 migration](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28.html)、[Serve over stdio](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio.html)、[Gateway](https://ts.sdk.modelcontextprotocol.io/v2/advanced/gateway.html)
- API：[client](https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/client/client/client.html)、[stdio](https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/client/client/stdio.html)、[streamableHttp](https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/client/client/streamableHttp.html)、[versionNegotiation](https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/client/client/versionNegotiation.html)、[probeClassifier](https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/client/client/probeClassifier.html)
- 包与源码：[registry: client](https://registry.npmjs.org/@modelcontextprotocol/client)、[registry: server](https://registry.npmjs.org/@modelcontextprotocol/server)、[dist/stdio.mjs](https://unpkg.com/@modelcontextprotocol/client@2.4.0/dist/stdio.mjs)

进程与平台

- [Node.js child_process §subprocess.kill](https://nodejs.org/api/child_process.html#subprocesskillsignal)
- [cross-spawn parse.js](https://unpkg.com/cross-spawn@7.0.6/lib/parse.js)
- [JSON-RPC 2.0 Error object](https://www.jsonrpc.org/specification#error_object)（`-32000…-32099` 为实现自定义服务端错误）

外部 Agent / 宿主

- Claude Code：[MCP](https://code.claude.com/docs/en/mcp)、[CLI reference](https://code.claude.com/docs/en/cli-reference)、[Agent SDK MCP](https://code.claude.com/docs/en/agent-sdk/mcp)、[sitemap](https://code.claude.com/docs/sitemap.xml)
- Codex：[codex-rs/cli/src/main.rs](https://github.com/openai/codex/blob/main/codex-rs/cli/src/main.rs)、[codex-rs/codex-mcp/README.md](https://github.com/openai/codex/blob/main/codex-rs/codex-mcp/README.md)
- Gemini CLI：[cli-reference.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/cli-reference.md)、[tools/mcp-server.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md)
- GitHub Copilot CLI：[CLI command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)、[CLI config dir reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference)
- Cursor：[Model Context Protocol](https://cursor.com/docs/mcp)
- Zed：[MCP](https://zed.dev/docs/ai/mcp)
- Goose：[goose-cli-commands.md](https://github.com/block/goose/blob/main/documentation/docs/guides/goose-cli-commands.md)、[remote-goose-server.md](https://github.com/block/goose/blob/main/documentation/docs/guides/remote-goose-server.md)
- OpenHands：[MCP](https://docs.openhands.dev/sdk/guides/mcp)、[docs/ACP_AGENTS.md](https://github.com/All-Hands-AI/OpenHands/blob/main/docs/ACP_AGENTS.md)
- Dify：[MCP Server](https://docs.dify.ai/en/cloud/use-dify/publish/publish-mcp)
- Coze：[coze-mcp-server README](https://github.com/coze-dev/coze-mcp-server)、[server.py](https://github.com/coze-dev/coze-mcp-server/blob/main/src/coze_mcp_server/server.py)

本仓库相关

- [package.json](../../package.json)（`@modelcontextprotocol/sdk` 1.32.1）、[node_modules/.../server/webStandardStreamableHttp.js](../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js)、[node_modules/.../client/stdio.js](../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js)
- 旧笔记：[mcp-client-orchestration.md](mcp-client-orchestration.md)、[mcp-host-remote-support.md](mcp-host-remote-support.md)
