# Server

本应用的 HTTP 服务上下文：网页、HTTP API 与对外 MCP 入站。

## Language

**入站（Inbound）**:
外部 AI 宿主经 `/mcp` 连本应用的 MCP 方向。
_Avoid_: 服务端模式、MCP Server 模式

**出站（Outbound）**:
本应用作为 MCP client 连外部 Agent 的方向。
_Avoid_: 客户端模式

**内部任务桥**:
Codex 子进程在单次任务内使用的 stdio 平台读取桥，不是对外 MCP 入口。
_Avoid_: stdio 入站、平台 MCP

**client**:
用户签发凭据时命名的接入实体；一枚凭据只属于一个 client。
_Avoid_: 设备、连接、会话

**凭据（client token）**:
绑定 `(user, client)`、用于入站认证的静态 bearer。
_Avoid_: 会话 token、local-session-token、API Key

**实例开关**:
决定 `/mcp` 是否存在（关闭即 404）的实例级总开关，默认关；关闭不会撤销任何凭据。
_Avoid_: 用户开关、per-user 开关

**入站桥**:
随包的 `src/mcp/stdio-bridge.mjs`，把只支持 stdio 的宿主带凭据转发到 `/mcp`；它不是第二个入站入口。
_Avoid_: stdio 入站、MCP 代理
