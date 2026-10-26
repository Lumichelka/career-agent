import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, mkdir, writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from '../src/server/app.mjs';
import {RecruitStore} from '../src/recruit/store.mjs';
import {buildReviewPrompt, parseReviewIssues} from '../src/source-check/review.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const DETAIL_URL = 'https://job3.swufe.edu.cn/jobfair/jobfair-show-123.htm';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture() {
  return JSON.parse(readFileSync(new URL('./fixtures/swufe/extraction.json', import.meta.url), 'utf8'));
}

// 假 MCP Agent：只在进程内实现 connect / listTools / callTool，绝不启动真实进程或联网。
// 同时挂一个写工具，用来断言复核者拿不到写工具、也不会调用它。
function fakeAgentFactory({callFail = null, connectFail = null, text = ''} = {}) {
  const log = [];
  const factory = async context => {
    factory.calls += 1;
    const index = factory.calls;
    log.push({kind: 'context', index, agent: context.agent.name});
    return {
      pid: null,
      era: () => 'modern',
      serverInfo: () => ({name: 'fake-review-agent', version: '1.0.0'}),
      connect: async () => {
        log.push({kind: 'connect', index});
        if (connectFail) throw connectFail;
      },
      // 故意同时暴露一个写工具：复核接口只能自己挑只读且收 prompt 的工具。
      listTools: async () => ({tools: [
        {
          name: 'review_extraction', title: '复核抽取', description: '接收抽取 JSON，返回问题列表',
          annotations: {readOnlyHint: true},
          inputSchema: {type: 'object', properties: {prompt: {type: 'string'}}, required: ['prompt']}
        },
        {
          name: 'danger_write', title: '写库', description: '会写业务数据',
          annotations: {readOnlyHint: false},
          inputSchema: {type: 'object', properties: {prompt: {type: 'string'}, idempotencyKey: {type: 'string'}}}
        }
      ]}),
      callTool: async (name, args) => {
        log.push({kind: 'callTool', index, name, args});
        if (callFail) throw callFail;
        return {content: [{type: 'text', text}]};
      },
      close: async () => { log.push({kind: 'close', index}); }
    };
  };
  factory.calls = 0;
  factory.log = log;
  return factory;
}

function fakeReader() {
  return async ({source, evidenceDir}) => {
    await mkdir(evidenceDir, {recursive: true});
    const at = new Date().toISOString();
    await writeFile(join(evidenceDir, '01-list.png'), PNG);
    await writeFile(join(evidenceDir, '02-detail.png'), PNG);
    return {
      screenshots: [
        {id: 'list', kind: 'screenshot', file: join(evidenceDir, '01-list.png'), url: source.listUrl, title: '双选会列表', at, viewport: {width: 1366, height: 900}},
        {id: 'detail', kind: 'screenshot', file: join(evidenceDir, '02-detail.png'), url: DETAIL_URL, title: '西南财经大学2026届秋季双选会', at, viewport: {width: 1366, height: 900}}
      ]
    };
  };
}

const fakeExtractor = () => async () => fixture();

async function startApp(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'zx-agent-review-'));
  const app = await createApp({root, dataDir: dir, host: '127.0.0.1', port: 0, ...options});
  t.after(async () => { await app.close(); await rm(dir, {recursive: true, force: true}); });
  return app;
}

function cookieOf(response) {
  const set = (response.headers.getSetCookie?.() || [response.headers.get('set-cookie')]).filter(Boolean);
  return set.map(value => value.split(';')[0]).join('; ');
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
async function waitFor(check, {timeoutMs = 20000, intervalMs = 40} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await wait(intervalMs);
  }
  throw new Error('等待条件超时');
}
async function finishedTask(app, cookie) {
  return waitFor(async () => {
    const listed = await getJson(app, '/api/tasks', cookie);
    const task = listed.tasks[0];
    return task && ['succeeded', 'failed', 'blocked', 'cancelled', 'undone'].includes(task.state) ? task : null;
  });
}
function withStore(app, user, fn) {
  const store = RecruitStore.open(join(app.dataDir, 'users', user.id, '.data', 'recruit.db'));
  try { return fn(store); } finally { store.close(); }
}
function snapshot(app, user) {
  return withStore(app, user, store => ({
    events: store.db.prepare('SELECT * FROM events ORDER BY id').all(),
    projects: store.db.prepare('SELECT * FROM event_projects ORDER BY id').all(),
    audits: store.db.prepare('SELECT * FROM write_audit ORDER BY seq').all()
  }));
}

const ISSUES = [
  {row: 'events[0]', field: 'title', issue: '标题可能漏了“秋季”', severity: 'medium'},
  {row: 'projects[1]', field: 'company', issue: '单位名像是简称', severity: 'low'}
];

test('复核提示词与解析：只给抽取 JSON 与来源元数据，问题列表可解析', () => {
  const extraction = fixture();
  const prompt = buildReviewPrompt({extraction, source: {id: 'swufe-xjh', name: '西南财经大学就业信息网', listUrl: 'https://job3.swufe.edu.cn/jobfair/jobfair-list-.htm', detailUrl: DETAIL_URL}});
  assert.match(prompt, /西南财经大学就业信息网/);
  assert.match(prompt, /events/);
  assert.ok(prompt.includes('中国银行四川省分行'), '提示词要带抽取 JSON 的正文');
  for (const needle of ['01-list.png', '02-detail.png', 'screenshots', 'iVBORw0KGgo', 'career_recruit_bulk_write', 'danger_write']) {
    assert.ok(!prompt.includes(needle), '提示词不能包含截图/写工具：' + needle);
  }
  assert.match(prompt, /问题列表/);
  assert.match(prompt, /不.*修改/);

  assert.equal(parseReviewIssues('这不是 JSON'), null);
  assert.deepEqual(parseReviewIssues('{"issues":' + JSON.stringify(ISSUES) + '}'), ISSUES);
  assert.deepEqual(parseReviewIssues('结果如下：\n' + '```json\n' + JSON.stringify(ISSUES) + '\n```'), ISSUES);
  assert.deepEqual(parseReviewIssues(JSON.stringify({issues: []})), []);
});

test('复核：假 Agent 返回问题列表，任务卡有数量与证据，写入集与审计未变，调用只进助手消息 step=review', {timeout: 60000}, async t => {
  const factory = fakeAgentFactory({text: JSON.stringify({issues: ISSUES})});
  const app = await startApp(t, {agentClientFactory: factory, sourceCheck: {browserReader: fakeReader(), extractor: fakeExtractor()}});
  const member = await register(app, 'review-user');
  const created = await postJson(app, '/api/agents', member.cookie, {name: '复核助手', transport: 'http', url: 'https://review.example.com/mcp', token: 'sk-review-secret'});

  const started = await postJson(app, '/api/source-check/start', member.cookie, {sourceId: 'swufe'});
  const task = await finishedTask(app, member.cookie);
  assert.equal(task.state, 'succeeded', '复核不阻塞写库：' + JSON.stringify(task.error));
  assert.equal(task.counts.writes, 4);
  assert.equal(task.counts.batches, 1);

  // 任务卡数据：复核 2 个问题，建议制不自动改写入集。
  assert.equal(task.review.status, 'issues');
  assert.equal(task.review.count, 2);
  assert.deepEqual(task.review.issues, ISSUES);
  assert.equal(task.review.agentLeg, 'passed');
  assert.equal(task.review.agent.name, '复核助手');
  assert.equal('calls' in task, false, '调用记录不能进任务记录');
  assert.equal('call' in (task.review || {}), false, '任务记录里不能有调用记录');

  // 写入集与审计保持不变：复核只读，不拿写工具。
  const rows = snapshot(app, member.user);
  assert.equal(rows.events.length, 1);
  assert.equal(rows.projects.length, 3);
  assert.equal(rows.audits.length, 4);
  assert.ok(rows.audits.every(row => row.task_id === started.taskId));

  // 复核输出存任务证据；只读工具被调用一次，写工具从未被调用。
  assert.ok(task.evidence.some(item => item.kind === 'review'), '任务证据里应有复核结果');
  const calls = factory.log.filter(item => item.kind === 'callTool');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'review_extraction');
  assert.ok(!factory.log.some(item => item.kind === 'callTool' && item.name === 'danger_write'), '不能调用写工具');
  const prompt = calls[0].args.prompt;
  assert.ok(prompt.includes('西南财经大学2026届秋季双选会'));
  for (const needle of ['01-list.png', '02-detail.png', 'iVBORw0KGgo']) assert.ok(!prompt.includes(needle), '截图不能发给复核 Agent：' + needle);
  assert.equal('screenshots' in calls[0].args, false);

  // 复核调用只出现在助手消息的调用表：step=review，任务记录没有 calls。
  const session = await getJson(app, '/api/session/' + started.sessionId, member.cookie);
  const assistants = session.messages.filter(message => message.role === 'assistant');
  assert.equal(assistants.length, 1, '来源校对没有助手消息时补一条');
  const reviewCalls = assistants[0].calls || [];
  assert.equal(reviewCalls.length, 1);
  assert.equal(reviewCalls[0].step, 'review');
  assert.equal(reviewCalls[0].outcome, 'ok');
  assert.ok(Number.isFinite(reviewCalls[0].durationMs));
  assert.match(reviewCalls[0].backend.label, /复核助手/);
  assert.equal('calls' in task, false);

  // 复核证据文件可读取，且不含截图。
  const reviewEvidence = task.evidence.find(item => item.kind === 'review');
  assert.match(reviewEvidence.url, /file=review\.json/);
  const response = await fetch(app.origin + reviewEvidence.url, {headers: {'x-career-token': app.token, cookie: member.cookie}});
  assert.equal(response.status, 200);
  const reviewFile = await response.text();
  assert.ok(reviewFile.includes('标题可能漏了'));
  assert.ok(!reviewFile.includes('01-list.png'));
});

test('复核：Agent 超时 -> 任务成功但标复核不可用，带错误码与恢复建议，写库照常', {timeout: 60000}, async t => {
  const timeout = Object.assign(new Error('上游响应超时'), {code: 'REQUEST_TIMEOUT'});
  const factory = fakeAgentFactory({callFail: timeout});
  const app = await startApp(t, {agentClientFactory: factory, sourceCheck: {browserReader: fakeReader(), extractor: fakeExtractor()}});
  const member = await register(app, 'review-timeout-user');
  await postJson(app, '/api/agents', member.cookie, {name: '会超时的复核助手', transport: 'http', url: 'https://review.example.com/mcp', token: 'sk-review-secret'});

  const started = await postJson(app, '/api/source-check/start', member.cookie, {sourceId: 'swufe'});
  const task = await finishedTask(app, member.cookie);
  assert.equal(task.state, 'succeeded', '复核失败不能把写库任务判失败');
  assert.equal(task.counts.writes, 4);
  assert.equal(task.review.status, 'unavailable');
  assert.equal(task.review.error.code, 'REQUEST_TIMEOUT');
  assert.ok(task.review.error.recovery, '要有恢复建议');
  assert.equal(task.review.agentLeg, 'failed', '验收的 Agent 路径记为未通过');

  const rows = snapshot(app, member.user);
  assert.equal(rows.events.length, 1);
  assert.equal(rows.projects.length, 3);
  assert.equal(rows.audits.length, 4);

  // 失败也留一条 step=review 的调用记录，方便对账。
  const session = await getJson(app, '/api/session/' + started.sessionId, member.cookie);
  const call = (session.messages.find(message => message.role === 'assistant')?.calls || [])[0];
  assert.equal(call.step, 'review');
  assert.equal(call.outcome, 'failed');
  assert.equal(call.errorCode, 'REQUEST_TIMEOUT');
});