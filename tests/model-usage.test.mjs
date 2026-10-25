import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {startMockOpenAI} from './mock-openai.mjs';
import {runApiModel, normalizeUsage} from '../src/model/api-model.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('chat 流式：请求带 stream_options.include_usage，usage 随结果返回', async () => {
  const mock = await startMockOpenAI();
  try {
    const config = {protocol: 'chat', baseUrl: mock.url, model: 'mock-model', stream: true, maxTokens: 1024};
    const out = await runApiModel({root, prompt: '请给出测试回复', search: false, config});
    assert.deepEqual(out.usage, {input: 11, output: 7, total: 18});
    assert.equal(mock.state.requests[0].stream_options?.include_usage, true, '流式必须显式要 usage');
  } finally { await mock.close(); }
});

test('Kimi 独立统计块：choices 为空的最后一块也能记进 usage', async () => {
  const mock = await startMockOpenAI({usage: 'empty-choices'});
  try {
    const config = {protocol: 'chat', baseUrl: mock.url, model: 'mock-model', stream: true, maxTokens: 1024};
    const out = await runApiModel({root, prompt: '请给出测试回复', search: false, config});
    assert.deepEqual(out.usage, {input: 11, output: 7, total: 18});
    assert.ok(JSON.parse(out.raw).reply);
  } finally { await mock.close(); }
});

test('chat 非流式：从 data.usage 取用量', async () => {
  const mock = await startMockOpenAI();
  try {
    const config = {protocol: 'chat', baseUrl: mock.url, model: 'mock-model', stream: false, maxTokens: 1024};
    const out = await runApiModel({root, prompt: '请给出测试回复', search: false, config});
    assert.deepEqual(out.usage, {input: 11, output: 7, total: 18});
  } finally { await mock.close(); }
});

test('Anthropic Messages：input_tokens / output_tokens', async () => {
  const mock = await startMockOpenAI();
  try {
    const config = {protocol: 'messages', baseUrl: mock.url, model: 'mock-model', stream: false, maxTokens: 1024};
    const out = await runApiModel({root, prompt: '请给出测试回复', search: false, config});
    assert.deepEqual(out.usage, {input: 11, output: 7, total: 18});
  } finally { await mock.close(); }
});

test('OpenAI Responses：input_tokens / output_tokens', async () => {
  const mock = await startMockOpenAI();
  try {
    const config = {protocol: 'responses', baseUrl: mock.url, model: 'mock-model', stream: false, maxTokens: 1024};
    const out = await runApiModel({root, prompt: '请给出测试回复', search: false, config});
    assert.deepEqual(out.usage, {input: 11, output: 7, total: 18});
  } finally { await mock.close(); }
});

test('供应商没回 usage：返回 null，交给界面显示「未回传」', async () => {
  const mock = await startMockOpenAI({usage: 'none'});
  try {
    const config = {protocol: 'chat', baseUrl: mock.url, model: 'mock-model', stream: true, maxTokens: 1024};
    const out = await runApiModel({root, prompt: '请给出测试回复', search: false, config});
    assert.equal(out.usage, null);
    assert.ok(JSON.parse(out.raw).reply, '没 usage 不影响正文');
  } finally { await mock.close(); }
});

test('工具循环里多轮调用的 usage 会累加', async () => {
  const mock = await startMockOpenAI();
  try {
    const config = {protocol: 'chat', baseUrl: mock.url, model: 'mock-model', stream: true, maxTokens: 1024};
    const out = await runApiModel({root, prompt: '请调用 career_platform_status 检查连接状态', search: true, config});
    assert.deepEqual(out.usage, {input: 22, output: 14, total: 36}, '两轮各 11/7');
  } finally { await mock.close(); }
});

test('normalizeUsage：三种协议字段与缺失降级', () => {
  assert.deepEqual(normalizeUsage({prompt_tokens: 5, completion_tokens: 3, total_tokens: 8}, 'chat'), {input: 5, output: 3, total: 8});
  assert.deepEqual(normalizeUsage({input_tokens: 5, output_tokens: 3}, 'messages'), {input: 5, output: 3, total: 8});
  assert.deepEqual(normalizeUsage({input_tokens: 5, output_tokens: 3, total_tokens: 9}, 'responses'), {input: 5, output: 3, total: 9});
  const dashscope = normalizeUsage({prompt_tokens: 5, completion_tokens: 3, total_tokens: 8, image_tokens: 100}, 'chat');
  assert.equal(dashscope.image, 100);
  const cached = normalizeUsage({prompt_tokens: 5, completion_tokens: 3, total_tokens: 8, prompt_cache_hit_tokens: 2}, 'chat');
  assert.equal(cached.cached, 2);
  assert.equal(normalizeUsage(null, 'chat'), null);
  assert.equal(normalizeUsage({}, 'chat'), null);
  assert.deepEqual(normalizeUsage({total_tokens: 8}, 'chat'), {total: 8}, '只有 total 时不硬拆输入输出');
});
test('图片请求：messages 用 base64 source，responses 用 input_image', async () => {
  const mock = await startMockOpenAI();
  try {
    const image = {name: 'shot.png', type: 'image', mime: 'image/png', dataUrl: 'data:image/png;base64,' + Buffer.from('fake-image').toString('base64')};
    await runApiModel({root, prompt: '请给出测试回复', search: false, images: [image], config: {protocol: 'messages', baseUrl: mock.url, model: 'mock-model', stream: false, maxTokens: 256}});
    const messagesBody = mock.state.requests.at(-1);
    const messagesContent = messagesBody.messages[0].content;
    assert.equal(messagesContent[0].type, 'image');
    assert.equal(messagesContent[0].source.type, 'base64');
    assert.equal(messagesContent[0].source.media_type, 'image/png');
    assert.ok(!messagesContent[0].source.data.startsWith('data:'), 'Anthropic 只要 base64 本体');
    assert.equal(messagesContent[1].type, 'text');

    await runApiModel({root, prompt: '请给出测试回复', search: false, images: [image], config: {protocol: 'responses', baseUrl: mock.url, model: 'mock-model', stream: false, maxTokens: 256}});
    const responsesBody = mock.state.requests.at(-1);
    const inputContent = responsesBody.input[0].content;
    assert.equal(inputContent[0].type, 'input_text');
    assert.equal(inputContent[1].type, 'input_image');
    assert.equal(inputContent[1].image_url, image.dataUrl);
  } finally { await mock.close(); }
});
