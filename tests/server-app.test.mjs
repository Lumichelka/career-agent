import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp, rm, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from '../src/server/app.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

// 每个用例一条独立实例：临时数据目录 + 系统分配端口，结束关闭并清目录。
async function startApp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'zx-app-'));
  const app = await createApp({root, dataDir: dir, host: '127.0.0.1', port: 0});
  t.after(async () => { await app.close(); await rm(dir, {recursive: true, force: true}); });
  return app;
}

test('createApp：临时数据目录 + 随机端口起动，关闭后不再响应', async t => {
  const app = await startApp(t);
  assert.ok(app.port > 0, '应报告实际监听端口');
  assert.equal(app.host, '127.0.0.1');

  const health = await fetch(app.origin + '/health');
  assert.equal(health.status, 200);
  const body = await health.json();
  assert.equal(body.app, 'career-agent');
  assert.equal(body.status, 'ready');
  assert.equal(body.port, app.port, '健康检查应报告实际监听端口');

  await app.close();
  await assert.rejects(() => fetch(app.origin + '/health'), '关闭后连接应失败');
});

test('静态页：no-store 与 CSP 不回归', async t => {
  const app = await startApp(t);
  const res = await fetch(app.origin + '/chat');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('content-security-policy') || '', /default-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('鉴权：缺 token 403，缺登录 401，注册后 cookie 可访问本人接口', async t => {
  const app = await startApp(t);

  const noToken = await fetch(app.origin + '/api/new', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
  assert.equal(noToken.status, 403);

  const noLogin = await fetch(app.origin + '/api/new', {method: 'POST', headers: {'Content-Type': 'application/json', 'x-career-token': app.token}, body: '{}'});
  assert.equal(noLogin.status, 401);

  const reg = await fetch(app.origin + '/api/auth/register', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'x-career-token': app.token},
    body: JSON.stringify({name: 'alice', password: 'correct-horse-battery'})
  });
  assert.equal(reg.status, 200);
  const {user} = await reg.json();
  assert.equal(user.name, 'alice');
  const cookie = (reg.headers.getSetCookie?.() || [reg.headers.get('set-cookie')]).filter(Boolean).join('; ');
  assert.match(cookie, /career_auth=/);

  const me = await fetch(app.origin + '/api/auth/me', {headers: {'x-career-token': app.token, cookie}});
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.name, 'alice');

  const created = await fetch(app.origin + '/api/new', {method: 'POST', headers: {'Content-Type': 'application/json', 'x-career-token': app.token, cookie}, body: '{}'});
  assert.equal(created.status, 200);
  const session = await created.json();
  assert.match(session.id, /^[a-f0-9-]{36}$/);
});

test('跨账号隔离：各自的会话列表与数据目录互不可见', async t => {
  const app = await startApp(t);

  const register = async name => {
    const res = await fetch(app.origin + '/api/auth/register', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'x-career-token': app.token},
      body: JSON.stringify({name, password: 'correct-horse-battery'})
    });
    assert.equal(res.status, 200, name + ' 注册失败');
    const cookie = (res.headers.getSetCookie?.() || [res.headers.get('set-cookie')]).filter(Boolean).join('; ');
    const {user} = await res.json();
    return {user, cookie};
  };
  const alice = await register('alice');
  const bob = await register('bob');

  const newSession = async (cookie) => {
    const res = await fetch(app.origin + '/api/new', {method: 'POST', headers: {'Content-Type': 'application/json', 'x-career-token': app.token, cookie}, body: '{}'});
    assert.equal(res.status, 200);
    return res.json();
  };
  await newSession(alice.cookie);

  const aliceList = await (await fetch(app.origin + '/api/sessions', {headers: {'x-career-token': app.token, cookie: alice.cookie}})).json();
  const bobList = await (await fetch(app.origin + '/api/sessions', {headers: {'x-career-token': app.token, cookie: bob.cookie}})).json();
  assert.equal(aliceList.sessions.length, 1);
  assert.equal(bobList.sessions.length, 0, 'bob 不应看到 alice 的会话');

  const usersDir = join(app.dataDir, 'users');
  const dirs = await readdir(usersDir);
  assert.ok(dirs.includes(alice.user.id) && dirs.includes(bob.user.id), '每个账号应有独立数据目录');
  assert.notEqual(alice.user.id, bob.user.id);
});

test('Host 头不在白名单时返回 403', async t => {
  const app = await startApp(t);
  const status = await new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port: app.port, path: '/health', headers: {Host: 'evil.example'}}, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(status, 403);
});

test('CLI 启动：npm start 行为不变（owner、首登文件、日志、健康检查）', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'zx-cli-'));
  const child = spawn(process.execPath, ['src/server/index.mjs'], {
    cwd: root,
    env: {...process.env, PORT: '0', CAREER_HOST: '127.0.0.1', CAREER_DATA_DIR: dir},
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => { child.kill(); await rm(dir, {recursive: true, force: true}); });

  const {out, port} = await new Promise((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(() => reject(new Error('启动超时，输出：' + buffered)), 15000);
    child.stdout.on('data', chunk => {
      buffered += chunk.toString();
      // 等最后一行（首次登录提示）出现再收：只等第一行会把后面的日志截掉。
      if (/首次登录\.txt/.test(buffered)) {
        const matched = buffered.match(/http:\/\/127\.0\.0\.1:(\d+)/);
        clearTimeout(timer);
        resolve({out: buffered, port: Number(matched[1])});
      }
    });
    child.stderr.on('data', chunk => { buffered += chunk.toString(); });
    child.on('exit', code => { clearTimeout(timer); reject(new Error('进程提前退出 code=' + code + '，输出：' + buffered)); });
  });

  assert.match(out, /职向智能体/);
  assert.match(out, /首次登录\.txt/);
  const files = await readdir(dir);
  assert.ok(files.includes('首次登录.txt'), '应生成首次登录文件');
  assert.ok(files.includes('accounts.json'), '应生成账号表（含 owner）');

  const health = await (await fetch('http://127.0.0.1:' + port + '/health')).json();
  assert.equal(health.status, 'ready');
  assert.equal(health.port, port, '日志中的端口应与实际监听一致');
});

test('平台岗位：清单接口鉴权、空库可读；未读页面不写入', async t => {
  const app = await startApp(t);
  const reg = await fetch(app.origin + '/api/auth/register', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'x-career-token': app.token},
    body: JSON.stringify({name: 'platform-user', password: 'correct-horse-battery'})
  });
  assert.equal(reg.status, 200);
  const cookie = (reg.headers.getSetCookie?.() || [reg.headers.get('set-cookie')]).filter(Boolean).join('; ');
  const headers = {'Content-Type': 'application/json', 'x-career-token': app.token, cookie};

  let res = await fetch(app.origin + '/api/platform/jobs', {method: 'POST', headers, body: JSON.stringify({q: '数据'})});
  assert.equal(res.status, 200);
  let data = await res.json();
  assert.equal(data.status, 'empty');
  assert.equal(data.jobs.length, 0);
  assert.equal(data.platforms.length, 7, '接口带 7 个平台名，供筛选');

  res = await fetch(app.origin + '/api/platform/jobsSave', {method: 'POST', headers, body: JSON.stringify({platform: 'boss', idempotencyKey: 'platform-save-1'})});
  assert.equal(res.status, 200);
  data = await res.json();
  assert.equal(data.status, 'needs_read', '没读过页面时不能凭空入库');
  assert.equal(data.code, 'PLATFORM_NOT_READ');

  const anonymous = await fetch(app.origin + '/api/platform/jobs', {method: 'POST', headers: {'Content-Type': 'application/json', 'x-career-token': app.token}, body: '{}'});
  assert.ok([401, 403].includes(anonymous.status), '平台岗位属于个人数据，未登录或没有任务身份时不可读');
});
