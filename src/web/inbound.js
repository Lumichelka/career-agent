// 「模型与接口」对话框里的入站 MCP 区：实例开关、client 凭据、一次性凭据与三种宿主片段。
// 独立脚本 + 自行注入样式，避免改动内联对话框与其它设置页签（#34 也在改同一处）。
(function () {
  const ZX = window.__zx;
  if (!ZX) return;
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const fmt = iso => {
    if (!iso) return '未使用';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'});
  };

  let status = null;        // GET /api/mcp 的公开状态（不含凭据）
  let pending = [];         // 入站转发发起、等你决定的敏感写确认（#38），没有任务卡也要能处理
  let reveal = null;        // 本次对话框内新签发的完整凭据；关闭对话框即消失
  let pendingEnable = false;
  let error = '';

  const STYLE = `
    .inbound-mcp{display:grid;gap:10px;margin-top:20px;padding-top:16px;border-top:1px solid #dce7df;min-width:0;overflow-wrap:anywhere}
    .inbound-mcp h3{margin:0;font-size:15px;color:#205a48}
    .inbound-mcp p{margin:0;font-size:12px;line-height:1.8;color:#6d7f73}
    .inbound-mcp code{font:11.5px/1.6 ui-monospace,Consolas,monospace;background:#f2f7f3;border:1px solid #e0e9e2;border-radius:5px;padding:1px 4px;overflow-wrap:anywhere}
    .inbound-switch{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .inbound-switch .state{font-size:12px;font-weight:600;color:#3d5c4b}
    .inbound-switch .state.on{color:#236c50}
    .inbound-switch .dot{width:8px;height:8px;border-radius:50%;background:#b9c7bd}
    .inbound-switch .dot.on{background:#2f8a63;box-shadow:0 0 0 3px #2f8a6322}
    .inbound-mcp button{padding:6px 11px;border:1px solid #d7e1d9;background:#fff;border-radius:7px;font-size:12px;color:#2d5b45;cursor:pointer}
    .inbound-mcp button.primary{background:#236c50;border-color:#236c50;color:#fff}
    .inbound-mcp button.danger{color:#9a4a3a;border-color:#e3cfc9}
    .inbound-mcp button:disabled{opacity:.55;cursor:default}
    .inbound-confirm{border:1px solid #bcd7c5;background:#edf6ef;border-radius:10px;padding:10px 12px;display:grid;gap:8px}
    .inbound-confirm .actions{display:flex;gap:8px;flex-wrap:wrap}
    .inbound-reveal{border:1px solid #bcd7c5;background:#f7fbf8;border-radius:10px;padding:10px 12px;display:grid;gap:8px}
    .inbound-tokenline{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
    .inbound-tokenline code{flex:1 1 160px;min-width:0;word-break:break-all}
    .inbound-snippets{display:grid;gap:8px}
    .inbound-snippets details{border:1px solid #e0e9e2;border-radius:8px;background:#fff;padding:7px 9px}
    .inbound-snippets summary{cursor:pointer;font-size:12px;color:#3d5c4b}
    .inbound-snippets pre{margin:6px 0 0;white-space:pre-wrap;word-break:break-all;font:11.5px/1.7 ui-monospace,Consolas,monospace;color:#24402f;background:#fbfdfb;border:1px solid #eef3ef;border-radius:6px;padding:8px;max-height:180px;overflow:auto}
    .inbound-issue{display:flex;gap:6px;flex-wrap:wrap}
    .inbound-issue input{flex:1 1 150px;min-width:0;padding:7px 9px;border:1px solid #d7e1d9;border-radius:7px;font:12px inherit;color:#274333;background:#fff}
    .inbound-clients{list-style:none;margin:0;padding:0;display:grid;gap:7px}
    .inbound-client{border:1px solid #e0e9e2;border-radius:9px;padding:8px 10px;display:grid;gap:5px;min-width:0}
    .inbound-client .top{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
    .inbound-client .name{font-size:12.5px;font-weight:600;color:#274333}
    .inbound-client .meta{font-size:11px;color:#7b8b80}
    .inbound-client .actions{display:flex;gap:6px;flex-wrap:wrap}
    .inbound-pending{border:1px solid #e3cfc9;background:#fdf6f3;border-radius:10px;padding:9px 11px;display:grid;gap:7px}
    .inbound-pending ul{list-style:none;margin:0;padding:0;display:grid;gap:6px}
    .inbound-pending li{display:grid;gap:4px;font-size:11.5px;color:#6f564d;min-width:0;overflow-wrap:anywhere}
    .inbound-pending .actions{display:flex;gap:6px;flex-wrap:wrap}
    .inbound-pending .acts button{font-size:11.5px;padding:4px 9px}
    .inbound-hint{font-size:11.5px;color:#8a5b16;margin:2px 0 0}
    .inbound-err{color:#a64232!important}
    .inbound-empty{font-size:11.5px;color:#8a998f}
    @media(max-width:480px){
      .inbound-mcp{padding-top:12px}
      .inbound-client .actions button{flex:1 1 auto}
      .inbound-issue button{flex:1 1 100%}
    }
  `;

  function ensureStyle() {
    if ($('#inbound-mcp-style')) return;
    const style = document.createElement('style');
    style.id = 'inbound-mcp-style';
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  function snippetsHtml() {
    if (!reveal) return '';
    const parts = reveal.snippets.map((s, i) =>
      '<details' + (i === 0 ? ' open' : '') + '><summary>' + esc(s.label) + '</summary>' +
      '<pre>' + esc(s.content) + '</pre>' +
      (s.note ? '<p>' + esc(s.note) + '</p>' : '') +
      '<button type="button" data-act="copy-snippet" data-index="' + i + '">复制片段</button></details>'
    ).join('');
    return '<div class="inbound-reveal" role="status">' +
      '<p><strong>凭据只显示这一次。</strong>关闭后只保留前缀；需要完整值请重新生成。</p>' +
      '<div class="inbound-tokenline"><code>' + esc(reveal.token) + '</code><button type="button" data-act="copy-token">复制凭据</button></div>' +
      '<div class="inbound-snippets">' + parts + '</div></div>';
  }

  function previewText(item) {
    const text = typeof item.preview === 'string' ? item.preview : JSON.stringify(item.preview || {});
    return text.length > 160 ? text.slice(0, 160) + '…' : text;
  }

  // 入站转发发起的敏感写没有任务卡；这里给一份紧凑清单，接受/拒绝仍在网页端点。
  function pendingHtml() {
    if (!pending.length) return '';
    return '<div class="inbound-pending" role="status"><p><strong>外部客户端发起的写入等你确认（' + esc(pending.length) + '）</strong>：接受后才落库；拒绝不会写入。</p><ul>' +
      pending.map(item =>
        '<li><span>' + esc(item.tool) + ' · ' + esc(item.entity || '') + ' · 有效至 ' + esc(fmt(item.expiresAt)) + '</span>' +
        '<code>' + esc(previewText(item)) + '</code>' +
        '<span class="acts actions"><button type="button" class="primary" data-act="accept-inbound" data-id="' + esc(item.confirmId) + '">接受</button>' +
        '<button type="button" class="danger" data-act="reject-inbound" data-id="' + esc(item.confirmId) + '">拒绝</button></span></li>'
      ).join('') + '</ul></div>';
  }

  function clientsHtml() {
    const list = status?.clients || [];
    if (!list.length) return '<p class="inbound-empty">还没有签发凭据。签发后把这枚凭据只交给你信任的外部 AI。</p>';
    return '<ul class="inbound-clients">' + list.map(c =>
      '<li class="inbound-client">' +
        '<div class="top"><span class="name">' + esc(c.name) + '</span>' +
        '<span class="meta">' + esc(c.tokenPrefix) + '…</span>' +
        (c.revoked ? '<span class="meta">已撤销</span>' : '<span class="meta">' + esc(fmt(c.lastUsedAt)) + (c.lastUsedAt ? ' 用过' : '') + '</span>') +
        '</div>' +
        '<div class="meta">创建于 ' + esc(fmt(c.createdAt)) + ' · 签发时工具 ' + esc(c.toolCount) + ' 个' + (c.regeneratedAt ? ' · 最近重生成 ' + esc(fmt(c.regeneratedAt)) : '') + '</div>' +
        (c.newToolCount ? '<p class="inbound-hint">签发后新发现 ' + esc(c.newToolCount) + ' 个工具：' + esc((c.newTools || []).join('、')) + '。旧凭据继续有效，无需重新生成。</p>' : '') +
        (c.revoked ? '' : '<div class="actions"><button type="button" data-act="regenerate" data-id="' + esc(c.id) + '">重新生成</button><button type="button" class="danger" data-act="revoke" data-id="' + esc(c.id) + '">撤销</button></div>') +
      '</li>'
    ).join('') + '</ul>';
  }

  function render() {
    const section = $('#inbound-mcp-section');
    if (!section) return;
    if (!status) {
      section.innerHTML = '<h3>入站 MCP</h3><p>正在读取状态…</p>';
      return;
    }
    const on = !!status.enabled;
    const audience = status.audience || {promised: [], unverified: [], note: ''};
    section.innerHTML =
      '<h3>入站 MCP</h3>' +
      '<p>让 Claude Code / Cursor / Codex 这类外部 AI 通过本机 <code>/mcp</code> 读取你的求职数据。默认关闭；关闭时端点返回 404，但不会撤销已签凭据。</p>' +
      '<div class="inbound-switch"><span class="dot' + (on ? ' on' : '') + '"></span>' +
      '<span class="state' + (on ? ' on' : '') + '">' + (on ? '已开启' : '已关闭') + '</span>' +
      '<button type="button" class="' + (on ? 'danger' : 'primary') + '" data-act="toggle">' + (on ? '关闭入站' : '开启入站…') + '</button>' +
      (status.enabledBy ? '<span class="meta">由 ' + esc(status.enabledBy) + ' 于 ' + esc(fmt(status.enabledAt)) + ' 开启</span>' : '') +
      '</div>' +
      (pendingEnable
        ? '<div class="inbound-confirm"><p><strong>开启后</strong>，任何持有本实例签发凭据的外部 AI 都能读取你的本机求职数据；凭据只属于你，关闭开关不会撤销它们。</p><div class="actions"><button type="button" class="primary" data-act="confirm-enable">确认开启</button><button type="button" data-act="cancel-enable">取消</button></div></div>'
        : '') +
      '<p><strong>地址承诺：</strong>' + esc(audience.note || '') + ' 已承诺：' + audience.promised.map(u => '<code>' + esc(u) + '</code>').join('、') + '；未验证：' + audience.unverified.map(u => '<code>' + esc(u) + '</code>').join('、') + '。</p>' +
      snippetsHtml() +
      '<div class="inbound-issue"><input id="inbound-client-name" maxlength="40" placeholder="client 名称，例如 claude-code" aria-label="client 名称"><button type="button" class="primary" data-act="issue">签发凭据</button></div>' +
      (error ? '<p class="inbound-err" role="alert">' + esc(error) + '</p>' : '') +
      pendingHtml() +
      clientsHtml();
  }

  async function load() {
    try {
      status = await ZX.api('mcp');
      error = '';
    } catch (e) {
      error = e.message;
    }
    try {
      const out = await ZX.api('confirmations?state=pending');
      // 只列入站转发发起的；任务内的待确认仍由工作流抽屉负责。
      pending = (out.confirmations || []).filter(item => item.actorType === 'forwarded_client');
    } catch {
      pending = [];
    }
    render();
  }

  async function post(path, body) {
    error = '';
    try {
      const out = await ZX.api(path, body);
      status = out.enabled !== undefined && out.clients ? out : status;
      return out;
    } catch (e) {
      error = e.message;
      render();
      throw e;
    }
  }

  function mount() {
    const content = $('#dialog-content');
    if (!content || !$('#ms-form') || $('#inbound-mcp-section')) return;
    ensureStyle();
    const section = document.createElement('section');
    section.id = 'inbound-mcp-section';
    section.className = 'inbound-mcp';
    section.setAttribute('aria-label', '入站 MCP');
    content.appendChild(section);
    render();
    load();
  }

  document.addEventListener('click', async event => {
    const button = event.target.closest('#inbound-mcp-section [data-act]');
    if (!button) return;
    const act = button.dataset.act;
    if (act === 'toggle') {
      if (status?.enabled) {
        button.disabled = true;
        try { await post('mcp/switch', {enabled: false}); pendingEnable = false; await load(); }
        finally { button.disabled = false; }
      } else {
        pendingEnable = true;
        render();
      }
      return;
    }
    if (act === 'cancel-enable') { pendingEnable = false; render(); return; }
    if (act === 'confirm-enable') {
      button.disabled = true;
      try { await post('mcp/switch', {enabled: true, confirm: true}); pendingEnable = false; await load(); }
      finally { button.disabled = false; }
      return;
    }
    if (act === 'issue') {
      const input = $('#inbound-client-name');
      const name = String(input?.value || '').trim();
      if (!name) { error = '先给这个 client 起个名字，例如 claude-code。'; render(); return; }
      button.disabled = true;
      try {
        reveal = await post('mcp/clients', {name});
        if (input) input.value = '';
        await load();
      } finally { button.disabled = false; }
      return;
    }
    if (act === 'regenerate') {
      button.disabled = true;
      try {
        reveal = await post('mcp/clients/regenerate', {id: button.dataset.id});
        await load();
      } finally { button.disabled = false; }
      return;
    }
    if (act === 'revoke') {
      if (!window.confirm('撤销后这枚凭据立即失效，外部 AI 无法再用它读取你的数据。继续？')) return;
      button.disabled = true;
      try {
        await post('mcp/clients/revoke', {id: button.dataset.id});
        if (reveal?.client?.id === button.dataset.id) reveal = null;
        await load();
      } finally { button.disabled = false; }
      return;
    }
    if (act === 'accept-inbound' || act === 'reject-inbound') {
      const path = act === 'accept-inbound' ? 'confirmations/accept' : 'confirmations/reject';
      button.disabled = true;
      try {
        await post(path, {confirmId: button.dataset.id, ...(act === 'reject-inbound' ? {reason: '在入站 MCP 设置里拒绝'} : {})});
        await load();
      } finally { button.disabled = false; }
      return;
    }
    if (act === 'copy-token' && reveal) {
      await copy(reveal.token, button);
      return;
    }
    if (act === 'copy-snippet' && reveal) {
      const snippet = reveal.snippets[Number(button.dataset.index)];
      if (snippet) await copy(snippet.content, button);
    }
  });

  async function copy(text, button) {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const area = document.createElement('textarea');
        area.value = text;
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        area.remove();
      }
      const before = button.textContent;
      button.textContent = '已复制';
      setTimeout(() => { button.textContent = before; }, 1200);
    } catch {
      error = '复制失败，请手动选中复制。';
      render();
    }
  }

  function observe() {
    const content = $('#dialog-content');
    if (!content) return;
    new MutationObserver(() => mount()).observe(content, {childList: true, subtree: true});
    mount();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observe, {once: true});
  else observe();
})();
