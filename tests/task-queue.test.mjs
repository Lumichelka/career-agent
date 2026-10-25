import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskQueue, QueueTimeoutError} from '../src/server/task-queue.mjs';

const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));

test('每用户 2 个：第 3 个排队，释放一个后按到达顺序放行', async () => {
  const queue = new TaskQueue({userLimit: 2, globalLimit: 8, waitLimitMs: 1000});
  const first = await queue.acquire('u1');
  const second = await queue.acquire('u1');
  assert.deepEqual(queue.stats(), {active: 2, waiting: 0, userLimit: 2, globalLimit: 8, waitLimitMs: 1000});

  let third = null;
  const waiting = queue.acquire('u1').then(release => { third = release; });
  await tick();
  assert.equal(third, null, '第 3 个任务必须排队');
  assert.equal(queue.stats().waiting, 1);

  first();
  await waiting;
  assert.ok(third, '释放名额后应放行第 3 个任务');
  assert.equal(queue.stats().active, 2);

  second();
  third();
  assert.equal(queue.stats().active, 0);
});

test('释放函数幂等：重复调用不会多放名额', async () => {
  const queue = new TaskQueue({userLimit: 1, globalLimit: 1, waitLimitMs: 100});
  const release = await queue.acquire('u1');
  release();
  release();
  assert.equal(queue.stats().active, 0, '重复释放不能让计数变负或多放名额');
});

test('全局上限 8：第 9 个任务排队', async () => {
  const queue = new TaskQueue({userLimit: 2, globalLimit: 8, waitLimitMs: 1000});
  const releases = [];
  for (let i = 0; i < 8; i++) releases.push(await queue.acquire('u' + (i % 4)));
  assert.equal(queue.stats().active, 8);

  let ninth = null;
  const waiting = queue.acquire('u9').then(release => { ninth = release; });
  await tick();
  assert.equal(ninth, null, '全局满 8 时应排队');
  assert.equal(queue.stats().waiting, 1);

  releases[0]();
  await waiting;
  assert.ok(ninth);
  for (const release of releases) release();
  ninth();
  assert.equal(queue.stats().active, 0);
});

test('排队超时给出 QUEUE_TIMEOUT，并把自己从队列里摘掉', async () => {
  const queue = new TaskQueue({userLimit: 1, globalLimit: 1, waitLimitMs: 40});
  const release = await queue.acquire('u1');
  await assert.rejects(queue.acquire('u2'), error => {
    assert.equal(error.code, 'QUEUE_TIMEOUT');
    assert.ok(error instanceof QueueTimeoutError);
    assert.match(error.message, /排队/);
    return true;
  });
  assert.equal(queue.stats().waiting, 0);
  release();
  assert.equal(queue.stats().active, 0);
});

test('排队中中止：拒绝并让出位置，后面的任务不受影响', async () => {
  const queue = new TaskQueue({userLimit: 1, globalLimit: 1, waitLimitMs: 1000});
  const release = await queue.acquire('u1');
  const controller = new AbortController();
  const pending = queue.acquire('u2', {signal: controller.signal});
  await tick();
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(queue.stats().waiting, 0);

  release();
  const next = await queue.acquire('u2');
  assert.equal(queue.stats().active, 1);
  next();
  assert.equal(queue.stats().active, 0);
});

test('队首用户已满时，后面还能跑的用户不必等它', async () => {
  const queue = new TaskQueue({userLimit: 1, globalLimit: 4, waitLimitMs: 1000});
  const a1 = await queue.acquire('A');
  const served = [];
  const a2 = queue.acquire('A').then(release => { served.push('A2'); return release; });
  const b1 = queue.acquire('B').then(release => { served.push('B1'); return release; });
  await tick();
  assert.deepEqual(served, ['B1'], 'A 的用户名额已满，B1 不应被队首的 A2 挡住');

  a1();
  await tick();
  assert.deepEqual(served, ['B1', 'A2'], 'A 释放后 A2 放行');

  const releases = await Promise.all([a2, b1]);
  for (const release of releases) release();
  assert.equal(queue.stats().active, 0);
});

test('排队超时文案按毫秒或秒显示', () => {
  assert.match(new QueueTimeoutError(120000).message, /120 秒/);
  assert.match(new QueueTimeoutError(150).message, /150 毫秒/);
});
