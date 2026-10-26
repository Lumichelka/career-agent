import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import source, {parseCorporations, parseCorporationDetail, mergeCorporationDetail} from '../src/recruit/sources/scu-jobfair.mjs';

const html = readFileSync(new URL('./fixtures/scu-corporations.html', import.meta.url), 'utf8');
const detailHtml = readFileSync(new URL('./fixtures/scu-corporation-detail.html', import.meta.url), 'utf8');

test('川大双选会：参会单位解析', () => {
  const projects = parseCorporations(html);
  assert.equal(projects.length, 2);
  assert.equal(projects[0].company, '浙江吉利控股集团有限公司');
  assert.match(projects[0].notes, /制造业/);
  assert.equal(projects[0].applyMode, '现场');
  assert.match(projects[0].sourceUrl, /jobfaircorporationinfo/);
});

test('川大双选会：详情页职位信息解析', () => {
  const detail = parseCorporationDetail(detailHtml);
  assert.equal(detail.jobs.length, 2);
  assert.equal(detail.jobs[0].name, '财务审计');
  assert.equal(detail.jobs[0].type, '会计|审计|出纳|财务|税务');
  assert.equal(detail.jobs[0].degree, '本科');
  assert.equal(detail.jobs[0].count, '5');
  assert.equal(detail.jobs[0].salary, '7000-8000');
  assert.equal(detail.jobs[0].major, '不限');
  assert.ok(detail.jobs[0].requirement.includes('本科及以上学历'));
  assert.ok(detail.jobs[0].duties.includes('资金财产的监督审计'));
  assert.equal(detail.email, 'xhzhaopin@xhgroup.cn');
  assert.equal(detail.jobs[1].name, '培训管理');
});

test('川大双选会：详情合并为「一个岗位一个项目」', () => {
  const corp = {company: '安徽新华教育集团有限公司', sourceUrl: 'https://jy.scu.edu.cn/index/index/jobfaircorporationinfo.html?data=abc', sourceKey: 'abc', applyMode: '现场', notes: '单位信息：行业：教育；性质：其他企业'};
  const detail = parseCorporationDetail(detailHtml);
  const projects = mergeCorporationDetail(corp, detail);
  assert.equal(projects.length, 2);
  assert.equal(projects[0].company, '安徽新华教育集团有限公司');
  assert.equal(projects[0].title, '财务审计');
  assert.ok(projects[0].positions.includes('薪资 7000-8000'));
  assert.ok(projects[0].positions.includes('招聘 5 人'));
  assert.ok(projects[0].requirements.includes('学历 本科'));
  assert.ok(projects[0].requirements.includes('本科及以上学历'));
  assert.equal(projects[0].applyMode, '邮箱投递');
  assert.equal(projects[0].applyUrl, 'mailto:xhzhaopin@xhgroup.cn');
  assert.equal(projects[1].title, '培训管理');
  assert.match(projects[0].sourceKey, /^abc#[a-f0-9]{16}$/, '岗位键是稳定 hash，不是数组下标');
  assert.notEqual(projects[0].sourceKey, projects[1].sourceKey);
});

test('川大双选会：岗位顺序变化不改变 sourceKey（不会把 A 的内容写进 B）', () => {
  const corp = {company: '安徽新华教育集团有限公司', sourceUrl: 'https://jy.scu.edu.cn/index/index/jobfaircorporationinfo.html?data=abc', sourceKey: 'abc', applyMode: '现场', notes: ''};
  const detail = parseCorporationDetail(detailHtml);
  const forward = mergeCorporationDetail(corp, detail);
  const reversed = mergeCorporationDetail(corp, {jobs: [...detail.jobs].reverse(), email: detail.email});
  const byTitle = list => Object.fromEntries(list.map(p => [p.title, p.sourceKey]));
  assert.deepEqual(byTitle(forward), byTitle(reversed), '键只由岗位内容决定');
  assert.equal(forward[0].sourceKey.split('#')[0], 'abc');
});

test('川大双选会：详情读不到时留空并标「未公布」', () => {
  const corp = {company: '某公司', sourceUrl: 'http://x', sourceKey: 'k', applyMode: '现场', notes: ''};
  const projects = mergeCorporationDetail(corp, {jobs: [], email: ''});
  assert.equal(projects.length, 1);
  assert.equal(projects[0].title, '');
  assert.equal(projects[0].positions, '');
  assert.equal(projects[0].requirements, '');
  assert.ok(projects[0].notes.includes('岗位/要求未公布'));
});

test('川大双选会：fetchProjects 抓列表 + 逐单位抓详情', async () => {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    calls.push({url, method: opts.method || 'GET'});
    const u = new URL(url);
    if (opts.method === 'POST') {
      // 参会单位列表（复用 scu-corporations.html 的两个单位）
      return {ok: true, status: 200, text: html};
    }
    // 详情页：abc 有职位，def 被 WAF 483
    if (u.searchParams.get('data') === 'abc') return {ok: true, status: 200, text: detailHtml};
    return {ok: false, status: 483, message: 'HTTP 483：触发风控'};
  };
  const item = {url: 'https://jy.scu.edu.cn/index/index/jobfairdetail.html?data=xyz'};
  const got = await source.fetchProjects(item, undefined, {fetchText: fetch, base: 'http://mock'});
  assert.equal(got.status, 'ok');
  // abc 拆 2 个岗位 + def 退回单位级「未公布」= 3 个项目
  assert.equal(got.projects.length, 3);
  const byTitle = got.projects.map(p => p.title);
  assert.ok(byTitle.includes('财务审计'));
  assert.ok(byTitle.includes('培训管理'));
  const fallback = got.projects.find(p => p.title === '');
  assert.ok(fallback);
  assert.ok(fallback.notes.includes('岗位/要求未公布'));
  assert.equal(fallback.company, '宇树科技股份有限公司');
  // 详情抓取只针对列表里的两个单位，且邮箱投递作为投递方式
  assert.equal(got.projects[0].applyMode, '邮箱投递');
  assert.equal(got.projects[0].applyUrl, 'mailto:xhzhaopin@xhgroup.cn');
});

test('川大双选会：超出 detailLimit 的单位退回单位级「未公布」，不静默丢弃', async () => {
  const html3 = html.replace('</ul>', '<li><a href="/index/index/jobfaircorporationinfo.html?data=ghi"> 中国工商银行&nbsp;【行业：金融业；性质：国有企业 】 </a></li>\n</ul>');
  const calls = [];
  const fetch = async (url, opts = {}) => {
    calls.push({url, method: opts.method || 'GET'});
    if (opts.method === 'POST') return {ok: true, status: 200, text: html3};
    if (new URL(url).searchParams.get('data') === 'abc') return {ok: true, status: 200, text: detailHtml};
    throw new Error('超出 detailLimit 的单位不应再抓详情页');
  };
  const item = {url: 'https://jy.scu.edu.cn/index/index/jobfairdetail.html?data=xyz'};
  const got = await source.fetchProjects(item, undefined, {fetchText: fetch, base: 'http://mock', detailLimit: 1});
  assert.equal(got.status, 'ok');
  assert.deepEqual(calls.filter(c => c.method === 'GET').map(c => new URL(c.url).searchParams.get('data')), ['abc'], '只对前 detailLimit 个单位抓详情');
  const byCompany = got.projects.reduce((acc, p) => { (acc[p.company] ||= []).push(p); return acc; }, {});
  assert.equal(byCompany['浙江吉利控股集团有限公司'].length, 2);
  assert.equal(byCompany['宇树科技股份有限公司'].length, 1);
  assert.equal(byCompany['中国工商银行'].length, 1);
  for (const company of ['宇树科技股份有限公司', '中国工商银行']) {
    const project = byCompany[company][0];
    assert.equal(project.title, '');
    assert.match(project.notes, /岗位\/要求未公布/);
    assert.ok(project.sourceKey, '退回单位级也要有稳定键');
  }
});

test('川大双选会：声明项目能力', () => {
  assert.deepEqual(source.capabilities, {list: 'static', detail: 'http', projects: 'api'});
  assert.equal(typeof source.fetchProjects, 'function');
});
