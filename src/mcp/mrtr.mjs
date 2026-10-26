// MRTR（契约 #21 §9）：sampling / elicitation / roots 三个 handler。
// sampling 用该用户「当前」模型（api / local；owner 可用 Codex）补全：固定 system 约束、
// maxTokens ≤2048、单次 ≤30s、带 tools 一律 UNSUPPORTED、未配置模型 SAMPLING_UNAVAILABLE；
// 每个 Agent 第一次采样前只提示一次可能产生费用。
// elicitation 只负责把表单送到对话页并等用户提交/拒绝/取消（5 分钟超时、不预填）；
// 本应用自己的敏感写确认永远不走这里。roots 只给该用户的 users/<id> 一个根。
import {pathToFileURL} from 'node:url';
import {runSamplingCompletion, SAMPLING_TIMEOUT_MS} from '../model/api-model.mjs';

export const SAMPLING_SYSTEM = '你是被外部 Agent 请求补全的模型；只回答请求内容，不调用工具，不读取本地数据';
export const SAMPLING_MAX_TOKENS = 2048;
export const SAMPLING_TIMEOUT = SAMPLING_TIMEOUT_MS;
export const ELICITATION_TIMEOUT_MS = 5 * 60 * 1000;
export const ROOT_NAME = '职向数据目录';
export const SAMPLING_NOTICE = '外部 Agent 正在请求用你的当前模型补全，可能会产生费用；模型只回答请求内容，不调用工具、不读取本地数据。';

export function mrtrError(code, message, recovery = '') {
  const error = new Error(message);
  error.code = code;
  if (recovery) error.recovery = recovery;
  return error;
}

// MCP 的 sampling 消息可能是字符串，也可能是 text/image 块数组；这里只拼接文本，图片给占位。
export function samplingMessages(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  return list.map(message => {
    const role = message?.role === 'assistant' ? 'assistant' : 'user';
    const content = message?.content;
    let text;
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      text = content.map(block => {
        if (!block || typeof block !== 'object') return '';
        if (block.type === 'text') return String(block.text ?? '');
        if (block.type === 'image') return '〔图片〕';
        if (block.type === 'audio') return '〔音频〕';
        if (block.type === 'tool_use' || block.type === 'tool_result') return '〔工具内容〕';
        return '';
      }).join('\n');
    } else text = '';
    return {role, content: text};
  });
}

export function samplingTokenLimit(requested) {
  const value = Number(requested);
  if (!Number.isFinite(value) || value <= 0) return SAMPLING_MAX_TOKENS;
  return Math.min(Math.trunc(value), SAMPLING_MAX_TOKENS);
}

// 表单通道：request() 发事件并等待；respond() 由 HTTP 接口调用；超时按 cancel 结束。
export function createElicitationChannel({timer = defaultTimer(), timeoutMs = ELICITATION_TIMEOUT_MS, now = Date.now} = {}) {
  const pending = new Map();
  const channel = {
    pending,
    request({userId = '', taskId = '', elicitId = '', agentId = '', agentName = '', title = '', message = '', requestedSchema = null, emit = null, signal = null, timeoutMs: overrideMs = null} = {}) {
      if (!userId) throw new Error('elicitation 需要用户身份');
      const id = elicitId || ('elicit-' + Math.random().toString(36).slice(2) + now().toString(36));
      const limit = Math.max(1, Number(overrideMs) || timeoutMs);
      const event = {
        type: 'mrtr_elicit_required',
        taskId,
        elicitId: id,
        agentId,
        agentName,
        title: title || ('来自 ' + (agentName || '外部 Agent') + ' 的请求'),
        message: String(message || '').slice(0, 2000),
        requestedSchema: requestedSchema && typeof requestedSchema === 'object' ? requestedSchema : {type: 'object', properties: {}},
        timeoutMs: limit,
        at: new Date(now()).toISOString()
      };
      const done = (action, content = null, reason = '') => {
        const entry = pending.get(id);
        if (!entry) return false;
        pending.delete(id);
        entry.cleanup();
        entry.emit?.({type: 'mrtr_elicit_resolved', taskId: entry.taskId, elicitId: id, agentId: entry.agentId, action, reason, at: new Date(now()).toISOString()});
        entry.resolve(action === 'accept' ? {action, content: content || {}} : {action: action === 'decline' ? 'decline' : 'cancel'});
        return true;
      };
      return {
        elicitId: id,
        promise: new Promise((resolve, reject) => {
          const entry = {
            userId, taskId, agentId, emit, resolve, reject,
            cleanup: () => {
              if (entry.timer) timer.clearTimeout(entry.timer);
              if (entry.onAbort) signal?.removeEventListener('abort', entry.onAbort);
            }
          };
          entry.timer = timer.setTimeout(() => done('cancel', null, 'timeout'), limit);
          if (signal) {
            entry.onAbort = () => done('cancel', null, 'cancelled');
            signal.addEventListener('abort', entry.onAbort, {once: true});
          }
          pending.set(id, entry);
          emit?.(event);
          if (signal?.aborted) done('cancel', null, 'cancelled');
        })
      };
    },
    respond({userId, elicitId, action = '', content = null} = {}) {
      const entry = pending.get(String(elicitId || ''));
      if (!entry || entry.userId !== userId) return null;
      const chosen = ['accept', 'decline', 'cancel'].includes(action) ? action : '';
      if (!chosen) return {invalid: true};
      if (chosen !== 'accept' && content) return {invalid: true};
      const ok = this.pending.get(String(elicitId));
      if (!ok) return null;
      // done 在闭包里；这里重新走一遍同样的收尾路径。
      const done = value => {
        const target = pending.get(String(elicitId));
        if (!target) return false;
        pending.delete(String(elicitId));
        target.cleanup();
        target.emit?.({type: 'mrtr_elicit_resolved', taskId: target.taskId, elicitId: String(elicitId), agentId: target.agentId, action: value, reason: '', at: new Date(now()).toISOString()});
        target.resolve(value === 'accept' ? {action: 'accept', content: content && typeof content === 'object' ? {...content} : {}} : {action: value});
        return true;
      };
      return done(chosen) ? {ok: true, action: chosen} : null;
    },
    close() {
      for (const [id] of [...pending]) this.respond({userId: pending.get(id)?.userId, elicitId: id, action: 'cancel'});
    }
  };
  return channel;
}

export function createMrtrHandlers({
  userId = '',
  user = null,
  home = '',
  models = null,
  backends = null,
  gate = null,
  fetchImpl = null,
  root = '',
  createConnection = null,
  activeCallFor = () => null,
  askElicitation = null,
  onNotice = null,
  codexComplete = null,
  samplingTimeoutMs = SAMPLING_TIMEOUT,
  elicitationTimeoutMs = ELICITATION_TIMEOUT_MS,
  now = Date.now
} = {}) {
  if (!home) throw new Error('MRTR handlers 需要该用户的 home');
  const noticeSeen = new Set();
  const isOwner = user?.name === 'owner';

  function settings() {
    const snapshot = typeof models?.snapshot === 'function' ? models.snapshot() : {};
    let kind = '';
    try { kind = backends?.current?.(typeof models?.public === 'function' ? models.public() : snapshot) || ''; } catch { kind = ''; }
    if (!['codex', 'api', 'local'].includes(kind)) kind = snapshot?.mode === 'local' ? 'local' : snapshot?.mode === 'codex' ? 'codex' : 'api';
    return {snapshot, kind};
  }

  function modelPlan() {
    const {snapshot, kind} = settings();
    if (kind === 'codex') {
      if (!isOwner) return {unavailable: '本机 Codex 只有 owner 能用，当前账号没有可采样的模型。'};
      return {kind, model: 'codex', config: snapshot};
    }
    if (!snapshot?.model || !snapshot?.baseUrl) return {unavailable: '还没有配置模型，无法替外部 Agent 采样。'};
    return {kind: snapshot.mode === 'local' ? 'local' : 'api', model: snapshot.model, config: snapshot};
  }

  function emitActive(agent, event) {
    const context = activeCallFor?.(agent.id);
    if (!context?.emit) return;
    context.emit({taskId: context.taskId || '', at: new Date(now()).toISOString(), ...event});
  }

  async function sampling(agent, request, extra = {}) {
    if (agent?.mrtr?.sampling === false) {
      throw mrtrError('UNSUPPORTED', '这个外部 Agent 的 sampling 开关已关闭：本应用不替它补全。', '在该 Agent 的设置里打开 sampling，或让外部 Agent 自己完成这一步。');
    }
    const params = request?.params && typeof request.params === 'object' ? request.params : (request && typeof request === 'object' ? request : {});
    if (Array.isArray(params.tools) && params.tools.length) {
      throw mrtrError('UNSUPPORTED', '采样请求带了 tools：本应用不为上游运行工具循环。', '让外部 Agent 自己完成工具步骤。');
    }
    const plan = modelPlan();
    if (plan.unavailable) throw mrtrError('SAMPLING_UNAVAILABLE', plan.unavailable, '先到「模型与接口设置」里配置 API 或本地模型，再重试。');
    if (!noticeSeen.has(agent.id)) {
      noticeSeen.add(agent.id);
      const payload = {type: 'mrtr_sampling_notice', agentId: agent.id, agentName: agent.name, text: SAMPLING_NOTICE, warning: SAMPLING_NOTICE};
      if (typeof onNotice === 'function') onNotice(payload);
      else emitActive(agent, payload);
    }
    const maxTokens = samplingTokenLimit(params.maxTokens);
    const messages = samplingMessages(params.messages);
    const signal = extra?.signal || null;
    const call = async () => {
      if (plan.kind === 'codex') {
        if (typeof codexComplete !== 'function') {
          throw mrtrError('SAMPLING_UNAVAILABLE', '当前是 Codex 后端，但采样补全没有接通。');
        }
        const prompt = messages.map(message => message.role + '：' + message.content).join('\n\n');
        const out = await codexComplete({prompt: SAMPLING_SYSTEM + '\n\n' + prompt, signal, timeoutMs: samplingTimeoutMs});
        return {text: String(out?.text ?? out ?? ''), model: 'codex'};
      }
      return runSamplingCompletion({
        config: plan.config,
        messages,
        system: SAMPLING_SYSTEM,
        maxTokens,
        fetchImpl,
        signal,
        timeoutMs: samplingTimeoutMs
      });
    };
    let out;
    try {
      out = gate ? await gate.run(userId, call, {signal, timeoutMs: samplingTimeoutMs}) : await call();
    } catch (error) {
      if (error?.code === 'QUEUE_TIMEOUT') throw error;
      if (error?.code) throw error;
      throw mrtrError('UPSTREAM_ERROR', String(error?.message || '采样失败').slice(0, 500), '稍后重试；持续失败就让外部 Agent 自己完成这一步。');
    }
    return {
      model: out?.model || plan.model,
      stopReason: 'endTurn',
      role: 'assistant',
      content: {type: 'text', text: String(out?.text ?? '')}
    };
  }

  async function elicitation(agent, request, extra = {}) {
    if (agent?.mrtr?.elicitation === false) {
      throw mrtrError('UNSUPPORTED', '这个外部 Agent 的 elicitation 开关已关闭：本应用不替它弹表单。', '在该 Agent 的设置里打开 elicitation，或让外部 Agent 自己询问。');
    }
    const params = request?.params && typeof request.params === 'object' ? request.params : (request && typeof request === 'object' ? request : {});
    const context = activeCallFor?.(agent.id) || null;
    if (typeof askElicitation !== 'function' || !context?.emit) {
      // 没有对话页可弹：明确拒绝，绝不编造答案。
      return {action: 'decline'};
    }
    const answer = await askElicitation({
      agentId: agent.id,
      agentName: agent.name,
      title: '来自 ' + agent.name + ' 的请求',
      message: String(params.message || ''),
      requestedSchema: params.requestedSchema && typeof params.requestedSchema === 'object' ? params.requestedSchema : {type: 'object', properties: {}},
      timeoutMs: elicitationTimeoutMs,
      context,
      signal: extra?.signal || context.signal || null
    });
    if (!answer || !['accept', 'decline', 'cancel'].includes(answer.action)) return {action: 'decline'};
    if (answer.action === 'accept') {
      const content = answer.content && typeof answer.content === 'object' && !Array.isArray(answer.content) ? {...answer.content} : {};
      return {action: 'accept', content};
    }
    return {action: answer.action};
  }

  function roots() {
    return {roots: [{uri: pathToFileURL(home).href, name: ROOT_NAME}]};
  }

  // 每个连接按 Agent 自己的 mrtr 开关与身份绑定 handler；共享同一个 noticeSeen（会话级）。
  function handlersFor(agent) {
    return {
      sampling: (request, extra) => sampling(agent, request, extra),
      elicitation: (request, extra) => elicitation(agent, request, extra),
      roots: () => roots()
    };
  }

  return {handlersFor, noticeSeen, sampling, elicitation, roots, modelPlan};
}

function defaultTimer() {
  return {
    setTimeout(fn, ms) {
      const handle = setTimeout(fn, ms);
      if (typeof handle.unref === 'function') handle.unref();
      return handle;
    },
    clearTimeout(handle) { clearTimeout(handle); }
  };
}
