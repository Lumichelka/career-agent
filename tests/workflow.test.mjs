import test from 'node:test';
import assert from 'node:assert/strict';
import {badgeCount, groupTasks, renderDrawer, renderTaskCard, formatDuration, STATE_LABELS} from '../src/web/workflow.js';

const task = over => ({
  id: 't1', sessionId: 's1', title: '写一封邮件', backend: 'API · mock', sourceName: '',
  state: 'running', createdAt: '2026-10-26T02:00:00.000Z', startedAt: '2026-10-26T02:00:01.000Z', finishedAt: '',
  progress: {percent: 40, text: '正在读取页面'},
  evidence: [], draft: null, error: null, events: [], seq: 3,
  ...over
});

test('徽标只计运行中与待确认', () => {
  const tasks = [
    task({id: 'a', state: 'running'}),
    task({id: 'b', state: 'waiting_confirmation'}),
    task({id: 'c', state: 'queued'}),
    task({id: 'd', state: 'succeeded'}),
    task({id: 'e', state: 'failed'}),
    task({id: 'f', state: 'cancelled'}),
    task({id: 'g', state: 'undone'})
  ];
  assert.equal(badgeCount(tasks), 2);
  assert.equal(badgeCount([]), 0);
  assert.equal(badgeCount(null), 0);
});

test('按状态分组：运行中 / 排队中 / 待确认 / 已完成 / 失败与取消，空组不出现', () => {
  const tasks = [
    task({id: '1', state: 'failed'}),
    task({id: '2', state: 'running'}),
    task({id: '3', state: 'succeeded'}),
    task({id: '4', state: 'queued'}),
    task({id: '5', state: 'cancelled'}),
    task({id: '6', state: 'blocked'})
  ];
  const groups = groupTasks(tasks);
  assert.deepEqual(groups.map(group => group.label), ['运行中', '排队中', '待确认', '已完成', '失败与取消']);
  assert.deepEqual(groups.map(group => group.tasks.length), [1, 1, 1, 1, 2]);
  assert.deepEqual(groupTasks([]), []);
});

test('任务卡：状态、进度、证据区块与草稿区块都在', () => {
  const html = renderTaskCard(task({
    evidence: [
      {id: 'e1', kind: 'screenshot', name: '就业网首页截图', url: 'https://example.com/a.png', at: '2026-10-26T02:00:02.000Z'},
      {id: 'e2', kind: 'page', name: '就业网页面', bytes: 4096, at: '2026-10-26T02:00:03.000Z'}
    ],
    draft: {title: '双选会草稿', chars: 128, artifactId: 'a1', at: '2026-10-26T02:00:04.000Z'}
  }));
  assert.match(html, /data-state="running"/);
  assert.match(html, /运行中/);
  assert.match(html, /40%/);
  assert.match(html, /正在读取页面/);
  assert.match(html, /证据（2）/);
  assert.match(html, /就业网首页截图/);
  assert.match(html, /https:\/\/example\.com\/a\.png/);
  assert.match(html, /草稿 · 双选会草稿/);
  assert.match(html, /data-task-draft="t1"/);
  assert.match(html, /data-task-stop="t1"/);
});

test('任务卡：空证据与空草稿也显示区块，不让卡片缺一块', () => {
  const html = renderTaskCard(task({state: 'queued', progress: {percent: 0, text: '排队中'}}));
  assert.match(html, /证据（0）/);
  assert.match(html, /还没有证据/);
  assert.match(html, /还没有草稿/);
});

test('任务卡：结束的任务隐藏停止按钮，显示时长与错误恢复建议', () => {
  const html = renderTaskCard(task({
    state: 'failed', finishedAt: '2026-10-26T02:01:01.000Z', durationMs: 60000,
    error: {code: 'CONNECT_FAILED', message: '连接在 60 秒内没有建立', recovery: '检查上游地址'}
  }));
  assert.doesNotMatch(html, /data-task-stop/);
  assert.match(html, /CONNECT_FAILED/);
  assert.match(html, /连接在 60 秒内没有建立/);
  assert.match(html, /恢复建议：检查上游地址/);
  assert.match(html, /1 分 00 秒/);
});

test('任务卡：用户内容被转义，不会注入 HTML', () => {
  const html = renderTaskCard(task({
    title: '<img src=x onerror=alert(1)>',
    progress: {percent: 10, text: '<script>alert(2)</script>'},
    evidence: [{id: 'e', kind: 'tool', name: '<b>证据</b>'}],
    draft: {title: '<i>草稿</i>', chars: 1, artifactId: 'a'}
  }));
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<b>证据<\/b>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('抽屉：空状态与分组标题', () => {
  assert.match(renderDrawer([]), /还没有任务/);
  const html = renderDrawer([task({id: '1', state: 'running'}), task({id: '2', state: 'succeeded', finishedAt: '2026-10-26T02:00:30.000Z'})]);
  assert.match(html, /data-group="running"/);
  assert.match(html, /data-group="done"/);
  assert.match(html, /运行中 <span>1<\/span>/);
  assert.doesNotMatch(html, /data-group="failed"/, '空分组不应出现');
});

test('状态中文名与时长格式', () => {
  assert.equal(STATE_LABELS.waiting_confirmation, '待确认');
  assert.equal(STATE_LABELS.blocked, '已阻塞');
  assert.equal(formatDuration(0), '0 秒');
  assert.equal(formatDuration(65000), '1 分 05 秒');
});
