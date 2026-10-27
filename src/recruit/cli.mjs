#!/usr/bin/env node
// 命令行入口：适合放进计划任务（Windows 任务计划程序 / cron）做每日采集。
// 用法：
//   node recruit/cli.mjs sources
//   node recruit/cli.mjs collect --source scu-employ --limit 20
//   node recruit/cli.mjs list --days 30
//   node recruit/cli.mjs export --format ics --out schedule.ics
//   node recruit/cli.mjs probe
//   node recruit/cli.mjs verify
import {join, resolve} from 'node:path';
import {writeFileSync} from 'node:fs';
import {SOURCES, REMOVED_SOURCES, sourceById} from './sources/index.mjs';
import {runCollection, collectSource} from './collect.mjs';
import {RecruitStore} from './store.mjs';
import {buildSchedule, toICS, toCSV, toMarkdown} from './schedule.mjs';
import {fetchText} from './fetch.mjs';
import {verifyEvent, verifyNeedsSourceUrl} from './verify.mjs';
import {defaultUserDataDir} from '../config/paths.mjs';

const argv = process.argv.slice(2);
const command = argv[0] || 'help';
const flag = name => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : ''; };
const many = name => argv.reduce((acc, v, i) => (v === '--' + name && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);
const days = Number(flag('days') || 30);
const dataDir = resolve(flag('data') || defaultUserDataDir());
const openStore = () => { const s = RecruitStore.open(join(dataDir, 'recruit.db')); s.syncSources(SOURCES, REMOVED_SOURCES); return s; };
const line = '─'.repeat(66);

function fmt(iso) {
  if (!iso) return '';
  const d = new Date(new Date(iso).getTime() + 8 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

if (command === 'sources') {
  const store = openStore();
  const states = store.sourceStates();
  console.log('信息源清单（按类别）\n' + line);
  let category = '';
  for (const s of states) {
    if (s.category !== category) { category = s.category; console.log('\n【' + category + '】'); }
    const flagText = s.orphaned ? '来源已下线' : (s.enabled ? (s.last_status ? '最近：' + s.last_status : '已接入') : '未接入');
    console.log(` ${s.id.padEnd(18)} ${s.name.padEnd(28)} ${String(flagText).padEnd(12)} ${s.mode}`);
    if (!s.enabled && s.note) console.log(`   └ ${s.note}`);
  }
  console.log('\n' + line + `\n共 ${states.length} 个源，已接入 ${states.filter(s => s.enabled).length} 个。`);
  store.close();
} else if (command === 'collect') {
  const ids = many('source');
  const requested = Number(flag('limit'));
  const limit = Number.isFinite(requested) && requested > 0 ? requested : undefined;
  const result = await runCollection({dir: dataDir, sourceIds: ids, limit, onLog: e => console.log('· ' + e.text)});
  console.log('\n' + line);
  for (const r of result.results) console.log(`${(r.status || '').padEnd(10)} ${String(r.id).padEnd(18)} 新增 ${r.created}  更新 ${r.updated}  ${r.message || ''}`);
  console.log(line + `\n合计：${result.totals.created} 条新增，${result.totals.updated} 条更新，${result.totals.failed} 个源失败。`);
} else if (command === 'list') {
  const store = openStore();
  const from = new Date().toISOString().slice(0, 10) + 'T00:00:00+08:00';
  const to = new Date(Date.now() + days * 86400000).toISOString();
  const events = store.listEvents({from, to, limit: 300});
  const schedule = buildSchedule(events);
  console.log(toMarkdown(schedule, {title: `线下招聘时间安排表（未来 ${days} 天）`}));
  store.close();
} else if (command === 'export') {
  const format = (flag('format') || 'ics').toLowerCase();
  const out = flag('out') || ('schedule.' + format);
  const store = openStore();
  const from = new Date().toISOString().slice(0, 10) + 'T00:00:00+08:00';
  const to = new Date(Date.now() + days * 86400000).toISOString();
  const events = store.listEvents({from, to, limit: 500});
  const body = format === 'ics' ? toICS(events) : format === 'csv' ? toCSV(events) : toMarkdown(buildSchedule(events));
  await writeFileSync(out, body, 'utf8');
  console.log(`已导出 ${events.length} 场活动 → ${resolve(out)}`);
  store.close();
} else if (command === 'probe') {
  console.log('逐源连通性检查（GET 列表页）\n' + line);
  for (const source of SOURCES) {
    const t = Date.now();
    const res = await fetchText(source.listUrl, {method: source.request?.method || 'GET', headers: source.request?.headers, body: source.request?.body, timeout: 15000, retries: 0});
    const state = res.ok ? '可访问' : res.reason;
    console.log(`${state.padEnd(14)} ${String(res.status).padEnd(4)} ${source.id.padEnd(18)} ${Date.now() - t}ms ${res.message || ''}`);
  }
} else if (command === 'verify') {
  const store = openStore();
  const events = store.listEvents({from: new Date().toISOString().slice(0, 10), to: new Date(Date.now() + 90 * 86400000).toISOString(), limit: 100});
  let ok = 0, bad = 0;
  for (const e of events) {
    if (!e.sourceUrl && verifyNeedsSourceUrl(e.sourceId)) continue;
    let source;
    try { source = sourceById(e.sourceId); } catch { source = {id: e.sourceId || 'unknown', listUrl: e.sourceUrl}; }
    const r = await verifyEvent(source, e);
    store.setVerified(e.id, r.ok ? 1 : 0, r.reason);
    if (r.ok) ok++; else bad++;
    console.log(`${r.ok ? '✔' : '✘'} ${fmt(e.startAt)} ${e.school} ${e.title.slice(0, 30)}  ${r.reason}`);
  }
  console.log(`\n复核完成：${ok} 条仍然有效，${bad} 条需人工确认。`);
  store.close();
} else {
  console.log(`职向 · 招聘信息采集工具

  node recruit/cli.mjs sources                         查看信息源
  node recruit/cli.mjs probe                           检查各源是否可访问
  node recruit/cli.mjs collect [--source id]... [--limit N]
  node recruit/cli.mjs list [--days 30]                打印时间安排表
  node recruit/cli.mjs export --format ics|csv|md --days 30 --out schedule.ics
  node recruit/cli.mjs verify                          复核来源链接是否仍有效

  可选：--data <目录> 指定数据目录（默认 .data）
  示例：node recruit/cli.mjs collect --source scu-employ --source sufe-xjh --limit 15`);
}
