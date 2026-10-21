(() => {
  const ADMIN = document.currentScript.dataset.admin;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const size = (n) => n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';
  const time = (t) => t && !t.startsWith('0001') ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '';
  const msg = (el, text, cls) => { el.textContent = text; el.className = 'form-msg' + (cls ? ' ' + cls : ''); };

  async function api(path, body) {
    const opt = body === undefined
      ? {}
      : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-FK-Admin': '1' }, body: JSON.stringify(body) };
    const r = await fetch(ADMIN + '/api/' + path, opt);
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && $('#releases')) location.reload();
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
    return j;
  }

  // ---- login ----
  const login = $('#login-form');
  if (login) {
    const out = $('#login-msg');
    const send = $('#send-code');
    send.addEventListener('click', async () => {
      if (!$('#phone').value.trim()) return msg(out, '请输入手机号', 'err');
      send.disabled = true;
      try {
        await api('otp', { phone: $('#phone').value });
        msg(out, '如果号码已授权，验证码已发送', 'ok');
        let left = 60;
        const t = setInterval(() => {
          send.textContent = --left + ' 秒';
          if (left <= 0) { clearInterval(t); send.textContent = '获取验证码'; send.disabled = false; }
        }, 1000);
      } catch (e) {
        msg(out, e.message, 'err');
        send.disabled = false;
      }
    });
    login.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('login', { phone: $('#phone').value, code: $('#code').value });
        location.reload();
      } catch (err) {
        msg(out, err.message, 'err');
      }
    });
    return;
  }

  // ---- dashboard ----
  $('#logout').addEventListener('click', async () => { await api('logout', {}).catch(() => {}); location.reload(); });

  let releases = [];
  async function loadReleases() {
    releases = await api('releases');
    $('#releases tbody').innerHTML = releases.length ? releases.map((r) => `
      <tr data-id="${esc(r.id)}">
        <td><b>v${esc(r.version)}</b>${r.mandatory ? ' <span class="tag tag-pink">强制</span>' : ''}${r.notes_en ? '' : ' <span class="tag" title="没有英文更新说明">无英文</span>'}</td>
        <td>${esc(r.platform)}</td>
        <td class="file">${esc(r.file_name)}</td>
        <td>${size(r.size)}</td>
        <td>${r.downloads}</td>
        <td>${r.published ? '<span class="tag tag-blue">已发布</span>' : '<span class="tag">未发布</span>'}</td>
        <td>${time(r.created_at)}</td>
        <td class="actions">
          <button class="btn btn-ghost btn-sm" data-act="toggle">${r.published ? '下线' : '发布'}</button>
          <button class="btn btn-ghost btn-sm" data-act="mandatory">${r.mandatory ? '取消强制' : '设为强制'}</button>
          <button class="btn btn-ghost btn-sm" data-act="notes">说明</button>
          <button class="btn btn-ghost btn-sm btn-danger" data-act="delete">删除</button>
        </td>
      </tr>`).join('') : '<tr><td colspan="8" class="muted">还没有上传任何版本</td></tr>';
  }

  async function loadLogs() {
    const action = $('#log-filter').value;
    const logs = await api('logs?n=300&action=' + encodeURIComponent(action));
    $('#logs tbody').innerHTML = logs.length ? logs.map((l) => `
      <tr>
        <td>${esc(time(l.time))}</td>
        <td>${esc(l.action)}</td>
        <td>${l.ok ? '<span class="tag tag-blue">成功</span>' : '<span class="tag tag-pink">失败</span>'}</td>
        <td>${esc(l.ip)}</td>
        <td>${esc(l.detail)}</td>
      </tr>`).join('') : '<tr><td colspan="5" class="muted">暂无日志</td></tr>';
  }
  $('#log-filter').addEventListener('change', loadLogs);

  const refresh = () => Promise.all([loadReleases(), loadLogs()]).catch((e) => console.error(e));

  $('#releases').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const id = b.closest('tr').dataset.id;
    const r = releases.find((x) => x.id === id);
    const label = `v${r.version} (${r.platform})`;
    try {
      if (b.dataset.act === 'toggle') {
        await api('releases/' + id, { published: !r.published });
      } else if (b.dataset.act === 'mandatory') {
        await api('releases/' + id, { mandatory: !r.mandatory });
      } else if (b.dataset.act === 'notes') {
        $('#notes-title').textContent = '编辑更新说明 · ' + label;
        $('#notes-text').value = r.notes || '';
        $('#notes-text-en').value = r.notes_en || '';
        const dlg = $('#notes-dialog');
        dlg.returnValue = '';
        dlg.showModal();
        await new Promise((res) => dlg.addEventListener('close', res, { once: true }));
        if (dlg.returnValue !== 'save') return;
        await api('releases/' + id, { notes: $('#notes-text').value, notes_en: $('#notes-text-en').value });
      } else if (b.dataset.act === 'delete') {
        if (!confirm(`删除 ${label}？OSS 上的安装包也会一并删除，无法恢复。`)) return;
        await api('releases/' + id + '/delete', {});
      }
      await refresh();
    } catch (err) {
      alert(err.message);
    }
  });

  // upload with progress (XHR exposes upload progress; fetch does not)
  const form = $('#upload-form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const out = $('#upload-msg');
    const bar = form.querySelector('.progress');
    const fill = form.querySelector('.progress-bar');
    const fd = new FormData();
    // text fields first: the server reads the stream in order
    for (const k of ['version', 'platform', 'notes', 'notes_en']) fd.append(k, form.elements[k].value);
    if (form.elements.publish.checked) fd.append('publish', '1');
    if (form.elements.mandatory.checked) fd.append('mandatory', '1');
    fd.append('file', form.elements.file.files[0]);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', ADMIN + '/api/upload');
    xhr.setRequestHeader('X-FK-Admin', '1');
    xhr.upload.onprogress = (ev) => {
      if (!ev.lengthComputable) return;
      const p = ev.loaded / ev.total;
      fill.style.width = (p * 100).toFixed(1) + '%';
      msg(out, p < 1 ? `上传中 ${(p * 100).toFixed(0)}%` : '正在写入存储…');
    };
    xhr.onload = () => {
      $('#upload-btn').disabled = false;
      let j = {};
      try { j = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 200) {
        msg(out, `v${j.version} 上传成功${j.published ? '并已发布' : '（未发布）'}`, 'ok');
        form.reset();
        bar.hidden = true;
        refresh();
      } else {
        msg(out, j.error || '上传失败 HTTP ' + xhr.status, 'err');
      }
    };
    xhr.onerror = () => { $('#upload-btn').disabled = false; msg(out, '网络错误，上传失败', 'err'); };
    $('#upload-btn').disabled = true;
    bar.hidden = false;
    fill.style.width = '0';
    xhr.send(fd);
  });

  refresh();
})();
