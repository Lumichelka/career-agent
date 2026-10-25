import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WeChatStore} from '../src/wechat/store.mjs';
import {handleWechat, bizOf} from '../src/wechat/api.mjs';
import {analyzeArticle} from '../src/wechat/analyze.mjs';
import {handleRecruit} from '../src/recruit/api.mjs';

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
