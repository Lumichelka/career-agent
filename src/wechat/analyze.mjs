// 公众号文章分析：判断是否含招聘信息，抽取活动/项目草稿；不自动写库。
import {extractDraft} from '../recruit/manual.mjs';

const COMPANY_RE = /(?:公司|集团|银行|医院|学校|研究院|事务所|中心|大学|局|厂|院)/;

export function extractProjects(text, limit = 30) {
  const out = [];
  const seen = new Set();
  const suffix = /^(.{2,60}?(?:公司|集团|银行|医院|研究院|事务所|局|厂|学校))(?=$|[\s（(：:，,])/;
  for (const raw of String(text || '').split(/\n+/)) {
    const line = raw.replace(/^[\s\-*•·\d.、]+/, '').trim();
    if (line.length < 5 || line.length > 120) continue;
    if (/[。！？；]/.test(line)) continue;
    if (/^(欢迎|请|如需|完成|衷心|根据|部分|国家|主动|成绩|查询|预计|计划|提升|按|一般|各|关注|点击|扫描|办公|地址|电话|微信|公众号|就业网|学校|学院|中心|求职|考研|留学|入伍|公务员)/.test(line)) continue;
    if (/邀请函|手册|月历|通知|公告|活动安排|报名流程|访问|注册|联系|宣传/.test(line)) continue;
    let m = line.match(suffix);
    if (!m) {
      const simple = line.match(/^(.{2,40}?)\s+(?:校园招聘|招聘)\s*[：:]?\s*(.+)$/);
      if (!simple) continue;
      const c = simple[1].trim();
      if (/[，,。；|｜@]/.test(c) || /(会|活动|信息|岗位|就业|招聘|公众号)$/.test(c)) continue;
      if (seen.has(c)) continue;
      seen.add(c);
      out.push({company: c.slice(0, 80), title: simple[2].split(/[|｜，,（(]/)[0].trim().slice(0, 80), positions: '', applyMode: '', sourceUrl: '', notes: '来自公众号文章，需核对'});
      if (out.length >= limit) break;
      continue;
    }
    const company = m[1].trim();
    if (company.length < 3 || /@|你有一份|就业|招聘|公众号|大学$|学院$|中心$/.test(company)) continue;
    if (seen.has(company)) continue;
    seen.add(company);
    let rest = line.slice(m[0].length).replace(/^[\s:：,，\-—]+/, '').replace(/^(校园招聘|招聘|双选会|宣讲会)[：:\s]*/, '');
    const title = rest.split(/[|｜，,（(]/)[0].trim().slice(0, 80);
    out.push({company: company.slice(0, 80), title, positions: '', applyMode: '', sourceUrl: '', notes: '来自公众号文章，需核对'});
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
  const titleLike = /双选|宣讲|招聘会|专场|招聘/.test(title) ? title : '';
  const summary = (titleLike || relevant || title).slice(0, 300);
  const draft = extractDraft({text: body, title, url});
  const projects = extractProjects(body);

  const warnings = [];
  if (hasRecruitment === 'uncertain') warnings.push('文章提到招聘，但没有明确活动/岗位，建议人工确认');
  if (!draft.startAt) warnings.push('未识别到开始时间');
  if (!projects.length) warnings.push('未识别到参会单位/项目');
  return {hasRecruitment, summary, draft, projects, warnings};
}
