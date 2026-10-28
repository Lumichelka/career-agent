import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile, readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

test('npm test 注册了每个 tests/*.test.mjs，且清单没有重复', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const listed = [...pkg.scripts.test.matchAll(/(tests\/[\w./-]+\.test\.mjs)/g)].map(m => m[1]);
  const files = (await readdir(join(root, 'tests')))
    .filter(name => name.endsWith('.test.mjs'))
    .map(name => 'tests/' + name)
    .sort();
  assert.deepEqual([...new Set(listed)].sort(), files, '新增测试文件必须加进 package.json 的 npm test 清单');
  assert.equal(listed.length, new Set(listed).size, 'npm test 清单里有重复测试文件');
});

test('scripts/check.mjs 引用的测试文件都存在，且没有重复', async () => {
  const source = await readFile(join(root, 'scripts', 'check.mjs'), 'utf8');
  const listed = [...source.matchAll(/'(tests\/[\w./-]+\.test\.mjs)'/g)].map(m => m[1]);
  assert.ok(listed.length > 0, 'check.mjs 应引用测试文件');
  for (const file of listed) assert.ok(existsSync(join(root, file)), 'check.mjs 引用了不存在的测试：' + file);
  assert.equal(listed.length, new Set(listed).size, 'check.mjs 测试清单里有重复项');
});
