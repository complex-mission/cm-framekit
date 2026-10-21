// 版本检测：启动后静默向官网查询一次；有新版时标题栏出现徽章，点开查看更新说明并去官网下载
// （官网下载需通过人机验证，所以这里只打开下载页，不直接下文件）。帮助页底部可手动检查。
(() => {
  const SITE = 'https://fk.complexmission.com';
  const T = window.__TAURI__;
  const t = (s) => (typeof window.t === 'function' ? window.t(s) : s);
  const $ = (id) => document.getElementById(id);

  const platform = () => {
    const ua = navigator.userAgent;
    if (/Windows/i.test(ua)) return /ARM64|aarch64/i.test(ua) ? 'windows-arm64' : 'windows-x64';
    if (/Mac OS X|Macintosh/i.test(ua)) return 'macos-arm64';
    return 'linux-x64';
  };

  let current = '';
  let info = null; // 最近一次 /api/update 的结果（有新版时）

  async function fetchUpdate() {
    if (!current) current = await T.app.getVersion();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const lang = window.I18n && window.I18n.lang === 'en' ? 'en' : 'zh';
      const url = `${SITE}/api/update?version=${encodeURIComponent(current)}&platform=${platform()}&lang=${lang}`;
      const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function showBadge() {
    const b = $('titlebar-update');
    b.textContent = `${t('新版本')} v${info.latest.version}`;
    b.classList.remove('hidden');
  }

  function openModal() {
    if (!info) return;
    $('update-version').textContent = 'v' + info.latest.version;
    $('update-current').textContent = 'v' + current;
    $('update-notes').textContent = info.latest.notes || '';
    $('update-mandatory').classList.toggle('hidden', !info.mandatory);
    // 强制更新：不提供“稍后”和关闭按钮
    $('btn-update-later').classList.toggle('hidden', !!info.mandatory);
    $('btn-close-update').classList.toggle('hidden', !!info.mandatory);
    $('modal-update').classList.remove('hidden');
  }

  const closeModal = () => { if (!info || !info.mandatory) $('modal-update').classList.add('hidden'); };

  async function check(manual) {
    const status = $('update-status');
    if (manual) status.textContent = t('正在检查更新…');
    try {
      const res = await fetchUpdate();
      if (res.update && res.latest) {
        info = res;
        showBadge();
        if (manual) status.textContent = '';
        if (manual || res.mandatory) openModal();
      } else if (manual) {
        status.textContent = `${t('已是最新版本')} (v${current})`;
      }
    } catch (e) {
      if (manual) status.textContent = t('检查更新失败，请稍后再试');
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('titlebar-update').addEventListener('click', openModal);
    $('btn-check-update').addEventListener('click', () => check(true));
    $('btn-close-update').addEventListener('click', closeModal);
    $('btn-update-later').addEventListener('click', closeModal);
    $('btn-update-download').addEventListener('click', () => {
      window.api.openExternal(info && info.download_page ? info.download_page : SITE + '/download');
    });
    $('btn-update-changelog').addEventListener('click', () => {
      window.api.openExternal(info && info.changelog ? info.changelog : SITE + '/changelog');
    });
    T.app.getVersion().then((v) => {
      current = v;
      $('update-status').textContent = `${t('当前版本')} v${v}`;
    }).catch(() => {});
    // 不挡启动：稍后在后台静默检查
    setTimeout(() => check(false), 3000);
  });
})();
