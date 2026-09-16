(() => {
  const T = (key, values) => window.I18n?.t(key, values) ?? key;
  const label = (node, key) => { node.setAttribute('data-i18n', key); node.textContent = T(key); };
  const buttons = [...document.querySelectorAll('[data-install-app]')];
  const standalone = window.matchMedia('(display-mode: standalone)');
  let installed = standalone.matches || navigator.standalone === true;
  let pending = null;
  const update = () => {
    for (const button of buttons) {
      button.hidden = installed;
      button.dataset.installReady = String(Boolean(pending));
    }
  };
  let help;
  function showHelp() {
    if (!help) {
      help = document.createElement('dialog'); help.className = 'pwa-dialog';
      help.setAttribute('aria-labelledby', 'pwa-help-title');
      const title = document.createElement('h2'); title.id = 'pwa-help-title'; label(title,"安装 GPU Observatory");
      const intro = document.createElement('p'); label(intro,"安装后，可从桌面或应用列表启动看板，并在独立窗口中使用。");
      const steps = document.createElement('p'); label(steps,"使用 Chrome 地址栏右侧的安装图标，或右上角 ⋮ 菜单中的“安装” / “将网页安装为应用”选项。");
      const hint = document.createElement('p'); hint.className = 'pwa-hint'; label(hint,"如果暂未出现安装选项，请在普通 Chrome 窗口打开本网站，稍等片刻后重试。已安装时可直接从应用列表打开。安装后仍需登录并保持联网。");
      const close = document.createElement('button'); close.className = 'pwa-close'; close.type = 'button'; label(close,"知道了"); close.addEventListener('click', () => help.close());
      help.append(title, intro, steps, hint, close); document.body.append(help);
    }
    if (!help.open) help.showModal();
  }
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault(); pending = event; installed = false; update();
  });
  window.addEventListener('appinstalled', () => {
    installed = true; pending = null; if (help?.open) help.close(); update();
  });
  standalone.addEventListener('change', event => { installed = event.matches || navigator.standalone === true; update(); });
  for (const button of buttons) button.addEventListener('click', async () => {
    if (installed) return;
    if (!pending) { showHelp(); return; }
    const prompt = pending; pending = null; button.disabled = true;
    try {
      await prompt.prompt();
      const result = await prompt.userChoice;
      if (result.outcome === 'accepted') installed = true;
    } catch { showHelp(); }
    finally { button.disabled = false; update(); }
  });
  update();
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .catch(() => console.warn('App offline page registration failed; online monitoring is unaffected.'));
  }
})();
