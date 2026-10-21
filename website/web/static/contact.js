(() => {
  const form = document.getElementById('contact-form');
  const msg = document.getElementById('ct-msg');
  const txt = document.getElementById('ct-text').dataset;
  const lang = document.getElementById('fk-config').dataset.lang;
  const btn = form.querySelector('button[type="submit"]');
  const count = document.getElementById('ct-count');
  const say = (s, cls) => { msg.textContent = s; msg.className = 'form-msg' + (cls ? ' ' + cls : ''); };

  form.elements.message.addEventListener('input', (e) => { count.textContent = e.target.value.length; });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = form.elements;
    if (f.message.value.trim().length < 5) return say(txt.short, 'err');
    btn.disabled = true;
    say(txt.sending);
    try {
      const r = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: f.name.value, contact: f.contact.value, message: f.message.value, website: f.website.value, lang }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        form.reset();
        count.textContent = '0';
        say(txt.ok, 'ok');
      } else {
        say(j.error === 'rate_limited' ? txt.limited : j.error === 'invalid' ? txt.short : txt.failed, 'err');
      }
    } catch {
      say(txt.failed, 'err');
    } finally {
      btn.disabled = false;
    }
  });
})();
