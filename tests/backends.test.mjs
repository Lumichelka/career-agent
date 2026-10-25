import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  MAX_IMAGE_BYTES, MAX_IMAGE_TOTAL_BYTES, BackendChoice, backendEntries, candidatesFor,
  imageContentFor, modelCapabilities, normalizeImageAttachment, publicBackends, resolveTurn,
  selectBackend, turnCapabilities, validateImages
} from '../src/model/backends.mjs';

const png = 'data:image/png;base64,' + Buffer.from('fake-png-bytes').toString('base64');
const image = {name: 'shot.png', type: 'image', mime: 'image/png', dataUrl: png};
const apiVision = {mode: 'api', preset: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', hasKey: true};
const apiText = {mode: 'api', preset: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro', hasKey: true};
const localText = {mode: 'local', preset: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', hasKey: false};

function choiceStub(kind = '') {
  return {current: settings => kind || settings.mode, snapshot: () => ({api: kind, agent: ''}), set: async () => ({api: kind, agent: ''})};
}

test('能力解析：有图片就是要 vision，否则 text + tools', () => {
  assert.deepEqual(turnCapabilities([]), ['text', 'tools']);
  assert.deepEqual(turnCapabilities([{name: 'a.txt', text: 'x'}]), ['text', 'tools']);
  assert.deepEqual(turnCapabilities([image]), ['text', 'tools', 'vision']);
});

test('型号能力：已知视觉/纯文本型号按表判断，未知按纯文本（fail closed）', () => {
  assert.ok(modelCapabilities({preset: 'deepseek', model: 'deepseek-flash'}).includes('vision'));
  assert.ok(!modelCapabilities({preset: 'deepseek', model: 'deepseek-v4-pro'}).includes('vision'));
  assert.ok(modelCapabilities({preset: 'zhipu', model: 'glm-4.6v-flash'}).includes('vision'));
  assert.ok(!modelCapabilities({preset: 'openai', model: 'gpt-3.5-turbo'}).includes('vision'));
  assert.ok(!modelCapabilities({preset: 'custom', model: 'whatever'}).includes('vision'));
});

test('图片附件：data URL 与裸 base64 都接受，非图片与超限拒绝', () => {
  const normalized = normalizeImageAttachment(image);
  assert.equal(normalized.type, 'image');
  assert.equal(normalized.mime, 'image/png');
  assert.ok(normalized.bytes > 0);
  assert.match(normalized.dataUrl, /^data:image\/png;base64,/);

  const bare = normalizeImageAttachment({name: 'b.jpg', type: 'image', mime: 'image/jpeg', dataUrl: Buffer.from('abc').toString('base64')});
  assert.match(bare.dataUrl, /^data:image\/jpeg;base64,/);

  assert.equal(normalizeImageAttachment({name: 'a.txt', text: 'x'}), null);
  assert.equal(normalizeImageAttachment({name: 'a.png', type: 'image', mime: 'text/plain', dataUrl: png}), null);
  assert.equal(normalizeImageAttachment({name: 'a.png', type: 'image', mime: 'image/png', dataUrl: 'not-base64!!'}), null);

  const huge = 'data:image/png;base64,' + 'A'.repeat(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 8);
  assert.equal(normalizeImageAttachment({name: 'huge.png', type: 'image', mime: 'image/png', dataUrl: huge}), null);

  const tooMany = validateImages([image, image, image, image, image, image].map((item, index) => ({...item, name: 'i' + index + '.png'})));
  assert.match(tooMany.error, /5/);

  const big = {...image, dataUrl: 'data:image/png;base64,' + 'A'.repeat(Math.ceil(MAX_IMAGE_TOTAL_BYTES / 2 / 3) * 4)};
  const tooBig = validateImages([big, {...big, name: 'big2.png'}]);
  assert.match(tooBig.error, /8MB/);
});

test('图片请求形状：chat 用 image_url，messages 用 base64 source，responses 用 input_image', () => {
  const chat = imageContentFor('chat', [image]);
  assert.equal(chat[0].type, 'image_url');
  assert.equal(chat[0].image_url.url, png);
  const messages = imageContentFor('messages', [image]);
  assert.equal(messages[0].type, 'image');
  assert.equal(messages[0].source.type, 'base64');
  assert.equal(messages[0].source.media_type, 'image/png');
  assert.ok(!messages[0].source.data.startsWith('data:'));
  const responses = imageContentFor('responses', [image]);
  assert.equal(responses[0].type, 'input_image');
  assert.equal(responses[0].image_url, png);
  assert.equal(imageContentFor('chat', []), null);
});

test('外部 Agent 永远不作为视觉候选，即使它自称会读图', () => {
  const entries = [
    {kind: 'agent', label: '外部 Agent', capabilities: ['text', 'tools', 'vision'], configured: true, preset: '', model: ''},
    {kind: 'api', label: 'API', capabilities: ['text', 'tools', 'vision'], configured: true, preset: 'deepseek', model: 'deepseek-flash'}
  ];
  const vision = candidatesFor(entries, ['text', 'tools', 'vision']);
  assert.deepEqual(vision.map(card => card.kind), ['api']);
  // 文本任务里外部 Agent 仍可作为候选（#34 配置后才真正可用）。
  assert.deepEqual(candidatesFor(entries, ['text', 'tools']).map(card => card.kind).sort(), ['agent', 'api']);
});

test('当前后端不满足视觉：CANDIDATE_REQUIRED + 候选卡（名称/能力/约每次费用/配置入口）', () => {
  const turn = resolveTurn({settings: apiVision, choice: choiceStub('codex'), user: {name: 'owner'}, attachments: [image]});
  assert.equal(turn.ok, false);
  assert.equal(turn.code, 'CANDIDATE_REQUIRED');
  assert.equal(turn.current.kind, 'codex');
  const api = turn.candidates.find(card => card.kind === 'api');
  assert.ok(api, '已配置的视觉 API 要出现在候选里');
  assert.equal(api.configured, true);
  assert.ok(api.capabilities.includes('vision'));
  assert.ok(Number.isFinite(api.approxCostPerCall) && api.approxCostPerCall > 0);
  assert.match(api.approxCostLabel, /^≈¥/);
  const local = turn.candidates.find(card => card.kind === 'local');
  assert.ok(local && local.configured === false, '未配置的本地模型给配置入口');
  assert.equal(local.configTarget, 'model-settings');
  assert.ok(turn.candidates.every(card => card.kind !== 'agent'));
});

test('当前后端满足能力：直接开始，不弹候选', () => {
  const ok = resolveTurn({settings: apiVision, choice: choiceStub('api'), user: {name: 'alice'}, attachments: [image]});
  assert.equal(ok.ok, true);
  assert.equal(ok.backend.kind, 'api');
  assert.deepEqual(ok.capabilities, ['text', 'tools', 'vision']);
  const codex = resolveTurn({settings: apiText, choice: choiceStub('codex'), user: {name: 'owner'}, attachments: []});
  assert.equal(codex.ok, true);
  assert.equal(codex.backend.kind, 'codex');
});

test('候选按约每次费用升序，免费/本机在前，无价在后', () => {
  const settings = apiText;
  const entries = backendEntries({settings, user: {name: 'owner'}});
  const cards = candidatesFor(entries, ['text', 'tools']);
  // 已配置的排前；组内按约每次费用升序，无价排后。
  const groups = [cards.filter(card => card.configured), cards.filter(card => !card.configured)];
  for (const group of groups) {
    const priced = group.filter(card => card.approxCostPerCall !== null);
    for (let i = 1; i < priced.length; i += 1) assert.ok(priced[i - 1].approxCostPerCall <= priced[i].approxCostPerCall);
    const firstUnpriced = group.findIndex(card => card.approxCostPerCall === null);
    if (firstUnpriced >= 0) assert.ok(group.slice(firstUnpriced).every(card => card.approxCostPerCall === null), '无价排在有价之后');
  }
  assert.ok(cards.every(card => card.kind !== 'codex' || card.approxCostPerCall === null));
});

test('选择：未配置 409、非 owner 选 codex 403、已配置成功并持久化到用户目录', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'zx-backends-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const choice = await new BackendChoice(dir).load();

  const unconfigured = await selectBackend({settings: {mode: 'api', model: '', baseUrl: ''}, choice, user: {name: 'alice'}, kind: 'api'});
  assert.equal(unconfigured.ok, false);
  assert.equal(unconfigured.status, 409);
  assert.equal(unconfigured.code, 'BACKEND_NOT_CONFIGURED');

  const codex = await selectBackend({settings: apiVision, choice, user: {name: 'alice'}, kind: 'codex'});
  assert.equal(codex.status, 403);
  assert.equal(codex.code, 'CODEX_OWNER_ONLY');

  const owner = await selectBackend({settings: apiVision, choice, user: {name: 'owner'}, kind: 'api'});
  assert.equal(owner.ok, true);
  assert.equal(owner.current.kind, 'api');
  const reloaded = await new BackendChoice(dir).load();
  assert.equal(reloaded.snapshot().api, 'api');

  const codexOk = await selectBackend({settings: apiVision, choice, user: {name: 'owner'}, kind: 'codex'});
  assert.equal(codexOk.ok, true);
  assert.equal((await new BackendChoice(dir).load()).snapshot().api, 'codex');
});

test('GET 视图：当前后端、能力、候选与两个选择位', () => {
  const view = publicBackends({settings: localText, choice: choiceStub(''), user: {name: 'alice'}});
  assert.equal(view.current.kind, 'local');
  assert.ok(view.current.label.includes('qwen2.5:7b'));
  assert.deepEqual(view.capabilities, ['text', 'tools']);
  assert.ok(view.choices && 'api' in view.choices && 'agent' in view.choices);
  assert.ok(Array.isArray(view.candidates));
  assert.ok(view.candidates.some(card => card.kind === 'api' && card.configured === false));
});
