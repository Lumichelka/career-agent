import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {RecruitStore} from '../src/recruit/store.mjs';
import {handleRecruit} from '../src/recruit/api.mjs';
import {callTool} from '../src/tools/execute.mjs';
import {savePlatformJobs, listPlatformJobs} from '../src/recruit/platform-jobs-service.mjs';
import {acceptConfirmation, listConfirmations} from '../src/writes/confirmations.mjs';
import {projectCardMeta} from '../src/web/recruit-cards.js';
import {readFileSync} from 'node:fs';

function baseEvent(id = 'a'.repeat(24)) {
  return {
    id, sourceId: 'manual', school: '测试大学', city: '成都', kind: '双选会',
    title: '测试双选会', company: '', startAt: '2026-11-01T09:00:00+08:00',
    fetchedAt: new Date().toISOString(), confidence: 0.7
  };
}

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'zx-project-'));
  try { return await fn(dir); } finally { await rm(dir, {recursive: true, force: true}); }
}

test('招聘项目：一场活动多个项目、更新与删除', async () => {
  await withDir(async dir => {
    const store = RecruitStore.open(join(dir, 'recruit.db'));
    try {
      store.upsertEvent(baseEvent());
      const p1 = store.upsertProject({eventId: 'a'.repeat(24), company: '甲公司', title: '数据分析', positions: 'SQL', applyMode: '网申'});
      const p2 = store.upsertProject({eventId: 'a'.repeat(24), company: '乙公司', title: '产品经理'});
      assert.equal(store.listProjects('a'.repeat(24)).length, 2);
      const updated = store.upsertProject({...p1, id: p1.id, title: '高级数据分析'});
      assert.equal(updated.title, '高级数据分析');
      const events = store.listEvents({from: '2026-10-01T00:00:00+08:00', to: '2026-12-01T00:00:00+08:00', withProjects: true});
      assert.equal(events.length, 1);
      assert.equal(events[0].projects.length, 2);
      assert.equal(store.stats().projects, 2);
      store.deleteProject(p2.id);
      assert.equal(store.listProjects('a'.repeat(24)).length, 1);
    } finally { store.close(); }
  });
});

test('招聘项目：必须关联活动，单位和项目至少填一项', async () => {
  await withDir(async dir => {
    const store = RecruitStore.open(join(dir, 'recruit.db'));
    try {
      store.upsertEvent(baseEvent());
      assert.throws(() => store.upsertProject({eventId: 'x'.repeat(24), company: '甲'}), /关联活动/);
      assert.throws(() => store.upsertProject({eventId: 'a'.repeat(24)}), /至少填一项/);
    } finally { store.close(); }
  });
});

test('API：日历返回活动与项目，项目可增删', async () => {
  await withDir(async dir => {
    const store = RecruitStore.open(join(dir, 'recruit.db'));
    store.upsertEvent(baseEvent());
    store.close();
    let out = await handleRecruit({method: 'GET', pathname: 'calendar', url: new URL('http://x/api/recruit/calendar?month=2026-11'), dir});
    assert.equal(out.json.days.length, 1);
    assert.equal(out.json.days[0].events.length, 1);
    const eventId = out.json.days[0].events[0].id;
    out = await handleRecruit({method: 'POST', pathname: 'projects', body: {eventId, company: '甲公司', title: '数据分析'}, dir});
    assert.equal(out.json.ok, true);
    out = await handleRecruit({method: 'GET', pathname: 'calendar', url: new URL('http://x/api/recruit/calendar?month=2026-11'), dir});
    assert.equal(out.json.days[0].events[0].projects.length, 1);
    assert.equal(out.json.stats.projects, 1);
    const pid = out.json.days[0].events[0].projects[0].id;
    out = await handleRecruit({method: 'POST', pathname: `projects/${pid}/delete`, body: {}, dir});
    assert.equal(out.json.ok, true);
  });
});

test('API：批量粘贴多个招聘项目', async () => {
  await withDir(async dir => {
    const store = RecruitStore.open(join(dir, 'recruit.db'));
    store.upsertEvent(baseEvent());
    store.close();
    const text = '甲公司 | 数据分析 | SQL/Python | 网申 | https://a.example\n乙公司 | 产品经理 | 沟通\n\n';
    let out = await handleRecruit({method: 'POST', pathname: 'projects/bulk', body: {eventId: 'a'.repeat(24), text}, dir});
    assert.equal(out.json.ok, true);
    assert.equal(out.json.count, 2);
    assert.equal(out.json.projects[0].company, '甲公司');
    assert.equal(out.json.projects[0].applyMode, '网申');
    out = await handleRecruit({method: 'POST', pathname: 'projects/bulk', body: {eventId: 'a'.repeat(24), text: '   '}, dir});
    assert.equal(out.status, 400);
  });
});

test('来源项目同步：幂等、手工保留、连续缺失移除', async () => {
  await withDir(async dir => {
    const store = RecruitStore.open(join(dir, 'recruit.db'));
    try {
      store.upsertEvent(baseEvent());
      const eventId = 'a'.repeat(24);
      let r = store.syncProjects(eventId, 'swpu-jobfair', [
        {company: '甲公司', title: '数据分析', sourceKey: '1'},
        {company: '乙公司', title: '产品经理', sourceKey: '2'}
      ]);
      assert.equal(r.created, 2);
      r = store.syncProjects(eventId, 'swpu-jobfair', [
        {company: '甲公司', title: '数据分析（更新）', sourceKey: '1'},
        {company: '乙公司', title: '产品经理', sourceKey: '2'}
      ]);
      assert.equal(r.updated, 2);
      const manual = store.upsertProject({eventId, company: '手工单位', title: '手工岗位'});
      assert.equal(manual.sourceId, '');
      for (let i = 0; i < 3; i++) store.syncProjects(eventId, 'swpu-jobfair', [{company: '甲公司', title: '数据分析（更新）', sourceKey: '1'}]);
      const projects = store.listProjects(eventId).filter(p => p.status === 'active');
      assert.equal(projects.some(p => p.company === '乙公司'), false);
      assert.equal(projects.some(p => p.id === manual.id), true);
      const events = store.listEvents({from: '2026-10-01T00:00:00+08:00', to: '2026-12-01T00:00:00+08:00', withProjects: true});
      assert.equal(events[0].projects.some(p => p.company === '乙公司'), false);
    } finally { store.close(); }
  });
});

test('Agent 工具：项目列表/详情/来源健康', async () => {
  await withDir(async dir => {
    const store = RecruitStore.open(join(dir, 'recruit.db'));
    store.upsertEvent(baseEvent());
    store.syncProjects('a'.repeat(24), 'swpu-jobfair', [{company: '甲公司', title: '数据分析', sourceKey: '1'}]);
    const project = store.listProjects('a'.repeat(24))[0];
    store.close();
    const ctx = {config: {recruitDir: dir}};
    const list = await callTool('career_recruit_projects', {days: 30}, ctx);
    assert.equal(list.status, 'readable');
    assert.equal(list.projects[0].company, '甲公司');
    const detail = await callTool('career_recruit_project', {id: project.id}, ctx);
    assert.equal(detail.project.title, '数据分析');
    assert.equal(detail.event.id, 'a'.repeat(24));
    const health = await callTool('career_source_health', {}, ctx);
    assert.equal(health.status, 'readable');
    assert.ok(health.count >= 13);
  });
});

// ---- 平台岗位入库（#51） ----
function platformJob(overrides = {}) {
  return {
    company: '甲公司', title: '数据分析师', positions: '薪资 8-12K', requirements: '本科',
    city: '成都', sourceUrl: 'https://www.zhipin.com/job_detail/a.html', sourceKey: 'boss-1',
    confidence: 0.6, notes: '来自平台列表摘要，需点开详情核对；未代投递。',
    rawText: '数据分析师 8-12K 成都', fetchedAt: '2026-10-26T10:00:00.000Z',
    ...overrides
  };
}

test('平台岗位：写入项目表、按岗位/城市/平台筛选、来源可追溯且幂等', async () => {
  await withDir(async dir => {
    const store = RecruitStore.open(join(dir, 'recruit.db'));
    try {
      let saved = store.savePlatformJobs({
        platform: 'boss', city: '成都', query: '数据分析', fetchedAt: '2026-10-26T10:00:00.000Z',
        jobs: [platformJob(), platformJob({company: '乙公司', title: '产品经理', sourceKey: 'boss-2', sourceUrl: 'https://www.zhipin.com/job_detail/b.html'})]
      });
      assert.equal(saved.created, 2);
      assert.equal(saved.updated, 0);

      const all = store.listPlatformJobs();
      assert.equal(all.length, 2);
      const job = all.find(item => item.title === '数据分析师');
      assert.equal(job.eventId, '', '平台岗位不绑定线下活动');
      assert.equal(job.platform, 'boss');
      assert.equal(job.city, '成都');
      assert.equal(job.sourceId, 'platform:boss');
      assert.equal(job.sourceKey, 'boss-1');
      assert.equal(job.sourceUrl, 'https://www.zhipin.com/job_detail/a.html');
      assert.equal(job.confidence, 0.6);
      assert.equal(job.fetchedAt, '2026-10-26T10:00:00.000Z');
      assert.match(job.notes, /未代投递/);

      assert.equal(store.listPlatformJobs({q: '数据'}).length, 1, '按岗位关键词筛选');
      assert.equal(store.listPlatformJobs({q: '产品'}).length, 1);
      assert.equal(store.listPlatformJobs({city: '成都'}).length, 2);
      assert.equal(store.listPlatformJobs({city: '北京'}).length, 0);
      assert.equal(store.listPlatformJobs({platform: 'boss'}).length, 2);
      assert.equal(store.listPlatformJobs({platform: 'liepin'}).length, 0);

      // 同一来源键再次入库：更新而不是重复；没有出现的新岗位不会被删掉。
      saved = store.savePlatformJobs({
        platform: 'boss', city: '成都', fetchedAt: '2026-10-27T10:00:00.000Z',
        jobs: [platformJob({title: '高级数据分析师', positions: '薪资 12-18K', fetchedAt: '2026-10-27T10:00:00.000Z'})]
      });
      assert.equal(saved.updated, 1);
      assert.equal(store.listPlatformJobs().length, 2);
      const updated = store.listPlatformJobs({q: '高级'});
      assert.equal(updated.length, 1);
      assert.equal(updated[0].positions, '薪资 12-18K');
      assert.equal(updated[0].fetchedAt, '2026-10-27T10:00:00.000Z');
      assert.equal(updated[0].firstSeenAt, '2026-10-26T10:00:00.000Z', '首次抓取时间保留');
    } finally { store.close(); }
  });
});

test('平台岗位：不混入线下活动日历，项目统计单独可查', async () => {
  await withDir(async dir => {
    const store = RecruitStore.open(join(dir, 'recruit.db'));
    try {
      store.upsertEvent(baseEvent());
      store.upsertProject({eventId: 'a'.repeat(24), company: '线下公司', title: '线下岗位'});
      store.savePlatformJobs({platform: 'shixiseng', city: '成都', jobs: [platformJob({sourceUrl: 'https://www.shixiseng.com/intern/a'})]});
      const events = store.listEvents({from: '2026-10-01T00:00:00+08:00', to: '2026-12-01T00:00:00+08:00', withProjects: true});
      assert.equal(events.length, 1);
      assert.equal(events[0].projects.length, 1, '日历只显示线下活动下的项目');
      assert.equal(events[0].projects[0].company, '线下公司');
      const stats = store.stats();
      assert.equal(stats.projects, 2);
      assert.equal(stats.platformProjects, 1);
      assert.equal(store.listProjects('a'.repeat(24)).length, 1);
    } finally { store.close(); }
  });
});

test('旧库迁移：event_projects 允许不绑定活动，历史项目不丢', async () => {
  await withDir(async dir => {
    const file = join(dir, 'recruit.db');
    const legacy = new DatabaseSync(file);
    legacy.exec(`CREATE TABLE event_projects(
      id TEXT PRIMARY KEY, event_id TEXT NOT NULL, company TEXT, title TEXT,
      positions TEXT, requirements TEXT, apply_mode TEXT, apply_url TEXT,
      source_url TEXT, notes TEXT, source_id TEXT, source_key TEXT,
      status TEXT DEFAULT 'active', confidence REAL DEFAULT 0.8,
      first_seen_at TEXT, last_seen_at TEXT, missing_runs INTEGER DEFAULT 0,
      raw_text TEXT, created_at TEXT, updated_at TEXT
    )`);
    legacy.exec(`INSERT INTO event_projects(id,event_id,company,title,status,confidence,created_at,updated_at)
      VALUES('old-project','old-event','历史公司','历史岗位','active',0.8,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`);
    legacy.close();

    const store = RecruitStore.open(file);
    try {
      const kept = store.getProject('old-project');
      assert.equal(kept.company, '历史公司');
      const saved = store.savePlatformJobs({platform: 'boss', jobs: [platformJob()]});
      assert.equal(saved.created, 1);
      assert.equal(store.listPlatformJobs().length, 1);
      assert.equal(store.listPlatformJobs()[0].eventId, '');
    } finally { store.close(); }
  });
});

test('平台岗位入库：未确认不落库，任务卡接受后按原参数写入', async () => {
  await withDir(async dir => {
    const snapshot = {
      url: 'https://www.zhipin.com/web/geek/job?query=%E6%95%B0%E6%8D%AE',
      title: '数据分析师招聘-BOSS直聘',
      text: '',
      at: '2026-10-26T10:00:00.000Z',
      links: [{title: '数据分析师\n8-12K\n成都', url: 'https://www.zhipin.com/job_detail/a.html'}]
    };
    const pending = await savePlatformJobs({
      dir, userId: 'user-a', taskId: 'task-1', platform: 'boss', city: '成都',
      snapshot, idempotencyKey: 'platform-1'
    });
    assert.equal(pending.status, 'confirm_required');
    assert.equal(pending.code, 'NEEDS_CONFIRMATION');
    assert.match(pending.confirmId, /^[0-9a-f-]{36}$/);
    assert.equal(pending.preview.jobs[0].title, '数据分析师');
    assert.equal(pending.preview.jobs[0].city, '成都');
    assert.equal(pending.preview.jobs[0].sourceUrl, 'https://www.zhipin.com/job_detail/a.html');
    assert.equal(listPlatformJobs({dir}).jobs.length, 0, '确认前不落库');

    const confirmations = listConfirmations({dir, userId: 'user-a', taskId: 'task-1'});
    assert.equal(confirmations.confirmations.length, 1);
    assert.equal(confirmations.confirmations[0].tool, 'career_platform_jobs_save');

    // 同一个幂等键 + 同一页面快照重放：复用同一条确认，不新建。
    const again = await savePlatformJobs({
      dir, userId: 'user-a', taskId: 'task-1', platform: 'boss', city: '成都',
      snapshot, idempotencyKey: 'platform-1'
    });
    assert.equal(again.status, 'confirm_required');
    assert.equal(again.confirmId, pending.confirmId, '同键同参数应复用确认');
    assert.equal(listConfirmations({dir, userId: 'user-a', taskId: 'task-1'}).confirmations.length, 1);

    const accepted = await acceptConfirmation({dir, userId: 'user-a', confirmId: pending.confirmId});
    assert.equal(accepted.status, 'applied');
    assert.equal(accepted.counts.created, 1);
    const listed = listPlatformJobs({dir, q: '数据分析', city: '成都', platform: 'boss'});
    assert.equal(listed.jobs.length, 1);
    const job = listed.jobs[0];
    assert.equal(job.sourceId, 'platform:boss');
    assert.equal(job.sourceUrl, 'https://www.zhipin.com/job_detail/a.html');
    assert.equal(job.confidence, 0.6);
    assert.equal(job.fetchedAt, '2026-10-26T10:00:00.000Z');
    assert.match(job.notes, /核对/);
    assert.equal(job.applyMode, '');
  });
});

test('平台岗位入库：没读过页面、没有可识别岗位、链接不属于本站都拒绝写入', async () => {
  await withDir(async dir => {
    const notRead = await savePlatformJobs({dir, userId: 'user-a', platform: 'boss', idempotencyKey: 'p-1'});
    assert.equal(notRead.status, 'needs_read');

    const empty = await savePlatformJobs({
      dir, userId: 'user-a', platform: 'boss', idempotencyKey: 'p-2',
      snapshot: {url: 'https://www.zhipin.com/web/geek/job', title: '搜索', text: '', links: [{title: '首页', url: 'https://www.zhipin.com/'}]}
    });
    assert.equal(empty.status, 'empty');

    const foreign = await savePlatformJobs({
      dir, userId: 'user-a', platform: 'boss', idempotencyKey: 'p-3',
      snapshot: {url: 'https://www.zhipin.com/web/geek/job', title: '搜索', text: '', links: [{title: '数据分析师', url: 'https://evil.example.com/job_detail/a.html'}]}
    });
    assert.equal(foreign.status, 'empty');

    assert.equal(listPlatformJobs({dir}).jobs.length, 0);
  });
});

test('招聘项目卡：渲染 requirements 与 notes，缺失岗位/要求标「未公布」', () => {
  const full = projectCardMeta({
    positions: '薪资 7000-8000；招聘 5 人',
    requirements: '学历 本科；专业 会计',
    notes: '来自双选会详情页'
  });
  assert.equal(full.positions, '薪资 7000-8000；招聘 5 人');
  assert.equal(full.requirements, '学历 本科；专业 会计');
  assert.match(full.notes, /来自双选会详情页/);
  assert.equal(full.published, true);
  assert.ok(full.details.some(item => item.label === '要求' && item.value.includes('本科')));

  const empty = projectCardMeta({positions: '', requirements: '', notes: '单位信息：行业：教育'});
  assert.equal(empty.published, false);
  assert.match(empty.notes, /单位信息：行业：教育/);
  assert.match(empty.notes, /岗位未公布/);
  assert.match(empty.notes, /要求未公布/);

  const partial = projectCardMeta({positions: '数据分析', requirements: ''});
  assert.match(partial.notes, /要求未公布/);
  assert.ok(!partial.notes.includes('岗位未公布'));
});

test('数据页引用项目卡 helper，不再只渲染 positions/applyMode/applyUrl', () => {
  const html = readFileSync(new URL('../src/web/recruit.html', import.meta.url), 'utf8');
  assert.match(html, /projectCardMeta/);
  assert.match(html, /requirements/);
});

test('API：平台岗位按岗位/城市筛选，来源字段随行返回', async () => {
  await withDir(async dir => {
    const store = RecruitStore.open(join(dir, 'recruit.db'));
    store.savePlatformJobs({platform: 'boss', city: '成都', jobs: [platformJob()]});
    store.close();
    let out = await handleRecruit({method: 'GET', pathname: 'platform-jobs', url: new URL('http://x/api/recruit/platform-jobs?city=%E6%88%90%E9%83%BD&q=%E6%95%B0%E6%8D%AE'), dir});
    assert.equal(out.json.status, 'readable');
    assert.equal(out.json.count, 1);
    assert.equal(out.json.jobs[0].platform, 'boss');
    assert.equal(out.json.jobs[0].sourceUrl, 'https://www.zhipin.com/job_detail/a.html');
    assert.ok(out.json.platforms.some(item => item.id === 'boss' && item.name === 'BOSS直聘'));
    out = await handleRecruit({method: 'GET', pathname: 'platform-jobs', url: new URL('http://x/api/recruit/platform-jobs?city=%E5%8C%97%E4%BA%AC'), dir});
    assert.equal(out.json.status, 'empty');
    assert.equal(out.json.jobs.length, 0);
  });
});
