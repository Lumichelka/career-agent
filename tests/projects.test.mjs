import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RecruitStore} from '../src/recruit/store.mjs';
import {handleRecruit} from '../src/recruit/api.mjs';

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
