// 后端顶栏（当前后端 / 本轮约花费 / 本次锁定）、候选卡与助手消息下的调用表。
// 数据来自 /api/backends 与助手消息的 calls；不引入框架，尽量不动首页内联代码。
(function () {
  const zx = window.__zx || {};
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

  const CAP_LABELS = {text: '文本', tools: '工具', vision: '读图'};
  const STEP_LABELS = {plan: '规划', act: '执行', review: '复核', sample: '采样'};
  const state = {info: null, lock: false, cost: null, pendingCandidates: null, pendingTimer: null};

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
    bar.innerHTML = '<span class="bb-current" id="bb-current">当前：读取中…</span><span class="bb-cost" id="bb-cost">本轮 ≈¥—</span><button type="button" id="turn-lock" aria-pressed="false" title="锁定本轮：失败也不换后端">🔓 本次锁定</button>';
    const toggle = $('#workflow-toggle');
    if (toggle && toggle.parentNode === header) header.insertBefore(bar, toggle);
    else header.appendChild(bar);
    $('#turn-lock').addEventListener('click', () => { state.lock = !state.lock; renderBar(); });
    return bar;
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

  async function waitUntilIdle(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (turnIdle()) return true;
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    return turnIdle();
  }

  window.addEventListener('career:task', event => {
    const detail = event.detail || {};
    if (detail.type === 'candidate_required') { scheduleCandidates(detail); return; }
    if (detail.type === 'task' && detail.state === 'running') {
      state.cost = null;
      state.pendingCandidates = null;
      renderBar();
      return;
    }
    if (detail.type === 'done') {
      state.pendingCandidates = null;
      const last = detail.session?.messages?.at(-1);
      state.cost = totalCost(last?.calls);
      renderBar();
    }
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

  window.__turnLock = () => state.lock === true;
  window.__backendState = () => ({lock: state.lock, cost: state.cost, info: state.info});

  const style = document.createElement('style');
  style.textContent = `
#backend-bar{display:inline-flex;align-items:center;gap:8px;font-size:11px;color:#4b6b5b;min-width:0;flex:0 1 auto}
#backend-bar .bb-current{max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
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
.calls{margin-top:14px;border:1px solid #e2eae4;background:#fbfdfb;border-radius:11px;padding:8px 12px;min-width:0;max-width:100%}
.calls summary{cursor:pointer;font-size:11px;color:#436b57;font-weight:600;overflow-wrap:anywhere}
.calls .table-scroll{overflow-x:auto;margin-top:8px;max-width:100%}
.calls table{width:100%;border-collapse:collapse;font-size:10.5px;color:#4f6a5b}
.calls th,.calls td{padding:4px 6px;border-bottom:1px solid #e8efea;text-align:left;white-space:nowrap}
.calls th{color:#7a8d81;font-weight:600}
@media(max-width:750px){
 header{height:auto;min-height:76px;flex-wrap:wrap;row-gap:6px}
 #backend-bar{order:3;width:100%;justify-content:flex-end;gap:6px;font-size:10px}
 #backend-bar .bb-current{max-width:150px}
 .calls{padding:7px 9px}
}
@media(max-width:420px){
 #backend-bar .bb-current{max-width:118px}
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
