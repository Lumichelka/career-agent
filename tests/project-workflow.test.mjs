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
