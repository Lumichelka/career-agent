import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {normalizeBaseUrl, endpointFor, isPrivateHostname, validateProxy, explainError, detectPreset, decorateChatError} from './providers.mjs';
import {KeyVault} from './keyvault.mjs';
import {ModelSettings, validateModelSettings} from './model-settings.mjs';
import {buildSchedule, estimateTravel, toICS, toCSV, toMarkdown} from './recruit/schedule.mjs';

test('接口地址规范化：去掉重复协议路径', () => {
  assert.equal(normalizeBaseUrl(' https://api.deepseek.com/chat/completions '), 'https://api.deepseek.com');
  assert.equal(normalizeBaseUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1');
  assert.equal(normalizeBaseUrl('https://api.openai.com/v1/chat/completions'), 'https://api.openai.com/v1');
  assert.equal(endpointFor('https://api.deepseek.com', 'chat'), 'https://api.deepseek.com/chat/completions');
  assert.throws(() => normalizeBaseUrl('ftp://x.com'), /http/);
  assert.throws(() => normalizeBaseUrl('https://user:pass@x.com'), /账号密码/);
});

test('内网判定与代理校验', () => {
  for (const host of ['127.0.0.1', '192.168.1.9', '10.0.0.3', '172.20.1.1', '100.101.1.1', 'localhost', 'nas.local']) {
    assert.equal(isPrivateHostname(host), true, host);
  }
  assert.equal(isPrivateHostname('api.deepseek.com'), false);
  assert.equal(validateProxy('http://127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(validateProxy(''), '');
  assert.throws(() => validateProxy('socks5://127.0.0.1:1080'), /http/);
});

test('预设识别与错误翻译', () => {
  assert.equal(detectPreset('https://api.deepseek.com', 'chat'), 'deepseek');
  assert.equal(detectPreset('http://127.0.0.1:11434/v1', 'chat'), 'ollama');
  const dns = new Error('fetch failed');
  dns.cause = {code: 'ENOTFOUND'};
  assert.match(explainError(dns).text, /域名解析失败/);
  assert.match(explainError(new Error('connect ECONNREFUSED 127.0.0.1:1234')).text, /端口拒绝连接/);
});

test('未配置 Key 时，401 会提示去哪里配置', () => {
  const raw = '鉴权失败，请检查 API Key 与接口权限（HTTP 401）：Authentication Fails (governor)';
  const friendly = decorateChatError(raw, false);
  assert.match(friendly, /还没有配置 API Key/);
  assert.match(friendly, /模型与接口设置/);
  assert.equal(decorateChatError(raw, true), raw, '已配置 Key 时不改写，避免把 Key 失效误报成未配置');
  assert.equal(decorateChatError('其他错误', false), '其他错误');
});

test('模型设置校验：局域网 HTTP 必须显式允许', () => {
  assert.throws(() => validateModelSettings({mode: 'api', protocol: 'chat', baseUrl: 'http://192.168.1.5:8080/v1', model: 'x'}), /允许局域网 HTTP/);
  const ok = validateModelSettings({mode: 'api', protocol: 'chat', baseUrl: 'http://192.168.1.5:8080/v1', model: 'x', allowPrivateHttp: true});
  assert.equal(ok.baseUrl, 'http://192.168.1.5:8080/v1');
  assert.throws(() => validateModelSettings({mode: 'api', protocol: 'chat', baseUrl: 'http://example.com/v1', model: 'x'}), /HTTPS/);
});

test('Key 加密保存与读取（重启后仍在）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zx-vault-'));
  try {
    const vault = await new KeyVault(dir).init();
    await vault.set('model.apiKey', 'sk-test-123456');
    const raw = await readFile(join(dir, 'secrets.enc.json'), 'utf8');
    assert.equal(raw.includes('sk-test-123456'), false, '明文不应落盘');
    const again = await new KeyVault(dir).init();
    assert.equal(again.get('model.apiKey'), 'sk-test-123456');
    await again.delete('model.apiKey');
    assert.equal(again.get('model.apiKey'), '');
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('模型设置保存后能从快照拿到 Key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zx-model-'));
  try {
    const vault = await new KeyVault(join(dir, '.data')).init();
    const models = await new ModelSettings(dir, vault).load();
    await models.save({preset: 'deepseek', mode: 'api', protocol: 'chat', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'sk-abc'});
    const snapshot = models.snapshot();
    assert.equal(snapshot.apiKey, 'sk-abc');
    assert.equal(snapshot.model, 'deepseek-chat');
    const reloaded = await new ModelSettings(dir, await new KeyVault(join(dir, '.data')).init()).load();
    assert.equal(reloaded.snapshot().apiKey, 'sk-abc');
    assert.equal(reloaded.public().hasKey, true);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

const events = [
  {id: 'a1', school: '四川大学', city: '成都', kind: '宣讲会', title: 'A公司宣讲', company: 'A', startAt: '2026-10-26T09:00:00+08:00', endAt: '2026-10-26T11:00:00+08:00', venue: '四川大学望江校区就业中心221', sourceUrl: 'https://example.com/a', confidence: 0.8},
  {id: 'a2', school: '四川大学', city: '成都', kind: '宣讲会', title: 'B公司宣讲', company: 'B', startAt: '2026-10-26T10:00:00+08:00', endAt: '2026-10-26T12:00:00+08:00', venue: '四川大学望江校区就业中心303', sourceUrl: 'https://example.com/b', confidence: 0.7},
  {id: 'a3', school: '上海财经大学', city: '上海', kind: '宣讲会', title: 'C银行宣讲', company: 'C', startAt: '2026-10-27T14:00:00+08:00', endAt: '2026-10-27T16:00:00+08:00', venue: '武东路校区大学生活动中心', sourceUrl: 'https://example.com/c', confidence: 0.9}
];

test('行程排班：同城重叠算冲突，异地只提示取舍', () => {
  const schedule = buildSchedule(events);
  assert.equal(schedule.stats.events, 3);
  assert.equal(schedule.stats.conflicts, 1, 'A/B 时间重叠');
  const day2 = schedule.days.find(d => d.date === '2026-10-26');
  assert.equal(day2.items.filter(i => i.conflict).length, 1);
  const day3 = schedule.days.find(d => d.date === '2026-10-27');
  assert.equal(day3.items[0].conflict, false);
});

test('通勤估算：同场地为 0，跨城按 180 分钟', () => {
  assert.equal(estimateTravel('同一个场地', '同一个场地', '成都', '成都').minutes, 0);
  assert.equal(estimateTravel('四川大学望江校区', '四川大学江安校区', '成都', '成都').minutes > 0, true);
  assert.equal(estimateTravel('x', 'y', '成都', '上海').minutes, 180);
});

test('导出 ICS / CSV / Markdown 结构正确', () => {
  const ics = toICS(events);
  assert.match(ics, /^BEGIN:VCALENDAR/);
  assert.match(ics, /DTSTART;TZID=Asia\/Shanghai:20261026T090000/);
  assert.match(ics, /END:VCALENDAR/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 3);
  const csv = toCSV(events);
  assert.equal(csv.split('\r\n')[0].includes('日期'), true);
  assert.equal(csv.split('\r\n').filter(Boolean).length, 4);
  const md = toMarkdown(buildSchedule(events));
  assert.match(md, /共 3 场/);
  assert.match(md, /2026-10-26/);
});

test('中文 ICS 文本保持 UTF-8 可读', () => {
  const ics = toICS([events[0]], {calendarName: '职向 线下招聘行程'});
  assert.match(ics, /X-WR-CALNAME:职向 线下招聘行程/);
});
