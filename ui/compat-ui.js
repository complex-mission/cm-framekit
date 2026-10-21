// 网页 / Apple 设备兼容性提示：导入视频的分析结果 + 各输出选项的平台说明。
(() => {
  const en = () => window.I18n && window.I18n.lang === 'en';
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let expanded = false;
  let lastIssues = [];

  // 导入视频的兼容性分析（来自后端 compat.rs）
  window.renderCompat = function (issues) {
    const panel = document.getElementById('compat-panel');
    if (!panel) return;
    if (issues !== undefined) lastIssues = issues || [];
    const list = lastIssues;
    const errors = list.filter(i => i.level === 'error').length;
    const warns = list.filter(i => i.level === 'warn').length;

    let cls = 'ok';
    let label = en() ? 'Source web compatibility: good (Safari / Chrome / Firefox)' : '源文件网页兼容性：良好（Safari / Chrome / Firefox 均可播放）';
    if (errors) {
      cls = 'error';
      label = en() ? `Source web compatibility: ${errors} blocking issue(s)${warns ? `, ${warns} warning(s)` : ''}` : `源文件网页兼容性：${errors} 个严重问题${warns ? `，${warns} 个提醒` : ''}`;
    } else if (warns) {
      cls = 'warn';
      label = en() ? `Source web compatibility: ${warns} warning(s)` : `源文件网页兼容性：${warns} 个提醒`;
    } else if (list.length) {
      label += en() ? ' · notes' : ' · 有提示';
    }
    const icon = { ok: '✓', warn: '!', error: '✕' }[cls];
    const items = list.map(i => {
      const tx = en() ? i.en : i.zh;
      return `<li class="compat-item compat-${i.level}"><span class="compat-dot"></span><div><div class="compat-title">${esc(tx.title)}</div><div class="compat-detail">${esc(tx.detail)}</div></div></li>`;
    }).join('');
    const foot = en()
      ? 'This describes the original file. Previews generated here are always H.264/HEVC(hvc1) 8-bit + AAC + faststart and pass a built-in check.'
      : '以上针对原始文件。本软件生成的 MP4 预览固定为 H.264/HEVC(hvc1) 8-bit + AAC + faststart，并会自动校验。';

    panel.className = `compat-panel compat-${cls}`;
    panel.innerHTML = `
      <button type="button" class="compat-summary" ${list.length ? '' : 'disabled'}>
        <span class="compat-icon">${icon}</span><span>${esc(label)}</span>
        ${list.length ? `<span class="compat-toggle${expanded ? ' open' : ''}"><span>${expanded ? (en() ? 'Hide' : '收起') : (en() ? 'Details' : '详情')}</span><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg></span>` : ''}
      </button>
      ${list.length && expanded ? `<ul class="compat-list">${items}</ul><div class="compat-foot">${esc(foot)}</div>` : ''}`;
    const btn = panel.querySelector('.compat-summary');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      expanded = !expanded;
      window.renderCompat();
      if (typeof checkLayout === 'function') checkLayout();
    });
  };

  // ---- 输出选项的平台说明 ----

  function previewNote(codec, fmt, audio) {
    const E = en();
    if (fmt === 'gif') return E ? 'GIF: plays everywhere, but large and 256 colours max.' : 'GIF：所有平台都能播放，但体积大、最多 256 色。';
    if (fmt === 'webp') return E ? 'Animated WebP: Safari 14+ (macOS 11 / iOS 14) and all modern browsers; much smaller than GIF.' : '动画 WebP：Safari 14+（macOS 11 / iOS 14）及所有现代浏览器可播，体积远小于 GIF。';
    const hevc = /265|hevc/i.test(codec);
    const a = audio ? (E ? ' Audio: AAC-LC stereo (plays everywhere).' : ' 音频：AAC-LC 双声道（全平台）。') : '';
    if (hevc) {
      return (E
        ? '⚠ H.265 (hvc1, Main 8-bit): Safari on Mac/iOS (incl. M1) ✓; Chrome/Edge only with GPU HEVC decoding; Firefox only on Windows with hardware support; Linux mostly ✕. ~40% smaller than H.264.'
        : '⚠ H.265（hvc1，Main 8-bit）：Mac/iOS 的 Safari（含 M1）✓；Chrome/Edge 需显卡支持 HEVC 硬解；Firefox 仅 Windows 且有硬解；Linux 基本 ✕。体积比 H.264 小约 40%。') + a;
    }
    return (E
      ? '✓ H.264 High 8-bit 4:2:0 + faststart: plays in every browser and device (Safari/iOS/M1/Chrome/Firefox/Android). Recommended for the web.'
      : '✓ H.264 High 8-bit 4:2:0 + faststart：所有浏览器和设备都能播放（Safari/iOS/M1/Chrome/Firefox/Android），网页使用推荐。') + a;
  }

  function audioNote(codec) {
    const E = en();
    if (codec === 'aac') return E ? '✓ AAC in .m4a (faststart): plays everywhere, including old Safari/iOS.' : '✓ AAC（.m4a，faststart）：所有浏览器和设备都能播放，包括旧版 Safari/iOS。';
    if (codec === 'opus') return E ? '⚠ Opus in .ogg: smallest files, but Safari needs 18.4+ (macOS 15.4 / iOS 18.4); older Apple devices cannot play it.' : '⚠ Opus（.ogg）：体积最小，但 Safari 需 18.4+（macOS 15.4 / iOS 18.4），旧 Apple 设备放不了。';
    return E ? '✓ MP3: plays everywhere. 5.1/7.1 sources are downmixed to stereo.' : '✓ MP3：全平台可播放。5.1/7.1 源会自动下混为立体声。';
  }

  function hintEl(afterId, id) {
    let el = document.getElementById(id);
    if (!el) {
      const anchor = document.getElementById(afterId);
      if (!anchor) return null;
      el = document.createElement('div');
      el.id = id;
      el.className = 'form-hint compat-hint';
      anchor.insertAdjacentElement('afterend', el);
    }
    return el;
  }

  window.updateCompatHints = function () {
    const pc = document.getElementById('preview-codec');
    const pf = document.getElementById('preview-format');
    const pa = document.getElementById('preview-audio');
    const ph = hintEl('preview-hint', 'preview-compat-hint');
    if (pc && pf && ph) {
      const text = previewNote(pc.value, pf.value, pa && pa.checked);
      ph.textContent = text;
      ph.classList.toggle('compat-hint-warn', text.startsWith('⚠'));
    }
    const ac = document.getElementById('audio-codec');
    const ah = hintEl('audio-hint', 'audio-compat-hint');
    if (ac && ah) {
      const text = audioNote(ac.value);
      ah.textContent = text;
      ah.classList.toggle('compat-hint-warn', text.startsWith('⚠'));
    }
  };

  // 输出校验（后端 mp4box 扫描）发现问题时附在任务日志后
  window.compatWarningSuffix = function (res) {
    if (!res || !Array.isArray(res.warnings) || !res.warnings.length) return '';
    return (en() ? ' · ⚠ check: ' : ' · ⚠ 校验：') + res.warnings.join('；');
  };

  document.addEventListener('DOMContentLoaded', () => {
    ['preview-codec', 'preview-format', 'preview-audio', 'audio-codec'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', window.updateCompatHints);
    });
    setTimeout(window.updateCompatHints, 0);
  });
})();
