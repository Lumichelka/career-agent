import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WeChatStore} from '../src/wechat/store.mjs';
import {RecruitStore} from '../src/recruit/store.mjs';
import {getTool} from '../src/tools/registry.mjs';
import {callTool} from '../src/tools/execute.mjs';
import {startMockOpenAI} from './mock-openai.mjs';
import {runApiModel} from '../src/model/api-model.mjs';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'zx-wechat-articles-'));
  try { return await fn(dir); } finally { await rm(dir, {recursive: true, force: true}); }
}

// 两所学校、三篇文章、一个已关联活动与项目：覆盖账号/学校/关键词筛选与关联读取。
async function seed(dir) {
  const ws = WeChatStore.open(join(dir, 'wechat.db'));
  const rs = RecruitStore.open(join(dir, 'recruit.db'));
  try {
    const sc = ws.addAccount({name: '四川大学就业指导', school: '四川大学'});
    const swufe = ws.addAccount({name: '西南财经大学就业', school: '西南财经大学'});
    const a1 = ws.saveArticle({
      accountId: sc.id, title: '四川大学秋季双选会通知', url: 'https://mp.weixin.qq.com/s/a1',
      publishedAt: '2026-10-20', summary: '四川大学秋季双选会将于11月20日举行', content: '四川大学秋季双选会 2026年11月20日 14:00 体育馆 甲公司 招聘 数据分析'
    });
    ws.saveAnalysis(a1.id, {
      hasRecruitment: 'yes', summary: '四川大学秋季双选会将于11月20日举行',
      draft: {title: '四川大学秋季双选会', startAt: '2026-11-20T14:00', school: '四川大学', kind: '双选会', venue: '体育馆'},
      projects: [{company: '甲公司', title: '数据分析', notes: '需核对'}],
      warnings: []
    });
    const a2 = ws.saveArticle({
      accountId: swufe.id, title: '西南财经大学宣讲会', url: 'https://mp.weixin.qq.com/s/a2',
      publishedAt: '2026-10-18', summary: '西南财经大学专场宣讲会', content: '西南财经大学宣讲会 乙公司 招聘 财务'
    });
    ws.saveAnalysis(a2.id, {
      hasRecruitment: 'yes', summary: '西南财经大学专场宣讲会',
      draft: {title: '西南财经大学宣讲会', startAt: '2026-11-01T19:00', school: '西南财经大学', kind: '宣讲会'},
      projects: [{company: '乙公司', title: '财务'}], warnings: []
    });
    const a3 = ws.saveArticle({
      accountId: sc.id, title: '四川大学招聘信息汇总（非活动）', url: 'https://mp.weixin.qq.com/s/a3',
      publishedAt: '2026-10-10', summary: '招聘信息汇总', content: '仅汇总链接'
    });
    ws.saveAnalysis(a3.id, {hasRecruitment: 'no', summary: '招聘信息汇总', draft: {}, projects: [], warnings: []});

    rs.upsertEvent({
      id: 'wx-e1', sourceId: 'wechat:' + sc.id, school: '四川大学', kind: '双选会',
      title: '四川大学秋季双选会', startAt: '2026-11-20T14:00:00+08:00', venue: '体育馆',
      sourceUrl: a1.url, fetchedAt: new Date().toISOString(), status: 'active'
    });
    rs.upsertProject({eventId: 'wx-e1', sourceId: 'wechat:' + sc.id, sourceKey: 'p1', company: '甲公司', title: '数据分析', positions: '3人', requirements: '本科，统计/计算机相关', notes: '需核对'});
    ws.linkEvent(a1.id, 'wx-e1');
    return {sc, swufe, a1, a2, a3};
  } finally { ws.close(); rs.close(); }
}

test('公众号文章工具：注册为只读，声明账号/学校/关键词筛选', () => {
  const tool = getTool('career_wechat_articles');
  assert.ok(tool, '工具应已注册');
  assert.equal(tool.permission, 'read');
  assert.equal(tool.handler, 'wechat.articles');
  assert.ok(tool.title);
  assert.ok(tool.description);
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['account', 'hasRecruitment', 'limit', 'q', 'school']);
});

test('公众号文章工具：按账号/学校/关键词筛选，返回草稿、关联活动与来源链接', async () => {
  await withDir(async dir => {
    await seed(dir);
    let out = await callTool('career_wechat_articles', {account: '四川大学'}, {config: {dataDir: dir}});
    assert.equal(out.status, 'readable');
    assert.equal(out.count, 2);
    assert.ok(out.articles.every(a => a.account.name === '四川大学就业指导'));

    out = await callTool('career_wechat_articles', {school: '西南财经大学'}, {config: {dataDir: dir}});
    assert.equal(out.count, 1);
    assert.equal(out.articles[0].title, '西南财经大学宣讲会');

    out = await callTool('career_wechat_articles', {q: '双选会'}, {config: {dataDir: dir}});
    assert.equal(out.count, 1);
    assert.equal(out.articles[0].title, '四川大学秋季双选会通知');

    out = await callTool('career_wechat_articles', {account: '四川大学', q: '汇总'}, {config: {dataDir: dir}});
    assert.equal(out.count, 1);
    assert.equal(out.articles[0].hasRecruitment, 'no');

    out = await callTool('career_wechat_articles', {hasRecruitment: 'yes', limit: 1}, {config: {dataDir: dir}});
    assert.equal(out.count, 2, 'count 是命中总数，不是本页条数');
    assert.equal(out.articles.length, 1);

    // 非整数 limit 取整，不能把小数绑给 SQLite 的 LIMIT 而报错。
    out = await callTool('career_wechat_articles', {limit: 1.5}, {config: {dataDir: dir}});
    assert.equal(out.articles.length, 1);
  });
});

test('公众号文章工具：单篇返回分析摘要、抽取草稿、关联活动/项目与来源', async () => {
  await withDir(async dir => {
    await seed(dir);
    const out = await callTool('career_wechat_articles', {q: '秋季双选会'}, {config: {dataDir: dir}});
    const article = out.articles[0];
    assert.equal(article.url, 'https://mp.weixin.qq.com/s/a1');
    assert.equal(article.publishedAt, '2026-10-20');
    assert.equal(article.hasRecruitment, 'yes');
    assert.match(article.summary, /11月20日/);
    assert.equal(article.draft.startAt, '2026-11-20T14:00');
    assert.equal(article.draft.venue, '体育馆');
    assert.equal(article.draftProjects[0].company, '甲公司');
    assert.equal(article.draftProjects[0].notes, '需核对');
    assert.equal(article.analyzed, true);
    assert.equal(article.event.id, 'wx-e1');
    assert.equal(article.event.title, '四川大学秋季双选会');
    assert.equal(article.eventProjects[0].company, '甲公司');
    assert.equal(article.eventProjects[0].positions, '3人');
    assert.equal(article.eventProjects[0].requirements, '本科，统计/计算机相关');
    assert.equal(article.eventProjects[0].notes, '需核对');
    assert.equal(article.source.id, 'wechat:' + article.account.id);
    assert.equal(article.source.articleUrl, article.url);
  });
});

test('公众号文章工具：只读，不抓取、不写库、不投递', async () => {
  await withDir(async dir => {
    const {a1, sc} = await seed(dir);
    // 快照用只读连接，避免正常打开时的 seed 自己改 updated_at 干扰断言。
    const wsBefore = WeChatStore.open(join(dir, 'wechat.db'), {readOnly: true});
    const analyzedBefore = wsBefore.getArticle(a1.id).analyzedAt;
    const statsBefore = wsBefore.stats();
    const accountBefore = wsBefore.db.prepare('SELECT updated_at FROM wechat_accounts WHERE id=?').get(sc.id).updated_at;
    wsBefore.close();
    const rsBefore = RecruitStore.open(join(dir, 'recruit.db'), {readOnly: true});
    const countsBefore = {events: rsBefore.stats().total, projects: rsBefore.stats().projects};
    rsBefore.close();

    await callTool('career_wechat_articles', {}, {config: {dataDir: dir}});

    const wsAfter = WeChatStore.open(join(dir, 'wechat.db'), {readOnly: true});
    try {
      assert.deepEqual(wsAfter.stats(), statsBefore);
      assert.equal(wsAfter.getArticle(a1.id).analyzedAt, analyzedBefore);
      const accountAfter = wsAfter.db.prepare('SELECT updated_at FROM wechat_accounts WHERE id=?').get(sc.id).updated_at;
      assert.equal(accountAfter, accountBefore, '只读查询不能改账号 updated_at');
    } finally { wsAfter.close(); }
    const rsAfter = RecruitStore.open(join(dir, 'recruit.db'), {readOnly: true});
    try {
      assert.equal(rsAfter.stats().total, countsBefore.events);
      assert.equal(rsAfter.stats().projects, countsBefore.projects);
    } finally { rsAfter.close(); }
  });
});

test('公众号文章工具：没有数据目录时判为不可用，没有命中时为空', async () => {
  await withDir(async dir => {
    const missing = await callTool('career_wechat_articles', {}, {config: {}});
    assert.equal(missing.status, 'unavailable');
    assert.deepEqual(missing.articles, []);

    await seed(dir);
    const empty = await callTool('career_wechat_articles', {q: '不存在的关键词'}, {config: {dataDir: dir}});
    assert.equal(empty.status, 'empty');
    assert.equal(empty.count, 0);
    assert.deepEqual(empty.articles, []);
  });
});

test('公众号文章工具：没有文章库时返回空，不创建数据库', async () => {
  await withDir(async dir => {
    const out = await callTool('career_wechat_articles', {}, {config: {dataDir: dir}});
    assert.equal(out.status, 'empty');
    assert.equal(out.count, 0);
    assert.deepEqual(await readdir(dir), [], '目录里不应出现新建的 wechat.db');
  });
});

test('公众号文章链路：模型经工具清单调用只读工具后才回答', async () => {
  const mock = await startMockOpenAI();
  try {
    const config = {protocol: 'chat', baseUrl: mock.url, model: 'mock-model', stream: true, maxTokens: 2048};
    let called = '';
    const out = await runApiModel({
      root,
      prompt: '查公众号文章里关于双选会的招聘信息，只读，不要写库。',
      search: true,
      config,
      toolCaller: async name => {
        called = name;
        return {
          status: 'readable',
          count: 1,
          articles: [{title: '某公司双选会', url: 'https://mp.weixin.qq.com/s/x', account: {name: '就业中心'}, hasRecruitment: 'yes'}]
        };
      }
    });
    assert.equal(called, 'career_wechat_articles');
    assert.ok(out.trace.some(t => t.label === 'career_wechat_articles'), 'trace 应记录工具调用');
    assert.match(out.toolEvidence.join('\n'), /某公司双选会/);
    assert.ok(JSON.parse(out.raw).reply);
  } finally { await mock.close(); }
});

test('公众号文章工具：有文章库但没有招聘库时不创建招聘库', async () => {
  await withDir(async dir => {
    const ws = WeChatStore.open(join(dir, 'wechat.db'));
    try {
      const account = ws.addAccount({name: '某校就业中心', school: '某校'});
      const article = ws.saveArticle({
        accountId: account.id, title: '某校双选会', url: 'https://mp.weixin.qq.com/s/no-recruit',
        summary: '双选会', content: '某校双选会 甲公司 招聘'
      });
      ws.linkEvent(article.id, 'not-in-recruit-db');
    } finally { ws.close(); }

    const out = await callTool('career_wechat_articles', {}, {config: {dataDir: dir}});
    assert.equal(out.status, 'readable');
    assert.equal(out.articles[0].event, null);
    assert.equal(existsSync(join(dir, 'recruit.db')), false, '只读查询不能创建 recruit.db');
  });
});
