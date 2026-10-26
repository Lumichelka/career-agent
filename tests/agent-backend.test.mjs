import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from '../src/server/app.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// 假 MCP Agent：进程内 connect / listTools / callTool，不启动进程、不联网。
function fakeAgentFactory({text = '这是外部 Agent 的回复。'} = {}) {
  const log = [];
  const factory = async context => {
    log.push({kind: 'context', agent: context.agent?.name});
    return {
      pid: null,
      era: () => 'modern',
      serverInfo: () => ({name: 'fake-agent-backend', version: '1.0.0'}),
      connect: async () => { log.push({kind: 'connect'}); },
      listTools: async () => ({tools: [
        {
          name: 'chat', title: '聊天', description: '接收 prompt 并返回文本',
          annotations: {readOnlyHint: true},
          inputSchema: {type: 'object', properties: {prompt: {type: 'string'}}, required: ['prompt']}
        },
        {
          name: 'danger_write', title: '写库', description: '写工具不会用于聊天执行',
          annotations: {readOnlyHint: false},
          inputSchema: {type: 'object', properties: {prompt: {type: 'string'}, idempotencyKey: {type: 'string'}}}
        }
      ]}),
      callTool: async (name, args) => {
        log.push({kind: 'callTool', name, args});
        return {content: [{type: 'text', text}]};
      },
      close: async () => { log.push({kind: 'close'}); }
    };
  };
  factory.log = log;
  return factory;
}

async function startApp(t, factory) {
  const dir = await mkdtemp(join(tmpdir(), 'zx-agent-backend-'));
  const app = await createApp({root, dataDir: dir, host: '127.0.0.1', port: 0, agentClientFactory: factory});
  t.after(async () => { await app.close(); await rm(dir, {recursive: true, force: true}); });
  return app;
}

function cookieOf(response) {
  return (response.headers.getSetCookie?.() || [response.headers.get('set-cookie')]).filter(Boolean).map(value => value.split(';')[0]).join('; ');
}
function headers(app, cookie) {
  return {'Content-Type': 'application/json', 'x-career-token': app.token, cookie};
}
async function register(app, name) {
  const response = await fetch(app.origin + '/api/auth/register', {
    method: 'POST', headers: headers(app, ''),
    body: JSON.stringify({name, password: 'correct-horse-battery'})
  });
  const body = await response.json();
  assert.equal(response.status, 200, name + ' 注册失败：' + JSON.stringify(body));
  return {user: body.user, cookie: cookieOf(response)};
}
async function postJson(app, path, cookie, body, expectedStatus = 200) {
  const response = await fetch(app.origin + path, {method: 'POST', headers: headers(app, cookie), body: JSON.stringify(body)});
  const payload = await response.json();
  assert.equal(response.status, expectedStatus, path + ' 状态不符：' + JSON.stringify(payload));
  return payload;
}
async function getJson(app, path, cookie) {
  const response = await fetch(app.origin + path, {headers: headers(app, cookie)});
  const payload = await response.json();
  assert.equal(response.status, 200, path + ' 失败：' + JSON.stringify(payload));
  return payload;
}

// 读 NDJSON；遇到首次出网确认时就地选「以后不再问」，模拟用户在对话页点一次。
async function chat(app, cookie, sessionId, message, extra = {}) {
  const response = await fetch(app.origin + '/api/chat', {
    method: 'POST', headers: headers(app, cookie),
    body: JSON.stringify({id: sessionId, message, ...extra})
  });
  assert.equal(response.status, 200, 'chat 应返回 NDJSON');
  const events = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, {stream: true});
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      events.push(event);
      if (event.type === 'external_confirm_required') {
        await postJson(app, '/api/agents/outbound', cookie, {confirmId: event.confirmId, decision: 'always'});
      }
    }
  }
  if (buffer.trim()) events.push(JSON.parse(buffer));
  return events;
}

test('外部 Agent 后端：候选、单独选择、真正执行聊天一轮，且永不作为视觉候选', {timeout: 90000}, async t => {
  const factory = fakeAgentFactory();
  const app = await startApp(t, factory);
  const member = await register(app, 'agent-backend-user');

  // 没有配置时：外部 Agent 作为「待配置」候选存在，但不可选。
  const before = await getJson(app, '/api/backends', member.cookie);
  assert.ok(before.kinds.includes('agent'), '后端种类包含 agent');
  const placeholder = before.candidates.find(card => card.kind === 'agent');
  assert.equal(placeholder.configured, false);
  assert.equal(placeholder.configTarget, 'agent-settings');
  await postJson(app, '/api/backends/select', member.cookie, {kind: 'agent'}, 409);

  const created = await postJson(app, '/api/agents', member.cookie, {
    name: '我的外部 Agent', transport: 'http', url: 'https://agent.example.com/mcp'
  });
  const agentId = created.agent.id;

  const view = await getJson(app, '/api/backends', member.cookie);
  const card = view.candidates.find(item => item.kind === 'agent' && item.agentId === agentId);
  assert.ok(card, '已启用的外部 Agent 进入文本候选');
  assert.equal(card.configured, true);
  assert.ok(card.capabilities.includes('text') && card.capabilities.includes('tools'));
  assert.ok(!card.capabilities.includes('vision'), '外部 Agent 永不带 vision 能力');

  // 视觉任务里没有任何 agent 候选。
  const selected = await postJson(app, '/api/backends/select', member.cookie, {kind: 'agent', agentId});
  assert.equal(selected.current.kind, 'agent');
  assert.equal(selected.current.agentId, agentId);
  assert.equal((await getJson(app, '/api/backends', member.cookie)).choices.agent, agentId, 'agent 槽位单独持久化');

  // 切回模型 API 不覆盖 agent 槽位。
  await postJson(app, '/api/model/save', member.cookie, {
    preset: 'deepseek', mode: 'api', protocol: 'chat', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'sk-test', stream: true
  });
  await postJson(app, '/api/backends/select', member.cookie, {kind: 'api'});
  assert.equal((await getJson(app, '/api/backends', member.cookie)).choices.agent, agentId, '模型 API 与外部 Agent 分开选、互不覆盖');
  await postJson(app, '/api/backends/select', member.cookie, {kind: 'agent', agentId});

  const session = await postJson(app, '/api/new', member.cookie, {});
  const events = await chat(app, member.cookie, session.id, '帮我用外部 Agent 总结一下这周的投递计划');
  const done = events.find(event => event.type === 'done');
  assert.ok(done, '任务应以 done 收尾：' + JSON.stringify(events.filter(event => event.type === 'error')));
  const assistant = done.session.messages.at(-1);
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.backendKind, 'agent');
  assert.equal(assistant.content, '这是外部 Agent 的回复。');
  assert.equal(assistant.calls.length, 1, '外部 Agent 聊天只记一次执行调用');
  assert.equal(assistant.calls[0].step, 'act');
  assert.equal(assistant.calls[0].backend.kind, 'agent');
  assert.equal(assistant.calls[0].backend.agentId, agentId);
  assert.equal(assistant.calls[0].outcome, 'ok');
  assert.equal('usage' in assistant.calls[0], false, '外部 Agent 没有模型 usage');
  assert.equal('cost' in assistant.calls[0], false, '外部 Agent 不编造费用');
  assert.equal(done.session.memory, '', '外部 Agent 结果没有记忆');
  assert.deepEqual(done.session.messages.at(-1).sources || [], []);
  assert.equal(assistant.artifact ?? null, null, '助手消息不写 artifact');

  const calls = factory.log.filter(item => item.kind === 'callTool');
  assert.equal(calls.length, 1, '只调用一次外部 Agent 工具');
  assert.equal(calls[0].name, 'chat', '只选只读、收 prompt 的工具');
  assert.match(calls[0].args.prompt, /帮我用外部 Agent 总结/);
  assert.ok(!factory.log.some(item => item.kind === 'callTool' && item.name === 'danger_write'), '写工具不能用于聊天执行');

  const tasks = await getJson(app, '/api/tasks', member.cookie);
  assert.equal(tasks.tasks[0].state, 'succeeded');
  assert.equal('calls' in tasks.tasks[0], false, '调用记录只挂助手消息');

  // 带图片时：外部 Agent 不是候选，明确停下来，不再发送。
  const visionEvents = await chat(app, member.cookie, session.id, '看看这张截图', {
    backend: 'agent', agentId,
    attachments: [{name: 'shot.png', type: 'image', mime: 'image/png', dataUrl: PNG}]
  });
  const candidate = visionEvents.find(event => event.type === 'candidate_required');
  assert.ok(candidate, '带图选外部 Agent 要停下来');
  assert.ok(candidate.candidates.every(item => item.kind !== 'agent'), '视觉候选里没有外部 Agent');
  assert.equal(visionEvents.find(event => event.type === 'error').code, 'CANDIDATE_REQUIRED');
  assert.equal(factory.log.filter(item => item.kind === 'callTool').length, 1, '没有额外发送内容');
});
