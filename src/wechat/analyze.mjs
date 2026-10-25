// 公众号文章分析：判断是否含招聘信息，抽取活动/项目草稿；不自动写库。
import {extractDraft} from '../recruit/manual.mjs';

const COMPANY_RE = /(?:公司|集团|银行|医院|学校|研究院|事务所|中心|大学|局|厂|院)/;

export function extractProjects(text, limit = 30) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text || '').split(/\n+/)) {
    const line = raw.replace(/^[\s\-*•·\d.、]+/, '').trim();
    if (line.length < 5 || line.length > 120) continue;
    if (!COMPANY_RE.test(line)) continue;
    if (/双选会|宣讲会|招聘会|活动时间|活动地点|举办|时间[:：]|地点[:：]/.test(line)) continue;
    if (/^(招聘|岗位|要求|时间|地点|投递|简历|宣讲|双选)/.test(line)) continue;
    const company = line.split(/[|｜：:，,（(]/)[0].trim().slice(0, 80);
    if (!company || company.length < 3 || seen.has(company)) continue;
    seen.add(company);
    out.push({company, title: '', positions: '', applyMode: '', sourceUrl: '', notes: '来自公众号文章，需核对'});
    if (out.length >= limit) break;
  }
  return out;
}

export function analyzeArticle({title = '', text = '', url = ''}) {
  const body = String(text || '').trim();
  const strong = /双选会|宣讲会|招聘会|校园招聘|招聘岗位|岗位需求|投递方式|现场招聘/.test(body);
  const weak = /招聘|校招|岗位|简历|投递/.test(body);
  const hasRecruitment = strong ? 'yes' : weak ? 'uncertain' : 'no';
  const lines = body.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const relevant = lines.find(l => /双选会|宣讲会|招聘会|招聘|岗位|投递/.test(l)) || lines[0] || '';
  const summary = (relevant || title).slice(0, 300);
  const draft = extractDraft({text: body, title, url});
  const projects = extractProjects(body);
  if (!projects.length && draft.company) projects.push({company: draft.company, title: draft.title || '', positions: '', applyMode: draft.applyMode || '', sourceUrl: url, notes: '来自文章标题/正文，需核对'});
  const warnings = [];
  if (hasRecruitment === 'uncertain') warnings.push('文章提到招聘，但没有明确活动/岗位，建议人工确认');
  if (!draft.startAt) warnings.push('未识别到开始时间');
  if (!projects.length) warnings.push('未识别到参会单位/项目');
  return {hasRecruitment, summary, draft, projects, warnings};
}
