// 视觉抽取结果的清洗与落库前规范化：
// 只保留活动与单位字段；联系方式（联系人/手机/邮箱/微信/身份证）在写库与审计之前整段丢弃；
// 读不到的字段留空，读不懂的活动/单位不写入（绝不编造）。
import {readFile} from 'node:fs/promises';
import {basename} from 'node:path';
import {runVisionJson} from '../model/api-model.mjs';

const CONTACT_KEY = /(contact|phone|mobile|telephone|tel|email|mail|wechat|weixin|idcard|identity|联系人|联系方式|手机|电话|邮箱|微信|身份证|证件)/i;
const CONTACT_VALUE = /^(?:1[3-9]\d{9}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\d{17}[\dXx])$/;

const text = (value, max) => {
  if (value === null || value === undefined) return '';
  return String(value).trim().slice(0, max);
};

export function isContactField(key) {
  const normalized = String(key ?? '').toLowerCase().replace(/[\s_-]/g, '');
  return CONTACT_KEY.test(normalized);
}

// 递归删除联系方式字段；只由纯联系方式构成的值也一并抹掉，避免从值侧漏进审计。
export function stripContacts(value) {
  if (Array.isArray(value)) return value.map(item => stripContacts(item));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (isContactField(key)) continue;
      out[key] = stripContacts(item);
    }
    return out;
  }
  if (typeof value === 'string' && CONTACT_VALUE.test(value.trim())) return '';
  return value;
}

export const EXTRACTION_PROMPT = [
  '你是来源校对任务里的视觉抽取器。只依据给出的截图（列表页 + 一场活动详情）提取，不补充任何外部知识。',
  '只输出 JSON 对象，格式：{"events":[{"title":"","startAt":"","endAt":"","venue":"","school":"","city":"","kind":""}],"projects":[{"eventRef":0,"company":"","title":"","positions":"","requirements":"","applyMode":"","applyUrl":""}]}。',
  'startAt 用 ISO 时间（例如 2026-11-05T09:00:00+08:00）；截图上读不到的字段留空字符串，绝不猜测、绝不编造。',
  'eventRef 是 projects 对应 events 的下标（从 0 开始）。',
  '不要输出联系人、手机、邮箱、微信、身份证等联系方式字段；这些信息会被丢弃。'
].join('\n');

export function buildExtractionPrompt(source = {}) {
  return EXTRACTION_PROMPT + '\n来源：' + String(source.name || source.school || '未知来源') + '；学校默认西南财经大学，城市默认成都，类型默认双选会。';
}

// 只保留写入需要的事件/单位字段；跳过没有标题/开始时间的活动，跳过没有单位名/项目名的单位。
export function normalizeExtraction(raw, {source = {}, detailUrl = ''} = {}) {
  const cleaned = stripContacts(raw && typeof raw === 'object' ? raw : {});
  const rawEvents = Array.isArray(cleaned.events) ? cleaned.events : [];
  const rawProjects = Array.isArray(cleaned.projects) ? cleaned.projects : [];
  const events = [];
  const indexMap = new Map();
  let skippedEvents = 0;
  for (let index = 0; index < rawEvents.length; index++) {
    const input = rawEvents[index];
    if (!input || typeof input !== 'object' || Array.isArray(input)) { skippedEvents++; continue; }
    const title = text(input.title, 200);
    const startAt = text(input.startAt, 40);
    if (!title || !startAt) { skippedEvents++; continue; }
    indexMap.set(index, events.length);
    events.push({
      title,
      startAt,
      endAt: text(input.endAt, 40),
      venue: text(input.venue, 200),
      school: text(input.school, 60) || '西南财经大学',
      city: text(input.city, 20) || '成都',
      kind: text(input.kind, 20) || '双选会',
      sourceUrl: detailUrl || text(input.sourceUrl, 500)
    });
  }
  const projects = [];
  let skippedProjects = 0;
  for (const input of rawProjects) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) { skippedProjects++; continue; }
    const company = text(input.company, 120);
    const title = text(input.title, 200);
    if (!company && !title) { skippedProjects++; continue; }
    const rawIndex = Number.isInteger(input.eventIndex) ? input.eventIndex : Number.isInteger(input.eventRef) ? input.eventRef : 0;
    const eventIndex = indexMap.get(rawIndex);
    if (eventIndex === undefined) { skippedProjects++; continue; }
    projects.push({
      eventIndex,
      company,
      title,
      positions: text(input.positions, 2000),
      requirements: text(input.requirements, 4000),
      applyMode: text(input.applyMode, 60),
      applyUrl: text(input.applyUrl, 500)
    });
  }
  return {
    source: {
      id: text(source.id, 80),
      name: text(source.name, 120),
      listUrl: text(source.listUrl, 500),
      detailUrl: text(detailUrl, 500)
    },
    events,
    projects,
    skipped: {events: skippedEvents, projects: skippedProjects},
    extractedAt: new Date().toISOString()
  };
}

function visionConfigError(message, recovery) {
  const error = new Error(message);
  error.code = 'VISION_NOT_CONFIGURED';
  error.recovery = recovery;
  return error;
}

// 视觉抽取器：把两张截图转成 data URL 交给当前视觉模型 API，只做一次 JSON 往返，不调用工具。
export function createVisionExtractor({config = {}, visionCall = runVisionJson, readFileImpl = readFile} = {}) {
  return async ({screenshots = [], source = {}, signal} = {}) => {
    if (!config || config.mode === 'codex' || !config.baseUrl || !config.model) {
      throw visionConfigError('还没有可用的视觉模型 API，来源校对无法读图。', '在「模型与接口设置」里配置支持读图的模型 API（如 deepseek-flash）后重试。');
    }
    const images = [];
    for (const shot of screenshots.slice(0, 2)) {
      if (!shot?.file) continue;
      const bytes = await readFileImpl(shot.file);
      images.push({name: basename(shot.file), type: 'image', mime: 'image/png', dataUrl: 'data:image/png;base64,' + bytes.toString('base64')});
    }
    if (images.length !== 2) throw visionConfigError('视觉抽取需要列表页与详情页两张截图。', '重新发起来源校对；仍失败就改用手动导入。');
    const result = await visionCall({config, prompt: buildExtractionPrompt(source), images, signal});
    const json = result && typeof result === 'object' && 'json' in result ? result.json : result;
    if (!json || typeof json !== 'object') throw visionConfigError('视觉模型没有返回可用的 JSON。', '重试一次；仍失败就改用人工导入。');
    return json;
  };
}
