import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from '../src/server/app.mjs';
import {PRESETS, modelMigrationHint} from '../src/model/providers.mjs';
import {modelCapabilities} from '../src/model/backends.mjs';
import {ModelSettings} from '../src/model/model-settings.mjs';
import {KeyVault} from '../src/model/keyvault.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('预设型号迁移：当前型号表，DeepSeek 默认自带视觉，不静默改已保存型号', async t => {
  assert.equal(PRESETS.deepseek.model, 'deepseek-flash');
  assert.equal(PRESETS.zhipu.model, 'glm-5.3-flash');
  assert.equal(PRESETS.moonshot.model, 'kimi-k3.1-pro');
  assert.equal(PRESETS.qwen.model, 'qwen3.7-plus');
  assert.equal(PRESETS.ollama.model, 'qwen3-vl:8b');
  assert.ok(modelCapabilities({preset: 'deepseek', model: PRESETS.deepseek.model}).includes('vision'), 'DeepSeek 默认型号必须能读图');

  const deepseek = modelMigrationHint({preset: 'deepseek', model: 'deepseek-chat'});
  assert.equal(deepseek.code, 'MODEL_POSSIBLY_RETIRED');
  assert.equal(deepseek.suggestion.model, 'deepseek-flash');
  assert.match(deepseek.message, /可能已下线/);
  assert.equal(modelMigrationHint({preset: 'zhipu', model: 'glm-4-flash'}).suggestion.model, 'glm-5.3-flash');
  assert.equal(modelMigrationHint({preset: 'moonshot', model: 'moonshot-v1-8k'}).suggestion.model, 'kimi-k3.1-pro');
  assert.equal(modelMigrationHint({preset: 'qwen', model: 'qwen-plus'}).suggestion.model, 'qwen3.7-plus');
  assert.equal(modelMigrationHint({preset: 'ollama', model: 'qwen2.5:7b'}).suggestion.model, 'qwen3-vl:8b');
  assert.equal(modelMigrationHint({preset: 'openai', model: 'gpt-3.5-turbo'}), null, '没有可靠迁移目标就不猜');

  const dir = await mkdtemp(join(tmpdir(), 'zx-model-presets-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const vault = await new KeyVault(join(dir, '.data')).init();
  const models = await new ModelSettings(dir, vault).load();
  await models.save({preset: 'deepseek', mode: 'api', protocol: 'chat', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'sk-abc'});
  assert.equal(models.public().model, 'deepseek-chat', '保存的型号不能被迁移逻辑改掉');
  assert.equal(models.public().modelHint.suggestion.model, 'deepseek-flash');
  const switched = await models.switchModel({preset: 'deepseek', model: 'deepseek-flash'});
  assert.equal(switched.model, 'deepseek-flash');
  assert.equal(switched.hasKey, true, '一键切换保留已保存的 Key');
  assert.equal(switched.modelHint, null);
});

test('HTTP：/api/model 暴露过期型号提示，一次显式点击才切换', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'zx-model-hint-http-'));
  const app = await createApp({root, dataDir: dir, host: '127.0.0.1', port: 0});
  t.after(async () => { await app.close(); await rm(dir, {recursive: true, force: true}); });

  const register = await fetch(app.origin + '/api/auth/register', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'x-career-token': app.token},
    body: JSON.stringify({name: 'hint-user', password: 'correct-horse-battery'})
  });
  assert.equal(register.status, 200);
  const cookie = (register.headers.getSetCookie?.() || [register.headers.get('set-cookie')]).filter(Boolean).map(value => value.split(';')[0]).join('; ');
  const headers = {'Content-Type': 'application/json', 'x-career-token': app.token, cookie};

  const saved = await fetch(app.origin + '/api/model/save', {
    method: 'POST', headers,
    body: JSON.stringify({preset: 'deepseek', mode: 'api', protocol: 'chat', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'sk-test', stream: true})
  });
  assert.equal(saved.status, 200, await saved.text());

  const before = await (await fetch(app.origin + '/api/model', {headers})).json();
  assert.equal(before.model, 'deepseek-chat');
  assert.equal(before.modelHint.code, 'MODEL_POSSIBLY_RETIRED');
  assert.equal(before.modelHint.suggestion.model, 'deepseek-flash');

  // 没有点按钮之前，保存的配置不变。
  const unchanged = await (await fetch(app.origin + '/api/model', {headers})).json();
  assert.equal(unchanged.model, 'deepseek-chat');

  const switched = await fetch(app.origin + '/api/model/switch-model', {
    method: 'POST', headers,
    body: JSON.stringify({preset: 'deepseek', model: 'deepseek-flash'})
  });
  const switchedText = await switched.text();
  assert.equal(switched.status, 200, switchedText);
  const switchedBody = JSON.parse(switchedText);
  assert.equal(switchedBody.model, 'deepseek-flash');
  assert.equal(switchedBody.hasKey, true);
  assert.equal(switchedBody.modelHint, null);

  const after = await (await fetch(app.origin + '/api/model', {headers})).json();
  assert.equal(after.model, 'deepseek-flash');
  assert.equal(after.modelHint, null);
});
