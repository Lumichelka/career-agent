// 随包的 stdio → HTTP 桥：只支持 stdio 的宿主把本应用当成本地命令启动，
// 由这里带着入站凭据连 /mcp。服务端仍然只认「HTTP + token」，stdio 不是第二个入口。
//
// 用法（Host 配置）：
//   command = node
//   args    = ["<仓库>/src/mcp/stdio-bridge.mjs"]
//   env     = { CAREER_MCP_URL: "http://127.0.0.1:4189/mcp", CAREER_MCP_TOKEN: "zxmcp_..." }
import {Server} from '@modelcontextprotocol/server';
import {serveStdio} from '@modelcontextprotocol/server/stdio';
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';

const url = String(process.env.CAREER_MCP_URL || '').trim();
const token = String(process.env.CAREER_MCP_TOKEN || '').trim();
if (!/^https?:\/\//.test(url) || !token) {
  console.error('缺少入站桥接配置：需要 CAREER_MCP_URL（例如 http://127.0.0.1:4189/mcp）与 CAREER_MCP_TOKEN。');
  process.exit(1);
}

// 桥只在第一次用到时连接上游；失败后允许下一次重试。
let upstream = null;
function connect() {
  if (!upstream) {
    upstream = (async () => {
      const client = new Client({name: 'career-agent-stdio-bridge', version: '3.0.0'}, {versionNegotiation: {mode: 'auto'}});
      await client.connect(new StreamableHTTPClientTransport(new URL(url), {authProvider: {token: async () => token}}));
      return client;
    })().catch(error => { upstream = null; throw error; });
  }
  return upstream;
}

function createServer() {
  const server = new Server({name: 'career-agent', version: '3.0.0'}, {capabilities: {tools: {}}});
  server.setRequestHandler('tools/list', async () => (await connect()).listTools());
  server.setRequestHandler('tools/call', async request => {
    try {
      return await (await connect()).callTool(request.params);
    } catch (error) {
      return {content: [{type: 'text', text: '入站 MCP 调用失败：' + (error?.message || String(error))}], isError: true};
    }
  });
  return server;
}

serveStdio(createServer);
