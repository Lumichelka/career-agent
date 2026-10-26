import {Server} from '@modelcontextprotocol/server';
import {serveStdio} from '@modelcontextprotocol/server/stdio';
import {platformTools} from '../tools/registry.mjs';

const base = process.env.CAREER_BRIDGE_URL, token = process.env.CAREER_BRIDGE_TOKEN;
if (!base || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base) || !token) throw new Error('缺少本机平台桥接配置');

// 动作名从登录型工具的 handler（platform.status → status）派生，避免与注册表各维护一份。
const ACTION = Object.fromEntries(platformTools().map(t => [t.name, t.handler.split('.').pop()]));

// v2 的 serveStdio 自己决定这条连接的时代（legacy initialize / modern discover），
// 并把同一条连接钉在这个工厂产出的一个实例上；两种时代共用同一份工具定义。
function createServer() {
  const server = new Server({name: 'career-platform-reader', version: '2.0.0'}, {capabilities: {tools: {}}});

  server.setRequestHandler('tools/list', async () => ({
    tools: platformTools().map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters,
      annotations: {readOnlyHint: t.permission !== 'write', destructiveHint: false, openWorldHint: t.handler !== 'platform.status'}
    }))
  }));

  server.setRequestHandler('tools/call', async request => {
    const {name, arguments: args = {}} = request.params;
    const action = ACTION[name];
    // 未知工具是协议层错误（与 v1 桥行为一致），不是一次失败的工具调用。
    if (!action) throw new Error('未知工具：' + name);
    let response;
    try {
      response = await fetch(base + '/api/platform/' + action, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'x-career-token': token},
        body: JSON.stringify({...args, taskId: process.env.CAREER_TASK_ID || ''}),
        signal: AbortSignal.timeout(410000)
      });
    } catch (e) {
      return {content: [{type: 'text', text: '平台工具连接失败：' + e.message}], isError: true};
    }
    const text = await response.text();
    if (!response.ok) {
      // 先看状态码：502 之类可能返回 HTML，不能当 JSON 解析失败。
      return {content: [{type: 'text', text: '平台接口失败（HTTP ' + response.status + '）：' + text.slice(0, 300)}], isError: true};
    }
    let value;
    try { value = JSON.parse(text); } catch {
      return {content: [{type: 'text', text: '平台接口返回的不是 JSON：' + text.slice(0, 300)}], isError: true};
    }
    return {content: [{type: 'text', text: JSON.stringify(value)}]};
  });

  return server;
}

serveStdio(createServer);
