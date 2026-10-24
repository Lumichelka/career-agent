import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CompanyStore} from '../src/company/store.mjs';
import {handleCompany} from '../src/company/api.mjs';
import {RecruitStore} from '../src/recruit/store.mjs';
import {ResumeStore} from '../src/resume/store.mjs';
import {callTool} from '../src/tools/execute.mjs';

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'zx-company-'));
  try { return await fn(dir); } finally { await rm(dir, {recursive: true, force: true}); }
}

test('公司档案：创建、按名称合并、来源、删除', async () => {
  await withDir(async dir => {
    const store = CompanyStore.open(join(dir, 'company.db'));
    try {
      const c = store.save({name: '某银行', industry: '金融', city: '成都', summary: '介绍', sources: [{title: '官网', url: 'https://example.com'}]});
      assert.equal(c.name, '某银行');
      assert.equal(c.sources.length, 1);
      const merged = store.save({name: '某银行', prospects: '前景', reputation: '评价'});
      assert.equal(merged.id, c.id);
      assert.equal(merged.summary, '介绍');
      assert.equal(merged.prospects, '前景');
      assert.equal(store.stats().companies, 1);
      assert.throws(() => store.save({name: ''}), /公司名称/);
      store.delete(c.id);
      assert.equal(store.list().length, 0);
    } finally { store.close(); }
  });
});

test('API：从对话保存公司档案', async () => {
  await withDir(async dir => {
    const sessionId = '12345678-1234-1234-1234-123456789abc';
    await writeFile(join(dir, sessionId + '.json'), JSON.stringify({
      id: sessionId, artifacts: [{title: '公司调研-某集团', content: '行业：制造\n前景：稳定'}]
    }), 'utf8');
    const out = await handleCompany({method: 'POST', pathname: 'companies/from-session', body: {sessionId}, dir});
    assert.equal(out.json.company.name, '某集团');
    assert.match(out.json.company.summary, /行业/);
    const list = await handleCompany({method: 'GET', pathname: 'companies', dir});
    assert.equal(list.json.companies.length, 1);
  });
});

test('API：详情关联招聘活动与投递', async () => {
  await withDir(async dir => {
    const company = new CompanyStore(join(dir, 'company.db'));
    const saved = company.save({name: '某银行', summary: '介绍'});
    company.close();
    const recruit = new RecruitStore(join(dir, 'recruit.db'));
    recruit.upsertEvent({
      id: 'a'.repeat(24), sourceId: 'manual', school: '测试大学', city: '成都', kind: '宣讲会',
      title: '某银行宣讲会', company: '某银行', startAt: '2026-11-01T09:00:00+08:00',
      fetchedAt: new Date().toISOString(), confidence: 0.7
    });
    recruit.close();
    const resume = new ResumeStore(join(dir, 'resume.db'));
    resume.saveApplication({company: '某银行', role: '数据分析', stage: '已投递'});
    resume.close();

    const out = await handleCompany({method: 'GET', pathname: 'companies/' + saved.id, dir});
    assert.equal(out.json.company.name, '某银行');
    assert.equal(out.json.events.length, 1);
    assert.equal(out.json.applications.length, 1);
  });
});

test('工具：company_list / company_read', async () => {
  await withDir(async dir => {
    let out = await callTool('company_list', {}, {config: {dataDir: dir}});
    assert.equal(out.status, 'readable');
    assert.equal(out.companies.length, 0);
    const saved = await handleCompany({method: 'POST', pathname: 'companies', body: {name: '某集团', summary: '集团介绍'}, dir});
    out = await callTool('company_list', {}, {config: {dataDir: dir}});
    assert.equal(out.companies[0].name, '某集团');
    out = await callTool('company_read', {name: '某集团'}, {config: {dataDir: dir}});
    assert.equal(out.status, 'readable');
    assert.match(out.company.summary, /集团介绍/);
    assert.equal(saved.json.company.id, out.company.id);
  });
});
