// 命令行体检：读取本机保存的模型配置，跑一遍分层检查。
// 用法：node diag.mjs            （检查已保存配置）
//      node diag.mjs --base https://api.deepseek.com --model deepseek-chat [--key sk-...]
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {runDiagnostics} from './diag.mjs';
import {KeyVault} from './keyvault.mjs';
import {ModelSettings} from './model-settings.mjs';
import {PRESETS} from './providers.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const arg = name => { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : ''; };

let config = null;
try {
  const accounts = JSON.parse(await readFile(join(root, '.data', 'accounts.json'), 'utf8'));
  const id = accounts[0]?.id;
  if (id) {
    const home = join(root, '.data', 'users', id);
    const vault = await new KeyVault(join(home, '.data')).init();
    const models = await new ModelSettings(home, vault).load();
    config = models.snapshot();
  }
} catch { /* 没有账号时用参数或默认值 */ }

if (!config) config = {protocol: 'chat', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', preset: 'ollama'};
if (arg('base')) config.baseUrl = arg('base');
if (arg('model')) config.model = arg('model');
if (arg('protocol')) config.protocol = arg('protocol');
if (arg('key')) config.apiKey = arg('key');
if (arg('proxy')) config.proxy = arg('proxy');

console.log('体检目标：' + config.baseUrl + ' · ' + config.protocol + ' · ' + (config.model || '(未填模型)'));
const report = await runDiagnostics(config);
for (const s of report.stages) {
  const mark = s.status === 'pass' ? '✔' : s.status === 'warn' ? '!' : s.status === 'fail' ? '✘' : '·';
  console.log(`${mark} ${s.label.padEnd(10)} ${s.detail || ''}`);
  if (s.fix) console.log(`  └ 建议：${s.fix}`);
}
console.log('\n结论：' + report.hint);
process.exit(report.ok ? 0 : 1);
