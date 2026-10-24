import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ResumeStore, STAGES} from '../src/resume/store.mjs';
import {handleResume} from '../src/resume/api.mjs';
import {callTool} from '../src/tools/execute.mjs';

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'zx-resume-'));
  try { return await fn(dir); } finally { await rm(dir, {recursive: true, force: true}); }
}

test('简历：创建、版本递增、列表与最新版', async () => {
  await withDir(async dir => {
    const store = ResumeStore.open(join(dir, 'resume.db'));
    try {
      const created = store.createResume({name: '后端简历', content: '第一版内容\n第二行'});
      assert.equal(created.versions.length, 1);
      assert.equal(created.versions[0].content, '第一版内容\n第二行');
      const v2 = store.addVersion(created.id, {title: '银行定向版', content: '定向内容', jdText: 'JD 内容'});
      assert.equal(v2.versionNo, 2);
      const detail = store.getResume(created.id);
      assert.equal(detail.versions.length, 2);
      assert.equal(detail.versions[0].title, '银行定向版');
      assert.equal(detail.versions[0].jdText, 'JD 内容');
      const list = store.listResumes();
      assert.equal(list[0].versions, 2);
    } finally { store.close(); }
  });
});

test('简历：名称/正文校验与删除', async () => {
  await withDir(async dir => {
    const store = ResumeStore.open(join(dir, 'resume.db'));
    try {
      assert.throws(() => store.createResume({name: '', content: 'x'}), /简历名称/);
      assert.throws(() => store.createResume({name: 'x', content: ''}), /简历正文/);
      const r = store.createResume({content: 'x'});
      store.deleteResume(r.id);
      assert.equal(store.listResumes().length, 0);
    } finally { store.close(); }
  });
});

test('投递：新增、改阶段、日期校验、删除与统计', async () => {
  await withDir(async dir => {
    const store = ResumeStore.open(join(dir, 'resume.db'));
    try {
      const app = store.saveApplication({company: '某银行', role: '数据分析', stage: '已投递', deadline: '2026-11-30'});
      assert.equal(app.company, '某银行');
      assert.equal(app.stage, '已投递');
      const updated = store.saveApplication({...app, id: app.id, stage: '面试中', nextFollowup: '2026-11-10'});
      assert.equal(updated.stage, '面试中');
      assert.equal(updated.nextFollowup, '2026-11-10');
      assert.equal(store.listApplications().length, 1);
      assert.equal(store.stats().byStage['面试中'], 1);
      assert.throws(() => store.saveApplication({company: 'x', role: 'y', stage: '随便'}), /阶段无效/);
      assert.throws(() => store.saveApplication({company: 'x', role: 'y', deadline: '11/30'}), /YYYY-MM-DD/);
      store.deleteApplication(app.id);
      assert.equal(store.listApplications().length, 0);
    } finally { store.close(); }
  });
});

test('API：创建简历、加版本、读取详情', async () => {
  await withDir(async dir => {
    let out = await handleResume({method: 'POST', pathname: 'resumes', body: {name: '我的简历', content: '正文 A'}, dir});
    const id = out.json.resume.id;
    assert.ok(id);
    out = await handleResume({method: 'POST', pathname: `resumes/${id}/versions`, body: {title: '定向版', content: '正文 B', jdText: 'JD'}, dir});
    assert.equal(out.json.version.versionNo, 2);
    out = await handleResume({method: 'GET', pathname: `resumes/${id}`, dir});
    assert.equal(out.json.resume.versions[0].title, '定向版');
    out = await handleResume({method: 'GET', pathname: 'resumes', dir});
    assert.equal(out.json.resumes[0].versions, 2);
  });
});

test('API：从对话保存文稿', async () => {
  await withDir(async dir => {
    const sessionId = '11111111-2222-3333-4444-555555555555';
    await writeFile(join(dir, sessionId + '.json'), JSON.stringify({
      id: sessionId, title: '对话', memory: '', messages: [],
      artifacts: [{id: 'a', title: '定向简历', content: '对话生成的简历正文', createdAt: new Date().toISOString()}]
    }), 'utf8');
    const out = await handleResume({method: 'POST', pathname: 'resumes/from-session', body: {sessionId}, dir});
    assert.match(out.json.version.content, /对话生成/);
    const detail = await handleResume({method: 'GET', pathname: 'resumes/' + out.json.resume.id, dir});
    assert.equal(detail.json.resume.versions[0].title, '定向简历');
  });
});

test('API：投递与 CSV 导出', async () => {
  await withDir(async dir => {
    let out = await handleResume({method: 'POST', pathname: 'applications', body: {company: '某公司', role: '产品', stage: '笔试'}, dir});
    assert.equal(out.json.application.stage, '笔试');
    out = await handleResume({method: 'GET', pathname: 'applications', dir});
    assert.equal(out.json.applications.length, 1);
    assert.deepEqual(out.json.stages, STAGES);
    out = await handleResume({method: 'GET', pathname: 'applications/export.csv', dir});
    assert.match(out.file.body, /公司/);
    assert.match(out.file.body, /某公司/);
  });
});

test('工具：resume_list / resume_read 读取本机简历', async () => {
  await withDir(async dir => {
    let out = await callTool('resume_list', {}, {config: {dataDir: dir}});
    assert.equal(out.status, 'readable');
    assert.equal(out.resumes.length, 0);
    const created = await handleResume({method: 'POST', pathname: 'resumes', body: {name: '测试简历', content: '真实内容'}, dir});
    out = await callTool('resume_list', {}, {config: {dataDir: dir}});
    assert.equal(out.resumes[0].name, '测试简历');
    out = await callTool('resume_read', {}, {config: {dataDir: dir}});
    assert.equal(out.status, 'readable');
    assert.match(out.version.content, /真实内容/);
    assert.equal(created.json.resume.id, out.resume.id);
  });
});

test('面试准备：创建、题目、更新、校验、删除', async () => {
  await withDir(async dir => {
    const store = ResumeStore.open(join(dir, 'resume.db'));
    try {
      const it = store.saveInterview({
        company: '某银行', role: '数据分析', content: '流程预测：笔试→初面→终面',
        questions: [{q: '自我介绍', type: '行为', points: 'STAR', answer: ''}]
      });
      assert.equal(it.questions.length, 1);
      assert.equal(it.content.includes('流程预测'), true);
      const list = store.listInterviews();
      assert.equal(list[0].questionCount, 1);
      assert.equal(list[0].answered, 0);
      const updated = store.saveInterview({...it, id: it.id, questions: [{...it.questions[0], answer: '我的回答'}, {q: '为什么选我们', answer: ''}]});
      assert.equal(updated.questions.length, 2);
      assert.equal(store.listInterviews()[0].answered, 1);
      assert.equal(store.stats().interviews, 1);
      assert.throws(() => store.saveInterview({company: 'x'}), /至少填一项/);
      assert.throws(() => store.saveInterview({company: 'x', questions: [{q: ''}]}), /不能为空/);
      store.deleteInterview(it.id);
      assert.equal(store.listInterviews().length, 0);
    } finally { store.close(); }
  });
});

test('API：面试准备的增删查与从对话保存', async () => {
  await withDir(async dir => {
    let out = await handleResume({method: 'POST', pathname: 'interviews', body: {company: '某公司', role: '产品', content: '准备内容'}, dir});
    const id = out.json.interview.id;
    out = await handleResume({method: 'GET', pathname: 'interviews', dir});
    assert.equal(out.json.interviews.length, 1);
    assert.equal(out.json.interviews[0].company, '某公司');
    out = await handleResume({method: 'GET', pathname: 'interviews/' + id, dir});
    assert.equal(out.json.interview.content, '准备内容');

    const sessionId = '99999999-8888-7777-6666-555555555555';
    await writeFile(join(dir, sessionId + '.json'), JSON.stringify({
      id: sessionId, artifacts: [{title: '面试准备-某银行', content: '对话生成的面试准备'}]
    }), 'utf8');
    out = await handleResume({method: 'POST', pathname: 'interviews/from-session', body: {sessionId}, dir});
    assert.match(out.json.interview.content, /对话生成/);
    assert.equal(out.json.interview.role, '面试准备-某银行');

    await handleResume({method: 'POST', pathname: 'interviews/' + id + '/delete', body: {}, dir});
    out = await handleResume({method: 'GET', pathname: 'interviews', dir});
    assert.equal(out.json.interviews.length, 1);
  });
});

test('工具：interview_list / interview_read', async () => {
  await withDir(async dir => {
    let out = await callTool('interview_list', {}, {config: {dataDir: dir}});
    assert.equal(out.status, 'readable');
    assert.equal(out.interviews.length, 0);
    await handleResume({method: 'POST', pathname: 'interviews', body: {company: '某银行', content: '准备内容', questions: [{q: '自我介绍', answer: '大家好'}]}, dir});
    out = await callTool('interview_list', {}, {config: {dataDir: dir}});
    assert.equal(out.interviews[0].company, '某银行');
    assert.equal(out.interviews[0].questions, 1);
    out = await callTool('interview_read', {}, {config: {dataDir: dir}});
    assert.equal(out.status, 'readable');
    assert.match(out.interview.content, /准备内容/);
    assert.equal(out.interview.questions[0].answer, '大家好');
  });
});
