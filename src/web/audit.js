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

// 「全部审计」的筛选条件：与后端 /api/audit 查询参数同名，界面不自己过滤、不自己算计数。
const FILTER_KEYS = ['from', 'to', 'actorType', 'actorRef', 'tool', 'entity', 'taskId'];
const CLEAR_PHRASE = '清空我的审计';

function emptyFilters() {
  return {from: '', to: '', actorType: '', actorRef: '', tool: '', entity: '', taskId: ''};
}

const state = {
  open: false, scope: 'task', taskId: '', batchId: '', all: false,
  batches: [], preview: null, previewByEvent: new Map(), selectedBatchId: '',
  results: new Map(), summary: null, error: '', mobileDetail: false, busy: false, force: null,
  filters: emptyFilters(), auditCounts: {batches: 0, rows: 0}, lastClearedAt: '', clearPhrase: CLEAR_PHRASE,
  notice: '', exporting: false, clearing: false
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

const ACTOR_OPTIONS = [['', '全部'], ['model', '模型'], ['model_api', '模型 API（来源校对）'], ['agent', '外部 Agent'], ['user', '用户']];
const ENTITY_OPTIONS = [['', '全部'], ['events', '招聘活动'], ['event_projects', '招聘项目'], ['profile_facts', '长期画像']];

function optionList(options, selected) {
  return options.map(([value, label]) => '<option value="' + escape(value) + '"' + (value === selected ? ' selected' : '') + '>' + escape(label) + '</option>').join('');
}

// 工具栏只在「全部审计」里出现；任务/单批视图保持 #31 的原样，不混入跨任务动作。
function toolbarHtml() {
  const f = state.filters;
  return '<div class="audit-toolbar" role="group" aria-label="全部审计筛选、导出与清空">' +
    '<div class="audit-toolbar-filters">' +
    '<label class="audit-filter"><span>从</span><input type="datetime-local" id="audit-filter-from" value="' + escape(f.from) + '"></label>' +
    '<label class="audit-filter"><span>到</span><input type="datetime-local" id="audit-filter-to" value="' + escape(f.to) + '"></label>' +
    '<label class="audit-filter"><span>发起者</span><select id="audit-filter-actor-type">' + optionList(ACTOR_OPTIONS, f.actorType) + '</select></label>' +
    '<label class="audit-filter"><span>发起者标识</span><input type="text" id="audit-filter-actor-ref" placeholder="api:mock / undo" value="' + escape(f.actorRef) + '"></label>' +
    '<label class="audit-filter"><span>工具</span><input type="text" id="audit-filter-tool" placeholder="工具名" value="' + escape(f.tool) + '"></label>' +
    '<label class="audit-filter"><span>实体</span><select id="audit-filter-entity">' + optionList(ENTITY_OPTIONS, f.entity) + '</select></label>' +
    '<label class="audit-filter"><span>任务 id</span><input type="text" id="audit-filter-task" placeholder="任务 id" value="' + escape(f.taskId) + '"></label>' +
    '</div>' +
    '<div class="audit-toolbar-actions">' +
    '<button type="button" data-audit-apply>应用筛选</button>' +
    '<button type="button" data-audit-reset>重置</button>' +
    '<button type="button" data-audit-export="json">导出 JSON</button>' +
    '<button type="button" data-audit-export="csv">导出 CSV</button>' +
    '<button type="button" class="audit-clear-open" data-audit-clear-open>清空我的审计</button>' +
    '</div>' +
    '<p class="audit-toolbar-meta" id="audit-toolbar-meta"></p>' +
    '</div>';
}

function filterQuery() {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) if (state.filters[key]) params.set(key, state.filters[key]);
  return params.toString();
}

function readFilterInputs() {
  const value = id => document.getElementById(id)?.value ?? '';
  return {
    from: value('audit-filter-from'),
    to: value('audit-filter-to'),
    actorType: value('audit-filter-actor-type'),
    actorRef: value('audit-filter-actor-ref').trim(),
    tool: value('audit-filter-tool').trim(),
    entity: value('audit-filter-entity'),
    taskId: value('audit-filter-task').trim()
  };
}

function renderToolbar() {
  if (!els) return;
  if (state.scope !== 'all') {
    if (els.toolbarSlot.childElementCount) els.toolbarSlot.replaceChildren();
    return;
  }
  if (!els.toolbarSlot.firstElementChild) els.toolbarSlot.innerHTML = toolbarHtml();
  const meta = document.getElementById('audit-toolbar-meta');
  if (!meta) return;
  const filtering = FILTER_KEYS.some(key => state.filters[key]);
  const parts = ['共 ' + (Number(state.auditCounts?.batches) || 0) + ' 个批次 / ' + (Number(state.auditCounts?.rows) || 0) + ' 行' + (filtering ? '（已筛选）' : '')];
  if (state.lastClearedAt) parts.push('上次清空 ' + timeLabel(state.lastClearedAt));
  if (state.clearPhrase) parts.push('清空需输入「' + state.clearPhrase + '」');
  meta.textContent = parts.join(' · ');
}

async function applyFilters() {
  if (!state.open || state.scope !== 'all') return;
  state.filters = readFilterInputs();
  state.notice = '';
  state.selectedBatchId = '';
  await loadData();
  render();
}

async function resetFilters() {
  if (!state.open || state.scope !== 'all') return;
  state.filters = emptyFilters();
  state.notice = '';
  state.selectedBatchId = '';
  els?.toolbarSlot.replaceChildren();
  await loadData();
  render();
}

function downloadName(response, format) {
  const disposition = response.headers.get('content-disposition') || '';
  const matched = /filename="([^"]+)"/.exec(disposition);
  return matched ? matched[1] : 'career-audit.' + format;
}

// 导出由服务端生成（内容类型/文件名/计数都在响应里），前端只负责触发下载并展示后端计数。
async function runExport(format) {
  if (!state.open || state.scope !== 'all' || state.exporting) return;
  state.exporting = true;
  state.error = '';
  state.notice = '';
  render();
  try {
    if (typeof zx.raw !== 'function') throw new Error('当前页面版本不支持直接下载，请刷新页面后重试。');
    // 导出与当前视图用同一个批次数上限，保证「导出的就是眼前这一份」。
    const params = new URLSearchParams(filterQuery());
    params.set('limit', '50');
    const response = await zx.raw('audit/export?format=' + encodeURIComponent(format) + '&' + params.toString());
    const name = downloadName(response, format);
    const countsHeader = response.headers.get('x-audit-counts') || '';
    let counts = null;
    try { counts = countsHeader ? JSON.parse(countsHeader) : null; } catch { counts = null; }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    state.notice = '已导出 ' + (counts ? (Number(counts.rows) || 0) + ' 行 / ' + (Number(counts.batches) || 0) + ' 个批次' : '当前筛选结果') + '（' + name + '）';
  } catch (error) {
    state.error = '导出失败：' + error.message;
  } finally {
    state.exporting = false;
    render();
  }
}

function openClear() {
  if (!state.open || state.scope !== 'all' || !els) return;
  const label = document.getElementById('audit-clear-phrase-label');
  if (label) label.textContent = state.clearPhrase;
  const input = document.getElementById('audit-clear-phrase');
  if (input) input.value = '';
  const confirm = document.querySelector('[data-clear-confirm]');
  if (confirm) confirm.disabled = true;
  const hint = document.getElementById('audit-clear-hint');
  if (hint) hint.textContent = '';
  if (typeof els.clearDialog.showModal === 'function' && !els.clearDialog.open) els.clearDialog.showModal();
  input?.focus();
}

// 工具栏与清空弹窗的样式跟 audit.js 一起走，避免改动 index.html 的长样式行。
function ensureAuditStyle() {
  if (document.getElementById('audit-global-style')) return;
  const style = document.createElement('style');
  style.id = 'audit-global-style';
  style.textContent = [
    '#audit-toolbar-slot{flex:0 0 auto;border-bottom:1px solid #e6ede8;background:#f7faf7;padding:9px 12px;min-width:0}',
    '#audit-toolbar-slot:empty{display:none}',
    '.audit-toolbar{display:flex;flex-direction:column;gap:7px;min-width:0}',
    '.audit-toolbar-filters{display:flex;flex-wrap:wrap;gap:6px;min-width:0}',
    '.audit-filter{display:flex;flex-direction:column;gap:2px;flex:1 1 118px;min-width:0;font-size:10px;color:#5f7b6b}',
    '.audit-filter input,.audit-filter select{width:100%;min-width:0;box-sizing:border-box;border:1px solid #d9e6dd;border-radius:7px;padding:4px 6px;font-size:11px;background:#fff;color:#253b30}',
    '.audit-toolbar-actions{display:flex;flex-wrap:wrap;gap:6px;min-width:0}',
    '.audit-toolbar-actions button{border:1px solid #d9e5dc;background:#fff;border-radius:8px;padding:5px 10px;font-size:11px;color:#3f6f57;white-space:nowrap}',
    '.audit-toolbar-actions button.audit-clear-open{border-color:#e3c6a8;color:#8a4f17}',
    '.audit-toolbar-meta{margin:0;font-size:10px;color:#8b9b91;line-height:1.6;word-break:break-word}',
    '#audit-clear-dialog{border:0;border-radius:14px;padding:0;width:min(440px,92vw);max-width:92vw;background:#fff;box-shadow:0 24px 70px #08211640}',
    '#audit-clear-dialog::backdrop{background:#0b1f1880}',
    '.audit-clear-form{padding:16px 18px;display:grid;gap:10px;min-width:0}',
    '.audit-clear-form h3{margin:0;font-size:14px;color:#8a4f17}',
    '.audit-clear-form p{margin:0;font-size:11px;color:#5f7b6b;line-height:1.7}',
    '.audit-clear-form label{display:grid;gap:4px;font-size:11px;color:#3f6f57;min-width:0}',
    '.audit-clear-form input{width:100%;min-width:0;box-sizing:border-box;border:1px solid #d9e6dd;border-radius:8px;padding:6px 8px;font-size:12px}',
    '#audit-clear-hint{margin:0;font-size:10px;color:#a33b2a;min-height:14px}',
    '@media (max-width:750px){#audit-toolbar-slot{padding:8px 9px}.audit-filter{flex-basis:calc(50% - 3px)}.audit-toolbar-actions button{flex:1 1 auto}}'
  ].join('\n');
  document.head.append(style);
}

async function confirmClear() {
  if (state.clearing) return;
  const input = document.getElementById('audit-clear-phrase');
  const phrase = String(input?.value || '').trim();
  const hint = document.getElementById('audit-clear-hint');
  if (phrase !== state.clearPhrase) {
    if (hint) hint.textContent = '请输入完整的「' + state.clearPhrase + '」。';
    return;
  }
  state.clearing = true;
  const confirm = document.querySelector('[data-clear-confirm]');
  if (confirm) confirm.disabled = true;
  try {
    const out = await zx.api('audit/clear', {phrase});
    try { els.clearDialog.close(); } catch { /* 已关闭 */ }
    const counts = out.counts || {};
    state.notice = '已清空 ' + (Number(counts.rows) || 0) + ' 条审计、' + (Number(counts.confirmations) || 0) + ' 条确认记录';
    state.lastClearedAt = out.lastClearedAt || '';
    state.summary = null;
    state.results = new Map();
    state.filters = emptyFilters();
    els?.toolbarSlot.replaceChildren();
    await loadData();
  } catch (error) {
    if (hint) hint.textContent = error.message;
  } finally {
    state.clearing = false;
    render();
  }
}

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
  if (state.scope === 'all') {
    const counts = state.auditCounts || {batches: state.batches.length, rows: state.batches.reduce((sum, batch) => sum + (batch.rows || []).length, 0)};
    const parts = ['全部审计 · ' + (Number(counts.batches) || 0) + ' 个批次 / ' + (Number(counts.rows) || 0) + ' 行（只读总览）'];
    if (state.notice) parts.push(state.notice);
    else if (state.lastClearedAt) parts.push('上次清空 ' + timeLabel(state.lastClearedAt));
    return parts.join(' · ');
  }
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
  renderToolbar();
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
      ? 'audit?limit=50' + (filterQuery() ? '&' + filterQuery() : '')
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
    if (state.scope === 'all') {
      state.auditCounts = audit.counts || {batches: state.batches.length, rows: state.batches.reduce((sum, batch) => sum + (batch.rows || []).length, 0)};
    }
    state.lastClearedAt = audit.lastClearedAt || '';
    state.clearPhrase = audit.clearPhrase || CLEAR_PHRASE;
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
  try { if (els.clearDialog?.open) els.clearDialog.close(); } catch { /* 已关闭 */ }
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
  // 每次进入跨任务视图从干净筛选开始，避免上一次的筛选悄悄影响导出与清空。
  state.filters = emptyFilters();
  state.notice = '';
  state.auditCounts = {batches: 0, rows: 0};
  els?.toolbarSlot.replaceChildren();
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
    '<div id="audit-toolbar-slot"></div>' +
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

  // 清空审计：必须原样输入指定短语；删的是本人全部审计与确认记录，不是当前筛选结果。
  const clearDialog = document.createElement('dialog');
  clearDialog.id = 'audit-clear-dialog';
  clearDialog.setAttribute('aria-label', '清空我的审计确认');
  clearDialog.innerHTML = '<div class="audit-clear-form"><h3>清空我的审计</h3>' +
    '<p>会删除你的全部审计记录与确认记录；幂等记录保留到 7 天 TTL，其他账号不受影响。清空后无法从界面恢复，建议先导出。</p>' +
    '<label>请输入「<b id="audit-clear-phrase-label"></b>」以确认<input type="text" id="audit-clear-phrase" autocomplete="off" spellcheck="false"></label>' +
    '<p id="audit-clear-hint" role="alert"></p>' +
    '<div class="audit-force-actions"><button type="button" data-clear-cancel>取消</button><button type="button" data-clear-confirm disabled>清空</button></div></div>';
  document.body.append(clearDialog);
  ensureAuditStyle();

  els = {
    layer,
    scope: $('#audit-scope'),
    allToggle: $('#audit-all-toggle'),
    summary: $('#audit-summary'),
    batches: $('#audit-batches'),
    detail: $('#audit-detail'),
    conflictBar: $('#audit-conflict-bar'),
    toolbarSlot: $('#audit-toolbar-slot'),
    dialog,
    forceBody: $('#audit-force-body'),
    clearDialog
  };

  $('#audit-back').addEventListener('click', back);
  $('#audit-close').addEventListener('click', close);
  $('#audit-all-toggle').addEventListener('click', () => { toggleAll(); });
  layer.addEventListener('click', async event => {
    if (event.target.closest('[data-audit-apply]')) { await applyFilters(); return; }
    if (event.target.closest('[data-audit-reset]')) { await resetFilters(); return; }
    const exportButton = event.target.closest('[data-audit-export]');
    if (exportButton) { await runExport(exportButton.dataset.auditExport); return; }
    if (event.target.closest('[data-audit-clear-open]')) { openClear(); return; }
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
  const clearInput = clearDialog.querySelector('#audit-clear-phrase');
  clearInput.addEventListener('input', () => {
    const confirm = clearDialog.querySelector('[data-clear-confirm]');
    if (confirm) confirm.disabled = String(clearInput.value || '').trim() !== state.clearPhrase;
  });
  clearDialog.querySelector('[data-clear-cancel]').addEventListener('click', () => { try { clearDialog.close(); } catch { /* 已关闭 */ } });
  clearDialog.querySelector('[data-clear-confirm]').addEventListener('click', confirmClear);
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !state.open) return;
    if (els.clearDialog?.open) { try { els.clearDialog.close(); } catch { /* 已关闭 */ } return; }
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
