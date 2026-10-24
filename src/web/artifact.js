// 对话生成的文稿可以一键保存：简历版本 / 面试准备（用户点击即确认）。
(function () {
  const ZX = window.__zx || {};
  const ACTIONS = {
    'save-resume': {path: 'resumes/from-session', redirect: '/resume'},
    'save-interview': {path: 'interviews/from-session', redirect: '/resume#interviews'}
  };

  document.addEventListener('click', async event => {
    const button = event.target.closest('#save-resume, #save-interview');
    if (!button) return;
    const action = ACTIONS[button.id];
    if (!action) return;
    const session = ZX.currentSession?.();
    if (!session?.id) { ZX.showError?.('请先打开一个对话'); return; }
    button.disabled = true;
    const original = button.textContent;
    button.textContent = '保存中…';
    try {
      await ZX.api(action.path, {sessionId: session.id});
      button.textContent = '已保存 ✓';
      setTimeout(() => { location.href = action.redirect; }, 600);
    } catch (e) {
      button.textContent = original;
      ZX.showError?.(e.message);
    } finally {
      button.disabled = false;
    }
  });
})();
