// 工作流抽屉：顶栏「工作流 · N」徽标 + 右侧抽屉（手机底部 72vh）。
// 渲染函数不碰 document，可以直接在 Node 里测；mount() 才在浏览器里接管页面元素。
//
// 与页面其它模块一样在运行时注入 DOM，不重写 index.html 的结构（ui-model.js 也是这么加侧栏入口的）。

export const STATE_LABELS = {
  queued: '排队中',
  running: '运行中',
  waiting_confirmation: '待确认',
  blocked: '已阻塞',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  undone: '已撤销'
};

export const GROUPS = [
  {key: 'running', label: '运行中', states: ['running']},
  {key: 'queued', label: '排队中', states: ['queued']},
  {key: 'confirm', label: '待确认', states: ['waiting_confirmation', 'blocked']},
  {key: 'done', label: '已完成', states: ['succeeded', 'undone']},
  {key: 'failed', label: '失败与取消', states: ['failed', 'cancelled']}
];

export const ACTIVE_STATES = new Set(['queued', 'running', 'waiting_confirmation', 'blocked']);

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));
}

function oneLine(value, max = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function clock(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes ? minutes + ' 分 ' + String(seconds).padStart(2, '0') + ' 秒' : seconds + ' 秒';
}

// 徽标只计「运行中 + 待确认」；排队与已结束都不算。
export function badgeCount(tasks) {
  return (Array.isArray(tasks) ? tasks : []).filter(task => task?.state === 'running' || task?.state === 'waiting_confirmation').length;
}

export function groupTasks(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  return GROUPS
    .map(group => ({...group, tasks: list.filter(task => group.states.includes(task?.state))}))
    .filter(group => group.tasks.length > 0);
}

function toneOf(state) {
  if (state === 'running') return 'running';
  if (state === 'queued' || state === 'waiting_confirmation' || state === 'blocked') return 'confirm';
  if (state === 'succeeded' || state === 'undone') return 'done';
  return 'failed';
}

function evidenceHtml(task) {
  const evidence = Array.isArray(task.evidence) ? task.evidence : [];
  const head = '<summary>证据（' + evidence.length + '）</summary>';
  if (!evidence.length) {
    return '<details class="more" data-key="evidence-' + esc(task.id) + '">' + head +
      '<div class="task-line muted">还没有证据：读取到的页面、截图或来源会留在这里。</div></details>';
  }
  const items = evidence.map(item => {
    const name = '<b>' + esc(oneLine(item.name || item.kind || '证据', 60)) + '</b>';
    const note = [];
    if (item.bytes) note.push(Math.max(1, Math.round(item.bytes / 1024)) + 'KB');
    if (item.count) note.push(item.count + ' 条');
    if (item.at) note.push(clock(item.at));
    const body = name + (note.length ? ' · ' + esc(note.join(' · ')) : '');
    if (typeof item.url === 'string' && /^https?:\/\//i.test(item.url)) {
      return '<a class="ev" href="' + esc(item.url) + '" target="_blank" rel="noopener noreferrer">🖼 ' + body + '</a>';
    }
    return '<span class="ev">📄 ' + body + '</span>';
  }).join('');
  return '<details class="more" data-key="evidence-' + esc(task.id) + '" open>' + head +
    '<div class="evidence">' + items + '</div></details>';
}

function draftHtml(task) {
  const draft = task.draft;
  if (!draft) return '<div class="draft muted">还没有草稿：完成一次对话后，文稿会留在任务卡里。</div>';
  const meta = [draft.chars ? draft.chars + ' 字' : '', draft.at ? clock(draft.at) : ''].filter(Boolean).join(' · ');
  return '<div class="draft"><b>草稿 · ' + esc(oneLine(draft.title || '文稿', 60)) + '</b>' +
    '<div class="trace">' + esc(meta || '等待预览') + '（只预览；写库在后续票）</div>' +
    '<div class="task-actions"><button class="wf-btn" type="button" data-task-draft="' + esc(task.id) + '">预览</button></div></div>';
}

export function renderTaskCard(task) {
  const state = task?.state || 'failed';
  const tone = toneOf(state);
  const id = esc(task?.id || '');
  const running = state === 'running';
  const percent = Math.max(0, Math.min(100, Number(task?.progress?.percent) || 0));
  let html = '<article class="task ' + tone + '" data-task="' + id + '" data-state="' + esc(state) + '">';
  html += '<div class="task-head"><span class="dot' + (running ? ' pulse' : '') + '"></span>' +
    '<div class="task-title">' + esc(oneLine(task?.title || '未命名任务', 80)) +
    (task?.sourceName ? '<small>' + esc(oneLine(task.sourceName, 40)) + '</small>' : '') + '</div>' +
    '<span class="task-state">' + esc(STATE_LABELS[state] || state) + '</span></div>';
  const meta = [];
  if (task?.backend) meta.push(esc(oneLine(task.backend, 60)));
  if (task?.startedAt && !task?.finishedAt) meta.push('开始 ' + esc(clock(task.startedAt)));
  if (task?.durationMs) meta.push(esc(formatDuration(task.durationMs)));
  if (task?.queuedMs > 1000 && !task?.startedAt) meta.push('排队 ' + esc(formatDuration(task.queuedMs)));
  meta.push(percent + '%');
  html += '<div class="task-meta">' + meta.map(item => '<span>' + item + '</span>').join('') + '</div>';
  html += '<div class="progress"><i style="width:' + percent + '%"></i></div>';
  html += '<div class="task-line">' + esc(oneLine(task?.progress?.text || STATE_LABELS[state] || '', 160)) + '</div>';
  if (ACTIVE_STATES.has(state)) {
    html += '<div class="task-actions"><button class="wf-btn" type="button" data-task-stop="' + id + '">停止</button></div>';
  }
  html += evidenceHtml(task);
  html += draftHtml(task);
  if (task?.error) {
    html += '<div class="fail-box"><b>' + esc(task.error.code || 'FAILED') + '</b>' +
      '<div>' + esc(oneLine(task.error.message || '', 400)) + '</div>' +
      (task.error.recovery ? '<div class="trace">恢复建议：' + esc(oneLine(task.error.recovery, 300)) + '</div>' : '') + '</div>';
  } else if (state === 'cancelled') {
    html += '<div class="task-line muted">' + esc(task?.stopReason === 'time_limit' ? '已到时间上限停止' : '已停止，未完成的部分不会写入') + '</div>';
  }
  return html + '</article>';
}

export function renderDrawer(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (!list.length) return '<div class="wf-empty">还没有任务。发一条消息，任务卡会出现在这里。</div>';
  const groups = groupTasks(list);
  if (!groups.length) return '<div class="wf-empty">还没有任务。</div>';
  return groups.map(group =>
    '<section class="task-group" data-group="' + group.key + '">' +
    '<h3 class="task-group-head">' + esc(group.label) + ' <span>' + group.tasks.length + '</span></h3>' +
    group.tasks.map(renderTaskCard).join('') +
    '</section>'
  ).join('');
}

const CSS = `
.wf-head-right{display:flex;align-items:center;gap:10px;font-size:11px;font-weight:400}
.wf-head-right .wf-tag{border:1px solid #dce9df;background:#eff6f0;color:#53816b;border-radius:30px;padding:4px 12px;font-size:10px;white-space:nowrap}
.wf-entry{display:inline-flex;align-items:center;gap:6px;border:1px solid #cfe0d5;background:#fff;color:#305c47;border-radius:30px;padding:5px 12px;font-size:11px;line-height:1.4;white-space:nowrap;cursor:pointer}
.wf-entry:hover{background:#f2f8f3}
.wf-entry:focus-visible{outline:2px solid #2f7a5d;outline-offset:2px}
.wf-badge{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;border-radius:20px;background:#176b55;color:#fff;font-size:10px;font-weight:600}
.wf-badge.zero{background:#dfe7e1;color:#6f8278}
.wf-scrim{position:fixed;inset:0;background:#172e2740;z-index:60;opacity:0;pointer-events:none;transition:opacity .18s}
body.wf-open .wf-scrim{opacity:1;pointer-events:auto}
.wf-drawer{position:fixed;top:0;right:0;bottom:0;width:400px;max-width:100%;background:#fbfcfb;border-left:1px solid #e4e8e5;z-index:70;transform:translateX(102%);transition:transform .22s ease;display:flex;flex-direction:column;box-shadow:-18px 0 50px #172e2722;overflow:hidden}
body.wf-open .wf-drawer{transform:none}
.wf-drawer-head{padding:16px 16px 10px;border-bottom:1px solid #e4e8e5;display:flex;flex-direction:column;gap:6px}
.wf-drawer-head .line{display:flex;align-items:center;gap:8px}
.wf-drawer-head h2{margin:0;font-size:15px}
.wf-drawer-head .x{margin-left:auto;border:0;background:none;font-size:19px;color:#7d8f83;line-height:1;cursor:pointer;padding:2px 6px}
.wf-drawer-head .wf-note{margin:0;font-size:10.5px;color:#7e8c85;line-height:1.7}
.wf-drawer-body{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:12px;min-width:0}
.wf-drawer-foot{border-top:1px solid #e4e8e5;padding:9px 14px;font-size:10px;color:#8b9a90}
.wf-empty{padding:26px 14px;text-align:center;font-size:12px;color:#8b9a90;line-height:1.9}
.task-group{display:flex;flex-direction:column;gap:8px;min-width:0}
.task-group-head{margin:4px 2px 0;font-size:10px;letter-spacing:1.5px;color:#8b9a90;font-weight:600;display:flex;justify-content:space-between}
.task{display:flex;flex-direction:column;gap:8px;border:1px solid #dde7e0;background:#fff;border-radius:14px;padding:13px 15px;min-width:0;overflow-wrap:anywhere}
.task.running{border-left:3px solid #176b55}
.task.confirm{border-left:3px solid #a8691f}
.task.done{border-left:3px solid #557f6c}
.task.failed{border-left:3px solid #a64232}
.task-head{display:flex;align-items:flex-start;gap:8px;min-width:0}
.dot{width:8px;height:8px;border-radius:50%;flex:0 0 8px;margin-top:7px;background:#176b55}
.dot.pulse{box-shadow:0 0 0 4px #176b5522;animation:wf-pulse 1.8s infinite}
@keyframes wf-pulse{50%{box-shadow:0 0 0 7px #176b550d}}
.task.confirm .dot{background:#a8691f}
.task.done .dot{background:#557f6c}
.task.failed .dot{background:#a64232}
.task-title{font-size:13.5px;font-weight:600;line-height:1.5;min-width:0;overflow-wrap:anywhere}
.task-title small{font-weight:400;color:#7e8c85;font-size:11px;margin-left:6px}
.task-state{margin-left:auto;font-size:10px;color:#5b7a68;background:#eef5ef;border-radius:20px;padding:2px 8px;white-space:nowrap;flex:0 0 auto}
.task.confirm .task-state{background:#fbf1e0;color:#8a5a17}
.task.failed .task-state{background:#fbebe7;color:#a64232}
.task-meta{display:flex;gap:10px;flex-wrap:wrap;font-size:10.5px;color:#7a8c81;min-width:0}
.progress{height:5px;border-radius:4px;background:#edf2ee;overflow:hidden}
.progress i{display:block;height:100%;background:linear-gradient(90deg,#2f8a68,#7bb79b);border-radius:4px;transition:width .25s ease}
.task-line{font-size:11.5px;color:#5c7165;overflow-wrap:anywhere}
.task-line.muted,.draft.muted{color:#8b9a90;font-size:11px}
.task-actions{display:flex;gap:6px;flex-wrap:wrap}
.wf-btn{border:1px solid #cfe0d5;background:#fff;border-radius:8px;padding:5px 10px;font-size:11px;color:#305c47;cursor:pointer}
.wf-btn:hover{background:#f2f8f3}
.wf-btn:disabled{opacity:.5;cursor:default}
details.more{border-top:1px dashed #e5ebe6;padding-top:6px}
details.more summary{cursor:pointer;font-size:11px;color:#6d8176;list-style:none}
details.more summary::-webkit-details-marker{display:none}
details.more summary:before{content:'▸ ';color:#93a69a}
details.more[open] summary:before{content:'▾ '}
.evidence{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.ev{border:1px solid #dde7e0;background:#fbfdfb;border-radius:8px;padding:4px 8px;font-size:10.5px;color:#4f6d5d;display:flex;gap:5px;align-items:center;max-width:100%;overflow-wrap:anywhere;text-decoration:none}
.ev b{font-weight:600;color:#2f5c47}
.draft{background:#f7faf7;border:1px solid #e0eae2;border-radius:10px;padding:10px 12px;font-size:11.5px;line-height:1.75;display:flex;flex-direction:column;gap:6px}
.draft b{font-size:12px;color:#274b3b}
.fail-box{background:#fdf3f0;border:1px solid #eed3cb;border-radius:10px;padding:10px 12px;font-size:11.5px;line-height:1.75;display:flex;flex-direction:column;gap:6px}
.fail-box b{font-size:12px;color:#8f3d2e}
@media(min-width:751px){
  body.wf-open main{margin-right:400px;transition:margin-right .22s ease}
  body.wf-open .wf-scrim{opacity:0;pointer-events:none}
}
@media(max-width:750px){
  header>div>span{display:none}
  .wf-head-right .wf-tag{display:none}
  .wf-drawer{top:auto;left:0;right:0;bottom:0;width:100%;height:72vh;max-height:72vh;border-left:0;border-top:1px solid #e4e8e5;border-radius:18px 18px 0 0;transform:translateY(102%)}
  body.wf-open .wf-drawer{transform:none}
  .wf-drawer-head{padding-top:10px}
  .wf-drawer-head:before{content:'';display:block;width:38px;height:4px;border-radius:4px;background:#d6e2da;margin:0 auto 6px}
  .wf-drawer-body{padding:10px 10px 16px}
  .task{padding:11px 12px}
  .wf-entry{font-size:10.5px;padding:4px 10px}
}
@media(prefers-reduced-motion:reduce){.wf-drawer,.wf-scrim,.progress i,body.wf-open main{transition:none!important}.dot.pulse{animation:none!important}}
`;

function injectStyle() {
  if (document.getElementById('wf-style')) return;
  const style = document.createElement('style');
  style.id = 'wf-style';
  style.textContent = CSS;
  document.head.appendChild(style);
}

function injectChrome() {
  const header = document.querySelector('main header') || document.querySelector('header');
  if (!header) return null;
  injectStyle();
  let entry = document.getElementById('wf-entry');
  if (!entry) {
    entry = document.createElement('button');
    entry.id = 'wf-entry';
    entry.type = 'button';
    entry.className = 'wf-entry';
    entry.setAttribute('aria-controls', 'wf-drawer');
    entry.setAttribute('aria-expanded', 'false');
    entry.innerHTML = '工作流 <span class="wf-badge zero" id="wf-badge">0</span>';
    let right = header.querySelector('.wf-head-right');
    if (!right) {
      right = document.createElement('div');
      right.className = 'wf-head-right';
      const tag = header.querySelector(':scope > span');
      if (tag) { tag.classList.add('wf-tag'); right.appendChild(tag); }
      header.appendChild(right);
    }
    right.appendChild(entry);
  }
  if (!document.getElementById('wf-drawer')) {
    const scrim = document.createElement('div');
    scrim.id = 'wf-scrim';
    scrim.className = 'wf-scrim';
    const drawer = document.createElement('section');
    drawer.id = 'wf-drawer';
    drawer.className = 'wf-drawer';
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-label', '工作流面板');
    drawer.setAttribute('aria-hidden', 'true');
    drawer.inert = true;
    drawer.innerHTML = '<div class="wf-drawer-head"><div class="line"><h2>工作流</h2><button class="x" id="wf-close" type="button" aria-label="关闭工作流">×</button></div>' +
      '<p class="wf-note">任务卡按状态分组；证据与草稿跟着任务走。审计明细与撤销在后续票（#29 / #31）。</p></div>' +
      '<div class="wf-drawer-body" id="wf-drawer-body"></div>' +
      '<div class="wf-drawer-foot">徽标只计「运行中 + 待确认」。</div>';
    document.body.append(scrim, drawer);
  }
  return entry;
}

function mount() {
  const ZX = window.__zx || {};
  if (!ZX.api) return;
  const entry = injectChrome();
  if (!entry) return;
  const badge = document.getElementById('wf-badge');
  const drawer = document.getElementById('wf-drawer');
  const list = document.getElementById('wf-drawer-body');
  const scrim = document.getElementById('wf-scrim');
  let tasks = [];
  let rendered = '';
  let inflight = null;
  let timer = null;

  function render() {
    if (badge) {
      const count = badgeCount(tasks);
      badge.textContent = String(count);
      badge.classList.toggle('zero', count === 0);
    }
    if (!list) return;
    const html = renderDrawer(tasks);
    if (html === rendered) return;
    const openKeys = new Set([...list.querySelectorAll('details[open]')].map(node => node.dataset.key).filter(Boolean));
    list.innerHTML = html;
    for (const node of list.querySelectorAll('details')) if (openKeys.has(node.dataset.key)) node.open = true;
    rendered = html;
  }

  function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const data = await ZX.api('tasks');
        if (Array.isArray(data?.tasks)) tasks = data.tasks;
        render();
      } catch { /* 未登录或接口不可用时保持现状 */ }
      finally { inflight = null; }
    })();
    return inflight;
  }

  function setOpen(open) {
    document.body.classList.toggle('wf-open', open);
    if (drawer) {
      drawer.setAttribute('aria-hidden', open ? 'false' : 'true');
      drawer.inert = !open;
    }
    entry.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) refresh();
  }

  entry.addEventListener('click', () => setOpen(!document.body.classList.contains('wf-open')));
  document.getElementById('wf-close')?.addEventListener('click', () => setOpen(false));
  if (scrim) scrim.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.body.classList.contains('wf-open')) setOpen(false);
  });

  list?.addEventListener('click', async event => {
    const stop = event.target.closest('[data-task-stop]');
    if (stop) {
      stop.disabled = true;
      try { await ZX.api('tasks/cancel', {id: stop.dataset.taskStop}); }
      catch (error) { ZX.showError?.(error.message); }
      finally { stop.disabled = false; refresh(); }
      return;
    }
    const draft = event.target.closest('[data-task-draft]');
    if (draft) {
      const task = tasks.find(item => item.id === draft.dataset.taskDraft);
      if (!task?.draft) return;
      try {
        const session = await ZX.api('session/' + encodeURIComponent(task.sessionId));
        const artifacts = Array.isArray(session?.artifacts) ? session.artifacts : [];
        const artifact = artifacts.find(item => item.id === task.draft.artifactId) || artifacts[artifacts.length - 1];
        if (!artifact) throw new Error('草稿已不在这个对话里，可能已被删除。');
        const dialog = document.querySelector('#dialog');
        const content = document.querySelector('#dialog-content');
        if (content) content.innerHTML = '<h2>' + esc(artifact.title || '草稿') + '</h2><pre>' + esc(artifact.content || '') + '</pre>';
        if (dialog && !dialog.open) dialog.showModal();
      } catch (error) { ZX.showError?.(error.message); }
    }
  });

  refresh();
  timer = setInterval(() => {
    if (document.visibilityState !== 'hidden') refresh();
  }, 1500);
  window.addEventListener('beforeunload', () => clearInterval(timer), {once: true});
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once: true});
  else mount();
}
