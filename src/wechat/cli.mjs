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
import {readFileSync, existsSync} from 'node:fs';
import {WeChatStore} from './store.mjs';
import {handleWechat} from './api.mjs';
import {publishArticle} from './publish.mjs';
import {syncSubscriptions} from './subscribe.mjs';
import {RecruitStore} from '../recruit/store.mjs';
import {resolveDataDir} from '../config/paths.mjs';

const argv = process.argv.slice(2);
const command = argv[0] || 'help';
const flag = name => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : ''; };
const dataDir = resolve(flag('data') || defaultDataDir());
const line = '─'.repeat(66);

function defaultDataDir() {
  const base = resolveDataDir();
  try {
    const accounts = JSON.parse(readFileSync(join(base, 'accounts.json'), 'utf8'));
    if (accounts.length === 1) {
      const dir = join(base, 'users', accounts[0].id, '.data');
      if (existsSync(dir)) return dir;
    }
  } catch { /* 还没初始化 */ }
  return base;
}

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
      const out = await syncSubscriptions({store, accounts, dir: dataDir, limit: Number(flag('limit') || 5), publish: argv.includes('--publish'), onLog: e => console.log('· ' + e.text)});
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
        const out = await publishArticle({dir: dataDir, articleId: article.id, store});
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
      const rs = RecruitStore.open(join(dataDir, 'recruit.db'));
      try {
        const res = rs.db.prepare("DELETE FROM events WHERE source_url LIKE '%example.com/%' OR source_url LIKE '%example.org/%' OR source_url LIKE '%example.net/%'").run();
        events = Number(res.changes) || 0;
      } finally { rs.close(); }
    } finally { store.close(); }
    console.log('已清理演示文章 ' + articles + ' 条、演示活动 ' + events + ' 条。');
    return;
  }
  console.log(`职向 · 公众号管线

  node src/wechat/cli.mjs report                 账号/文章/订阅报告
  node src/wechat/cli.mjs sync [--account id] [--limit 5] [--publish]
  node src/wechat/cli.mjs import --url <链接> [--text 正文]
  node src/wechat/cli.mjs discover --url <来源页> | --text <HTML/正文>
  node src/wechat/cli.mjs publish-all            把已识别招聘信息的文章写成活动/项目
  node src/wechat/cli.mjs purge-demo             清理 example.com 演示数据

  可选：--data <目录> 指定数据目录`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
