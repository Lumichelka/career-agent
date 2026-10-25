// 工作流抽屉：顶栏徽标 + 右侧/底部抽屉。数据只读 /api/tasks，动作走 /api/tasks/*。
// 后端只给状态与计数，前端不自己算「跑中 / 待确认」数量。
const zx = window.__zx || {};
const $ = selector => document.querySelector(selector);
const escape = zx.escape || (value => String(value ?? ''));

const STATE_LABELS = {
  queued: '排队中',
  running: '运行中',
  waiting_confirmation: '待确认',
  blocked: '受阻',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
  undone: '已撤销'
};

// 一张任务只进一个分组，避免同一张卡在抽屉里出现两次。
const GROUPS = [
  {id: 'running', label: '运行中'},
  {id: 'waiting', label: '待确认'},
  {id: 'drafts', label: '草稿'},
  {id: 'undo', label: '可撤销'},
  {id: 'failed', label: '失败'}
];

const state = {tasks: [], confirmations: [], counts: {}, badge: 0, open: false, error: '', confirmError: '', loaded: false};

// 敏感写入确认：待确认区展示脱敏预览与接受/拒绝；已处理记录并入审计区且不可撤销。
const TOOL_LABELS = {career_profile_write: '写入长期画像'};
const toolLabel = name => TOOL_LABELS[name] || name || '敏感写入';

function previewText(preview) {
  if (!preview) return '（没有可预览的内容）';
  if (Array.isArray(preview.facts)) return preview.facts.map(fact => (fact.key || '要点') + '：' + (fact.value ?? '')).join('\n');
  return JSON.stringify(preview, null, 1);
}

function expiryText(expiresAt) {
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'}) + ' 前有效';
}

const pendingFor = task => state.confirmations.filter(item => item.taskId === task.id && item.decision === 'pending' && !item.expired);
const decidedFor = task => state.confirmations.filter(item => item.taskId === task.id && item.decision !== 'pending');

function confirmationBlock(task) {
  const items = pendingFor(task);
  if (!items.length) return '';
  const rows = items.map(item => {
    const id = escape(item.confirmId);
    return '<div class="confirm-item" data-confirm-id="' + id + '">'
      + '<div class="confirm-head"><span class="confirm-tool">' + escape(toolLabel(item.tool)) + '</span><small class="confirm-expiry">' + escape(expiryText(item.expiresAt)) + '</small></div>'
      + '<pre class="confirm-preview">' + escape(previewText(item.preview)) + '</pre>'
      + '<div class="task-actions confirm-actions"><button type="button" data-confirm-action="accept" data-confirm-id="' + id + '">接受</button><button type="button" data-confirm-action="reject" data-confirm-id="' + id + '">拒绝</button></div>'
      + '</div>';
  }).join('');
  return '<section class="task-block task-confirm"><h5>待确认 · 敏感写入</h5>' + rows + '<p class="placeholder">接受后才会写入本机；拒绝不会留下业务数据，但会保留这次确认记录。</p></section>';
}

function confirmationAuditBlock(task) {
  const items = decidedFor(task);
  if (!items.length) return '';
  const rows = items.map(item => {
    const accepted = item.decision === 'accepted';
    const text = accepted ? '已接受 · 写入已记入审计' : '已拒绝 · 未写入';
    return '<li class="confirm-log-item" data-decision="' + escape(item.decision) + '"><span>' + escape(toolLabel(item.tool)) + '</span><small>' + escape(text) + '</small></li>';
  }).join('');
  return '<section class="task-block task-audit"><h5>审计 · 确认记录</h5><ul class="confirm-log">' + rows + '</ul><p class="placeholder">确认记录不可撤销；已写入的数据如需撤回，请在审计审阅层撤销。</p></section>';
}
let refreshing = null;
let pollTimer = null;

function groupOf(task) {
  if (task.state === 'queued' || task.state === 'running') return 'running';
  if (task.state === 'waiting_confirmation' || task.state === 'blocked') return 'waiting';
  if (task.state === 'failed' || task.state === 'cancelled') return 'failed';
  if ((task.drafts || []).some(draft => draft.status === 'draft')) return 'drafts';
  return 'undo';
}

function stateChip(task) {
  const label = STATE_LABELS[task.state] || task.state;
  return '<span class="task-state state-' + escape(task.state) + '">' + escape(label) + '</span>';
}

function evidenceBlock(task) {
  const items = task.evidence || [];
  const list = items.length
    ? '<ul>' + items.slice(-6).map(item => '<li>' + escape(item.label || item.kind || '证据') + '</li>').join('') + '</ul>'
    : '<p class="placeholder">暂无证据。工具调用与截图会记录在这里。</p>';
  return '<section class="task-block task-evidence"><h5>证据</h5>' + list + '</section>';
}

function draftBlock(task) {
  const drafts = task.drafts || [];
  const rows = drafts.length
    ? drafts.map(draft => {
        const title = '<span class="draft-title" title="' + escape(draft.title) + '">' + escape(draft.title) + '</span>';
        if (draft.status !== 'draft') return '<div class="draft-row">' + title + '<small>' + escape(draft.status === 'saved' ? '已保存' : '已丢弃') + '</small></div>';
        return '<div class="draft-row">' + title + '<div class="draft-actions"><button type="button" data-task-action="save" data-draft-id="' + escape(draft.id) + '">保存</button><button type="button" data-task-action="discard" data-draft-id="' + escape(draft.id) + '">丢弃</button></div></div>';
      }).join('')
    : '<p class="placeholder">暂无草稿。文稿类结果会挂在这里，不会变成新的助手消息。</p>';
  return '<section class="task-block task-drafts"><h5>草稿</h5>' + rows + '</section>';
}

function undoBlock(task) {
  const undo = task.undo;
  let text = '本次任务没有自动写入记录。';
  if (undo?.summary) text = undo.summary;
  else if (undo?.available === true) text = '可撤销 ' + (undo.count || 0) + ' 条自动写入。';
  else if (task.state === 'succeeded') text = '撤销摘要将在写入审计接入后显示。';
  else if (task.state === 'undone') text = '本次任务已撤销。';
  const button = '<button type="button" data-task-action="undo" disabled title="写网关与审计接入后可用">撤销本任务全部自动写入</button>';
  return '<section class="task-block task-undo"><h5>撤销摘要</h5><p class="placeholder">' + escape(text) + '</p><div class="task-actions">' + button + '</div></section>';
}

function card(task) {
  const counts = task.counts || {};
  const canStop = ['queued', 'running', 'waiting_confirmation', 'blocked'].includes(task.state);
  const error = task.error
    ? '<div class="task-error">' + escape(task.error.code ? task.error.code + ' · ' + task.error.message : task.error.message) + (task.error.recovery ? '（' + escape(task.error.recovery) + '）' : '') + '</div>'
    : '';
  const stop = canStop ? '<div class="task-actions"><button type="button" data-task-action="stop">停止任务</button></div>' : '';
  return '<article class="task-card" data-task-id="' + escape(task.id) + '" data-state="' + escape(task.state) + '">'
    + '<div class="task-card-head"><span class="task-source" title="' + escape(task.sourceName || '对话') + '">' + escape(task.sourceName || '对话') + '</span>' + stateChip(task) + '</div>'
    + '<h4>' + escape(task.title || '求职任务') + '</h4>'
    + '<p class="task-phase">' + escape(task.phase || '') + '</p>'
    + '<div class="task-meta">自动写入 ' + (Number(counts.writes) || 0) + ' 条 · 批次 ' + (Number(counts.batches) || 0) + ' · 工具 ' + (Number(counts.tools) || 0) + ' · 证据 ' + (Number(counts.evidence) || 0) + ' · 草稿 ' + (Number(counts.drafts) || 0) + '</div>'
    + error
    + confirmationBlock(task)
    + evidenceBlock(task)
    + draftBlock(task)
    + undoBlock(task)
    + confirmationAuditBlock(task)
    + stop
    + '</article>';
}

function render() {
  const count = $('#workflow-count');
  if (count) count.textContent = String(state.badge);
  const toggle = $('#workflow-toggle');
  if (toggle) {
    toggle.classList.toggle('has-active', state.badge > 0);
    toggle.setAttribute('aria-label', state.badge > 0 ? '工作流，' + state.badge + ' 个进行中任务' : '工作流，没有进行中的任务');
  }
  const summary = $('#workflow-summary');
  if (summary) summary.textContent = state.tasks.length + ' 个任务';
  const body = $('#workflow-body');
  if (!body) return;

  if (!state.tasks.length) {
    body.innerHTML = '<p class="workflow-empty">' + escape(state.error || '还没有任务。发起一次对话后，进度、证据与草稿会出现在这里。') + '</p>';
    return;
  }
  const confirmError = state.confirmError ? '<p class="task-error" role="alert">' + escape(state.confirmError) + '</p>' : '';
  body.innerHTML = confirmError + GROUPS.map(group => {
    const tasks = state.tasks.filter(task => groupOf(task) === group.id);
    const cards = tasks.length ? tasks.map(card).join('') : '<p class="placeholder">暂无</p>';
    return '<section class="workflow-group" data-group="' + group.id + '"><div class="workflow-group-head"><b>' + group.label + '</b><span class="workflow-group-count">' + tasks.length + '</span></div>' + cards + '</section>';
  }).join('');
}

async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const [data, confirmData] = await Promise.all([
        zx.api('tasks'),
        // 确认列表读失败不影响任务卡；待确认区只是少一块，不伪造记录。
        zx.api('confirmations?state=all').catch(() => null)
      ]);
      if (confirmData) {
        state.confirmations = Array.isArray(confirmData.confirmations) ? confirmData.confirmations : [];
        state.confirmError = '';
      }
      state.tasks = Array.isArray(data.tasks) ? data.tasks : [];
      state.counts = data.counts || {};
      state.badge = Number(data.badge) || 0;
      state.error = '';
      state.loaded = true;
      render();
    } catch (error) {
      // 未登录时静默；真正失败才在抽屉里说明。
      if (!/登录|401/.test(String(error.message))) state.error = '任务记录读取失败：' + error.message;
      render();
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

function schedulePoll(delay = 3000) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    await refresh();
    schedulePoll(state.badge > 0 ? 1500 : 5000);
  }, delay);
}

function setOpen(open) {
  state.open = !!open;
  document.body.classList.toggle('workflow-open', state.open);
  const toggle = $('#workflow-toggle');
  if (toggle) toggle.setAttribute('aria-expanded', String(state.open));
  const drawer = $('#workflow-drawer');
  if (drawer) drawer.setAttribute('aria-hidden', String(!state.open));
  const scrim = $('#workflow-scrim');
  if (scrim) scrim.hidden = !state.open;
  if (state.open) refresh();
  else toggle?.focus();
}

const toggle = $('#workflow-toggle');
if (toggle) toggle.addEventListener('click', () => setOpen(!state.open));
$('#workflow-close')?.addEventListener('click', () => setOpen(false));
$('#workflow-scrim')?.addEventListener('click', () => setOpen(false));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && state.open) setOpen(false);
});

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-task-action]');
  if (!button || button.disabled) return;
  const cardElement = button.closest('.task-card');
  const taskId = cardElement?.dataset.taskId;
  if (!taskId) return;
  const action = button.dataset.taskAction;
  button.disabled = true;
  try {
    if (action === 'stop') await zx.api('tasks/stop', {taskId});
    else if (action === 'save' || action === 'discard') await zx.api('tasks/draft', {taskId, draftId: button.dataset.draftId, action});
    await refresh();
  } catch (error) {
    state.error = error.message;
    render();
  } finally {
    button.disabled = false;
  }
});

// 待确认区的接受/拒绝：成功后刷新任务卡（任务会从待确认收尾，审计区出现确认记录）。
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-confirm-action]');
  if (!button || button.disabled) return;
  const action = button.dataset.confirmAction;
  if (action !== 'accept' && action !== 'reject') return;
  button.disabled = true;
  try {
    await zx.api('confirmations/' + action, {confirmId: button.dataset.confirmId});
    state.confirmError = '';
    await refresh();
  } catch (error) {
    state.confirmError = error.message;
    render();
  }
});

window.addEventListener('career:task', event => {
  const detail = event.detail || {};
  if (!['task', 'progress', 'evidence', 'error', 'done'].includes(detail.type)) return;
  clearTimeout(pollTimer);
  refresh().finally(() => schedulePoll(state.badge > 0 ? 1200 : 4000));
});

window.__workflow = {refresh, open: () => setOpen(true), close: () => setOpen(false), state: () => ({...state})};

refresh();
schedulePoll(3000);
