import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readdir, writeFile, readFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {WeChatStore} from '../src/wechat/store.mjs';
import {handleWechat, bizOf} from '../src/wechat/api.mjs';
import {analyzeArticle} from '../src/wechat/analyze.mjs';
import {handleRecruit} from '../src/recruit/api.mjs';
import {RecruitStore} from '../src/recruit/store.mjs';
import {publishArticle} from '../src/wechat/publish.mjs';
import {readFeed} from '../src/recruit/feed.mjs';
import {feed as careerFeed} from '../src/tools/handlers/recruit.mjs';
import {undoTask} from '../src/writes/undo.mjs';
import {
  OperatorError, OPERATOR_LAUNCH_OPTIONS
} from '../src/source-check/operator.mjs';
import {
  WECHAT_OPERATOR_TOOL, WECHAT_ARTICLE_LIMIT, WECHAT_SUMMARY_EVIDENCE,
  pickWechatOperatorAccount, normalizeWechatOperatorArticles, wechatProfileUrl,
  runWechatOperator
} from '../src/wechat/operator.mjs';

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'zx-wechat-'));
  try { return await fn(dir); } finally { await rm(dir, {recursive: true, force: true}); }
}

test('公众号：种子账号、添加/去重、文章记录与统计', async () => {
  await withDir(async dir => {
    const store = WeChatStore.open(join(dir, 'wechat.db'));
    try {
      assert.equal(store.listAccounts().length, 9);
      const a = store.addAccount({name: '测试就业', school: '测试大学'});
      assert.equal(store.addAccount({name: '测试就业'}).id, a.id);
      const article = store.saveArticle({accountId: a.id, title: '双选会通知', url: 'https://mp.weixin.qq.com/s/demo', summary: '摘要', content: '正文'});
      assert.equal(store.listArticles().length, 1);
      assert.equal(article.title, '双选会通知');
      assert.equal(store.stats().articles, 1);
      store.deleteArticle(article.id);
      assert.equal(store.listArticles().length, 0);
    } finally { store.close(); }
  });
});

test('公众号：从链接识别 biz', () => {
  assert.equal(bizOf('https://mp.weixin.qq.com/s?__biz=MzA4ODgzNjg2NQ==&mid=1'), 'MzA4ODgzNjg2NQ==');
  assert.equal(bizOf('https://example.com'), '');
  assert.equal(bizOf('bad'), '');
});

test('API：公众号账号列表与新增', async () => {
  await withDir(async dir => {
    let out = await handleWechat({method: 'GET', pathname: 'accounts', dir});
    assert.equal(out.json.accounts.length, 9);
    out = await handleWechat({method: 'POST', pathname: 'accounts', body: {name: '新增公众号', school: '某大学'}, dir});
    assert.equal(out.json.account.name, '新增公众号');
    out = await handleWechat({method: 'GET', pathname: 'accounts', dir});
    assert.equal(out.json.accounts.length, 10);
    assert.equal(out.json.stats.accounts, 10);
  });
});

test('公众号文章：识别招聘信息并抽取单位草稿，但不自动入库', () => {
  const analysis = analyzeArticle({
    title: '秋季双选会通知',
    text: '四川大学秋季双选会将于2026年11月20日14:00在体育馆举行。\n浙江吉利控股集团有限公司 招聘 数据分析\n宇树科技股份有限公司 招聘 算法工程师',
    url: 'https://mp.weixin.qq.com/s/demo'
  });
  assert.equal(analysis.hasRecruitment, 'yes');
  assert.ok(analysis.projects.length >= 2);
  assert.match(analysis.draft.startAt, /2026-11-20/);
});

test('API：公众号账号并入招聘来源视图', async () => {
  await withDir(async dir => {
    const ws = WeChatStore.open(join(dir, 'wechat.db'));
    ws.close();
    const out = await handleRecruit({method: 'GET', pathname: 'sources', dir});
    assert.equal(out.json.wechat.accounts.length, 9);
    assert.equal(out.json.wechat.accounts[0].sourceType, 'wechat');
    assert.match(out.json.wechat.accounts[0].sourceId, /^wechat:/);
  });
});

test('API：文章分析写回分类与草稿', async () => {
  await withDir(async dir => {
    const store = WeChatStore.open(join(dir, 'wechat.db'));
    const account = store.listAccounts()[0];
    const article = store.saveArticle({accountId: account.id, title: '双选会通知', url: 'https://mp.weixin.qq.com/s/analyze-demo', summary: '正文', content: '四川大学双选会 2026年11月20日 14:00 体育馆\n甲公司 招聘 数据分析'});
    store.close();
    const out = await handleWechat({method: 'POST', pathname: `articles/${article.id}/analyze`, body: {}, dir});
    assert.equal(out.json.analysis.hasRecruitment, 'yes');
    assert.equal(out.json.article.hasRecruitment, 'yes');
    assert.ok(out.json.analysis.projects.length >= 1);
  });
});

test('公众号：文章链接归一化去重（协议/追踪参数/hash）', async () => {
  await withDir(async dir => {
    const store = WeChatStore.open(join(dir, 'wechat.db'));
    try {
      const account = store.listAccounts()[0];
      const first = store.saveArticle({
        accountId: account.id, title: '双选会通知',
        url: 'https://mp.weixin.qq.com/s?__biz=MzA4ODgzNjg2NQ==&mid=2650347880&idx=1&sn=abc&chksm=deadbeef&scene=21#rd',
        content: '四川大学秋季双选会 2026年11月20日 14:00 体育馆'
      });
      const second = store.saveArticle({
        accountId: account.id, title: '双选会通知',
        url: 'http://mp.weixin.qq.com/s?__biz=MzA4ODgzNjg2NQ==&mid=2650347880&sn=abc&idx=1&from=timeline&isappinstalled=0',
        content: '四川大学秋季双选会 2026年11月20日 14:00 体育馆'
      });
      assert.equal(second.id, first.id);
      assert.equal(store.listArticles().length, 1);
      assert.equal(first.url, 'https://mp.weixin.qq.com/s?__biz=MzA4ODgzNjg2NQ%3D%3D&mid=2650347880&idx=1&sn=abc');
    } finally { store.close(); }
  });
});

test('公众号：按 biz 别名与正文昵称自动归属', async () => {
  await withDir(async dir => {
    const store = WeChatStore.open(join(dir, 'wechat.db'));
    try {
      const accounts = store.listAccounts();
      const xicai = accounts.find(a => a.name === '西财校招');
      const zhongda = accounts.find(a => a.name === '中山大学就业');
      const quarantine = store.addAccount({name: '未归类公众号', note: '临时'});
      const byBiz = store.saveArticle({
        accountId: quarantine.id, title: '关于“西财就业”与“西财校招”公众号合并的通知',
        url: 'https://mp.weixin.qq.com/s?__biz=MzA4ODgzNjg2NQ==&mid=2650347880&idx=1&sn=biz',
        content: '公开搜索结果：公众号合并通知。'
      });
      assert.equal(store.getArticle(byBiz.id).accountId, xicai.id);
      const byNickname = store.saveArticle({
        accountId: quarantine.id, title: '双选会邀请函',
        url: 'https://mp.weixin.qq.com/s?__biz=UnknownBiz&mid=1&idx=1&sn=nick',
        content: '中山大学就业\n中山大学2027届毕业生推介手册&校园招聘活动邀请函'
      });
      assert.equal(store.getArticle(byNickname.id).accountId, zhongda.id);
      assert.ok(!store.listAccounts().some(a => a.name === '未归类公众号'));
      assert.equal(store.getAccount(zhongda.id).biz, 'UnknownBiz');
    } finally { store.close(); }
    const reopened = WeChatStore.open(join(dir, 'wechat.db'));
    try {
      assert.equal(reopened.getAccount(reopened.listAccounts().find(a => a.name === '中山大学就业').id).biz, 'UnknownBiz');
    } finally { reopened.close(); }
  });
});

test('公众号：清理 example.com 演示数据，保留真实文章', async () => {
  await withDir(async dir => {
    const file = join(dir, 'wechat.db');
    let store = WeChatStore.open(file);
    const account = store.listAccounts()[3];
    store.saveArticle({accountId: account.id, title: '演示双选会', url: 'https://example.com/wechat-demo2', content: '演示正文'});
    store.saveArticle({accountId: account.id, title: '真实双选会', url: 'https://mp.weixin.qq.com/s?__biz=RealBiz&mid=2&idx=1&sn=real', content: '真实正文'});
    store.close();
    store = WeChatStore.open(file);
    try {
      const articles = store.listArticles();
      assert.equal(articles.length, 1);
      assert.equal(articles[0].title, '真实双选会');
      assert.equal(store.stats().demoArticles, 0);
    } finally { store.close(); }
  });
});

test('公众号：真实招聘文章产出带来源的活动与项目，重复发布不重复', async () => {
  await withDir(async dir => {
    const store = WeChatStore.open(join(dir, 'wechat.db'));
    const account = store.listAccounts().find(a => a.name === '四川大学就业指导中心');
    const body = '四川大学秋季双选会将于2026年11月20日14:00在体育馆举行。\n浙江吉利控股集团有限公司 招聘 数据分析\n宇树科技股份有限公司 招聘 算法工程师';
    const article = store.saveArticle({
      accountId: account.id, title: '四川大学秋季双选会通知',
      url: 'https://mp.weixin.qq.com/s?__biz=ScuJobs&mid=1&idx=1&sn=publish',
      content: body
    });
    store.close();

    const first = await publishArticle({dir, articleId: article.id});
    assert.equal(first.ok, true);
    assert.match(first.event.sourceId, /^wechat:/);
    assert.equal(first.event.sourceUrl, article.url);
    assert.equal(first.event.startAt, '2026-11-20T14:00:00+08:00');
    assert.ok(first.projects.length >= 2);
    assert.ok(first.projects.every(p => p.sourceId === first.event.sourceId));

    const again = await publishArticle({dir, articleId: article.id});
    assert.equal(again.event.id, first.event.id);
    assert.equal(again.projects.length, first.projects.length);

    const rs = RecruitStore.open(join(dir, 'recruit.db'));
    try {
      const events = rs.listEvents({limit: 10, withProjects: true});
      assert.equal(events.length, 1);
      assert.equal(events[0].sourceId, first.event.sourceId);
      assert.equal(events[0].projects.length, first.projects.length);
      assert.ok(events[0].projects.every(p => p.sourceUrl === article.url));
    } finally { rs.close(); }
  });
});

test('公众号：没有参会单位的推文不自动生成空活动', async () => {
  await withDir(async dir => {
    const store = WeChatStore.open(join(dir, 'wechat.db'));
    const account = store.listAccounts().find(a => a.name === '中山大学就业');
    const article = store.saveArticle({
      accountId: account.id, title: '@中大学子 你有一份2026就业升学月历待查收',
      url: 'https://mp.weixin.qq.com/s?__biz=Zd&mid=1&idx=1&sn=monthly',
      content: '中山大学就业\n求职 寒假实习招聘仍在报名。\n计划就业的应届毕业生可以先明确目标。'
    });
    store.close();
    const out = await publishArticle({dir, articleId: article.id});
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'no_projects');
    const rs = RecruitStore.open(join(dir, 'recruit.db'));
    try { assert.equal(rs.listEvents({limit: 10}).length, 0); } finally { rs.close(); }
  });
});

test('API：导入真实招聘文章自动产出带来源活动/项目，并去重', async () => {
  await withDir(async dir => {
    const body = '四川大学秋季双选会将于2026年11月20日14:00在体育馆举行。\n浙江吉利控股集团有限公司 招聘 数据分析\n宇树科技股份有限公司 招聘 算法工程师';
    const failFetch = async () => ({ok: false, message: '需要粘贴正文', title: '四川大学秋季双选会通知', nickname: '四川大学就业指导中心', biz: 'ApiScu', link: 'https://mp.weixin.qq.com/s?__biz=ApiScu&mid=1&idx=1&sn=import'});
    const first = await handleWechat({
      method: 'POST', pathname: 'articles/import', dir, userId: 'user-api',
      body: {url: 'https://mp.weixin.qq.com/s?__biz=ApiScu&mid=1&idx=1&sn=import', text: body},
      deps: {fetchArticle: failFetch}
    });
    assert.equal(first.json.article.accountId, first.json.account.id);
    assert.equal(first.json.account.name, '四川大学就业指导中心');
    assert.equal(first.json.publish.ok, true);
    assert.equal(first.json.event.sourceId, 'wechat:' + first.json.account.id);
    assert.equal(first.json.event.sourceUrl, first.json.article.url);
    assert.ok(first.json.publish.projects.length >= 2);

    const again = await handleWechat({
      method: 'POST', pathname: 'articles/import', dir,
      body: {url: 'http://mp.weixin.qq.com/s?__biz=ApiScu&mid=1&idx=1&sn=import&chksm=track#rd', text: body},
      deps: {fetchArticle: failFetch}
    });
    assert.equal(again.json.article.id, first.json.article.id);
    assert.equal(again.json.event.id, first.json.event.id);

    const store = WeChatStore.open(join(dir, 'wechat.db'));
    try {
      assert.equal(store.stats().articles, 1);
      assert.equal(store.stats().unattributed, 0);
    } finally { store.close(); }
    const rs = RecruitStore.open(join(dir, 'recruit.db'));
    try {
      const events = rs.listEvents({limit: 10, withProjects: true});
      assert.equal(events.length, 1);
      assert.equal(events[0].projects.length, first.json.publish.projects.length);
      const audits = rs.db.prepare('SELECT * FROM write_audit').all();
      assert.equal(audits.length, 1 + first.json.publish.projects.length, '导入自动发布要走审计');
      assert.ok(audits.every(row => row.user_id === 'user-api'));
    } finally { rs.close(); }
  });
});

test('API：订阅源、同步与账号发现', async () => {
  await withDir(async dir => {
    const store = WeChatStore.open(join(dir, 'wechat.db'));
    const account = store.listAccounts().find(a => a.name === '中山大学就业');
    store.close();
    let out = await handleWechat({method: 'POST', pathname: 'accounts/' + account.id + '/subscribe', body: {feedUrl: 'https://schools.test/zhongda'}, dir});
    assert.equal(out.json.account.subscribed, true);
    const text = '中山大学就业秋季双选会将于2026年11月20日14:00在体育馆举行，请同学们携带简历参加。本次双选会共有 120 家单位参会，涵盖制造、金融、信息技术、教育等行业。\n浙江吉利控股集团有限公司 招聘 数据分析\n宇树科技股份有限公司 招聘 算法工程师\n更多参会单位请关注后续通知，现场设有就业政策咨询台和简历门诊。';
    out = await handleWechat({
      method: 'POST', pathname: 'accounts/' + account.id + '/sync', dir,
      deps: {
        fetchFeed: async url => ({ok: true, url, text: '<a href="https://mp.weixin.qq.com/s?__biz=ZdApi&mid=1&idx=1&sn=sync">双选会</a>'}),
        fetchArticle: async link => ({ok: true, link, title: '中山大学就业秋季双选会', nickname: '中山大学就业', biz: 'ZdApi', publishedAt: '2026-10-20', text})
      }
    });
    assert.equal(out.json.imported, 1);
    assert.equal(out.json.status, 'ok');
    out = await handleWechat({method: 'GET', pathname: 'accounts', dir});
    assert.ok(out.json.stats.subscribed >= 1);
    assert.equal(out.json.stats.demoArticles, 0);

    out = await handleWechat({
      method: 'POST', pathname: 'discover', dir,
      body: {text: '测试大学就业 | https://mp.weixin.qq.com/s?__biz=NewBiz&mid=1&idx=1&sn=new', school: '测试大学'}
    });
    assert.equal(out.json.candidates.length, 1);
    assert.equal(out.json.candidates[0].name, '测试大学就业');
    assert.ok(out.json.candidates[0].accountId);
  });
});

test('API：文章可手动发布到招聘库并回写 eventId', async () => {
  await withDir(async dir => {
    const store = WeChatStore.open(join(dir, 'wechat.db'));
    const account = store.listAccounts().find(a => a.name === '四川大学就业指导中心');
    const article = store.saveArticle({
      accountId: account.id, title: '四川大学秋季双选会通知',
      url: 'https://mp.weixin.qq.com/s?__biz=PublishApi&mid=1&idx=1&sn=p',
      content: '四川大学秋季双选会将于2026年11月20日14:00在体育馆举行。\n浙江吉利控股集团有限公司 招聘 数据分析'
    });
    store.close();
    const published = await handleWechat({method: 'POST', pathname: 'articles/' + article.id + '/publish', body: {}, dir});
    assert.equal(published.json.ok, true);
    assert.equal(published.json.event.sourceId, 'wechat:' + account.id);
    const reopened = WeChatStore.open(join(dir, 'wechat.db'));
    try { assert.equal(reopened.getArticle(article.id).eventId, published.json.event.id); } finally { reopened.close(); }
  });
});

test('API：拒绝 example.com 演示链接，避免再次写入演示数据', async () => {
  await withDir(async dir => {
    const out = await handleWechat({
      method: 'POST', pathname: 'articles/import', dir,
      body: {url: 'https://example.com/wechat-demo2', text: '演示正文，长度足够但不应入库。'},
      deps: {fetchArticle: async () => ({ok: false, message: '不应抓取'})}
    });
    assert.equal(out.status, 400);
    assert.match(out.json.error, /示例域名/);
    const store = WeChatStore.open(join(dir, 'wechat.db'));
    try { assert.equal(store.stats().articles, 0); } finally { store.close(); }
  });
});

test('API：从来源页 URL 发现公众号并自动订阅', async () => {
  await withDir(async dir => {
    const url = 'https://schools.test/matrix';
    const html = [
      '<a href="https://mp.weixin.qq.com/mp/profile_ext?action=home&__biz=SwpuMatrix">西南石油大学就业</a>',
      '<a href="https://mp.weixin.qq.com/s?__biz=SwpuMatrix&mid=1&idx=1&sn=one">双选会通知</a>'
    ].join('\n');
    const out = await handleWechat({
      method: 'POST', pathname: 'discover', dir, body: {url, school: '西南石油大学'},
      deps: {fetchFeed: async link => ({ok: true, url: link, text: html})}
    });
    assert.equal(out.json.candidates.length, 1);
    assert.equal(out.json.candidates[0].name, '西南石油大学就业');
    assert.equal(out.json.candidates[0].feedUrl, url);
    const reopened = WeChatStore.open(join(dir, 'wechat.db'));
    try {
      const account = reopened.listAccounts().find(a => a.name === '西南石油大学就业');
      assert.equal(account.feedUrl, url);
      assert.equal(account.biz, 'SwpuMatrix');
    } finally { reopened.close(); }
  });
});

test('旧库种子冲突：legacy 别名行 + canonical 行同时存在时安全合并，不撞 name UNIQUE', async () => {
  await withDir(async dir => {
    const file = join(dir, 'wechat.db');
    let store = WeChatStore.open(file);
    const canonical = store.listAccounts().find(a => a.name === '西财校招');
    store.db.prepare('DELETE FROM wechat_accounts WHERE id=?').run(canonical.id);
    const legacyId = 'legacy-xicai';
    const now = new Date().toISOString();
    store.db.prepare(`INSERT INTO wechat_accounts(id,name,school,category,biz,created_at,updated_at,alias_biz,alias_names,feed_url)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(legacyId, '西财就业', '西南财经大学', '财经强校', 'MjM5MDAxMzM4MQ==', now, now, '["MzA4ODgzNjg2NQ=="]', '[]', 'https://schools.test/xicai');
    store.db.prepare(`INSERT INTO wechat_accounts(id,name,school,category,biz,created_at,updated_at,alias_biz,alias_names,feed_url)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run('canonical-xicai', '西财校招', '西南财经大学', '财经强校', 'MjM5MDAxMzM4MQ==', now, now, '[]', '[]', '');
    store.db.prepare('INSERT INTO wechat_articles(id,account_id,title,url,content,created_at) VALUES(?,?,?,?,?,?)')
      .run('legacy-article', legacyId, '西财旧文', 'https://mp.weixin.qq.com/s?__biz=MjA&mid=1&idx=1&sn=legacy', '旧正文', now);
    store.close();

    // 重新打开会跑 seed()：旧别名行不能因为改名撞 UNIQUE 而让整个库打不开。
    store = WeChatStore.open(file);
    try {
      const rows = store.listAccounts().filter(a => a.school === '西南财经大学');
      assert.equal(rows.length, 1, '同一学校只保留一个合并后的账号');
      const merged = rows[0];
      assert.equal(merged.name, '西财校招');
      assert.ok(merged.aliasNames.includes('西财就业'), '旧名保留为别名');
      assert.equal(merged.feedUrl, 'https://schools.test/xicai', '订阅地址不因合并丢失');
      assert.equal(store.getArticle('legacy-article').accountId, merged.id, '旧文章改挂到合并后的账号');
      const duplicate = store.db.prepare('SELECT name, COUNT(*) c FROM wechat_accounts GROUP BY name HAVING c > 1').all();
      assert.deepEqual(duplicate, []);
    } finally { store.close(); }
  });
});

test('发布：force 不再绕过「至少 1 单位 / 合法开始时间 / 非未发现招聘」门禁', async () => {
  await withDir(async dir => {
    const store = WeChatStore.open(join(dir, 'wechat.db'));
    const account = store.listAccounts().find(a => a.name === '四川大学就业指导中心');
    const article = store.saveArticle({
      accountId: account.id, title: '四川大学秋季双选会通知',
      url: 'https://mp.weixin.qq.com/s?__biz=ForceGate&mid=1&idx=1&sn=force',
      content: '四川大学秋季双选会通知正文'
    });
    store.saveAnalysis(article.id, {hasRecruitment: 'no', draft: {startAt: '2026-11-20T14:00:00+08:00'}, projects: [{company: '甲公司', title: '数据分析'}], warnings: []});
    let out = await publishArticle({dir, articleId: article.id, force: true});
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'not_recruitment');

    const noStart = store.saveArticle({
      accountId: account.id, title: '没有开始时间的推文',
      url: 'https://mp.weixin.qq.com/s?__biz=ForceGate&mid=2&idx=1&sn=nostart',
      content: '只有单位名单，没有时间'
    });
    store.saveAnalysis(noStart.id, {hasRecruitment: 'yes', draft: {}, projects: [{company: '乙公司', title: '产品经理'}], warnings: []});
    out = await publishArticle({dir, articleId: noStart.id, force: true});
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'invalid_start_at');

    const noProjects = store.saveArticle({
      accountId: account.id, title: '只有时间没有单位',
      url: 'https://mp.weixin.qq.com/s?__biz=ForceGate&mid=3&idx=1&sn=noproj',
      content: '双选会 2026年11月20日 14:00'
    });
    store.saveAnalysis(noProjects.id, {hasRecruitment: 'yes', draft: {startAt: '2026-11-20T14:00:00+08:00'}, projects: [], warnings: []});
    out = await publishArticle({dir, articleId: noProjects.id, force: true});
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'no_projects');
    store.close();

    const rs = RecruitStore.open(join(dir, 'recruit.db'));
    try { assert.equal(rs.listEvents({limit: 10}).length, 0, '被门禁挡下时一行都不写'); } finally { rs.close(); }
  });
});

test('自动发布写审计：事件与项目同一批次，重放不重复写', async () => {
  await withDir(async dir => {
    const store = WeChatStore.open(join(dir, 'wechat.db'));
    const account = store.listAccounts().find(a => a.name === '四川大学就业指导中心');
    const article = store.saveArticle({
      accountId: account.id, title: '四川大学秋季双选会通知',
      url: 'https://mp.weixin.qq.com/s?__biz=AuditScu&mid=1&idx=1&sn=audit',
      content: '四川大学秋季双选会将于2026年11月20日14:00在体育馆举行。\n浙江吉利控股集团有限公司 招聘 数据分析\n宇树科技股份有限公司 招聘 算法工程师'
    });
    store.close();

    const first = await publishArticle({dir, articleId: article.id, audit: {userId: 'user-a', actorType: 'model'}});
    assert.equal(first.ok, true);
    assert.ok(first.batchId, '自动发布要产生审计批次');
    assert.equal(first.duplicate, false);

    const rs = RecruitStore.open(join(dir, 'recruit.db'));
    let audits, idem;
    try {
      audits = rs.db.prepare('SELECT * FROM write_audit ORDER BY seq').all();
      idem = rs.db.prepare('SELECT * FROM idempotency').all();
    } finally { rs.close(); }
    assert.equal(audits.length, 1 + first.projects.length, '事件 1 行 + 每个项目 1 行');
    assert.ok(audits.every(row => row.user_id === 'user-a'));
    assert.ok(audits.every(row => row.batch_id === first.batchId));
    assert.ok(audits.every(row => row.tool === 'career_wechat_publish'));
    assert.ok(audits.some(row => row.entity === 'events' && row.action === 'create'));
    assert.ok(audits.filter(row => row.entity === 'event_projects').length >= 1);
    assert.equal(idem.length, 1);
    assert.equal(idem[0].status, 'completed');

    const again = await publishArticle({dir, articleId: article.id, audit: {userId: 'user-a', actorType: 'model'}});
    assert.equal(again.ok, true);
    assert.equal(again.duplicate, true);
    assert.equal(again.event.id, first.event.id);
    const rs2 = RecruitStore.open(join(dir, 'recruit.db'));
    try { assert.equal(rs2.db.prepare('SELECT COUNT(*) c FROM write_audit').get().c, audits.length, '重放不新增审计'); } finally { rs2.close(); }
  });
});

test('purge-demo：示例活动软删除并写审计，不物理 DELETE；重复执行不重复审计', async () => {
  await withDir(async dir => {
    const rs = RecruitStore.open(join(dir, 'recruit.db'));
    try {
      const at = new Date().toISOString();
      rs.upsertEvent({id: 'demo'.padEnd(24, '0'), sourceId: 'manual', school: '演示大学', city: '成都', kind: '双选会', title: '演示活动', startAt: '2026-11-01T09:00:00+08:00', sourceUrl: 'https://example.com/demo', fetchedAt: at});
      rs.upsertEvent({id: 'real'.padEnd(24, '0'), sourceId: 'manual', school: '真实大学', city: '成都', kind: '双选会', title: '真实活动', startAt: '2026-11-02T09:00:00+08:00', sourceUrl: 'https://school.edu.cn/real', fetchedAt: at});
    } finally { rs.close(); }

    const out = await handleWechat({method: 'POST', pathname: 'purge-demo', dir, userId: 'user-a'});
    assert.equal(out.json.removedEvents, 1);
    assert.ok(out.json.auditBatchId);

    const check = RecruitStore.open(join(dir, 'recruit.db'));
    try {
      const demo = check.getEvent('demo'.padEnd(24, '0'));
      assert.equal(demo.status, 'archived', '演示活动是软删除');
      assert.match(demo.notes, /软删除/);
      assert.equal(check.listEvents({limit: 10}).length, 1, '默认列表只剩真实活动');
      const audits = check.db.prepare('SELECT * FROM write_audit').all();
      assert.equal(audits.length, 1);
      assert.equal(audits[0].action, 'delete');
      assert.equal(audits[0].entity, 'events');
      assert.equal(audits[0].user_id, 'user-a');
      assert.equal(audits[0].tool, 'wechat_purge_demo');
    } finally { check.close(); }

    const again = await handleWechat({method: 'POST', pathname: 'purge-demo', dir, userId: 'user-a'});
    assert.equal(again.json.removedEvents, 0);
    const final = RecruitStore.open(join(dir, 'recruit.db'));
    try { assert.equal(final.db.prepare('SELECT COUNT(*) c FROM write_audit').get().c, 1, '重复清理不重复审计'); } finally { final.close(); }
  });
});

test('账号未配置订阅页：同步返回可诊断的 disabled，账号仍可配置 feedUrl', async () => {
  await withDir(async dir => {
    const account = (await handleWechat({method: 'GET', pathname: 'accounts', dir})).json.accounts.find(a => a.name === '中山大学就业');
    assert.equal(account.subscribed, false);
    assert.equal(account.feedUrl, '');
    const out = await handleWechat({method: 'POST', pathname: 'accounts/' + account.id + '/sync', body: {}, dir});
    assert.equal(out.json.status, 'disabled');
    assert.match(out.json.message, /未配置/);
    const saved = await handleWechat({method: 'POST', pathname: 'accounts/' + account.id + '/subscribe', body: {feedUrl: 'https://schools.test/zhongda'}, dir});
    assert.equal(saved.json.account.subscribed, true);
    assert.equal(saved.json.account.feedUrl, 'https://schools.test/zhongda');
  });
});

test('CLI：subscribe 能配置 feedUrl（9 个空账号的配置入口）', async () => {
  await withDir(async dir => {
    let store = WeChatStore.open(join(dir, 'wechat.db'));
    const account = store.listAccounts().find(a => a.name === '中山大学就业');
    store.close();
    const cli = join(fileURLToPath(new URL('..', import.meta.url)), 'src', 'wechat', 'cli.mjs');
    const out = execFileSync(process.execPath, [cli, 'subscribe', '--account', account.id, '--feed', 'https://schools.test/zhongda', '--data', dir], {encoding: 'utf8'});
    assert.match(out, /已保存订阅页/);
    store = WeChatStore.open(join(dir, 'wechat.db'));
    try {
      assert.equal(store.getAccount(account.id).feedUrl, 'https://schools.test/zhongda');
      assert.ok(store.listSubscribed().some(a => a.id === account.id));
    } finally { store.close(); }
  });
});

test('升级真实旧库：清演示数据、把“未归类”文章自动归属到已知账号', async () => {
  await withDir(async dir => {
    const file = join(dir, 'wechat.db');
    let store = WeChatStore.open(file);
    const zhongda = store.listAccounts().find(a => a.name === '中山大学就业');
    const fallback = store.addAccount({name: '未归类公众号', note: '旧数据'});
    const now = new Date().toISOString();
    const insert = store.db.prepare('INSERT INTO wechat_articles(id,account_id,title,url,content,created_at) VALUES(?,?,?,?,?,?)');
    insert.run('old-invite', fallback.id, '中山大学2027届毕业生推介手册&校园招聘活动邀请函', 'https://mp.weixin.qq.com/s?__biz=ZdReal&mid=1&idx=1&sn=invite', '中山大学就业\n中山大学2027届毕业生推介手册', now);
    insert.run('old-monthly', fallback.id, '@中大学子 你有一份2026就业升学月历待查收', 'https://mp.weixin.qq.com/s?__biz=ZdReal&mid=2&idx=1&sn=monthly', '中山大学就业\n求职 寒假实习招聘仍在报名。', now);
    insert.run('old-demo', zhongda.id, '四川大学秋季双选会演示', 'https://example.com/wechat-demo2', '演示正文', now);
    store.close();

    store = WeChatStore.open(file);
    try {
      const stats = store.stats();
      assert.equal(stats.demoArticles, 0);
      assert.equal(stats.articles, 2);
      assert.equal(stats.unattributed, 0);
      const articles = store.listArticles();
      assert.ok(articles.every(a => a.accountId === zhongda.id));
      assert.ok(articles.every(a => a.biz === 'ZdReal'));
      assert.ok(!store.listAccounts().some(a => a.name === '未归类公众号'));
      assert.equal(store.getAccount(zhongda.id).biz, 'ZdReal');
    } finally { store.close(); }
  });
});

// ---- 公众号 AI 操作员（#59）----

const WECHAT_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

function fakeWechatPage({title = '公众号文章列表', text = '西南财经大学公众号'} = {}) {
  const calls = [];
  const handlers = new Map();
  let currentUrl = 'https://mp.weixin.qq.com/mp/profile_ext?action=home';
  const page = {
    calls,
    url: () => currentUrl,
    setUrl: value => { currentUrl = String(value); },
    title: async () => title,
    goto: async url => { calls.push({action: 'goto', url}); currentUrl = url; },
    click: async selector => { calls.push({action: 'click', selector}); },
    fill: async (selector, value) => { calls.push({action: 'fill', selector, value}); },
    press: async (selector, key) => { calls.push({action: 'press', selector, key}); },
    evaluate: async script => {
      if (typeof script === 'function') { calls.push({action: 'evaluate_fn'}); return text; }
      calls.push({action: 'evaluate', script});
      return null;
    },
    screenshot: async ({path}) => { calls.push({action: 'screenshot', path}); await writeFile(path, WECHAT_PNG); },
    waitForTimeout: async ms => { calls.push({action: 'wait', ms}); await new Promise(resolve => setTimeout(resolve, ms)); },
    on: (name, handler) => { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(handler); return page; },
    emit: async (name, value) => { for (const handler of handlers.get(name) || []) await handler(value); }
  };
  return page;
}

function fakeWechatLauncher(page, capture = {}) {
  const context = {
    pages: () => [page],
    newPage: async () => page,
    route: async () => {},
    on: () => {},
    close: async () => { capture.closed = true; }
  };
  return async options => { capture.options = options; return context; };
}

const WECHAT_ARTICLE_URLS = {
  jobfair: 'https://mp.weixin.qq.com/s?__biz=MzM5MDAxMzM4MQ%3D%3D&mid=2650000001&idx=1&sn=jobfair59',
  nodate: 'https://mp.weixin.qq.com/s?__biz=MzM5MDAxMzM4MQ%3D%3D&mid=2650000002&idx=1&sn=nodate59',
  monthly: 'https://mp.weixin.qq.com/s?__biz=MzM5MDAxMzM4MQ%3D%3D&mid=2650000003&idx=1&sn=monthly59'
};

function fixtureWechatReaders({listError = null} = {}) {
  const jobfair = readFileSync(new URL('./fixtures/wechat-xicai-article.txt', import.meta.url), 'utf8');
  const bodies = {
    jobfair59: {title: '西南财经大学2027届秋季双选会邀请函', nickname: '西财校招', publishedAt: '2026-11-10', text: jobfair},
    nodate59: {title: '西南财经大学秋季双选会参会单位', nickname: '西财校招', text: '西南财经大学秋季双选会参会单位\n中国工商银行股份有限公司\n成都银行股份有限公司\n本次双选会由学校就业指导中心组织，请同学们携带简历参加。具体举办时间与地点请关注后续通知，不要错过与用人单位当面交流的机会。请提前准备纸质简历，并留意现场引导与展位分布。'},
    monthly59: {title: '@西财学子 你有一份2026就业升学月历待查收', nickname: '西财校招', text: '西南财经大学就业\n求职 寒假实习招聘仍在报名。\n计划就业的应届毕业生可以先明确目标，合理安排求职节奏。\n本月还有多场就业指导讲座与简历门诊活动，欢迎同学们关注学校就业信息网，及时了解最新安排。请合理安排课程与求职时间，提前做好材料准备。学校就业指导中心将持续发布招聘信息与活动通知，请保持关注。'}
  };
  const calls = [];
  let listCalls = 0;
  return {
    calls,
    bodies,
    list: async () => {
      listCalls += 1;
      calls.push({kind: 'list', n: listCalls});
      if (listError && listCalls === 1) throw listError;
      return [
        {title: '西南财经大学2027届秋季双选会邀请函', url: WECHAT_ARTICLE_URLS.jobfair},
        {title: '西南财经大学秋季双选会参会单位', url: WECHAT_ARTICLE_URLS.nodate},
        {title: '@西财学子 你有一份2026就业升学月历待查收', url: WECHAT_ARTICLE_URLS.monthly}
      ];
    },
    article: async ({article}) => {
      calls.push({kind: 'article', url: article.url});
      return bodies[new URL(article.url).searchParams.get('sn')];
    }
  };
}

function xicaiAccount(dir) {
  const store = WeChatStore.open(join(dir, 'wechat.db'));
  try { return store.listAccounts().find(account => account.name === '西财校招'); } finally { store.close(); }
}

test('公众号 AI 操作员：首选西财校招、次选上财就业，列表只收公众号文章链接', () => {
  assert.equal(pickWechatOperatorAccount([{name: '上海财经大学就业', biz: 'sufe'}, {name: '西财校招', biz: 'xicai'}]).name, '西财校招');
  assert.equal(pickWechatOperatorAccount([{name: '上海财经大学就业', biz: 'sufe'}]).name, '上海财经大学就业');
  assert.equal(pickWechatOperatorAccount([]), null);
  assert.match(wechatProfileUrl({biz: 'abc+/='}), /__biz=abc%2B%2F%3D/);
  const list = normalizeWechatOperatorArticles([
    {title: '一', url: 'https://mp.weixin.qq.com/s?__biz=X&mid=1&idx=1&sn=1'},
    {title: '重复', url: 'http://mp.weixin.qq.com/s?__biz=X&mid=1&idx=1&sn=1&chksm=y#rd'},
    {title: '外部', url: 'https://example.com/s?x=1'},
    {title: '主页', url: 'https://mp.weixin.qq.com/mp/profile_ext?action=home&__biz=X'}
  ], {limit: 5});
  assert.equal(list.length, 1);
  assert.equal(list[0].url, 'https://mp.weixin.qq.com/s?__biz=X&mid=1&idx=1&sn=1');
  assert.equal(WECHAT_ARTICLE_LIMIT, 5);
});

test('公众号 AI 操作员：fixture 文章列表+正文 → 活动/项目/证据/feed/撤销', {timeout: 30000}, async () => {
  await withDir(async dir => {
    const account = xicaiAccount(dir);
    const taskId = '77777777-7777-4777-8777-777777777777';
    const readers = fixtureWechatReaders();
    const page = fakeWechatPage();
    const capture = {};
    const evidence = [];
    const out = await runWechatOperator({
      dataDir: dir, wechatDir: dir, userId: 'user-59', task: {id: taskId}, account,
      launch: fakeWechatLauncher(page, capture), readers,
      emit: () => {}, addEvidence: entry => evidence.push(entry), setPhase: () => {},
      askHuman: async () => { throw new Error('fixture 流程不应暂停'); }
    });

    assert.equal(out.ok, true);
    assert.equal(out.articles, 3);
    assert.equal(out.published.length, 1);
    assert.deepEqual(out.skipped.map(item => item.reason).sort(), ['invalid_start_at', 'no_units']);
    assert.equal(out.written, 7, '1 场活动 + 6 个单位');
    assert.equal(capture.options.profileDir, join(dir, 'users', 'user-59', 'profile'));
    assert.equal(capture.options.options.headless, false);
    assert.equal(OPERATOR_LAUNCH_OPTIONS.headless, false);
    assert.equal(capture.closed, true);
    assert.deepEqual(readers.calls.map(call => call.kind), ['list', 'article', 'article', 'article']);
    assert.equal(page.calls.filter(call => call.action === 'goto').length, 4, '列表 1 次 + 正文 3 篇');
    assert.ok(page.calls.filter(call => call.action === 'screenshot').length >= 4, '每步截图');

    const evidenceDir = join(dir, 'users', 'user-59', 'tasks', taskId, 'evidence');
    const files = await readdir(evidenceDir);
    for (const file of ['wechat-list.json', 'wechat-article-001.json', 'wechat-article-002.json', 'wechat-article-003.json']) {
      assert.ok(files.includes(file), '缺证据文件：' + file);
    }
    assert.ok(evidence.some(item => /公众号文章列表/.test(item.label)));
    assert.ok(evidence.some(item => /公众号文章/.test(item.label)));

    const rs = RecruitStore.open(join(dir, 'recruit.db'));
    let audits;
    try {
      const events = rs.listEvents({limit: 10, withProjects: true});
      assert.equal(events.length, 1, '只对「单位 + 合法 startAt」的文章生成活动');
      const event = events[0];
      assert.equal(event.sourceUrl, WECHAT_ARTICLE_URLS.jobfair);
      assert.equal(event.startAt, '2026-11-20T14:00:00+08:00');
      assert.ok(event.sourceId.startsWith('wechat:'));
      assert.equal(event.projects.length, 6);
      const fixtureText = readers.bodies.jobfair59.text;
      assert.ok(event.projects.every(project => fixtureText.includes(project.company)), '0 编造：单位都能在正文里找到');

      audits = rs.db.prepare('SELECT * FROM write_audit ORDER BY seq').all();
      assert.equal(audits.length, 7);
      assert.ok(audits.every(row => row.user_id === 'user-59' && row.task_id === taskId && row.tool === WECHAT_OPERATOR_TOOL));
      assert.ok(audits.every(row => row.source_ref === 'artifact:wechat-article-001.json'));

      const feed = readFeed({db: rs.db, dataDir: dir, userId: 'user-59', types: ['event', 'project']});
      assert.equal(feed.entries.length, 7);
      for (const entry of feed.entries) {
        const record = entry.record;
        assert.equal(record.source_url, WECHAT_ARTICLE_URLS.jobfair);
        assert.match(record.fetched_at, /^\d{4}-\d{2}-\d{2}T/);
        assert.ok(record.confidence > 0);
        assert.equal(record.evidence_ref, 'artifact:wechat-article-001.json');
        assert.equal(record.evidence_available, true);
        assert.match(record.operation_id, new RegExp('^' + taskId + ':\\d+$'), 'operation_id = taskId:runSeq');
      }
    } finally { rs.close(); }

    // /chat 与入站 MCP 共用的 career_feed 工具读同一条路径。
    const chatFeed = await careerFeed({}, {config: {recruitDir: dir, dataDir: dir, userId: 'user-59'}});
    assert.equal(chatFeed.status, 'readable');
    assert.ok(chatFeed.entries.length >= 3);
    assert.ok(chatFeed.entries.every(entry => entry.record.evidence_ref && entry.record.source_url));

    // 可撤销：任务级撤销删回所有业务行，feed 增量里能看到 undo。
    const undo = await undoTask({dir, userId: 'user-59', taskId});
    assert.ok(undo.counts.undone >= 7, '活动与项目都要能撤销');
    const after = RecruitStore.open(join(dir, 'recruit.db'));
    try {
      assert.equal(after.listEvents({limit: 10}).length, 0);
      assert.equal(after.db.prepare('SELECT COUNT(*) c FROM event_projects').get().c, 0);
      const incremental = readFeed({db: after.db, dataDir: dir, userId: 'user-59', types: ['event', 'project'], since: 0});
      assert.ok(incremental.entries.some(entry => entry.op === 'undo'));
    } finally { after.close(); }
  });
});

test('公众号 AI 操作员：不足 3 条记录判 failed 并给恢复建议（最小记录门禁）', {timeout: 30000}, async () => {
  await withDir(async dir => {
    const account = xicaiAccount(dir);
    const readers = fixtureWechatReaders();
    // 只读一篇、只抽 1 个单位：1 活动 + 1 单位 = 2 条，低于验收下限。
    readers.list = async () => [{title: '西南财经大学2027届秋季双选会邀请函', url: WECHAT_ARTICLE_URLS.jobfair}];
    const analyze = () => ({
      hasRecruitment: 'yes',
      summary: '双选会',
      draft: {startAt: '2026-11-20T14:00:00+08:00', title: '西南财经大学2027届秋季双选会'},
      projects: [{company: '中国工商银行股份有限公司', title: '管理培训生'}],
      warnings: []
    });
    const page = fakeWechatPage();
    const capture = {};
    await assert.rejects(runWechatOperator({
      dataDir: dir, wechatDir: dir, userId: 'user-59-min', task: {id: '99999999-9999-4999-8999-999999999999'}, account,
      launch: fakeWechatLauncher(page, capture), readers, analyze,
      emit: () => {}, addEvidence: async () => {}, setPhase: () => {},
      askHuman: async () => { throw new Error('fixture 流程不应暂停'); }
    }), error => {
      assert.equal(error?.code, 'WECHAT_MIN_RECORDS');
      assert.match(error.recovery, /至少 3 条|手动导入/);
      return true;
    });
    const evidenceDir = join(dir, 'users', 'user-59-min', 'tasks', '99999999-9999-4999-8999-999999999999', 'evidence');
    const summary = JSON.parse(await readFile(join(evidenceDir, WECHAT_SUMMARY_EVIDENCE), 'utf8'));
    assert.equal(summary.written, 2);
    assert.equal(summary.accounted, 2, '门禁看写入/确认的记录数');
    assert.ok(summary.published.length >= 1, '已写入的记录与证据保留，便于用户核对');
  });
});

test('公众号 AI 操作员：登录墙暂停 waiting_login，人工继续后从停点续跑并写库', {timeout: 30000}, async () => {
  await withDir(async dir => {
    const account = xicaiAccount(dir);
    const readers = fixtureWechatReaders({listError: new OperatorError('OPERATOR_LOGIN_REQUIRED', '公众号文章列表需要登录或验证，请在本窗口登录后点「已登录，继续」。', '不要绕过微信验证。')});
    const page = fakeWechatPage();
    const capture = {};
    const humans = [];
    const out = await runWechatOperator({
      dataDir: dir, wechatDir: dir, userId: 'user-59b', task: {id: '88888888-8888-4888-8888-888888888888'}, account,
      launch: fakeWechatLauncher(page, capture), readers,
      emit: () => {}, addEvidence: async () => {}, setPhase: () => {},
      askHuman: async info => { humans.push(info); return {action: 'resume'}; }
    });

    assert.equal(out.ok, true);
    assert.equal(humans.length, 1);
    assert.equal(humans[0].state, 'waiting_login');
    assert.equal(humans[0].kind, 'login');
    assert.match(humans[0].reason, /登录/);
    assert.equal(readers.calls.filter(call => call.kind === 'list').length, 2, '人工处理后重试读列表，不重跑已完成的打开页面');
    assert.equal(page.calls.filter(call => call.action === 'goto').length, 4);
    assert.equal(out.published.length, 1);
  });
});
