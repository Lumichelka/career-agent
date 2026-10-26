// 外部 Agent 作为聊天后端的最小执行体（#34/#35 的接线）：
// 选一个启用 Agent 的只读、收 prompt 的工具，把用户消息与上下文交给它，返回的文本包成正常 runAgent 结果形状。
// 不是完整的模型工具循环：外部 Agent 用自己的工具，本应用不把本地工具面交给它。
import {ExternalToolset, externalError, selectPromptTool, EXTERNAL_RECOVERY} from './tools.mjs';

export const AGENT_TURN_MAX_PROMPT = 64000;

export function buildAgentPrompt({message = '', attachments = [], profile = [], memory = ''} = {}) {
  const textAttachments = (Array.isArray(attachments) ? attachments : [])
    .filter(item => item && typeof item.text === 'string' && item.text.trim())
    .map(item => '【附件：' + String(item.name || '资料') + '】\n' + item.text.slice(0, 20000))
    .join('\n\n');
  const parts = ['你是用户选择的外部 Agent。请直接完成用户消息，用中文回答；不要编造未提供的事实，也不要索取或泄露凭据。'];
  if (Array.isArray(profile) && profile.length) parts.push('用户已确认的画像：' + JSON.stringify(profile).slice(0, 8000));
  if (memory) parts.push('对话记忆：' + String(memory).slice(0, 5000));
  parts.push('用户消息：\n' + String(message || '').slice(0, 32000));
  if (textAttachments) parts.push('本轮附件：\n' + textAttachments.slice(0, 30000));
  return parts.join('\n\n').slice(0, AGENT_TURN_MAX_PROMPT);
}

function agentError(message, {code = 'UPSTREAM_ERROR', recovery = EXTERNAL_RECOVERY[code] || EXTERNAL_RECOVERY.UPSTREAM_ERROR, agent = null, tool = '', attempted = false} = {}) {
  const error = new Error(message);
  error.code = code;
  error.recovery = recovery;
  error.agent = agent;
  error.tool = tool;
  error.attempted = attempted;
  return error;
}

function callRecord({agent, tool, at, durationMs, outcome = 'ok', errorCode = ''}) {
  const record = {
    // 外部 Agent 聊天只有一次执行调用；复核走 source-check 的 step=review。
    step: 'act',
    backend: {kind: 'agent', preset: '', model: '', agentId: agent.id, label: agent.name ? '外部 Agent · ' + agent.name : '外部 Agent'},
    at,
    durationMs: Math.max(0, Number(durationMs) || 0),
    outcome
  };
  if (errorCode) record.errorCode = String(errorCode).slice(0, 60);
  return record;
}

// 包成 app.mjs 期望的形状：reply / memory / sources / artifact / visualization / calls / trace / quality。
export function agentTurnResult({reply, call, durationMs = 0}) {
  return {
    reply,
    memory: '',
    sources: [],
    artifact: {title: '', content: ''},
    visualization: {title: '', unit: '', items: []},
    plan: null,
    trace: [],
    quality: {status: 'checked', issues: []},
    skill: null,
    calls: call ? [call] : [],
    durationMs: Math.max(0, Number(durationMs) || 0),
    hadToolSuccess: false,
    toolSuccesses: 0
  };
}

// 选中的 Agent 单独 pin：不把同一用户其他 Agent 的工具混进这一轮，也不让未同意的 Agent 收到内容。
export async function runAgentBackend({
  userId = '', taskId = '', home = '', evidenceDir = '', agent, config, connections,
  message = '', attachments = [], profile = [], memory = '', emit = () => {}, signal,
  askConsent = null, now = Date.now, fallback = false
} = {}) {
  if (!agent || !agent.id) throw agentError('没有选中的外部 Agent。', {code: 'AGENT_NOT_CONFIGURED'});
  if (!config || !connections) throw agentError('外部 Agent 执行体缺少配置或连接。', {code: 'UNSUPPORTED'});
  if (signal?.aborted) throw agentError('本次任务已停止。', {code: 'CANCELLED'});

  const record = (config.agents || []).find(item => item && item.id === agent.id) || null;
  if (!record || record.enabled === false) throw agentError('选中的外部 Agent 不存在或已停用。', {code: 'AGENT_NOT_CONFIGURED', agent: {id: agent.id, name: agent.name || ''}});

  const scopedConfig = {
    agents: [record],
    outboundConsent: id => (typeof config.outboundConsent === 'function' ? config.outboundConsent(id) : {neverAsk: false}),
    approveOutbound: (id, options) => (typeof config.approveOutbound === 'function' ? config.approveOutbound(id, options) : null)
  };
  const toolset = new ExternalToolset({
    userId, taskId, home, evidenceDir, config: scopedConfig, connections, emit, askConsent, now
  });
  let snapshot;
  try {
    snapshot = await toolset.pin();
  } catch (error) {
    const mapped = externalError(error);
    throw agentError(mapped.message, {...mapped, agent: {id: agent.id, name: agent.name || ''}, attempted: false});
  }
  const tool = selectPromptTool(toolset.tools);
  if (!tool) {
    const failed = snapshot?.unavailable?.[0];
    if (failed) {
      throw agentError(failed.message, {
        code: failed.code, recovery: failed.recovery,
        agent: {id: failed.agentId, name: failed.name}, attempted: true
      });
    }
    throw agentError('这个外部 Agent 没有可用的只读 prompt 工具（写工具不会用于聊天执行）。', {
      code: 'UNSUPPORTED',
      recovery: '给外部 Agent 配置一个只读、接收 prompt 并返回文本的工具后再试。',
      agent: {id: agent.id, name: agent.name || ''},
      attempted: false
    });
  }

  const started = now();
  const at = new Date(started).toISOString();
  emit({type: 'status', text: '正在请求外部 Agent「' + String(agent.name || '未命名') + '」…'});
  const envelope = await toolset.callTool(tool.tool, {[tool.key]: buildAgentPrompt({message, attachments, profile, memory})}, {signal});
  const durationMs = now() - started;
  const call = callRecord({
    agent: {id: agent.id, name: agent.name || ''},
    tool: tool.tool.upstreamTool,
    at, durationMs,
    outcome: envelope.status === 'ok' ? (fallback ? 'fallback' : 'ok') : 'failed',
    errorCode: envelope.error?.code
  });
  if (envelope.status !== 'ok') {
    const error = envelope.error || {code: 'UPSTREAM_ERROR', message: '外部 Agent 执行失败', recovery: EXTERNAL_RECOVERY.UPSTREAM_ERROR};
    throw agentError(String(error.message || '外部 Agent 执行失败'), {
      code: error.code, recovery: error.recovery, agent: {id: agent.id, name: agent.name || ''}, tool: tool.tool.upstreamTool, attempted: true
    });
  }
  const reply = String(envelope.data?.text ?? '').trim();
  if (!reply) {
    throw agentError('外部 Agent 返回了空文本，这一轮没有可用回复。', {
      code: 'INVALID_RESULT', recovery: EXTERNAL_RECOVERY.INVALID_RESULT,
      agent: {id: agent.id, name: agent.name || ''}, tool: tool.tool.upstreamTool, attempted: true
    });
  }
  emit({type: 'status', text: '外部 Agent 已返回结果'});
  return agentTurnResult({reply, call, durationMs: now() - started});
}
