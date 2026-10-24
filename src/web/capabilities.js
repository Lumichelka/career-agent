// 能力面板：把工具、技能、记忆从"藏在代码里"变成界面上可见。
(function () {
  const $ = s => document.querySelector(s);
  const ZX = window.__zx || {};
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

  const badge = (text, tone) => '<span style="display:inline-block;font-size:10px;padding:1px 8px;border-radius:20px;' +
    (tone === 'write' ? 'background:#fdf1e6;color:#9a5a21;border:1px solid #f0d9c2' : 'background:#eef6f0;color:#3d6b52;border:1px solid #d6e6db') +
    '">' + esc(text) + '</span>';

  function toolCard(t) {
    const params = Object.keys(t.parameters?.properties || {});
    return '<section class="platform-card" style="margin:10px 0;padding:14px">' +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
      '<code style="font-size:12px">' + esc(t.name) + '</code>' +
      badge(t.permission === 'write' ? '可写' : '只读', t.permission) +
      '<span style="font-size:11px;color:#819b8b">超时 ' + Math.round((t.timeoutMs || 10000) / 1000) + 's</span>' +
      '</div>' +
      '<p style="margin:6px 0 0;font-size:13px;color:#20332c">' + esc(t.title) + '</p>' +
      '<p style="margin:4px 0 0;font-size:12px;color:#74867b;line-height:1.7">' + esc(t.description) + '</p>' +
      (params.length ? '<p style="margin:4px 0 0;font-size:11px;color:#879083">参数：' + params.map(esc).join(' · ') + '</p>' : '<p style="margin:4px 0 0;font-size:11px;color:#879083">无参数</p>') +
      '</section>';
  }

  function skillCard(s) {
    return '<section class="platform-card" style="margin:10px 0;padding:14px">' +
      '<code style="font-size:12px">' + esc(s.id) + '</code> ' + badge(s.writes ? '含写入' : '只读', s.writes ? 'write' : 'read') +
      '<p style="margin:6px 0 0;font-size:13px">' + esc(s.name) + '</p>' +
      '<p style="margin:4px 0 0;font-size:12px;color:#74867b">触发：' + (s.triggers.length ? s.triggers.map(esc).join(' / ') : '未声明') + '</p>' +
      '</section>';
  }

  async function show() {
    const data = await ZX.api('capabilities');
    const tools = data.tools || [];
    const skills = data.skills || [];
    const reads = tools.filter(t => t.permission !== 'write').length;
    const writes = tools.length - reads;
    const layers = data.memory?.layers || [];

    $('#dialog-content').innerHTML =
      '<h2>能力与记忆</h2>' +
      '<p class="platform-note">这里是智能体"会做什么"的清单。模型调用、参数校验、能力面板共用同一份定义（<code>src/tools/registry.mjs</code>）。</p>' +
      '<div style="display:flex;gap:16px;flex-wrap:wrap;margin:12px 0 4px;font-size:12px;color:#3d6b52">' +
      '<span><b style="font-size:20px">' + tools.length + '</b> 个工具</span>' +
      '<span><b style="font-size:20px">' + reads + '</b> 只读</span>' +
      '<span><b style="font-size:20px">' + writes + '</b> 可写</span>' +
      '<span><b style="font-size:20px">' + skills.length + '</b> 个技能</span>' +
      '</div>' +
      '<h3 style="font-size:14px;margin:16px 0 4px">工具</h3>' +
      (tools.length ? tools.map(toolCard).join('') : '<p class="platform-note">没有注册工具。</p>') +
      '<h3 style="font-size:14px;margin:18px 0 4px">技能</h3>' +
      (skills.length ? skills.map(skillCard).join('') : '<p class="platform-note">还没有技能。M7 阶段会添加四个：行程规划、公司调研、简历定向、面试准备。技能是"步骤 + 约束 + 验收"，不是新工具。</p>') +
      '<h3 style="font-size:14px;margin:18px 0 4px">记忆</h3>' +
      layers.map(l => '<section class="platform-card" style="margin:8px 0;padding:12px">' +
        '<b style="font-size:13px">' + esc(l.name) + '</b> <span style="font-size:11px;color:#819b8b">' + esc(l.scope) + '</span>' +
        '<p style="margin:5px 0 0;font-size:12px;color:#74867b">存：' + esc(l.stores) + '</p>' +
        '<p style="margin:3px 0 0;font-size:12px;color:#74867b">规则：' + esc(l.rule) + '</p>' +
        '</section>').join('') +
      '<p class="platform-note">' + esc(data.memory?.note || '') + '</p>';

    if (!$('#dialog').open) $('#dialog').showModal();
  }

  function mount() {
    const anchor = $('#recruit-entry') || $('#platforms');
    if (!anchor || $('#capability-entry')) return;
    const button = document.createElement('button');
    button.id = 'capability-entry';
    button.className = 'new platform-launch';
    button.textContent = '⚙ 能力与记忆';
    button.onclick = () => show().catch(e => ZX.showError?.(e.message));
    anchor.after(button);
  }

  mount();
})();
