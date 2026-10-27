import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SOURCES, REMOVED_SOURCES, sourceById, enabledSources, CATEGORIES} from '../src/recruit/sources/index.mjs';
import {collectSource, htmlToText} from '../src/recruit/collect.mjs';
import uibe, {decryptUibePayload, parseUibePageMeta, parseUibeListJson, parseUibeListHtml, parseUibeDetail, nextUibePage, collectUibePages} from '../src/recruit/sources/uibe.mjs';
import swjtu from '../src/recruit/sources/swjtu.mjs';
import {RecruitStore} from '../src/recruit/store.mjs';

test('源注册表：自动发现 13 个源，id 唯一；默认自动采集 8 个（对外经贸待 robots 确认）', () => {
  assert.equal(SOURCES.length, 13);
  const ids = SOURCES.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(SOURCES.filter(s => s.enabled).length, 10, '24365/国聘作为 browser 源开放；对外经贸默认关闭等待 robots 确认');
  assert.equal(enabledSources().length, 8, '默认采集不包含需登录的人工源，也不含 robots 未确认的对外经贸');
  assert.equal(enabledSources().some(s => s.id === 'uibe-career'), false);
  assert.equal(sourceById('uibe-career').sourceCheck.enabled, true, '保留来源校对/解析器');
});

test('24365/国聘：browser 源骨架开放，但明确需登录/人工确认，不自动采集也不绕过登录', async () => {
  for (const id of ['ncss', 'iguopin']) {
    const source = sourceById(id);
    assert.equal(source.enabled, true, id + ' 应作为可用来源展示');
    assert.equal(source.mode, 'browser');
    assert.equal(source.loginRequired, true);
    assert.equal(source.manualConfirm, true);
    assert.equal(source.collectMode, 'manual');
    assert.equal(typeof source.parseList, 'function', 'browser 骨架保留 parseList 接缝');
    assert.match(source.note, /登录|人工/);
    assert.equal(source.capabilities.list, 'browser');
    const out = await collectSource(id, {dir: 'unused', persist: false});
    assert.equal(out.status, 'needs_login');
    assert.match(out.message, /登录|人工确认/);
  }
});

test('每个源字段完整，已接入的必须有 parseList', () => {
  for (const source of SOURCES) {
    assert.ok(source.id, '缺 id');
    assert.ok(source.name, source.id + ' 缺 name');
    assert.ok(source.school, source.id + ' 缺 school');
    assert.ok(source.listUrl, source.id + ' 缺 listUrl');
    assert.ok(['static', 'json', 'browser', 'rss', 'manual'].includes(source.mode), source.id + ' mode 无效');
    assert.ok(CATEGORIES.includes(source.category), source.id + ' category 无效');
    if (source.enabled) {
      assert.equal(typeof source.parseList, 'function', source.id + ' 已接入但没有 parseList');
    } else {
      assert.ok(source.note, source.id + ' 未接入但没有说明原因');
    }
    if (source.fetchProjects) {
      assert.equal(typeof source.fetchProjects, 'function', source.id + ' fetchProjects 不是函数');
    }
  }
});

test('按 id 查找与错误提示', () => {
  assert.equal(sourceById('scu-employ').school, '四川大学');
  assert.throws(() => sourceById('nope'), /未知信息源/);
});

test('Web 前端使用的目录元数据齐全', () => {
  const catalog = Object.fromEntries(SOURCES.map(s => [s.id, {category: s.category, channel: s.channel, fallback: s.fallback || '', note: s.note || ''}]));
  assert.equal(catalog['sufe-xjh'].category, '财经强校');
  assert.equal(catalog['cufe-scc'].fallback.length > 0, true);
});

test('已下线来源墓碑：南开/中山源码已移除但谱系保留', () => {
  assert.equal(REMOVED_SOURCES.length, 2);
  assert.deepEqual(REMOVED_SOURCES.map(s => s.id).sort(), ['nankai-recruitment', 'sysu-home']);
  for (const s of REMOVED_SOURCES) {
    assert.equal(s.enabled, false);
    assert.ok(s.name && s.school && s.listUrl);
    assert.ok(!SOURCES.some(x => x.id === s.id), s.id + ' 不应同时出现在当前注册表');
  }
});

const swjtuCalendar = JSON.parse(readFileSync(new URL('./fixtures/swjtu-calendar.json', import.meta.url), 'utf8'));

test('西南交大：日历 JSON 按北京时间过滤过去场次，未来场次保留', () => {
  const items = swjtu.parseList('', {...swjtu, today: '2026-10-27'}, swjtuCalendar);
  assert.deepEqual(items.map(item => item.title), [
    '中国电科2027届校园招聘宣讲会',
    '中国中车2027届双选会',
    '京东方2027届校园招聘宣讲会'
  ]);
  assert.equal(items[0].startAt, '2026-10-27T19:00:00+08:00');
  assert.equal(items[0].venue, '九里校区大学生会堂');
  assert.equal(items[0].url, 'https://jiuye.swjtu.edu.cn/career/index/common/jyrlDetail?type=xjh&id=1002');
  assert.equal(items[0].kind, '宣讲会');
  assert.equal(items[1].kind, '双选会');
  assert.equal(items[1].url, 'https://jiuye.swjtu.edu.cn/career/index/common/jyrlDetail?type=zph&id=1003');
  assert.ok(!items.some(item => item.title.includes('中国中铁')), '过去场次不应入库');

  const later = swjtu.parseList('', {...swjtu, today: '2026-11-01'}, swjtuCalendar);
  assert.deepEqual(later.map(item => item.title), ['中国中车2027届双选会', '京东方2027届校园招聘宣讲会']);
});

const uibeFixture = name => readFileSync(new URL('./fixtures/uibe/' + name, import.meta.url), 'utf8');
const uibeList = JSON.parse(uibeFixture('list-page1.json'));
const uibeListHtml = uibeFixture('list-page1.html');
const uibeDetailHtml = uibeFixture('detail.html');

test('对外经贸：列表每页 20 条、共 202 页，字段完整且 source_url 指向详情', () => {
  assert.deepEqual(parseUibePageMeta(uibeList), {curPage: 1, pageCount: 202, totalRecords: 4023});
  const items = parseUibeListJson(uibeList, uibe);
  assert.equal(items.length, 20);
  const first = items[0];
  assert.equal(first.title, '中化能源股份有限公司2027年校园宣讲会');
  assert.equal(first.company, '中化石油有限公司');
  assert.equal(first.startAt, '2026-10-27T18:30:00+08:00');
  assert.equal(first.endAt, '2026-10-27T20:30:00+08:00');
  assert.equal(first.venue, '求真楼319');
  assert.equal(first.city, '北京');
  assert.equal(first.kind, '宣讲会');
  assert.equal(first.url, 'https://career.uibe.edu.cn/front/zph.jspa?tid=2101594239258345474');
  for (const item of items) {
    assert.ok(item.title, '缺标题');
    assert.ok(item.company, '缺单位：' + item.title);
    assert.ok(item.venue, '缺地点：' + item.title);
    assert.match(item.startAt, /^2026-\d{2}-\d{2}T\d{2}:\d{2}:00\+08:00$/, '时间格式错误：' + item.startAt);
    assert.match(item.url, /^https:\/\/career\.uibe\.edu\.cn\/front\/zph\.jspa\?tid=\d+$/, 'source_url 应指向详情：' + item.url);
  }
});

test('对外经贸：列表响应按站点公开密钥解密，解不开时给出可诊断原因', () => {
  const json = decryptUibePayload(uibeFixture('list-page1.cipher.txt'));
  assert.equal(json.msg, 'Y');
  assert.equal(json.pageCount, 202);
  assert.equal(json.data.length, 20);
  assert.equal(parseUibeListJson(json, uibe)[0].company, '中化石油有限公司');
  assert.deepEqual(parseUibeListJson({data: [{title: '缺少开始时间', name: '某公司'}]}, uibe), [], '缺时间不补默认值');
  assert.throws(() => decryptUibePayload('这不是密文'), /解密|JSON/);
});

test('对外经贸：分页边界、空页停止与逐页限速', async () => {
  assert.equal(nextUibePage({curPage: 1, pageCount: 202, fetched: 0, limit: 20, pageItems: 20}), 2);
  assert.equal(nextUibePage({curPage: 202, pageCount: 202, fetched: 0, limit: 20, pageItems: 20}), null, '最后一页不再翻');
  assert.equal(nextUibePage({curPage: 1, pageCount: 202, fetched: 20, limit: 20, pageItems: 20}), null, '达到条数上限即停');
  assert.equal(nextUibePage({curPage: 1, pageCount: 202, fetched: 0, limit: 20, pageItems: 0}), null, '空页即停');

  const makePage = n => ({
    ...uibeList,
    curPage: n,
    pageCount: 5,
    data: uibeList.data.slice(0, 2).map((row, i) => ({...row, tid: n * 100 + i, title: '第' + n + '页活动' + i}))
  });
  const calls = [];
  let sleeps = 0;
  const result = await collectUibePages({
    source: uibe, limit: 5, delayMs: 1,
    sleep: async () => { sleeps++; },
    loadPage: async n => { calls.push(n); return makePage(n); }
  });
  assert.deepEqual(calls, [1, 2, 3]);
  assert.equal(result.items.length, 5);
  assert.equal(result.pages, 3);
  assert.equal(result.pageCount, 5);
  assert.equal(result.stopped, 'limit');
  assert.equal(sleeps, 2, '只在页与页之间等待');

  const emptyCalls = [];
  const empty = await collectUibePages({
    source: uibe, limit: 20,
    loadPage: async n => {
      emptyCalls.push(n);
      return n === 1 ? makePage(1) : {...uibeList, curPage: n, pageCount: 5, data: []};
    }
  });
  assert.deepEqual(emptyCalls, [1, 2]);
  assert.equal(empty.items.length, 2);
  assert.equal(empty.stopped, 'empty');
});

test('对外经贸：详情解析单位/地点/时间/正文，未知字段不编造', () => {
  const extra = parseUibeDetail(htmlToText(uibeDetailHtml), {});
  assert.equal(extra.company, '中化石油有限公司');
  assert.equal(extra.venue, '求真楼319');
  assert.equal(extra.date, '2026-10-27');
  assert.equal(extra.startTime, '18:30');
  assert.equal(extra.endTime, '20:30');
  assert.match(extra.rawText, /中化能源是中国中化/);
  assert.doesNotMatch(extra.rawText, /当前位置|友情链接/);

  const missing = parseUibeDetail('这里没有结构化字段', {});
  assert.equal(missing.company || '', '');
  assert.equal(missing.venue || '', '');
  assert.equal(missing.date || '', '');
  assert.equal(missing.rawText || '', '');

  const footer = parseUibeDetail('招聘单位：某公司\n地点：\n办公地点：北京市朝阳区惠新东街10号', {});
  assert.equal(footer.venue || '', '', '不能把页脚办公地点当成活动地点');
  assert.equal(footer.company, '某公司');
});

test('对外经贸：渲染列表 HTML 可解析，缺年份时不伪造日期', () => {
  const items = parseUibeListHtml(uibeListHtml, uibe, {year: 2026});
  assert.equal(items.length, 20);
  assert.equal(items[0].title, '中化能源股份有限公司2027年校园宣讲会');
  assert.equal(items[0].venue, '求真楼319');
  assert.equal(items[0].startAt, '2026-10-27T18:30:00+08:00');
  assert.equal(items[0].company, '', '列表未给单位名，不凭空生成');
  assert.equal(items[0].url, 'https://career.uibe.edu.cn/front/zph.jspa?tid=2101594239258345474');

  const noYear = parseUibeListHtml(uibeListHtml, uibe);
  assert.equal(noYear.length, 20);
  assert.equal(noYear[0].startAt, '', '页面没有年份，不拿当前年份冒充');
  assert.match(noYear[0].notes, /年份/);

  // 页面别处出现 ISO 日期也不能拿来猜年份；列表没有时间也不能伪造 09:00。
  const html = '<ul id="zph-list-content"><li><span class="create-time">10月27日</span><a href="/front/zph.jspa?tid=1">中化能源宣讲会</a></li></ul><div>更新时间 2026-10-20</div>';
  const guessed = parseUibeListHtml(html, uibe);
  assert.equal(guessed[0].startAt, '', '不能从页面其他日期猜年份');
  assert.match(guessed[0].notes, /年份/);
  const noClockHtml = '<ul id="zph-list-content"><li><span class="create-time">10月27日</span><a href="/front/zph.jspa?tid=1">中化能源宣讲会</a></li></ul>';
  const noClock = parseUibeListHtml(noClockHtml, uibe, {year: 2026});
  assert.equal(noClock[0].startAt, '', '缺具体时间就留空，不能伪造 09:00');
  assert.match(noClock[0].notes, /具体时间/);
});

test('对外经贸：默认关闭自动采集（页面 JS 仍 POST robots 禁止的接口），解析器齐全', () => {
  assert.equal(uibe.enabled, false, 'robots 未人工确认前不能默认自动采集');
  assert.match(uibe.note, /robots/, '必须标注需人工确认 robots');
  assert.equal(uibe.detailDelayMs, 1200, '详情抓取间隔 1.2s');
  assert.match(uibe.note, /20 条|202 页/, '保留每页 20/共 202 页的说明');
  assert.equal(uibe.mode, 'browser');
  assert.equal(uibe.capabilities.list, 'browser');
  assert.equal(uibe.capabilities.detail, 'http');
  assert.equal(typeof uibe.parseList, 'function');
  assert.equal(typeof uibe.fetchList, 'function');
  assert.equal(typeof uibe.parseDetail, 'function');
  assert.equal(uibe.detailAll, true, '列表不含正文，详情需要逐条核对');
  assert.match(uibe.listUrl, /\/front\/channel\.jspa\?channelId=766&parentId=625$/);
  assert.equal(uibe.sourceCheck.enabled, true);
});

test('对外经贸：接入采集器后一次采集 3 条，单位和正文来自详情页', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/robots.txt') return res.end('User-agent: *\nAllow: /\n');
    if (req.url.startsWith('/front/zph.jspa?tid=')) {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end('<!doctype html><html><body>' + uibeDetailHtml + '</body></html>');
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const dir = await mkdtemp(join(tmpdir(), 'zx-uibe-collect-'));
  try {
    const detail = parseUibeListJson(uibeList, uibe).slice(0, 3).map(item => {
      const parsed = new URL(item.url);
      return {...item, url: base + parsed.pathname + parsed.search};
    });
    const source = {...uibe, id: 'uibe-test', enabled: true, listUrl: base + '/list', fetchList: async () => ({items: detail, pageCount: 202, pages: 1})};
    const result = await collectSource(source, {dir, limit: 3, detailLimit: 3});
    assert.equal(result.status, 'connected', result.message);
    assert.equal(result.created, 3);
    const store = RecruitStore.open(join(dir, 'recruit.db'));
    try {
      const events = store.listEvents({from: '2026-10-01T00:00:00+08:00', to: '2026-12-01T00:00:00+08:00'});
      assert.equal(events.length, 3);
      for (const event of events) {
        assert.ok(event.company, '缺单位');
        assert.ok(event.venue, '缺地点');
        assert.match(event.startAt, /^2026-10-\d{2}T\d{2}:\d{2}:00\+08:00$/);
        assert.match(event.sourceUrl, /\/front\/zph\.jspa\?tid=\d+$/);
        assert.match(event.rawText, /中化能源是中国中化/, '正文应来自详情页');
      }
    } finally { store.close(); }
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, {recursive: true, force: true});
  }
});