// 来源校验 v2（#46）：按源适配的复核策略。
// 现状：verify 对所有源一律 fetchText(详情页) + 标题子串，SPA/共用列表 URL 的源被误标「来源页面已变化」。
// 目标：swjtu/sufe/sicau 走各自 JSON 列表接口（按事件日期/页码取回并匹配）；uestc 无独立详情 URL 走列表级复核；
//       四种失败原因可区分：页面变化 / JS 壳无法字符串校验 / 无独立详情 URL / 真失效。
import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceById} from '../src/recruit/sources/index.mjs';
import {verifyEvent, VERIFY_CATEGORY} from '../src/recruit/verify.mjs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RecruitStore} from '../src/recruit/store.mjs';

const TITLE = '中国石化集团胜利石油管理局有限公司2027校园招聘宣讲会';

// 默认详情页策略用的静态源（不在按源适配清单里）。
const detailSource = sourceById('scu-employ');

function eventFor(source, over = {}) {
  return {
    id: 'a'.repeat(24),
    sourceId: source.id,
    school: source.school,
    city: source.city,
    kind: source.kind || '宣讲会',
    title: TITLE,
    startAt: '2026-10-26T09:20:00+08:00',
    sourceUrl: 'https://jy.scu.edu.cn/index/index/employdetail.html?data=abc',
    ...over
  };
}

const fetchOk = text => async () => ({ok: true, status: 200, text});
const fetchFail = (msg, status = 0, reason = 'dns_failed') => async () => ({ok: false, status, reason, message: msg});

test('默认详情页：正文包含标题 → ok', async () => {
  const src = detailSource;
  const event = eventFor(src);
  const r = await verifyEvent(src, event, {fetchText: fetchOk('<div>' + TITLE + '</div><div>地点：望江校区</div>')});
  assert.equal(r.ok, true);
  assert.equal(r.category, VERIFY_CATEGORY.OK);
  assert.equal(r.reason, '来源页面仍包含该活动');
});

test('默认详情页：正文不含标题且页面有实质内容 → 页面变化', async () => {
  const src = detailSource;
  const event = eventFor(src);
  const r = await verifyEvent(src, event, {fetchText: fetchOk('<div>这里是就业网首页，有大量导航与其它活动，但没有这一场。</div>' + '内容'.repeat(200))});
  assert.equal(r.ok, false);
  assert.equal(r.category, VERIFY_CATEGORY.PAGE_CHANGED);
  assert.equal(r.reason, '来源页面已变化：未找到该活动');
});

test('默认详情页：JS 壳（几乎无可见文字）→ 无法字符串校验', async () => {
  const src = detailSource;
  const event = eventFor(src);
  const r = await verifyEvent(src, event, {fetchText: fetchOk('<div id="app"></div>')});
  assert.equal(r.ok, false);
  assert.equal(r.category, VERIFY_CATEGORY.JS_SHELL);
  assert.equal(r.reason, '详情页为 JS 渲染，无法字符串校验，请用浏览器人工确认');
});

test('默认详情页：404/410 才是真失效', async () => {
  const src = detailSource;
  const event = eventFor(src);
  for (const [status, reason] of [[404, 'http_error'], [410, 'http_error']]) {
    const r = await verifyEvent(src, event, {fetchText: fetchFail('HTTP ' + status, status, reason)});
    assert.equal(r.ok, false);
    assert.equal(r.category, VERIFY_CATEGORY.GONE, status + ' 才可判 GONE');
    assert.match(r.reason, /^来源链接已失效/);
  }
});

test('默认详情页：超时/429/5xx/DNS/网络错误是可重试的 transient，不误判 GONE', async () => {
  const src = detailSource;
  const event = eventFor(src);
  const cases = [
    {status: 0, reason: 'timeout', message: '请求超时：站点响应慢'},
    {status: 429, reason: 'rate_limited', message: 'HTTP 429：too many requests'},
    {status: 502, reason: 'server_error', message: 'HTTP 502：bad gateway'},
    {status: 503, reason: 'server_error', message: 'HTTP 503：unavailable'},
    {status: 0, reason: 'dns_failed', message: '域名解析失败：站点可能已迁移'},
    {status: 0, reason: 'network_error', message: '网络错误：socket hang up'},
    {status: 0, reason: 'refused', message: '连接被拒绝'}
  ];
  for (const item of cases) {
    const r = await verifyEvent(src, event, {fetchText: fetchFail(item.message, item.status, item.reason)});
    assert.equal(r.ok, false, item.reason);
    assert.equal(r.category, VERIFY_CATEGORY.TRANSIENT_ERROR, item.reason + ' 不能判 GONE');
    assert.equal(r.retryable, true);
    assert.match(r.reason, /可重试/);
  }
});

test('上财：走 JSON 列表接口，按 URL 命中 → ok；未命中 → 页面变化', async () => {
  const src = sourceById('sufe-xjh');
  const url = 'https://career.sufe.edu.cn/career/xjhxx/view/123';
  const event = eventFor(src, {sourceUrl: url, title: '中国光大银行上海分行2027年秋季校园招聘宣讲会'});
  const json = {code: 200, data: {list: [{xjhid: '123', xjhzt: event.title, dwmc: '中国光大银行', jbrq: '2026-10-23', jbsjdmc: '15:00-17:00', cddz: '武东路校区', szsmc: '上海市', hyyjmc: '金融业', rsgmmc: '10000人以上'}]}};
  const hit = await verifyEvent(src, event, {fetchText: fetchOk(JSON.stringify(json))});
  assert.equal(hit.ok, true);
  assert.equal(hit.category, VERIFY_CATEGORY.OK);
  assert.equal(hit.reason, '来源接口仍包含该活动');

  const miss = await verifyEvent(src, event, {fetchText: fetchOk(JSON.stringify({code: 200, data: {list: []}}))});
  assert.equal(miss.ok, false);
  assert.equal(miss.category, VERIFY_CATEGORY.PAGE_CHANGED);
});

test('川农：走 JSON 列表接口，按 URL（id 参数）命中', async () => {
  const src = sourceById('sicau-xjh');
  const url = 'https://job.sicau.edu.cn/employment/zpxx/xyxjh/meeting_details/index.html?id=999&enid=&postid=';
  const event = eventFor(src, {sourceUrl: url});
  const json = {data: [{recruitmentId: 999, title: TITLE, entName: '中国石化', beginDate: '2026-10-26 09:20', endDate: '2026-10-26 11:20', place: '成都校区', schoolBranch: 2}]};
  const r = await verifyEvent(src, event, {fetchText: fetchOk(JSON.stringify(json))});
  assert.equal(r.ok, true);
  assert.equal(r.category, VERIFY_CATEGORY.OK);
});

test('西南交大：按事件日期 POST 日历接口，命中 → ok', async () => {
  const src = sourceById('swjtu-xjh');
  const url = 'https://jiuye.swjtu.edu.cn/career/abc123';
  const day = new Date(Date.now() + 8 * 3600 * 1000 + 3 * 86400000).toISOString().slice(0, 10);
  const event = eventFor(src, {sourceUrl: url, startAt: day + 'T09:20:00+08:00'});
  let seen = null;
  const fetchText = async (u, opts) => {
    seen = {u, method: opts.method, body: opts.body};
    const json = {data: [{con: [{mark: day + ' 09:20', a: '/abc123', xjhzt: TITLE, cdmc: '犀浦校区'}]}]};
    return {ok: true, status: 200, text: JSON.stringify(json)};
  };
  const r = await verifyEvent(src, event, {fetchText});
  assert.equal(r.ok, true);
  assert.equal(r.category, VERIFY_CATEGORY.OK);
  assert.equal(seen.body, 'date=' + day, '应按事件日期请求日历，而不是今天');
});

test('电子科大：无独立详情 URL，列表级复核命中/未命中', async () => {
  const src = sourceById('uestc-xjh');
  const event = eventFor(src, {sourceUrl: 'https://jiuye.uestc.edu.cn/career/', startAt: '2026-10-08T09:30:00+08:00', title: '中国工程物理研究院宣讲会'});
  let seenUrl = '';
  const fetchText = async (u) => {
    seenUrl = u;
    const json = {code: 200, data: {onSiteCalendar: {data: {'2026-10-08': {data: [{recruitmentDate: '2026-10-08 09:30:00', companyName: '中国工程物理研究院', title: '中国工程物理研究院宣讲会', endTime: '11:30:00', recruitmentLocation: '清水河校区'}]}}}}};
    return {ok: true, status: 200, text: JSON.stringify(json)};
  };
  const hit = await verifyEvent(src, event, {fetchText});
  assert.equal(hit.ok, true);
  assert.equal(hit.category, VERIFY_CATEGORY.OK);
  assert.equal(hit.reason, '无独立详情 URL，列表级复核仍包含该活动');
  assert.match(seenUrl, /month=2026-10/);

  const missJson = JSON.stringify({code: 200, data: {onSiteCalendar: {data: {}}}});
  const miss = await verifyEvent(src, event, {fetchText: fetchOk(missJson)});
  assert.equal(miss.ok, false);
  assert.equal(miss.category, VERIFY_CATEGORY.NO_DETAIL_URL);
  assert.equal(miss.reason, '无独立详情 URL，列表级复核未找到该活动');
});

test('西南石油双选会：走 JSON 列表接口，按 URL 命中', async () => {
  const src = sourceById('swpu-jobfair');
  const url = 'https://jyzx.swpu.edu.cn/detail/jobfair?id=888';
  const event = eventFor(src, {sourceUrl: url, kind: '双选会', title: '西南石油大学2027届毕业生秋季双选会'});
  const json = {code: 1, data: {list: [{fair_id: 888, title: event.title, meet_day: '2026-10-26', meet_time: '09:00:00'}]}};
  const r = await verifyEvent(src, event, {fetchText: fetchOk(JSON.stringify(json))});
  assert.equal(r.ok, true);
  assert.equal(r.category, VERIFY_CATEGORY.OK);
});


function makeEvent(source, over = {}) {
  return {
    id: 'a'.repeat(24),
    sourceId: source.id,
    school: source.school,
    city: source.city,
    kind: source.kind || '宣讲会',
    title: over.title || TITLE,
    company: '',
    startAt: over.startAt || '2026-10-26T09:20:00+08:00',
    endAt: '',
    venue: '',
    sourceUrl: over.sourceUrl || 'https://jy.scu.edu.cn/index/index/employdetail.html?data=abc',
    fetchedAt: new Date().toISOString(),
    confidence: 0.6
  };
}

test('四类失败原因经 setVerified 写入库后 notes 可区分', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zx-verify-'));
  try {
    const store = RecruitStore.open(join(dir, 'recruit.db'));
    const verify = async (source, event, fetchText) => {
      const r = await verifyEvent(source, event, {fetchText});
      store.setVerified(event.id, r.ok ? 1 : 0, r.reason);
      return store.getEvent(event.id);
    };

    const detail = makeEvent(detailSource);
    store.upsertEvent(detail);
    assert.equal((await verify(detailSource, detail, fetchFail('HTTP 404', 404, 'http_error'))).notes, '来源链接已失效：HTTP 404');
    const transient = await verify(detailSource, detail, fetchFail('请求超时：站点响应慢', 0, 'timeout'));
    assert.match(transient.notes, /可重试/);
    assert.equal(transient.verified, false);
    assert.equal((await verify(detailSource, detail, fetchOk('<div>其它活动</div>' + '内容'.repeat(200)))).notes, '来源页面已变化：未找到该活动');
    assert.equal((await verify(detailSource, detail, fetchOk('<div id="app"></div>'))).notes, '详情页为 JS 渲染，无法字符串校验，请用浏览器人工确认');

    const uestc = sourceById('uestc-xjh');
    const uEvent = makeEvent(uestc, {sourceUrl: 'https://jiuye.uestc.edu.cn/career/', title: '中国工程物理研究院宣讲会'});
    store.upsertEvent(uEvent);
    const noDetail = await verify(uestc, uEvent, fetchOk(JSON.stringify({code: 200, data: {onSiteCalendar: {data: {}}}})));
    assert.equal(noDetail.notes, '无独立详情 URL，列表级复核未找到该活动');
    assert.equal(noDetail.verified, false);
    store.close();
  } finally { await rm(dir, {recursive: true, force: true}); }
});
