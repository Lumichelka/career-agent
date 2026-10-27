import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {startMockOpenAI} from './mock-openai.mjs';
import {runApiModel} from '../src/model/api-model.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('项目研究链路：模型调用项目工具后才给结论', async () => {
  const mock = await startMockOpenAI();
  try {
    const config = {protocol: 'chat', baseUrl: mock.url, model: 'mock-model', stream: true, maxTokens: 2048};
    const out = await runApiModel({
      root,
      prompt: '研究这个招聘项目：先列出项目，再查岗位要求与薪资，最后对照简历给建议。',
      search: true,
      config,
      toolCaller: async name => ({
        status: 'readable',
        projects: [{id: 'p1', company: '甲公司', title: '数据分析', sourceUrl: 'https://example.com/project'}],
        tool: name
      })
    });
    assert.ok(out.trace.some(t => t.label === 'career_recruit_projects'), '应调用项目工具');
    assert.match(out.toolEvidence.join('\n'), /甲公司/);
    assert.ok(JSON.parse(out.raw).reply);
  } finally { await mock.close(); }
});

test('公众号文章查询失败：工具证据带原因，回复如实说明且不编造', async () => {
  const mock = await startMockOpenAI();
  try {
    const config = {protocol: 'chat', baseUrl: mock.url, model: 'mock-model', stream: true, maxTokens: 2048};
    let called = '';
    const out = await runApiModel({
      root,
      prompt: '查公众号文章失败：看看有没有双选会招聘信息。',
      search: true,
      config,
      toolCaller: async name => {
        called = name;
        return {status: 'unavailable', message: '没有数据目录，无法读取公众号文章'};
      }
    });
    assert.equal(called, 'career_wechat_articles', '应调用公众号文章工具');
    assert.ok(out.trace.some(t => t.label === 'career_wechat_articles'), 'trace 应记录工具调用');
    const evidence = out.toolEvidence.join('\n');
    assert.match(evidence, /没有数据目录/, '工具证据应保留失败原因');
    assert.match(evidence, /unavailable/, '工具证据应保留失败状态');
    const reply = JSON.parse(out.raw).reply;
    assert.match(reply, /无法读取|不能读取/, '回复应明确说无法读取');
    assert.match(reply, /不编造|不会编造|没有编造/, '回复应说明不编造');
    assert.doesNotMatch(reply, /甲公司|乙公司|某公司/, '回复不应编造公司或文章');
  } finally { await mock.close(); }
});
