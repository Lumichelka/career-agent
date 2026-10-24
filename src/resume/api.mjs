// 简历与投递 API：挂在 /api/resumes 和 /api/applications 下。
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {ResumeStore, STAGES} from './store.mjs';

function csv(rows) {
  const head = ['公司', '岗位', '城市', '渠道', '阶段', '截止日期', '下次跟进', '备注'];
  const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  return '\uFEFF' + [head, ...rows.map(r => [r.company, r.role, r.city, r.channel, r.stage, r.deadline, r.nextFollowup, r.notes])]
    .map(row => row.map(q).join(',')).join('\r\n') + '\r\n';
}

export async function handleResume({method, pathname, url, body, dir}) {
  const store = ResumeStore.open(join(dir, 'resume.db'));
  try {
    const parts = pathname.split('/').filter(Boolean);

    if (method === 'GET') {
      if (pathname === 'resumes') return {json: {resumes: store.listResumes(), stats: store.stats()}};
      if (pathname === 'applications') return {json: {applications: store.listApplications(), stages: STAGES, stats: store.stats()}};
      if (pathname === 'applications/export.csv') return {file: {body: csv(store.listApplications()), type: 'text/csv; charset=utf-8', name: 'zhixiang-applications.csv'}};
      if (parts[0] === 'resumes' && parts[1] && parts.length === 2) {
        const resume = store.getResume(parts[1]);
        return resume ? {json: {resume}} : {status: 404, json: {error: '简历不存在'}};
      }
      return null;
    }

    if (method === 'POST') {
      if (pathname === 'resumes') return {json: {resume: store.createResume(body || {})}};

      if (pathname === 'resumes/from-session') {
        const sessionId = String(body?.sessionId || '');
        if (!/^[a-f0-9-]{36}$/.test(sessionId)) return {status: 400, json: {error: '无效的会话'}};
        let session;
        try { session = JSON.parse(await readFile(join(dir, sessionId + '.json'), 'utf8')); } catch { return {status: 404, json: {error: '没有这个对话'}}; }
        const artifact = (session.artifacts || []).at(-1);
        if (!artifact || !artifact.content?.trim()) return {status: 400, json: {error: '本次对话还没有可保存的文稿'}};
        const existing = store.listResumes();
        let resumeId, version;
        if (existing.length) {
          resumeId = existing[0].id;
          version = store.addVersion(resumeId, {title: artifact.title || '对话生成版本', content: artifact.content, notes: '来自对话 ' + sessionId.slice(0, 8)});
        } else {
          const created = store.createResume({name: '我的简历', title: artifact.title || '对话生成版本', content: artifact.content, notes: '来自对话 ' + sessionId.slice(0, 8)});
          resumeId = created.id;
          version = created.versions[0];
        }
        return {json: {resume: store.getResume(resumeId), version}};
      }

      if (parts[0] === 'resumes' && parts[1] && parts[2] === 'versions') {
        const version = store.addVersion(parts[1], body || {});
        return {json: {version, resume: store.getResume(parts[1])}};
      }
      if (parts[0] === 'resumes' && parts[1] && parts[2] === 'delete') {
        store.deleteResume(parts[1]);
        return {json: {ok: true}};
      }

      if (pathname === 'applications') return {json: {application: store.saveApplication(body || {})}};
      if (parts[0] === 'applications' && parts[1] && parts[2] === 'delete') {
        store.deleteApplication(parts[1]);
        return {json: {ok: true}};
      }

      return null;
    }

    return null;
  } finally {
    store.close();
  }
}
