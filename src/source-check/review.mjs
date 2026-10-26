// 外部 Agent 文本复核（#40）：只把抽取 JSON 与来源元数据交给一个只读、收 prompt 的工具，
// 只要求返回问题列表 {row, field, issue, severity}；建议制，不修改写入集、不写库、不读图。
// 复核调用使用 #34/#35 的连接与结果信封；失败只降级成「复核不可用」，不阻断写库。
import {ExternalToolset, externalError, EXTERNAL_RECOVERY, selectPromptTool} from '../agents/tools.mjs';

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

// 只读且收 prompt 的工具才是复核工具；实现与外部 Agent 聊天执行共用 selectPromptTool。
export const selectReviewTool = selectPromptTool;

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

// 默认复核器：取一个已启用且用户已同意出网的外部 Agent，pin 后只调用只读、收 prompt 的工具。
// 复核在后台任务里跑，不能凭空替用户点头：只有该用户为这个 Agent 持久化过「以后不再问」才发送，
// 否则本次不发送任何内容，标 AGENT_CONSENT_REQUIRED 让用户去设置里明确同意。
export function createExternalReviewer({userId = '', config, connections, home = '', evidenceDir = '', taskId = '', emit = () => {}, now = Date.now, callTimeoutMs = 60000} = {}) {
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
    const consented = enabled.filter(agent => typeof config.outboundConsent === 'function' && config.outboundConsent(agent.id)?.neverAsk === true);
    if (!consented.length) {
      throw reviewerError('外部 Agent 复核需要你先同意首次出网，本次没有发送任何内容。', {
        code: 'AGENT_CONSENT_REQUIRED',
        recovery: '在「模型与接口设置」→「外部 Agent」里点「允许出网」（或在对话里选择「以后不再问」），然后重试来源校对。',
        attempted: false
      });
    }
    // 只把已同意的 Agent 放进这次 pin；不要让其他未同意 Agent 的工具被选中后收到内容。
    const scopedConfig = {
      agents: consented,
      outboundConsent: id => config.outboundConsent(id),
      approveOutbound: (id, options) => (typeof config.approveOutbound === 'function' ? config.approveOutbound(id, options) : null)
    };
    const toolset = new ExternalToolset({
      userId, taskId, home, evidenceDir, config: scopedConfig, connections,
      emit,
      // 已持久化同意的 Agent 会在 ensureConsent 里直接放行；这个兜底绝不静默发送。
      askConsent: async () => ({decision: 'reject', message: '复核没有新的出网同意，本次没有发送内容。'}),
      now, callTimeoutMs
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
