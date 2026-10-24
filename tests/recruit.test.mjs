import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SOURCES, sourceById, normalizeCity, parseTimeRange, parseDateText} from '../src/recruit/sources/index.mjs';
import {eventId, htmlToText} from '../src/recruit/collect.mjs';
import {RecruitStore} from '../src/recruit/store.mjs';
import {buildSchedule, toICS, toCSV, toMarkdown} from '../src/recruit/schedule.mjs';

const scuEmploy = `<ul>
<li>
  <span class="list1_time">2026-10-26【09:20:00-11:20:00】</span>
  <span class="list1_time">望江校区就业指导中心221室</span>
  <a href="/index/index/employdetail.html?data=abc">中国石化集团胜利石油管理局有限公司</a>
</li>
<li>
  <span class="list1_time">2026-10-26【15:20:00-17:20:00】</span>
  <span class="list1_time">望江校区就业指导中心303室</span>
  <a href="/index/index/employdetail.html?data=def">福建南孚市场营销有限公司</a>
</li>
</ul>`;

const scuJobfair = `<ul>
<li><span class="list1_time">2026-10-23 14:00</span><a href="/index/index/jobfairdetail.html?data=xyz">周五职通车—江安校区综合场（二）</a></li>
</ul>`;

const nankaiList = `<ul>
<li><a href="/recruitment/content/type/1/id/387.html" target="_blank">南开大学2027届毕业生秋季校园双选会（综合类第三场）</a> <span>2026-11-13</span></li>
<li><a href="/recruitment/content/type/1/id/388.html" target="_blank">南开大学商学院2026年秋季实习就业双选会</a> <span>2026-10-29</span></li>
</ul>`;

const nankaiDetail = `时间：2026-11-13 14:00 地点：南开大学津南校区大通学生中心一楼
一、活动时间地点 1.时间：2026年11月13日（星期五）14:00-17:00`;

test('日期与时段解析', () => {
  assert.equal(parseDateText('2026年11月13日'), '2026-11-13');
  assert.equal(parseDateText('2026/1/5'), '2026-01-05');
  assert.deepEqual(parseTimeRange('15:00-17:00'), ['15:00', '17:00']);
  assert.deepEqual(parseTimeRange('09:20:00—11:20:00'), ['09:20', '11:20']);
  assert.equal(parseTimeRange('没有时间'), null);
});

test('城市名规范化', () => {
  assert.equal(normalizeCity('浙江省杭州市'), '杭州');
  assert.equal(normalizeCity('上海市'), '上海');
  assert.equal(normalizeCity('成都'), '成都');
  assert.equal(normalizeCity('', '天津'), '天津');
});

test('四川大学宣讲会解析', () => {
  const source = sourceById('scu-employ');
  const items = source.parseList(scuEmploy, source);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, '中国石化集团胜利石油管理局有限公司');
  assert.equal(items[0].startAt, '2026-10-26T09:20:00+08:00');
  assert.equal(items[0].endAt, '2026-10-26T11:20:00+08:00');
  assert.equal(items[0].venue, '望江校区就业指导中心221室');
  assert.match(items[0].url, /^https:\/\/jy\.scu\.edu\.cn\/index\/index\/employdetail/);
});

test('四川大学双选会解析', () => {
  const source = sourceById('scu-jobfair');
  const items = source.parseList(scuJobfair, source);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, '双选会');
  assert.equal(items[0].venue, '四川大学江安校区');
  assert.equal(items[0].startAt, '2026-10-23T14:00:00+08:00');
});

test('南开列表 + 详情补全地点与结束时间', () => {
  const source = sourceById('nankai-recruitment');
  const items = source.parseList(nankaiList, source);
  assert.equal(items.length, 2);
  assert.equal(items[0].startAt.slice(0, 10), '2026-11-13');
  const detail = source.parseDetail(nankaiDetail, items[0]);
  assert.equal(detail.venue, '南开大学津南校区大通学生中心一楼');
  assert.equal(detail.startTime, '14:00');
  assert.equal(detail.endTime, '17:00');
});

test('上海财经大学 JSON 解析', () => {
  const source = sourceById('sufe-xjh');
  const json = {code: 200, data: {list: [{xjhid: '123', xjhzt: '中国光大银行上海分行2027年秋季校园招聘宣讲会', dwmc: '中国光大银行股份有限公司上海分行', jbrq: '2026-10-23', jbsjdmc: '15:00-17:00', cddz: '武东路校区大学生活动中心A208', szsmc: '上海市', hyyjmc: '金融业', rsgmmc: '10000人以上'}]}};
  const items = source.parseList('', source, json);
  assert.equal(items.length, 1);
  assert.equal(items[0].company, '中国光大银行股份有限公司上海分行');
  assert.equal(items[0].venue, '武东路校区大学生活动中心A208');
  assert.equal(items[0].url, 'https://career.sufe.edu.cn/career/xjhxx/view/123');
});

test('事件 ID 稳定，重复采集不重复入库', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zx-recruit-'));
  try {
    const store = RecruitStore.open(join(dir, 'recruit.db'));
    store.syncSources(SOURCES);
    const event = {
      id: eventId({school: '四川大学', title: 'A', startAt: '2026-10-26T09:00:00+08:00', venue: 'X'}),
      sourceId: 'scu-employ', school: '四川大学', city: '成都', kind: '宣讲会', title: 'A', company: 'A',
      startAt: '2026-10-26T09:00:00+08:00', endAt: '', venue: 'X', fetchedAt: new Date().toISOString(), confidence: 0.7
    };
    assert.equal(store.upsertEvent(event), 'created');
    assert.equal(store.upsertEvent(event), 'updated');
    assert.equal(store.upsertEvent({...event, id: eventId({school: '四川大学', title: 'B', startAt: '2026-10-27T09:00:00+08:00', venue: 'Y'}), title: 'B'}), 'created');
    const list = store.listEvents({from: '2026-10-01T00:00:00+08:00', to: '2026-12-01T00:00:00+08:00'});
    assert.equal(list.length, 2);
    assert.equal(store.stats().total, 2);
    const ics = toICS(list);
    assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2);
    assert.ok(toCSV(list).includes('四川大学'));
    assert.ok(toMarkdown(buildSchedule(list)).includes('2026-10-26'));
    store.close();
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('HTML 转文本保留行结构', () => {
  const text = htmlToText('<div>时间：2026-11-13 14:00</div><div>地点：大通学生中心</div>');
  assert.match(text, /时间：2026-11-13 14:00\n地点：大通学生中心/);
});

test('智能体工具能读取本机招聘数据库', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zx-tool-'));
  try {
    const store = RecruitStore.open(join(dir, 'recruit.db'));
    store.upsertEvent({
      id: eventId({school: '四川大学', title: '工具测试宣讲', startAt: '2026-11-02T14:00:00+08:00', venue: '望江校区'}),
      sourceId: 'scu-employ', school: '四川大学', city: '成都', kind: '宣讲会', title: '工具测试宣讲', company: '测试公司',
      startAt: '2026-11-02T14:00:00+08:00', endAt: '2026-11-02T16:00:00+08:00', venue: '望江校区', fetchedAt: new Date().toISOString(), confidence: 0.8
    });
    store.close();
    const {callCareerTool} = await import('../src/model/api-model.mjs');
    const out = await callCareerTool('career_recruit_events', {days: 30}, {config: {recruitDir: dir}});
    assert.equal(out.count, 1);
    assert.match(out.markdown, /工具测试宣讲/);
    assert.equal(out.events[0].school, '四川大学');
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('工具参数校验拒绝多余字段', async () => {
  const {validateToolArguments} = await import('../src/tools/policy.mjs');
  assert.throws(() => validateToolArguments('career_recruit_events', {days: 30, evil: 1}), /未声明参数/);
  assert.throws(() => validateToolArguments('career_recruit_events', {days: 999}), /不能大于 90/);
  assert.deepEqual(validateToolArguments('career_company_research', {company: ' 某公司 ', city: '成都'}), {company: '某公司', city: '成都'});
});
