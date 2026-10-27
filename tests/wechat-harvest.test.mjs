import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {findWechatLinks, harvestWechat} from '../src/wechat/harvest.mjs';
import {analyzeArticle} from '../src/wechat/analyze.mjs';
import {fetchWechatArticle} from '../src/wechat/fetch-article.mjs';
import {discoverAccounts} from '../src/wechat/attribute.mjs';
import {syncSubscriptions} from '../src/wechat/subscribe.mjs';
import {WeChatStore} from '../src/wechat/store.mjs';

test('来源页：发现并规范化公众号文章链接', () => {
  const html = '<a href="http://mp.weixin.qq.com/s?__biz=abc&amp;mid=1">一</a><a href="https://mp.weixin.qq.com/s/xyz#rd">二</a><a href="https://example.com">三</a>';
  const links = findWechatLinks(html);
  assert.equal(links.length, 2);
  assert.ok(links.every(l => l.startsWith('https://mp.weixin.qq.com/s')));
  assert.ok(links.every(l => !l.includes('&amp;')));
});

test('文章分析：真实双选会推文抽出 26 家参会单位', () => {
  const text = readFileSync(new URL('./fixtures/wechat-jobfair-article.txt', import.meta.url), 'utf8');
  const a = analyzeArticle({title: '线下双选 | 5月8日 | “周五职通车”——2027届实习专场', text, url: 'https://mp.weixin.qq.com/s/jobfair'});
  assert.equal(a.hasRecruitment, 'yes');
  assert.equal(a.projects.length, 26);
  assert.ok(a.projects.some(p => p.company.includes('德州仪器')));
  assert.equal(a.summary, '线下双选 | 5月8日 | “周五职通车”——2027届实习专场');
});

test('文章分析：月历/邀请函噪声不产生假项目', () => {
  const monthly = analyzeArticle({
    title: '@中大学子 你有一份2026就业升学月历待查收',
    text: '求职 寒假实习招聘仍在报名。\n中山大学就业\n主动与学校进行联系\n成绩公布后\n部分市区春招开始报名\n计划就业的应届毕业生可以先明确目标。',
    url: 'https://mp.weixin.qq.com/s/monthly'
  });
  assert.equal(monthly.projects.length, 0);
  const invite = analyzeArticle({
    title: '2027届毕业生推介手册&校园招聘活动邀请函',
    text: '中山大学2027届毕业生推介手册&2026年秋季学期校园招聘活动邀请函\n请使用电脑访问 “中山大学就业信息网”\n欢迎各地组织部门、人力资源和社会保障部门、人才交流中心',
    url: 'https://mp.weixin.qq.com/s/invite'
  });
  assert.equal(invite.projects.length, 0);
});

test('文章分析：真实单位 + 招聘行能拆出项目', () => {
  const a = analyzeArticle({
    title: '双选会通知',
    text: '双选会时间：2026年11月20日 14:00\n浙江吉利控股集团有限公司 招聘 数据分析\n宇树科技股份有限公司 招聘 算法工程师',
    url: 'https://mp.weixin.qq.com/s/recruit'
  });
  assert.equal(a.hasRecruitment, 'yes');
  assert.deepEqual(a.projects.map(p => p.company), ['浙江吉利控股集团有限公司', '宇树科技股份有限公司']);
  assert.equal(a.projects[0].title, '数据分析');
});

test('非公众号链接不进入正文抓取', async () => {
  const out = await fetchWechatArticle('https://example.com/article');
  assert.equal(out.ok, false);
  assert.match(out.message, /有效的公众号/);
});

test('来源页：发现公众号候选（biz + 昵称 + 文章链接）', () => {
  const html = [
    '<a href="https://mp.weixin.qq.com/mp/profile_ext?action=home&__biz=QlV0&scene=124">清华大学就业</a>',
    '<a href="https://mp.weixin.qq.com/s?__biz=QlV0&mid=1&idx=1&sn=a">双选会通知</a>',
    '<a href="https://mp.weixin.qq.com/s?__biz=QlV0&mid=2&idx=1&sn=b">宣讲会安排</a>'
  ].join('\n');
  const candidates = discoverAccounts(html, {school: '清华大学'});
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].name, '清华大学就业');
  assert.equal(candidates[0].biz, 'QlV0');
  assert.equal(candidates[0].articleUrls.length, 2);
});

test('来源页：短链文章锚文本不会被当成账号名', () => {
  const candidates = discoverAccounts('<a href="https://mp.weixin.qq.com/s/abc">双选会通知</a>');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].name, '');
  assert.equal(candidates[0].articleUrls.length, 1);
});

test('来源页：一行一条的“账号 | 文章链接”清单也能发现', () => {
  const text = '中山大学就业 | https://mp.weixin.qq.com/s?__biz=Zd&mid=1&idx=1&sn=x\n南开大学就业｜https://mp.weixin.qq.com/s?__biz=Nk&mid=1&idx=1&sn=y';
  const candidates = discoverAccounts(text);
  assert.deepEqual(candidates.map(c => c.name).sort(), ['中山大学就业', '南开大学就业']);
  assert.deepEqual(candidates.map(c => c.biz).sort(), ['Nk', 'Zd']);
});

test('订阅同步：9 个空账号都能入库最近文章，重复同步不重复', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zx-wechat-sync-'));
  try {
    const store = WeChatStore.open(join(dir, 'wechat.db'));
    try {
      const accounts = store.listAccounts();
      assert.equal(accounts.length, 9);
      assert.equal(accounts.filter(a => a.articles === 0).length, 9);
      for (const account of accounts) store.setSubscription(account.id, 'https://schools.test/' + account.id);
      const fetchFeed = async url => {
        const account = accounts.find(a => url.endsWith(a.id));
        return {ok: true, url, text: '<a href="https://mp.weixin.qq.com/s?__biz=biz-' + account.id + '&mid=1&idx=1&sn=' + account.id + '">' + account.name + ' 双选会</a>'};
      };
      const fetchArticle = async link => {
        const id = new URL(link).searchParams.get('sn');
        const account = accounts.find(a => a.id === id);
        return {
          ok: true, link, title: account.name + ' 秋季双选会', nickname: account.name,
          biz: 'biz-' + id, publishedAt: '2026-10-20',
          text: account.name + '秋季双选会将于2026年11月20日14:00在体育馆举行，请同学们携带简历参加。本次双选会共有 120 家单位参会，涵盖制造、金融、信息技术、教育等行业。\n浙江吉利控股集团有限公司 招聘 数据分析\n宇树科技股份有限公司 招聘 算法工程师\n更多参会单位请关注后续通知，现场设有就业政策咨询台和简历门诊。'
        };
      };
      const first = await syncSubscriptions({store, fetchFeed, fetchArticle, limit: 5});
      assert.equal(first.accounts, 9);
      assert.equal(first.imported, 9);
      assert.ok(store.listAccounts().every(a => a.articles > 0));
      const second = await syncSubscriptions({store, fetchFeed, fetchArticle, limit: 5});
      assert.equal(second.imported, 0);
      assert.equal(store.stats().articles, 9);
      assert.ok(store.listArticles().every(a => a.hasRecruitment === 'yes'));
    } finally { store.close(); }
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('来源页采集：入库文章带摘要，抓取失败给出可粘贴提示', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zx-harvest-result-'));
  try {
    const html = '<a href="https://mp.weixin.qq.com/s/one">一</a><a href="https://mp.weixin.qq.com/s/two">二</a>';
    let calls = 0;
    const result = await harvestWechat({
      text: html, dir, limit: 2,
      fetchArticle: async link => {
        calls++;
        if (link.includes('/two')) return {ok: false, needPaste: true, message: '微信要求验证或正文为空；请把推文正文粘贴进来', link};
        return {ok: true, title: '某公司双选会', text: '某公司 招聘 数据分析。\n' + '正文'.repeat(80), link, nickname: '就业中心', biz: 'biz1'};
      }
    });
    assert.equal(calls, 2);
    assert.equal(result.imported, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.articles.length, 1);
    assert.equal(result.articles[0].title, '某公司双选会');
    assert.ok(result.articles[0].summary.includes('数据分析'));
    assert.ok(result.articles[0].summary.length <= 120);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].needPaste, true);
    assert.match(result.failures[0].link, /\/two$/);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});
