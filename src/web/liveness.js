// 任务失联提示：90 秒没有收到除心跳外的 NDJSON 事件，就标「可能失联」。
// 心跳不算进度；任何真实事件清掉提示。服务端不杀任务，任务可能仍在后台跑。
(function () {
  const TIMEOUT_MS = 90000;
  let lastActivityAt = Date.now();
  let timer = null;
  let stale = false;

  function hintElement() {
    let el = document.getElementById('liveness-hint');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'liveness-hint';
    el.className = 'liveness-hint';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.hidden = true;
    el.innerHTML = '<b>可能失联</b>：90 秒没有收到任务进度（心跳不算进度）。服务端没有杀任务，可能仍在后台运行；可以继续等待或点「停止」。';
    const status = document.getElementById('status');
    if (status && status.parentNode) status.parentNode.insertBefore(el, status);
    else document.querySelector('.composer-area')?.prepend(el);
    return el;
  }

  function turnActive() {
    const stop = document.getElementById('stop');
    return !!stop && stop.hidden === false;
  }

  function refreshHint() {
    hintElement().hidden = !stale;
  }

  // 每次真实进度都重排一个一次性计时器；到点只检查一次，不做高频轮询。
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(check, Math.max(0, lastActivityAt + TIMEOUT_MS - Date.now()));
  }

  function check() {
    timer = null;
    if (!turnActive()) {
      if (stale) { stale = false; refreshHint(); }
      return;
    }
    if (Date.now() - lastActivityAt < TIMEOUT_MS) return schedule();
    stale = true;
    refreshHint();
  }

  function activity() {
    lastActivityAt = Date.now();
    if (stale) { stale = false; refreshHint(); }
    if (turnActive()) schedule();
  }

  window.addEventListener('career:task', event => {
    const type = event?.detail?.type;
    if (!type || type === 'heartbeat') return;
    activity();
  });

  function watchTurnStart() {
    const stop = document.getElementById('stop');
    if (!stop || typeof MutationObserver !== 'function') return;
    new MutationObserver(() => { if (stop.hidden === false) activity(); }).observe(stop, {attributes: true, attributeFilter: ['hidden']});
  }

  function boot() {
    const style = document.createElement('style');
    style.textContent = '.liveness-hint{margin:0 0 10px;border:1px solid #e8d3a8;background:#fdf6e7;color:#6b4f17;border-radius:10px;padding:7px 10px;font-size:11px;line-height:1.7;overflow-wrap:anywhere}.liveness-hint b{font-size:12px}';
    document.head.appendChild(style);
    hintElement();
    watchTurnStart();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, {once: true});
  else boot();
})();
