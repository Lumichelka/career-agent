// 公司档案 API：列表、详情（含关联活动/投递）、保存、删除、从对话保存。
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {CompanyStore} from './store.mjs';
import {RecruitStore} from '../recruit/store.mjs';
import {ResumeStore} from '../resume/store.mjs';
import {generateCompanyProfiles} from './research.mjs';

const norm = s => String(s || '').replace(/\s+/g, '').toLowerCase();
function sameCompany(a, b) {
  const x = norm(a), y = norm(b);
  return !!x && !!y && (x.includes(y) || y.includes(x));
}

function related(dir, name) {
  let events = [], applications = [];
  try {
    const store = RecruitStore.open(join(dir, 'recruit.db'));
    try { events = store.listEvents({limit: 500, includeCancelled: true}).filter(e => sameCompany(e.company, name)).slice(0, 30); }
    finally { store.close(); }
  } catch { /* 招聘库还没建 */ }
  try {
    const store = ResumeStore.open(join(dir, 'resume.db'));
    try { applications = store.listApplications().filter(a => sameCompany(a.company, name)).slice(0, 30); }
    finally { store.close(); }
  } catch { /* 简历库还没建 */ }
  return {events, applications};
}

function artifactName(title, body) {
  const raw = String(title || '').replace(/^[【\[]?(公司调研|公司简报|公司档案)[】\]]?[-—：:\s]*/i, '').trim();
  if (raw.length >= 2) return raw.slice(0, 80);
  return String(body || '').split('\n').map(s => s.trim()).find(Boolean)?.slice(0, 80) || '未命名公司';
}

export async function handleCompany({method, pathname, body, dir, searchUrl = '', fetchImpl = fetch}) {
  const store = CompanyStore.open(join(dir, 'company.db'));
  try {
    const parts = pathname.split('/').filter(Boolean);

    if (method === 'GET') {
      if (pathname === 'companies') return {json: {companies: store.list(), stats: store.stats()}};
      if (parts[0] === 'companies' && parts[1] && parts.length === 2) {
        const company = store.get(parts[1]);
        if (!company) return {status: 404, json: {error: '公司档案不存在'}};
        return {json: {company, ...related(dir, company.name)}};
      }
      return null;
    }

    if (method === 'POST') {
      if (pathname === 'companies/generate') {
        const out = await generateCompanyProfiles({
          dataDir: dir,
          searchUrl,
          fetchImpl,
          limit: Number(body?.limit) || undefined
        });
        return {json: out};
      }

      if (pathname === 'companies') return {json: {company: store.save(body || {})}};

      if (pathname === 'companies/from-session') {
        const sessionId = String(body?.sessionId || '');
        if (!/^[a-f0-9-]{36}$/.test(sessionId)) return {status: 400, json: {error: '无效的会话'}};
        let session;
        try { session = JSON.parse(await readFile(join(dir, sessionId + '.json'), 'utf8')); } catch { return {status: 404, json: {error: '没有这个对话'}}; }
        const artifact = (session.artifacts || []).at(-1);
        if (!artifact || !artifact.content?.trim()) return {status: 400, json: {error: '本次对话还没有可保存的文稿'}};
        const name = String(body?.name || artifactName(artifact.title, artifact.content)).slice(0, 80);
        const company = store.save({
          name,
          summary: artifact.content.slice(0, 6000),
          notes: '来自对话 ' + sessionId.slice(0, 8)
        });
        return {json: {company}};
      }

      if (parts[0] === 'companies' && parts[1] && parts[2] === 'delete') {
        store.delete(parts[1]);
        return {json: {ok: true}};
      }
      return null;
    }

    return null;
  } finally {
    store.close();
  }
}
