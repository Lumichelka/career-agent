// 「模型与接口设置」的第二页签：外部 Agent 配置、连接状态与工具。
// 独立脚本 + 自注入样式，不改内联对话框；#37 的入站 MCP 区仍挂在 #ms-form 之后，切到本页签时隐藏。
(function () {
  const ZX = window.__zx;
  if (!ZX) return;
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const api = path => ZX.api(path);

  const state = {
    tab: 'model',
    data: null,
    selectedId: '',
    view: 'list',
    subtab: 'status',
    adding: false,
    draftTransport: '',
    formDraft: null,
    pendingRemoveEnv: [],
    busy: false,
    error: '',
    feedback: ''
  };

  const STYLE = `
.settings-tabs{display:flex;gap:2px;margin:12px 0 14px;border-bottom:1px solid #e0e9e2;min-width:0}
.settings-tabs button{border:0;background:none;padding:8px 12px;font-size:12.5px;color:#6b7f74;border-bottom:2px solid transparent;white-space:nowrap}
.settings-tabs button.on{color:#1e5a44;border-bottom-color:#236c50;font-weight:600}
#agents-tab-panel{min-width:0;overflow-wrap:anywhere}
#dialog-content[data-active-tab="agents"] #inbound-mcp-section{display:none}
#dialog.agents-wide{max-width:920px;width:calc(100% - 35px)}
.agents-wrap{display:grid;grid-template-columns:minmax(190px,1fr) minmax(0,2fr);gap:16px;align-items:start;min-width:0}
.agents-list-pane{min-width:0;border-right:1px solid #e6ede8;padding-right:13px}
.agents-list-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;font-size:12px;color:#436b57}
.agents-list-head strong{font-size:12.5px}
.agents-list-head span{font-size:10px;color:#8b9a90}
.agents-row{display:flex;align-items:flex-start;gap:7px;width:100%;border:1px solid #e6ece7;background:#fff;border-radius:10px;padding:7px 9px;margin-bottom:6px;text-align:left;min-width:0;font:inherit;color:inherit}
.agents-row:hover{background:#f7fbf8}
.agents-row.on{border-color:#bcd7c5;background:#f0f8f2;box-shadow:inset 0 0 0 1px #bcd7c5}
.agents-row .agents-main{min-width:0;flex:1;display:flex;flex-direction:column;gap:1px}
.agents-row .agents-main b{font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agents-row .agents-main small{font-size:9.5px;color:#7c8c82;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agents-row .agents-count{font-size:9.5px;color:#8b9a90;white-space:nowrap;margin-top:2px}
.agents-dot{width:8px;height:8px;border-radius:50%;background:#b9c7bd;margin-top:7px;flex:0 0 auto}
.agents-dot.ok{background:#2f8a63;box-shadow:0 0 0 3px #2f8a6322}
.agents-dot.err{background:#b4543c}
.agents-dot.wait{background:#d09a3c}
.agents-dot.live{background:#5d8fb5}
.agents-empty{border:1px dashed #dde7e0;border-radius:9px;padding:14px 10px;text-align:center;font-size:11px;color:#8b9a90;line-height:1.8}
.agents-add{width:100%;margin-top:7px;border:1px dashed #c6d8cb;background:#fbfdfb;border-radius:9px;padding:7px;font-size:11.5px;color:#2d6b4f}
.agents-hint{font-size:9.5px;color:#8b9a90;line-height:1.7;margin:6px 0 0}
.agents-detail-pane{min-width:0}
.agents-detail-head{display:flex;align-items:flex-start;gap:9px;flex-wrap:wrap;margin-bottom:6px}
.agents-back{display:none;border:1px solid #d9e5dc;background:#fff;border-radius:7px;padding:4px 9px;font-size:11px;color:#3f6f57}
.agents-detail-main{flex:1;min-width:0}
.agents-detail-main h3{font-size:15px;margin:0;display:flex;align-items:center;gap:6px;flex-wrap:wrap;color:#205a48}
.agents-tag{font-size:9px;border:1px solid #dce7df;background:#f4f9f5;border-radius:20px;padding:1px 7px;color:#5f7a6b;font-weight:400}
.agents-sub{font-size:10.5px;color:#7b8c82;margin:3px 0 0;overflow-wrap:anywhere;line-height:1.7}
.agents-subtabs{display:flex;gap:3px;margin:7px 0 11px;border-bottom:1px solid #e6ede8}
.agents-subtabs button{border:0;background:none;padding:6px 10px;font-size:11.5px;color:#6b7f74;border-bottom:2px solid transparent}
.agents-subtabs button.on{color:#1e5a44;border-bottom-color:#236c50;font-weight:600}
.agents-card{border:1px solid #dfe8e1;background:#fff;border-radius:11px;padding:10px 12px;display:grid;gap:5px;min-width:0}
.agents-card.ok{border-left:3px solid #2f8a68}
.agents-card.err{border-left:3px solid #b4543c;background:#fffdfc}
.agents-card.wait{border-left:3px solid #d09a3c}
.agents-card.idle{border-left:3px solid #c3cec6}
.agents-line{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:12px;min-width:0}
.agents-chip{font-size:10px;border-radius:20px;padding:1px 8px;border:1px solid #dfe8e1;background:#f7faf8;color:#60776a;white-space:nowrap}
.agents-chip.ok{color:#1f6a4c;border-color:#b6d6c1;background:#eaf5ed}
.agents-chip.err{color:#95523f;border-color:#ecd0c6;background:#fdf1ec}
.agents-chip.wait{color:#8a5b16;border-color:#e8d3a8;background:#fdf6e7}
.agents-kv{display:flex;gap:8px;font-size:10.5px;color:#6d8176;line-height:1.7;min-width:0}
.agents-kv span{flex:0 0 58px;color:#93a39a}
.agents-kv b{font-weight:500;color:#405a4c;overflow-wrap:anywhere;min-width:0}
.agents-note{font-size:10.5px;color:#7b8c82;margin:2px 0 0;overflow-wrap:anywhere;line-height:1.7}
.agents-note.amber{color:#8a5a17;background:#fdf6ec;border:1px solid #efdfc6;border-radius:8px;padding:5px 8px}
.agents-rec{font-size:10.5px;color:#5f7568;background:#f3f8f4;border-radius:8px;padding:5px 8px;overflow-wrap:anywhere}
.agents-block{border:1px solid #dfe8e1;background:#fff;border-radius:11px;padding:9px 11px;margin-top:10px;min-width:0}
.agents-block-head{display:flex;align-items:center;gap:7px;margin-bottom:5px;min-width:0}
.agents-block-head b{font-size:12px;color:#2c5543}
.agents-block-head span{font-size:9.5px;color:#8b9a90;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agents-block-head button{margin-left:auto;flex:0 0 auto}
.agents-tools{display:flex;flex-direction:column;gap:3px;margin-top:3px;min-width:0}
.agents-tool{display:flex;align-items:center;gap:7px;padding:4px 6px;border-radius:7px;background:#fbfdfb;min-width:0}
.agents-tool code{flex:1;min-width:0;font:11px/1.6 ui-monospace,Consolas,monospace;color:#2d5b45;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agents-mini{border:1px dashed #dde7e0;border-radius:9px;padding:10px;text-align:center;margin-top:4px;font-size:11px;color:#8b9a90;line-height:1.8}
.agents-form{display:flex;flex-direction:column;gap:11px;min-width:0}
.agents-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.agents-field>label{font-size:11px;color:#4d6959}
.agents-field input[type=text],.agents-field input[type=password],.agents-field input:not([type]),.agents-field select{padding:7px 10px;border:1px solid #d7e1d9;border-radius:8px;background:#fff;font-size:12.5px;width:100%;min-width:0;color:#274333;font-family:inherit}
.agents-field input:focus{outline:2px solid #bcd7c5;outline-offset:-1px}
.agents-field.check label{display:flex;align-items:flex-start;gap:7px;font-size:11.5px;color:#4d6959}
.agents-field.check input{width:auto;margin-top:4px}
.agents-seg{display:flex;gap:6px;flex-wrap:wrap}
.agents-seg label{display:flex;align-items:center;gap:5px;border:1px solid #d7e1d9;background:#fff;border-radius:8px;padding:6px 9px;font-size:11.5px;color:#4d6959}
.agents-seg label.on{border-color:#9fc4ac;background:#f2f9f4}
.agents-seg input{width:auto!important}
.agents-env-row{display:flex;gap:6px;align-items:center;min-width:0}
.agents-env-row code{font-size:10.5px;color:#3f6f57;white-space:nowrap}
.agents-env-row input{flex:1;min-width:0}
.agents-env-row .agents-rm{border:0;background:none;color:#a05b49;font-size:12px;padding:0 3px}
.agents-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:3px}
.agents-actions button,.agents-block button,.agents-detail-head button{padding:6px 11px;border:1px solid #d7e1d9;background:#fff;border-radius:7px;font-size:11.5px;color:#2d5b45;font-family:inherit}
.agents-actions button.primary{background:#236c50;border-color:#236c50;color:#fff}
.agents-actions button.danger{color:#9a4a3a;border-color:#e3cfc9}
.agents-actions button:disabled{opacity:.55;cursor:default}
.agents-feedback{font-size:11px;color:#426c54;white-space:pre-wrap;margin:0;line-height:1.7;overflow-wrap:anywhere}
.agents-feedback.err{color:#a64232}
.agents-reveal{font-size:10.5px;color:#5f7568;background:#f3f8f4;border-radius:8px;padding:5px 8px;overflow-wrap:anywhere}
@media(max-width:750px){
 #dialog.agents-wide{max-width:100vw;width:100vw;height:100dvh;max-height:100dvh;margin:0;border-radius:0;padding:14px 14px 20px;overflow:auto}
 .agents-wrap{grid-template-columns:1fr;gap:10px}
 .agents-list-pane{border-right:0;padding-right:0}
 #agents-tab-panel[data-view="list"] .agents-detail-pane{display:none}
 #agents-tab-panel[data-view="detail"] .agents-list-pane{display:none}
 .agents-back{display:inline-block}
 .agents-actions button{flex:1 1 auto}
}
`;

  function ensureStyle() {
    if ($('#agents-style')) return;
    const style = document.createElement('style');
    style.id = 'agents-style';
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  const selected = () => (state.data?.agents || []).find(agent => agent.id === state.selectedId) || null;
  const owner = () => state.data?.owner === true;
  const stateLabel = status => ({
    disconnected: '未连接',
    connecting: '连接中…',
    connected: '已连接 · ' + (status.era || 'modern'),
    failed: '失败 · ' + (status.lastError?.code || 'CONNECT_FAILED'),
    closed: '已回收',
    queued: '排队中'
  })[status.state] || '未连接';
  const dotClass = status => status.state === 'connected' ? 'ok' : status.state === 'failed' ? 'err' : status.state === 'queued' ? 'wait' : status.state === 'connecting' ? 'live' : 'idle';
  const chipClass = status => status.state === 'connected' ? 'ok' : status.state === 'failed' ? 'err' : status.state === 'queued' || status.state === 'connecting' ? 'wait' : '';
  const fmtTime = iso => {
    if (!iso) return '—';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'});
  };
  const transportLabel = transport => transport === 'stdio' ? 'stdio · 本机进程' : 'HTTP · Streamable';

  function listHtml() {
    const agents = state.data?.agents || [];
    const head = '<div class="agents-list-head"><strong>外部 Agent</strong><span>' + agents.length + ' / ' + (state.data?.max || 10) + '</span></div>';
    const rows = agents.map(agent => {
      const status = agent.status || agent;
      return '<button type="button" class="agents-row ' + (agent.id === state.selectedId ? 'on' : '') + '" data-agent-id="' + esc(agent.id) + '" aria-pressed="' + (agent.id === state.selectedId) + '">' +
        '<span class="agents-dot ' + dotClass(status) + '"></span>' +
        '<span class="agents-main"><b>' + esc(agent.name) + '</b><small>' + esc(agent.transport === 'stdio' ? 'stdio' : 'http') + ' · ' + esc(stateLabel(status)) + '</small></span>' +
        '<span class="agents-count">' + (status.tools?.length || 0) + ' 工具</span></button>';
    }).join('');
    const add = agents.length < (state.data?.max || 10)
      ? '<button type="button" class="agents-add" data-act="add">＋ 添加外部 Agent</button>'
      : '<p class="agents-hint">已经达到 10 个上限。</p>';
    const hint = owner()
      ? '<p class="agents-hint">stdio 仅 owner；HTTP 每用户独立，凭据只进本用户 KeyVault。</p>'
      : '<p class="agents-hint">成员只能配置 HTTP Agent；stdio 仅 owner（API 会返回 400 STDIO_OWNER_ONLY）。</p>';
    return head + (agents.length ? rows : '<div class="agents-empty">还没有外部 Agent。<br>连接后可把它的工具借给任务用。</div>') + add + hint;
  }

  function statusHtml(agent) {
    const missing = '还没有连接：懒连接在第一次调用或「测试连接」时建立。';
    return agent.state === 'connected'
      ? '<div class="agents-line"><span class="agents-chip ok">● ' + esc(stateLabel(agent)) + '</span><span class="agents-note">最近连接 ' + esc(fmtTime(agent.lastConnectedAt)) + '</span></div>' +
        '<div class="agents-kv"><span>上游</span><b>' + esc(agent.serverInfo ? agent.serverInfo.name + ' ' + (agent.serverInfo.version || '') : '—') + '</b></div>' +
        '<div class="agents-kv"><span>协商</span><b>auto · ' + esc(agent.era || 'modern') + ' 时代</b></div>' +
        '<p class="agents-note">空闲 30 分钟回收；下一次调用自动重连，工具缓存 10 分钟。</p>' +
        (agent.era === 'legacy' ? '<p class="agents-note amber">上游未支持 2026-07-28：已回退 initialize（legacy 时代），功能照用。</p>' : '')
      : agent.state === 'failed'
        ? '<div class="agents-line"><span class="agents-chip err">● 失败 · ' + esc(agent.lastError?.code || 'CONNECT_FAILED') + '</span></div>' +
          '<div class="agents-kv"><span>错误</span><b>' + esc(agent.lastError?.message || '连接失败') + '</b></div>' +
          '<div class="agents-rec"><b>恢复</b> ' + esc(agent.lastError?.recovery || '检查配置后重试连接。') + '</div>' +
          (agent.retryInMs > 0 ? '<p class="agents-note">自动重连将在 ' + Math.ceil(agent.retryInMs / 1000) + ' 秒后允许；也可以立即手动重试。</p>' : '') +
          (agent.retryExhausted ? '<p class="agents-note amber">自动重连已用满 3 次 / 10 分钟，请点「重试连接」。</p>' : '')
        : agent.state === 'closed'
          ? '<div class="agents-line"><span class="agents-chip ' + chipClass(agent) + '">○ 已回收</span><span class="agents-note">上次连接 ' + esc(fmtTime(agent.lastConnectedAt)) + '</span></div>' +
            '<div class="agents-kv"><span>原因</span><b>空闲 30 分钟，连接与子进程已关闭</b></div>' +
            '<p class="agents-note">下一次调用会自动重连；工具列表缓存过期后重新发现。</p>'
          : '<div class="agents-line"><span class="agents-chip">○ ' + esc(stateLabel(agent)) + '</span><span class="agents-note">' + (agent.enabled === false ? '已停用' : '已启用，还没连接过') + '</span></div>' +
            '<div class="agents-kv"><span>说明</span><b>' + esc(missing) + '</b></div>';
  }

  function toolsHtml(agent) {
    const tools = agent.tools || [];
    const head = '<div class="agents-block-head"><b>工具</b><span>' + tools.length + ' 个</span><button type="button" data-act="refresh">刷新</button></div>';
    if (agent.state === 'failed') return '<div class="agents-block">' + head + '<div class="agents-mini">连接失败：工具列表不可用。修复后点「测试连接」重新发现；这不是空工具列表。</div></div>';
    if (agent.state === 'disconnected' && !tools.length) return '<div class="agents-block">' + head + '<div class="agents-mini">还没连接：连接成功后自动 listTools。</div></div>';
    if (!tools.length) return '<div class="agents-block">' + head + '<div class="agents-mini">没有发现到工具。</div></div>';
    const rows = tools.map(tool => '<div class="agents-tool"><code>' + esc(tool.name) + '</code><span class="agents-chip ' + (tool.readOnly ? 'ok' : 'wait') + '">' + (tool.readOnly ? '只读' : '写') + '</span></div>').join('');
    return '<div class="agents-block">' + head + '<div class="agents-tools">' + rows + '</div>' +
      '<p class="agents-note">读 / 写来自上游 annotations（readOnlyHint 缺省按写），只用于分级，不是授权。</p></div>';
  }

  function mrtrHtml(agent) {
    const mrtr = agent.mrtr || {sampling: true, elicitation: true};
    return '<div class="agents-block"><div class="agents-block-head"><b>MRTR</b><span>采样与弹表单</span></div>' +
      '<div class="agents-line"><span class="agents-chip ' + (mrtr.sampling ? 'ok' : '') + '">sampling ' + (mrtr.sampling ? '开' : '关') + '</span>' +
      '<span class="agents-chip ' + (mrtr.elicitation ? 'ok' : '') + '">elicitation ' + (mrtr.elicitation ? '开' : '') + '</span></div>' +
      '<p class="agents-note">默认都开；关闭后上游相应请求会被拒绝。本应用自己的敏感写确认不走 MRTR。</p></div>';
  }

  function statusPane(agent) {
    return '<div class="agents-card ' + (agent.state === 'connected' ? 'ok' : agent.state === 'failed' ? 'err' : agent.state === 'queued' || agent.state === 'connecting' ? 'wait' : 'idle') + '">' + statusHtml(agent) + '</div>' +
      toolsHtml(agent) + mrtrHtml(agent);
  }

  function envRows(agent, draft) {
    const saved = agent?.stdio?.envKeys || [];
    const typed = draft?.env || {};
    const keys = [...new Set([...saved, ...Object.keys(typed)])];
    if (!keys.length) return '<p class="agents-hint">还没有环境变量。</p>';
    return keys.map(key => '<div class="agents-env-row" data-env-key="' + esc(key) + '"><code>' + esc(key) + '</code><input type="password" autocomplete="off" value="' + esc(typed[key] || '') + '" placeholder="' + (saved.includes(key) ? '已保存 · 留空不修改' : '值') + '" aria-label="环境变量 ' + esc(key) + ' 的值"><button type="button" class="agents-rm" data-act="remove-env" title="删除这个变量">×</button></div>').join('');
  }

  function formHtml(agent, adding) {
    const transports = state.data?.transports || ['http'];
    const defaultTransport = transports.includes('stdio') ? 'stdio' : 'http';
    const draft = state.formDraft && state.formDraft.key === (adding ? '__new' : agent?.id) ? state.formDraft : null;
    const transport = draft?.transport || (adding ? (state.draftTransport || defaultTransport) : (agent?.transport || defaultTransport));
    const nameValue = draft ? draft.name : (agent?.name || '');
    const enabledValue = draft ? draft.enabled : agent?.enabled !== false;
    const mrtrValue = draft ? draft.mrtr : (agent?.mrtr || {sampling: true, elicitation: true});
    const stdio = transport === 'stdio';
    const url = agent?.http?.url || '';
    const tokenPlaceholder = agent?.hasToken ? '已保存（' + (agent.tokenMask || '••••••') + '），留空不修改' : '粘贴凭据（只存 KeyVault，不回显）';
    const headerPlaceholder = agent?.http?.hasHeaderValue ? '已保存 · 留空不修改' : '自定义 header 值（可选）';
    const transportOptions = transports.map(item =>
      '<label class="' + (item === transport ? 'on' : '') + '"><input type="radio" name="agents-transport" value="' + esc(item) + '"' + (item === transport ? ' checked' : '') + '> ' + esc(transportLabel(item)) + '</label>'
    ).join('');
    return '<form class="agents-form" id="agents-form" autocomplete="off">' +
      '<div class="agents-field"><label for="agents-name">名称（1–40 字，用户内唯一）</label><input id="agents-name" type="text" maxlength="40" value="' + esc(nameValue) + '" placeholder="例如 Claude Code"></div>' +
      '<div class="agents-field"><label>传输方式</label><div class="agents-seg">' + transportOptions + '</div>' +
        '<p class="agents-hint">' + (owner() ? 'stdio 等价于以服务器系统身份执行命令，仅 owner 可配；子进程不继承 CAREER_*、模型 Key 与代理。' : '成员只能配 HTTP；stdio 选项不显示，API 也会 400 拒绝。') + '</p></div>' +
      (stdio
        ? '<div class="agents-field"><label for="agents-command">命令（绝对路径或 PATH 可解析）</label><input id="agents-command" type="text" value="' + esc(draft ? draft.command : (agent?.stdio?.command || '')) + '" placeholder="claude"></div>' +
          '<div class="agents-field"><label for="agents-args">参数（空格分隔，shell: false）</label><input id="agents-args" type="text" value="' + esc(draft ? draft.args.join(' ') : (agent?.stdio?.args || []).join(' ')) + '" placeholder="mcp serve"></div>' +
          '<div class="agents-field"><label>环境变量</label><div id="agents-env-rows">' + envRows(agent, draft) + '</div><button type="button" class="agents-add" data-act="add-env">＋ 添加环境变量</button><p class="agents-hint">只注入这个 Agent；值存 KeyVault，界面只显示键名与掩码。</p></div>'
        : '<div class="agents-field"><label for="agents-url">URL（Streamable HTTP）</label><input id="agents-url" type="text" value="' + esc(draft ? draft.url : url) + '" placeholder="https://…/mcp">' +
          '<p class="agents-hint">公网必须 HTTPS；本机 / 私网 HTTP 需要下面显式允许。' + (agent?.hasUrlCredentials ? ' URL 里的用户信息或查询串已作为凭据保存在 KeyVault，界面只显示脱敏地址。' : '') + '</p></div>' +
          '<div class="agents-field check"><label><input id="agents-private" type="checkbox"' + ((draft ? draft.allowPrivateHttp : agent?.http?.allowPrivateHttp) ? ' checked' : '') + '> 允许局域网 HTTP（本机 / 私网地址）</label></div>' +
          '<div class="agents-field"><label for="agents-token">凭据</label><input id="agents-token" type="password" autocomplete="off" value="' + esc(draft ? draft.token || '' : '') + '" placeholder="' + esc(tokenPlaceholder) + '">' +
          '<p class="agents-hint">Bearer 凭据只存 KeyVault，不写进提示词、trace 或证据；401 报 AUTH_FAILED，不做 OAuth 自动刷新。</p></div>' +
          '<div class="agents-field"><label for="agents-header">自定义 header（可选）</label><input id="agents-header" type="text" value="' + esc(draft ? draft.headerName : (agent?.http?.headerName || '')) + '" placeholder="例如 X-API-Key；留空走 Authorization: Bearer">' +
          '<input id="agents-header-value" type="password" autocomplete="off" value="' + esc(draft ? draft.headerValue || '' : '') + '" placeholder="' + esc(headerPlaceholder) + '"></div>') +
      '<div class="agents-field check"><label><input id="agents-enabled" type="checkbox"' + (enabledValue ? ' checked' : '') + '> 启用这个 Agent</label></div>' +
      '<div class="agents-field"><label>MRTR</label>' +
        '<div class="agents-field check"><label><input id="agents-sampling" type="checkbox"' + (mrtrValue?.sampling !== false ? ' checked' : '') + '> sampling · 允许上游请求模型补全</label></div>' +
        '<div class="agents-field check"><label><input id="agents-elicitation" type="checkbox"' + (mrtrValue?.elicitation !== false ? ' checked' : '') + '> elicitation · 允许上游弹表单</label></div>' +
        '<p class="agents-hint">默认都开；关闭后上游相应请求被拒绝（UNSUPPORTED）。</p></div>' +
      '<div class="agents-actions"><button type="button" class="primary" data-act="save">保存</button>' +
        (adding ? '' : '<button type="button" data-act="test">测试连接</button><button type="button" class="danger" data-act="delete">删除</button>') +
        '<button type="button" data-act="cancel">' + (adding ? '取消' : '返回状态') + '</button></div>' +
      '<p class="agents-feedback" id="agents-feedback" role="status">' + esc(state.feedback) + '</p>' +
      '<div class="agents-reveal">配置存 users/&lt;id&gt;/.data/agents.json；凭据进该用户 KeyVault；每用户最多 10 个。</div>' +
    '</form>';
  }

  function detailHtml() {
    if (state.adding) {
      return '<div class="agents-detail-head"><button type="button" class="agents-back" data-act="back">← 全部</button><div class="agents-detail-main"><h3>添加外部 Agent</h3><p class="agents-sub">配置保存后可以「测试连接」：只连接与发现工具，不调用任何工具。</p></div></div>' + formHtml(null, true);
    }
    const agent = selected();
    if (!agent) return '<div class="agents-empty">左侧选择或添加一个外部 Agent。</div>';
    const modeLabel = agent.transport === 'stdio' ? 'stdio' : 'HTTP';
    const display = agent.transport === 'stdio'
      ? (agent.stdio?.command || '') + ' ' + (agent.stdio?.args || []).join(' ')
      : (agent.http?.url || '');
    return '<div class="agents-detail-head"><button type="button" class="agents-back" data-act="back">← 全部</button>' +
      '<div class="agents-detail-main"><h3>' + esc(agent.name) + ' <span class="agents-tag">' + esc(modeLabel) + '</span>' + (agent.enabled === false ? ' <span class="agents-tag">已停用</span>' : '') + '</h3>' +
      '<p class="agents-sub">' + esc(display) + (agent.lastConnectedAt ? ' · 最近连接 ' + esc(fmtTime(agent.lastConnectedAt)) : '') +
        ' · 出网：' + (agent.outbound?.neverAsk ? '已同意' : '未同意') + '</p></div>' +
      (agent.outbound?.neverAsk ? '' : '<button type="button" data-act="consent">允许出网</button>') +
      '<button type="button" data-act="reconnect">重连</button></div>' +
      '<div class="agents-subtabs"><button type="button" data-subtab="status" class="' + (state.subtab === 'status' ? 'on' : '') + '">状态与工具</button><button type="button" data-subtab="config" class="' + (state.subtab === 'config' ? 'on' : '') + '">配置</button></div>' +
      '<div>' + (state.subtab === 'config' ? formHtml(agent, false) : statusPane(agent)) + '</div>';
  }

  function render() {
    const panel = $('#agents-tab-panel');
    if (!panel) return;
    panel.dataset.view = state.view;
    if (!state.data) {
      panel.innerHTML = '<p class="agents-hint">正在读取外部 Agent 配置…</p>';
      return;
    }
    panel.innerHTML = '<div class="agents-wrap"><div class="agents-list-pane">' + listHtml() + '</div><div class="agents-detail-pane">' + detailHtml() + '</div></div>' +
      (state.error ? '<p class="agents-feedback err" role="alert">' + esc(state.error) + '</p>' : '');
  }

  async function load() {
    try {
      const data = await api('agents');
      state.data = data;
      state.error = '';
      if (!state.selectedId && data.agents?.length && !state.adding) {
        state.selectedId = data.agents[0].id;
        // 手机上先看列表，点进详情才是第二屏；桌面直接两栏。
        if (window.innerWidth > 750) state.view = 'detail';
      }
      if (state.selectedId && !data.agents.some(agent => agent.id === state.selectedId) && !state.adding) {
        state.selectedId = data.agents[0]?.id || '';
      }
    } catch (error) {
      state.error = error.message;
    }
    render();
  }

  function setTab(tab) {
    state.tab = tab;
    const dialog = $('#dialog');
    const tabs = $('#settings-tab-bar');
    if (tabs) tabs.querySelectorAll('button').forEach(button => button.classList.toggle('on', button.dataset.settingsTab === tab));
    const modelPanel = $('#model-tab-panel');
    const agentsPanel = $('#agents-tab-panel');
    if (modelPanel) modelPanel.hidden = tab !== 'model';
    if (agentsPanel) agentsPanel.hidden = tab !== 'agents';
    if (dialog) dialog.classList.toggle('agents-wide', tab === 'agents');
    const content = $('#dialog-content');
    if (content) content.dataset.activeTab = tab;
    if (tab === 'agents') load().catch(() => {});
  }

  function mount() {
    const content = $('#dialog-content');
    if (!content || !$('#ms-form') || $('#settings-tab-bar')) return;
    ensureStyle();
    const title = content.querySelector('h2');
    const tabs = document.createElement('div');
    tabs.id = 'settings-tab-bar';
    tabs.className = 'settings-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.innerHTML = '<button type="button" role="tab" data-settings-tab="model" class="on">模型与接口</button><button type="button" role="tab" data-settings-tab="agents">外部 Agent</button>';
    if (title) title.after(tabs); else content.prepend(tabs);
    const modelPanel = document.createElement('div');
    modelPanel.id = 'model-tab-panel';
    tabs.after(modelPanel);
    for (const node of [...content.children]) {
      if (node === title || node === tabs || node === modelPanel) continue;
      if (node.id === 'inbound-mcp-section' || node.id === 'agents-tab-panel') continue;
      modelPanel.appendChild(node);
    }
    const agentsPanel = document.createElement('div');
    agentsPanel.id = 'agents-tab-panel';
    agentsPanel.hidden = true;
    agentsPanel.setAttribute('aria-label', '外部 Agent');
    modelPanel.after(agentsPanel);
    // 重新打开对话框时重置到第一页签；入站 MCP 区仍挂在对话框底部，只在本页签隐藏。
    state.tab = 'model';
    state.selectedId = '';
    state.view = 'list';
    state.subtab = 'status';
    state.adding = false;
    state.draftTransport = '';
    state.formDraft = null;
    state.pendingRemoveEnv = [];
    state.busy = false;
    state.error = '';
    state.feedback = '';
    state.data = null;
    setTab('model');
    render();
  }

  function readForm() {
    const value = id => ($('#' + id)?.value || '').trim();
    const transport = $('#agents-form input[name="agents-transport"]:checked')?.value || 'http';
    if (transport === 'stdio') {
      const env = {};
      for (const row of $$('#agents-env-rows .agents-env-row')) {
        const key = row.dataset.envKey || row.querySelector('[data-env-new-key]')?.value.trim() || '';
        const input = row.querySelector('input[type="password"]');
        if (key && input && input.value.trim()) env[key] = input.value;
      }
      return {
        name: value('agents-name'),
        transport,
        command: value('agents-command'),
        args: value('agents-args') ? value('agents-args').split(/\s+/).filter(Boolean) : [],
        env,
        removeEnv: [...state.pendingRemoveEnv],
        enabled: $('#agents-enabled')?.checked === true,
        mrtr: {sampling: $('#agents-sampling')?.checked === true, elicitation: $('#agents-elicitation')?.checked === true}
      };
    }
    const body = {
      name: value('agents-name'),
      transport,
      url: value('agents-url'),
      allowPrivateHttp: $('#agents-private')?.checked === true,
      headerName: value('agents-header'),
      enabled: $('#agents-enabled')?.checked === true,
      mrtr: {sampling: $('#agents-sampling')?.checked === true, elicitation: $('#agents-elicitation')?.checked === true}
    };
    const token = $('#agents-token')?.value || '';
    if (token.trim()) body.token = token.trim();
    const headerValue = $('#agents-header-value')?.value || '';
    if (headerValue.trim()) body.headerValue = headerValue.trim();
    return body;
  }

  async function doSave() {
    const body = readForm();
    state.busy = true;
    state.feedback = '正在保存…';
    state.error = '';
    render();
    try {
      const result = state.adding
        ? await ZX.api('agents', body)
        : await ZX.api('agents', {...body, id: state.selectedId}, 'PATCH');
      state.adding = false;
      state.draftTransport = '';
      state.formDraft = null;
      state.pendingRemoveEnv = [];
      state.busy = false;
      state.selectedId = result.agent.id;
      state.view = 'detail';
      state.subtab = 'status';
      state.feedback = '已保存。可以点「测试连接」验证连接与工具发现。';
      await load();
      state.subtab = 'status';
      render();
    } catch (error) {
      state.busy = false;
      state.error = error.message;
      state.feedback = error.message;
      render();
    }
  }

  async function runAction(path, label) {
    if (!state.selectedId) return;
    state.busy = true;
    state.error = '';
    state.feedback = label + '…';
    render();
    try {
      const result = await ZX.api('agents/' + path, {id: state.selectedId});
      state.busy = false;
      state.feedback = result.ok === false
        ? '失败：' + (result.code || 'CONNECT_FAILED') + '。' + (result.recovery || '')
        : path === 'test' ? '连接成功，已发现 ' + (result.agent?.tools?.length || 0) + ' 个工具。'
          : path === 'consent' ? '已记录出网同意：之后来源校对的文本复核可以直接执行。'
            : '已刷新。';
      if (result.ok === false) state.error = result.error || '';
      await load();
      if (path === 'refresh' || path === 'reconnect') state.subtab = 'status';
      render();
    } catch (error) {
      state.busy = false;
      state.error = error.message;
      state.feedback = error.message;
      render();
    }
  }

  async function doDelete() {
    if (!state.selectedId) return;
    if (!window.confirm('删除这个外部 Agent？它的凭据也会从 KeyVault 删除。')) return;
    state.busy = true;
    try {
      await ZX.api('agents?id=' + encodeURIComponent(state.selectedId), undefined, 'DELETE');
      state.selectedId = '';
      state.view = 'list';
      state.adding = false;
      state.subtab = 'status';
      await load();
    } catch (error) {
      state.error = error.message;
    }
    state.busy = false;
    render();
  }

  document.addEventListener('click', async event => {
    const tab = event.target.closest('#settings-tab-bar [data-settings-tab]');
    if (tab) { setTab(tab.dataset.settingsTab); return; }
    if (!event.target.closest('#agents-tab-panel')) return;
    const row = event.target.closest('[data-agent-id]');
    if (row) {
      state.selectedId = row.dataset.agentId;
      state.formDraft = null;
      state.adding = false;
      state.view = 'detail';
      state.subtab = 'status';
      state.feedback = '';
      state.error = '';
      render();
      return;
    }
    const subtab = event.target.closest('[data-subtab]');
    if (subtab) { state.subtab = subtab.dataset.subtab; state.formDraft = null; state.feedback = ''; render(); return; }
    const action = event.target.closest('[data-act]')?.dataset.act;
    if (!action) return;
    if (action === 'add') {
      state.adding = true;
      state.selectedId = '';
      state.formDraft = null;
      state.draftTransport = '';
      state.pendingRemoveEnv = [];
      state.view = 'detail';
      state.subtab = 'config';
      state.feedback = '';
      state.error = '';
      render();
      return;
    }
    if (action === 'back') { state.view = 'list'; state.adding = false; state.formDraft = null; render(); return; }
    if (action === 'cancel') { state.adding = false; state.formDraft = null; state.subtab = 'status'; state.feedback = ''; render(); return; }
    if (action === 'save') { await doSave(); return; }
    if (action === 'test') { await runAction('test', '正在连接并发现工具'); return; }
    if (action === 'refresh') { await runAction('refresh', '正在刷新工具'); return; }
    if (action === 'reconnect') { await runAction('reconnect', '正在重连'); return; }
    if (action === 'consent') { await runAction('consent', '正在记录出网同意'); return; }
    if (action === 'delete') { await doDelete(); return; }
    if (action === 'add-env') {
      const rows = $('#agents-env-rows');
      if (!rows) return;
      const index = rows.querySelectorAll('.agents-env-row').length;
      const row = document.createElement('div');
      row.className = 'agents-env-row';
      row.innerHTML = '<input type="text" data-env-new-key placeholder="变量名" aria-label="新环境变量名"><input type="password" autocomplete="off" data-env-new-value placeholder="值（保存后只显示掩码）" aria-label="新环境变量值"><button type="button" class="agents-rm" data-act="remove-env" title="删除这个变量">×</button>';
      row.dataset.envRow = String(index);
      rows.appendChild(row);
      return;
    }
    if (action === 'remove-env') {
      const row = event.target.closest('.agents-env-row');
      const key = row?.dataset.envKey;
      if (key) state.pendingRemoveEnv = [...new Set([...(state.pendingRemoveEnv || []), key])];
      row?.remove();
      return;
    }
  });

  document.addEventListener('change', event => {
    const radio = event.target.closest('input[name="agents-transport"]');
    if (!radio) return;
    // 切换传输会换字段：先把已填内容收进草稿，再重绘，避免用户丢输入。
    state.formDraft = {...readForm(), key: state.adding ? '__new' : state.selectedId};
    if (state.adding) state.draftTransport = radio.value;
    render();
  });

  function observe() {
    const content = $('#dialog-content');
    if (!content) return;
    new MutationObserver(() => mount()).observe(content, {childList: true, subtree: false});
    mount();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observe, {once: true});
  else observe();
})();
