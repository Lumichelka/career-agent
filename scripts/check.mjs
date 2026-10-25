// 一键自检：环境、数据目录、数据库、测试。
// 用法：node scripts/check.mjs [--no-test]
import {spawnSync} from 'node:child_process';
import {mkdir, writeFile, rm, readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveDataDir} from '../src/config/paths.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const checks = [];
function record(name, ok, detail = '', warn = false) {
  checks.push({name, ok, warn});
  console.log((ok ? '✔' : warn ? '!' : '✘') + ' ' + name + (detail ? '：' + detail : ''));
}

// 1. Node 版本
const major = Number(process.versions.node.split('.')[0]);
record('Node.js 版本', major >= 23, process.version + (major >= 23 ? '' : '（需要 23+）'));

// 2. 数据目录可写
const dataDir = resolveDataDir();
try {
  await mkdir(dataDir, {recursive: true});
  const probe = join(dataDir, '.write-check');
  await writeFile(probe, 'ok', 'utf8');
  await rm(probe, {force: true});
  record('数据目录可写', true, dataDir);
} catch (e) {
  record('数据目录可写', false, e.message);
}

// 3. 账号数据
record('账号数据', existsSync(join(dataDir, 'accounts.json')), existsSync(join(dataDir, 'accounts.json')) ? join(dataDir, 'accounts.json') : '尚未初始化（首次启动会创建）', !existsSync(join(dataDir, 'accounts.json')));

// 4. 招聘数据库（优先查当前账号的租户目录）
if (major >= 23) {
  let dbFile = join(dataDir, 'recruit.db');
  try {
    const accounts = JSON.parse(await readFile(join(dataDir, 'accounts.json'), 'utf8'));
    const owner = accounts[0];
    if (owner?.id) {
      const tenantDb = join(dataDir, 'users', owner.id, '.data', 'recruit.db');
      if (existsSync(tenantDb)) dbFile = tenantDb;
    }
  } catch { /* 没有账号就用根目录 */ }
  if (!existsSync(dbFile)) {
    record('招聘数据库', false, '尚未采集（可运行 npm run collect）', true);
  } else {
    try {
      const {RecruitStore} = await import('../src/recruit/store.mjs');
      const store = RecruitStore.open(dbFile);
      const stats = store.stats();
      store.close();
      record('招聘数据库', true, `${stats.total} 场活动，其中未来 ${stats.upcoming} 场`);
    } catch (e) {
      record('招聘数据库', false, e.message);
    }
  }
}

// 5. 自动化测试
if (!args.includes('--no-test')) {
  console.log('\n运行自动化测试…');
  const files = ['tests/core.test.mjs', 'tests/api-model.test.mjs', 'tests/isolation.test.mjs', 'tests/recruit.test.mjs', 'tests/paths.test.mjs', 'tests/tools.test.mjs', 'tests/memory.test.mjs', 'tests/skills.test.mjs', 'tests/sources.test.mjs', 'tests/lifecycle.test.mjs', 'tests/resume.test.mjs', 'tests/backup.test.mjs', 'tests/manual.test.mjs', 'tests/company.test.mjs', 'tests/docx.test.mjs', 'tests/platform.test.mjs', 'tests/projects.test.mjs', 'tests/wechat.test.mjs', 'tests/swpu-jobfair.test.mjs', 'tests/collect-projects.test.mjs', 'tests/scu-jobfair.test.mjs', 'tests/uestc.test.mjs', 'tests/project-workflow.test.mjs', 'tests/wechat-harvest.test.mjs'];
  const run = spawnSync(process.execPath, ['--test', ...files], {cwd: root, stdio: 'inherit'});
  record('自动化测试', run.status === 0, run.status === 0 ? '全部通过' : '存在失败，见上方输出');
} else {
  record('自动化测试', true, '已跳过（--no-test）', true);
}

const failed = checks.filter(c => !c.ok && !c.warn);
console.log('\n' + '─'.repeat(50));
console.log(failed.length ? `自检未通过：${failed.length} 项失败` : '自检通过，可以启动。');
process.exitCode = failed.length ? 1 : 0;
