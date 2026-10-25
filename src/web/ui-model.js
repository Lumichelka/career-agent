// 模型设置面板的增强版：供应商预设、一键体检、代理、备用接口。
// 以独立脚本覆盖首页原有面板，避免改动大段内联代码。
(function () {
  const ZX = window.__zx || {};
  const $ = s => document.querySelector(s);
  const val = s => ($(s) ? $(s).value : '');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  let presets = [];

  function feedback(text, isError) {
    const el = $('#ms-feedback');
    if (!el) return;
    el.textContent = text;
    el.style.color = isError ? '#a64232' : '#2d7150';
  }

  function applyPreset(id) {
    const p = presets.find(x => x.id === id);
    if (!p) return;
    $('#ms-protocol').value = p.protocol || 'chat';
    if (p.baseUrl) $('#ms-base').value = p.baseUrl;
    if (p.model) $('#ms-model').value = p.model;
    $('#ms-note').textContent = p.note || '';
    const keyHint = $('#ms-key-hint');
    if (keyHint) keyHint.innerHTML = p.keyUrl ? '在哪里申请：<a href="' + esc(p.keyUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(p.keyUrl) + ' ↗</a>' : '';
  }

  function collect() {
    const fallbackEnabled = $('#ms-fb-enable').checked;
    return {
      preset: val('#ms-preset'), mode: val('#ms-mode'), protocol: val('#ms-protocol'),
      baseUrl: val('#ms-base').trim(), model: val('#ms-model').trim(),
      apiKey: val('#ms-key'), clearKey: $('#ms-clear').checked,
      proxy: val('#ms-proxy').trim(), allowPrivateHttp: $('#ms-private').checked,
      maxTokens: Number(val('#ms-max') || 8192), stream: true,
      searchUrl: val('#ms-search').trim(),
      fallback: fallbackEnabled ? {
        enabled: true,
        preset: val('#ms-fb-preset'), protocol: 'chat',
        baseUrl: val('#ms-fb-base').trim(), model: val('#ms-fb-model').trim(),
        apiKey: val('#ms-fb-key')
      } : {enabled: false}
    };
  }

  function renderDiag(report) {
    const box = $('#ms-diag');
    box.hidden = false;
    box.innerHTML = report.stages.map(s => {
      const tone = s.status === 'pass' ? '#2d7150' : s.status === 'warn' ? '#a06a1c' : s.status === 'fail' ? '#a64232' : '#8a8a8a';
      const icon = s.status === 'pass' ? '✔' : s.status === 'warn' ? '!' : s.status === 'fail' ? '✘' : '·';
      return '<div style="display:flex;gap:8px;margin:5px 0"><span style="color:' + tone + ';width:14px">' + icon + '</span>' +
        '<div><b>' + esc(s.label) + '</b>　<span style="color:#6b7b70">' + esc(s.detail || '') + '</span>' +
        (s.fix ? '<div style="color:' + tone + ';font-size:11.5px">建议：' + esc(s.fix) + '</div>' : '') + '</div></div>';
    }).join('') + '<div style="margin-top:8px;font-weight:600;color:' + (report.ok ? '#2d7150' : '#a64232') + '">' + esc(report.hint || '') + '</div>';
  }

  window.showModelSettings = async function () {
    const c = await ZX.refreshModelLabel();
    try { presets = (await ZX.api('model/presets')).presets || []; } catch { presets = []; }
    const presetOptions = presets.map(p => '<option value="' + esc(p.id) + '">' + esc(p.label) + '</option>').join('');

    $('#dialog-content').innerHTML = `
      <h2>模型与接口</h2>
      <p class="platform-note">先选供应商预设，通常只需再填一个 API Key。Key 会加密保存在本机，重启后不用重填。</p>
      <form id="ms-form" class="model-grid">
        <label>供应商预设
          <select id="ms-preset">${presetOptions}</select>
          <small id="ms-note"></small>
        </label>
        <label>执行后端
          <select id="ms-mode">
            <option value="api">API · 联网服务</option>
            <option value="local">本地模型 · Ollama / LM Studio</option>
            <option value="codex">本机 Codex（需自行安装登录）</option>
          </select>
        </label>
        <label>接口协议
          <select id="ms-protocol">
            <option value="chat">OpenAI Chat Completions</option>
            <option value="responses">OpenAI Responses</option>
            <option value="messages">Anthropic Messages</option>
          </select>
        </label>
        <label>接口基础地址
          <input id="ms-base" placeholder="https://api.deepseek.com">
          <small>填到 /v1 或服务根地址即可，程序会补协议路径；粘贴带 /chat/completions 的地址也会自动纠正。</small>
        </label>
        <label>模型名
          <input id="ms-model" placeholder="deepseek-chat">
        </label>
        <label>API Key
          <input id="ms-key" type="password" autocomplete="off" placeholder="${c.hasKey ? '已保存（' + esc(c.keySource || '') + '），留空表示不修改' : '粘贴你的 Key；本地模型通常不需要'}">
          <small id="ms-key-hint"></small>
        </label>
        <label class="model-check"><input id="ms-clear" type="checkbox">清除已保存的 Key</label>
        <details>
          <summary>网络与高级选项</summary>
          <label>代理地址（可选）
            <input id="ms-proxy" placeholder="http://127.0.0.1:7890">
            <small>访问境外接口需要代理时填写；留空则直连。只支持 http:// 代理。</small>
          </label>
          <label class="model-check"><input id="ms-private" type="checkbox">允许局域网 HTTP 接口（如自建网关在 NAS 上）</label>
          <label>单次输出上限（tokens）
            <input id="ms-max" type="number" min="256" max="64000" step="256">
            <small>写长简历建议 8192；推理模型可调高。</small>
          </label>
          <label>通用联网搜索地址（可选，SearXNG）
            <input id="ms-search" placeholder="https://你的搜索服务/search">
          </label>
          <label class="model-check"><input id="ms-fb-enable" type="checkbox">启用备用接口（主接口失败时自动切换）</label>
          <label>备用供应商<select id="ms-fb-preset">${presetOptions}</select></label>
          <label>备用基础地址<input id="ms-fb-base" placeholder="https://open.bigmodel.cn/api/paas/v4"></label>
          <label>备用模型名<input id="ms-fb-model" placeholder="glm-4-flash"></label>
          <label>备用 API Key<input id="ms-fb-key" type="password" autocomplete="off" placeholder="${c.hasFallbackKey ? '已保存，留空不修改' : '可留空'}"></label>
        </details>
        <div class="model-buttons">
          <button type="button" id="ms-diag-btn">一键体检</button>
          <button type="button" id="ms-test">测试接口</button>
          <button type="submit">保存并用于后续任务</button>
        </div>
        <div id="ms-feedback" role="status"></div>
        <div id="ms-diag" hidden style="font-size:12px;line-height:1.7;border:1px solid #dce7df;border-radius:10px;padding:10px 12px;background:#fbfdfb"></div>
      </form>`;

    $('#ms-preset').value = c.preset || 'custom';
    $('#ms-mode').value = c.mode;
    $('#ms-protocol').value = c.protocol;
    $('#ms-base').value = c.baseUrl;
    $('#ms-model').value = c.model;
    $('#ms-proxy').value = c.proxy || '';
    $('#ms-private').checked = !!c.allowPrivateHttp;
    $('#ms-max').value = c.maxTokens || 8192;
    $('#ms-search').value = c.searchUrl || '';
    if (c.fallback?.enabled) {
      $('#ms-fb-enable').checked = true;
      $('#ms-fb-preset').value = c.fallback.preset || 'custom';
      $('#ms-fb-base').value = c.fallback.baseUrl || '';
      $('#ms-fb-model').value = c.fallback.model || '';
    }
    applyPreset(c.preset || 'custom');

    $('#ms-preset').onchange = () => applyPreset(val('#ms-preset'));
    $('#ms-fb-preset').onchange = () => {
      const p = presets.find(x => x.id === val('#ms-fb-preset'));
      if (p) { $('#ms-fb-base').value = p.baseUrl || ''; $('#ms-fb-model').value = p.model || ''; }
    };

    $('#ms-form').onsubmit = async e => {
      e.preventDefault();
      try {
        const result = await ZX.api('model/save', collect());
        $('#ms-key').value = ''; $('#ms-fb-key').value = '';
        $('#engine-label').textContent = '当前驱动：' + result.label;
        feedback('设置已保存。' + (result.hasKey ? ' Key 已加密保存在本机。' : ' 尚未保存 Key，可稍后填写。'));
      } catch (err) { feedback(err.message, true); }
    };

    $('#ms-test').onclick = async () => {
      const btn = $('#ms-test');
      btn.disabled = true;
      feedback('正在发送最小连通测试，不发送简历或聊天记录……');
      try { feedback((await ZX.api('model/test', collect())).message); }
      catch (err) { feedback(err.message, true); }
      finally { btn.disabled = false; }
    };

    $('#ms-diag-btn').onclick = async () => {
      const btn = $('#ms-diag-btn');
      btn.disabled = true;
      btn.textContent = '体检中…';
      feedback('依次检查 域名 → 端口 → 证书 → 鉴权 → 工具调用 → JSON 输出，约 5–20 秒。');
      try { renderDiag(await ZX.api('model/diag', {settings: collect()})); feedback(''); }
      catch (err) { feedback(err.message, true); }
      finally { btn.disabled = false; btn.textContent = '一键体检'; }
    };

    if (!$('#dialog').open) $('#dialog').showModal();
  };

  $('#model-settings').onclick = () => window.showModelSettings().catch(e => ZX.showError?.(e.message));
  if ($('#mobile-model')) $('#mobile-model').onclick = () => window.showModelSettings().catch(e => ZX.showError?.(e.message));

  // 侧栏加入口：工作台 / 招聘日历
  try {
    const anchor = $('#platforms');
    if (anchor && !$('#today-entry')) {
      const t = document.createElement('button');
      t.id = 'today-entry';
      t.className = 'new platform-launch';
      t.textContent = '▦ 今天 / 工作台';
      t.onclick = () => { location.href = '/'; };
      anchor.before(t);
    }
    if (anchor && !$('#recruit-entry')) {
      const b = document.createElement('button');
      b.id = 'recruit-entry';
      b.className = 'new platform-launch';
      b.textContent = '▤ 招聘日历 / 行程表';
      b.onclick = () => { location.href = '/recruit'; };
      anchor.after(b);
    }
    const recruit = $('#recruit-entry');
    if (recruit && !$('#resume-entry')) {
      const r = document.createElement('button');
      r.id = 'resume-entry';
      r.className = 'new platform-launch';
      r.textContent = '▥ 简历与投递';
      r.onclick = () => { location.href = '/resume'; };
      recruit.after(r);
    }
    const resumeBtn = $('#resume-entry');
    if (resumeBtn && !$('#company-entry')) {
      const c = document.createElement('button');
      c.id = 'company-entry';
      c.className = 'new platform-launch';
      c.textContent = '▦ 公司档案';
      c.onclick = () => { location.href = '/companies'; };
      resumeBtn.after(c);
    }
    const platformsBtn = $('#platforms');
    if (platformsBtn && !$('#data-root-link')) {
      const d = document.createElement('a');
      d.id = 'data-root-link';
      d.href = '/recruit';
      d.className = 'new';
      d.textContent = '▤ 数据与日历';
      d.style.display = 'block';
      d.style.textDecoration = 'none';
      platformsBtn.after(d);
    }
    const sessionsEl = $('#sessions');
    if (sessionsEl && !$('#session-search')) {
      const q = document.createElement('input');
      q.id = 'session-search';
      q.placeholder = '搜索对话…';
      q.setAttribute('aria-label', '搜索对话');
      q.style.cssText = 'width:100%;margin:8px 0;padding:8px 10px;border:1px solid #dce7df;border-radius:8px;background:#fff;font:12px inherit;color:#1f3a2e';
      sessionsEl.before(q);
      const filter = () => {
        const v = q.value.trim().toLowerCase();
        sessionsEl.querySelectorAll('button').forEach(b => { b.style.display = !v || b.textContent.toLowerCase().includes(v) ? '' : 'none'; });
      };
      q.addEventListener('input', filter);
      new MutationObserver(filter).observe(sessionsEl, {childList: true});
    }
    const companyBtn = $('#company-entry');
    if (companyBtn && !$('#wechat-entry')) {
      const x = document.createElement('button');
      x.id = 'wechat-entry';
      x.className = 'new platform-launch';
      x.textContent = '✉ 公众号文章';
      x.onclick = () => { location.href = '/wechat'; };
      companyBtn.after(x);
    }
  } catch { /* 侧栏结构变化时忽略 */ }
  function setupContextPanel() {
    const header = document.querySelector('header');
    if (!header || document.getElementById('context-toggle')) return;
    const project = new URLSearchParams(location.search).get('project') || '';
    const btn = document.createElement('button');
    btn.id = 'context-toggle';
    btn.textContent = '上下文';
    btn.style.cssText = 'margin-left:10px;padding:5px 10px;border:1px solid #d5dfcd;border-radius:8px;background:#fff;color:#2d5542;font-size:11px;cursor:pointer';
    header.appendChild(btn);
    const panel = document.createElement('div');
    panel.id = 'context-panel';
    panel.hidden = true;
    panel.style.cssText = 'position:fixed;right:18px;top:70px;width:280px;z-index:30;background:#fff;border:1px solid #dce7df;border-radius:12px;padding:12px;box-shadow:0 12px 36px #1f3a2e22;font-size:12px;line-height:1.8;color:#314b3f';
    panel.innerHTML = '<b style="font-size:12px">当前上下文</b>' + (project ? '<div style="margin-top:6px">项目：<code style="font-size:10px">' + project.slice(0,8) + '…</code></div>' : '<div style="margin-top:6px;color:#7b8b80">还没有从日历选择项目</div>') + '<div style="margin-top:8px"><a href="/recruit">打开数据与日历 →</a></div><div><a href="/resume">我的简历</a> · <a href="/companies">公司档案</a></div><div style="color:#7b8b80;margin-top:6px">来源只来自高校/公众号；平台用于研究岗位要求与薪资。</div>';
    document.body.appendChild(panel);
    btn.onclick = () => { panel.hidden = !panel.hidden; };
    if (project) {
      panel.hidden = false;
      const input = document.querySelector('#input');
      if (input && !input.value.trim()) {
        input.value = '研究这个招聘项目（ID：' + project + '）：先读取项目详情和所属活动，再查公司/行业/岗位要求和薪资，最后对照我的简历给出准备建议。不要从平台登记岗位或投递。';
        input.dispatchEvent(new Event('input', {bubbles: true}));
      }
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setupContextPanel, {once: true});
  else setTimeout(setupContextPanel, 0);
})();