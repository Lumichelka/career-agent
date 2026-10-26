// 后端顶栏（当前后端 / 本轮约花费 / 本次锁定）、候选卡与助手消息下的调用表。
// 数据来自 /api/backends 与助手消息的 calls；不引入框架，尽量不动首页内联代码。
(function () {
  const zx = window.__zx || {};
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

  const CAP_LABELS = {text: '文本', tools: '工具', vision: '读图'};
  const STEP_LABELS = {plan: '规划', act: '执行', review: '复核', sample: '采样'};
  const state = {info: null, lock: false, cost: null, pendingCandidates: null, pendingTimer: null, failure: null, failureTimer: null};

  // 与 src/model/prices.mjs 的 formatCny 保持同一口径：永远带「≈¥」。
  function formatCny(cny) {
    if (cny === null || cny === undefined || cny === '') return '';
    const n = Number(cny);
    if (!Number.isFinite(n)) return '';
    if (n === 0) return '≈¥0';
    const digits = n < 0.001 ? 6 : n < 0.01 ? 5 : n < 0.1 ? 4 : n < 1 ? 3 : 2;
    return '≈¥' + n.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
  }

  function totalCost(calls) {
    let sum = 0, found = false;
    for (const call of Array.isArray(calls) ? calls : []) {
      if (Number.isFinite(call?.cost?.cny)) { sum += call.cost.cny; found = true; }
    }
    return found ? sum : null;
  }

  function totalTokens(calls) {
    let sum = 0, found = false;
    for (const call of Array.isArray(calls) ? calls : []) {
      if (Number.isFinite(call?.usage?.total)) { sum += call.usage.total; found = true; }
    }
    return found ? sum : null;
  }

  function durationText(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value < 0) return '—';
    return value >= 1000 ? (value / 1000).toFixed(1) + 's' : Math.round(value) + 'ms';
  }

  // 调用表：只挂助手消息，展开后 步骤 / 后端 / 耗时 / 输入·输出 / ≈¥ / 备注。
  function callsHtml(calls, locked) {
    if (!Array.isArray(calls) || !calls.length) return '';
    const cost = totalCost(calls);
    const tokens = totalTokens(calls);
    const summary = [calls.length + ' 次'];
    if (cost !== null) summary.push(formatCny(cost));
    if (tokens !== null) summary.push(tokens.toLocaleString('en-US') + ' tok');
    else summary.push('未回传');
    if (locked) summary.push('本次锁定');
    const rows = calls.map(call => {
      const step = STEP_LABELS[call.step] || call.step || '';
      const backend = call.backend?.label || call.backend?.model || call.backend?.kind || '';
      const usage = call.usage
        ? String(call.usage.input ?? '—') + ' · ' + String(call.usage.output ?? '—')
        : '未回传';
      const price = Number.isFinite(call.cost?.cny) ? formatCny(call.cost.cny) : '—';
      const notes = [];
      if (call.outcome === 'failed') notes.push(call.errorCode || '失败');
      if (call.outcome === 'fallback') notes.push('回退');
      if (locked) notes.push('锁定');
      return '<tr><td>' + esc(step) + '</td><td>' + esc(backend) + '</td><td>' + esc(durationText(call.durationMs)) + '</td><td>' + esc(usage) + '</td><td>' + esc(price) + '</td><td>' + esc(notes.join(' · ') || '成功') + '</td></tr>';
    }).join('');
    return '<details class="calls"><summary>本次调用（' + esc(summary.join(' · ')) + '）</summary><div class="table-scroll"><table><thead><tr><th>步骤</th><th>后端</th><th>耗时</th><th>输入·输出</th><th>≈¥</th><th>备注</th></tr></thead><tbody>' + rows + '</tbody></table></div></details>';
  }
  window.__zxCallsHtml = callsHtml;

  function ensureBar() {
    let bar = $('#backend-bar');
    if (bar) return bar;
    const header = document.querySelector('header');
    if (!header) return null;
    bar = document.createElement('span');
    bar.id = 'backend-bar';
    bar.setAttribute('role', 'status');
    bar.setAttribute('aria-label', '当前后端、本轮预计花费与锁定');
    bar.innerHTML = '<span class="bb-current" id="bb-current">当前：读取中…</span>' +
      '<button type="button" class="bb-mode" id="bb-mode-api" aria-pressed="false" title="选择模型 API / 本地模型 / 本机 Codex">模型 API</button>' +
      '<button type="button" class="bb-mode" id="bb-mode-agent" aria-pressed="false" title="选择外部 Agent（只做文本与工具，不读图）">外部 Agent</button>' +
      '<span class="bb-cost" id="bb-cost">本轮 ≈¥—</span><button type="button" id="turn-lock" aria-pressed="false" title="锁定本轮：失败也不换后端">🔓 本次锁定</button>' +
      '<div id="bb-menu" hidden></div>';
    const toggle = $('#workflow-toggle');
    if (toggle && toggle.parentNode === header) header.insertBefore(bar, toggle);
    else header.appendChild(bar);
    $('#turn-lock').addEventListener('click', () => { state.lock = !state.lock; renderBar(); });
    $('#bb-mode-api').addEventListener('click', () => toggleMenu('api'));
    $('#bb-mode-agent').addEventListener('click', () => toggleMenu('agent'));
    return bar;
  }

  // 两个入口各自列出自己的候选：模型 API（api/local/codex）与外部 Agent（永不 vision）。
  function menuCards(slot) {
    const candidates = Array.isArray(state.info?.candidates) ? state.info.candidates : [];
    return candidates.filter(card => slot === 'agent' ? card.kind === 'agent' : card.kind !== 'agent');
  }

  function hideMenu() {
    const menu = $('#bb-menu');
    if (menu) { menu.hidden = true; menu.innerHTML = ''; }
  }

  function toggleMenu(slot) {
    const menu = $('#bb-menu');
    if (!menu) return;
    if (!menu.hidden && menu.dataset.slot === slot) { hideMenu(); return; }
    const current = state.info?.current || {};
    const cards = menuCards(slot);
    const rows = cards.map(card => {
      const selected = slot === 'agent' ? current.kind === 'agent' && current.agentId === card.agentId : current.kind === card.kind;
      const cost = card.approxCostPerCall === null || card.approxCostPerCall === undefined ? '' : ' · 约 ' + formatCny(card.approxCostPerCall) + '/次';
      return '<button type="button" class="bb-menu-item' + (card.configured ? '' : ' unconfigured') + '" data-menu-kind="' + esc(card.kind) + '" data-menu-agent="' + esc(card.agentId || '') + '" data-menu-configured="' + (card.configured ? 'true' : 'false') + '" aria-pressed="' + selected + '">' +
        '<b>' + esc(card.label) + '</b><small>' + esc(capabilityText(card.capabilities) + cost) + '</small></button>';
    }).join('');
    menu.dataset.slot = slot;
    menu.innerHTML = '<div class="bb-menu-head">' + (slot === 'agent' ? '选择外部 Agent' : '选择模型 API') + '</div>' +
      (rows || '<p class="bb-menu-empty">还没有可用候选，请先到「模型与接口设置」完成配置。</p>') +
      (slot === 'agent' ? '<button type="button" class="bb-menu-config" data-menu-config="agent-settings">管理外部 Agent…</button>' : '<button type="button" class="bb-menu-config" data-menu-config="model-settings">打开模型与接口设置…</button>');
    menu.hidden = false;
  }

  function renderBar() {
    ensureBar();
    const info = state.info;
    const current = info?.current;
    const currentEl = $('#bb-current');
    if (currentEl) {
      currentEl.textContent = '当前：' + (current?.label || '未配置');
      currentEl.title = current?.label || '';
    }
    const costEl = $('#bb-cost');
    if (costEl) costEl.textContent = state.cost === null ? '本轮 ≈¥—' : '本轮 ' + formatCny(state.cost);
    const lock = $('#turn-lock');
    if (lock) {
      lock.setAttribute('aria-pressed', String(state.lock));
      lock.textContent = state.lock ? '🔒 本次锁定' : '🔓 本次锁定';
    }
    const isAgent = current?.kind === 'agent';
    const apiEntry = $('#bb-mode-api');
    const agentEntry = $('#bb-mode-agent');
    if (apiEntry) apiEntry.setAttribute('aria-pressed', String(!isAgent));
    if (agentEntry) agentEntry.setAttribute('aria-pressed', String(isAgent));
  }

  async function refresh() {
    try {
      state.info = await zx.api('backends');
      renderBar();
    } catch { /* 未登录时静默 */ }
  }

  function capabilityText(capabilities) {
    return (Array.isArray(capabilities) ? capabilities : []).map(cap => CAP_LABELS[cap] || cap).join(' · ');
  }

  function candidatesHtml(event) {
    const cards = (Array.isArray(event.candidates) ? event.candidates : []).map(card => {
      const cost = card.approxCostPerCall === null || card.approxCostPerCall === undefined
        ? '未计价'
        : '约 ' + formatCny(card.approxCostPerCall) + '/次';
      const action = card.configured ? '' : '<span class="candidate-action">' + esc(card.configTarget === 'owner-only' ? '仅 owner 可用' : '去配置 …') + '</span>';
      return '<button type="button" class="candidate-card' + (card.configured ? '' : ' unconfigured') + '" data-backend-kind="' + esc(card.kind) + '" data-configured="' + (card.configured ? 'true' : 'false') + '" data-config-target="' + esc(card.configTarget || '') + '"><strong>' + esc(card.label) + '</strong><small>' + esc(capabilityText(card.capabilities)) + '</small><span class="candidate-cost">' + esc(cost) + '</span>' + action + '</button>';
    }).join('');
    const guide = event.guide ? '<p class="candidate-guide">' + esc(event.guide) + '</p>' : '';
    return '<section class="candidate-cards" role="group" aria-label="候选后端"><h3>本轮需要换一个后端</h3><p>' + esc(event.message || '当前后端不满足本轮所需能力。') + '</p>' + guide + '<div class="candidate-grid">' + (cards || '<p class="candidate-guide">没有可用候选，请先打开「模型与接口设置」完成配置。</p>') + '</div></section>';
  }

  function showCandidates(event) {
    const messages = $('#messages');
    if (!messages) return;
    messages.querySelectorAll('.candidate-cards').forEach(node => node.remove());
    messages.insertAdjacentHTML('beforeend', candidatesHtml(event));
    messages.scrollTop = messages.scrollHeight;
  }

  function turnIdle() {
    const stop = $('#stop');
    return !stop || stop.hidden === true;
  }

  function scheduleCandidates(event) {
    state.pendingCandidates = event;
    clearTimeout(state.pendingTimer);
    const deadline = Date.now() + 15000;
    // 候选事件可能比 error 先到：等这一轮收尾（输入与附件回填）后再显示卡片，避免点卡时 busy=true。
    const show = () => {
      if (!state.pendingCandidates) return;
      if (!turnIdle() && Date.now() < deadline) {
        state.pendingTimer = setTimeout(show, 80);
        return;
      }
      showCandidates(state.pendingCandidates);
    };
    state.pendingTimer = setTimeout(show, 0);
  }

  // 「换 X 重试（约 ¥x）」：一次失败只给这一张按钮；没有建议时只给「重试」（同后端）。
  function fallbackLabel(suggestion) {
    const cost = suggestion?.approxCostLabel ? '（' + suggestion.approxCostLabel + '）' : '';
    return '换 ' + (suggestion.label || suggestion.kind) + ' 重试' + cost;
  }

  function failureHtml(failure) {
    if (!failure || !failure.taskId) return '';
    const suggestion = failure.suggestion;
    if (suggestion && suggestion.kind) {
      return '<section class="turn-actions" role="group" aria-label="失败后的可用操作">'
        + '<button type="button" class="fallback-retry" data-fallback-task="' + esc(failure.taskId) + '" data-fallback-kind="' + esc(suggestion.kind) + '" data-fallback-message="' + esc(suggestion.message || '') + '">' + esc(fallbackLabel(suggestion)) + '</button>'
        + '</section>';
    }
    if (!failure.error) return '';
    return '<section class="turn-actions" role="group" aria-label="失败后的可用操作">'
      + '<button type="button" data-retry-same="1">重试</button>'
      + '</section>';
  }

  function renderFailure() {
    const messages = $('#messages');
    if (!messages) return;
    messages.querySelectorAll('.turn-actions').forEach(node => node.remove());
    const html = failureHtml(state.failure);
    if (html) {
      messages.insertAdjacentHTML('beforeend', html);
      messages.scrollTop = messages.scrollHeight;
    }
  }

  function scheduleFailure() {
    clearTimeout(state.failureTimer);
    const deadline = Date.now() + 15000;
    // 和候选卡一样，等这一轮收尾（输入与附件回填）后再出按钮，点的时候 busy 已经为 false。
    const show = () => {
      if (!state.failure) return;
      if (!turnIdle() && Date.now() < deadline) {
        state.failureTimer = setTimeout(show, 80);
        return;
      }
      renderFailure();
    };
    state.failureTimer = setTimeout(show, 0);
  }

  async function waitUntilIdle(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (turnIdle()) return true;
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    return turnIdle();
  }

  function clearFailure() {
    clearTimeout(state.failureTimer);
    state.failure = null;
    document.querySelectorAll('.turn-actions').forEach(node => node.remove());
  }

  window.addEventListener('career:task', event => {
    const detail = event.detail || {};
    if (detail.type === 'candidate_required') {
      state.failure = null;
      scheduleCandidates(detail);
      return;
    }
    if (detail.type === 'fallback_suggested') {
      state.failure = {...(state.failure || {}), taskId: detail.taskId, suggestion: detail};
      scheduleFailure();
      return;
    }
    if (detail.type === 'error') {
      // 候选卡的停止条件由候选 UI 负责，不再额外给「重试」。
      if (detail.code === 'CANDIDATE_REQUIRED') return;
      state.failure = {...(state.failure || {}), taskId: detail.taskId || state.failure?.taskId || '', error: detail.text || ''};
      scheduleFailure();
      return;
    }
    if (detail.type === 'task' && detail.state === 'running') {
      state.cost = null;
      state.pendingCandidates = null;
      clearFailure();
      renderBar();
      return;
    }
    if (detail.type === 'task' && detail.state === 'failed') {
      if (!state.failure?.error) {
        state.failure = {...(state.failure || {}), taskId: detail.taskId};
        scheduleFailure();
      }
      return;
    }
    if (detail.type === 'task' && (detail.state === 'cancelled' || detail.state === 'succeeded')) {
      clearFailure();
      return;
    }
    if (detail.type === 'done') {
      state.pendingCandidates = null;
      clearFailure();
      const last = detail.session?.messages?.at(-1);
      state.cost = totalCost(last?.calls);
      renderBar();
    }
  });

  // 顶栏两个入口的选择菜单：一次点击 = 一次明确的换后端；未配置的项只打开设置，不开始本轮。
  document.addEventListener('click', async event => {
    const item = event.target.closest('#bb-menu [data-menu-kind]');
    if (item) {
      event.preventDefault();
      if (item.dataset.menuConfigured !== 'true') {
        hideMenu();
        if (item.dataset.menuKind === 'agent' && typeof window.showModelSettings === 'function') window.showModelSettings();
        else if (typeof window.showModelSettings === 'function') window.showModelSettings();
        else zx.showError?.('请到「模型与接口设置」完成配置。');
        return;
      }
      const kind = item.dataset.menuKind;
      try {
        await zx.api('backends/select', {kind, agentId: item.dataset.menuAgent || ''});
        hideMenu();
        await refresh();
      } catch (error) {
        zx.showError?.(error.message);
      }
      return;
    }
    const config = event.target.closest('#bb-menu [data-menu-config]');
    if (config) {
      hideMenu();
      if (typeof window.showModelSettings === 'function') window.showModelSettings();
      return;
    }
    if (!event.target.closest('#bb-menu') && !event.target.closest('.bb-mode')) hideMenu();
  });

  document.addEventListener('click', async event => {
    const card = event.target.closest('.candidate-card');
    if (!card || card.disabled) return;
    event.preventDefault();
    if (card.dataset.configured !== 'true') {
      // 未配置的卡是配置入口：打开「模型与接口设置」，不开始本轮。
      if (typeof window.showModelSettings === 'function') window.showModelSettings();
      else zx.showError?.('请点左下角「模型与接口设置」完成配置。');
      return;
    }
    card.disabled = true;
    try {
      await zx.api('backends/select', {kind: card.dataset.backendKind});
      await refresh();
      state.pendingCandidates = null;
      document.querySelectorAll('.candidate-cards').forEach(node => node.remove());
      // 先等这一轮真正结束（输入与附件已回填），点一张卡即开始本轮。
      if (!(await waitUntilIdle())) {
        card.disabled = false;
        zx.showError?.('上一轮还在收尾，请稍后重试。');
        return;
      }
      const form = $('#chat');
      if (form) form.requestSubmit();
    } catch (error) {
      card.disabled = false;
      zx.showError?.(error.message);
    }
  });

  // 一次点击 = 确认换后端 + 用同一条消息/附件重跑整轮；建议由服务端绑定失败任务，只能消费一次。
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-fallback-task]');
    if (!button || button.disabled) return;
    event.preventDefault();
    button.disabled = true;
    try {
      const result = await zx.api('backends/fallback', {taskId: button.dataset.fallbackTask, kind: button.dataset.fallbackKind});
      window.__fallbackDepth = (Number(result.fallback?.depth) || 0) + 1;
      await refresh();
      // 从抽屉（可能刷新过页面）点按钮时，先切回失败任务所在的会话，再重跑。
      const sessionId = button.dataset.fallbackSession || '';
      if (sessionId && window.__zxLoadSession && window.__zx.currentSession?.()?.id !== sessionId) await window.__zxLoadSession(sessionId);
      clearFailure();
      if (!(await waitUntilIdle())) throw new Error('上一轮还在收尾，请稍后重试。');
      const input = $('#input');
      const message = button.dataset.fallbackMessage || '';
      if (input && !input.value.trim() && message) input.value = message;
      const attachments = $('#attachments');
      if (input && !input.value.trim() && !(attachments && attachments.children.length)) {
        throw new Error('消息没有留在输入框里，请重新输入这条消息后再发送。');
      }
      $('#chat')?.requestSubmit();
    } catch (error) {
      button.disabled = false;
      window.__fallbackDepth = 0;
      zx.showError?.(error.message);
    }
  });

  // 没有换后端建议时（本轮已有工具成功 / 锁定 / 建议用满）：只重试同一后端。
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-retry-same]');
    if (!button || button.disabled) return;
    event.preventDefault();
    button.disabled = true;
    try {
      window.__fallbackDepth = 0;
      clearFailure();
      if (!(await waitUntilIdle())) throw new Error('上一轮还在收尾，请稍后重试。');
      const input = $('#input');
      if (input && !input.value.trim() && !($('#attachments')?.children.length)) {
        throw new Error('消息没有留在输入框里，请重新输入后再发送。');
      }
      $('#chat')?.requestSubmit();
    } catch (error) {
      button.disabled = false;
      zx.showError?.(error.message);
    }
  });

  window.__turnLock = () => state.lock === true;
  window.__backendState = () => ({lock: state.lock, cost: state.cost, info: state.info});

  const style = document.createElement('style');
  style.textContent = `
#backend-bar{display:inline-flex;align-items:center;gap:8px;font-size:11px;color:#4b6b5b;min-width:0;flex:0 1 auto;position:relative}
#backend-bar .bb-current{max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#backend-bar .bb-mode{border:1px solid #d6e5da;background:#fff;border-radius:20px;padding:3px 9px;font-size:10px;color:#4b6b5b;white-space:nowrap;line-height:1.6}
#backend-bar .bb-mode[aria-pressed="true"]{background:#e7f3e9;border-color:#9fc4ac;color:#1f5a41;font-weight:600}
#bb-menu{position:absolute;right:0;top:calc(100% + 6px);z-index:50;width:min(300px,86vw);background:#fff;border:1px solid #d9e6dd;border-radius:12px;box-shadow:0 16px 40px #1f3a2e2e;padding:8px;display:flex;flex-direction:column;gap:4px;min-width:0}
#bb-menu[hidden]{display:none}
#bb-menu .bb-menu-head{font-size:10px;color:#8b9b91;letter-spacing:1px;padding:2px 4px 4px}
#bb-menu .bb-menu-item{display:flex;flex-direction:column;gap:1px;text-align:left;border:1px solid #e6ece7;background:#fff;border-radius:9px;padding:6px 8px;min-width:0;font:inherit;color:inherit}
#bb-menu .bb-menu-item[aria-pressed="true"]{border-color:#9fc4ac;background:#f2f9f4}
#bb-menu .bb-menu-item.unconfigured{background:#f7faf7;color:#7b8c82}
#bb-menu .bb-menu-item b{font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#bb-menu .bb-menu-item small{font-size:9.5px;color:#8b9b91;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#bb-menu .bb-menu-empty{margin:4px;font-size:10.5px;color:#8b9b91;line-height:1.7}
#bb-menu .bb-menu-config{border:1px dashed #c6d8cb;background:#fbfdfb;border-radius:8px;padding:5px 8px;font-size:10.5px;color:#2d6b4f;margin-top:2px}
#backend-bar .bb-cost{white-space:nowrap;font-variant-numeric:tabular-nums}
#turn-lock{border:1px solid #d6e5da;background:#fff;border-radius:20px;padding:3px 9px;font-size:10px;color:#4b6b5b;white-space:nowrap;line-height:1.6}
#turn-lock[aria-pressed="true"]{background:#e7f3e9;border-color:#9fc4ac;color:#1f5a41;font-weight:600}
.candidate-cards{margin:0 0 26px;border:1px solid #cfe2d4;background:#fbfdfb;border-radius:14px;padding:14px 16px;min-width:0;overflow-wrap:anywhere}
.candidate-cards h3{margin:0 0 6px;font-size:14px;color:#205a48}
.candidate-cards p{margin:4px 0;font-size:12px;color:#6f8478;line-height:1.8}
.candidate-grid{display:grid;gap:8px;margin-top:10px}
.candidate-card{display:flex;flex-direction:column;align-items:flex-start;gap:3px;border:1px solid #d7e5da;background:#fff;border-radius:11px;padding:10px 12px;text-align:left;min-width:0;width:100%}
.candidate-card strong{font-size:13px;color:#244c3a;overflow-wrap:anywhere}
.candidate-card small{font-size:10px;color:#7d9184}
.candidate-card .candidate-cost{font-size:11px;color:#2d7150;font-variant-numeric:tabular-nums}
.candidate-card .candidate-action{font-size:10px;color:#8a6a2f}
.candidate-card.unconfigured{background:#f7faf7}
.candidate-card[disabled]{opacity:.6}
.turn-actions{display:flex;gap:8px;flex-wrap:wrap;margin:-6px 0 22px;padding:0 2px;min-width:0}
.turn-actions button{border:1px solid #9fc4ac;background:#eaf5ed;color:#1f5a41;border-radius:10px;padding:7px 13px;font-size:12px;font-weight:600;max-width:100%;overflow-wrap:anywhere;text-align:left}
.turn-actions button[disabled]{opacity:.55;cursor:default}
.calls{margin-top:14px;border:1px solid #e2eae4;background:#fbfdfb;border-radius:11px;padding:8px 12px;min-width:0;max-width:100%}
.calls summary{cursor:pointer;font-size:11px;color:#436b57;font-weight:600;overflow-wrap:anywhere}
.calls .table-scroll{overflow-x:auto;margin-top:8px;max-width:100%}
.calls table{width:100%;border-collapse:collapse;font-size:10.5px;color:#4f6a5b}
.calls th,.calls td{padding:4px 6px;border-bottom:1px solid #e8efea;text-align:left;white-space:nowrap}
.calls th{color:#7a8d81;font-weight:600}
@media(max-width:750px){
 header{height:auto;min-height:76px;flex-wrap:wrap;row-gap:6px}
 #backend-bar{order:3;width:100%;justify-content:flex-end;gap:6px;font-size:10px;flex-wrap:wrap}
 #backend-bar .bb-current{max-width:130px}
 #backend-bar .bb-mode{font-size:9px;padding:2px 7px}
 .calls{padding:7px 9px}
}
@media(max-width:420px){
 #backend-bar .bb-current{max-width:100px}
 #backend-bar .bb-mode{font-size:9px;padding:2px 6px}
}
`;
  document.head.appendChild(style);

  ensureBar();
  refresh();
  const poll = setInterval(() => {
    if (state.info) { clearInterval(poll); return; }
    refresh();
  }, 2000);
  if (typeof poll.unref === 'function') poll.unref();
})();
