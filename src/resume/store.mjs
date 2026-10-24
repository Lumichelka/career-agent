// 简历版本与投递记录：与招聘库分开存 resume.db，避免采集数据和求职材料混在一起。
let DatabaseSync;
try {
  ({DatabaseSync} = await import('node:sqlite'));
} catch {
  throw new Error('当前 Node 版本不支持内置 SQLite（node:sqlite）。请升级到 Node 23+。');
}
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS resumes(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, is_base INTEGER DEFAULT 1,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS resume_versions(
  id TEXT PRIMARY KEY, resume_id TEXT NOT NULL, version_no INTEGER DEFAULT 1,
  title TEXT, content TEXT, jd_text TEXT, notes TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS applications(
  id TEXT PRIMARY KEY, company TEXT, role TEXT, city TEXT, channel TEXT,
  stage TEXT, deadline TEXT, next_followup TEXT, resume_version_id TEXT,
  jd_text TEXT, notes TEXT, created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS interview_preps(
  id TEXT PRIMARY KEY, company TEXT, role TEXT, jd_text TEXT, content TEXT,
  questions_json TEXT, notes TEXT, created_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_versions_resume ON resume_versions(resume_id);
CREATE INDEX IF NOT EXISTS idx_apps_stage ON applications(stage);
CREATE INDEX IF NOT EXISTS idx_preps_updated ON interview_preps(updated_at);
`;

export const STAGES = ['已投递', '笔试', '面试中', 'Offer', '已结束'];
const LIMITS = {name: 60, title: 80, content: 50000, jd: 20000, notes: 2000, company: 80, role: 80, city: 30, channel: 40};

function clean(value, max, field, {multiline = false} = {}) {
  if (typeof value !== 'string') throw new Error(field + ' 必须是文字');
  let text = multiline ? value.replace(/\r\n/g, '\n').trim() : value.replace(/\s+/g, ' ').trim();
  if (!text) throw new Error(field + ' 不能为空');
  if (text.length > max) throw new Error(field + ' 不能超过 ' + max + ' 个字');
  return text;
}
function optional(value, max, field, opts) {
  if (value === undefined || value === null || String(value).trim() === '') return '';
  return clean(String(value), max, field, opts);
}
function dateOrEmpty(value, field) {
  if (!value) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw new Error(field + ' 需为 YYYY-MM-DD');
  return String(value);
}

export class ResumeStore {
  constructor(file) {
    mkdirSync(dirname(file), {recursive: true});
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(SCHEMA);
  }
  static open(file) { return new ResumeStore(file); }
  close() { try { this.db.close(); } catch { /* 已关闭 */ } }

  listResumes() {
    return this.db.prepare(`SELECT r.*, COUNT(v.id) AS versions, MAX(v.created_at) AS last_version_at
      FROM resumes r LEFT JOIN resume_versions v ON v.resume_id = r.id
      GROUP BY r.id ORDER BY r.updated_at DESC`).all().map(r => ({
      id: r.id, name: r.name, isBase: !!r.is_base, versions: Number(r.versions) || 0,
      lastVersionAt: r.last_version_at, createdAt: r.created_at, updatedAt: r.updated_at
    }));
  }

  getResume(id) {
    const resume = this.db.prepare('SELECT * FROM resumes WHERE id=?').get(id);
    if (!resume) return null;
    const versions = this.db.prepare('SELECT * FROM resume_versions WHERE resume_id=? ORDER BY version_no DESC').all(id).map(rowToVersion);
    return {
      id: resume.id, name: resume.name, isBase: !!resume.is_base,
      createdAt: resume.created_at, updatedAt: resume.updated_at, versions
    };
  }

  createResume({name = '我的简历', content, jdText = '', notes = '', title = '基础版'}) {
    const now = new Date().toISOString();
    const resume = {id: randomUUID(), name: clean(name, LIMITS.name, '简历名称'), is_base: 1, created_at: now, updated_at: now};
    const version = this.#version(resume.id, 1, title, content, jdText, notes, now);
    this.db.prepare('INSERT INTO resumes(id,name,is_base,created_at,updated_at) VALUES(?,?,?,?,?)')
      .run(resume.id, resume.name, 1, now, now);
    this.db.prepare('INSERT INTO resume_versions(id,resume_id,version_no,title,content,jd_text,notes,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(version.id, version.resumeId, version.versionNo, version.title, version.content, version.jdText, version.notes, now);
    return this.getResume(resume.id);
  }

  #version(resumeId, no, title, content, jdText, notes, now) {
    return {
      id: randomUUID(), resumeId, versionNo: no,
      title: clean(title, LIMITS.title, '版本标题'),
      content: clean(content, LIMITS.content, '简历正文', {multiline: true}),
      jdText: optional(jdText, LIMITS.jd, '岗位描述', {multiline: true}),
      notes: optional(notes, LIMITS.notes, '备注', {multiline: true}),
      createdAt: now
    };
  }

  addVersion(resumeId, {title, content, jdText = '', notes = ''}) {
    if (!this.getResume(resumeId)) throw new Error('简历不存在');
    const now = new Date().toISOString();
    const max = this.db.prepare('SELECT MAX(version_no) AS n FROM resume_versions WHERE resume_id=?').get(resumeId).n || 0;
    const version = this.#version(resumeId, max + 1, title || '版本 ' + (max + 1), content, jdText, notes, now);
    this.db.prepare('INSERT INTO resume_versions(id,resume_id,version_no,title,content,jd_text,notes,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(version.id, resumeId, version.versionNo, version.title, version.content, version.jdText, version.notes, now);
    this.db.prepare('UPDATE resumes SET updated_at=? WHERE id=?').run(now, resumeId);
    return version;
  }

  deleteResume(id) {
    this.db.prepare('DELETE FROM resume_versions WHERE resume_id=?').run(id);
    this.db.prepare('DELETE FROM resumes WHERE id=?').run(id);
  }

  getVersion(id) {
    const row = this.db.prepare('SELECT * FROM resume_versions WHERE id=?').get(id);
    return row ? rowToVersion(row) : null;
  }

  latestVersion(resumeId) {
    const row = this.db.prepare('SELECT * FROM resume_versions WHERE resume_id=? ORDER BY version_no DESC LIMIT 1').get(resumeId);
    return row ? rowToVersion(row) : null;
  }

  listApplications() {
    return this.db.prepare('SELECT * FROM applications ORDER BY updated_at DESC').all().map(rowToApp);
  }

  saveApplication(input) {
    const now = new Date().toISOString();
    const app = normalizeApp(input, this);
    if (input.id) {
      const exists = this.db.prepare('SELECT id FROM applications WHERE id=?').get(input.id);
      if (!exists) throw new Error('投递记录不存在');
      this.db.prepare(`UPDATE applications SET company=?,role=?,city=?,channel=?,stage=?,deadline=?,next_followup=?,
        resume_version_id=?,jd_text=?,notes=?,updated_at=? WHERE id=?`)
        .run(app.company, app.role, app.city, app.channel, app.stage, app.deadline, app.nextFollowup,
          app.resumeVersionId, app.jdText, app.notes, now, input.id);
      return rowToApp(this.db.prepare('SELECT * FROM applications WHERE id=?').get(input.id));
    }
    const id = randomUUID();
    this.db.prepare(`INSERT INTO applications(id,company,role,city,channel,stage,deadline,next_followup,resume_version_id,jd_text,notes,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, app.company, app.role, app.city, app.channel, app.stage, app.deadline, app.nextFollowup,
        app.resumeVersionId, app.jdText, app.notes, now, now);
    return rowToApp(this.db.prepare('SELECT * FROM applications WHERE id=?').get(id));
  }

  deleteApplication(id) {
    this.db.prepare('DELETE FROM applications WHERE id=?').run(id);
  }

  listInterviews() {
    return this.db.prepare('SELECT * FROM interview_preps ORDER BY updated_at DESC').all().map(r => {
      const questions = parseQuestions(r.questions_json);
      return {
        id: r.id, company: r.company, role: r.role, updatedAt: r.updated_at,
        createdAt: r.created_at, questionCount: questions.length,
        answered: questions.filter(q => q.answer).length
      };
    });
  }

  getInterview(id) {
    const row = this.db.prepare('SELECT * FROM interview_preps WHERE id=?').get(id);
    return row ? rowToInterview(row) : null;
  }

  saveInterview(input) {
    const now = new Date().toISOString();
    const data = normalizeInterview(input);
    if (input.id) {
      if (!this.getInterview(input.id)) throw new Error('面试准备不存在');
      this.db.prepare(`UPDATE interview_preps SET company=?,role=?,jd_text=?,content=?,questions_json=?,notes=?,updated_at=? WHERE id=?`)
        .run(data.company, data.role, data.jdText, data.content, JSON.stringify(data.questions), data.notes, now, input.id);
      return this.getInterview(input.id);
    }
    const id = randomUUID();
    this.db.prepare(`INSERT INTO interview_preps(id,company,role,jd_text,content,questions_json,notes,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(id, data.company, data.role, data.jdText, data.content, JSON.stringify(data.questions), data.notes, now, now);
    return this.getInterview(id);
  }

  deleteInterview(id) {
    this.db.prepare('DELETE FROM interview_preps WHERE id=?').run(id);
  }

  stats() {
    const byStage = Object.fromEntries(this.db.prepare('SELECT stage, COUNT(*) c FROM applications GROUP BY stage').all().map(r => [r.stage, r.c]));
    const total = this.db.prepare('SELECT COUNT(*) c FROM applications').get().c;
    const resumes = this.db.prepare('SELECT COUNT(*) c FROM resumes').get().c;
    const versions = this.db.prepare('SELECT COUNT(*) c FROM resume_versions').get().c;
    const interviews = this.db.prepare('SELECT COUNT(*) c FROM interview_preps').get().c;
    return {applications: total, byStage, resumes, versions, interviews};
  }
}

function normalizeApp(input, store) {
  const stage = input.stage || '已投递';
  if (!STAGES.includes(stage)) throw new Error('阶段无效');
  let resumeVersionId = input.resumeVersionId || '';
  if (resumeVersionId && !store.getVersion(resumeVersionId)) throw new Error('绑定的简历版本不存在');
  return {
    company: clean(input.company, LIMITS.company, '公司名称'),
    role: clean(input.role, LIMITS.role, '岗位名称'),
    city: optional(input.city, LIMITS.city, '城市'),
    channel: optional(input.channel, LIMITS.channel, '投递渠道'),
    stage,
    deadline: dateOrEmpty(input.deadline, '截止日期'),
    nextFollowup: dateOrEmpty(input.nextFollowup, '跟进日期'),
    resumeVersionId,
    jdText: optional(input.jdText, LIMITS.jd, '岗位描述', {multiline: true}),
    notes: optional(input.notes, LIMITS.notes, '备注', {multiline: true})
  };
}

function rowToVersion(r) {
  return {id: r.id, resumeId: r.resume_id, versionNo: r.version_no, title: r.title, content: r.content, jdText: r.jd_text, notes: r.notes, createdAt: r.created_at};
}
function normalizeInterview(input) {
  const company = clean(input.company || '未命名', LIMITS.company, '公司名称');
  const role = optional(input.role, LIMITS.role, '岗位名称');
  const jdText = optional(input.jdText, LIMITS.jd, '岗位描述', {multiline: true});
  const content = optional(input.content, LIMITS.content, '准备内容', {multiline: true});
  const notes = optional(input.notes, LIMITS.notes, '备注', {multiline: true});
  const questions = normalizeQuestions(input.questions);
  if (!content && !questions.length) throw new Error('准备内容和题目至少填一项');
  return {company, role, jdText, content, notes, questions};
}

function normalizeQuestions(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error('题目必须是数组');
  return list.slice(0, 50).map((item, i) => {
    const text = clean(String(item?.q || item?.question || ''), 500, '第 ' + (i + 1) + ' 题');
    return {
      q: text,
      type: optional(item.type, 20, '题目类型'),
      points: optional(item.points, 1000, '回答要点', {multiline: true}),
      answer: optional(item.answer, 2000, '我的回答', {multiline: true})
    };
  });
}

function parseQuestions(raw) {
  try { const arr = JSON.parse(raw || '[]'); return Array.isArray(arr) ? arr : []; } catch { return []; }
}

function rowToInterview(r) {
  return {
    id: r.id, company: r.company, role: r.role, jdText: r.jd_text, content: r.content,
    questions: parseQuestions(r.questions_json), notes: r.notes,
    createdAt: r.created_at, updatedAt: r.updated_at
  };
}

function rowToApp(r) {
  return {
    id: r.id, company: r.company, role: r.role, city: r.city, channel: r.channel, stage: r.stage,
    deadline: r.deadline, nextFollowup: r.next_followup, resumeVersionId: r.resume_version_id,
    jdText: r.jd_text, notes: r.notes, createdAt: r.created_at, updatedAt: r.updated_at
  };
}
