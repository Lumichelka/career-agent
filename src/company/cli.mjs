#!/usr/bin/env node
// 命令行入口：从招聘库高频单位名批量生成带来源的公司档案。
// 用法：
//   node company/cli.mjs generate [--limit 25] [--data <目录>]
// 需要先在“模型与接口 → 通用联网搜索”里配置 SearXNG 地址；未配置会给出可诊断提示，不伪造数据。
import {join, resolve} from 'node:path';
import {readFileSync, existsSync} from 'node:fs';
import {resolveDataDir} from '../config/paths.mjs';
import {generateCompanyProfiles} from './research.mjs';

const argv = process.argv.slice(2);
const command = argv[0] || 'help';
const flag = name => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : ''; };

// 默认写到 owner 账号的数据目录，这样命令行生成的结果网页也能看到。
function defaultDataDir() {
  const base = resolveDataDir();
  try {
    const accounts = JSON.parse(readFileSync(join(base, 'accounts.json'), 'utf8'));
    if (accounts.length === 1) {
      const dir = join(base, 'users', accounts[0].id, '.data');
      if (existsSync(dir)) return dir;
    }
  } catch { /* 还没初始化过账号 */ }
  return base;
}

function readSearchUrl(dir) {
  try {
    const cfg = JSON.parse(readFileSync(join(dir, 'model-settings.json'), 'utf8'));
    return typeof cfg.searchUrl === 'string' ? cfg.searchUrl.trim() : '';
  } catch { return ''; }
}

if (command === 'generate') {
  const dataDir = resolve(flag('data') || defaultDataDir());
  const limit = Number(flag('limit') || 25);
  const searchUrl = readSearchUrl(dataDir);
  const out = await generateCompanyProfiles({dataDir, searchUrl, limit});
  console.log(out.message);
  for (const c of out.companies) {
    console.log('· ' + c.name + '（来源 ' + c.sources.length + ' 条）');
  }
  if (out.status === 'unavailable') process.exitCode = 2;
} else {
  console.log(`职向 · 公司调研数据源

  node company/cli.mjs generate [--limit 25] [--data <目录>]

  从招聘库高频单位名批量生成带来源的公司档案（需先在“模型与接口”里配置 SearXNG）。
  可选：--data <目录> 指定数据目录（默认 owner 账号的 .data）`);
}
