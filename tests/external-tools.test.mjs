import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {AgentConfig} from '../src/agents/config.mjs';
import {
  ExternalToolset, EXTERNAL_ERROR_CODES, EXTERNAL_RECOVERY, MAX_MODEL_TEXT, OUTBOUND_WARNING,
  assignSlugs, envelopeForModel, externalToolName, externalToolsSupported, mergeToolSurface
} from '../src/agents/tools.mjs';
import {runApiModel, API_TOOLS} from '../src/model/api-model.mjs';
import {startMockOpenAI} from './mock-openai.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

const readTool = (name = 'search', extra = {}) => ({
  name, title: name, description: '上游说明',
  annotations: {readOnlyHint: true},
  inputSchema: {type: 'object', properties: {q: {type: 'string'}}},
  ...extra
});
const desktopDescriptor = (overrides = {}) => ({
  name: 'mcp__dify__echo', description: '外部工具', parameters: {type: 'object', properties: {q: {type: 'string'}}},
  permission: 'read', external: true, agentId: 'agent-1', agentName: 'Dify 助手', agentSlug: 'dify',
  upstreamTool: 'echo', readOnly: true, timeoutMs: 63000, ...overrides
});
const okEnvelope = (tool, text = '外部结果') => ({
  status: 'ok', data: {text},
  evidence: {actorType: 'external_agent', agentId: tool.agentId, tool: tool.name, requestId: 'req-1', at: new Date().toISOString(), era: 'modern', durationMs: 1},
  readOnly: true, retryable: true
});

function fakeConnections(agents, {callImpl = null} = {}) {
  const byId = new Map(agents.map(agent => [agent.id, agent.list || []]));
  const connections = {
    log: [],
    byId,
    async pin(id) { connections.log.push({kind: 'pin', id}); return (byId.get(id) || []).map(tool => ({...tool})); },
    async status(id) { return {id, era: 'modern'}; },
    async callTool(id, name, args, options = {}) {
      connections.log.push({kind: 'callTool', id, name, args, options});
      if (callImpl) return callImpl({id, name, args, options});
      return {content: [{type: 'text', text: 'ok'}]};
    },
    async disconnect(id, reason) { connections.log.push({kind: 'disconnect', id, reason}); }
  };
  return connections;
}

async function setup(t, {tools = {}, callImpl = null, askConsent = async () => ({decision: 'always'}), options = {}} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'zx-ext-'));
  const home = join(dir, 'users', 'u1');
  const evidenceDir = join(home, 'tasks', 'task-1', 'evidence');
  const config = await new AgentConfig(home, null).load();
  const agents = [];
  for (const [name, list] of Object.entries(tools)) {
    const agent = await config.create({name, transport: 'http', url: 'https://agent' + agents.length + '.example.com/mcp'}, {isOwner: true});
    agents.push({...agent, list});
  }
  const connections = fakeConnections(agents, {callImpl});
  const toolsetOptions = {
    userId: 'u1', taskId: 'task-1', home, evidenceDir, config, connections,
    emit: options.emit || (() => {}),
    askConsent: options.askConsent || askConsent,
    sleep: options.sleep,
    callTimeoutMs: options.callTimeoutMs,
    graceMs: options.graceMs,
    maxRawBytes: options.maxRawBytes,
    maxEvidenceBytes: options.maxEvidenceBytes
  };
  if (options.now) toolsetOptions.now = options.now;
  const toolset = new ExternalToolset(toolsetOptions);
  t.after(() => rm(dir, {recursive: true, force: true}));
  return {dir, home, evidenceDir, config, connections, toolset, agents, toolsetOptions};
}

test('命名：mcp__<slug>__<tool>，slug 撞名加序号，长工具名截断加哈希且总长 ≤128', () => {
  assert.equal(externalToolName('dify', 'search'), 'mcp__dify__search');
  const slugs = assignSlugs([
    {id: '1', name: 'Dify 助手'},
    {id: '2', name: 'dify-助手'},
    {id: '3', name: 'A/B'},
    {id: '4', name: 'A B'},
    {id: '5', name: '职向'}
  ]);
  assert.deepEqual(slugs.map(item => item.slug), ['dify', 'dify-2', 'a-b', 'a-b-2', 'agent-5']);
  const long = 'x'.repeat(300);
  const short = externalToolName('dify', long);
  assert.ok(short.length <= 128, '长工具名总长不超过 128');
  assert.ok(short.startsWith('mcp__dify__'));
  assert.match(short, /-[0-9a-f]{8}$/);
  assert.notEqual(externalToolName('dify', long + 'y'), short, '不同原名不能截成同名');
  // 本地工具在前，上游工具在后
  const merged = mergeToolSurface([{name: 'company_list'}], [{name: 'mcp__a__x'}]);
  assert.deepEqual(merged.map(tool => tool.name), ['company_list', 'mcp__a__x']);
});

test('快照：任务开始时 pin；上游按 Agent 名排序，任务内增删工具不漂移', async t => {
  const {toolset, connections, agents} = await setup(t, {tools: {'Zeta': [readTool('z1')], 'Alpha': [readTool('a1')]}});
  const surface = await toolset.pin();
  assert.deepEqual(surface.tools.map(tool => tool.name), ['mcp__alpha__a1', 'mcp__zeta__z1']);
  const merged = mergeToolSurface(API_TOOLS, surface.tools);
  assert.deepEqual(merged.slice(0, API_TOOLS.length).map(tool => tool.name), API_TOOLS.map(tool => tool.name), '本地工具永远在前');
  assert.equal(surface.tools[0].readOnly, true);
  assert.equal(surface.tools[0].external, true);
  assert.equal(surface.tools[0].parameters.properties.q.type, 'string', '上游 inputSchema 进入模型工具面');
  for (const agent of agents) connections.byId.set(agent.id, [readTool('changed')]);
  assert.deepEqual(toolset.tools.map(tool => tool.name), ['mcp__alpha__a1', 'mcp__zeta__z1'], 'pin 后不随上游变化');
  const out = await toolset.callTool('mcp__alpha__a1', {q: 'x'}, {});
  assert.equal(out.status, 'ok');
  assert.equal(connections.log.find(item => item.kind === 'callTool').name, 'a1', '按上游原名调用');
});

test('信封：统一字段、图片资产占位、给模型 ≤64KB 且 truncated，完整响应写证据文件', async t => {
  const big = 'a'.repeat(70 * 1024);
  const callImpl = async () => ({
    content: [
      {type: 'text', text: big},
      {type: 'image', data: Buffer.from('PNGDATA').toString('base64'), mimeType: 'image/png'}
    ]
  });
  const {toolset, evidenceDir} = await setup(t, {tools: {'Dify 助手': [readTool()]}, callImpl});
  await toolset.pin();
  const out = await toolset.callTool('mcp__dify__search', {q: 'x'}, {});
  assert.equal(out.status, 'ok');
  assert.equal(out.evidence.actorType, 'external_agent');
  assert.deepEqual(Object.keys(out.evidence).sort(), ['actorType', 'agentId', 'at', 'durationMs', 'era', 'requestId', 'tool']);
  assert.equal(out.evidence.era, 'modern');
  assert.ok(out.evidence.durationMs >= 0);
  assert.equal(out.readOnly, true);
  assert.equal(out.retryable, true);
  assert.equal(out.truncated, true);
  assert.match(out.data.text, /〔图片已存为证据 /);
  assert.equal(out.assets.length, 1);
  assert.equal(out.assets[0].type, 'image');
  const modelText = envelopeForModel(out);
  assert.ok(Buffer.byteLength(modelText, 'utf8') <= MAX_MODEL_TEXT);
  assert.equal(JSON.parse(modelText).truncated, true);
  const files = await readdir(evidenceDir);
  const raw = files.find(name => name.startsWith('mcp-'));
  assert.ok(raw, '完整响应写进证据文件');
  const saved = JSON.parse(await readFile(join(evidenceDir, raw), 'utf8'));
  assert.equal(saved.result.content[0].text.length, big.length);
  assert.ok(files.some(name => name.endsWith('.png')), '图片落盘为证据资产');
});

test('证据文件：超过上限时截断，文件仍是合法 JSON 且不超过上限', async t => {
  const {toolset, evidenceDir} = await setup(t, {
    tools: {'Dify 助手': [readTool()]},
    callImpl: async () => ({content: [{type: 'text', text: 'b'.repeat(5000)}]}),
    options: {maxEvidenceBytes: 600}
  });
  await toolset.pin();
  await toolset.callTool('mcp__dify__search', {q: 'x'}, {});
  const file = (await readdir(evidenceDir)).find(name => name.startsWith('mcp-'));
  assert.ok(file);
  const text = await readFile(join(evidenceDir, file), 'utf8');
  assert.ok(Buffer.byteLength(text, 'utf8') <= 600);
  assert.equal(JSON.parse(text).truncated, true);
});

test('错误码：TOOL_ERROR / INVALID_RESULT / REQUEST_TIMEOUT / AUTH_FAILED / RESULT_TOO_LARGE 都带 recovery', async t => {
  for (const code of EXTERNAL_ERROR_CODES) assert.ok(EXTERNAL_RECOVERY[code], code + ' 必须有恢复建议');
  const cases = [
    {code: 'TOOL_ERROR', callImpl: async () => ({content: [{type: 'text', text: '上游说参数不对'}], isError: true})},
    {code: 'INVALID_RESULT', callImpl: async () => ({content: 'nope'})},
    {code: 'REQUEST_TIMEOUT', callImpl: async () => { throw Object.assign(new Error('request timed out'), {code: 'REQUEST_TIMEOUT'}); }},
    {code: 'AUTH_FAILED', callImpl: async () => { throw Object.assign(new Error('401 Unauthorized'), {status: 401}); }},
    {code: 'RESULT_TOO_LARGE', callImpl: async () => ({content: [{type: 'text', text: 'x'.repeat(4000)}]}), options: {maxRawBytes: 500}}
  ];
  for (const item of cases) {
    const {toolset} = await setup(t, {tools: {'Dify 助手': [readTool()]}, callImpl: item.callImpl, options: item.options || {}});
    await toolset.pin();
    const out = await toolset.callTool('mcp__dify__search', {q: 'x'}, {});
    assert.equal(out.status, 'error', item.code);
    assert.equal(out.error.code, item.code);
    assert.equal(out.error.recovery, EXTERNAL_RECOVERY[item.code]);
    assert.ok(out.error.message.length > 0);
  }
});

test('进度：单调递增、≥200ms 节流、事件字段齐全', async t => {
  let now = 1000;
  const events = [];
  const callImpl = async ({options}) => {
    options.onprogress({progress: 1, total: 6, message: '开始'});
    now += 250; options.onprogress({progress: 3, total: 6});
    now += 150; options.onprogress({progress: 2, total: 6});
    now += 49; options.onprogress({progress: 5, total: 6});
    now += 101; options.onprogress({progress: 6, total: 6});
    return {content: [{type: 'text', text: 'done'}]};
  };
  const {toolset, agents} = await setup(t, {tools: {'Dify 助手': [readTool()]}, callImpl, options: {emit: event => events.push(event), now: () => now}});
  await toolset.pin();
  await toolset.callTool('mcp__dify__search', {q: 'x'}, {});
  const progress = events.filter(event => event.type === 'tool_progress');
  assert.deepEqual(progress.map(event => event.progress), [1, 3, 6], '回退与节流窗口内的进度丢弃');
  for (const event of progress) {
    assert.equal(event.taskId, 'task-1');
    assert.equal(event.agentId, agents[0].id);
    assert.equal(event.tool, 'mcp__dify__search');
    assert.equal(event.total, 6);
  }
});

test('取消：结果丢弃记 CANCELLED，宽限期后丢连接；宽限期内结束则不额外丢连接', async t => {
  const hanging = () => new Promise(() => {});
  const first = await setup(t, {tools: {'Dify 助手': [readTool()]}, callImpl: hanging, options: {graceMs: 10, sleep: ms => new Promise(resolve => setTimeout(resolve, ms))}});
  await first.toolset.pin();
  const controller = new AbortController();
  const pending = first.toolset.callTool('mcp__dify__search', {q: 'x'}, {signal: controller.signal});
  setTimeout(() => controller.abort(), 5);
  const cancelled = await pending;
  assert.equal(cancelled.status, 'error');
  assert.equal(cancelled.error.code, 'CANCELLED');
  assert.equal(cancelled.error.recovery, EXTERNAL_RECOVERY.CANCELLED);
  assert.ok(first.connections.log.some(item => item.kind === 'disconnect'), '2 秒宽限（可注入）后丢连接');

  const slow = () => new Promise(resolve => setTimeout(() => resolve({content: [{type: 'text', text: 'late'}]}), 30));
  const second = await setup(t, {tools: {'Dify 助手': [readTool()]}, callImpl: slow, options: {graceMs: 200, sleep: ms => new Promise(resolve => setTimeout(resolve, ms))}});
  await second.toolset.pin();
  const controller2 = new AbortController();
  const pending2 = second.toolset.callTool('mcp__dify__search', {q: 'x'}, {signal: controller2.signal});
  setTimeout(() => controller2.abort(), 5);
  const late = await pending2;
  assert.equal(late.error.code, 'CANCELLED');
  assert.equal(late.data, undefined, '取消后的结果必须丢弃');
  assert.equal(second.connections.log.some(item => item.kind === 'disconnect'), false, '宽限期内结束就不额外丢连接');
});

test('调用参数：默认 60 秒超时，可覆盖但上限 300 秒；不自动重试', async t => {
  const one = await setup(t, {tools: {'Dify 助手': [readTool()]}});
  await one.toolset.pin();
  await one.toolset.callTool('mcp__dify__search', {q: '1'}, {});
  const call = one.connections.log.find(item => item.kind === 'callTool');
  assert.equal(call.options.timeout, 60000);
  assert.equal(one.connections.log.filter(item => item.kind === 'callTool').length, 1, '已发出的调用不自动重试');

  const two = await setup(t, {tools: {'Dify 助手': [readTool()]}, options: {callTimeoutMs: 999999}});
  await two.toolset.pin();
  await two.toolset.callTool('mcp__dify__search', {q: '2'}, {});
  assert.equal(two.connections.log.find(item => item.kind === 'callTool').options.timeout, 300000);
});

test('首次出网确认：同一任务只问一次；仅本次不持久，以后不再问写进配置并复用', async t => {
  const asked = [];
  const first = await setup(t, {
    tools: {'Dify 助手': [readTool()]},
    options: {askConsent: async ({agentName}) => { asked.push(agentName); return {decision: 'once'}; }}
  });
  const agentId = first.agents[0].id;
  await first.toolset.pin();
  await first.toolset.callTool('mcp__dify__search', {q: '1'}, {});
  await first.toolset.callTool('mcp__dify__search', {q: '2'}, {});
  assert.deepEqual(asked, ['Dify 助手'], '同一任务只问一次');
  assert.equal(first.config.outboundConsent(agentId).neverAsk, false, '仅本次不落配置');

  const second = new ExternalToolset({...first.toolsetOptions, askConsent: async () => ({decision: 'always'})});
  await second.pin();
  await second.callTool('mcp__dify__search', {q: '3'}, {});
  assert.equal(first.config.outboundConsent(agentId).neverAsk, true, '以后不再问落配置');
  const reloaded = await new AgentConfig(first.home, null).load();
  assert.equal(reloaded.outboundConsent(agentId).neverAsk, true, '重启后仍然记得');
  await reloaded.update(agentId, {name: 'Dify 助手（改名）'}, {isOwner: true});
  assert.equal(reloaded.outboundConsent(agentId).neverAsk, true, '改配置不能清掉出网同意');

  let askedAgain = 0;
  const third = new ExternalToolset({...first.toolsetOptions, askConsent: async () => { askedAgain += 1; return {decision: 'reject'}; }});
  await third.pin();
  const out = await third.callTool('mcp__dify__search', {q: '4'}, {});
  assert.equal(askedAgain, 0, '已选以后不再问就不再弹');
  assert.equal(out.status, 'ok');
  assert.match(OUTBOUND_WARNING, /看到|副作用/);
});

test('首次出网确认：拒绝时不发送内容，返回 CANCELLED 并留外部调用证据', async t => {
  const events = [];
  const {toolset, connections} = await setup(t, {
    tools: {'Dify 助手': [readTool()]},
    options: {emit: event => events.push(event), askConsent: async () => ({decision: 'reject'})}
  });
  await toolset.pin();
  const out = await toolset.callTool('mcp__dify__search', {q: 'secret'}, {});
  assert.equal(out.status, 'error');
  assert.equal(out.error.code, 'CANCELLED');
  assert.equal(connections.log.some(item => item.kind === 'callTool'), false, '拒绝后绝不把内容发出去');
  assert.ok(events.some(event => event.type === 'evidence' && event.evidence.kind === 'external_call' && /CANCELLED/.test(event.evidence.detail)));
});

test('上游写：readOnlyHint 缺省按写；幂等键透传，否则 retryable:false；写调用记证据与远端副作用提示', async t => {
  const events = [];
  const tools = {'Dify 助手': [
    {name: 'lookup', annotations: {readOnlyHint: true}, inputSchema: {type: 'object', properties: {q: {type: 'string'}}}},
    {name: 'publish', inputSchema: {type: 'object', properties: {idempotencyKey: {type: 'string'}, title: {type: 'string'}}}},
    {name: 'remove', inputSchema: {type: 'object', properties: {title: {type: 'string'}}}}
  ]};
  const {config, toolset, connections, agents} = await setup(t, {tools, options: {emit: event => events.push(event)}});
  await config.approveOutbound(agents[0].id, {neverAsk: true});
  await toolset.pin();
  assert.deepEqual(toolset.tools.map(tool => [tool.upstreamTool, tool.readOnly]), [['lookup', true], ['publish', false], ['remove', false]]);
  const lookup = await toolset.callTool('mcp__dify__lookup', {q: 'x'}, {});
  assert.equal(lookup.readOnly, true);
  assert.equal(lookup.retryable, true);
  const publish = await toolset.callTool('mcp__dify__publish', {title: 't'}, {});
  const publishCall = connections.log.filter(item => item.kind === 'callTool').at(-1);
  assert.match(publishCall.args.idempotencyKey, /^task-task-1-\d+$/, '有幂等键字段就透传我们的键');
  assert.equal(publish.readOnly, false);
  assert.equal(publish.retryable, true);
  const remove = await toolset.callTool('mcp__dify__remove', {title: 't'}, {});
  assert.equal(remove.retryable, false, '没有幂等键字段就标不可重试');
  assert.equal(connections.log.filter(item => item.kind === 'callTool').at(-1).args.idempotencyKey, undefined);
  const evidence = events.filter(event => event.type === 'evidence').map(event => event.evidence);
  assert.ok(evidence.some(item => /写/.test(item.label)), '写调用记外部调用事件并提示远端副作用不可撤销');
  assert.ok(evidence.every(item => /只读|写/.test(item.label)));
});

test('Codex：动态外部工具不可用时给出明确说明，不静默假装', () => {
  const codex = externalToolsSupported('codex');
  assert.equal(codex.supported, false);
  assert.match(codex.message, /Codex/);
  assert.match(codex.message, /不支持|只/);
  assert.equal(externalToolsSupported('api').supported, true);
});

test('动态工具面：模型拿到的工具与本地一致，mcp__* 走外部调用，结果回到模型', async () => {
  const mock = await startMockOpenAI();
  try {
    const config = {protocol: 'chat', baseUrl: mock.url, model: 'mock-model', stream: true, maxTokens: 2048};
    const calls = [];
    const out = await runApiModel({
      root, prompt: '请调用外部工具', search: true, config,
      externalTools: [desktopDescriptor()],
      externalCaller: async (tool, args) => {
        calls.push({name: tool.name, args});
        return okEnvelope(tool);
      }
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'mcp__dify__echo');
    const offered = mock.state.requests[0].tools.map(tool => tool.function?.name);
    assert.ok(offered.includes('mcp__dify__echo'), '外部工具进入模型工具面');
    assert.ok(offered.includes('career_platform_status'), '本地工具仍在');
    assert.ok(out.trace.some(item => item.label === 'mcp__dify__echo'));
    const toolMessage = mock.state.requests[1].messages.filter(message => message.role === 'tool').at(-1);
    assert.match(toolMessage.content, /外部结果/);
    assert.match(out.toolEvidence.join('\n'), /mcp__dify__echo/);
  } finally { await mock.close(); }
});

test('动态工具面：单次结果给模型 ≤64KB，超额标记 truncated', async () => {
  const mock = await startMockOpenAI();
  try {
    const config = {protocol: 'chat', baseUrl: mock.url, model: 'mock-model', stream: true, maxTokens: 2048};
    await runApiModel({
      root, prompt: '请调用外部工具', search: true, config,
      externalTools: [desktopDescriptor()],
      externalCaller: async tool => ({...okEnvelope(tool, 'y'.repeat(100 * 1024)), truncated: true})
    });
    const toolMessage = mock.state.requests[1].messages.filter(message => message.role === 'tool').at(-1);
    assert.ok(Buffer.byteLength(toolMessage.content, 'utf8') <= MAX_MODEL_TEXT);
    assert.equal(JSON.parse(toolMessage.content).truncated, true);
  } finally { await mock.close(); }
});

test('调用计数：外部工具与本地工具共用每次任务 8 次调用上限', async () => {
  const mock = await startMockOpenAI();
  try {
    const config = {protocol: 'chat', baseUrl: mock.url, model: 'mock-model', stream: true, maxTokens: 2048};
    const calls = [];
    await assert.rejects(
      runApiModel({
        root, prompt: '请反复调用外部工具', search: true, config,
        externalTools: [desktopDescriptor({parameters: {type: 'object', properties: {q: {type: 'string'}}}})],
        externalCaller: async tool => { calls.push(tool.name); return okEnvelope(tool); }
      }),
      /8次调用上限/
    );
    assert.equal(calls.length, 8);
  } finally { await mock.close(); }
});
