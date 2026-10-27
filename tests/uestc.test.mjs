import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import source, {parseUestcCalendar} from '../src/recruit/sources/uestc.mjs';
import {collectSource} from '../src/recruit/collect.mjs';
import {RecruitStore} from '../src/recruit/store.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/uestc-calendar.json', import.meta.url), 'utf8'));

test('电子科大：现场日历解析', () => {
  const items = parseUestcCalendar(fixture);
  assert.equal(items.length, 1);
  assert.equal(items[0].company, '中国工程物理研究院');
  assert.equal(items[0].startAt, '2026-10-08T09:30:00+08:00');
  assert.equal(items[0].endAt, '2026-10-08T11:30:00+08:00');
  assert.equal(items[0].kind, '宣讲会');
});

test('电子科大：使用日历接口且无需项目能力', () => {
  assert.match(source.listUrl, /\/api\/home\/calendar\?month=/);
  assert.equal(source.enabled, true);
  assert.equal(source.capabilities.projects, 'none');
});

test('电子科大：整月日历超过 20 条时未来场次不被截断，活动链接留空', async () => {
  const dayOffset = n => new Date(Date.now() + 8 * 3600 * 1000 + n * 86400000).toISOString().slice(0, 10);
  const rows = [];
  for (let i = 0; i < 20; i++) {
    rows.push({
      id: 'past-' + i,
      title: '过去单位' + i + '宣讲会',
      companyName: '过去单位' + i,
      recruitmentDate: dayOffset(-20 + i) + ' 09:00:00',
      endTime: '11:00:00',
      recruitmentLocation: '学生活动中心',
      recruitmentTypeLabel: '现场招聘'
    });
  }
  for (let i = 0; i < 3; i++) {
    rows.push({
      id: 'future-' + i,
      title: '未来单位' + i + '宣讲会',
      companyName: '未来单位' + i,
      recruitmentDate: dayOffset(2 + i) + ' 09:00:00',
      endTime: '11:00:00',
      recruitmentLocation: '学生活动中心',
      recruitmentTypeLabel: '现场招聘'
    });
  }
  const days = {};
  for (const row of rows) {
    const day = row.recruitmentDate.slice(0, 10);
    (days[day] ||= {data: []}).data.push(row);
  }

  const calls = [];
  const server = createServer((req, res) => {
    if (req.url === '/robots.txt') {
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      return res.end('User-agent: *\nAllow: /\n');
    }
    calls.push(req.url);
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({code: 0, data: {onSiteCalendar: {data: days}}}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const dir = await mkdtemp(join(tmpdir(), 'zx-uestc-window-'));
  try {
    const testSource = {...source, id: 'uestc-test', listUrl: base + '/career/api/home/calendar?month=2026-10'};
    const result = await collectSource(testSource, {dir});
    assert.equal(result.status, 'connected', result.message);
    assert.equal(result.fetched, 23);
    const now = new Date(Date.now() + 8 * 3600 * 1000);
    const thisMonth = now.toISOString().slice(0, 7);
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 7);
    assert.ok(calls.some(url => url.includes('month=' + thisMonth)), '应请求本月日历');
    assert.ok(calls.some(url => url.includes('month=' + nextMonth)), '应请求下月日历，避免月末抓不到未来场次');
    const store = RecruitStore.open(join(dir, 'recruit.db'));
    try {
      const events = store.listEvents({limit: 100});
      assert.equal(events.length, 23);
      const future = events.find(event => event.title === '未来单位2宣讲会');
      assert.ok(future, '未来场次必须入库');
      assert.equal(future.sourceUrl, '', '没有详情页时不能指向首页');
      assert.match(future.notes, /无详情链接/);
      assert.equal(future.confidence, 0.85, '无详情链接不应抬高置信度');
    } finally { store.close(); }
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, {recursive: true, force: true});
  }
});
