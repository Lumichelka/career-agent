import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TOOLS, getTool, listTools, toolsForModel, platformTools} from '../src/tools/registry.mjs';
import {validateArguments, validateToolArguments} from '../src/tools/policy.mjs';
import {HANDLERS, createToolExecutor, callTool} from '../src/tools/execute.mjs';
import {listSkills} from '../src/skills/index.mjs';

test('注册表：名称唯一、字段完整、处理器都有实现', () => {
  const names = TOOLS.map(t => t.name);
  assert.equal(new Set(names).size, names.length, '工具名重复');
  for (const tool of TOOLS) {
    assert.ok(tool.title, tool.name + ' 缺标题');
    assert.ok(['read', 'write'].includes(tool.permission), tool.name + ' 权限无效');
    assert.equal(tool.parameters.type, 'object');
    assert.ok(HANDLERS[tool.handler], tool.name + ' 没有处理器');
    assert.ok(Number(tool.timeoutMs) > 0);
  }
  assert.equal(platformTools().length, 5);
  const jobSave = getTool('career_platform_jobs_save');
  assert.equal(jobSave.permission, 'write');
  assert.equal(jobSave.sensitivity, 'sensitive');
  assert.equal(jobSave.writeDomain, 'recruit');
  assert.equal(getTool('career_platform_jobs').permission, 'read');
});

test('来源健康工具说明使用七状态词表，不再写旧的 ok 语义', () => {
  const description = getTool('career_source_health').description;
  assert.match(description, /connected/);
  assert.match(description, /list_only/);
  assert.doesNotMatch(description, /ok 只在/);
});

test('规格 #1 的智能体只读工具齐全', () => {
  for (const name of ['career_recruit_projects', 'career_recruit_project', 'career_source_health', 'career_wechat_articles']) {
    const tool = getTool(name);
    assert.ok(tool, name + ' 应已注册');
    assert.equal(tool.permission, 'read', name + ' 应只读');
  }
});

test('模型工具集不暴露权限与处理器', () => {
  const modelTools = toolsForModel();
  assert.equal(modelTools.length, TOOLS.length);
  for (const t of modelTools) {
    assert.equal(t.handler, undefined);
    assert.equal(t.permission, undefined);
    assert.ok(t.parameters);
  }
});

test('参数校验由 schema 推导：未知字段、必填、枚举、长度、范围', () => {
  const events = getTool('career_recruit_events');
  assert.throws(() => validateArguments(events, {evil: 1}), /未声明参数/);
  assert.throws(() => validateArguments(events, {days: 0}), /不能小于 1/);
  assert.throws(() => validateArguments(events, {days: 91}), /不能大于 90/);
  assert.throws(() => validateArguments(events, {kind: '随便'}), /取值无效/);
  assert.deepEqual(validateArguments(events, {days: '7', school: ' 四川大学 '}), {days: 7, school: '四川大学'});

  const company = getTool('career_company_research');
  assert.throws(() => validateArguments(company, {}), /缺少参数：company/);
  assert.throws(() => validateArguments(company, {company: 'x'.repeat(61)}), /不能超过 60/);
  assert.deepEqual(validateArguments(company, {company: ' 某公司 ', city: '成都'}), {company: '某公司', city: '成都'});

  assert.throws(() => validateToolArguments('不存在的工具', {}), /工具未开放/);
});

test('执行器：未知工具、非法参数、重复调用', async () => {
  const execute = createToolExecutor({runner: async (tool, args) => ({status: 'readable', tool: tool.name, args})});
  assert.equal((await execute('nope', {})).code, 'UNKNOWN_TOOL');
  assert.equal((await execute('career_recruit_events', {days: 999})).code, 'INVALID_ARGUMENTS');
  const first = await execute('career_recruit_events', {days: 7});
  assert.equal(first.status, 'readable');
  const second = await execute('career_recruit_events', {days: 7});
  assert.equal(second.code, 'DUPLICATE_CALL');
  const other = await execute('career_recruit_events', {days: 8});
  assert.equal(other.status, 'readable');
});

test('执行器：处理器异常会转成可读错误', async () => {
  const execute = createToolExecutor({runner: async () => { throw new Error('网络断了'); }});
  const result = await execute('career_public_search', {query: '成都 宣讲会'});
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'TOOL_FAILED');
  assert.match(result.message, /网络断了/);
  assert.ok(result.recovery);
});

test('直接调用会校验参数并分发到处理器', async () => {
  const result = await callTool('career_recruit_events', {days: 7}, {config: {}});
  assert.equal(result.status, 'unavailable');
  assert.match(result.message, /招聘数据库/);
  await assert.rejects(() => callTool('nope', {}), /工具未开放/);
});

test('技能扫描：读取 SKILL.md 元信息', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zx-skill-'));
  try {
    const dir = join(root, 'src', 'skills', 'schedule-planner');
    await mkdir(dir, {recursive: true});
    await writeFile(join(dir, 'SKILL.md'), `---\nid: schedule-planner\nname: 行程规划\ndescription: 按天整理\ntriggers: [排行程, 冲突]\ntools: [career_recruit_events]\nwrites: false\nversion: 2\n---\n# 正文\n`, 'utf8');
    const skills = await listSkills(root);
    assert.equal(skills.length, 1);
    assert.equal(skills[0].id, 'schedule-planner');
    assert.deepEqual(skills[0].triggers, ['排行程', '冲突']);
    assert.equal(skills[0].version, 2);
    assert.equal(skills[0].writes, false);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('能力列表可直接序列化给前端', () => {
  const json = JSON.stringify(listTools());
  assert.ok(json.includes('career_recruit_events'));
  assert.ok(!json.includes('recruit.events'), '不应把内部处理器名暴露给前端');
});
