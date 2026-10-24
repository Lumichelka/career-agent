import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {backupDataDir} from '../scripts/backup.mjs';

async function withDirs(fn) {
  const root = await mkdtemp(join(tmpdir(), 'zx-backup-'));
  try {
    const data = join(root, 'data');
    const backups = join(root, 'backups');
    await mkdir(join(data, 'users', 'u1', '.data'), {recursive: true});
    await writeFile(join(data, 'accounts.json'), JSON.stringify({users: [{name: 'owner'}]}), 'utf8');
    await writeFile(join(data, 'users', 'u1', '.data', 'recruit.db'), 'fake-db', 'utf8');
    await writeFile(join(data, 'users', 'u1', '.data', 'memory.json'), '{}', 'utf8');
    return await fn({root, data, backups});
  } finally { await rm(root, {recursive: true, force: true}); }
}

test('备份：复制数据、写清单、保留可读副本', async () => {
  await withDirs(async ({data, backups}) => {
    const r = await backupDataDir({dataDir: data, backupRoot: backups, keep: 5});
    assert.ok(r.files >= 3);
    assert.ok(r.bytes > 0);
    const manifest = JSON.parse(await readFile(join(r.target, 'backup-manifest.json'), 'utf8'));
    assert.equal(manifest.app, '职向');
    assert.ok(manifest.files >= 3);
    const copied = await readFile(join(r.target, 'accounts.json'), 'utf8');
    assert.match(copied, /owner/);
    assert.equal((await stat(join(r.target, 'users', 'u1', '.data', 'recruit.db'))).isFile(), true);
  });
});

test('备份：保留份数与目录保护', async () => {
  await withDirs(async ({data, backups}) => {
    await backupDataDir({dataDir: data, backupRoot: backups, keep: 1});
    await backupDataDir({dataDir: data, backupRoot: backups, keep: 1});
    const dirs = (await readdir(backups, {withFileTypes: true})).filter(e => e.isDirectory() && e.name.startsWith('zhixiang-'));
    assert.equal(dirs.length, 1);
    await assert.rejects(() => backupDataDir({dataDir: data, backupRoot: join(data, 'backups')}), /不能放在数据目录/);
  });
});
