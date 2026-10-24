import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema, CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {platformTools} from '../tools/registry.mjs';

const base = process.env.CAREER_BRIDGE_URL, token = process.env.CAREER_BRIDGE_TOKEN;
if (!base || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base) || !token) throw new Error('缺少本机平台桥接配置');

const ACTION = {
  career_platform_status: 'status',
  career_platform_search: 'search',
  career_platform_read: 'read'
};

const server = new Server({name: 'career-platform-reader', version: '1.1.0'}, {capabilities: {tools: {}}});

// 工具定义来自统一注册表，避免与对话模式各维护一份
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: platformTools().map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.parameters,
    annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: t.handler !== 'platform.status'}
  }))
}));

server.setRequestHandler(CallToolRequestSchema, async r => {
  const action = ACTION[r.params.name];
  if (!action) throw new Error('未知工具');
  try {
    const response = await fetch(base + '/api/platform/' + action, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'x-career-token': token},
      body: JSON.stringify({...r.params.arguments, taskId: process.env.CAREER_TASK_ID || ''}),
      signal: AbortSignal.timeout(410000)
    });
    const value = await response.json();
    return {content: [{type: 'text', text: JSON.stringify(value)}], isError: !response.ok};
  } catch (e) {
    return {content: [{type: 'text', text: '平台工具连接失败：' + e.message}], isError: true};
  }
});
await server.connect(new StdioServerTransport());
