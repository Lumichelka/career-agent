// 招聘域批量写入：活动 + 项目，按稳定身份创建或更新。
// 只写 events / event_projects，不写公司档案；旧值/新值都是整行，交给写网关逐行审计。
import {createHash} from 'node:crypto';
import {WriteError} from '../writes/gateway.mjs';

const EVENT_LIMIT = 50;
const PROJECT_LIMIT = 200;

function text(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function pick(input, previous, fallback, max) {
  if (input !== undefined && input !== null) return text(input, max);
  if (previous !== undefined && previous !== null && previous !== '') return String(previous).slice(0, max);
  return fallback;
}

export function normalizeSource(source = {}) {
  const input = source && typeof source === 'object' ? source : {};
  const sourceId = text(input.sourceId, 80) || 'manual';
  return {sourceId, sourceUrl: text(input.sourceUrl, 500), notes: text(input.notes, 2000)};
}

// 参数校验在业务写之前完成；返回错误文本，合法时返回 null。
export function validateBulkPayload(events, projects, source) {
  if (!Array.isArray(events) || events.length === 0) return 'events 至少需要一条活动。';
  if (events.length > EVENT_LIMIT) return '一次最多写入 ' + EVENT_LIMIT + ' 场活动。';
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (!event || typeof event !== 'object' || Array.isArray(event)) return '第 ' + (i + 1) + ' 场活动格式不正确。';
    if (!text(event.title, 200)) return '第 ' + (i + 1) + ' 场活动缺少 title。';
    if (!text(event.startAt, 40)) return '第 ' + (i + 1) + ' 场活动缺少 startAt。';
  }
  if (projects !== undefined && projects !== null && !Array.isArray(projects)) return 'projects 必须是数组。';
  const list = Array.isArray(projects) ? projects : [];
  if (list.length > PROJECT_LIMIT) return '一次最多写入 ' + PROJECT_LIMIT + ' 个招聘项目。';
  for (let i = 0; i < list.length; i++) {
    const project = list[i];
    if (!project || typeof project !== 'object' || Array.isArray(project)) return '第 ' + (i + 1) + ' 个招聘项目格式不正确。';
    if (!text(project.company, 120) && !text(project.title, 200)) return '第 ' + (i + 1) + ' 个招聘项目需要 company 或 title。';
    const hasIndex = Number.isInteger(project.eventIndex);
    const hasId = typeof project.eventId === 'string' && project.eventId.trim();
    if (!hasIndex && !hasId) return '第 ' + (i + 1) + ' 个招聘项目要用 eventIndex 或 eventId 关联活动。';
    if (hasIndex && (project.eventIndex < 0 || project.eventIndex >= events.length)) return '第 ' + (i + 1) + ' 个招聘项目的 eventIndex 超出活动数组。';
  }
  if (source && typeof source !== 'object') return 'source 必须是对象。';
  return null;
}

// 去重口径（#54 评审）：不再用「标题 + startAt」逐字相等。AI 与确定性源对同一场活动
// 的措辞可能不同（“邀请函/通知”后缀、全半角、空白、时区写法），所以先归一化：
//   标题 → NFKC + 去空白/标点 + 去常见后缀；
//   时间 → 统一按 +08:00 折成 YYYY-MM-DDTHH:mm；
//   单位 → company 优先，没有就用 school（再没有才留空）。
// 匹配时单位只在双方都有值时比较，避免 AI 补了 company 而确定性源没写就判成两条。
export function normalizeEventTitle(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[·•・\-—_/\\|｜:：,，。.;；!！?？'"“”‘’()（）\[\]【】<>《》]+/g, '')
    .replace(/(邀请函|通知|公告|详情|简章|海报|预告|邀请)$/,'');
}

export function normalizeEventMoment(value) {
  const raw = String(value ?? '').trim();
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return new Date(parsed.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 16);
  return raw.slice(0, 16);
}

function eventUnit(record) {
  return normalizeEventTitle(record.company || record.school || '');
}

export function eventIdentityKey(record) {
  return [normalizeEventTitle(record.title), normalizeEventMoment(record.startAt), eventUnit(record)].join('|');
}

function findEvent(store, {sourceId, sourceKey, title, startAt, company, school}) {
  const incoming = {title, startAt, company, school};
  let identity;
  if (sourceKey) {
    identity = createHash('sha1').update('event|' + sourceId + '|' + sourceKey).digest('hex').slice(0, 24);
    const row = store.getEvent(identity);
    if (row) return {id: identity, row};
    // 没命中 sourceKey 时仍做一次归一化匹配：手工预置/另一条路径写的同一场活动要更新而不是新增。
  } else {
    identity = createHash('sha1').update('event|' + eventIdentityKey(incoming)).digest('hex').slice(0, 24);
  }
  const byId = store.getEvent(identity);
  if (byId) return {id: identity, row: byId};
  const date = normalizeEventMoment(startAt).slice(0, 10);
  const candidates = store.db.prepare('SELECT * FROM events WHERE substr(start_at, 1, 10)=? ORDER BY last_seen_at DESC').all(date);
  const wantedTitle = normalizeEventTitle(title);
  const wantedMoment = normalizeEventMoment(startAt);
  const wantedCompany = normalizeEventTitle(company);
  const wantedSchool = normalizeEventTitle(school);
  for (const row of candidates) {
    if (normalizeEventTitle(row.title) !== wantedTitle) continue;
    if (normalizeEventMoment(row.start_at) !== wantedMoment) continue;
    // 单位只在双方都写了 company 时强比较：AI 补了 company、确定性源没写，不能判成两条。
    const rowCompany = normalizeEventTitle(row.company);
    if (wantedCompany && rowCompany && wantedCompany !== rowCompany) continue;
    // 双方都没有 company 时才用 school 兜底区分。
    if (!wantedCompany && !rowCompany && wantedSchool && row.school && normalizeEventTitle(row.school) !== wantedSchool) continue;
    return {id: row.id, row: store.getEvent(row.id)};
  }
  return {id: identity, row: null};
}

function eventRecord(input, previous, {sourceId, sourceUrl, sourceNotes}) {
  const notes = input.notes !== undefined ? text(input.notes, 2000) : (previous?.notes || sourceNotes);
  return {
    id: previous?.id,
    sourceId,
    school: pick(input.school, previous?.school, '', 60),
    city: pick(input.city, previous?.city, '', 20),
    kind: pick(input.kind, previous?.kind, '其他', 20),
    title: pick(input.title, previous?.title, '', 200),
    company: pick(input.company, previous?.company, '', 120),
    startAt: pick(input.startAt, previous?.startAt, '', 40),
    endAt: pick(input.endAt, previous?.endAt, '', 40),
    venue: pick(input.venue, previous?.venue, '', 200),
    address: pick(input.address, previous?.address, '', 300),
    industry: pick(input.industry, previous?.industry, '', 60),
    companySize: pick(input.companySize, previous?.companySize, '', 40),
    positions: pick(input.positions, previous?.positions, '', 2000),
    requirements: pick(input.requirements, previous?.requirements, '', 4000),
    applyMode: pick(input.applyMode, previous?.applyMode, '', 60),
    applyUrl: pick(input.applyUrl, previous?.applyUrl, '', 500),
    sourceUrl: pick(input.sourceUrl, previous?.sourceUrl, sourceUrl, 500),
    publishedAt: pick(input.publishedAt, previous?.publishedAt, '', 40),
    fetchedAt: new Date().toISOString(),
    confidence: Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : (Number(previous?.confidence) || 0.7),
    rawText: input.rawText !== undefined ? text(input.rawText, 20000) : (previous?.rawText || ''),
    notes,
    interviewStage: pick(input.interviewStage, previous?.interviewStage, '', 20),
    interviewType: pick(input.interviewType, previous?.interviewType, '', 40),
    status: input.status === 'cancelled' ? 'cancelled' : (previous?.status === 'cancelled' ? 'cancelled' : 'active')
  };
}

function resolveEventId(project, refs, index) {
  if (Number.isInteger(project.eventIndex)) {
    const id = refs.byIndex.get(project.eventIndex);
    if (!id) throw new WriteError('INVALID_ARGUMENTS', '第 ' + (index + 1) + ' 个招聘项目引用的活动未写入。', 400);
    return id;
  }
  const id = refs.byId.get(String(project.eventId));
  if (!id) throw new WriteError('INVALID_ARGUMENTS', '第 ' + (index + 1) + ' 个招聘项目引用的 eventId 不在本次活动里。', 400);
  return id;
}

/**
 * 在调用方的事务里写业务行，返回 [{action, entity, entityId, oldValues, newValues, note}]。
 * 调用方必须传入同一个 RecruitStore（同一个 DatabaseSync），否则审计与业务数据不在同一事务。
 */
export function bulkWriteRows({store, events, projects = [], source}) {
  const origin = normalizeSource(source);
  const changes = [];
  const refs = {byIndex: new Map(), byId: new Map()};

  for (let index = 0; index < events.length; index++) {
    const input = events[index];
    const title = text(input.title, 200);
    const startAt = text(input.startAt, 40);
    const sourceKey = text(input.sourceKey, 200);
    const found = findEvent(store, {sourceId: origin.sourceId, sourceKey, title, startAt, company: text(input.company, 120), school: text(input.school, 60)});
    const record = eventRecord({...input, id: found.id}, found.row, origin);
    record.id = found.id;
    store.upsertEvent(record);
    const saved = store.getEvent(record.id);
    changes.push({
      action: found.row ? 'update' : 'create',
      entity: 'events',
      entityId: saved.id,
      oldValues: found.row || null,
      newValues: saved,
      note: origin.notes
    });
    refs.byIndex.set(index, saved.id);
    refs.byId.set(saved.id, saved.id);
  }

  for (let index = 0; index < projects.length; index++) {
    const input = projects[index];
    const eventId = resolveEventId(input, refs, index);
    const projectSourceId = text(input.sourceId, 80) || origin.sourceId;
    const company = text(input.company, 120);
    const title = text(input.title, 200);
    const sourceKey = text(input.sourceKey, 200)
      || createHash('sha1').update([projectSourceId, company, title, text(input.sourceUrl, 500)].join('|')).digest('hex').slice(0, 32);
    const previousRow = store.db.prepare('SELECT id FROM event_projects WHERE event_id=? AND source_id=? AND source_key=?').get(eventId, projectSourceId, sourceKey);
    const previous = previousRow ? store.getProject(previousRow.id) : null;
    const saved = store.upsertProject({
      ...(previous ? {id: previous.id} : {}),
      eventId,
      company,
      title,
      positions: pick(input.positions, previous?.positions, '', 2000),
      requirements: pick(input.requirements, previous?.requirements, '', 4000),
      applyMode: pick(input.applyMode, previous?.applyMode, '', 60),
      applyUrl: pick(input.applyUrl, previous?.applyUrl, '', 500),
      sourceUrl: pick(input.sourceUrl, previous?.sourceUrl, origin.sourceUrl, 500),
      notes: input.notes !== undefined ? text(input.notes, 2000) : (previous?.notes || origin.notes),
      sourceId: projectSourceId,
      sourceKey,
      confidence: Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : (Number(previous?.confidence) || 0.8)
    });
    changes.push({
      action: previous ? 'update' : 'create',
      entity: 'event_projects',
      entityId: saved.id,
      oldValues: previous || null,
      newValues: saved,
      note: origin.notes
    });
  }

  return {
    changes,
    result: {
      events: changes.filter(change => change.entity === 'events').map(change => ({id: change.entityId, action: change.action})),
      projects: changes.filter(change => change.entity === 'event_projects').map(change => ({id: change.entityId, action: change.action}))
    }
  };
}
