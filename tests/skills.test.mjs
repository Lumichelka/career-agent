import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {listSkills, loadSkill, selectSkill} from '../src/skills/index.mjs';
import {buildPrompt} from '../src/agent/agent.mjs';
import {getTool} from '../src/tools/registry.mjs';
import {startMockOpenAI} from './mock-openai.mjs';
import {runApiModel} from '../src/model/api-model.mjs';
import {runAgent} from '../src/agent/agent.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('技能清单：四个技能，字段完整，工具都存在于注册表', async () => {
  const skills = await listSkills(root);
  assert.equal(skills.length, 4);
  const ids = skills.map(s => s.id).sort();
  assert.deepEqual(ids, ['company-research', 'interview-prep', 'resume-tailoring', 'source-reading']);
  for (const skill of skills) {
    assert.ok(skill.name, skill.id + ' 缺名称');
    assert.ok(skill.triggers.length > 0, skill.id + ' 缺触发词');
    assert.equal(skill.writes, false, skill.id + ' 目前应为只读');
    for (const name of skill.tools) assert.ok(getTool(name), skill.id + ' 引用了不存在的工具 ' + name);
  }
});

test('加载技能：正文、提示词、验收清单', async () => {
  const skill = await loadSkill(root, 'company-research');
  assert.equal(skill.id, 'company-research');
  assert.match(skill.body, /何时使用/);
  assert.match(skill.prompt, /来源|调研|公司/);
  assert.match(skill.checklist, /验收清单/);
  assert.deepEqual(skill.tools, ['career_company_research', 'career_public_search', 'career_recruit_projects', 'career_recruit_project']);
  assert.match(skill.body, /career_recruit_project/);
  assert.match(skill.body, /项目 id 先/);
  assert.match(skill.body, /不是公司官方事实/);
});

test('技能路由：按最长触发词选择', async () => {
  assert.equal(await selectSkill(root, '这周成都有什么宣讲会，帮我排一下'), null);
  assert.equal((await selectSkill(root, '帮我把简历改一下，贴了 JD')).id, 'resume-tailoring');
  assert.equal((await selectSkill(root, '这家公司怎么样，待遇如何')).id, 'company-research');
  assert.equal((await selectSkill(root, '下周要面试了，帮我准备')).id, 'interview-prep');
  assert.equal((await selectSkill(root, '这个就业网抓取失败，帮我校对来源结构')).id, 'source-reading');
  assert.equal(await selectSkill(root, '今天天气不错'), null);
  assert.equal(await selectSkill(root, ''), null);
});

test('提示词包含技能说明与约束', async () => {
  const skill = await loadSkill(root, 'resume-tailoring');
  const prompt = buildPrompt({messages: [], memory: ''}, '改简历', [], [], skill);
  assert.ok(prompt.includes('本次启用技能'));
  assert.ok(prompt.includes('简历定向'));
  assert.ok(prompt.includes('证据映射'));
  assert.ok(prompt.includes('不编造'));
});

test('技能限定了工具：模型只看到该技能允许的工具', async () => {
  const mock = await startMockOpenAI();
  try {
    const skill = await loadSkill(root, 'company-research');
    const config = {protocol: 'chat', baseUrl: mock.url, model: 'mock-model', stream: true, maxTokens: 1024};
    await runApiModel({root, prompt: '请给出测试回复', search: true, config, toolNames: skill.tools});
    const withTools = mock.state.requests.find(r => r.tools?.length);
    assert.ok(withTools, '应该有一次带工具的请求');
    assert.equal(withTools.tools.length, 4);
    const names = withTools.tools.map(t => t.function.name);
    assert.deepEqual(names.sort(), ['career_company_research', 'career_public_search', 'career_recruit_project', 'career_recruit_projects'].sort());
  } finally { await mock.close(); }
});

test('完整链路：启用技能后计划与执行都带技能上下文', async () => {
  const mock = await startMockOpenAI();
  try {
    const skill = await loadSkill(root, 'company-research');
    const config = {protocol: 'chat', baseUrl: mock.url, model: 'mock-model', stream: true, maxTokens: 2048};
    const result = await runAgent({
      root,
      session: {messages: [], memory: '', artifacts: []},
      message: '帮我调研一下这家公司',
      profile: [{key: '目标城市', value: '成都', updatedAt: new Date().toISOString()}],
      skill,
      modelCall: options => runApiModel({...options, config})
    });
    assert.equal(result.skill.id, 'company-research');
    assert.ok(result.reply.length > 0);
    const prompts = mock.state.requests.map(r => JSON.stringify(r.messages || r.input || ''));
    assert.ok(prompts.some(p => p.includes('本次启用技能')), '提示词应包含技能说明');
    const toolRequest = mock.state.requests.find(r => r.tools?.length);
    assert.equal(toolRequest.tools.length, 4);
  } finally { await mock.close(); }
});
