# MCP 入站：实例开关、client 凭据与双时代服务

> 对应规格 [#25](https://github.com/Lumichelka/career-agent/issues/25) 与实施票 [#37](https://github.com/Lumichelka/career-agent/issues/37)。
> 决策依据：[#21 入站位置](https://github.com/Lumichelka/career-agent/issues/21)、[mcp-host-remote-support](../research/mcp-host-remote-support.md)、[mcp-client-orchestration](../research/mcp-client-orchestration.md)。
> 本文只写已实现的契约；转发/聚合（合并上游 Agent 的工具）属于后续票 [#38](https://github.com/Lumichelka/career-agent/issues/38)。

## 1. 端点与开关

- 端点只有现有端口上的 `/mcp`（与网页同一个进程、同一个监听地址），没有第二个入站端口。
- **实例级总开关默认关**：关闭时 `/mcp` 一律返回 **404**（带有效凭据也一样，端点表现为不存在）。
- 任何**登录用户**都可以开启，但要**二次确认**：`POST /api/mcp/switch {enabled:true}` 返回 409 `NEEDS_CONFIRMATION` 与风险说明；再带 `confirm:true` 才真正开启。界面里同样是两步（「开启入站」→「确认开启」）。
- **关闭不级联撤销已签凭据**：重新开启后，原凭据照常可用。这是有意的——开关控制「对外是否可达」，凭据控制「谁可以」。
- 开关是**实例级**的：开启后任何账号已签发的凭据都能从 `/mcp` 访问，但每枚凭据只落到它所属的账号；因此二次确认的文案按实例级写，而不是只说「你的数据」。

## 2. 凭据：每 (user, client) 一枚

- 用户在网页端为每个 client 签发自签 bearer：`POST /api/mcp/clients {name}`。
- **签发即同意**：记录签发时刻与**当时的工具集快照**；完整凭据只在签发/重新生成的响应里出现一次，之后列表只显示前缀（`zxmcp_ + 8 位`）。
- 凭据**不自动过期**（重启、闲置都不会失效），只能**逐个撤销**或重新生成。
- **重新生成立即换掉凭据**：同一 client 身份不变，旧 token 下一次请求就是 401。
- **身份只来自 `Authorization: Bearer`**：网页登录 cookie、`x-career-token` 实例口令、`/api/` 的会话机制**都不是**入站身份。
- 服务端只保存 **SHA-256 哈希**与显示前缀，落在该账号自己的数据目录（`users/<id>/.data/mcp-clients.json`）；实例开关状态在数据根目录的 `mcp-inbound.json`。
- 凭据的调用只落在**凭据所属账号**的数据目录；撤销后，已经建立的连接下一次请求即 401。

### 接口

| 方法与路径 | 作用 |
| --- | --- |
| `GET /api/mcp` | 开关状态、`/mcp` 地址、受众承诺、本人已签凭据（只显前缀） |
| `POST /api/mcp/switch {enabled, confirm}` | 开/关实例开关；开启未确认时 409 `NEEDS_CONFIRMATION` |
| `POST /api/mcp/clients {name}` | 签发一枚凭据；返回一次完整 token 与三种宿主片段 |
| `POST /api/mcp/clients/revoke {id}` | 撤销单枚凭据，立即 401 |
| `POST /api/mcp/clients/regenerate {id}` | 重新生成同一 client 的凭据，旧 token 立即失效 |

## 3. 三种宿主片段

签发/重新生成时返回 `snippets`（`claude-code` / `cursor-vscode` / `codex`）。格式来自一手文档（见 [mcp-host-remote-support](../research/mcp-host-remote-support.md)）：

- **Claude Code**（官方 CLI 形态）：

  ```bash
  claude mcp add --transport http career-agent http://127.0.0.1:4189/mcp --header "Authorization: Bearer <本次签发的凭据>"
  ```

- **Cursor / VS Code**（`.mcp.json`，两边都认 `mcpServers`；VS Code 若用 `.vscode/mcp.json` 则把键换成 `servers`）：

  ```json
  {
    "mcpServers": {
      "career-agent": {
        "type": "http",
        "url": "http://127.0.0.1:4189/mcp",
        "headers": {"Authorization": "Bearer <本次签发的凭据>"}
      }
    }
  }
  ```

- **Codex**（`~/.codex/config.toml`）：**不内联 token**。Codex 明确拒绝 `bearer_token`，只接受从环境变量取：

  ```toml
  [mcp_servers.career-agent]
  url = "http://127.0.0.1:4189/mcp"
  bearer_token_env_var = "CAREER_MCP_TOKEN"
  ```

  先把本次签发的凭据写进环境变量 `CAREER_MCP_TOKEN`，再启动 Codex。

## 4. 双时代服务

- 入站同时服务 **modern（2026-07-28，按请求信封）** 与 **legacy（2025 时代，无状态）** 两种协议时代，由 SDK 的 `createMcpHandler` 按请求判定，工厂为每次交换新建一个实例。
- 同一条连接不会被强行升级：宿主说 legacy 就按 legacy 答复，说 modern 就按 modern；工具定义与 handler 只有一份（`src/tools/registry.mjs`），两种时代不会漂移。
- 这不是「以后升级」的占位：Claude Code 会探测 modern，Codex 默认 legacy，两种都必须能用。

## 5. 暴露哪些工具

- 从统一注册表生成，当前暴露**除平台工具以外的全部本地工具**（公司档案、简历、面试准备、招聘日历/项目、来源健康、公开搜索）。
- 平台工具（`career_platform_*`）是**任务内**的登录型浏览器操作，靠内部任务桥与 `taskId` 鉴权；入站连接没有任务，因此不进列表，按未知工具处理。
- 工具结果统一为一层 JSON 文本；参数错误按 `INVALID_ARGUMENTS` 返回（`isError: true`），未知工具是协议层错误。
- **工具集快照只做同意凭证，不约束可调用范围**：`ListTools` 每次按当前注册表实时返回；新增工具不要求重新同意（与规格「扩权不重问」一致），「新增工具只提示」随转发票 [#38](https://github.com/Lumichelka/career-agent/issues/38) 一起做。
- 入站**写工具**要到写网关（[#29](https://github.com/Lumichelka/career-agent/issues/29)）落地后才出现，且仍走本应用确认；转发与合并上游工具是 [#38](https://github.com/Lumichelka/career-agent/issues/38)。

## 6. 受众：只承诺两种地址

| 地址 | 状态 |
| --- | --- |
| `http://127.0.0.1:4189/mcp` | **承诺**（本机回环） |
| Tailscale HTTPS（`tailscale serve https` 后的 `https://<机器>.<tailnet>.ts.net/mcp`） | **承诺**（加密隧道）；前提是把 tailnet 主机名加进 `CAREER_ALLOWED_HOSTS`，否则 Host 白名单会 403 |
| 局域网明文 `http://192.168.x.x:4189/mcp` | **未验证，不承诺**：没有一家宿主的一手文档写明接受 LAN 明文 http |
| 其它地址（公网域名、端口映射等） | **不承诺**：不在本规格范围内，也不做 OAuth 2.1 / DCR |

状态接口与网页对话框都会原样显示这段承诺与「未验证」清单，避免部署预期被夸大。

> Tailscale HTTPS 还依赖现有部署护栏：服务的 Host 白名单只认本机/局域网地址与 `CAREER_ALLOWED_HOSTS` 里的主机。用 `tailscale serve https` 前，把 `<机器>.<tailnet>.ts.net` 加进该环境变量（见 [部署与备份](14-部署与备份.md)）。

## 7. 只用 stdio 的宿主：随包桥

Claude Desktop 这类只支持 stdio 的宿主，用随包的 `src/mcp/stdio-bridge.mjs` 桥到 `/mcp`。桥自己带着入站凭据走 HTTP，**服务端仍然只认「HTTP + token」**：

```json
{
  "mcpServers": {
    "career-agent": {
      "command": "node",
      "args": ["<仓库路径>/src/mcp/stdio-bridge.mjs"],
      "env": {
        "CAREER_MCP_URL": "http://127.0.0.1:4189/mcp",
        "CAREER_MCP_TOKEN": "<本次签发的凭据>"
      }
    }
  }
}
```

缺少 `CAREER_MCP_URL` 或 `CAREER_MCP_TOKEN` 时桥直接退出并说明原因；桥的上游调用失败会作为 `isError` 的工具结果返回，不会让宿主进程崩溃。

## 8. 测试

`tests/mcp-inbound.test.mjs`（已加入 `npm test`）覆盖：

- 默认关 → 404；开启未确认 → 409 且开关不动；确认后无 token 401、坏 token 401、cookie 与实例口令不能当凭据
- 签发：完整 token 只回一次、列表只显前缀、工具集快照记录；落盘只有 SHA-256 哈希，没有可用明文
- 三种片段格式；Codex 片段不含 token / Authorization
- modern（auto）与 legacy 两条路径都能初始化、ListTools、CallTool；参数错误是工具失败，未知工具是协议错误
- 撤销后立即 401（包括活着的连接）；重新生成后旧 token 立即失效
- 关闭开关不撤销凭据，重新开启后原 token 仍可用
- 凭据与开关跨重启保留，凭据不自动过期
- 两个账号的凭据与数据互不可见
- 随包 stdio 桥能列出并调用工具；缺配置时退出并说明原因
