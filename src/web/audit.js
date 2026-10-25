// 审计审阅层：抽屉之上的独立层。批次新→旧，桌面两栏（左批次右 diff）、手机全屏列表→详情。
// 计数与逐行结果只渲染后端返回的字段；前端不自己算撤销成功数。
const zx = window.__zx || {};
const $ = selector => document.querySelector(selector);
const escape = zx.escape || (value => String(value ?? ''));

const TOOL_LABELS = {career_recruit_bulk_write: '招聘活动批量写入', career_profile_write: '写入长期画像'};
const ENTITY_LABELS = {events: '招聘活动', event_projects: '招聘项目', profile_facts: '长期画像'};
const ACTION_LABELS = {create: '新建', update: '更新', delete: '删除', skip: '跳过'};
const RESULT_LABELS = {
  undone: '已撤销', applied: '已撤销', forced: '强制撤销', skipped_conflict: '冲突跳过',
  conflict: '冲突', ready: '待撤销', already_undone: '已撤销', failed: '失败'
};
const RESULT_CLASS = {
  undone: 'chip-undo', applied: 'chip-undo', forced: 'chip-forced', skipped_conflict: 'chip-conflict',
  conflict: 'chip-conflict', ready: 'chip-ready', already_undone: 'chip-undo', failed: 'chip-failed'
};
const REASONS = {
  created_row_missing: '写入后创建的行已被手工删除',
  created_row_changed: '创建的行已被手工修改',
  updated_row_missing: '写入后更新的行已被手工删除',
  updated_row_changed: '更新的行已被手工修改',
  deleted_row_recreated: '被删除的行已被手工重建且内容不同',
  unsupported_entity: '这个实体还不支持撤销',
  unsupported_action: '这个审计动作不支持撤销',
  already_undone: '这一行已经撤销过'
};

const state = {
  open: false, scope: 'task', taskId: '', batchId: '', all: false,
  batches: [], preview: null, previewByEvent: new Map(), selectedBatchId: '',
  results: new Map(), summary: null, error: '', mobileDetail: false, busy: false, force: null
};

let els = null;

function isMobile() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(max-width:750px)').matches;
}

function toolLabel(name) { return TOOL_LABELS[name] || name || '自动写入'; }
function entityLabel(name) { return ENTITY_LABELS[name] || name || '数据行'; }
function timeLabel(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'});
}
function shortId(id) { return String(id || '').slice(0, 8); }

function cell(value) {
  if (value === null || value === undefined || value === '') return '<em>—</em>';
  if (typeof value === 'object') return escape(JSON.stringify(value));
  const text = String(value);
  return escape(text.length > 500 ? text.slice(0, 500) + '…' : text);
}

function pretty(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

function isUndoBatch(batch) {
  return (batch.rows || []).some(row => row.undoOf);
}

function previewFor(batchId) {
  return state.preview?.batches?.find(batch => batch.batchId === batchId) || null;
}

function resultFor(row) {
  if (row.undoOf) return {result: row.result || 'applied', from: 'audit'};
  const current = state.results.get(row.eventId);
  if (current) return {result: current.result, from: 'undo', data: current};
  const preview = state.previewByEvent.get(row.eventId);
  if (preview) return {result: preview.result, from: 'preview', data: preview};
  return null;
}

function chip(result) {
  if (!result || !result.result) return '';
  const label = RESULT_LABELS[result.result] || result.result;
  const cls = RESULT_CLASS[result.result] || '';
  return '<span class="audit-chip ' + cls + '" data-result="' + escape(result.result) + '">' + escape(label) + '</span>';
}

function diffTable(oldValues, newValues) {
  const keys = [...new Set([...Object.keys(oldValues || {}), ...Object.keys(newValues || {})])];
  if (!keys.length) return '';
  const rows = keys.map(key => '<tr data-field="' + escape(key) + '"><td class="audit-field">' + escape(key) +
    '</td><td class="audit-old">' + cell(oldValues?.[key]) +
    '</td><td class="audit-new">' + cell(newValues?.[key]) + '</td></tr>').join('');
  return '<table class="audit-diff"><thead><tr><th>字段</th><th>旧值</th><th>新值</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

function conflictBlock(preview) {
  if (!preview || preview.result !== 'conflict') return '';
  const reason = REASONS[preview.reason] || preview.reason || '当前值已变化';
  const changed = Array.isArray(preview.changed) && preview.changed.length ? '：' + preview.changed.join('、') : '：' + reason;
  return '<div class="audit-conflict-inline"><span class="audit-chip chip-conflict">冲突</span> ' + escape(reason + changed) +
    '<div class="audit-force-pair" style="margin-top:6px"><span>当前值</span><pre>' + escape(pretty(preview.current)) + '</pre></div>' +
    '<div class="audit-force-pair"><span>写回值</span><pre>' + escape(pretty(preview.desired)) + '</pre></div></div>';
}

function renderBatches() {
  if (!state.batches.length) return '<p class="audit-empty">还没有审计批次。自动写入发生后会出现在这里。</p>';
  const hint = state.all ? '<p class="audit-batches-hint">全部审计 · 只读总览</p>' : '';
  const cards = state.batches.map(batch => {
    const preview = previewFor(batch.batchId);
    const undoBatch = isUndoBatch(batch);
    const counts = batch.counts || {};
    const chips = [];
    if (undoBatch) chips.push('<span class="audit-chip chip-undo">撤销记录</span>');
    else if (preview?.counts?.conflicts) chips.push('<span class="audit-chip chip-conflict">冲突 ' + preview.counts.conflicts + '</span>');
    else if (preview?.counts?.ready) chips.push('<span class="audit-chip chip-ready">待撤销 ' + preview.counts.ready + '</span>');
    else if (preview?.counts?.rows) chips.push('<span class="audit-chip chip-undo">已撤销</span>');
    const disabled = undoBatch || !preview || (Number(preview.counts?.ready) || 0) + (Number(preview.counts?.conflicts) || 0) === 0;
    const meta = (batch.rows || []).length + ' 行 · 新建 ' + (Number(counts.create) || 0) + ' · 更新 ' + (Number(counts.update) || 0) + ' · 删除 ' + (Number(counts.delete) || 0);
    return '<div class="audit-batch" role="button" tabindex="0" data-batch-id="' + escape(batch.batchId) + '" data-undo-batch="' + (undoBatch ? 'true' : 'false') + '" aria-selected="' + (batch.batchId === state.selectedBatchId ? 'true' : 'false') + '">' +
      '<div class="audit-batch-head"><b>' + escape(undoBatch ? '撤销记录' : toolLabel(batch.tool)) + '</b><small>' + escape(timeLabel(batch.occurredAt)) + '</small></div>' +
      '<div class="audit-batch-meta">' + escape(meta) + ' ' + chips.join(' ') + '</div>' +
      '<div class="audit-batch-actions"><button type="button" data-batch-undo="' + escape(batch.batchId) + '"' + (disabled ? ' disabled' : '') + '>撤销这一批</button></div>' +
      '</div>';
  }).join('');
  return hint + cards;
}

function renderRows(batch) {
  return (batch.rows || []).map(row => {
    const result = resultFor(row);
    const preview = result?.from === 'preview' ? result.data : null;
    const label = (ACTION_LABELS[row.action] || row.action) + ' · ' + entityLabel(row.entity);
    const raw = JSON.stringify({eventId: row.eventId, action: row.action, oldValues: row.oldValues, newValues: row.newValues}, null, 2);
    return '<div class="audit-row" data-event-id="' + escape(row.eventId) + '" data-result="' + escape(result?.result || '') + '">' +
      '<div class="audit-row-head"><b>' + escape(label) + '</b><small>' + escape(shortId(row.entityId)) + '</small>' + chip(result) + '</div>' +
      (row.undoOf ? '<small class="audit-detail-note">撤销自 ' + escape(shortId(row.undoOf)) + (row.note ? ' · ' + escape(row.note) : '') + '</small>' : '') +
      diffTable(row.oldValues, row.newValues) +
      conflictBlock(preview) +
      '<details class="audit-raw"><summary>原始 JSON</summary><pre>' + escape(raw) + '</pre></details>' +
      '</div>';
  }).join('');
}

function renderDetail() {
  const batch = state.batches.find(item => item.batchId === state.selectedBatchId) || state.batches[0];
  if (!batch) return '<p class="audit-empty">选择左侧一个批次查看旧值与新值。</p>';
  const preview = previewFor(batch.batchId);
  const undoBatch = isUndoBatch(batch);
  const remaining = (Number(preview?.counts?.ready) || 0) + (Number(preview?.counts?.conflicts) || 0);
  const action = !undoBatch && remaining > 0
    ? '<button type="button" data-detail-undo="' + escape(batch.batchId) + '">撤销这一批</button>'
    : '';
  return '<h3>' + escape(undoBatch ? '撤销记录' : toolLabel(batch.tool)) + ' · ' + escape(timeLabel(batch.occurredAt)) + '</h3>' +
    '<p class="audit-detail-note">批次 ' + escape(batch.batchId) + ' · ' + (batch.taskId ? '任务 ' + escape(shortId(batch.taskId)) : '未关联任务') + '</p>' +
    renderRows(batch) +
    (action ? '<div class="audit-actions">' + action + '</div>' : '');
}

function summaryHtml() {
  if (state.error) return '<span class="task-error" role="alert">' + escape(state.error) + '</span>';
  if (state.summary) {
    const counts = state.summary.counts || {};
    return '已撤销 ' + (Number(counts.undone) || 0) + ' / 冲突 ' + (Number(counts.conflicts) || 0) + ' / 失败 ' + (Number(counts.failed) || 0) +
      (Number(counts.forced) ? ' <span class="audit-chip chip-forced">强制 ' + Number(counts.forced) + '</span>' : '');
  }
  if (state.scope === 'all') return '全部审计共 ' + state.batches.length + ' 个批次（只读总览）。';
  const counts = state.preview?.counts || {};
  if (!counts.rows) return '当前范围没有可撤销的自动写入。';
  return '待撤销 ' + (Number(counts.ready) || 0) + ' 行 · 冲突 ' + (Number(counts.conflicts) || 0) + ' · 已撤销 ' + (Number(counts.already) || 0);
}

function forceTargets() {
  return [...state.previewByEvent.values()].filter(item => item.result === 'conflict');
}

function render() {
  if (!els) return;
  els.scope.textContent = state.scope === 'all' ? '全部审计 · 只读总览' : state.scope === 'batch' ? '单批 · ' + shortId(state.batchId) : '本任务 · ' + shortId(state.taskId);
  els.allToggle.setAttribute('aria-pressed', state.all ? 'true' : 'false');
  els.summary.hidden = false;
  els.summary.innerHTML = summaryHtml();
  els.batches.innerHTML = renderBatches();
  els.detail.innerHTML = renderDetail();
  const conflicts = state.scope === 'all' ? 0 : Number(state.preview?.counts?.conflicts) || 0;
  els.conflictBar.hidden = conflicts <= 0;
  if (conflicts > 0) {
    els.conflictBar.innerHTML = '<span>有 ' + conflicts + ' 行已被手工修改，默认撤销会跳过它们。</span><button type="button" data-force-open>强制撤销冲突 ' + conflicts + ' 条</button>';
  }
  els.layer.classList.toggle('show-detail', isMobile() && state.mobileDetail);
}

function selectBatch(batchId) {
  state.selectedBatchId = batchId;
  state.mobileDetail = isMobile();
  render();
}

async function loadData() {
  state.error = '';
  try {
    const auditPath = state.scope === 'all'
      ? 'audit?limit=50'
      : state.scope === 'task'
        ? 'audit?taskId=' + encodeURIComponent(state.taskId)
        : 'audit?batchId=' + encodeURIComponent(state.batchId);
    const previewPath = state.scope === 'all'
      ? ''
      : state.scope === 'task'
        ? 'audit/preview?taskId=' + encodeURIComponent(state.taskId)
        : 'audit/preview?batchId=' + encodeURIComponent(state.batchId);
    const [audit, preview] = await Promise.all([
      zx.api(auditPath),
      previewPath ? zx.api(previewPath).catch(error => ({error: error.message, batches: []})) : Promise.resolve(null)
    ]);
    state.batches = Array.isArray(audit.batches) ? audit.batches : [];
    state.preview = preview;
    state.previewByEvent = new Map();
    for (const batch of preview?.batches || []) {
      for (const row of batch.results || []) state.previewByEvent.set(row.eventId, row);
    }
    if (!state.batches.some(batch => batch.batchId === state.selectedBatchId)) {
      state.selectedBatchId = state.batches[0]?.batchId || '';
    }
    if (state.scope === 'batch' && state.batches[0]) {
      state.taskId = state.batches[0].taskId || '';
    }
  } catch (error) {
    state.error = '审计读取失败：' + error.message;
    state.batches = [];
    state.preview = null;
    state.previewByEvent = new Map();
  }
}

function openLayer() {
  mount();
  els.layer.hidden = false;
  document.body.classList.add('audit-open');
  state.open = true;
}

function close() {
  if (!els) return;
  state.open = false;
  state.busy = false;
  state.force = null;
  els.layer.hidden = true;
  els.layer.classList.remove('show-detail');
  document.body.classList.remove('audit-open');
  // 关闭后回到抽屉；抽屉保持/恢复打开。
  if (window.__workflow?.open) window.__workflow.open();
  document.querySelector('#workflow-close')?.focus();
}

async function openTask(taskId) {
  mount();
  state.open = true;
  state.scope = 'task';
  state.all = false;
  state.taskId = String(taskId || '');
  state.batchId = '';
  state.selectedBatchId = '';
  state.results = new Map();
  state.summary = null;
  state.preview = null;
  state.previewByEvent = new Map();
  state.mobileDetail = false;
  state.error = '';
  openLayer();
  render();
  await loadData();
  render();
}

async function openBatch(batchId) {
  mount();
  state.open = true;
  state.scope = 'batch';
  state.all = false;
  state.batchId = String(batchId || '');
  state.taskId = '';
  state.selectedBatchId = state.batchId;
  state.results = new Map();
  state.summary = null;
  state.preview = null;
  state.previewByEvent = new Map();
  state.mobileDetail = false;
  state.error = '';
  openLayer();
  render();
  await loadData();
  render();
}

async function openAll() {
  mount();
  state.open = true;
  state.scope = 'all';
  state.all = true;
  state.taskId = '';
  state.batchId = '';
  state.selectedBatchId = '';
  state.results = new Map();
  state.summary = null;
  state.preview = null;
  state.previewByEvent = new Map();
  state.mobileDetail = false;
  state.error = '';
  openLayer();
  render();
  await loadData();
  render();
}

async function toggleAll() {
  if (state.all) {
    const back = state.returnTo;
    state.returnTo = null;
    if (back?.scope === 'batch' && back.batchId) await openBatch(back.batchId);
    else if (back?.taskId) await openTask(back.taskId);
    else if (back?.batchId) await openBatch(back.batchId);
    else {
      state.all = false;
      state.scope = 'task';
      await loadData();
      render();
    }
  } else {
    state.returnTo = {scope: state.scope, taskId: state.taskId, batchId: state.batchId};
    await openAll();
  }
}

function back() {
  if (isMobile() && state.mobileDetail) {
    state.mobileDetail = false;
    els.layer.classList.remove('show-detail');
    render();
    return;
  }
  close();
}

async function runUndo({scope, batchId, taskId, force = false} = {}) {
  if (state.busy) return null;
  state.busy = true;
  state.error = '';
  const previous = state.summary;
  render();
  try {
    const out = scope === 'batch'
      ? await zx.api('audit/undo/batch', {batchId, force})
      : await zx.api('audit/undo/task', {taskId, force});
    state.summary = {counts: out.counts || {}, force: !!force, scope};
    const results = scope === 'batch'
      ? (out.results || [])
      : (out.batches || []).flatMap(batch => batch.results || []);
    state.results = new Map(results.filter(row => row.eventId).map(row => [row.eventId, row]));
    if (window.__workflow?.refresh) await window.__workflow.refresh().catch(() => {});
    await loadData();
    render();
    return out;
  } catch (error) {
    state.summary = previous;
    state.error = '撤销失败：' + error.message;
    render();
    return null;
  } finally {
    state.busy = false;
  }
}

function forceBody(targets) {
  const items = targets.slice(0, 8).map(item => {
    const label = entityLabel(item.entity) + ' · ' + shortId(item.entityId);
    return '<div class="audit-force-item" data-force-event="' + escape(item.eventId) + '">' +
      '<b>' + escape(label) + '</b>' +
      '<div class="audit-force-pair"><span>当前值</span><pre>' + escape(pretty(item.current)) + '</pre></div>' +
      '<div class="audit-force-pair"><span>写回值</span><pre>' + escape(pretty(item.desired)) + '</pre></div>' +
      '<p>后果：这一行的当前内容会被写回值覆盖；撤销会作为一次新的写入记入审计，无法从界面恢复。</p>' +
      '</div>';
  }).join('');
  return '<p class="audit-force-warning">强制撤销会覆盖你后来手工修改的内容。</p>' + items + (targets.length > 8 ? '<p class="audit-force-warning">还有 ' + (targets.length - 8) + ' 行冲突，只展示前 8 行。</p>' : '');
}

function showForce() {
  const targets = forceTargets();
  if (!targets.length) {
    state.error = '没有需要强制撤销的冲突行。';
    render();
    return false;
  }
  const scope = state.scope === 'batch' ? 'batch' : 'task';
  state.force = scope === 'batch'
    ? {scope, batchId: state.selectedBatchId || state.batchId}
    : {scope, taskId: state.taskId};
  els.forceBody.innerHTML = forceBody(targets);
  if (typeof els.dialog.showModal === 'function' && !els.dialog.open) els.dialog.showModal();
  return true;
}

async function confirmForce() {
  const target = state.force;
  if (!target) return;
  try { els.dialog.close(); } catch { /* 已关闭 */ }
  await runUndo({...target, force: true});
}

function errorText(error) {
  return error?.message || String(error || '');
}

function mount() {
  if (els) return;
  const layer = document.createElement('div');
  layer.id = 'audit-layer';
  layer.hidden = true;
  layer.setAttribute('role', 'dialog');
  layer.setAttribute('aria-modal', 'true');
  layer.setAttribute('aria-label', '审计审阅');
  layer.innerHTML = '<div class="audit-shell">' +
    '<div class="audit-head">' +
    '<button id="audit-back" type="button" aria-label="返回工作流">←<span class="audit-back-label"> 返回工作流</span></button>' +
    '<div class="audit-title"><strong>审计审阅</strong><small id="audit-scope"></small></div>' +
    '<button id="audit-all-toggle" type="button" aria-pressed="false" title="全部审计">全部审计</button>' +
    '<button id="audit-close" type="button" aria-label="关闭审计审阅">×</button>' +
    '</div>' +
    '<div id="audit-summary" class="audit-summary" role="status" hidden></div>' +
    '<div class="audit-main"><div class="audit-batches" id="audit-batches"></div><div class="audit-detail" id="audit-detail"></div></div>' +
    '<div id="audit-conflict-bar" class="audit-conflict-bar" hidden></div>' +
    '</div>';
  document.body.append(layer);

  const dialog = document.createElement('dialog');
  dialog.id = 'audit-force-dialog';
  dialog.setAttribute('aria-label', '强制撤销确认');
  dialog.innerHTML = '<div class="audit-force-form"><h3>强制撤销并覆盖</h3><div id="audit-force-body"></div>' +
    '<div class="audit-force-actions"><button type="button" data-force-cancel>取消</button><button type="button" data-force-confirm>强制撤销并覆盖</button></div></div>';
  document.body.append(dialog);

  els = {
    layer,
    scope: $('#audit-scope'),
    allToggle: $('#audit-all-toggle'),
    summary: $('#audit-summary'),
    batches: $('#audit-batches'),
    detail: $('#audit-detail'),
    conflictBar: $('#audit-conflict-bar'),
    dialog,
    forceBody: $('#audit-force-body')
  };

  $('#audit-back').addEventListener('click', back);
  $('#audit-close').addEventListener('click', close);
  $('#audit-all-toggle').addEventListener('click', () => { toggleAll(); });
  layer.addEventListener('click', async event => {
    const forceOpen = event.target.closest('[data-force-open]');
    if (forceOpen) { showForce(); return; }
    const batchUndo = event.target.closest('[data-batch-undo]');
    if (batchUndo && !batchUndo.disabled) {
      event.stopPropagation();
      await runUndo({scope: 'batch', batchId: batchUndo.dataset.batchUndo});
      return;
    }
    const detailUndo = event.target.closest('[data-detail-undo]');
    if (detailUndo) {
      await runUndo({scope: 'batch', batchId: detailUndo.dataset.detailUndo});
      return;
    }
    const batchCard = event.target.closest('[data-batch-id]');
    if (batchCard) selectBatch(batchCard.dataset.batchId);
  });
  layer.addEventListener('keydown', event => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-batch-id]')) {
      event.preventDefault();
      selectBatch(event.target.dataset.batchId);
    }
  });
  dialog.querySelector('[data-force-cancel]').addEventListener('click', () => { try { dialog.close(); } catch { /* 已关闭 */ } });
  dialog.querySelector('[data-force-confirm]').addEventListener('click', confirmForce);
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !state.open) return;
    if (dialog.open) { try { dialog.close(); } catch { /* 已关闭 */ } return; }
    close();
  });
}

async function openForceTask(taskId) {
  await openTask(taskId);
  if (state.open) showForce();
}

mount();

window.__audit = {
  openTask,
  openBatch,
  openAll,
  openForceTask,
  close,
  refresh: () => state.open ? loadData().then(render) : null,
  errorText: errorText
};
