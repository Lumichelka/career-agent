# 外部 AI 宿主能否连接“回环/LAN + 静态 Bearer”的 MCP Server

> Wayfinder 研究票 [#21](https://github.com/Lumichelka/career-agent/issues/21)，父地图 [#12](https://github.com/Lumichelka/career-agent/issues/12)。
> 调研时间：2026-10-25。只看产品官方文档、官方仓库源码与 MCP 规范；**只记事实，不写实现**，不做产品决策。
> 标注约定：`文档明确`＝一手文档写明；`推断`＝由一手材料组合推出；`未验证`＝一手材料没写，或本机取不到一手来源。
> 本机网络限制（影响取证）：`openai.com` 全域被 Cloudflare 拦截，`github.com` 域名在本环境解析到非公网地址；Codex 的结论改用 jsDelivr 上的 `openai/codex` 官方仓库镜像源码，ChatGPT 因此无法核验。

## 0. 结论速览

1. **远程 HTTP 已是主流能力**：8 个宿主中 7 个文档化了 `url` 形式的远程 MCP Server；Claude Desktop 走 UI“自定义连接器”，ChatGPT 未验证。
2. **“静态 Bearer 头”不需要 OAuth**：Claude Code、Cursor、VS Code、Codex 都有文档化的静态 header 入口，正好匹配“应用自签 token”方案。
3. **已核验宿主里，Claude Desktop 是唯一结构性不行的**：它的远程连接器由 **Anthropic 云端发起**，不看本机网络，回环/LAN 地址根本不可达；“No sign in + Request headers（可放 Bearer）”只在公网可达时才有意义。
4. **非 TLS 只被部分宿主文档化**：Cursor、VS Code 的示例里直接出现 `http://localhost:3000`；**没有任何宿主的一手文档写“接受 LAN 明文 http”**，`http://192.168.x.x` 一律 `未验证`。
5. **Codex 拒绝内联令牌**：源码明确报错 `bearer_token` 不受支持，要求 `bearer_token_env_var`（或 `http_headers`），静态明文令牌不是官方路径。
6. **协议时代几乎没有宿主公开承诺 2026-07-28**：只有 Claude Code 写明 v2 runtime 会自动探测新版本；Codex 源码里 2026-07-28 在 feature flag 后、默认 legacy；其余 `未验证`。
7. **stdio 是唯一普遍可用且无授权层的通道**：所有宿主都支持命令 + 环境变量，这也让“进程即信任边界”在每一家都能落地。

## 1. 宿主 × 能力矩阵

| 宿主 | 远程 HTTP（`url`） | 自定义 Bearer 头 | 本地 `http://` URL | stdio | 协议时代（2026-07-28） |
| --- | --- | --- | --- | --- | --- |
| Claude Desktop / claude.ai | 是 `文档明确`[2][3]，但走 UI 连接器、**云端发起** | 是 `文档明确`[3]（Request headers，UI） | **否**（云端发起，回环/LAN 不可达）`文档明确`[3] | 是 `文档明确`[4] | `未验证` |
| Claude Code | 是 `文档明确`[1] | 是 `文档明确`[1]（`--header` / `.mcp.json.headers`） | `未验证`[1] | 是 `文档明确`[1] | 是 `文档明确`[1]（v2 runtime 自动探测） |
| ChatGPT（桌面/Connectors） | `未验证` | `未验证` | `未验证` | `未验证` | `未验证` |
| Codex CLI | 是 `文档明确`[8]（`url`） | 是 `文档明确`[8]（`http_headers`；内联 `bearer_token` 被拒） | `未验证`[8] | 是 `文档明确`[8] | 在 flag 后、默认 legacy（源码）[9] |
| Cursor | 是 `文档明确`[5] | 是 `文档明确`[5]（`headers`） | 是 `文档明确`[5]（示例 `http://localhost:3000/mcp`） | 是 `文档明确`[5] | `未验证` |
| VS Code Copilot（MCP） | 是 `文档明确`[6][7] | 是 `文档明确`[6]（`headers` + `${input:...}`） | 是 `文档明确`[6]（示例 `http://localhost:3000`） | 是 `文档明确`[6] | `未验证` |
| Cherry Studio | 是 `文档明确`[10]（远程 SSE / 可流式 HTTP 填 URL） | `未验证`[10] | `未验证`[10] | 是 `文档明确`[10] | `未验证` |
| Continue | 是 `文档明确`[11][12]（`type: streamable-http`） | `推断`[12]（`requestOptions.headers`） | `未验证`[11] | 是 `文档明确`[11] | `未验证` |

LAN 明文 http（`http://192.168.x.x:4189/mcp`）：**所有宿主均 `未验证`**；Claude Desktop 为“否”，因为连接不由本机发起[3]。

## 2. 逐个宿主

### Claude Desktop（含 claude.ai、Cowork）

- 远程：Connectors 里“Add custom connector”只填 URL，随即可选 `Sign in now / Sign in when needed / No sign in`，并在 **Request headers** 里放固定凭据（API key、bearer token）[3]。所以“静态 Bearer”有官方入口，但只在 **公网可达** 时有用。
- 网络模型是决定性的：文档写明连接“originates from Anthropic's servers, not from your machine's network interface”，私有网络/VPN 后的服务器连不上，需要把 Anthropic IP 段加进防火墙[3]。
- 本机通道只有 stdio：`claude_desktop_config.json` 的 `mcpServers.<name>` 用 `command` / `args` / `env`[4]。
- 配置片段（stdio）：`{"mcpServers":{"career":{"command":"node","args":["F:\\职向\\src\\platform\\mcp.mjs"],"env":{"CAREER_MCP_TOKEN":"..."}}}}`[4]

### Claude Code

- 远程 HTTP 一等支持，官方就是 `claude mcp add --transport http <name> <url> --header "Authorization: Bearer ..."`；`.mcp.json` 里 `type` 可写 `http` 或别名 `streamable-http`，`url` + `headers` 生效[1]。
- 有 `headersHelper`（连接时运行命令产出 header JSON，10s 超时、可被 401/403 触发重跑），也支持 `${VAR}` 展开；但**远程 URL/headers 里的凭据类变量会被读成空**（如 `ANTHROPIC_AUTH_TOKEN`），要用自定义变量名[1]。
- OAuth 与静态头互斥：配了 `headers.Authorization` 后服务器拒绝该头，Claude Code 直接报连接失败，**不回退 OAuth**[1]。
- 非 TLS：文档只示例 `https://`；OAuth 令牌端点只允许 HTTPS 或 `localhost/127.0.0.1/::1`，局域网明文端点会被拒签[1]。普通 `http://` MCP URL 是否接受，文档未写 → `未验证`。
- 协议时代：v2 runtime 基于 TS SDK 2.x，**会先问 HTTP/stdio 服务器是否支持 2026-07-28**，支持就用；`MCP_SDK_GENERATION=v1|v2`、`MCP_PROTOCOL_NEGOTIATION=auto|legacy` 可强制[1]。

### ChatGPT（桌面 / Connectors）

- 一手来源不可达：`platform.openai.com`、`help.openai.com`、`developers.openai.com` 在本机均返回 Cloudflare 403（不是内容缺失，是取不到）[13]。
- 因此**不引用任何二手结论**；远程 URL、静态 header、localhost 支持、stdio 配置方式全部标 `未验证`。需要换网络环境再补证。

### Codex CLI

- 配置在 `~/.codex/config.toml` 的 `[mcp_servers.<name>]`：stdio 用 `command` / `args` / `env` / `env_vars` / `cwd`；远程用 `url`[8]。
- 远程认证字段：`bearer_token_env_var`（推荐）、`http_headers`（静态头映射）、`env_http_headers`（头值取自环境变量）、`http_headers_helper`（本地命令产出 header JSON）[8]。
- **内联 `bearer_token` 会被报错拒绝**："mcp_servers.<name> uses unsupported `bearer_token`; set `bearer_token_env_var`"[8]。
- 片段：`[mcp_servers.career]` + `url = "http://127.0.0.1:4189/mcp"` + `bearer_token_env_var = "CAREER_TOKEN"`（或 `http_headers = { Authorization = "Bearer ..." }`）[8]
- 协议时代：`McpProtocolMode::V20260728` 仅在 feature flag `Mcp20260728` 打开时启用，否则 `Legacy`（源码）[9]。

### Cursor

- `mcp.json` 同时支持 stdio 与远程；远程条目就是 `"url"` + `"headers"`，官方示例里既有 `http://localhost:3000/mcp`，也有 `"Authorization": "Bearer ${env:MY_SERVICE_TOKEN}"`[5]。
- 另有静态 OAuth 客户端凭据 `auth.CLIENT_ID/CLIENT_SECRET/scopes`，以及 `https://www.cursor.com/agents/mcp/oauth/callback`、`http://localhost:8787/callback` 两个固定回调；说明它默认会走 RFC 9728 发现 + DCR[5]。
- 配置对照表把 Streamable HTTP 的 Auth 写成 “OAuth”，与 `headers` 示例并存，文档内部不完全一致（见 §4）[5]。
- 企业侧还能按 URL/命令做 MCP allowlist 与网络限制[5]。

### VS Code Copilot（MCP）

- 两种格式：`.vscode/mcp.json`（`servers`）与便携 `.mcp.json` / `~/.copilot/mcp-config.json`（`mcpServers`）[6]。
- HTTP：`type: "http"`（先试 Streamable HTTP，失败回退 SSE）、`url`、`headers`、可选 `oauth.clientId`；`url` 示例直接写 `http://localhost:3000`，`headers` 示例是 `{"Authorization": "Bearer ${input:api-token}"}`[6]。
- 保密方式三档：VS Code 格式用 `${input:...}`（首次提示、安全存储）；便携格式用 `${NAME}` 环境变量；两者都可放 header[6]。
- 文档明确说 Copilot harness **没有**把 `${input:...}` 或 `SecretStorage` 注入 HTTP 认证头的内建能力，只能靠环境变量或 OAuth[6]。
- 协议时代：文档未写 → `未验证`[6][7]。

### Cherry Studio

- 远程服务器只要求填 URL（SSE 或可流式 HTTP），本地用命令 + 参数 + 环境变量；文档没有展开 header 字段[10]。
- 我用该文档站自己的问答接口核了一遍：官方回答是“没有说明 MCP 配置支持任意自定义请求头，也没有确认可设置静态 `Authorization: Bearer`”，`http://` 与局域网地址同样未说明[10]。
- 因此：远程 HTTP `文档明确`，**静态 Bearer 头与明文 LAN 地址一律 `未验证`**，协议时代 `未验证`。

### Continue

- `config.yaml` 的 `mcpServers[]`：`type` 取 `stdio | sse | streamable-http`，远程给 `url`，本地给 `command/args/env/cwd`[11]。
- 静态头没有专门的 `headers` 字段，但有 `requestOptions`：“Optional request options for `sse` and `streamable-http` servers. Same format as model requestOptions”，而 model 的 `requestOptions` 明确含 `headers`[12] → 记为 `推断`（组合推出，无直接示例）。
- 仓库里有一个未关闭的 issue 正好抱怨 `requestOptions.headers` 等传输相关属性没被文档写清（[continue#7595](https://github.com/continuedev/continue/issues/7595)），与“文档未直说”一致。

## 3. 对本应用的含义（只写事实推论）

- **能走“回环/LAN + 静态 bearer”的宿主**：Claude Code、Cursor、VS Code（前提是该 URL 被接受，LAN 明文属 `未验证`）、Codex（走 `bearer_token_env_var` 或 `http_headers`）。这四家的配置形态都能表达“每用户一个静态 token”，不需要应用实现 OAuth 2.1。
- **只能走 stdio 的宿主**：Claude Desktop（远程连接由 Anthropic 云端发起，回环/LAN 必然不可达）[3]。Continue、Cherry Studio 的 stdio 也文档明确，可作兜底。
- **必须 OAuth 或未验证的宿主**：ChatGPT 全部 `未验证`；Claude Desktop 若坚持远程，则必须公网可达（并按文档支持 OAuth 或固定 header）[3]。
- **协议时代的现实**：即使宿主接受静态 bearer，也不能假设它们说 2026-07-28。除 Claude Code 外，现有一手材料没有一家承诺 modern；Codex 默认还是 legacy[9]。所以入站端点要么双时代，要么按 legacy 兼容。
- **stdio 与 HTTP 的能力差**：stdio 侧凭证只能来自环境变量/进程权限（Claude Desktop[4]、Codex[8]、Continue[11]、VS Code[6] 都是这个形态），HTTP 侧才有“每请求头”这一层。

## 4. 未知与风险

- **ChatGPT 完全空白（高）**：openai.com 全域 403，未取得任何一手材料；不能把社区说法当事实，需换网络补证。
- **LAN 明文 http 无一手依据（高）**：Cursor/VS Code 只示例 `localhost`；`http://192.168.x.x` 是否被接受、是否被某些客户端的“仅 HTTPS/localhost”策略拦掉，全部 `未验证`。
- **文档内部矛盾（中）**：Cursor 的能力表把 Streamable HTTP 的 Auth 统一写成 OAuth，但同页给出 `headers` 静态 Bearer 示例[5]；实际以 `headers` 字段为准属 `推断`。
- **Continue 的 header 路径（中）**：只有 `requestOptions` 的间接描述[12]，且官方 issue 承认未写清；不同版本行为可能不同，`推断` 结论需实测。
- **版本差异（中）**：Claude Code 的 v2 runtime/2026-07-28 与具体小版本绑定（文档给了 v2.1.2xx 一串门槛）[1]；Codex 的 modern 模式藏在 feature flag 后[9]，同一版本不同账号可能不同。
- **取证路径**：Codex 结论来自 `openai/codex` 源码（经 jsDelivr 镜像读取，文件为 `codex-rs/config/src/mcp_types.rs`、`codex-rs/core/src/config/mod.rs`），不是发布说明；字段名以源码为准，CLI 帮助文本未核。
- **未覆盖**：LibreChat、Windsurf、Gemini CLI 等宿主本轮未取证（Gemini CLI 文档抓取失败），矩阵只含 8 个指定宿主。

## 主要来源

1. Claude Code — Connect to tools via MCP：<https://code.claude.com/docs/en/mcp>
2. MCP 文档 — Connect to remote MCP servers：<https://modelcontextprotocol.io/docs/2026-07-28/develop/connect-remote-servers>
3. Claude Help Center — Get started with custom connectors using remote MCP（网络要求、Request headers）：<https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp>
4. MCP 文档 — Connect to local MCP servers（Claude Desktop stdio 配置）：<https://modelcontextprotocol.io/docs/2026-07-28/develop/connect-local-servers>
5. Cursor — Model Context Protocol (MCP)：<https://cursor.com/docs/mcp>
6. VS Code — MCP configuration reference：<https://code.visualstudio.com/docs/agents/reference/mcp-configuration>
7. VS Code — Add MCP servers：<https://code.visualstudio.com/docs/agent-customization/mcp-servers>
8. openai/codex — `codex-rs/config/src/mcp_types.rs`（`McpServerTransportConfig`、`bearer_token` 校验）：<https://github.com/openai/codex/blob/main/codex-rs/config/src/mcp_types.rs>
9. openai/codex — `codex-rs/core/src/config/mod.rs`（`McpProtocolMode`、`Mcp20260728`）：<https://github.com/openai/codex/blob/main/codex-rs/core/src/config/mod.rs>
10. Cherry Studio — MCP 与外部工具（含其文档站问答接口的答复）：<https://docs.cherryai.com.cn/advanced-basic/extensions/mcp>
11. Continue — How to Set Up MCP：<https://docs.continue.dev/customize/deep-dives/mcp>
12. Continue — config.yaml Reference（`mcpServers` / `requestOptions`）：<https://docs.continue.dev/reference>
13. OpenAI 文档（本机 403，未能取证）：<https://platform.openai.com/docs/mcp>
14. MCP 规范 2026-07-28（协议时代定义）：<https://modelcontextprotocol.io/specification/2026-07-28>
