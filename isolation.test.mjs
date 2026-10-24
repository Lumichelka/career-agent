import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Accounts} from './accounts.mjs';
import {KeyVault} from './keyvault.mjs';

test('账号注册、登录与会话', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zx-accounts-'));
  try {
    const accounts = await new Accounts(dir).init();
    const user = await accounts.register('alice', 'correct-horse-battery');
    assert.equal(user.name, 'alice');
    await assert.rejects(() => accounts.register('ALICE', 'another-password'), /账号已存在/);
    await assert.rejects(() => accounts.register('bob', 'short'), /10至128位/);
    const login = accounts.login('alice', 'correct-horse-battery');
    assert.equal(accounts.authenticate('career_auth=' + login.token).name, 'alice');
    assert.equal(accounts.authenticate('career_auth=deadbeef'), null);
    accounts.logout('career_auth=' + login.token);
    assert.equal(accounts.authenticate('career_auth=' + login.token), null);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('密码不落明文，错误次数有限流', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zx-accounts-'));
  try {
    const accounts = await new Accounts(dir).init();
    await accounts.register('carol', 'super-secret-pass');
    const raw = await readFile(join(dir, 'accounts.json'), 'utf8');
    assert.equal(raw.includes('super-secret-pass'), false);
    for (let i = 0; i < 5; i++) assert.throws(() => accounts.login('carol', 'wrong-password'));
    assert.throws(() => accounts.login('carol', 'super-secret-pass'), /尝试过于频繁/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('两个账号的 Key 存储互不可见', async () => {
  const base = await mkdtemp(join(tmpdir(), 'zx-iso-'));
  try {
    const a = await new KeyVault(join(base, 'a')).init();
    const b = await new KeyVault(join(base, 'b')).init();
    await a.set('model.apiKey', 'sk-alice');
    assert.equal(a.get('model.apiKey'), 'sk-alice');
    assert.equal(b.get('model.apiKey'), '');
    const reloadedB = await new KeyVault(join(base, 'b')).init();
    assert.equal(reloadedB.get('model.apiKey'), '');
  } finally { await rm(base, {recursive: true, force: true}); }
});
