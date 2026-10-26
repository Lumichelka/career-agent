// 外部 Agent 文本复核（#40）：只把抽取 JSON 与来源元数据交给一个只读、收 prompt 的工具，
// 只要求返回问题列表 {row, field, issue, severity}；建议制，不修改写入集、不写库、不读图。
// 复核调用使用 #34/#35 的连接与结果信封；失败只降级成「复核不可用」，不阻断写库。
import {ExternalToolset, externalError, EXTERNAL_RECOVERY} from '../agents/tools.mjs';

export const REVIEW_STEP = 'review';
export const REVIEW_MAX_ISSUES = 100;
export const REVIEW_MAX_RAW = 4000;
export const REVIEW_PROMPT_HEADER = [
  '你是来源校对任务里的独立复核员。只做文本复核：不读图、不调用工具、不修改数据、不执行写入。',
  '只输出 JSON，不要解释。格式：{"issues":[{"row":"events[0]","field":"title","issue":"……","severity":"high|medium|low"}]}。',
  '没有问题就输出 {"issues":[]}。不要给出修改后的数据，只列问题。'
].join('\n');

function textOf(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

// prompt 只拼来源元数据与抽取 JSON，绝不带截图、截图路径或写工具。
export function buildReviewPrompt({extraction = {}, source = {}} = {}) {
  const payload = {
    source: {
      id: textOf(source.id, 80),
      name: textOf(source.name || source.school, 120),
      school: textOf(source.school, 60),
      listUrl: textOf(source.listUrl, 500),
      detailUrl: textOf(source.detailUrl || extraction?.source?.detailUrl, 500)
    },
    extraction
  };
  return REVIEW_PROMPT_HEADER + '\n来源元数据与抽取 JSON：\n' + JSON.stringify(payload, null, 2) + '\n只返回问题列表，不要修改数据，不要读图。';
}

function normalizeIssue(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const issue = textOf(item.issue ?? item.message, 500);
  const field = textOf(item.field, 120);
  if (!issue && !field) return null;
  const severity = ['high', 'medium', 'low'].includes(String(item.severity || '').toLowerCase())
    ? String(item.severity).toLowerCase()
    : textOf(item.severity, 20);
  return {row: textOf(item.row ?? item.eventRef ?? item.index, 120), field, issue, severity};
}

// 解析问题列表：接受纯 JSON、{issues:[...]}、代码块包裹；解析失败返回 null（原文由调用方存证据）。
export function parseReviewIssues(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  let body = raw;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) body = fenced[1].trim();
  const brace = body.indexOf('{');
  const bracket = body.indexOf('[');
  const start = brace < 0 ? bracket : bracket < 0 ? brace : Math.min(brace, bracket);
  if (start > 0) body = body.slice(start);
  if (start < 0) return null;
  let parsed;
  try { parsed = JSON.parse(body); } catch { return null; }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.issues) ? parsed.issues : null;
  if (!list) return null;
  return list.map(normalizeIssue).filter(Boolean).slice(0, REVIEW_MAX_ISSUES);
}

function reviewCallRecord({agent = {}, tool = '', at = new Date().toISOString(), durationMs = 0, outcome = 'ok', errorCode = ''} = {}) {
  const record = {
    step: REVIEW_STEP,
    backend: {kind: 'agent', label: '复核 · ' + (agent.name || '外部 Agent'), agentId: agent.id || ''},
    at,
    durationMs: Math.max(0, Number(durationMs) || 0),
    outcome
  };
  if (errorCode) record.errorCode = String(errorCode).slice(0, 60);
  return record;
}

// 只读且收 prompt 的工具才是复核工具；写工具、缺 prompt 的工具一律不选。
const PROMPT_KEYS = ['prompt', 'query', 'text', 'message', 'input', 'content'];
export function selectReviewTool(tools = []) {
  const readOnly = (Array.isArray(tools) ? tools : []).filter(tool => tool && tool.readOnly === true);
  for (const key of PROMPT_KEYS) {
    const found = readOnly.find(tool => tool.parameters?.properties && Object.hasOwn(tool.parameters.properties, key));
    if (found) return {tool: found, key};
  }
  return null;
}

function reviewerError(message, {code = 'UNSUPPORTED', status = 400, recovery = EXTERNAL_RECOVERY.UNSUPPORTED, agent = null, tool = '', attempted = false} = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.recovery = recovery;
  error.agent = agent;
  error.tool = tool;
  error.attempted = attempted;
  return error;
}

// 默认复核器：取一个启用的外部 Agent，pin 后只调用只读、收 prompt 的工具。
// 复核由用户发起来源校对时明确触发，且只发送已落在任务证据里的抽取 JSON，所以这里只做一次出网放行；
// 不把上游写工具、截图或任务工具面交给它。
export function createExternalReviewer({config, connections, home = '', evidenceDir = '', taskId = '', emit = () => {}, now = Date.now, callTimeoutMs = 60000} = {}) {
  if (!config || !connections) throw new Error('外部复核需要 config 与 connections');
  return async ({extraction, source, signal} = {}) => {
    const enabled = (config.agents || []).filter(agent => agent && agent.enabled !== false);
    if (!enabled.length) {
      throw reviewerError('还没有配置可用于复核的外部 Agent，本次没有发送任何内容。', {
        code: 'AGENT_NOT_CONFIGURED',
        recovery: '在「模型与接口设置」的外部 Agent 页签添加并启用一个外部 Agent，然后重试来源校对。',
        attempted: false
      });
    }
    const toolset = new ExternalToolset({
      userId: '', taskId, home, evidenceDir, config, connections,
      emit, askConsent: async () => ({decision: 'once'}), now, callTimeoutMs
    });
    let snapshot;
    try {
      snapshot = await toolset.pin();
    } catch (error) {
      const mapped = externalError(error);
      throw reviewerError(mapped.message, {...mapped, agent: null, attempted: false});
    }
    const tool = selectReviewTool(toolset.tools);
    if (!tool) {
      const failed = snapshot?.unavailable?.[0];
      if (failed) throw reviewerError(failed.message, {code: failed.code, recovery: failed.recovery, agent: {id: failed.agentId, name: failed.name}});
      throw reviewerError('复核 Agent 没有可用的只读 prompt 工具（写工具不会用于复核）。', {
        code: 'UNSUPPORTED',
        recovery: '给外部 Agent 配置一个只读、接收 prompt 并返回文本的工具后再试。',
        attempted: false
      });
    }
    const agent = {id: tool.tool.agentId, name: tool.tool.agentName};
    const started = now();
    const at = new Date(started).toISOString();
    const envelope = await toolset.callTool(tool.tool, {[tool.key]: buildReviewPrompt({extraction, source})}, {signal});
    const durationMs = now() - started;
    const call = reviewCallRecord({agent, tool: tool.tool.upstreamTool, at, durationMs, outcome: envelope.status === 'ok' ? 'ok' : 'failed', errorCode: envelope.error?.code});
    if (envelope.status !== 'ok') {
      return {ok: false, call, agent, tool: tool.tool.upstreamTool, error: envelope.error || {code: 'UPSTREAM_ERROR', message: '外部 Agent 复核失败', recovery: EXTERNAL_RECOVERY.UPSTREAM_ERROR}};
    }
    const text = String(envelope.data?.text ?? '');
    const issues = parseReviewIssues(text);
    return {ok: true, call, agent, tool: tool.tool.upstreamTool, text: text.slice(0, 20000), issues, raw: issues === null ? text.slice(0, REVIEW_MAX_RAW) : ''};
  };
}

export function fallbackReviewCall({agent = null, tool = '', durationMs = 0, outcome = 'failed', errorCode = ''} = {}) {
  return reviewCallRecord({agent: agent || {}, tool, at: new Date().toISOString(), durationMs, outcome, errorCode});
}
