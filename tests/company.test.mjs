import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CompanyStore} from '../src/company/store.mjs';
import {handleCompany} from '../src/company/api.mjs';
import {RecruitStore} from '../src/recruit/store.mjs';
import {ResumeStore} from '../src/resume/store.mjs';
import {callTool} from '../src/tools/execute.mjs';
import {searchCompanySources, buildCompanyProfile, generateCompanyProfiles} from '../src/company/research.mjs';

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
test('公司调研：从活动/项目统计高频单位，跳过取消与空名', async () => {
  await withDir(async dir => {
    const recruit = RecruitStore.open(join(dir, 'recruit.db'));
    try {
      const at = new Date().toISOString();
      const ev = (id, company, status) => recruit.upsertEvent({id, sourceId: 'manual', title: 'x', company, startAt: '2026-11-01T09:00:00+08:00', fetchedAt: at, status});
      ev('a'.repeat(24), '甲公司', 'active');
      ev('b'.repeat(24), '乙公司', 'active');
      ev('c'.repeat(24), '甲公司', 'active');
      ev('d'.repeat(24), '丙公司', 'cancelled');
      ev('e'.repeat(24), '  ', 'active');
      recruit.upsertProject({eventId: 'a'.repeat(24), company: '甲公司', title: '甲岗'});
      recruit.upsertProject({eventId: 'b'.repeat(24), company: '丁公司', title: '丁岗'});
      recruit.upsertProject({eventId: 'c'.repeat(24), company: '丁公司', title: '丁岗2'});
      assert.deepEqual(recruit.unitNameCounts(), [
        {name: '甲公司', count: 3},
        {name: '丁公司', count: 2},
        {name: '乙公司', count: 1}
      ]);
      assert.deepEqual(recruit.unitNameCounts({limit: 1}), [{name: '甲公司', count: 3}]);
    } finally { recruit.close(); }
  });
});

test('公司调研：档案正文逐条带来源 URL，不编造字段', () => {
  const sources = [
    {title: '甲官网', url: 'https://a.example.com/about', snippet: '甲是一家银行'},
    {title: '甲招聘页', url: 'https://a.example.com/jobs', snippet: '甲开放校招'}
  ];
  const p = buildCompanyProfile('甲公司', sources);
  assert.equal(p.name, '甲公司');
  assert.match(p.summary, /甲是一家银行/);
  assert.match(p.summary, /https:\/\/a\.example\.com\/about/);
  assert.match(p.summary, /https:\/\/a\.example\.com\/jobs/);
  assert.deepEqual(p.sources, [
    {title: '甲官网', url: 'https://a.example.com/about'},
    {title: '甲招聘页', url: 'https://a.example.com/jobs'}
  ]);
  assert.equal(p.industry, undefined, '不编造行业');
  assert.equal(p.size, undefined, '不编造规模');
  assert.equal(buildCompanyProfile('乙公司', []).summary, '');
});

test('公司调研：搜索去重、过滤非公开链接，HTTP 错误抛异常', async () => {
  const fetchImpl = async u => ({ok: true, json: async () => ({results: [
    {title: 'A', url: 'https://example.com/a', content: 'snippet A'},
    {title: 'B', url: 'https://example.com/a', content: 'dup'},
    {title: 'C', url: 'javascript:alert(1)', content: 'bad'},
    {title: 'D', url: 'https://example.com/b', content: 'snippet B'}
  ]})});
  const sources = await searchCompanySources({company: '甲公司', searchUrl: 'https://search.example.com/search', fetchImpl});
  assert.deepEqual(sources.map(s => s.url), ['https://example.com/a', 'https://example.com/b']);
  assert.deepEqual(sources.map(s => s.title), ['A', 'D']);
  const bad = async () => ({ok: false, status: 500});
  await assert.rejects(() => searchCompanySources({company: '甲公司', searchUrl: 'https://s.example.com', fetchImpl: bad}), /HTTP 500/);
});

test('公司调研：未配置搜索服务时给出可诊断提示且不写库', async () => {
  await withDir(async dir => {
    const recruit = RecruitStore.open(join(dir, 'recruit.db'));
    recruit.upsertEvent({id: 'a'.repeat(24), sourceId: 'manual', title: '甲宣讲', company: '甲公司', startAt: '2026-11-01T09:00:00+08:00', fetchedAt: new Date().toISOString()});
    recruit.close();
    const out = await generateCompanyProfiles({dataDir: dir, searchUrl: ''});
    assert.equal(out.status, 'unavailable');
    assert.match(out.message, /搜索/);
    assert.match(out.message, /配置/);
    assert.equal(out.generated, 0);
    const store = CompanyStore.open(join(dir, 'company.db'));
    assert.equal(store.stats().companies, 0);
    store.close();
  });
});

test('公司调研：招聘库无单位名时返回 empty', async () => {
  await withDir(async dir => {
    const out = await generateCompanyProfiles({dataDir: dir, searchUrl: 'https://search.example.com/search', fetchImpl: async () => ({ok: true, json: async () => ({results: []})})});
    assert.equal(out.status, 'empty');
    assert.match(out.message, /单位名|采集/);
  });
});

test('公司调研：批量生成公司档案，每条带来源 URL，重跑跳过已有', async () => {
  await withDir(async dir => {
    const recruit = RecruitStore.open(join(dir, 'recruit.db'));
    recruit.upsertEvent({id: 'a'.repeat(24), sourceId: 'manual', title: '甲宣讲', company: '甲公司', startAt: '2026-11-01T09:00:00+08:00', fetchedAt: new Date().toISOString()});
    recruit.upsertEvent({id: 'b'.repeat(24), sourceId: 'manual', title: '乙宣讲', company: '乙公司', startAt: '2026-11-01T09:00:00+08:00', fetchedAt: new Date().toISOString()});
    recruit.close();

    let calls = 0;
    const fetchImpl = async u => {
      calls++;
      const c = String(u.searchParams.get('q') || '').slice(0, 1);
      return {ok: true, json: async () => ({results: [{title: c + '官网', url: 'https://example.com/' + encodeURIComponent(c), content: c + '是一家用人单位'}]})};
    };

    const out = await generateCompanyProfiles({dataDir: dir, searchUrl: 'https://search.example.com/search', fetchImpl, limit: 2});
    assert.equal(out.status, 'readable');
    assert.equal(out.generated, 2);
    assert.equal(out.skipped, 0);

    const store = CompanyStore.open(join(dir, 'company.db'));
    const list = store.list();
    assert.equal(list.length, 2);
    for (const c of list) {
      assert.ok(c.sources.length >= 1);
      assert.ok(c.sources.every(s => s.url.startsWith('https://')));
      assert.match(c.summary, /https:\/\//);
    }
    store.close();
    const firstCalls = calls;

    // 重跑：两家已有档案，全部跳过，不再联网
    const again = await generateCompanyProfiles({dataDir: dir, searchUrl: 'https://search.example.com/search', fetchImpl, limit: 2});
    assert.equal(again.generated, 0);
    assert.equal(again.skipped, 2);
    assert.equal(calls, firstCalls, '已有档案的公司重跑不应再联网');
  });
});

test('公司调研：单家搜索失败不中断整批，跳过并继续', async () => {
  await withDir(async dir => {
    const recruit = RecruitStore.open(join(dir, 'recruit.db'));
    recruit.upsertEvent({id: 'a'.repeat(24), sourceId: 'manual', title: '甲宣讲', company: '甲公司', startAt: '2026-11-01T09:00:00+08:00', fetchedAt: new Date().toISOString()});
    recruit.upsertEvent({id: 'b'.repeat(24), sourceId: 'manual', title: '乙宣讲', company: '乙公司', startAt: '2026-11-01T09:00:00+08:00', fetchedAt: new Date().toISOString()});
    recruit.close();

    const fetchImpl = async u => {
      const c = String(u.searchParams.get('q') || '').slice(0, 1);
      if (c === '甲') return {ok: false, status: 503};
      return {ok: true, json: async () => ({results: [{title: c + '官网', url: 'https://example.com/' + encodeURIComponent(c), content: '简介'}]})};
    };

    const out = await generateCompanyProfiles({dataDir: dir, searchUrl: 'https://search.example.com/search', fetchImpl, limit: 2});
    assert.equal(out.status, 'readable');
    assert.equal(out.generated, 1);
    assert.equal(out.skipped, 1);
    const store = CompanyStore.open(join(dir, 'company.db'));
    assert.deepEqual(store.list().map(c => c.name), ['乙公司']);
    store.close();
  });
});
const COMPANY_FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/company-sources.json', import.meta.url), 'utf8'));

test('公司调研：20 条 fixture 单位批量生成，每条带来源且不编造字段', async () => {
  await withDir(async dir => {
    assert.equal(COMPANY_FIXTURE.companies.length, 20);
    const recruit = RecruitStore.open(join(dir, 'recruit.db'));
    try {
      COMPANY_FIXTURE.companies.forEach((item, index) => {
        recruit.upsertEvent({
          id: String(index + 1).padStart(24, '0'), sourceId: 'manual', school: '测试大学', city: '成都', kind: '双选会',
          title: item.name + '宣讲会', company: item.name, startAt: '2026-11-01T09:00:00+08:00', fetchedAt: new Date().toISOString()
        });
      });
    } finally { recruit.close(); }

    const fetchImpl = async u => {
      const q = String(u.searchParams.get('q') || '');
      const hit = COMPANY_FIXTURE.companies.find(c => q.includes(c.name));
      return {ok: true, json: async () => ({results: hit ? [{title: hit.title, url: hit.url, content: hit.snippet}] : []})};
    };
    const out = await generateCompanyProfiles({dataDir: dir, searchUrl: 'https://search.example.com/search', fetchImpl, limit: 20});
    assert.equal(out.status, 'readable');
    assert.equal(out.generated, 20);
    assert.equal(out.skipped, 0);
    const store = CompanyStore.open(join(dir, 'company.db'));
    try {
      const list = store.list();
      assert.equal(list.length, 20);
      for (const company of list) {
        assert.ok(company.sources.length >= 1, company.name + ' 必须有来源');
        assert.ok(company.sources.every(s => s.url.startsWith('https://companies.example.com/')));
        assert.match(company.summary, /https:\/\/companies\.example\.com\//);
        assert.equal(company.industry, '', '不编造行业');
        assert.equal(company.size, '', '不编造规模');
        assert.match(company.notes, /未做归纳推断/);
      }
    } finally { store.close(); }
  });
});

test('API：未配置搜索服务时批量生成返回可诊断的 unavailable，且不写库', async () => {
  await withDir(async dir => {
    const recruit = RecruitStore.open(join(dir, 'recruit.db'));
    recruit.upsertEvent({id: 'a'.repeat(24), sourceId: 'manual', title: '甲宣讲', company: '甲公司', startAt: '2026-11-01T09:00:00+08:00', fetchedAt: new Date().toISOString()});
    recruit.close();
    const out = await handleCompany({method: 'POST', pathname: 'companies/generate', body: {limit: 5}, dir, searchUrl: ''});
    assert.equal(out.json.status, 'unavailable');
    assert.match(out.json.message, /未配置/);
    assert.match(out.json.message, /搜索/);
    const store = CompanyStore.open(join(dir, 'company.db'));
    try { assert.equal(store.stats().companies, 0); } finally { store.close(); }
  });
});

test('数据页：公司档案批量生成入口存在，并提示未配置搜索服务', () => {
  const html = readFileSync(new URL('../src/web/recruit.html', import.meta.url), 'utf8');
  assert.match(html, /\/api\/companies\/companies\/generate/);
  assert.match(html, /批量生成公司档案/);
  assert.match(html, /未配置/);
});

test('API：批量生成公司档案端点', async () => {
  await withDir(async dir => {
    const recruit = RecruitStore.open(join(dir, 'recruit.db'));
    recruit.upsertEvent({id: 'a'.repeat(24), sourceId: 'manual', title: '甲宣讲', company: '甲公司', startAt: '2026-11-01T09:00:00+08:00', fetchedAt: new Date().toISOString()});
    recruit.close();
    const fetchImpl = async () => ({ok: true, json: async () => ({results: [{title: '甲官网', url: 'https://example.com/甲', content: '甲是一家用人单位'}]})});
    const out = await handleCompany({method: 'POST', pathname: 'companies/generate', body: {limit: 5}, dir, searchUrl: 'https://search.example.com/search', fetchImpl});
    assert.equal(out.json.status, 'readable');
    assert.equal(out.json.generated, 1);
    assert.ok(out.json.companies[0].sources.length >= 1);
  });
});


