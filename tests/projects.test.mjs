import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RecruitStore} from '../src/recruit/store.mjs';
import {handleRecruit} from '../src/recruit/api.mjs';
import {callTool} from '../src/tools/execute.mjs';

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
