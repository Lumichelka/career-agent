import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, mkdir, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveDataDir, prepareDataDir, legacyDataDir} from '../src/config/paths.mjs';

test('数据目录：环境变量优先', () => {
  const custom = join(tmpdir(), 'zx-custom-data');
  assert.equal(resolveDataDir({env: {CAREER_DATA_DIR: custom}}), custom);
});

test('数据目录：Windows 默认放 LOCALAPPDATA', () => {
  const dir = resolveDataDir({env: {LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local'}, platform: 'win32', home: 'C:\\Users\\demo'});
  assert.equal(dir, join('C:\\Users\\demo\\AppData\\Local', 'ZhiXiang'));
});

test('数据目录：非 Windows 用 home', () => {
  assert.ok(resolveDataDir({env: {}, platform: 'linux', home: '/home/demo'}).endsWith('.zhixiang'));
});

test('旧数据迁移：复制账号与文件，不删除旧目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zx-root-'));
  const target = await mkdtemp(join(tmpdir(), 'zx-target-'));
  const previous = process.env.CAREER_DATA_DIR;
  try {
    await mkdir(join(legacyDataDir(root), 'users', 'u1'), {recursive: true});
    await writeFile(join(legacyDataDir(root), 'accounts.json'), '[]', 'utf8');
    await writeFile(join(legacyDataDir(root), 'users', 'u1', 'note.txt'), 'hello', 'utf8');
    process.env.CAREER_DATA_DIR = target;
    const logs = [];
    const result = await prepareDataDir({root, log: m => logs.push(m)});
    assert.equal(result, target);
    assert.equal(await readFile(join(target, 'accounts.json'), 'utf8'), '[]');
    assert.equal(await readFile(join(target, 'users', 'u1', 'note.txt'), 'utf8'), 'hello');
    assert.ok(logs.some(l => l.includes('迁移')));
    // 旧目录仍在
    assert.equal(await readFile(join(legacyDataDir(root), 'accounts.json'), 'utf8'), '[]');
  } finally {
    if (previous === undefined) delete process.env.CAREER_DATA_DIR; else process.env.CAREER_DATA_DIR = previous;
    await rm(root, {recursive: true, force: true});
    await rm(target, {recursive: true, force: true});
  }
});

test('已有新数据时不重复迁移', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zx-root-'));
  const target = await mkdtemp(join(tmpdir(), 'zx-target-'));
  const previous = process.env.CAREER_DATA_DIR;
  try {
    await mkdir(legacyDataDir(root), {recursive: true});
    await writeFile(join(legacyDataDir(root), 'accounts.json'), '[{"old":true}]', 'utf8');
    await writeFile(join(target, 'accounts.json'), '[{"new":true}]', 'utf8');
    process.env.CAREER_DATA_DIR = target;
    await prepareDataDir({root});
    assert.equal(await readFile(join(target, 'accounts.json'), 'utf8'), '[{"new":true}]');
  } finally {
    if (previous === undefined) delete process.env.CAREER_DATA_DIR; else process.env.CAREER_DATA_DIR = previous;
    await rm(root, {recursive: true, force: true});
    await rm(target, {recursive: true, force: true});
  }
});
