// 对话生成的文稿可以一键保存到简历库（用户点击即确认）。
(function () {
  const ZX = window.__zx || {};

  document.addEventListener('click', async event => {
    const button = event.target.closest('#save-resume');
    if (!button) return;
    const session = ZX.currentSession?.();
    if (!session?.id) { ZX.showError?.('请先打开一个对话'); return; }
    button.disabled = true;
    const original = button.textContent;
    button.textContent = '保存中…';
    try {
      await ZX.api('resumes/from-session', {sessionId: session.id});
      button.textContent = '已保存 ✓';
      setTimeout(() => { location.href = '/resume'; }, 600);
    } catch (e) {
      button.textContent = original;
      ZX.showError?.(e.message);
    } finally {
      button.disabled = false;
    }
  });
})();
