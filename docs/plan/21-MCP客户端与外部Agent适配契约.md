# 21 · MCP 客户端与外部 Agent 适配契约

> Wayfinder 票 [#13](https://github.com/Lumichelka/career-agent/issues/13) 的决议稿；父地图 [#12](https://github.com/Lumichelka/career-agent/issues/12)。
> 日期：2026-10-25。状态：**决策已定，不写代码**；实现拆分留给 `/to-spec`。
> 输入：#19（传输/认证/生命周期研究）、#20（协议时代与 SDK）、#21（入站位置）、#22（聚合/转发）、#15（审计/撤销）。
> 研究依据：[mcp-client-orchestration.md](../research/mcp-client-orchestration.md)、[mcp-client-v2-and-agent-hosts.md](../research/mcp-client-v2-and-agent-hosts.md)、[write-audit-and-undo-model.md](../research/write-audit-and-undo-model.md)。

## 0. 范围与不变量

**覆盖**：本应用作为 MCP **客户端**连外部 MCP server 的配置、连接、发现、认证、调用、进度、取消、结果、证据；以及 L1 聚合与 L2 转发的客户端部分。

**不覆盖**：模型 API 的路由/回退/成本（#17）；多用户模型 Key 与浏览器登录隔离（#14）；审计表与撤销实现（#15）；入站端点与凭据（#21）；面板布局（#18/#23/新原型票）。

**不变量**（实现必须逐条满足）：

1. 身份只来自用户配置与验证过的凭据；不把会话、`clientInfo`、URL 参数或上游自报当授权。
2. 上游 token 不写日志、不进 task trace、不回传、不转发给第三方；第三方 token 只认证它自己。
3. 连接、发现结果、缓存、凭据按 `user_id` 隔离，不跨用户共享。
4. 一条连接建立后**时代钉住**（modern / legacy）；只有重连才重新协商。
5. modern 下无会话、无 `initialize`、无服务端主动请求；交互只走 MRTR（§9）。
6. 断流不续传；重发是新 request id；写操作必须幂等或有去重（§8）。
7. 工具注解不可信；`readOnlyHint` 只用于分级，不作为授权依据。
8. 敏感写入只在本应用 UI 用 `confirm_id` 确认；出站 client 永远无法代替用户确认。
9. stdio 仅实例 `owner` 可配；子进程不继承服务器密钥；`cwd` 锁在该用户目录。
10. 本契约是 v2 迁移与出站实现的唯一口径；与本研究笔记冲突时以笔记的一手事实为准并回改本文。

## 1. 术语

| 术语 | 含义 |
| --- | --- |
| 外部 Agent / 上游 | 任何可被 MCP 连上的 server；可以是 Dify 应用、Coze 包装器、自建包装，或 `claude mcp serve` 这类未文档化入口。不特指 Agent CLI 本体。 |
| 出站 | 本应用作为 MCP client 连上游。 |
| 入站 | 外部 AI 经本应用 `/mcp` 连进来（#21）。 |
| 转发 / 聚合 | 把上游工具再暴露给第三方 AI（#22）；聚合 = 让本应用自己的循环能用上游工具。 |
| 时代 | `modern` = 2026-07-28；`legacy` = 2025-11-25 及更早（`initialize` 握手）。 |
| 探测 | `auto` 协商先发的 `server/discover`（stdio 在一次性兄弟进程中）。 |
| 上游写 | 上游工具 annotations 不是 `readOnlyHint: true`。 |
| 本地写 | `src/tools/registry.mjs` 中 `permission: 'write'` 的本应用工具。 |

## 2. 协议与 SDK

- 依赖：`@modelcontextprotocol/client` **2.4.0** 与 `@modelcontextprotocol/server` **2.4.0**；`engines` 仓库维持 `>=23`。不再基于 `@modelcontextprotocol/sdk` 1.32.1 写新代码。
- 客户端构造：`new Client({name, version}, options)`；`versionNegotiation` **只允许 `{mode: 'auto'}`**（缺省 legacy 等于白升；`pin` 会把未跟上的上游变成硬失败）。
- `auto` 的降级序列（以研究笔记 §4 为准）：
  1. 先探测：stdio 用一次性兄弟进程跑 `server/discover`；HTTP 先发一个 modern 请求。
  2. 得到确定的 modern 证据 → 采用 modern；`getDiscoverResult()` 有值。
  3. 确定 legacy 或“不可识别” → 回退 `initialize`；`getProtocolEra() === 'legacy'`。
  4. 纠正性 `-32022` 按 SDK 语义重发一次，并装 loop guard。
  5. HTTP 上 **400 + 可识别的 modern JSON-RPC 错误**不是回退信号；按 modern 纠正/重试或失败。
- 连接建立后记录：`getProtocolEra()`、`getServerVersion()`、`getServerCapabilities()`、`getDiscoverResult()`（有/无）、协商耗时。这些进入连接状态与证据。
- **`probeClassifier` 不是 ClientOption**：它是导出的纯分类 API（`classifyProbeOutcome`）。契约不依赖它做自动回退；只有将来需要自定义探测结果分类时才单独用。
- `auto` 的成本已知并接受：stdio 每次 `connect()` 多 spawn 一次探测兄弟进程（stderr 丢弃、探完回收），会话子进程只 spawn 一次；因此连接要懒建、常驻、空闲回收（§4），不能每次工具调用都重连。
- 不支持：HTTP+SSE(2024-11-05)、WebSocket、OAuth 2.1/DCR/step-up、断流续传（`Last-Event-ID`）、legacy 的 `sampling`/`roots` 主动请求（modern 用 MRTR，见 §9）。
- 入站同批迁移：`src/platform/mcp.mjs` 改 v2 `serveStdio`（双时代，按连接钉住）；现有 legacy Codex 桥必须仍可用。迁移顺序见 §12。

### 2.1 协商失败面（映射到 §8 错误码）

| 场景 | 客户端看到 | 契约处理 |
| --- | --- | --- |
| stdio 探测超时 / 子进程退出 | 视为 legacy，回退 `initialize` | 记录“探测失败→legacy”；不算错误 |
| stdio 探测被“不认 pre-initialize 请求”的 server 拒绝 | 同上 | 同上 |
| HTTP 探测超时 | `SdkError(REQUEST_TIMEOUT)` | `REQUEST_TIMEOUT`，可重试一次 |
| HTTP 探测 2xx 但 body 不可用 | `SdkError(ERA_NEGOTIATION_FAILED)` | `ERA_NEGOTIATION_FAILED`，不重试 |
| HTTP 探测 5xx | `SdkHttpError(ERA_NEGOTIATION_FAILED)` | 同上，可重试一次 |
| HTTP 探测 401 / 403 | `SdkHttpError(CLIENT_HTTP_AUTHENTICATION/FORBIDDEN)` | `AUTH_FAILED`，不重试 |
| 已建立 legacy 连接后收到 400 + JSON-RPC 错误体 | `SdkHttpError` | `UPSTREAM_ERROR` |
| 已建立 modern 连接后收到 400 + JSON-RPC 错误体 | in-band `ProtocolError` | `UPSTREAM_ERROR` |
| 向 2025 peer 发 `server/discover` 等错配方法 | `SdkError(METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION)` | 实现 bug，记 `PROTOCOL_ERROR` |

## 3. 配置模型（每用户）

**存储**：非密配置放 `users/<user_id>/.data/agents.json`；密钥放该用户的 `KeyVault`（AES-256-GCM，`users/<user_id>/.data`）。不设实例级共享 Agent 配置。

```text
Agent {
  id            uuidv7
  name          显示名，1–40 字，用户内唯一
  transport     'stdio' | 'http'
  stdio         { command, args[], cwd? }        // 仅 owner
  http          { url }                          // 只允许 Streamable HTTP
  enabled       boolean
  mrtr          { sampling: boolean, elicitation: boolean }  // 默认 true
  createdAt / lastConnectedAt / lastEra / lastError
}
```

约束：

- **stdio 仅 `owner`**：非 owner 的 UI 不显示该选项，API 也拒绝（400）。理由：stdio 等价于以服务器 OS 身份执行用户命令，多用户下会跨用户读文件。
- stdio 的 `command` 必须是绝对路径或 PATH 可解析的可执行名；`args` 是数组，`shell: false`，不拼接字符串。
- stdio 子进程环境 = SDK 的 `getDefaultEnvironment()` 白名单 + 该用户配置的变量；**绝不继承** `CAREER_*`、模型 Key、bridge token、代理设置。`cwd` 默认该用户的 `users/<id>`，不允许指向其他用户目录或仓库根。
- HTTP URL：协议/主机校验复用 `src/model/providers.mjs` 的 `validateEndpoint` 语义——公网必须 HTTPS；本机/私网 HTTP 需显式勾选“允许局域网 HTTP”。URL 的用户信息或查询串视为凭据：整条 URL 存 vault，UI 只显 `scheme://host[:port]/path…`。
- HTTP 认证：静态 bearer/header 走 `authProvider = {token: async () => key}`（v2 传输托管的 `Authorization` 优先）；其他自定义头（如 `X-API-Key`）也存 vault，运行时注入 `requestInit.headers`。不实现 OAuth；遇到 401 + OAuth 发现直接报“本应用不支持 OAuth，请改用静态 token/header”。
- 每用户最多 **10** 个 Agent；名称冲突拒绝。
- “测试连接”只做 connect + 发现，不调用任何工具；结果写回 `lastConnectedAt/lastEra/lastError`。
- 首用提示：第一次真正调用某 Agent 时提示一次——“该 Agent 的工具会看到你交给它的内容；上游写与远端副作用不可撤销”。

## 4. 连接与生命周期（D3）

- **一条连接 per `(user, agent)`**，懒连接：第一次调用时 `connect()`；空闲 **30 分钟** close；下次调用重连。
- **并发**：每用户最多 **2** 个在途上游调用，全局最多 **8** 个；超出 FIFO 排队，排队等待上限 **120s**，超时 `QUEUE_TIMEOUT`。同一连接内多路复用。
- **断线与重连**：stdio 子进程退出或 HTTP transport 断开 → 连接标记 `disconnected`；下一次调用按退避重连（1s → 5s → 30s，最多 3 次/10 分钟）；仍失败标记 `failed`，需手动“重试连接”或下一次任务再试。
- **进程树回收（硬要求，不依赖 SDK）**：v2 `StdioClientTransport.close()` 只有 `stdin.end → 2s → SIGTERM → 2s → SIGKILL`，无 Job Object；Windows 上 `SIGTERM/SIGKILL` 只终止直接子进程，`npx`/`.cmd` 会留下孤儿。
  - Windows：创建 Job Object（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`），把子进程加入；关闭时 `TerminateJobObject`。拿不到 Job 时 fallback `taskkill /PID <pid> /T /F`。
  - POSIX：`detached: true` + `process.kill(-pid, 'SIGTERM')` → 2s → `SIGKILL`。
  - 空闲回收、任务取消、总超时、进程退出都走同一 kill 路径；日志记录 `pid` 与回收结果。
- **健康**：modern 无 `ping`；以 `tools/list` 成功作为连接健康。只有 transport error / 子进程退出才判死并重连；单次工具失败不重连。

## 5. 能力发现与命名空间

- 连接后立即 `listTools()`；SDK 自动翻页聚合（`listMaxPages` 默认 64，翻不完 `LIST_PAGINATION_EXCEEDED`）。
- **缓存 per `(user, agent)`**：TTL **10 分钟**；任务开始时 pin 一份快照，任务内不因上游增删工具而变化，避免长任务中途工具面漂移；下一个任务重新发现。
- 刷新触发：TTL 到期、用户点“刷新工具”、调用返回未知工具（`-32601`/`METHOD_NOT_FOUND`）时 refresh 一次并重试一次。
- **命名**：`mcp__<agentId>__<toolName>`。
  - `agentId` 是用户可读 slug（`a-z0-9_-`，1–24，冲突加 `-2`）。
  - `toolName` 保留原始字符；超过 96 字符截断并加 8 位哈希；总长 ≤ 128。
  - 本地工具永远在前，上游按 Agent 名称排序；前缀保证不与本地撞名。
- 注解快照：`readOnlyHint`（缺省 `false`）、`destructiveHint`（缺省 `true`）、`idempotentHint`（缺省 `false`）、`openWorldHint`（缺省 `true`）；**只用于分级，不作为授权**。
- 发现失败即连接失败，按 §8 报错；不返回半截列表。

## 6. 认证与凭据

- stdio：凭据只通过环境变量注入；stdout 只允许协议消息，日志走 stderr（`stderr: 'pipe'` 并接到任务日志，截断）。
- HTTP：`authProvider` 每请求取 token；401 不自动刷新（无 OAuth），标 `AUTH_FAILED`；403 标 `AUTH_FAILED`（权限）。
- Dify 这类“URL 内嵌凭证”的上游：URL 整体存 vault；错误消息、trace、证据、日志一律脱敏。
- 任何上游 token 都不得出现在：模型提示词、任务 trace、evidence 文件、前端状态、错误消息。
- 不实现 token passthrough：转发给第三方 AI 的只有本应用自签 client 凭据，上游 token 永不外传。

## 7. 调用、进度、取消

- 请求：`callTool({name, arguments}, {timeout, signal, onprogress, resetTimeoutOnProgress: true, maxTotalTimeout})`。
- **超时三层**：
  - 单次调用默认 **60s**（SDK 默认）；可按工具覆盖（上游工具没有 registry 的 `timeoutMs`，统一 60s；长任务类工具可单独配置，上限 300s）。
  - 任务总 **8 分钟**（与现有 Codex 子进程上限一致）；`maxTotalTimeout` 取任务剩余时间。
  - 进度续命只重置 idle 计时，不突破总上限（`resetTimeoutOnProgress: true` + `maxTotalTimeout`）。
- **进度**：`onprogress` → 事件 `{type:'tool_progress', taskId, agentId, tool, progress, total?, message?}`；progress 必须单调递增（回退值丢弃）；无 `total` 时 UI 显示不确定进度；节流 ≥200ms。
- **心跳**：沿用现有 15s `heartbeat`；90s 无任何事件（心跳除外）→ UI 标“可能失联”，但服务端不主动杀任务（除非总超时）。
- **取消**：UI 停止 / 任务超时 → `AbortSignal`。
  - modern HTTP：SDK 关闭该请求的响应流即取消。
  - legacy stdio / legacy HTTP：发 `notifications/cancelled`。
  - 2s 内未结束：stdio 杀进程树，HTTP 丢弃连接；不等待上游确认。
  - 取消后结果丢弃，记 `CANCELLED`；不把取消当成功。
- **重试**：只对“连接建立/探测失败”自动重试（退避）；**已发出的调用不自动重试**。写调用见 §8。

## 8. 结果、证据、写与幂等

### 8.1 统一信封

模型、UI、审计看到同一份结构：

```text
{
  status: 'ok' | 'error',
  data?: <归一化后的内容>,
  error?: { code, message, recovery },
  evidence: {
    actorType: 'external_agent',
    agentId, tool, requestId, at, era, durationMs
  },
  truncated?: true,
  assets?: [{ id, type: 'image'|'resource', uri }]
}
```

- `status:'ok'` 但上游 `isError: true` → 转成 `status:'error', code:'TOOL_ERROR'`，保留上游 message。
- `confirm_required` 只可能来自**本地写工具**（#15），不来自上游。

### 8.2 内容归一化

- `text` 块按序拼接。
- `image` / `resource` 块：存为该任务的证据资产（`users/<id>/tasks/<taskId>/evidence/`），模型只看到 `〔图片/资源已存为证据 #id〕` 占位。
- 单次给模型/界面的文本上限 **64KB**，超出截断并置 `truncated: true`。
- 完整 MCP 响应原文写证据文件（≤1MB）；超过再截断并标记。
- SDK 读缓冲上限 10MB；单条消息超限会关闭连接 → 记 `RESULT_TOO_LARGE`，不重试。

### 8.3 错误码

| code | 触发 | recovery |
| --- | --- | --- |
| `CONNECT_FAILED` | spawn 失败、网络不可达、DNS/TLS | 检查命令/URL/网络，重试连接 |
| `AUTH_FAILED` | 401/403 | 更新 token/header |
| `ERA_NEGOTIATION_FAILED` | 探测不可识别、pin 失败 | 确认上游是否支持 MCP；换传输 |
| `REQUEST_TIMEOUT` | 单次/总超时 | 缩小输入或提高单次超时 |
| `CANCELLED` | 用户停止/总超时 | 无需恢复 |
| `UPSTREAM_ERROR` | `ProtocolError`/`SdkError`/上游明确错误 | 查看上游日志；换工具 |
| `TOOL_ERROR` | `isError: true` | 按上游 message 修正参数 |
| `UNSUPPORTED` | MRTR 被禁用/超过轮次/需要的能力未实现 | 在外部 Agent 侧完成该步骤 |
| `QUEUE_TIMEOUT` | 排队 >120s | 稍后重试或减少并发 |
| `RESULT_TOO_LARGE` | 响应 >10MB | 让上游缩小返回 |
| `INVALID_RESULT` | 结果结构不符合 MCP schema | 报告上游；不重试 |

### 8.4 上游写

- 判定：`annotations.readOnlyHint === true` → 只读；**其余（含缺省、缺注解）一律按写**。
- 本应用循环直接调用非敏感上游写：允许，记 trace + 外部调用事件（#22 接受风险）；不额外弹确认，因为不改本地数据。
- 转发 client 调上游写：同规则；本地写仍走 `confirm_id`。
- 远端副作用不可撤销；UI 在首次调用时提示。
- **术语澄清**：#22 里的“敏感类”指本应用的四类敏感本地数据（#15）；上游写不落本地库，不套用本地敏感矩阵。上游写的风险由首用提示 + 外部调用事件承担。

### 8.5 幂等

- **本地写工具**（#15）：参数 `idempotencyKey`；外部 Agent 缺键 → `400 MISSING_IDEMPOTENCY_KEY`；内部循环按 `task_id + 步骤 + tool` 生成；7 天去重表、同键同指纹重放。
- **上游写**：若上游工具 schema 含 `idempotencyKey` 或 `idempotency_key`，透传我们的键；否则标记 `retryable: false`，断流后不自动重发（避免远端重复副作用），evidence 记 `idempotency: 'upstream_unsupported'`。
- 读取类调用可安全重试一次（仅限未收到任何响应字节时）。

## 9. MRTR（`input_required`）

已定：**自动用本应用模型/表单补齐**（不是拒绝，也不依赖外部 Agent 的确认）。

- SDK 配置：`ClientOptions.inputRequired = {autoFulfill: true, maxRounds: 3}`；每次调用默认不单独开 `allowInputRequired`。
- 注册三个 handler：
  1. `sampling/createMessage`：用该用户当前配置的模型（API 或 Codex）补全。
     - 固定 system 约束：“你是被外部 Agent 请求补全的模型；只回答请求内容，不调用工具，不读取本地数据。”
     - `maxTokens` 取 `min(请求值, 2048)`；单次 ≤30s，计入任务总时长。
     - 请求里若带 `tools`，返回 `UNSUPPORTED`（不为上游跑工具循环）。
     - 首次对某 Agent 采样前弹一次“将使用你的模型，可能产生费用”的提示；`mrtr.sampling=false` 时直接拒绝。
     - 用户未配置模型 → `SAMPLING_UNAVAILABLE`，不静默降级。
  2. `elicitation/create`：在聊天页弹表单，标题“来自 <agent> 的请求”；按 `requestedSchema` 渲染；用户可提交/拒绝/取消；5 分钟超时；**不预填**任何用户数据；`mrtr.elicitation=false` 时拒绝。
  3. `roots/list`：只返回该用户的 `users/<id>` 一个根，名称“职向数据目录”；不返回其他用户目录、仓库根或系统盘。
- 安全：MRTR 请求是任务数据，不是指令；不得因它改变工具权限、凭据或确认流程；不得把 `confirm_id`、token 或敏感正文交给上游。采样请求内容写 task evidence（截断）。
- 失败：轮次超限（`INPUT_REQUIRED_ROUNDS_EXCEEDED`）→ `UNSUPPORTED`；用户拒绝 → 上游收到 decline/cancel；模型未配置 → `SAMPLING_UNAVAILABLE`。
- **明确**：本应用自己的敏感写确认（#15 的 `confirm_id`）永远走本应用 UI，**不**通过 MRTR 的 elicitation 承载。

## 10. 入站转发（L2）的客户端契约

- 合并列表 = 本地 registry + 该用户所有 `enabled` 的上游工具（含写），命名同 §5。
- 转发开关是用户级；首次签发 client 凭据即同意，记录当时工具集快照（#21）；扩权不重问，UI 提示。
- 转发调用来源标 `forwarded_client` + client id；上游 token 绝不回传给第三方；第三方 token 只认证它自己。
- 转发写按 §8.4；本地写仍走 `confirm_id`；转发不能绕过确认。
- 入站 `ListTools` 每次按当前合并列表返回；“任务内不变”的快照只约束本应用循环的任务，不约束入站列表。

## 11. 首条验收

- **对象**：本机 Claude Code `claude mcp serve`（2.1.207；官方文档未列，属未文档化入口，仅作实测，不写成“受支持”）。
- **备选**：失败则 Coze `uvx coze-mcp-server`（stdio，需 `COZE_API_TOKEN`）；再失败则 Dify 应用 MCP Server（HTTP，URL 内嵌凭证）。
- **步骤**：完成 §12 的 v2 迁移后，以 owner 配置 stdio Agent `command = claude`、`args = ["mcp","serve"]` → `auto` 连接 → 记录 `getProtocolEra()`、`getDiscoverResult()` 有无、`serverInfo`、工具名列表（脱敏）、一次只读工具调用结果。
- **通过标准**：连接成功；工具列表非空；`getProtocolEra()` 有值（modern 或 legacy 均可）；一次只读调用返回结构合法的结果。若 modern 探测被拒、回退 legacy 成功，也算通过，但必须在证据里写明“回退到 legacy”。
- **失败标准**：connect 抛错且退避重试 3 次仍失败；或工具列表为空；或只读调用返回 `INVALID_RESULT`。
- **证据**：写进 #13 的验收评论（日期、版本、era、工具数、错误码、脱敏摘要），并回填地图。

## 12. 迁移与实现顺序

1. **换依赖**：`@modelcontextprotocol/client` / `server` 2.4.0；移除 `@modelcontextprotocol/sdk`（若测试临时需要，只放 devDependencies）。
2. **迁入站**：`src/platform/mcp.mjs` → v2 `serveStdio`（双时代，按连接钉住）；工具定义仍来自 `src/tools/registry.mjs`；handler 逻辑不变。
3. **现网回归**：Codex 桥端到端（对话触发 platform 工具）+ `npm test` 相关套件 + `npm run check`。
4. **出站模块**：连接池、配置存储、发现/缓存、调用/进度/取消、结果归一化、MRTR handler、并发队列；新增文件（如 `src/agent/mcp-client.mjs`，最终命名由实现定）。
5. **契约测试**：本地 mock MCP server 覆盖 modern/legacy/协商失败/401/超时/取消/大结果/MRTR 三类/上游写。
6. **首条验收**（§11）。
7. **回滚点**：迁移 commit 可整体 revert；出站功能在没有 Agent 配置时不激活，不影响现有链路。

## 13. 明确不做

- OAuth 2.1、DCR、step-up、token passthrough。
- HTTP+SSE(2024-11-05)、WebSocket、stdio 之外的本地传输。
- 断流续传（`Last-Event-ID`）；legacy 的 `sampling`/`roots` 主动请求。
- 每用户任意 stdio 命令（#14 再议）；非 owner 的 stdio 包装器（如 Coze）本轮不可配。
- 跨用户共享连接、缓存、凭据或发现结果。
- 远端副作用撤销（只记录发起，UI 明示）。
- 对已发出的上游写自动重试（上游无幂等键时）。
- 自动发现局域网 MCP server（只支持手动配置）。

## 14. 实现检查清单

- [ ] `auto` 协商；记录 era / discover；失败面按 §2.1 映射。
- [ ] 懒连接 + `(user, agent)` 唯一 + 空闲 30 分钟回收 + 退避重连。
- [ ] Windows Job Object / POSIX 进程组回收；取消、超时、空闲、退出共用 kill 路径。
- [ ] per-user 发现缓存 TTL 10 分钟 + 任务快照。
- [ ] `mcp__<agent>__<tool>` 命名、slug 冲突、长度截断。
- [ ] KeyVault 存 env/header/URL 凭证；日志、trace、evidence、UI 全链路脱敏。
- [ ] 并发 2/8 + FIFO + 120s 排队上限。
- [ ] 单次 60s / 总 8 分钟 / 进度续命 / 取消链。
- [ ] 统一信封 + 64KB 截断 + 证据资产 + 1MB 证据文件。
- [ ] MRTR sampling/elicitation/roots；费用提示；per-agent 开关；未配置模型的失败面。
- [ ] 上游写 `readOnlyHint` 分级；幂等透传或 `retryable:false`。
- [ ] 入站合并列表 + 同意快照 + 不转发 token。
- [ ] 迁移回归 + 首条验收证据。

## 15. 依据

- 研究：[mcp-client-orchestration.md](../research/mcp-client-orchestration.md)（传输、认证、生命周期、断流语义）；[mcp-client-v2-and-agent-hosts.md](../research/mcp-client-v2-and-agent-hosts.md)（v2 API、`auto` 探测、Windows 缺口、失败面、真实 MCP server 宿主）；[write-audit-and-undo-model.md](../research/write-audit-and-undo-model.md)（幂等/审计/确认）。
- 决议：[#20](https://github.com/Lumichelka/career-agent/issues/20)、[#21](https://github.com/Lumichelka/career-agent/issues/21)、[#22](https://github.com/Lumichelka/career-agent/issues/22)、[#15](https://github.com/Lumichelka/career-agent/issues/15)。
- 规范：<https://modelcontextprotocol.io/specification/2026-07-28>；SDK v2：<https://ts.sdk.modelcontextprotocol.io/v2/>。
