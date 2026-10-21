// Download buttons: Aliyun Captcha 2.0 (popup) -> POST /api/download -> short-lived link.
// In encryption mode the captcha is initialised with an EncryptedSceneId from /api/captcha-scene,
// fetched again (and the captcha rebuilt) when it is about to expire.
(() => {
  const cfg = document.getElementById('fk-config').dataset;
  const buttons = document.querySelectorAll('.js-download');
  if (!buttons.length) return;
  const status = document.querySelector('.dl-status');
  let pending = null;

  const say = (msg, err) => {
    if (!status) return;
    status.textContent = msg;
    status.classList.toggle('err', !!err);
  };

  async function fetchLink(captcha) {
    say(cfg.msgWorking);
    try {
      const r = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: pending.platform, version: pending.version || '', captcha }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        say(j.error === 'captcha_failed' ? cfg.msgCaptcha : j.error === 'rate_limited' ? cfg.msgLimited : cfg.msgFailed, true);
        return;
      }
      window.location.href = j.url;
      say(cfg.msgStarted);
      const again = document.createElement('a');
      again.href = j.url;
      again.textContent = cfg.msgRetry;
      status && status.append(again);
    } catch {
      say(cfg.msgFailed, true);
    }
  }

  // Captcha disabled (local testing only): download straight away.
  if (!cfg.captcha) {
    buttons.forEach((b) => b.addEventListener('click', () => {
      pending = { platform: b.dataset.platform, version: b.dataset.version };
      fetchLink('');
    }));
    return;
  }

  const encrypt = !!cfg.captchaEncrypt;
  let instance = null;
  let trigger = null;
  let expiresAt = Infinity; // ms; only finite in encryption mode
  let building = null;

  const loadScript = new Promise((resolve, reject) => {
    window.AliyunCaptchaConfig = { region: cfg.captchaRegion || 'cn', prefix: cfg.captchaPrefix };
    const s = document.createElement('script');
    s.src = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js';
    s.onload = resolve;
    s.onerror = reject;
    document.head.append(s);
  });

  async function encryptedSceneId() {
    const r = await fetch('/api/captcha-scene', { cache: 'no-store' });
    if (!r.ok) throw new Error('scene ' + r.status);
    const j = await r.json();
    // renew a minute early so a popup opened just before expiry still verifies
    expiresAt = Date.now() + Math.max(30, (j.expires_in || 600) - 60) * 1000;
    return j.EncryptedSceneId;
  }

  // The captcha binds to one hidden trigger; every visible button records what it wants and clicks
  // it. Rebuilding replaces the trigger and holder so no stale listener survives.
  async function build() {
    await loadScript;
    const opts = {
      SceneId: cfg.captchaScene,
      mode: 'popup',
      element: '#captcha-element',
      button: '#captcha-trigger',
      success: (captchaVerifyParam) => fetchLink(captchaVerifyParam),
      fail: () => say(cfg.msgCaptcha, true),
      getInstance: (i) => { instance = i; },
      slideStyle: { width: 360, height: 40 },
      language: cfg.lang === 'en' ? 'en' : 'cn',
    };
    if (encrypt) opts.EncryptedSceneId = await encryptedSceneId();
    if (instance && typeof instance.destroyCaptcha === 'function') instance.destroyCaptcha();
    instance = null;
    document.getElementById('captcha-trigger')?.remove();
    document.getElementById('captcha-element')?.remove();
    trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.id = 'captcha-trigger';
    trigger.hidden = true;
    const holder = document.createElement('div');
    holder.id = 'captcha-element';
    document.body.append(trigger, holder);
    window.initAliyunCaptcha(opts);
  }

  const ensure = () => {
    if (!building || Date.now() >= expiresAt) building = build().catch((e) => { building = null; throw e; });
    return building;
  };
  ensure().catch(() => say(cfg.msgFailed, true));

  buttons.forEach((b) => b.addEventListener('click', async () => {
    pending = { platform: b.dataset.platform, version: b.dataset.version };
    say('');
    try {
      await ensure();
    } catch {
      say(cfg.msgFailed, true);
      return;
    }
    // a freshly initialised captcha may bind its listener asynchronously
    setTimeout(() => trigger.click(), 50);
  }));
})();
