import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, mkdir, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {callTool} from '../src/tools/execute.mjs';
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

test('career_feed 快照：规范化记录、证据指针、脱敏原文与 cursor', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'zx-feed-'));
  try {
    const userId = 'u-feed';
    const taskId = 't-feed';
    const recruitDir = join(dataDir, 'users', userId, '.data');
    const evidenceDir = join(dataDir, 'users', userId, 'tasks', taskId, 'evidence');
    await mkdir(evidenceDir, {recursive: true});
    await writeFile(join(evidenceDir, '02-detail.png'), 'fake-png-bytes');
    const rawText = '<b>联系</b> 张三 手机 13800138000 邮箱 a@b.com 微信 wxid_abc123 身份证 110101199001011234';
    const {writeSourceCheck} = await import('../src/source-check/pipeline.mjs');
    const write = await writeSourceCheck({
      dataDir, userId, taskId,
      extraction: {
        events: [{title: 'AI 信息流宣讲会', startAt: '2026-11-11T14:00:00+08:00', company: '测试单位', rawText}],
        projects: [{eventIndex: 0, company: '测试单位', title: '数据分析', positions: 'SQL'}]
      },
      source: {listUrl: 'https://example.edu/list', detailUrl: 'https://example.edu/detail'},
      screenshots: [{id: 'detail', file: '02-detail.png', url: 'https://example.edu/detail', at: new Date().toISOString()}]
    });
    assert.equal(write.status, 'applied');

    const out = await callTool('career_feed', {}, {config: {recruitDir, dataDir, userId}});
    assert.equal(out.status, 'readable');
    assert.equal(out.hasMore, false);
    assert.equal(out.entries.length, 2);
    const event = out.entries.find(entry => entry.type === 'event');
    assert.equal(event.op, 'upsert');
    assert.equal(event.record.title, 'AI 信息流宣讲会');
    assert.equal(event.record.source_id, 'manual');
    assert.equal(event.record.source_url, 'https://example.edu/detail');
    assert.match(event.record.operation_id, new RegExp('^' + taskId + ':\\d+$'), 'operation_id = taskId:runSeq');
    assert.equal(event.record.evidence_ref, 'artifact:02-detail.png');
    assert.equal(event.record.evidence_available, true);
    assert.equal(event.record.schema_version, 'career_feed.v1');
    assert.equal(event.record.verification, 'unverified');
    assert.equal(event.record.deleted_at, null);
    assert.ok(event.record.fetched_at);
    assert.equal(event.rawText, undefined, 'rawText 默认不返回');
    assert.ok(Number.isInteger(event.seq) && event.seq > 0);
    assert.ok(out.nextCursor >= event.seq);

    const withRaw = await callTool('career_feed', {includeRawText: true}, {config: {recruitDir, dataDir, userId}});
    const rawEvent = withRaw.entries.find(entry => entry.type === 'event');
    assert.ok(rawEvent.rawText);
    for (const secret of ['13800138000', 'a@b.com', 'wxid_abc123', '110101199001011234', '<b>']) {
      assert.ok(!rawEvent.rawText.includes(secret), '原文不得包含 ' + secret);
    }
    assert.match(rawEvent.rawText, /AI 信息流宣讲会|联系/);
  } finally { await rm(dataDir, {recursive: true, force: true}); }
});

test('career_feed 增量：upsert/delete/undo 可见，cursor 只增不减', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'zx-feed-inc-'));
  try {
    const userId = 'u-feed-inc';
    const recruitDir = join(dataDir, 'users', userId, '.data');
    const putEvidence = async taskId => {
      const dir = join(dataDir, 'users', userId, 'tasks', taskId, 'evidence');
      await mkdir(dir, {recursive: true});
      await writeFile(join(dir, '02-detail.png'), 'fake-png-bytes');
      return dir;
    };
    const evidenceDirs = [await putEvidence('t-feed-inc'), await putEvidence('t-feed-inc-2'), await putEvidence('t-feed-inc-3')];
    const {writeSourceCheck} = await import('../src/source-check/pipeline.mjs');
    const {undoBatch} = await import('../src/writes/undo.mjs');
    const {createWriteGateway} = await import('../src/writes/gateway.mjs');
    const {RecruitStore} = await import('../src/recruit/store.mjs');
    const config = {recruitDir, dataDir, userId};
    const source = {listUrl: 'https://example.edu/list', detailUrl: 'https://example.edu/detail'};
    const screenshots = [{id: 'detail', file: '02-detail.png', url: source.detailUrl, at: new Date().toISOString()}];

    const first = await writeSourceCheck({
      dataDir, userId, taskId: 't-feed-inc', source, screenshots,
      extraction: {
        events: [{title: '增量活动', startAt: '2026-12-01T09:00:00+08:00', company: '甲单位'}],
        projects: [{eventIndex: 0, company: '甲单位', title: '岗位 A'}]
      }
    });
    assert.equal(first.status, 'applied');
    const snapshot = await callTool('career_feed', {}, {config});
    const cursor = snapshot.nextCursor;
    const eventId = snapshot.entries.find(entry => entry.type === 'event').id;

    // upsert：同一活动再次写入，标题/开始时间不变，地点更新。
    const second = await writeSourceCheck({
      dataDir, userId, taskId: 't-feed-inc-2', source, screenshots,
      extraction: {
        events: [{title: '增量活动', startAt: '2026-12-01T09:00:00+08:00', company: '甲单位', venue: '新地点'}],
        projects: [{eventIndex: 0, company: '甲单位', title: '岗位 A', positions: 'SQL'}]
      }
    });
    assert.equal(second.status, 'applied');
    const afterUpdate = await callTool('career_feed', {since: cursor}, {config});
    const update = afterUpdate.entries.find(entry => entry.type === 'event' && entry.id === eventId);
    assert.ok(update, '增量里应看见活动 upsert');
    assert.equal(update.op, 'upsert');
    assert.equal(update.record.venue, '新地点');
    assert.ok(afterUpdate.nextCursor > cursor);

    // delete：项目连续 3 次未出现后软删除，审计里是 delete。
    const store = RecruitStore.open(join(recruitDir, 'recruit.db'));
    try {
      const gateway = createWriteGateway({db: store.db, domain: 'recruit', userId, taskId: 't-feed-del'});
      for (const step of [1, 2, 3]) {
        await gateway.write({
          tool: 'career_recruit_bulk_write', sensitivity: 'auto', payload: {missing: step},
          idempotencyKey: 'feed-missing-' + step,
          execute: () => store.syncProjects(eventId, 'manual', [])
        });
      }
    } finally { store.close(); }
    const afterDelete = await callTool('career_feed', {since: afterUpdate.nextCursor}, {config});
    const removed = afterDelete.entries.find(entry => entry.type === 'project' && entry.op === 'delete');
    assert.ok(removed, '增量里应看见项目软删除');
    assert.equal(removed.record.status, 'removed');
    assert.ok(removed.record.deleted_at);
    assert.equal(removed.record.evidence_ref, 'artifact:02-detail.png');
    assert.equal(removed.record.evidence_available, true);
    assert.ok(afterDelete.nextCursor > afterUpdate.nextCursor);

    // undo：撤销一整批写入，下游看见 undo 与 deleted_at。
    const third = await writeSourceCheck({
      dataDir, userId, taskId: 't-feed-inc-3', source, screenshots,
      extraction: {events: [{title: '待撤销活动', startAt: '2026-12-02T09:00:00+08:00'}], projects: []}
    });
    assert.equal(third.status, 'applied');
    const beforeUndo = await callTool('career_feed', {}, {config});
    const undo = await undoBatch({dir: recruitDir, userId, batchId: third.batchId});
    assert.equal(undo.ok, true);
    const afterUndo = await callTool('career_feed', {since: beforeUndo.nextCursor}, {config});
    const undoEntry = afterUndo.entries.find(entry => entry.type === 'event' && entry.op === 'undo');
    assert.ok(undoEntry, '增量里应看见撤销');
    assert.equal(undoEntry.record.id, third.result.events[0].id);
    assert.ok(undoEntry.record.deleted_at, '被撤销删除的记录要带 deleted_at');
    assert.ok(undoEntry.undo_of, '撤销条目要指回原审计事件');
    assert.ok(afterUndo.nextCursor > beforeUndo.nextCursor);

    // cursor 分页：limit 只截断条目，nextCursor 停在最后一条已返回的 seq；不倒退。
    const page1 = await callTool('career_feed', {since: 0, limit: 1}, {config});
    assert.equal(page1.entries.length, 1);
    assert.equal(page1.hasMore, true);
    assert.ok(page1.nextCursor >= page1.entries[0].seq);
    const page2 = await callTool('career_feed', {since: page1.nextCursor, limit: 1}, {config});
    assert.equal(page2.entries.length, 1);
    assert.ok(page2.nextCursor >= page1.nextCursor);
    const future = page2.nextCursor + 1000000;
    const empty = await callTool('career_feed', {since: future}, {config});
    assert.deepEqual(empty.entries, []);
    assert.equal(empty.nextCursor, future, '未来 cursor 不得回退');

    // 快照分页：limit 截断后必须能用 nextOffset 继续取，而不是跳到不可达的 maxSeq。
    const full = await callTool('career_feed', {types: ['event', 'project'], limit: 200}, {config});
    assert.equal(full.hasMore, false);
    const walked = [];
    let snapPage = await callTool('career_feed', {types: ['event', 'project'], limit: 2}, {config});
    while (true) {
      assert.equal(snapPage.mode, 'snapshot');
      walked.push(...snapPage.entries.map(entry => entry.id));
      if (!snapPage.hasMore) {
        assert.equal(typeof snapPage.nextCursor, 'number', '快照取完后才给增量 cursor');
        assert.equal(snapPage.nextOffset, null);
        break;
      }
      assert.equal(snapPage.nextCursor, null, '快照截断时 nextCursor 不能是不可达的 maxSeq');
      assert.ok(Number.isInteger(snapPage.nextOffset));
      snapPage = await callTool('career_feed', {types: ['event', 'project'], limit: 2, offset: snapPage.nextOffset}, {config});
    }
    assert.deepEqual(walked, full.entries.map(entry => entry.id), 'offset 分页必须取全快照且不重复');

    // 清空审计后 cursor 仍然只增不减（sqlite_sequence 高水位）。
    const {clearAudit} = await import('../src/writes/audit-api.mjs');
    const beforeClear = (await callTool('career_feed', {}, {config})).nextCursor;
    clearAudit({dir: recruitDir, userId, phrase: '清空我的审计'});
    const afterClear = await callTool('career_feed', {}, {config});
    assert.ok(afterClear.nextCursor >= beforeClear, '清空审计后 cursor 不得倒退');
    const afterClearSince = await callTool('career_feed', {since: beforeClear}, {config});
    assert.equal(afterClearSince.nextCursor, beforeClear, '清空审计后增量 cursor 仍停在原处');

    // 证据 30 天过期：文件还在也返回 evidence_available:false。
    const old = new Date(Date.now() - 31 * 24 * 3600 * 1000);
    const {utimes} = await import('node:fs/promises');
    for (const dir of evidenceDirs) await utimes(join(dir, '02-detail.png'), old, old);
    const expired = await callTool('career_feed', {types: ['event']}, {config});
    assert.ok(expired.entries.length > 0);
    assert.ok(expired.entries.every(entry => entry.record.evidence_available === false), '过期证据必须标 false');
  } finally { await rm(dataDir, {recursive: true, force: true}); }
});

test('career_feed：类型过滤、公司快照与 8k 原文上限', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zx-feed-types-'));
  try {
    const {CompanyStore} = await import('../src/company/store.mjs');
    const companies = CompanyStore.open(join(dir, 'company.db'));
    companies.save({name: '测试公司', industry: '软件', city: '成都'});
    companies.close();
    const store = RecruitStore.open(join(dir, 'recruit.db'));
    store.upsertEvent({
      id: 'e'.repeat(24), sourceId: 'manual', school: '测试大学', kind: '宣讲会',
      title: '过滤测试活动', startAt: '2026-12-11T09:00:00+08:00',
      fetchedAt: new Date().toISOString(), confidence: 0.7
    });
    store.close();
    const config = {recruitDir: dir, dataDir: dir, userId: 'u-types'};

    const companyOnly = await callTool('career_feed', {types: ['company']}, {config});
    assert.equal(companyOnly.entries.length, 1);
    assert.equal(companyOnly.entries[0].type, 'company');
    assert.equal(companyOnly.entries[0].record.name, '测试公司');
    assert.equal(companyOnly.entries[0].seq, 0, '公司还没有审计写入，seq 为 0');

    const eventOnly = await callTool('career_feed', {types: ['event']}, {config});
    assert.ok(eventOnly.entries.length >= 1);
    assert.ok(eventOnly.entries.every(entry => entry.type === 'event'));

    // 公司记录没有 write_audit 行，只在快照可见；增量（since）不承诺包含公司写入。
    const companyIncremental = await callTool('career_feed', {types: ['company'], since: 0}, {config});
    assert.deepEqual(companyIncremental.entries, [], '公司写入不进增量：已知限制（见 README/plan 28）');

    const bad = await callTool('career_feed', {types: ['unknown']}, {config});
    assert.equal(bad.status, 'error');
    assert.equal(bad.code, 'INVALID_ARGUMENTS');

    const {sanitizeRawText} = await import('../src/recruit/feed.mjs');
    assert.equal(sanitizeRawText('<div>hello</div>'), 'hello');
    assert.equal(sanitizeRawText('x'.repeat(9000)).length, 8000);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('career_feed：聊天租户 .data 目录也能解析同用户的证据指针', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zx-feed-tenant-'));
  try {
    const userId = 'u-tenant';
    const taskId = 't-tenant';
    const tenant = join(root, 'users', userId, '.data');
    const evidenceDir = join(root, 'users', userId, 'tasks', taskId, 'evidence');
    await mkdir(evidenceDir, {recursive: true});
    await writeFile(join(evidenceDir, '02-detail.png'), 'fake-png-bytes');
    const store = RecruitStore.open(join(tenant, 'recruit.db'));
    const {createWriteGateway} = await import('../src/writes/gateway.mjs');
    const gateway = createWriteGateway({db: store.db, domain: 'recruit', userId, taskId});
    const row = {
      id: 'a'.repeat(24), sourceId: 'manual', school: '测试大学', kind: '宣讲会',
      title: '租户证据活动', startAt: '2026-12-12T09:00:00+08:00',
      fetchedAt: new Date().toISOString(), confidence: 0.7
    };
    const write = await gateway.write({
      tool: 'career_recruit_bulk_write', sensitivity: 'auto', payload: {tenant: true},
      idempotencyKey: 'tenant-feed-1', sourceRef: 'artifact:02-detail.png',
      execute: () => {
        store.upsertEvent(row);
        return {changes: [{action: 'create', entity: 'events', entityId: row.id, oldValues: null, newValues: store.getEvent(row.id)}]};
      }
    });
    assert.equal(write.status, 'applied');
    store.close();

    const feed = await callTool('career_feed', {}, {config: {recruitDir: tenant, dataDir: tenant, userId}});
    const entry = feed.entries.find(item => item.type === 'event');
    assert.equal(entry.record.evidence_ref, 'artifact:02-detail.png');
    assert.equal(entry.record.evidence_available, true, '租户 .data 的上一级 tasks 目录应被识别');
    assert.match(entry.record.operation_id, new RegExp('^' + taskId + ':\\d+$'), 'operation_id = taskId:runSeq');
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('career_feed 脱敏：先解 HTML 实体，再覆盖空格/连字符手机号、身份证与微信', async () => {
  const {sanitizeRawText} = await import('../src/recruit/feed.mjs');
  const raw = '&lt;b&gt;联系&lt;/b&gt; 手机 138&#48;013&#56;000 备用 138-0013-8000 座机 010-88886666\n身份证 110101&#49;9900101&#49;234 微信 wxid_abc12345 联系人 张三';
  const text = sanitizeRawText(raw);
  for (const secret of ['13800138000', '138-0013-8000', '110101199001011234', 'wxid_abc12345', '张三', '<b>']) {
    assert.ok(!text.includes(secret), '原文不得包含 ' + secret + '：' + text);
  }
  assert.ok(text.includes('联系'), '正常文本保留');
  assert.equal(sanitizeRawText('&lt;script&gt;alert(1)&lt;/script&gt;hello').includes('alert'), false, '实体转义出来的脚本也要删');
  assert.equal(sanitizeRawText('x'.repeat(9000)).length, 8000, '8k 上限不变');
  const {EVIDENCE_TTL_MS} = await import('../src/recruit/feed.mjs');
  assert.equal(EVIDENCE_TTL_MS, 30 * 24 * 3600 * 1000, '证据 30 天 TTL 不变');
});

test('career_feed 证据根限制在用户数据树内：dataDir/../tasks 不能跨出', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zx-feed-escape-'));
  try {
    const userId = 'u-escape';
    const taskId = 't-escape';
    const dataDir = join(root, 'data');
    await mkdir(dataDir, {recursive: true});
    const outside = join(root, 'tasks', taskId, 'evidence');
    await mkdir(outside, {recursive: true});
    await writeFile(join(outside, '02-detail.png'), 'fake-png-bytes');
    const store = RecruitStore.open(join(dataDir, 'recruit.db'));
    try {
      const {createWriteGateway} = await import('../src/writes/gateway.mjs');
      const gateway = createWriteGateway({db: store.db, domain: 'recruit', userId, taskId});
      const row = {
        id: 'b'.repeat(24), sourceId: 'manual', school: '测试大学', kind: '宣讲会',
        title: '越界证据活动', startAt: '2026-12-13T09:00:00+08:00',
        fetchedAt: new Date().toISOString(), confidence: 0.7
      };
      await gateway.write({
        tool: 'career_recruit_bulk_write', sensitivity: 'auto', payload: {escape: true},
        idempotencyKey: 'escape-feed-1', sourceRef: 'artifact:02-detail.png',
        execute: () => {
          store.upsertEvent(row);
          return {changes: [{action: 'create', entity: 'events', entityId: row.id, oldValues: null, newValues: store.getEvent(row.id)}]};
        }
      });
      const feed = await callTool('career_feed', {types: ['event']}, {config: {recruitDir: dataDir, dataDir, userId}});
      const entry = feed.entries.find(item => item.type === 'event');
      assert.equal(entry.record.evidence_ref, 'artifact:02-detail.png', '指针仍保留');
      assert.equal(entry.record.evidence_available, false, 'dataDir/../tasks 不在用户数据树内，不能算可用证据');
    } finally { store.close(); }
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('30 天证据清理：实际删除任务证据，审计与 feed 条目保留且 evidence_available:false', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zx-feed-cleanup-'));
  try {
    const userId = 'u-cleanup';
    const taskId = '11111111-2222-4333-8444-555555555555';
    const dataDir = join(root, 'data');
    const evidenceDir = join(dataDir, 'users', userId, 'tasks', taskId, 'evidence');
    await mkdir(evidenceDir, {recursive: true});
    await writeFile(join(evidenceDir, '02-detail.png'), 'fake-png-bytes');
    const store = RecruitStore.open(join(dataDir, 'recruit.db'));
    try {
      const {createWriteGateway} = await import('../src/writes/gateway.mjs');
      const gateway = createWriteGateway({db: store.db, domain: 'recruit', userId, taskId});
      const row = {
        id: 'c'.repeat(24), sourceId: 'manual', school: '测试大学', kind: '宣讲会',
        title: '待清理证据活动', startAt: '2026-12-14T09:00:00+08:00',
        fetchedAt: new Date().toISOString(), confidence: 0.7
      };
      await gateway.write({
        tool: 'career_recruit_bulk_write', sensitivity: 'auto', payload: {cleanup: true},
        idempotencyKey: 'cleanup-feed-1', sourceRef: 'artifact:02-detail.png',
        execute: () => {
          store.upsertEvent(row);
          return {changes: [{action: 'create', entity: 'events', entityId: row.id, oldValues: null, newValues: store.getEvent(row.id)}]};
        }
      });
      const before = await callTool('career_feed', {}, {config: {recruitDir: dataDir, dataDir, userId}});
      const beforeEntry = before.entries.find(item => item.type === 'event');
      assert.equal(beforeEntry.record.evidence_available, true);

      const {purgeExpiredEvidence} = await import('../src/source-check/evidence-cleanup.mjs');
      const later = Date.now() + 31 * 24 * 3600 * 1000;
      const out = await purgeExpiredEvidence({dataDir, now: later});
      assert.equal(out.removedFiles, 1);
      assert.equal(existsSync(join(evidenceDir, '02-detail.png')), false, '过期证据必须真的删掉');
      assert.equal(store.db.prepare('SELECT COUNT(*) c FROM write_audit').get().c, 1, '审计不能删');
      assert.equal(store.db.prepare('SELECT COUNT(*) c FROM events').get().c, 1, '业务行不能删');

      const after = await callTool('career_feed', {}, {config: {recruitDir: dataDir, dataDir, userId}});
      const afterEntry = after.entries.find(item => item.type === 'event');
      assert.equal(afterEntry.record.evidence_ref, 'artifact:02-detail.png', '指针保留');
      assert.equal(afterEntry.record.evidence_available, false, '清理后 feed 必须标不可用');
      assert.ok(afterEntry.record.operation_id, '条目仍可读');
    } finally { store.close(); }
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('SWUFE 与兜底去重：归一化标题/时间/单位，容忍措辞差异，不写两条记录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zx-dedupe-'));
  try {
    const {bulkWriteRows, normalizeEventTitle, normalizeEventMoment} = await import('../src/recruit/bulk.mjs');
    assert.equal(normalizeEventTitle('西南财经大学 2026 届秋季双选会（邀请函）'), normalizeEventTitle('西南财经大学2026届秋季双选会'));
    assert.equal(normalizeEventMoment('2026-11-05T01:00:00Z'), normalizeEventMoment('2026-11-05T09:00:00+08:00'));
    const store = RecruitStore.open(join(dir, 'recruit.db'));
    try {
      const source = {sourceId: 'swufe-xjh', notes: '来源校对'};
      const base = {title: '西南财经大学2026届秋季双选会', startAt: '2026-11-05T09:00:00+08:00', school: '西南财经大学', city: '成都', kind: '双选会'};
      const first = bulkWriteRows({store, events: [base], projects: [], source});
      assert.equal(first.changes[0].action, 'create');
      const variant = {...base, title: '西南财经大学 2026 届秋季双选会（邀请函）', startAt: '2026-11-05T01:00:00Z'};
      const second = bulkWriteRows({store, events: [variant], projects: [], source});
      assert.equal(second.result.events[0].id, first.result.events[0].id, '同一场活动必须复用 id');
      assert.equal(second.changes[0].action, 'update');
      assert.equal(store.db.prepare('SELECT COUNT(*) c FROM events').get().c, 1);

      // AI 补了单位、确定性源没写：仍视为同一场活动。
      const withUnit = {...base, company: '甲单位'};
      const third = bulkWriteRows({store, events: [withUnit], projects: [], source});
      assert.equal(third.result.events[0].id, first.result.events[0].id, 'AI 补单位不能判成新活动');
      // 双方都有单位且不同，才视为不同活动。
      const otherUnit = {...base, company: '乙单位'};
      bulkWriteRows({store, events: [otherUnit], projects: [], source});
      assert.equal(store.db.prepare('SELECT COUNT(*) c FROM events').get().c, 2, '单位明确不同视为不同活动');
    } finally { store.close(); }
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('工具参数校验拒绝多余字段', async () => {
  const {validateToolArguments} = await import('../src/tools/policy.mjs');
  assert.throws(() => validateToolArguments('career_recruit_events', {days: 30, evil: 1}), /未声明参数/);
  assert.throws(() => validateToolArguments('career_recruit_events', {days: 999}), /不能大于 90/);
  assert.deepEqual(validateToolArguments('career_company_research', {company: ' 某公司 ', city: '成都'}), {company: '某公司', city: '成都'});
});
