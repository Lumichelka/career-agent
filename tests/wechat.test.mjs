import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WeChatStore} from '../src/wechat/store.mjs';
import {handleWechat, bizOf} from '../src/wechat/api.mjs';

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
