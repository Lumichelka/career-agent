# 25 · 入站 /mcp 与宿主配置

> 对应票 [#37](https://github.com/Lumichelka/career-agent/issues/37)；父规格 [#25](https://github.com/Lumichelka/career-agent/issues/25)。
> 契约依据：[21 · MCP 客户端与外部 Agent 适配契约](21-MCP客户端与外部Agent适配契约.md)、[23 · 多用户隔离契约](23-多用户隔离契约.md)。

## 1. 端点与实例开关

- 入站端点就是现有 HTTP 服务上的 `/mcp`（默认 `http://127.0.0.1:4189/mcp`），与网页同进程、同端口、同监听地址。
- 实例级总开关，**默认关**。关闭时 `/mcp` 一律返回 **404**，即使请求带着有效凭据。
- **任何登录用户**都可以开启；开启必须二次确认（设置页里的「确认开启」按钮，API 为 `POST /api/mcp/switch {enabled:true, confirm:true}`，缺 `confirm` 返回 `409 NEEDS_CONFIRMATION`）。
- **关闭开关不撤销已签凭据**；重新开启后，之前未被撤销的凭据恢复可用。
- 同一实例只有一个开关，但凭据按用户隔离：A 打开的开关不会让 B 的凭据凭空出现，A 的凭据也只能读 A 的数据。

## 2. 凭据

- 每 `(user, client)` 一枚自签 bearer，形如 `zxmcp_<48 位十六进制>`，绑定签发它的账号 `user_id`。
- 落盘只存 **sha256 哈希**（`users/<id>/mcp-clients.json`），完整凭据只在签发/重新生成时返回一次；之后设置页只显示前缀（`zxmcp_ + 8 位`）。
- 不自动过期；可单独撤销；**重新生成立即让旧凭据失效**，client 身份与工具集快照保留。已撤销的 client 不能原地重新生成，需要新建。
- `clientInfo` 只做展示，不参与授权。
- 入站认证**只认** `Authorization: Bearer <凭据>`。网页登录 cookie、实例访问口令 `x-career-token`、请求体里的 user_id 都不是入站身份。
- 凭据不进日志、不进证据、不回传给上游；同一 `(user, client)` 的凭据只认证它自己的账号。

## 3. 三种宿主片段

签发凭据时，设置页会给出可直接粘贴的片段（`POST /api/mcp/clients` 的 `snippets` 字段同源）。下面的 `<token>` 只在你手上有完整凭据时替换。

### Claude Code

```shell
claude mcp add --transport http career-agent http://127.0.0.1:4189/mcp --header "Authorization: Bearer <token>"
```

### Cursor / VS Code（`.mcp.json`）

```json
{
  "mcpServers": {
    "career-agent": {
      "type": "http",
      "url": "http://127.0.0.1:4189/mcp",
      "headers": {"Authorization": "Bearer <token>"}
    }
  }
}
```

### Codex（`~/.codex/config.toml`）

Codex 不接受内联 `bearer_token`，片段里**绝不出现凭据**；先设环境变量，再引用它：

```toml
[mcp_servers.career-agent]
url = "http://127.0.0.1:4189/mcp"
bearer_token_env_var = "CAREER_MCP_TOKEN"
```

Windows PowerShell 临时设置：`$env:CAREER_MCP_TOKEN = "zxmcp_..."`；需要长期使用时写进用户环境变量，但别提交进仓库。若宿主只支持自定义请求头，也可用 `http_headers` 指向同一变量，仍然不要把凭据写死在配置里。

## 4. 受众承诺（写清楚边界）

- **只承诺**：
  - 本机回环：`http://127.0.0.1:4189/mcp`
  - Tailscale HTTPS：`tailscale serve https` 之后的 `https://<机器>.<tailnet>.ts.net/mcp`
- **未验证、不承诺**：局域网明文 `http://<局域网 IP>:4189/mcp`，以及任何未列出的地址（公网、反代、容器端口映射）。
- Tailscale HTTPS 经 `tailscale serve` 反代到本机时，Host 头是 `<机器>.<tailnet>.ts.net`；启动前把它加进 `CAREER_ALLOWED_HOSTS`（逗号分隔），否则应用原有的 Host 白名单会先返回 403。
- 不实现 OAuth 2.1 / DCR / step-up，不做 token passthrough。要跨公网请自己加 TLS 反代并自行承担风险，本项目的承诺仍只覆盖上面两条。
- 凭据是 bearer，谁能读到谁就能用；不要贴进聊天、issue、截图或仓库。

## 5. 双时代与 stdio 桥

- `/mcp` 同时服务 **modern（2026-07-28）** 与 **legacy（2025-11-25 及更早）** 两个协议时代，由 SDK 按连接/请求分类，同一个工具定义两边共用；写死只支持 modern 的宿主和旧的 `initialize` 宿主都能连。
- 只用 stdio 的宿主用随包桥接脚本 `src/mcp/stdio-bridge.mjs`：宿主通过 stdio 启动它，它带着 `CAREER_MCP_TOKEN` 走 HTTP 连 `/mcp`。**服务端仍然只认「HTTP + token」**，stdio 不是第二个入站入口。

```json
{
  "mcpServers": {
    "career-agent": {
      "command": "node",
      "args": ["<仓库路径>/src/mcp/stdio-bridge.mjs"],
      "env": {
        "CAREER_MCP_URL": "http://127.0.0.1:4189/mcp",
        "CAREER_MCP_TOKEN": "<token>"
      }
    }
  }
}
```

## 6. 工具面与转发

- `ListTools` / `CallTool` 来自统一注册表 `src/tools/registry.mjs`（`inboundTools()`）；当前是只读工具，写工具随写网关那张票进入同一注册表。
- 任务内的登录型平台工具（`career_platform_*`）**不暴露**给入站：它们依赖任务里的浏览器与 taskId，入站连接没有任务身份。
- 转发（把该用户启用 Agent 的上游工具合并进来）是 **#38**；合并点已预留在 `src/mcp/inbound.mjs` 的 `tools/list` 处，命名沿用 `mcp__<agent>__<tool>`，上游 token 永不回传给第三方，转发调用来源要标 `forwarded_client` + client id。
- 入站写仍然走本应用确认（`confirm_id`），转发不能绕过；入站写不计入本应用的模型调用记录。

## 7. 设置页使用的 HTTP 接口

均要求登录 cookie + 实例口令（与其它 `/api/*` 相同），只操作当前账号：

| 方法与路径 | 作用 |
| --- | --- |
| `GET /api/mcp` | 开关状态、受众说明、当前账号的 client 列表（只显前缀，不含完整凭据/哈希） |
| `POST /api/mcp/switch` | `{enabled, confirm?}`；开启缺 `confirm:true` 返回 409 |
| `POST /api/mcp/clients` | `{name}` 签发；返回一次性 `token` 与三种 `snippets` |
| `POST /api/mcp/clients/revoke` | `{id}` 撤销，立即生效 |
| `POST /api/mcp/clients/regenerate` | `{id}` 换新凭据并让旧凭据立即失效 |

实例配置落在数据根 `mcp-inbound.json`（开关 + 受众白名单），凭据落在各用户目录（`users/<id>/mcp-clients.json`，只存 sha256 哈希）。
