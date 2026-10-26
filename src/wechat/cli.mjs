#!/usr/bin/env node
// 公众号管线命令行：账号/文章报表、订阅同步、单篇导入、批量发布、清理演示数据。
// 用法：
//   node src/wechat/cli.mjs report
//   node src/wechat/cli.mjs sync [--account <id>] [--limit 5]
//   node src/wechat/cli.mjs import --url <文章链接> [--text 正文]
//   node src/wechat/cli.mjs discover --url <来源页> | --text <HTML/正文>
//   node src/wechat/cli.mjs publish-all
//   node src/wechat/cli.mjs purge-demo
import {join, resolve} from 'node:path';
import {WeChatStore} from './store.mjs';
import {handleWechat} from './api.mjs';
import {publishArticle} from './publish.mjs';
import {syncSubscriptions} from './subscribe.mjs';
import {purgeDemoRecruitEvents} from '../recruit/demo-purge.mjs';
import {defaultUserDataDir} from '../config/paths.mjs';

const argv = process.argv.slice(2);
const command = argv[0] || 'help';
const flag = name => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : ''; };
const dataDir = resolve(flag('data') || defaultUserDataDir());
const line = '─'.repeat(66);

async function main() {
  if (command === 'report') {
    const store = WeChatStore.open(join(dataDir, 'wechat.db'));
    try {
      const stats = store.stats();
      console.log('公众号报告\n' + line);
      console.log('账号 ' + stats.accounts + ' 个，文章 ' + stats.articles + ' 篇，已订阅 ' + stats.subscribed + ' 个，待归属 ' + stats.unattributed + ' 篇，演示数据 ' + stats.demoArticles + ' 条');
      for (const a of store.listAccounts()) {
        console.log(' ' + a.name.padEnd(20) + ' ' + String(a.articles).padStart(3) + ' 篇  招聘 ' + String(a.recruitmentArticles).padStart(2) + (a.feedUrl ? '  订阅 ' + a.lastSyncStatus : '  未订阅'));
      }
      console.log(line);
    } finally { store.close(); }
    return;
  }
  if (command === 'sync') {
    const store = WeChatStore.open(join(dataDir, 'wechat.db'));
    try {
      const id = flag('account');
      const accounts = id ? [store.getAccount(id)].filter(Boolean) : undefined;
      if (id && !accounts.length) throw new Error('账号不存在：' + id);
      const out = await syncSubscriptions({store, accounts, dir: dataDir, limit: Number(flag('limit') || 5), publish: argv.includes('--publish'), audit: {userId: 'cli', actorType: 'cli'}, onLog: e => console.log('· ' + e.text)});
      console.log(line + '\n共同步 ' + out.accounts + ' 个账号，新增 ' + out.imported + ' 篇，跳过 ' + out.skipped + ' 篇，失败 ' + out.failed + ' 篇。');
    } finally { store.close(); }
    return;
  }
  if (command === 'import') {
    const url = flag('url');
    if (!url) throw new Error('import 需要 --url');
    const out = await handleWechat({method: 'POST', pathname: 'articles/import', dir: dataDir, body: {url, text: flag('text'), school: flag('school')}});
    console.log(JSON.stringify(out.json, null, 2));
    return;
  }
  if (command === 'subscribe') {
    const id = flag('account');
    const feed = flag('feed') || flag('url');
    if (!id) throw new Error('subscribe 需要 --account <账号 id>');
    const store = WeChatStore.open(join(dataDir, 'wechat.db'));
    try {
      if (!store.getAccount(id)) throw new Error('账号不存在：' + id);
      const account = store.setSubscription(id, feed);
      console.log(account.feedUrl ? '已保存订阅页：' + account.name + ' → ' + account.feedUrl : '已取消订阅：' + account.name);
    } finally { store.close(); }
    return;
  }
  if (command === 'discover') {
    const url = flag('url'), text = flag('text');
    if (!url && !text) throw new Error('discover 需要 --url 或 --text');
    const out = await handleWechat({method: 'POST', pathname: 'discover', dir: dataDir, body: {url, text, school: flag('school')}});
    console.log(JSON.stringify(out.json, null, 2));
    return;
  }
  if (command === 'publish-all') {
    const store = WeChatStore.open(join(dataDir, 'wechat.db'));
    try {
      let ok = 0, skipped = 0;
      for (const article of store.listArticles({limit: 500})) {
        if (article.eventId) { skipped++; continue; }
        const out = await publishArticle({dir: dataDir, articleId: article.id, store, audit: {userId: 'cli', actorType: 'cli'}});
        if (out.ok) { ok++; console.log('✔ ' + article.title.slice(0, 40) + ' → ' + out.event.id); }
        else { skipped++; console.log('· ' + article.title.slice(0, 40) + '：' + out.reason); }
      }
      console.log(line + '\n生成 ' + ok + ' 场活动，跳过 ' + skipped + ' 篇。');
    } finally { store.close(); }
    return;
  }
  if (command === 'purge-demo') {
    const store = WeChatStore.open(join(dataDir, 'wechat.db'));
    let articles = 0, events = 0;
    try {
      articles = store.purgeDemoData();
      events = purgeDemoRecruitEvents({dir: dataDir, userId: 'cli', actorType: 'cli'}).removed;
    } finally { store.close(); }
    console.log('已清理演示文章 ' + articles + ' 条、演示活动 ' + events + ' 条。');
    return;
  }
  console.log(`职向 · 公众号管线

  node src/wechat/cli.mjs report                 账号/文章/订阅报告
  node src/wechat/cli.mjs sync [--account id] [--limit 5] [--publish]
  node src/wechat/cli.mjs import --url <链接> [--text 正文]
  node src/wechat/cli.mjs subscribe --account <id> --feed <订阅页 URL>
  node src/wechat/cli.mjs discover --url <来源页> | --text <HTML/正文>
  node src/wechat/cli.mjs publish-all            把已识别招聘信息的文章写成活动/项目
  node src/wechat/cli.mjs purge-demo             清理 example.com 演示数据

  可选：--data <目录> 指定数据目录`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
