import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {extractDraft, parseArticleHtml, parseManualInput} from '../src/recruit/manual.mjs';
import {handleRecruit} from '../src/recruit/api.mjs';
import {RecruitStore} from '../src/recruit/store.mjs';

const SAMPLE = '某银行2027届校园招聘宣讲会\n时间：2026年11月5日 14:30\n地点：四川大学望江校区就业中心\n现场面试，无领导小组讨论。';

test('手动解析：日期、时间、地点、类型、投递方式', () => {
  const d = extractDraft({text: SAMPLE});
  assert.equal(d.title, '某银行2027届校园招聘宣讲会');
  assert.equal(d.startAt, '2026-11-05T14:30:00+08:00');
  assert.equal(d.venue, '四川大学望江校区就业中心');
  assert.equal(d.kind, '宣讲会');
  assert.deepEqual(d.warnings, []);
});

test('手动解析：就业指导/培训类型', () => {
  const d = extractDraft({text: '简历门诊：一对一简历指导\n2026年11月8日 19:00\n地点：学生活动中心 302'});
  assert.equal(d.kind, '就业指导');
  assert.equal(d.startAt, '2026-11-08T19:00:00+08:00');
});

test('公众号 HTML：标题与正文提取', () => {
  const html = `<html><head><meta property="og:title" content="某集团宣讲会"></head>
    <body><h1 class="rich_media_title">某集团宣讲会</h1><div id="js_content"><p>时间：2026年12月1日 10:00</p><p>地点：就业中心 101</p></div></body></html>`;
  const p = parseArticleHtml(html);
  assert.equal(p.title, '某集团宣讲会');
  assert.match(p.text, /就业中心 101/);
});

test('手动解析：正文太短给出提示', async () => {
  const r = await parseManualInput({text: '太短'});
  assert.match(r.error, /至少/);
});

test('API：解析草稿 → 确认保存 → 写入招聘库并识别面试环节', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zx-manual-'));
  try {
    const parsed = await handleRecruit({method: 'POST', pathname: 'manual/parse', body: {text: SAMPLE}, dir});
    assert.equal(parsed.status || 200, 200);
    assert.ok(parsed.json.draft.title);
    const draft = parsed.json.draft;
    const saved = await handleRecruit({
      method: 'POST', pathname: 'manual/save',
      body: {...draft, school: '四川大学', rawText: SAMPLE, sourceUrl: 'https://mp.weixin.qq.com/s/demo'},
      dir
    });
    assert.equal(saved.status || 200, 200);
    assert.equal(saved.json.ok, true);
    assert.equal(saved.json.event.sourceId, 'manual');
    assert.equal(saved.json.event.interviewStage, '面试');
    assert.equal(saved.json.event.interviewType, '无领导小组讨论');
    const store = RecruitStore.open(join(dir, 'recruit.db'));
    try {
      assert.equal(store.listEvents({from: '2026-01-01T00:00:00+08:00', to: '2027-01-01T00:00:00+08:00'}).length, 1);
    } finally { store.close(); }
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('API：缺少开始时间拒绝保存', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zx-manual-'));
  try {
    const r = await handleRecruit({method: 'POST', pathname: 'manual/save', body: {title: '只有标题'}, dir});
    assert.equal(r.status, 400);
    assert.match(r.json.error, /必填/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});
