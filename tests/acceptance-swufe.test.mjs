import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, mkdir, writeFile, readFile} from 'node:fs/promises';
import {existsSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createApp} from '../src/server/app.mjs';
import {RecruitStore} from '../src/recruit/store.mjs';
import {resolveSource, writeSourceCheck, SOURCE_CHECK_NOTES} from '../src/source-check/pipeline.mjs';
import {verifyManifest} from '../docs/acceptance/24-swufe/verify-evidence.mjs';

// #42 西南财大首验的确定性回归：临时数据目录 + 固定抽取 fixture + 本地假浏览器/假视觉/假 MCP Agent，
// 跑真实的来源校对任务、写网关、审计与撤销代码。不联网、不启动 Chrome、不调视觉 API。
const root = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = new URL('./fixtures/swufe/extraction.json', import.meta.url);
const SOURCE = resolveSource('swufe-xjh');
const DETAIL_URL = 'https://job3.swufe.edu.cn/jobfair/jobfair-show-123.htm';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// live 录制的固定抽取结果（联系方式已剔除）；值本身是硬编码的已知样例，不从被测代码推导。
const FIXED_EVENT_TITLE = '西南财经大学2026届秋季双选会';
const FIXED_COMPANIES = ['中国银行四川省分行', '四川发展（控股）有限责任公司', '成都银行股份有限公司'];

// 假视觉模型会额外带回联系方式：验证抽取清洗、写库与审计里联系方式 0 条。
const CONTACTS = {contact: '张老师', phone: '13800138000', email: 'job@swufe.edu.cn', wechat: 'swufe-job', idcard: '510100199001011234'};
const CONTACT_NEEDLES = [
  ...Object.values(CONTACTS), '李经理', '13900139000', 'hr@example.com', 'swufe-job',
  '510100199001011234', 'contactName', 'contact', 'contacts', 'phone', 'email', 'wechat', 'idcard'
];
const ISSUES = [
  {row: 'events[0]', field: 'title', issue: '标题可能漏了“秋季”', severity: 'medium'},
  {row: 'projects[1]', field: 'company', issue: '单位名像是简称', severity: 'low'}
];

function fixture() {
  return JSON.parse(readFileSync(FIXTURE, 'utf8'));
}

function withContacts(raw) {
  return {
    ...raw,
    events: raw.events.map(event => ({...event, contacts: {...CONTACTS}})),
    projects: raw.projects.map(project => ({...project, contactName: '李经理', phone: '13900139000', email: 'hr@example.com'}))
  };
}

function collectKeys(value, keys = []) {
  if (Array.isArray(value)) { for (const item of value) collectKeys(item, keys); return keys; }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) { keys.push(key); collectKeys(item, keys); }
  }
  return keys;
}

function assertNoContacts(value, label) {
  const text = JSON.stringify(value);
  for (const needle of CONTACT_NEEDLES) assert.ok(!text.includes(needle), label + ' 不能包含联系方式：' + needle);
  const keys = collectKeys(value).map(key => key.toLowerCase());
  for (const key of ['contact', 'contacts', 'phone', 'mobile', 'email', 'wechat', 'weixin', 'idcard', 'contactname']) {
    assert.ok(!keys.includes(key), label + ' 不能包含联系字段：' + key);
  }
}

// 假浏览器：不启动真实浏览器、不联网；按契约写两张截图并记录两次页面读取。
function fakeReader() {
  const calls = [];
  const reader = async ({source, evidenceDir}) => {
    calls.push({kind: 'list', url: source.listUrl});
    await mkdir(evidenceDir, {recursive: true});
    const at = new Date().toISOString();
    await writeFile(join(evidenceDir, '01-list.png'), PNG);
    calls.push({kind: 'detail', url: DETAIL_URL});
    await writeFile(join(evidenceDir, '02-detail.png'), PNG);
    return {
      screenshots: [
        {id: 'list', kind: 'screenshot', file: join(evidenceDir, '01-list.png'), url: source.listUrl, title: '双选会列表', at, viewport: {width: 1366, height: 900}},
        {id: 'detail', kind: 'screenshot', file: join(evidenceDir, '02-detail.png'), url: DETAIL_URL, title: FIXED_EVENT_TITLE, at, viewport: {width: 1366, height: 900}}
      ]
    };
  };
  reader.calls = calls;
  return reader;
}

// 假视觉抽取器：固定 fixture + 一组联系方式；绝不调用模型 API。
function fakeExtractor() {
  const calls = [];
  const extractor = async ({screenshots}) => {
    calls.push({screenshots: screenshots.map(shot => shot.id)});
    return withContacts(fixture());
  };
  extractor.calls = calls;
  return extractor;
}

// 本地假 MCP Agent：只在进程内实现 connect / listTools / callTool，不启动进程、不联网。
// 同时暴露一个写工具，断言复核只挑只读且收 prompt 的工具。
function fakeAgentFactory(text) {
  const log = [];
  const factory = async context => {
    factory.calls += 1;
    const index = factory.calls;
    log.push({kind: 'context', index, agent: context.agent.name});
    return {
      pid: null,
      era: () => 'modern',
      serverInfo: () => ({name: 'acceptance-fake-review-agent', version: '1.0.0'}),
      connect: async () => { log.push({kind: 'connect', index}); },
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
        return {content: [{type: 'text', text}]};
      },
      close: async () => { log.push({kind: 'close', index}); }
    };
  };
  factory.calls = 0;
  factory.log = log;
  return factory;
}

async function startApp(t, {reader, extractor, factory}) {
  const dir = await mkdtemp(join(tmpdir(), 'zx-acceptance-swufe-'));
  const app = await createApp({
    root, dataDir: dir, host: '127.0.0.1', port: 0,
    agentClientFactory: factory,
    sourceCheck: {browserReader: reader, extractor}
  });
  t.after(async () => { await app.close(); await rm(dir, {recursive: true, force: true}); });
  return app;
}

function cookieOf(response) {
  return (response.headers.getSetCookie?.() || [response.headers.get('set-cookie')]).filter(Boolean).map(value => value.split(';')[0]).join('; ');
}

async function register(app, name) {
  const response = await fetch(app.origin + '/api/auth/register', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'x-career-token': app.token},
    body: JSON.stringify({name, password: 'correct-horse-battery'})
  });
  const body = await response.json();
  assert.equal(response.status, 200, name + ' 注册失败：' + JSON.stringify(body));
  return {user: body.user, cookie: cookieOf(response)};
}

function headers(app, cookie) {
  return {'Content-Type': 'application/json', 'x-career-token': app.token, cookie};
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

function dbPath(app, user) {
  return join(app.dataDir, 'users', user.id, '.data', 'recruit.db');
}

// 每次读库都开短连接并立即关闭，避免 Windows 删除临时目录时被 WAL 句柄占住。
function withStore(app, user, fn) {
  const store = RecruitStore.open(dbPath(app, user));
  try { return fn(store); } finally { store.close(); }
}

// 验收前 / 撤销后快照：整行 + 内容 sha256（与 docs/plan/24 §7 的判定口径一致）。
function snapshot(store) {
  const events = store.db.prepare('SELECT * FROM events ORDER BY id').all();
  const projects = store.db.prepare('SELECT * FROM event_projects ORDER BY id').all();
  return {events, projects, hash: createHash('sha256').update(JSON.stringify({events, projects})).digest('hex')};
}

function configureFakeReviewer(app, cookie) {
  return postJson(app, '/api/agents', cookie, {
    name: '本地假复核 Agent',
    transport: 'http',
    url: 'https://review.invalid/mcp',
    token: 'sk-local-fake-review'
  });
}

function evidenceDirOf(app, user, taskId) {
  return join(app.dataDir, 'users', user.id, 'tasks', taskId, 'evidence');
}

function readAuditRows(app, user) {
  return withStore(app, user, store => store.db.prepare('SELECT * FROM write_audit ORDER BY seq').all());
}

test('首验回归：来源校对全链路（两次浏览器读取 + 抽取 + 复核 + 写库 + 审计 1:1 + 幂等 + 任务级撤销）', {timeout: 60000}, async t => {
  const rawFixture = fixture();
  assert.equal(rawFixture.events.length, 1);
  assert.equal(rawFixture.events[0].title, FIXED_EVENT_TITLE, '固定 fixture 的值是已知样例');
  assert.deepEqual(rawFixture.projects.map(project => project.company), FIXED_COMPANIES);
  assertNoContacts(rawFixture, '固定抽取 fixture'); // fixture 本身已剔除联系方式

  const reader = fakeReader();
  const extractor = fakeExtractor();
  const factory = fakeAgentFactory(JSON.stringify({issues: ISSUES}));
  const app = await startApp(t, {reader, extractor, factory});
  const member = await register(app, 'acceptance-swufe-clean');
  await configureFakeReviewer(app, member.cookie);

  // 验收前快照：空库。
  const before = withStore(app, member.user, store => snapshot(store));
  assert.deepEqual(before.events, []);
  assert.deepEqual(before.projects, []);

  // 目标站直连请求计数：包住 globalThis.fetch，只用于断言没有向 swufe 发抓取请求。
  const realFetch = globalThis.fetch;
  const fetchedUrls = [];
  globalThis.fetch = (input, init) => {
    fetchedUrls.push(String(typeof input === 'string' ? input : input?.url || ''));
    return realFetch(input, init);
  };
  let started;
  let task;
  try {
    started = await postJson(app, '/api/source-check/start', member.cookie, {sourceId: 'swufe'});
    task = await finishedTask(app, member.cookie);
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(started.ok, true);
  assert.equal(started.sourceId, 'swufe-xjh', 'swufe 别名归一到真实来源 id');
  assert.match(started.taskId, /^[a-f0-9-]{36}$/);
  assert.equal(task.state, 'succeeded', '任务卡成功：' + JSON.stringify(task.error));
  assert.equal(task.counts.batches, 1);
  assert.equal(task.counts.writes, 4, '1 场活动 + 3 个单位');
  assert.equal('calls' in task, false, '调用记录不能进任务记录');

  // 1) 入口与浏览器边界：只读列表 + 一场详情各一次，各截图一次；不翻页、不并发。
  assert.deepEqual(reader.calls.map(call => call.kind), ['list', 'detail']);
  assert.equal(reader.calls.length, 2);
  assert.equal(extractor.calls.length, 1);
  assert.deepEqual(extractor.calls[0].screenshots, ['list', 'detail'], '视觉抽取只看两张截图');
  const evidenceDir = evidenceDirOf(app, member.user, started.taskId);
  for (const file of ['01-list.png', '02-detail.png', 'screenshots.json', 'extraction.json', 'review.json']) {
    assert.ok(existsSync(join(evidenceDir, file)), '证据文件必须落盘：' + file);
  }
  const shots = JSON.parse(await readFile(join(evidenceDir, 'screenshots.json'), 'utf8'));
  assert.equal(shots.length, 2);
  assert.deepEqual(shots.map(shot => shot.url), [SOURCE.listUrl, DETAIL_URL]);

  // 2) 外部 Agent 文本复核：建议制，只收到抽取 JSON（无截图、无联系方式），不拿写工具。
  assert.equal(task.review.status, 'issues');
  assert.equal(task.review.count, 2);
  assert.deepEqual(task.review.issues, ISSUES);
  assert.equal(task.review.agentLeg, 'passed');
  const reviewCalls = factory.log.filter(item => item.kind === 'callTool');
  assert.equal(reviewCalls.length, 1);
  assert.equal(reviewCalls[0].name, 'review_extraction');
  assert.ok(!factory.log.some(item => item.kind === 'callTool' && item.name === 'danger_write'), '复核不能调用写工具');
  const prompt = reviewCalls[0].args.prompt;
  assert.ok(prompt.includes(FIXED_EVENT_TITLE));
  for (const needle of ['01-list.png', '02-detail.png', 'iVBORw0KGgo', ...CONTACT_NEEDLES]) {
    assert.ok(!prompt.includes(needle), '复核 prompt 不能包含截图或联系方式：' + needle);
  }
  const session = await getJson(app, '/api/session/' + started.sessionId, member.cookie);
  const assistantCalls = session.messages.filter(message => message.role === 'assistant').flatMap(message => message.calls || []);
  assert.equal(assistantCalls.length, 1);
  assert.equal(assistantCalls[0].step, 'review');
  assert.equal(assistantCalls[0].outcome, 'ok');
  const reviewFile = JSON.parse(await readFile(join(evidenceDir, 'review.json'), 'utf8'));
  assert.deepEqual(reviewFile.issues, ISSUES);
  assert.ok(!JSON.stringify(reviewFile).includes('01-list.png'));

  // 3) 抽取：固定 fixture + 注入联系方式 -> 清洗后只剩活动与单位。
  const extraction = JSON.parse(await readFile(join(evidenceDir, 'extraction.json'), 'utf8'));
  assert.equal(extraction.events.length, 1);
  assert.equal(extraction.projects.length, 3);
  assert.equal(extraction.events[0].title, FIXED_EVENT_TITLE);
  assert.deepEqual(extraction.projects.map(project => project.company), FIXED_COMPANIES);
  assert.equal(extraction.events[0].endAt, '', '读不到的字段留空');
  assertNoContacts(extraction, '抽取证据');

  // 4) 写库边界：只写 events / event_projects；source_id=manual；source_url 只记录；notes 标非采集器。
  const rows = withStore(app, member.user, store => ({
    events: store.db.prepare('SELECT * FROM events ORDER BY id').all(),
    projects: store.db.prepare('SELECT * FROM event_projects ORDER BY id').all(),
    audits: store.db.prepare('SELECT * FROM write_audit ORDER BY seq').all(),
    idem: store.db.prepare('SELECT * FROM idempotency').all(),
    runs: store.db.prepare('SELECT COUNT(*) c FROM runs').get().c,
    rawPages: store.db.prepare('SELECT COUNT(*) c FROM raw_pages').get().c
  }));
  assert.equal(rows.events.length, 1);
  assert.equal(rows.projects.length, 3);
  assert.equal(rows.events[0].source_id, 'manual');
  assert.equal(rows.events[0].source_url, DETAIL_URL);
  assert.match(rows.events[0].notes, /浏览器截图读取（非采集器）/);
  assert.equal(rows.events[0].school, '西南财经大学');
  assert.equal(rows.events[0].city, '成都');
  assert.equal(rows.events[0].kind, '双选会');
  assert.equal(SOURCE_CHECK_NOTES, '浏览器截图读取（非采集器）');
  for (const project of rows.projects) {
    assert.equal(project.source_id, 'manual');
    assert.equal(project.source_url, DETAIL_URL);
    assert.match(project.notes, /浏览器截图读取（非采集器）/);
  }
  assertNoContacts(rows.events, 'events 行');
  assertNoContacts(rows.projects, 'event_projects 行');
  assert.equal(rows.runs, 0, '不调用采集器：没有采集运行记录');
  assert.equal(rows.rawPages, 0, '不抓取原始页面：fetchText 路径未发生');
  assert.ok(!existsSync(join(app.dataDir, 'users', member.user.id, '.data', 'company.db')), '不写公司档案库 company.db');

  // 5) 审计 1:1：每写一行恰好一条审计；同批次、同任务、来源指向截图、旧值/新值完整。
  assert.equal(rows.audits.length, 4);
  assert.equal(new Set(rows.audits.map(row => row.batch_id)).size, 1);
  assert.ok(rows.audits.every(row => row.task_id === started.taskId));
  assert.ok(rows.audits.every(row => row.actor_type === 'model_api'));
  assert.ok(rows.audits.every(row => row.source_ref === 'artifact:02-detail.png'));
  assert.ok(rows.audits.every(row => row.action === 'create'));
  assert.ok(rows.audits.every(row => row.old_values === null));
  const writtenIds = new Set([...rows.events, ...rows.projects].map(row => row.id));
  const auditedIds = new Set(rows.audits.map(row => row.entity_id));
  assert.deepEqual(auditedIds, writtenIds, '数据行与审计事件 1:1（无漏审计、无多余审计）');
  for (const row of rows.audits) {
    const values = JSON.parse(row.new_values);
    assert.equal(values.id, row.entity_id);
    assertNoContacts(values, '审计 new_values');
    assert.ok(!('contact' in values) && !('phone' in values));
  }
  assert.equal(rows.idem.length, 1);
  assert.equal(rows.idem[0].status, 'completed');
  assert.equal(rows.idem[0].key, 'source-check:' + started.taskId + ':write');
  assert.deepEqual(fetchedUrls.filter(url => /swufe\.edu\.cn/i.test(url)), [], '不向目标站发直连 HTTP 请求');

  // 6) 来源卡：保持采集器禁用，只记「最近手动读取 + 原因」。
  const sources = await getJson(app, '/api/recruit/sources', member.cookie);
  const swufe = sources.sources.find(source => source.id === 'swufe-xjh');
  assert.equal(swufe.enabled, 0);
  assert.equal(swufe.last_status, null);
  assert.equal(sources.manualReads['swufe-xjh'].status, 'succeeded');
  assert.match(sources.manualReads['swufe-xjh'].reason, /采集器.*禁用/);

  // 7) 幂等重放：同任务 + 同抽取结果重放，不新增行/审计，只标 duplicate。
  const replay = await writeSourceCheck({
    dataDir: app.dataDir,
    userId: member.user.id,
    taskId: started.taskId,
    extraction,
    source: {...SOURCE, detailUrl: DETAIL_URL},
    screenshots: shots
  });
  assert.equal(replay.status, 'replayed');
  assert.equal(replay.duplicate, true);
  const afterReplay = withStore(app, member.user, store => ({
    events: store.db.prepare('SELECT COUNT(*) c FROM events').get().c,
    projects: store.db.prepare('SELECT COUNT(*) c FROM event_projects').get().c,
    audits: store.db.prepare('SELECT COUNT(*) c FROM write_audit').get().c
  }));
  assert.deepEqual(afterReplay, {events: 1, projects: 3, audits: 4}, '幂等重放不产生重复行或重复审计');

  // 8) 任务级撤销：干净撤销后行 + 内容 sha256 与验收前快照一致；撤销本身是新批次 + undo_of。
  const undo = await postJson(app, '/api/audit/undo/task', member.cookie, {taskId: started.taskId});
  assert.equal(undo.ok, true);
  assert.equal(undo.scope, 'task');
  assert.equal(undo.counts.rows, 4);
  assert.equal(undo.counts.undone, 4);
  assert.equal(undo.counts.conflicts, 0);
  assert.equal(undo.counts.forced, 0);
  assert.equal(undo.counts.failed, 0);
  assert.equal(undo.undo.allUndone, true);
  assert.equal(undo.task.state, 'undone', '任务卡标记「已撤销」');

  const afterUndo = withStore(app, member.user, store => snapshot(store));
  assert.deepEqual(afterUndo.events, before.events);
  assert.deepEqual(afterUndo.projects, before.projects);
  assert.equal(afterUndo.hash, before.hash, '撤销后快照（行 + 内容 sha256）与验收前一致');

  const auditsAfterUndo = readAuditRows(app, member.user);
  const undoRows = auditsAfterUndo.filter(row => row.undo_of);
  assert.equal(undoRows.length, 4, '每撤销一行新增一条审计');
  assert.ok(undoRows.every(row => row.result === 'applied'));
  assert.deepEqual(undoRows.map(row => row.undo_of).sort(), rows.audits.map(row => row.event_id).sort());
  assert.equal(new Set(undoRows.map(row => row.batch_id)).size, 1, '撤销行共享同一个新 batch_id');
  assert.notEqual(undoRows[0].batch_id, rows.audits[0].batch_id);
  const idemAfterUndo = withStore(app, member.user, store => store.db.prepare('SELECT COUNT(*) c FROM idempotency').get().c);
  assert.equal(idemAfterUndo, 1, '幂等行保留到 TTL');
});

test('首验回归：冲突 1 条 skip + 其余撤销；强制撤销写回旧值且审计同时有 skip 与 forced', {timeout: 60000}, async t => {
  const rawFixture = fixture();
  const project0 = rawFixture.projects[0];
  const reader = fakeReader();
  const extractor = fakeExtractor();
  const factory = fakeAgentFactory(JSON.stringify({issues: ISSUES}));
  const app = await startApp(t, {reader, extractor, factory});
  const member = await register(app, 'acceptance-swufe-conflict');
  await configureFakeReviewer(app, member.cookie);

  // 手工预置一行活动 + 一行项目（界面写入，不产生审计）；自动写入会把这两行更新。
  const seedEventId = 'seed-event-acceptance-0001';
  let seedProjectId = '';
  const seedSourceKey = createHash('sha1')
    .update(['manual', project0.company, project0.title, ''].join('|'))
    .digest('hex').slice(0, 32);
  const before = withStore(app, member.user, store => {
    store.upsertEvent({
      id: seedEventId, sourceId: 'manual', school: '西南财经大学', city: '成都', kind: '双选会',
      title: rawFixture.events[0].title, startAt: rawFixture.events[0].startAt,
      venue: '旧场馆', company: '旧单位', fetchedAt: '2026-01-01T00:00:00.000Z',
      confidence: 0.5, status: 'active', notes: '人工预置（无审计）'
    });
    const seeded = store.upsertProject({
      eventId: seedEventId, company: project0.company, title: project0.title,
      positions: '旧岗位', requirements: '旧要求', applyMode: '现场投递',
      sourceId: 'manual', sourceKey: seedSourceKey, sourceUrl: 'https://example.com/jobs/boc',
      notes: '人工预置（无审计）', confidence: 0.6
    });
    seedProjectId = seeded.id;
    return snapshot(store);
  });
  assert.equal(before.events.length, 1);
  assert.equal(before.projects.length, 1);

  const started = await postJson(app, '/api/source-check/start', member.cookie, {sourceId: 'swufe'});
  const task = await finishedTask(app, member.cookie);
  assert.equal(task.state, 'succeeded', '任务卡成功：' + JSON.stringify(task.error));
  const written = withStore(app, member.user, store => ({
    events: store.db.prepare('SELECT * FROM events ORDER BY id').all(),
    projects: store.db.prepare('SELECT * FROM event_projects ORDER BY id').all(),
    audits: store.db.prepare('SELECT * FROM write_audit ORDER BY seq').all()
  }));
  assert.equal(written.events.length, 1);
  assert.equal(written.projects.length, 3, '预置项目被更新，另外两个单位新增');
  assert.equal(written.audits.length, 4);
  assert.deepEqual(
    written.audits.map(row => row.entity + ':' + row.action).sort(),
    ['event_projects:create', 'event_projects:create', 'event_projects:update', 'events:update']
  );
  const writtenIds = new Set([...written.events, ...written.projects].map(row => row.id));
  assert.deepEqual(new Set(written.audits.map(row => row.entity_id)), writtenIds, '数据行与审计 1:1');

  // 写后手工改 1 行项目（界面修改，不产生审计）。
  const manualTitle = '我手工改过的项目名';
  withStore(app, member.user, store => {
    store.db.prepare('UPDATE event_projects SET title=?, positions=? WHERE id=?').run(manualTitle, '我手工改的岗位', seedProjectId);
  });

  // 默认撤销：冲突行 skip、其余撤销；不覆盖手工修改。
  const skipped = await postJson(app, '/api/audit/undo/task', member.cookie, {taskId: started.taskId});
  assert.equal(skipped.ok, true);
  assert.equal(skipped.counts.rows, 4);
  assert.equal(skipped.counts.undone, 3);
  assert.equal(skipped.counts.conflicts, 1);
  assert.equal(skipped.counts.forced, 0);
  assert.equal(skipped.counts.failed, 0);
  assert.equal(skipped.undo.allUndone, false);
  const mid = withStore(app, member.user, store => snapshot(store));
  assert.deepEqual(mid.events, before.events, '没冲突的活动行照常撤销并逐列恢复');
  assert.equal(mid.projects.length, 1, '没冲突的新增项目被撤销');
  assert.equal(mid.projects[0].title, manualTitle, '冲突行不能被悄悄覆盖');
  assert.equal(mid.projects[0].positions, '我手工改的岗位');

  const skipRows = readAuditRows(app, member.user).filter(row => row.undo_of);
  assert.equal(skipRows.length, 4, '3 条已撤销 + 1 条 skip');
  const skip = skipRows.find(row => row.result === 'skipped_conflict');
  assert.ok(skip, '冲突要留下 skip 审计行');
  assert.equal(skip.action, 'skip');
  assert.equal(JSON.parse(skip.old_values).title, manualTitle, 'skip 行记录冲突时的当前值');
  assert.equal(JSON.parse(skip.new_values).title, project0.title, 'skip 行也记录想写回的值');

  const listed = await getJson(app, '/api/tasks', member.cookie);
  const card = listed.tasks.find(item => item.id === started.taskId);
  assert.equal(card.state, 'succeeded', '仍有冲突时任务卡保持成功态，只更新撤销摘要');
  assert.equal(card.undo.available, true);
  assert.equal(card.undo.conflicts, 1);
  assert.equal(card.undo.remaining, 1);
  assert.match(card.undo.summary, /冲突/);

  // 强制撤销：写回旧值，审计同时有 skip 与 forced。
  const forced = await postJson(app, '/api/audit/undo/task', member.cookie, {taskId: started.taskId, force: true});
  assert.equal(forced.ok, true);
  assert.equal(forced.counts.undone, 1);
  assert.equal(forced.counts.forced, 1);
  assert.equal(forced.counts.conflicts, 1);
  assert.equal(forced.counts.failed, 0);
  assert.equal(forced.undo.allUndone, true);
  assert.equal(forced.task.state, 'undone');

  const after = withStore(app, member.user, store => snapshot(store));
  assert.deepEqual(after.events, before.events, '强制撤销把活动行逐列写回旧值');
  assert.deepEqual(after.projects, before.projects, '强制撤销把冲突项目写回旧值');
  assert.equal(after.hash, before.hash, '强制撤销后快照与验收前一致');
  assert.equal(after.projects[0].title, project0.title);
  assert.equal(after.projects[0].positions, '旧岗位');

  const allUndoRows = readAuditRows(app, member.user).filter(row => row.undo_of);
  const conflictUndoRows = allUndoRows.filter(row => row.undo_of === skip.undo_of);
  assert.ok(conflictUndoRows.some(row => row.result === 'skipped_conflict'), '审计保留 skip');
  const forcedRow = conflictUndoRows.find(row => row.result === 'forced');
  assert.ok(forcedRow, '审计保留 forced');
  assert.equal(conflictUndoRows.filter(row => row.result === 'forced').length, 1);
  assert.equal(forcedRow.action, 'update');
  assert.equal(JSON.parse(forcedRow.old_values).title, manualTitle);
  assert.equal(JSON.parse(forcedRow.new_values).title, project0.title);

  // 重复写入已被撤销，不产生重复活动/单位（全库行数回到验收前）。
  assert.equal(after.events.length, 1);
  assert.equal(after.projects.length, 1);
});

test('证据包模板：路径/哈希/清单可校验，占位符模板不会被当成验收证据', async () => {
  const docsDir = join(root, 'docs', 'acceptance', '24-swufe');
  const readme = await readFile(join(docsDir, 'README.md'), 'utf8');
  for (const needle of [
    '来源校对', '01-list.png', '02-detail.png', 'extraction.json', 'review.json',
    'audit-export.json', 'recruit.db.before', 'recruit.db.after', 'task.json',
    'sha256', 'live 检查清单', '验收通过', '日期', '不得伪造'
  ]) {
    assert.ok(readme.includes(needle), '证据包模板缺少：' + needle);
  }
  assert.ok(readme.includes('<待填写'), '模板必须保留待填写占位符，不能预填结果');

  const template = JSON.parse(await readFile(join(docsDir, 'manifest.template.json'), 'utf8'));
  assert.equal(template.status, 'pending', '模板状态必须是待验收');
  assert.ok(template.signature.statement.includes('待填写'), '模板签字区必须为空');
  const checked = await verifyManifest(template, {baseDir: docsDir});
  assert.equal(checked.ok, false, '未填写的模板不能通过校验');
  assert.ok(checked.errors.some(error => /pending|验收通过|占位符|待填写/.test(error)), '校验要明确指出模板未完成');
});
