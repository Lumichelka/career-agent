// 记忆面板：会话记忆 / 长期画像 / 任务记录。
(function () {
  const $ = s => document.querySelector(s);
  const ZX = window.__zx || {};
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

  const when = iso => {
    if (!iso) return '';
    const d = new Date(iso);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  async function load() {
    const session = ZX.currentSession?.();
    return ZX.api('memory' + (session?.id ? '?session=' + encodeURIComponent(session.id) : ''));
  }

  function factRow(f) {
    return '<div style="display:flex;gap:10px;align-items:flex-start;border:1px solid #e2e8e1;border-radius:10px;padding:10px 12px;margin:7px 0">' +
      '<div style="flex:1;min-width:0">' +
      '<b style="font-size:13px">' + esc(f.key) + '</b>' +
      '<div style="font-size:12px;color:#4e6558;margin-top:2px;white-space:pre-wrap">' + esc(f.value) + '</div>' +
      '<div style="font-size:10.5px;color:#879083;margin-top:3px">' + esc(f.source || '手动添加') + ' · ' + esc(when(f.updatedAt)) + '</div>' +
      '</div>' +
      '<button data-mem-delete="' + esc(f.id) + '" style="font-size:11px;padding:4px 9px">删除</button>' +
      '</div>';
  }

  function taskRow(t) {
    const tone = t.status === 'failed' ? '#a64232' : '#3d6b52';
    return '<div style="border-left:3px solid ' + tone + ';padding:6px 10px;margin:6px 0;background:#fbfdfb">' +
      '<div style="font-size:12.5px">' + esc(t.title || '未命名任务') + ' <span style="color:' + tone + ';font-size:10.5px">' + (t.status === 'failed' ? '失败' : '完成') + '</span></div>' +
      '<div style="font-size:10.5px;color:#879083;margin-top:2px">' + esc(when(t.at)) +
      (t.tools.length ? ' · 工具：' + esc(t.tools.join(' / ')) : '') +
      (t.artifact ? ' · 产出：' + esc(t.artifact) : '') +
      (t.error ? ' · 错误：' + esc(t.error) : '') + '</div>' +
      '</div>';
  }

  function render(data) {
    const profile = data.profile || [];
    const tasks = data.tasks || [];
    const session = data.session;
    const limits = data.limits || {};
    const canImport = !!(session?.memory && session.memory.trim());

    $('#dialog-content').innerHTML =
      '<h2>记忆与画像</h2>' +
      '<p class="platform-note">会话记忆每轮自动更新；长期画像只有你确认后才写入；任务记录自动保存最近 ' + (limits.tasks || 100) + ' 条。' +
      '删除画像后，后续对话不会再引用它。</p>' +

      '<h3 style="font-size:14px;margin:16px 0 4px">本次对话</h3>' +
      '<div style="font-size:12.5px;line-height:1.8;background:#f8faf7;border:1px solid #e2e8e1;border-radius:10px;padding:10px 12px;white-space:pre-wrap;max-height:140px;overflow:auto">' +
      esc(session?.memory || '（还没有累积记忆，先聊几句）') + '</div>' +
      '<div style="margin-top:8px"><button id="mem-import" ' + (canImport ? '' : 'disabled') + '>把本次要点存入长期画像</button></div>' +

      '<h3 style="font-size:14px;margin:18px 0 4px">长期画像 <span style="font-size:11px;color:#879083">' + profile.length + ' / ' + (limits.facts || 50) + '</span></h3>' +
      (profile.length ? profile.map(factRow).join('') : '<p class="platform-note">还没有长期画像。可以手动添加，或把本次对话要点存进来。</p>') +
      '<form id="mem-add" style="display:grid;gap:8px;margin-top:10px;border-top:1px dashed #e2e8e1;padding-top:12px">' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<input id="mem-key" maxlength="40" placeholder="要点名称，如：目标城市" style="flex:0 1 220px;padding:7px 9px;border:1px solid #d7e1d9;border-radius:8px;font:13px inherit">' +
      '<input id="mem-value" maxlength="500" placeholder="内容，如：成都、上海" style="flex:1 1 260px;padding:7px 9px;border:1px solid #d7e1d9;border-radius:8px;font:13px inherit">' +
      '<button type="submit">保存到画像</button>' +
      '</div></form>' +
      '<div id="mem-feedback" style="font-size:11.5px;color:#2d7150;margin-top:6px"></div>' +

      '<h3 style="font-size:14px;margin:18px 0 4px">最近任务 <span style="font-size:11px;color:#879083">' + tasks.length + ' 条</span></h3>' +
      (tasks.length ? tasks.slice(0, 12).map(taskRow).join('') : '<p class="platform-note">完成一次对话后，这里会记录计划、用到的工具和产出。</p>') +

      '<div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">' +
      '<button id="mem-clear-profile">清空长期画像</button>' +
      '<button id="mem-clear-tasks">清空任务记录</button>' +
      '</div>';

    const feedback = text => { const el = $('#mem-feedback'); if (el) el.textContent = text; };

    $('#mem-import').onclick = async () => {
      try {
        const r = await ZX.api('memory/profile/import', {sessionId: session.id});
        feedback('已存入，共 ' + r.facts.length + ' 条画像');
        await refresh();
      } catch (e) { feedback(e.message); }
    };

    $('#mem-add').onsubmit = async e => {
      e.preventDefault();
      try {
        await ZX.api('memory/profile', {key: $('#mem-key').value, value: $('#mem-value').value, source: '手动添加'});
        await refresh();
      } catch (err) { feedback(err.message); }
    };

    document.querySelectorAll('[data-mem-delete]').forEach(btn => {
      btn.onclick = async () => {
        try { await ZX.api('memory/profile/delete', {id: btn.dataset.memDelete}); await refresh(); }
        catch (e) { feedback(e.message); }
      };
    });

    $('#mem-clear-profile').onclick = async () => {
      if (!confirm('清空长期画像？删除后不可恢复。')) return;
      try { await ZX.api('memory/profile/clear', {}); await refresh(); } catch (e) { feedback(e.message); }
    };
    $('#mem-clear-tasks').onclick = async () => {
      if (!confirm('清空任务记录？')) return;
      try { await ZX.api('memory/tasks/clear', {}); await refresh(); } catch (e) { feedback(e.message); }
    };
  }

  async function refresh() { render(await load()); }

  async function show() {
    await refresh();
    if (!$('#dialog').open) $('#dialog').showModal();
  }

  function mount() {
    const button = $('#memory');
    if (!button) return;
    button.textContent = '记忆与画像';
    button.onclick = () => show().catch(e => ZX.showError?.(e.message));
  }

  mount();
})();
