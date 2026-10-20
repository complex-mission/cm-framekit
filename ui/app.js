// ============ State ============
let currentFile = null;
let videoInfo = null;
let settings = {};
let capturedFrames = [];
let currentFrameIndex = -1;
let videoElement = null;
let isDraggingTimeline = false;

// ============ DOM Ready ============
document.addEventListener('DOMContentLoaded', async () => {
  settings = await window.api.loadSettings();
  videoElement = document.getElementById('frame-preview-video');
  setupWindowControls();
  setupEventListeners();
  setupModeTabs();
  setupBatch();
  setupPresets();
  setupProgressListener();
  setupAudioTracks();
  updateAudioBitrateOptions();
  updatePreviewFormatFields();
  renderRecentFiles();

  // 初始状态 + 布局 + 语言：同步立即应用，确保首屏即正确（不被慢速硬件检测阻塞）
  document.getElementById('file-section').classList.add('initial-state');
  checkLayout();
  window.addEventListener('resize', checkLayout);

  window.I18n.setApplyHook(onLangApplied);
  window.I18n.capture();
  const lang = settings.lang || window.I18n.detect();
  document.getElementById('setting-lang').value = lang;
  window.I18n.apply(lang);

  // 硬件编码器检测较慢（会跑 ffmpeg），放后台异步进行，完成后再填充编码下拉与徽章
  populatePreviewCodecs();
});

// ============ Layout Check ============
function checkLayout() {
  const tasksSection = document.getElementById('tasks-section');
  const logBottom = document.getElementById('log-section-bottom');
  const isWide = window.innerWidth > 1360;
  
  if (isWide) {
    tasksSection.classList.add('wide-layout');
    logBottom.classList.add('hidden');
  } else {
    tasksSection.classList.remove('wide-layout');
    // 只有在任务区显示时才显示底部日志
    if (!tasksSection.classList.contains('hidden')) {
      logBottom.classList.remove('hidden');
    }
  }
}

// ============ Window Controls ============
function setupWindowControls() {
  document.getElementById('btn-minimize').addEventListener('click', () => {
    window.api.windowMinimize();
  });

  document.getElementById('btn-maximize').addEventListener('click', async () => {
    window.api.windowMaximize();
    updateMaximizeIcon();
  });

  document.getElementById('btn-close').addEventListener('click', () => {
    window.api.windowClose();
  });

  // 监听最大化状态变化
  window.addEventListener('resize', () => {
    updateMaximizeIcon();
  });
}

function updateMaximizeIcon() {
  const btn = document.getElementById('btn-maximize');
  // 简化处理：通过检测窗口大小判断是否最大化
  if (window.innerWidth >= screen.availWidth - 10) {
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
        <rect x="4" y="8" width="12" height="12" rx="1.5"/>
        <path d="M8 8V4h12v12h-4"/>
      </svg>
    `;
  } else {
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
        <rect x="5" y="5" width="14" height="14" rx="1.5"/>
      </svg>
    `;
  }
}

// ============ Event Listeners ============
function setupEventListeners() {
  // 文件选择 - 点击整个导入区域(含边距)即可选择；已加载文件时交给“更换文件”按钮
  document.getElementById('file-drop').addEventListener('click', () => {
    if (document.getElementById('file-drop').classList.contains('has-file')) return;
    selectFile();
  });
  document.getElementById('btn-change-file').addEventListener('click', (e) => {
    e.stopPropagation();
    selectFile();
  });

  // 拖拽：Tauri 接管系统拖放，由 webview 事件给出真实路径。
  // 批量面板可见时加入批量列表，否则载入第一个文件。
  window.api.onFileDrop((paths) => {
    const batchDrop = document.getElementById('batch-drop');
    if (batchDrop && batchDrop.offsetParent !== null) {
      paths.forEach(addBatchPath);
      renderBatchList();
    } else {
      loadFile(paths[0]);
    }
  }, (el) => {
    ['file-drop', 'batch-drop'].forEach(id => {
      const z = document.getElementById(id);
      if (z) z.classList.toggle('drag-over', !!el && z.offsetParent !== null);
    });
  });

  // 时间轴交互
  setupTimeline();

  // 截帧按钮
  document.getElementById('btn-capture-frame').addEventListener('click', captureCurrentFrame);
  document.getElementById('btn-export-frames').addEventListener('click', openExportModal);
  document.getElementById('btn-clear-frames').addEventListener('click', clearFrames);

  // 导出弹窗
  document.getElementById('btn-close-export').addEventListener('click', closeExportModal);
  document.getElementById('btn-cancel-export').addEventListener('click', closeExportModal);
  document.getElementById('btn-confirm-export').addEventListener('click', confirmExport);
  document.getElementById('export-format').addEventListener('change', updateExportHint);
  document.getElementById('export-size').addEventListener('change', updateSizeHint);
  document.getElementById('export-quality').addEventListener('input', () => {
    document.getElementById('export-quality-label').textContent = document.getElementById('export-quality').value;
  });

  // 音频选项
  document.getElementById('audio-codec').addEventListener('change', updateAudioBitrateOptions);
  document.getElementById('audio-bitrate').addEventListener('change', updateAudioBitrateHint);

  // 雪碧图间隔
  document.getElementById('sprite-interval').addEventListener('input', updateSpriteInterval);

  // 预览视频：任一设置变化都刷新底部「当前设置 + 预计体积」摘要
  ['preview-width', 'preview-codec', 'preview-format', 'preview-fps', 'preview-gif-colors', 'preview-webp-quality', 'preview-clips', 'preview-clip-duration', 'preview-audio']
    .forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', updatePreviewSummary);
    });
  // 帧率额外刷新其提示
  document.getElementById('preview-fps').addEventListener('change', updatePreviewFpsHint);
  // 格式变化：刷新提示 + 动态显隐相关字段
  document.getElementById('preview-format').addEventListener('change', () => {
    updatePreviewFormatHint();
    updatePreviewFormatFields();
  });
  // WebP 画质滑块数值显示
  document.getElementById('preview-webp-quality').addEventListener('input', () => {
    document.getElementById('preview-webp-quality-label').textContent = document.getElementById('preview-webp-quality').value;
  });

  // 任务队列「终止」按钮（事件委托，卡片动态生成）
  ['log-list-side', 'log-list-bottom'].forEach(id => {
    const list = document.getElementById(id);
    if (list) list.addEventListener('click', (e) => {
      const cancelBtn = e.target.closest('.log-cancel');
      if (cancelBtn) {
        const card = cancelBtn.closest('.log-item');
        if (card && card.dataset.task) cancelTask(card.dataset.task);
        return;
      }
      const detailsBtn = e.target.closest('.log-details-toggle');
      if (detailsBtn) {
        const pre = detailsBtn.closest('.log-item')?.querySelector('.log-details');
        if (pre) pre.classList.toggle('show');
      }
    });
  });

  // 执行任务
  document.getElementById('btn-run-tasks').addEventListener('click', () => runTasks());

  // 设置
  document.getElementById('btn-settings').addEventListener('click', openSettings);
  document.getElementById('btn-close-settings').addEventListener('click', closeSettings);
  document.getElementById('btn-cancel-settings').addEventListener('click', closeSettings);
  // 语言切换：即时生效并持久化
  document.getElementById('setting-lang').addEventListener('change', (e) => {
    settings.lang = e.target.value;
    window.api.saveSettings(settings);
    window.I18n.apply(settings.lang);
  });

  // 外部链接：用系统浏览器打开（事件委托，帮助正文会随语言重建）
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-ext-url]');
    if (a) {
      e.preventDefault();
      window.api.openExternal(a.getAttribute('data-ext-url'));
    }
  });

  // 帮助
  const openHelp = () => document.getElementById('modal-help').classList.remove('hidden');
  const closeHelp = () => document.getElementById('modal-help').classList.add('hidden');
  document.getElementById('btn-help').addEventListener('click', openHelp);
  document.getElementById('btn-close-help').addEventListener('click', closeHelp);
  document.getElementById('btn-ok-help').addEventListener('click', closeHelp);
  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
  document.getElementById('btn-select-output-dir').addEventListener('click', async () => {
    const dir = await window.api.selectDirectory('选择默认输出目录');
    if (dir) document.getElementById('setting-output-dir').value = dir;
  });
}

// ============ Timeline ============
function setupTimeline() {
  const track = document.getElementById('timeline-track');
  const thumb = document.getElementById('timeline-thumb');

  const updateTimeFromPosition = (e) => {
    if (!videoElement || !videoElement.duration) return;
    const rect = track.getBoundingClientRect();
    let percent = (e.clientX - rect.left) / rect.width;
    percent = Math.max(0, Math.min(1, percent));
    const time = percent * videoElement.duration;
    seekTo(time);
  };

  track.addEventListener('mousedown', (e) => {
    isDraggingTimeline = true;
    updateTimeFromPosition(e);
  });

  document.addEventListener('mousemove', (e) => {
    if (isDraggingTimeline) {
      updateTimeFromPosition(e);
    }
  });

  document.addEventListener('mouseup', () => {
    isDraggingTimeline = false;
  });
}

function seekTo(time) {
  if (!videoElement || !videoElement.duration) return;
  time = Math.max(0, Math.min(time, videoElement.duration));
  videoElement.currentTime = time;
  updateTimeline(time);
}

function updateTimeline(time) {
  if (!videoElement || !videoElement.duration) return;
  const percent = (time / videoElement.duration) * 100;
  document.getElementById('timeline-progress').style.width = percent + '%';
  document.getElementById('timeline-thumb').style.left = percent + '%';
  document.getElementById('current-time').textContent = formatTimePrecise(time);
}

// ============ File Handling ============
async function selectFile() {
  const filePath = await window.api.selectFile();
  if (filePath) {
    await loadFile(filePath);
  }
}

// 记录最近打开的文件（去重、置顶、上限 8）
// 兼容旧格式（字符串数组）→ 统一为 {path, ts}
function normalizeRecent(list) {
  return (Array.isArray(list) ? list : []).map(x => (typeof x === 'string') ? { path: x, ts: 0 } : x).filter(x => x && x.path);
}

function addRecentFile(p) {
  let list = normalizeRecent(settings.recentFiles).filter(x => x.path !== p);
  list.unshift({ path: p, ts: Date.now() });
  settings.recentFiles = list.slice(0, 8);
  window.api.saveSettings(settings);
  renderRecentFiles();
}

// 历史项时间格式：YYYY-MM-DD HH:MM
function formatDateTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 渲染导入区的「最近打开」列表（用 DOM 构建，避免路径转义/注入问题）
function renderRecentFiles() {
  const box = document.getElementById('recent-files');
  if (!box) return;
  box.innerHTML = '';

  const list = normalizeRecent(settings.recentFiles);
  if (list.length === 0) return;

  const head = document.createElement('div');
  head.className = 'recent-head';
  const label = document.createElement('span');
  label.textContent = t('最近打开');
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'recent-clear';
  clear.textContent = t('清空');
  clear.addEventListener('click', (e) => {
    e.stopPropagation(); // 避免冒泡到导入区触发选择文件
    settings.recentFiles = [];
    window.api.saveSettings(settings);
    renderRecentFiles();
  });
  head.appendChild(label);
  head.appendChild(clear);
  box.appendChild(head);

  const listEl = document.createElement('div');
  listEl.className = 'recent-list';
  list.forEach(item => {
    const p = item.path;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'recent-item';
    btn.title = p;

    const nameEl = document.createElement('span');
    nameEl.className = 'recent-name';
    nameEl.textContent = p.split(/[/\\]/).pop();
    btn.appendChild(nameEl);

    const timeEl = document.createElement('span');
    timeEl.className = 'recent-time';
    timeEl.textContent = formatDateTime(item.ts);
    btn.appendChild(timeEl);

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      loadFile(p);
    });
    listEl.appendChild(btn);
  });
  box.appendChild(listEl);
}

async function loadFile(filePath) {
  currentFile = filePath;
  const dropZone = document.getElementById('file-drop');
  const fileInfo = document.getElementById('file-info');
  const fileContent = document.getElementById('file-drop-content');
  const fileSection = document.getElementById('file-section');

  // 获取视频信息
  const result = await window.api.probeVideo(filePath);
  if (!result.success) {
    alert(t('无法读取视频文件: ') + result.error);
    return;
  }

  videoInfo = result.data;
  addRecentFile(filePath);

  // 更新 UI
  fileSection.classList.remove('initial-state');
  dropZone.classList.add('has-file');
  fileContent.classList.add('hidden');
  fileInfo.classList.remove('hidden');

  document.getElementById('file-name').textContent = filePath.split(/[/\\]/).pop();

  currentAudioTracks = videoInfo.audioTracks || [];
  renderFileMeta();
  renderCompat(videoInfo.compat);
  renderAudioTracks();

  // 显示任务面板
  document.getElementById('tasks-section').classList.remove('hidden');

  // 根据当前视频帧率/分辨率，生成预览帧率与导出尺寸的候选
  populatePreviewFps();
  populateExportSizes();

  // 清空已截帧
  clearFrames();
  
  // 重置日志
  resetLogs();
  
  // 检查布局
  checkLayout();

  // 加载视频预览
  loadVideoPreview(filePath);
}

// 文件信息行（动态内容，i18n 的静态快照管不到，切语言时需重新渲染）
function renderFileMeta() {
  const el = document.getElementById('file-meta');
  if (!el || !videoInfo) return;

  const parts = [];
  if (videoInfo.video) parts.push(`${videoInfo.video.width}×${videoInfo.video.height}`);
  parts.push(formatDuration(videoInfo.duration));
  parts.push(formatSize(videoInfo.size));
  if (videoInfo.video) parts.push(videoInfo.video.codec);

  // 多音轨时标出条数
  if (currentAudioTracks.length > 1) {
    parts.push(currentAudioTracks[0].codec);
    parts.push(window.I18n.lang === 'en'
      ? `${currentAudioTracks.length} audio tracks`
      : `${currentAudioTracks.length} 条音轨`);
  } else if (videoInfo.audio) {
    parts.push(videoInfo.audio.codec);
  } else {
    parts.push(t('无音频'));
  }

  el.innerHTML = parts.map(m => `<span>${escHtml(m)}</span>`).join('');
}

// 视频元素只绑定一次事件（旧版每次载入都重复 addEventListener）
let realVideoElement = null;

async function loadVideoPreview(filePath) {
  await window.api.ready;
  const img = document.getElementById('frame-preview-img');
  if (!realVideoElement) {
    realVideoElement = document.getElementById('frame-preview-video');
    // 视频来自 127.0.0.1 媒体服务器，与页面不同源：不加 crossOrigin 截帧时 canvas 会被污染
    realVideoElement.crossOrigin = 'anonymous';
    realVideoElement.addEventListener('loadedmetadata', () => {
      if (videoElement !== realVideoElement) return;
      onPreviewReady(realVideoElement.duration);
    });
    realVideoElement.addEventListener('timeupdate', () => {
      if (videoElement === realVideoElement && !isDraggingTimeline) updateTimeline(realVideoElement.currentTime);
    });
    realVideoElement.addEventListener('error', () => {
      // WebView 不支持该编码/容器（AVI/WMV/MPEG-2/ProRes、无硬解的 HEVC …）→ ffmpeg 抽帧预览
      if (videoElement === realVideoElement && currentFile) useFallbackPreview(currentFile);
    });
  }
  videoElement = realVideoElement;
  img.classList.add('hidden');
  document.getElementById('frame-preview-fallback-note')?.remove();

  const url = window.api.mediaUrl(filePath);
  if (!url) { useFallbackPreview(filePath); return; }
  realVideoElement.src = url;
  realVideoElement.classList.remove('hidden');
  document.getElementById('frame-placeholder').classList.add('hidden');
}

function onPreviewReady(duration) {
  document.getElementById('total-duration').textContent = formatDuration(duration);
  document.getElementById('btn-capture-frame').disabled = false;
  seekTo(0);
  // 自动计算雪碧图间隔
  calculateSpriteInterval(duration);
}

// 伪 video 对象：提供 duration/currentTime/videoWidth/videoHeight，画面由 ffmpeg 抽帧显示到 <img>
function useFallbackPreview(filePath) {
  const img = document.getElementById('frame-preview-img');
  const v = (videoInfo && videoInfo.video) || {};
  realVideoElement.removeAttribute('src');
  realVideoElement.load();
  realVideoElement.classList.add('hidden');
  document.getElementById('frame-placeholder').classList.add('hidden');
  img.classList.remove('hidden');

  let cur = 0, seq = 0, timer = null;
  const load = async (tm) => {
    const my = ++seq;
    const r = await window.api.grabFrame(filePath, tm, 1280, false);
    if (my === seq && currentFile === filePath && r.success) img.src = r.dataUrl;
  };
  videoElement = {
    isFallback: true,
    duration: (videoInfo && videoInfo.duration) || 0,
    videoWidth: v.displayWidth || v.width || 0,
    videoHeight: v.displayHeight || v.height || 0,
    get currentTime() { return cur; },
    // 拖动时间轴时节流，只解最后停下的位置
    set currentTime(tm) { cur = tm; clearTimeout(timer); timer = setTimeout(() => load(tm), 120); },
  };

  const note = document.createElement('div');
  note.id = 'frame-preview-fallback-note';
  note.className = 'frame-preview-fallback-note';
  note.textContent = t('此格式内置播放器无法直接播放，已切换为逐帧预览（截帧与导出不受影响）');
  document.getElementById('frame-preview').appendChild(note);
  onPreviewReady(videoElement.duration);
}

// ============ Frame Capture ============
async function captureCurrentFrame() {
  if (!videoElement || !videoElement.duration) return;

  const time = videoElement.currentTime;
  let dataUrl;
  if (videoElement.isFallback || (videoInfo && videoInfo.video && videoInfo.video.hdr)) {
    const btn = document.getElementById('btn-capture-frame');
    btn.disabled = true;
    try {
      const r = await window.api.grabFrame(currentFile, time, 0, true);
      if (!r.success) { alert(t('截帧失败: ') + r.error); return; }
      dataUrl = r.dataUrl;
    } finally {
      btn.disabled = false;
    }
  } else {
    const canvas = document.createElement('canvas');
    canvas.width = videoElement.videoWidth;
    canvas.height = videoElement.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(videoElement, 0, 0);
    dataUrl = canvas.toDataURL('image/png');
  }

  capturedFrames.push({
    dataUrl,
    time,
    index: capturedFrames.length
  });

  addFrameToList(dataUrl, time, capturedFrames.length - 1);
  updateFrameCount();
  document.getElementById('btn-export-frames').disabled = false;
}

function addFrameToList(dataUrl, time, index) {
  const frameList = document.getElementById('frame-list');
  const thumb = document.createElement('div');
  thumb.className = 'frame-thumb';
  thumb.dataset.index = index;
  
  // 根据视频比例计算缩略图尺寸
  const thumbWidth = 150;
  let thumbHeight = 85;
  if (videoElement && videoElement.videoWidth && videoElement.videoHeight) {
    const aspectRatio = videoElement.videoWidth / videoElement.videoHeight;
    thumbHeight = Math.round(thumbWidth / aspectRatio);
  }
  thumb.style.setProperty('--thumb-width', thumbWidth + 'px');
  thumb.style.setProperty('--thumb-height', thumbHeight + 'px');
  
  thumb.innerHTML = `
    <img src="${dataUrl}" alt="帧 ${index + 1}">
    <span class="frame-thumb-time">${formatTimePrecise(time)}</span>
    <button class="frame-thumb-delete" title="删除">
      <svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor">
        <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
      </svg>
    </button>
  `;

  thumb.addEventListener('click', (e) => {
    if (e.target.closest('.frame-thumb-delete')) {
      e.stopPropagation();
      removeFrame(index);
      return;
    }
    selectFrame(index);
  });

  frameList.appendChild(thumb);
  frameList.scrollLeft = frameList.scrollWidth;
}

function selectFrame(index) {
  if (index < 0 || index >= capturedFrames.length) return;
  currentFrameIndex = index;

  // 更新选中状态
  document.querySelectorAll('.frame-thumb').forEach(t => t.classList.remove('active'));
  const thumb = document.querySelector(`.frame-thumb[data-index="${index}"]`);
  if (thumb) thumb.classList.add('active');

  // 跳转到对应时间
  seekTo(capturedFrames[index].time);
}

function removeFrame(index) {
  capturedFrames = capturedFrames.filter((_, i) => i !== index);
  rebuildFrameList();
  updateFrameCount();

  if (capturedFrames.length === 0) {
    document.getElementById('btn-export-frames').disabled = true;
  }
}

function clearFrames() {
  capturedFrames = [];
  currentFrameIndex = -1;
  document.getElementById('frame-list').innerHTML = '';
  document.getElementById('btn-export-frames').disabled = true;
  updateFrameCount();
}

function rebuildFrameList() {
  const frameList = document.getElementById('frame-list');
  frameList.innerHTML = '';
  capturedFrames.forEach((frame, index) => {
    frame.index = index;
    addFrameToList(frame.dataUrl, frame.time, index);
  });
}

function updateFrameCount() {
  document.getElementById('frame-count').textContent = capturedFrames.length;
}

// ============ Export Modal ============
function openExportModal() {
  if (capturedFrames.length === 0) return;
  document.getElementById('modal-export').classList.remove('hidden');
  document.getElementById('export-frame-count').textContent = capturedFrames.length;

  // 默认选择当前帧
  const radioCurrent = document.querySelector('input[name="export-range"][value="current"]');
  const radioAll = document.querySelector('input[name="export-range"][value="all"]');
  if (currentFrameIndex >= 0) {
    radioCurrent.checked = true;
  } else {
    radioAll.checked = true;
  }

  updateExportHint();
  updateSizeHint();
}

// 基于源视频高度生成导出尺寸候选：只列小于原始高度的常见分辨率(原始尺寸即上限，避免放大增体积)
function populateExportSizes() {
  const sel = document.getElementById('export-size');
  if (!sel) return;

  const labels = { 2160: '2160p (4K)', 1440: '1440p (2K)' };
  const srcH = (videoInfo && videoInfo.video && videoInfo.video.height) ? videoInfo.video.height : 0;
  const srcW = (videoInfo && videoInfo.video && videoInfo.video.width) ? videoInfo.video.width : 0;
  const srcLabel = srcH ? `${t('原始尺寸')} (${srcW}×${srcH})` : t('原始尺寸');

  let html = `<option value="0" selected>${srcLabel}</option>`;
  const candidates = srcH
    ? [2160, 1440, 1080, 720, 480, 360].filter(h => h < srcH)
    : [1080, 720, 480];
  candidates.forEach(h => {
    html += `<option value="${h}">${labels[h] || h + 'p'}</option>`;
  });
  sel.innerHTML = html;
}

// 根据所选高度与视频原始分辨率，提示缩放后的尺寸
function updateSizeHint() {
  const targetHeight = parseInt(document.getElementById('export-size').value) || 0;
  const hint = document.getElementById('export-size-hint');
  const en = window.I18n && window.I18n.lang === 'en';

  if (targetHeight === 0) {
    hint.textContent = en ? 'Keep original resolution' : '保持原始分辨率';
    return;
  }
  if (videoElement && videoElement.videoHeight) {
    const vw = videoElement.videoWidth;
    const vh = videoElement.videoHeight;
    if (targetHeight >= vh) {
      hint.textContent = en ? `Original is ${vw}×${vh}; won't upscale, keeps original size` : `原始为 ${vw}×${vh}，不放大，将保持原始尺寸`;
    } else {
      const w = Math.round(vw * targetHeight / vh / 2) * 2;
      hint.textContent = en ? `~${w}×${targetHeight} (scaled by height)` : `约 ${w}×${targetHeight}（按高度等比缩放）`;
    }
  } else {
    hint.textContent = en ? 'Scaled by height; never upscaled beyond original' : '按高度等比缩放，不会放大超过原始尺寸';
  }
}

function closeExportModal() {
  document.getElementById('modal-export').classList.add('hidden');
}

function updateExportHint() {
  const format = document.getElementById('export-format').value;
  const qualityGroup = document.getElementById('export-quality-group');
  const hint = document.getElementById('export-hint');

  const en = window.I18n && window.I18n.lang === 'en';
  if (format === 'png') {
    qualityGroup.style.display = 'none';
    hint.textContent = en ? 'PNG is lossless — largest files' : 'PNG 为无损格式，文件较大';
  } else {
    qualityGroup.style.display = 'flex';
    if (format === 'jpg') {
      hint.textContent = en ? 'JPG: 85–95 recommended' : 'JPG 建议 85-95';
    } else {
      hint.textContent = en ? 'WebP is smaller than JPG at equal quality; 80–90 recommended' : 'WebP 同画质下比 JPG 更小，建议 80-90';
    }
  }
}

async function confirmExport() {
  const format = document.getElementById('export-format').value;
  const quality = parseInt(document.getElementById('export-quality').value);
  const targetHeight = parseInt(document.getElementById('export-size').value) || 0;
  const range = document.querySelector('input[name="export-range"]:checked').value;

  let framesToExport = [];
  if (range === 'current' && currentFrameIndex >= 0) {
    framesToExport = [capturedFrames[currentFrameIndex]];
  } else {
    framesToExport = [...capturedFrames];
  }

  if (framesToExport.length === 0) {
    alert(t('没有可导出的帧'));
    return;
  }

  closeExportModal();

  // 不再询问，直接存入与任务队列一致的同名文件夹
  const outputDir = settings.outputDir || currentFile.replace(/[/\\][^/\\]+$/, '');

  // PNG 且原始尺寸：直接保存；其余(改格式/画质/缩放)需重新编码
  const framesToSave = await Promise.all(framesToExport.map(async frame => {
    if (format === 'png' && targetHeight === 0) {
      return frame;
    }
    return {
      ...frame,
      dataUrl: await processFrame(frame.dataUrl, format, quality, targetHeight)
    };
  }));

  const result = await window.api.exportFrames({
    frames: framesToSave,
    format,
    quality,
    outputDir,
    inputPath: currentFile
  });

  if (result.success) {
    const en = window.I18n && window.I18n.lang === 'en';
    // 计算导出尺寸（与缩放逻辑一致：只缩小不放大）
    let dims = en ? 'Original' : '原始尺寸';
    const v = videoInfo && videoInfo.video;
    if (v && v.width && v.height) {
      if (targetHeight > 0 && targetHeight < v.height) {
        const w = Math.round(v.width * targetHeight / v.height / 2) * 2;
        dims = `${w}×${targetHeight}`;
      } else {
        dims = `${v.width}×${v.height}`;
      }
    }
    const qualityLabel = format === 'png' ? (en ? 'Lossless' : '无损') : (en ? `Q${quality}` : `质量${quality}`);
    const n = result.paths.length;
    const head = en ? `${n} frame(s)` : `${n}帧`;
    const msg = `${head} · ${format.toUpperCase()} · ${dims} · ${qualityLabel} · ${formatSize(result.size || 0)}`;
    addFrameExportRecord(msg, result.paths[0], result.dir);
  } else {
    addLog('frame', `导出失败: ${result.error}`, 'error');
  }
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

// 解码 -> (可选)按目标高度等比缩放 -> 按格式/画质重新编码
async function processFrame(dataUrl, format, quality, targetHeight) {
  const img = await loadImage(dataUrl);
  let w = img.naturalWidth;
  let h = img.naturalHeight;

  // 仅缩小，不放大；按高度等比
  if (targetHeight > 0 && targetHeight < h) {
    w = Math.round(img.naturalWidth * targetHeight / h / 2) * 2;
    h = targetHeight;
  }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);

  const mimeType = format === 'jpg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
  return format === 'png' ? canvas.toDataURL(mimeType) : canvas.toDataURL(mimeType, quality / 100);
}

// ============ Preview Options ============
// 帧率显示：整数显示整数，29.97 这类保留两位小数
function formatFps(fps) {
  return Number.isInteger(fps) ? String(fps) : String(Math.round(fps * 100) / 100);
}

// 基于源帧率生成候选帧率：只提供小于源帧率的常见值 + 源帧率的整数分频
function buildFpsCandidates(srcFps) {
  const set = new Set();
  [2, 3, 4].forEach(d => {
    const v = Math.round(srcFps / d);
    if (v >= 1) set.add(v);
  });
  [60, 50, 30, 25, 24, 15, 12, 10, 8, 5].forEach(v => {
    if (v < srcFps) set.add(v);
  });
  return [...set].filter(v => v >= 1 && v < srcFps).sort((a, b) => b - a);
}

// 加载视频后填充预览视频的帧率下拉
function populatePreviewFps() {
  const sel = document.getElementById('preview-fps');
  if (!sel) return;

  const srcFps = (videoInfo && videoInfo.video && videoInfo.video.fps) ? videoInfo.video.fps : 0;
  const srcLabel = srcFps ? `${t('原始帧率')} (${formatFps(srcFps)})` : t('原始帧率');

  let html = `<option value="0" selected>${srcLabel}</option>`;
  if (srcFps) {
    buildFpsCandidates(srcFps).forEach(v => {
      html += `<option value="${v}">${v} fps</option>`;
    });
  }
  sel.innerHTML = html;

  updatePreviewFpsHint();
  updatePreviewSummary();
}

// 各候选帧率的优势说明
function describeFps(v) {
  const en = window.I18n && window.I18n.lang === 'en';
  const mapEn = {
    60: 'very smooth, largest size; for high-motion content',
    50: 'PAL high frame rate',
    30: 'integer rate, universal for web/mobile',
    25: 'PAL TV standard (Europe)',
    24: 'cinematic, smaller size',
    15: 'small size, good for previews (recommended)',
    12: 'smaller, slightly choppy',
    10: 'smallest, noticeably choppy',
    8: 'tiny, quick browsing only',
    5: 'slideshow-like, smallest',
  };
  const mapZh = {
    60: '极流畅，体积最大；适合高动态画面',
    50: 'PAL 区高帧率',
    30: '整数帧率，网络/移动端通用',
    25: 'PAL 电视标准（欧洲）',
    24: '电影感，体积较小',
    15: '体积小，适合预览（推荐）',
    12: '体积更小，画面略卡',
    10: '体积最小，明显卡顿',
    8: '体积极小，仅快速浏览',
    5: '幻灯片式，体积最小',
  };
  return (en ? mapEn : mapZh)[v] || '';
}

// 帧率提示：解释当前所选帧率的优势/适用场景
function updatePreviewFpsHint() {
  const sel = document.getElementById('preview-fps');
  const hint = document.getElementById('preview-fps-hint');
  if (!sel || !hint) return;

  const en = window.I18n && window.I18n.lang === 'en';
  const v = parseFloat(sel.value) || 0;
  const srcFps = (videoInfo && videoInfo.video && videoInfo.video.fps) ? videoInfo.video.fps : 0;

  if (v === 0) {
    if (en) {
      let note = 'smoothest, largest size';
      if (srcFps >= 59.8) note += '; high frame rate is silkier';
      else if (srcFps >= 29.9 && srcFps < 30.1) note += '; 29.97 is the NTSC standard';
      else if (srcFps >= 24.9 && srcFps < 25.1) note += '; 25 is the PAL standard';
      else if (srcFps >= 23.9 && srcFps < 24.1) note += '; 24 is cinematic';
      hint.textContent = `Source rate${srcFps ? ' ' + formatFps(srcFps) : ''}: ${note}`;
    } else {
      let note = '画面最流畅、体积最大';
      if (srcFps >= 59.8) note += '；高帧率更顺滑';
      else if (srcFps >= 29.9 && srcFps < 30.1) note += '；29.97 为 NTSC 标准，兼容传统电视/设备';
      else if (srcFps >= 24.9 && srcFps < 25.1) note += '；25 为 PAL 标准';
      else if (srcFps >= 23.9 && srcFps < 24.1) note += '；24 富电影感';
      hint.textContent = `源帧率${srcFps ? ' ' + formatFps(srcFps) : ''}：${note}`;
    }
  } else {
    const d = describeFps(v);
    hint.textContent = `${v} fps${d ? ' — ' + d : ''}`;
  }
}

function previewIsHevc(codec) {
  return /265|hevc/i.test(codec || '');
}

// 体积校准的分组键：mp4 按编码家族，gif/webp 按格式
function previewCalibKey(s) {
  const fmt = (s.format || 'mp4').toLowerCase();
  if (fmt === 'gif' || fmt === 'webp') return fmt;
  return previewIsHevc(s.codec) ? 'mp4-h265' : 'mp4-h264';
}

function fillCodecSelect(sel, hw) {
  if (!sel) return;
  const current = sel.value;
  let html = '<option value="h264">' + t('H.264 (软件)') + '</option><option value="h265">' + t('H.265 (软件)') + '</option>';
  hw.forEach(e => {
    if (e.h264) html += `<option value="h264_${e.key}">H.264 (${e.label})</option>`;
    if (e.h265) html += `<option value="hevc_${e.key}">H.265 (${e.label})</option>`;
  });
  sel.innerHTML = html;
  sel.value = [...sel.options].some(o => o.value === current) ? current : 'h264';
}

let lastHw = [];

// 用 HW 检测结果填充编码下拉（软件 + 可用的硬件编码器），单文件与批量共用
async function populatePreviewCodecs() {
  let hw = [];
  try { hw = await window.api.getHwEncoders(); } catch (e) {}
  lastHw = hw;
  fillCodecSelect(document.getElementById('preview-codec'), hw);
  fillCodecSelect(document.getElementById('b-preview-codec'), hw);
  updateAccelBadge(hw);
  updateHelpHardware();
  updatePreviewSummary();
}

// 帮助里动态显示「本机实际检测到的硬件加速」（随探测结果与语言变化）
function updateHelpHardware() {
  const el = document.getElementById('help-hw-detected');
  if (!el) return;
  const en = window.I18n && window.I18n.lang === 'en';
  if (lastHw && lastHw.length) {
    const labels = lastHw.map(e => e.label).join(' / ');
    el.textContent = en
      ? `Detected on this machine: ${labels} — the codec dropdown shows H.264/H.265 (${labels}).`
      : `本机检测到：${labels} —— 编码下拉里会出现 H.264/H.265 (${labels}) 选项。`;
  } else {
    el.textContent = en
      ? 'No hardware acceleration detected on this machine; software encoding (libx264/libx265) is used.'
      : '本机未检测到硬件加速，使用软件编码（libx264/libx265）。';
  }
}

// 切换语言后重建带语言的动态内容
function onLangApplied() {
  fillCodecSelect(document.getElementById('preview-codec'), lastHw);
  fillCodecSelect(document.getElementById('b-preview-codec'), lastHw);
  updateAccelBadge(lastHw);
  updateHelpHardware();
  renderPresets();
  renderRecentFiles();
  updateAudioBitrateHint();
  renderFileMeta();
  renderCompat(videoInfo && videoInfo.compat);
  renderAudioTracks();
  updatePreviewFpsHint();
  updatePreviewFormatHint();
  updatePreviewSummary();
  updateExportHint();
  updateSizeHint();
  renderBatchList();
}

// 标题栏显示检测到的编码加速
function updateAccelBadge(hw) {
  const el = document.getElementById('titlebar-accel');
  if (!el) return;
  if (hw && hw.length) {
    el.textContent = '⚡ ' + hw.map(e => e.label).join(' / ');
    el.title = (window.I18n && window.I18n.lang === 'en' ? 'Hardware encoders detected: ' : '检测到可用硬件加速编码器：') + hw.map(e => e.label).join(window.I18n && window.I18n.lang === 'en' ? ', ' : '、');
    el.classList.add('on');
  } else {
    el.textContent = t('软件编码');
    el.title = window.I18n && window.I18n.lang === 'en' ? 'No hardware acceleration detected; using software' : '未检测到可用硬件加速，使用软件编码';
    el.classList.remove('on');
  }
}

// 输出格式提示（含 Safari 大动图警告）
function updatePreviewFormatHint() {
  const sel = document.getElementById('preview-format');
  const hint = document.getElementById('preview-format-hint');
  if (!sel || !hint) return;
  const fmt = sel.value;
  const en = window.I18n && window.I18n.lang === 'en';
  hint.classList.remove('warn');
  if (fmt === 'gif') {
    hint.textContent = en ? 'Most compatible, but only 256 colors and larger files' : '兼容性最好，但仅 256 色、体积偏大';
  } else if (fmt === 'webp') {
    hint.textContent = en
      ? '⚠ Smaller than GIF; but large/long animated WebP may play slower and slower (or stall) in Safari — keep it small, short, low fps'
      : '⚠ 体积小于 GIF；但大尺寸/长时长的动画 WebP 在 Safari 下可能越播越慢甚至卡死，建议小尺寸、短时长、低帧率';
    hint.classList.add('warn');
  } else {
    hint.textContent = en ? 'General video — best size, most reliable playback' : '通用视频，体积最优、播放最稳';
  }
}

// 按输出格式动态显隐相关字段：编码/音频仅 MP4；颜色数量仅 GIF；画质仅 WebP
function updatePreviewFormatFields() {
  const fmt = document.getElementById('preview-format').value;
  const toggle = (id, show) => {
    const el = document.getElementById(id);
    if (el) el.style.display = show ? '' : 'none';
  };
  toggle('pv-group-codec', fmt === 'mp4');
  toggle('pv-group-audio', fmt === 'mp4');
  toggle('pv-group-gifcolors', fmt === 'gif');
  toggle('pv-group-webpquality', fmt === 'webp');
}

// 估算预览最终体积(粗略：码率≈分辨率×帧率×每像素比特×编码系数；含按实测校准的系数)
function estimatePreviewBytes(s) {
  let aspect = 16 / 9;
  if (videoInfo && videoInfo.video && videoInfo.video.width && videoInfo.video.height) {
    aspect = videoInfo.video.width / videoInfo.video.height;
  }
  const height = Math.max(2, Math.round(s.width / aspect / 2) * 2);
  const srcFps = (videoInfo && videoInfo.video && videoInfo.video.fps) ? videoInfo.video.fps : 25;
  const fps = s.fps > 0 ? s.fps : srcFps;
  const duration = (s.clips || 0) * (s.clipDuration || 0);
  const fmt = (s.format || 'mp4').toLowerCase();

  let bpp;
  let audioBps = 0;
  if (fmt === 'gif') {
    const colors = s.gifColors || 256;
    bpp = 0.15 + 0.15 * (colors / 256); // 颜色越多体积越大
  } else if (fmt === 'webp') {
    const q = s.webpQuality || 70;
    bpp = 0.10 * (q / 70); // 画质越高体积越大
  } else {
    bpp = previewIsHevc(s.codec) ? 0.045 : 0.08;
    audioBps = s.includeAudio ? (previewIsHevc(s.codec) ? 64000 : 128000) : 0;
  }

  const raw = (s.width * height * fps * bpp + audioBps) * duration / 8;
  const factor = (settings.sizeCalibration && settings.sizeCalibration[previewCalibKey(s)]) || 1;
  return raw * factor;
}

// 用实际产物大小校准估算系数（指数平滑，限幅 0.2~5）
function calibrateSize(s, estBytes, actualBytes) {
  if (!estBytes || !actualBytes) return;
  const key = previewCalibKey(s);
  if (!settings.sizeCalibration) settings.sizeCalibration = {};
  const prev = settings.sizeCalibration[key] || 1;
  const rawEst = estBytes / prev;            // 去掉上次系数，还原模型原始预估
  const ratio = actualBytes / rawEst;        // 实际 / 模型
  const next = prev * 0.7 + ratio * 0.3;     // EMA
  settings.sizeCalibration[key] = Math.max(0.2, Math.min(5, next));
  window.api.saveSettings(settings);
  updatePreviewSummary();
}

// 底部提示：显示当前预览设置 + 预计体积
function updatePreviewSummary() {
  const hint = document.getElementById('preview-hint');
  if (!hint) return;

  const codec = document.getElementById('preview-codec').value;
  const fmt = document.getElementById('preview-format').value;
  const s = {
    width: parseInt(document.getElementById('preview-width').value) || 640,
    codec,
    format: fmt,
    fps: parseFloat(document.getElementById('preview-fps').value) || 0,
    gifColors: parseInt(document.getElementById('preview-gif-colors').value) || 256,
    webpQuality: parseInt(document.getElementById('preview-webp-quality').value) || 70,
    clips: parseInt(document.getElementById('preview-clips').value) || 10,
    clipDuration: parseFloat(document.getElementById('preview-clip-duration').value) || 1,
    includeAudio: document.getElementById('preview-audio').checked,
  };

  const en = window.I18n && window.I18n.lang === 'en';
  const fmtLabel = fmt === 'gif' ? 'GIF' : (fmt === 'webp' ? 'WebP' : 'MP4');
  const fpsLabel = s.fps > 0 ? `${s.fps}fps` : t('原始帧率');
  const totalDur = Math.round(s.clips * s.clipDuration * 10) / 10;
  const parts = [
    fmtLabel,
    previewIsHevc(codec) ? 'H.265' : 'H.264',
    `${s.width}px`,
    fpsLabel,
    en ? `${s.clips}×${s.clipDuration}s≈${totalDur}s` : `${s.clips}段×${s.clipDuration}s≈${totalDur}s`,
  ];
  if (fmt === 'mp4') parts.push(s.includeAudio ? t('含音频') : t('无音频'));

  let warn = '';
  if (videoInfo && videoInfo.duration) {
    const maxFit = Math.floor(videoInfo.duration / s.clipDuration);
    if (maxFit < 1) {
      warn = en ? ' · video is short → whole clip transcoded' : ' · 视频较短，将直接转码整段';
    } else if (s.clips > maxFit) {
      warn = en ? ` · only ${maxFit} clip(s) fit` : ` · 实际仅切 ${maxFit} 段`;
    }
  }
  const est = formatSize(estimatePreviewBytes(s));
  hint.textContent = en
    ? `Current: ${parts.join(' · ')} · est. ~${est}${warn}`
    : `当前设置：${parts.join(' · ')} · 预计体积 ~${est}（估算）${warn}`;
  updateCompatHints();
}

// ============ Audio Options ============
function updateAudioBitrateOptions() {
  const codec = document.getElementById('audio-codec').value;
  const bitrateSelect = document.getElementById('audio-bitrate');

  if (codec === 'aac') {
    bitrateSelect.innerHTML = `
      <option value="96k">96 kbps</option>
      <option value="128k" selected>128 kbps</option>
      <option value="160k">160 kbps</option>
      <option value="192k">192 kbps</option>
      <option value="256k">256 kbps</option>
    `;
  } else if (codec === 'mp3') {
    bitrateSelect.innerHTML = `
      <option value="128k" selected>128 kbps</option>
      <option value="192k">192 kbps</option>
      <option value="256k">256 kbps</option>
      <option value="320k">320 kbps</option>
    `;
  } else if (codec === 'opus') {
    bitrateSelect.innerHTML = `
      <option value="32k" selected>32 kbps</option>
      <option value="64k">64 kbps</option>
      <option value="96k">96 kbps</option>
      <option value="128k">128 kbps</option>
      <option value="192k">192 kbps</option>
    `;
  }

  updateAudioBitrateHint();
}

// ---- 多音轨（MTS/MKV 等常见多语言音轨）----
// 当前文件的音轨列表，来自 ffprobe；index 即 ffmpeg 的 -map 0:a:<index>
let currentAudioTracks = [];

const LANG_NAMES = {
  chi: ['中文', 'Chinese'], zho: ['中文', 'Chinese'], cmn: ['中文', 'Chinese'], yue: ['粤语', 'Cantonese'],
  eng: ['英语', 'English'], jpn: ['日语', 'Japanese'], kor: ['韩语', 'Korean'],
  fra: ['法语', 'French'], fre: ['法语', 'French'], deu: ['德语', 'German'], ger: ['德语', 'German'],
  spa: ['西班牙语', 'Spanish'], rus: ['俄语', 'Russian'], ita: ['意大利语', 'Italian'],
  por: ['葡萄牙语', 'Portuguese'], tha: ['泰语', 'Thai'], vie: ['越南语', 'Vietnamese'],
  ara: ['阿拉伯语', 'Arabic'], hin: ['印地语', 'Hindi'], ind: ['印尼语', 'Indonesian'],
  zh: ['中文', 'Chinese'], en: ['英语', 'English'], ja: ['日语', 'Japanese'], ko: ['韩语', 'Korean'],
};

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function langLabel(code) {
  const key = String(code || '').toLowerCase();
  if (!key || key === 'und') return '';
  const hit = LANG_NAMES[key] || LANG_NAMES[key.split('-')[0]];
  if (hit) return window.I18n.lang === 'en' ? hit[1] : hit[0];
  return code.toUpperCase();
}

function channelLabel(tr) {
  if (tr.channels === 1) return t('单声道');
  if (tr.channels === 2) return t('立体声');
  if (tr.channels === 6) return '5.1';
  if (tr.channels === 8) return '7.1';
  return tr.channels ? `${tr.channels}ch` : '';
}

// 音轨描述：#序号 · 标题 · 语言 · 编码 · 声道 · 码率 · 默认
function audioTrackLabel(tr) {
  const parts = [`#${tr.index + 1}`];
  if (tr.title) parts.push(tr.title);
  const lang = langLabel(tr.language);
  if (lang) parts.push(lang);
  if (tr.codec) parts.push(tr.codec.toUpperCase());
  const ch = channelLabel(tr);
  if (ch) parts.push(ch);
  if (tr.bitrate) parts.push(`${Math.round(tr.bitrate / 1000)} kbps`);
  if (tr.isDefault) parts.push(t('默认'));
  return parts.join(' · ');
}

function collectSelectedAudioTracks() {
  return [...document.querySelectorAll('.audio-track-check')]
    .filter(el => el.checked)
    .map(el => parseInt(el.dataset.index, 10));
}

// 只有多于一条音轨才显示选择列表；单音轨/无音轨时行为与以前完全一致
function renderAudioTracks() {
  const block = document.getElementById('audio-tracks-block');
  const list = document.getElementById('audio-tracks');
  if (!block || !list) return;

  if (currentAudioTracks.length < 2) {
    block.classList.add('hidden');
    list.innerHTML = '';
    return;
  }

  // 语言切换会重新渲染，保留已有勾选；首次渲染（无 checkbox）默认全选
  const hadBoxes = list.querySelector('.audio-track-check') !== null;
  const prev = hadBoxes ? collectSelectedAudioTracks() : currentAudioTracks.map(tr => tr.index);

  block.classList.remove('hidden');
  list.innerHTML = currentAudioTracks.map(tr => `
    <label class="checkbox-label track-item">
      <input type="checkbox" class="audio-track-check" data-index="${tr.index}"${prev.includes(tr.index) ? ' checked' : ''}>
      <span class="checkbox-custom"></span>
      <span class="track-text">${escHtml(audioTrackLabel(tr))}</span>
    </label>
  `).join('');

  list.querySelectorAll('.audio-track-check').forEach(el => el.addEventListener('change', syncAudioTracksAll));
  syncAudioTracksAll();
}

// 同步「全选」勾选框的三态显示
function syncAudioTracksAll() {
  const all = document.getElementById('audio-tracks-all');
  if (!all) return;
  const boxes = [...document.querySelectorAll('.audio-track-check')];
  const checked = boxes.filter(el => el.checked).length;
  all.checked = boxes.length > 0 && checked === boxes.length;
  all.indeterminate = checked > 0 && checked < boxes.length;
}

function setupAudioTracks() {
  const all = document.getElementById('audio-tracks-all');
  if (!all) return;
  all.addEventListener('change', () => {
    document.querySelectorAll('.audio-track-check').forEach(el => { el.checked = all.checked; });
    syncAudioTracksAll();
  });
}

function updateAudioBitrateHint() {
  const codec = document.getElementById('audio-codec').value;
  const bitrate = document.getElementById('audio-bitrate').value;
  const hint = document.getElementById('audio-hint');

  const en = window.I18n && window.I18n.lang === 'en';
  const hints = en ? {
    aac: {
      '96k': 'AAC 96kbps — fine for speech, small files',
      '128k': 'AAC 128kbps — transparent for most listeners; plays on every device',
      '160k': 'AAC 160kbps — high quality music',
      '192k': 'AAC 192kbps — very high quality',
      '256k': 'AAC 256kbps — top quality (iTunes-grade)',
    },
    mp3: {
      '128k': 'MP3 128kbps — good for speech/podcasts; music may show compression artifacts',
      '192k': 'MP3 192kbps — enough for most cases; hard to tell from the original',
      '256k': 'MP3 256kbps — high quality for quality-sensitive use',
      '320k': 'MP3 320kbps — top quality, larger files',
    },
    opus: {
      '32k': 'Opus 32kbps — very efficient, great for speech; fine for everyday use',
      '64k': 'Opus 64kbps — high quality, near-indistinguishable from higher rates',
      '96k': 'Opus 96kbps — very high quality for sensitive material',
      '128k': 'Opus 128kbps — ultra high quality, beyond most listeners',
      '192k': 'Opus 192kbps — top quality for professional audio',
    }
  } : {
    aac: {
      '96k': 'AAC 96kbps 适合语音，体积小',
      '128k': 'AAC 128kbps 多数人听不出与原始的区别，所有设备都能播放',
      '160k': 'AAC 160kbps 高品质音乐',
      '192k': 'AAC 192kbps 极高品质',
      '256k': 'AAC 256kbps 顶级品质（iTunes 同级）',
    },
    mp3: {
      '128k': 'MP3 128kbps 适合语音播客，音乐场景可能听出压缩痕迹',
      '192k': 'MP3 192kbps 对大多数场景已足够，基本听不出与原始音质的区别',
      '256k': 'MP3 256kbps 高品质，适合对音质有要求的场景',
      '320k': 'MP3 320kbps 最高品质，文件较大但音质最佳',
    },
    opus: {
      '32k': 'Opus 32kbps 效率极高，适合语音场景，推荐日常使用',
      '64k': 'Opus 64kbps 高品质，基本听不出与高码率的区别',
      '96k': 'Opus 96kbps 极高品质，适合对音质敏感的场景',
      '128k': 'Opus 128kbps 超高品质，远超大多数人的听觉分辨能力',
      '192k': 'Opus 192kbps 顶级品质，适合专业音频工作',
    }
  };

  hint.textContent = (hints[codec] && hints[codec][bitrate]) || '';
  updateCompatHints();
}

// ============ Sprite Interval ============
function updateSpriteInterval() {
  const interval = document.getElementById('sprite-interval').value;
  document.getElementById('sprite-interval-label').textContent = interval + 's';
}

function calculateSpriteInterval(duration) {
  // 根据视频时长自动计算合适的间隔，目标约20-30帧
  let interval = Math.max(2, Math.min(60, Math.round(duration / 25)));
  document.getElementById('sprite-interval').value = interval;
  document.getElementById('sprite-interval-label').textContent = interval + 's';
}

// ============ Preview Hint ============

// ============ Task Execution ============
async function runTasks() {
  if (!currentFile) return;

  const outputDir = settings.outputDir || currentFile.replace(/[/\\][^/\\]+$/, '');
  
  // 只移除「空闲」占位项，保留截帧/导出等历史记录
  getActiveLogLists().forEach(logList => {
    logList.querySelectorAll('.log-item').forEach(item => {
      if (item.querySelector('.log-status.idle')) item.remove();
    });
  });

  const tasks = {};

  // 收集启用的任务
  if (document.getElementById('audio-enable').checked) {
    tasks.audio = {
      codec: document.getElementById('audio-codec').value,
      bitrate: document.getElementById('audio-bitrate').value,
    };
    // 多音轨：把勾选的音轨传给主进程逐条导出；单音轨不传，沿用默认行为
    if (currentAudioTracks.length > 1) {
      const selected = collectSelectedAudioTracks();
      if (selected.length === 0) {
        addLog('system', '请至少选择一条音轨', 'error');
        return;
      }
      tasks.audio.tracks = selected;
    }
  }

  if (document.getElementById('sprite-enable').checked) {
    tasks.sprite = {
      width: parseInt(document.getElementById('sprite-width').value) || 160,
      cols: parseInt(document.getElementById('sprite-cols').value) || 10,
      interval: parseInt(document.getElementById('sprite-interval').value) || 10,
      quality: 75,
      format: 'webp',
    };
  }

  if (document.getElementById('preview-enable').checked) {
    tasks.preview = {
      width: parseInt(document.getElementById('preview-width').value) || 640,
      codec: document.getElementById('preview-codec').value,
      format: document.getElementById('preview-format').value,
      fps: parseFloat(document.getElementById('preview-fps').value) || 0,
      gifColors: parseInt(document.getElementById('preview-gif-colors').value) || 256,
      webpQuality: parseInt(document.getElementById('preview-webp-quality').value) || 70,
      clips: parseInt(document.getElementById('preview-clips').value) || 5,
      clipDuration: parseFloat(document.getElementById('preview-clip-duration').value) || 1,
      random: document.getElementById('preview-random').checked,
      includeAudio: document.getElementById('preview-audio').checked,
    };
  }

  // 视频较短时不再拦截：generatePreview 会自动切换为「整段直接转码」模式

  if (Object.keys(tasks).length === 0) {
    addLog('system', '请至少选择一个任务', 'error');
    return;
  }

  // 禁用按钮
  document.getElementById('btn-run-tasks').disabled = true;

  // 并行执行：各任务走独立的 ffmpeg 子进程，进度按 taskId 各自更新队列行
  const jobs = [];

  if (tasks.audio) {
    addLog('audio', '准备中...', 'running');
    jobs.push(
      window.api.extractAudio({ inputPath: currentFile, outputDir, options: tasks.audio })
        .then(res => applyResult('audio', res, res.outputPath))
    );
  }

  if (tasks.sprite) {
    addLog('sprite', '准备中...', 'running');
    jobs.push(
      window.api.generateSprite({ inputPath: currentFile, outputDir, options: tasks.sprite })
        .then(res => applyResult('sprite', res, res.spritePath))
    );
  }

  if (tasks.preview) {
    addLog('preview', '准备中...', 'running');
    const estBytes = estimatePreviewBytes(tasks.preview); // 记录本次预估，用于完成后校准
    jobs.push(
      window.api.generatePreview({ inputPath: currentFile, outputDir, options: tasks.preview })
        .then(res => {
          applyResult('preview', res, res.outputPath);
          if (res.success && res.size) calibrateSize(tasks.preview, estBytes, res.size);
        })
    );
  }

  await Promise.allSettled(jobs);

  // 恢复按钮
  document.getElementById('btn-run-tasks').disabled = false;
}

// 翻译来自主进程的进度/阶段文案（精确匹配 + 组合文案正则）
function translateProgress(msg) {
  if (!msg || !window.I18n || window.I18n.lang !== 'en') return msg;
  const exact = t(msg);
  if (exact !== msg) return exact;
  let m;
  if ((m = msg.match(/^截取片段 (\d+)\/(\d+)$/))) return `Extracting clip ${m[1]}/${m[2]}`;
  if ((m = msg.match(/^开始提取音频 \((.+)\)\.\.\.$/))) return `Extracting audio (${m[1]})...`;
  if ((m = msg.match(/^开始生成预览 \((.+)\)\.\.\.$/))) return `Generating preview (${m[1]})...`;
  if ((m = msg.match(/^批量截帧完成，共 (\d+) 帧$/))) return `Batch frames done — ${m[1]} frames`;
  if ((m = msg.match(/^音频提取完成，共 (\d+) 条音轨$/))) return `Audio extracted — ${m[1]} tracks`;
  // 多音轨进度形如「音轨 2/3：提取音频中」，前缀单独译，后半段递归走本函数
  if ((m = msg.match(/^音轨 (\d+)\/(\d+)：(.+)$/))) return `Track ${m[1]}/${m[2]}: ${translateProgress(m[3])}`;
  if ((m = msg.match(/^(.+?)失败:\s*(.*)$/))) {
    const map = { '音频提取': 'Audio extraction', '雪碧图生成': 'Sprite generation', '预览视频生成': 'Preview generation', '截帧': 'Frame capture', '批量截帧': 'Batch frames', '导出': 'Export' };
    return `${map[m[1]] || m[1]} failed: ${m[2]}`;
  }
  return msg;
}

// ============ Progress ============
function setupProgressListener() {
  window.api.onProgress(({ taskId, progress, message }) => {
    // 批量模式：把当前文件行的状态更新为「任务 百分比」
    if (batchRunning && batchActiveIndex >= 0 && progress >= 0) {
      const f = batchFiles[batchActiveIndex];
      const tk = f && f.tasks && f.tasks.find(x => x.key === taskId);
      if (tk && tk.status !== 'done' && tk.status !== 'error') {
        tk.status = 'processing';
        tk.pct = progress;
        updateBatchTaskState(batchActiveIndex, taskId);
      }
    }
    // 单文件模式：更新任务队列卡片（批量视图下这些卡片隐藏，updateXX 自动空操作）
    if (progress < 0) {
      updateLog(taskId, translateProgress(message), 'error');
    } else {
      updateProgress(taskId, progress, translateProgress(message));
    }
  });
}

// ============ Logging ============
function resetLogs() {
  const logLists = getActiveLogLists();
  logLists.forEach(logList => {
    logList.innerHTML = `
      <div class="log-item">
        <span class="log-task">${t('系统')}</span>
        <span class="log-msg">${t('等待任务开始...')}</span>
        <span class="log-status idle">${t('空闲')}</span>
      </div>
    `;
  });
}

function getActiveLogLists() {
  const lists = [];
  const logSide = document.getElementById('log-list-side');
  const logBottom = document.getElementById('log-list-bottom');
  
  if (logSide && logSide.offsetParent !== null) {
    lists.push(logSide);
  }
  if (logBottom && logBottom.offsetParent !== null) {
    lists.push(logBottom);
  }
  return lists;
}

function addLog(taskId, message, status) {
  const taskNames = {
    frame: '截帧',
    frames: '批量截帧',
    audio: '音频',
    sprite: '雪碧图',
    preview: '预览',
    system: '系统'
  };

  const logLists = getActiveLogLists();

  logLists.forEach(logList => {
    // 同名任务重跑时替换旧卡片，避免重复 id
    const old = document.getElementById(`log-${taskId}-${logList.id}`);
    if (old) old.remove();

    const item = document.createElement('div');
    item.className = 'log-item' + (status === 'running' ? ' running' : '');
    item.id = `log-${taskId}-${logList.id}`;
    item.dataset.task = taskId;
    item.innerHTML = `
      <span class="log-task">${t(taskNames[taskId] || taskId)}</span>
      <span class="log-msg">${translateProgress(message)}</span>
      <span class="log-status ${status}">${statusInner(status)}</span>
    `;
    logList.appendChild(item);
    logList.scrollTop = logList.scrollHeight;
  });
}

// 根据任务返回结果更新队列卡片（完成/失败/已终止）
function applyResult(taskId, res, filePath) {
  if (res.success) {
    // 多音轨：状态里带上条数；「打开」仍指向第一条产物，「文件夹」可看到全部
    const extra = res.count > 1
      ? (window.I18n.lang === 'en' ? ` (${res.count} tracks)` : `（${res.count} 条音轨）`)
      : '';
    updateLog(taskId, t('完成') + extra + compatWarningSuffix(res), 'success', filePath);
  } else if (res.cancelled) {
    updateLog(taskId, t('已终止'), 'cancelled');
  } else if (res.skipped) {
    updateLog(taskId, t('原视频没有音轨，已跳过'), 'cancelled');
  } else {
    updateLog(taskId, t('失败') + ': ' + res.error, 'error');
    if (res.details) attachErrorDetails(taskId, res.details);
  }
}

// 失败时附加可展开的 ffmpeg 详情（取 stderr 末尾若干行）
function attachErrorDetails(taskId, details) {
  const tail = String(details).trim().split('\n').slice(-40).join('\n');
  getActiveLogLists().forEach(logList => {
    const item = document.getElementById(`log-${taskId}-${logList.id}`);
    if (!item) return;

    const statusEl = item.querySelector('.log-status');
    if (statusEl && !statusEl.querySelector('.log-details-toggle')) {
      const btn = document.createElement('button');
      btn.className = 'log-details-toggle';
      btn.type = 'button';
      btn.textContent = t('详情');
      statusEl.appendChild(btn);
    }

    let pre = item.querySelector('.log-details');
    if (!pre) {
      pre = document.createElement('pre');
      pre.className = 'log-details';
      item.appendChild(pre);
    }
    pre.textContent = tail;
  });
}

// 点击「终止」：通知主进程取消，并即时反馈
function cancelTask(taskId) {
  window.api.cancelTask(taskId);
  getActiveLogLists().forEach(logList => {
    const item = document.getElementById(`log-${taskId}-${logList.id}`);
    if (item) {
      const msg = item.querySelector('.log-msg');
      if (msg) msg.textContent = t('正在终止...');
    }
  });
}

// 构建打开/文件夹小按钮
function makeLogAction(label, type) {
  const btn = document.createElement('button');
  btn.className = 'log-action';
  const icon = type === 'file'
    ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>';
  btn.innerHTML = icon + label;
  return btn;
}

// 每次截帧导出追加一条独立的「截帧」记录（含打开/文件夹与格式/尺寸/质量/大小）
let frameExportSeq = 0;
function addFrameExportRecord(message, file, dir) {
  const seq = ++frameExportSeq;
  getActiveLogLists().forEach(logList => {
    const item = document.createElement('div');
    item.className = 'log-item success';
    item.id = `log-frameexport-${seq}-${logList.id}`;
    item.dataset.task = 'frame';

    const task = document.createElement('span');
    task.className = 'log-task';
    task.textContent = t('截帧');

    const msg = document.createElement('span');
    msg.className = 'log-msg';
    msg.textContent = message;

    const status = document.createElement('span');
    status.className = 'log-status success';

    const actions = document.createElement('span');
    actions.className = 'log-actions';
    if (file) {
      const openBtn = makeLogAction(t('打开'), 'file');
      openBtn.addEventListener('click', () => window.api.openFile(file));
      actions.appendChild(openBtn);
    }
    if (dir) {
      const folderBtn = makeLogAction(t('文件夹'), 'folder');
      folderBtn.addEventListener('click', () => window.api.openFolder(dir));
      actions.appendChild(folderBtn);
    }
    status.appendChild(actions);
    const dot = document.createElement('span');
    dot.className = 'status-dot';
    status.appendChild(dot);
    status.appendChild(document.createTextNode(t('完成')));

    item.appendChild(task);
    item.appendChild(msg);
    item.appendChild(status);
    logList.appendChild(item);
    logList.scrollTop = logList.scrollHeight;
  });
}

// 状态区内容：运行中显示百分比，其余显示发光圆点 + 文案
function statusInner(status, percent = 0) {
  if (status === 'running') {
    const p = Math.round(percent);
    return `<span class="log-pie" style="--p:${p}"><span class="log-pct">${p}%</span></span>` +
      `<button class="log-cancel" type="button" title="终止任务"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h12v12H6z"/></svg></button>`;
  }
  if (status === 'success') return '<span class="status-dot"></span>' + t('完成');
  if (status === 'error') return '<span class="status-dot"></span>' + t('失败');
  if (status === 'cancelled') return '<span class="status-dot"></span>' + t('已终止');
  return '<span class="status-dot"></span>' + t('空闲');
}

// 更新运行中任务的进度条与百分比
function updateProgress(taskId, percent, message) {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  getActiveLogLists().forEach(logList => {
    const item = document.getElementById(`log-${taskId}-${logList.id}`);
    if (!item) return;
    item.classList.add('running');
    if (message) item.querySelector('.log-msg').textContent = message;
    const statusEl = item.querySelector('.log-status');
    statusEl.className = 'log-status running';
    const pie = statusEl.querySelector('.log-pie');
    const pctEl = statusEl.querySelector('.log-pct');
    if (pie && pctEl) {
      pie.style.setProperty('--p', p);
      pctEl.textContent = p + '%';
    } else {
      statusEl.innerHTML = statusInner('running', p);
    }
  });
}

function updateLog(taskId, message, status, filePath) {
  const logLists = getActiveLogLists();
  
  logLists.forEach(logList => {
    const item = document.getElementById(`log-${taskId}-${logList.id}`);
    if (!item) return;

    item.classList.remove('running', 'success', 'error', 'cancelled');
    if (['success', 'error', 'cancelled'].includes(status)) item.classList.add(status);
    item.querySelector('.log-msg').textContent = message;
    const statusEl = item.querySelector('.log-status');
    statusEl.className = `log-status ${status}`;
    
    if (status === 'success' && filePath) {
      // 使用自定义属性存储路径，避免HTML转义问题
      statusEl.innerHTML = `
        <span class="log-actions">
          <button class="log-action btn-open-file">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>
            ${t('打开')}
          </button>
          <button class="log-action btn-open-folder">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
            ${t('文件夹')}
          </button>
        </span>
        <span class="status-dot"></span>${t('完成')}
      `;
      
      // 绑定事件，使用闭包保存路径
      const openBtn = statusEl.querySelector('.btn-open-file');
      const folderBtn = statusEl.querySelector('.btn-open-folder');
      
      openBtn.addEventListener('click', () => {
        console.log('Opening file:', filePath);
        window.api.openFile(filePath);
      });
      
      folderBtn.addEventListener('click', () => {
        console.log('Opening folder:', filePath);
        window.api.openFolder(filePath);
      });
    } else {
      statusEl.innerHTML = statusInner(status);
    }
    
    logList.scrollTop = logList.scrollHeight;
  });
}

async function openFile(filePath) {
  await window.api.openFile(filePath);
}

async function openFolder(filePath) {
  await window.api.openFolder(filePath);
}

// ============ Utilities ============
function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatTimePrecise(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

// ============ Settings ============
function openSettings() {
  document.getElementById('modal-settings').classList.remove('hidden');
  document.getElementById('setting-output-dir').value = settings.outputDir || '';
  document.getElementById('setting-lang').value = settings.lang || window.I18n.lang;
}

function closeSettings() {
  document.getElementById('modal-settings').classList.add('hidden');
}

async function saveSettings() {
  settings.outputDir = document.getElementById('setting-output-dir').value;
  await window.api.saveSettings(settings);
  closeSettings();
}

// ============ 模式切换（单文件 / 批量） ============
function setupModeTabs() {
  document.querySelectorAll('.mode-tab').forEach(tab => {
    tab.addEventListener('click', () => switchMode(tab.dataset.mode));
  });
}

function switchMode(mode) {
  document.querySelectorAll('.mode-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
  document.getElementById('view-single').classList.toggle('hidden', mode !== 'single');
  document.getElementById('view-batch').classList.toggle('hidden', mode !== 'batch');
}

// ============ 批量处理 ============
let batchFiles = [];
let batchRunning = false;
let batchCancelAll = false;
let batchActiveIndex = -1;

function setupBatch() {
  document.getElementById('batch-add').addEventListener('click', addBatchFiles);
  const drop = document.getElementById('batch-drop');
  drop.addEventListener('click', addBatchFiles);
  document.getElementById('batch-clear').addEventListener('click', () => {
    if (batchRunning) return;
    batchFiles = [];
    renderBatchList();
  });
  document.getElementById('batch-run').addEventListener('click', runBatch);
  document.getElementById('batch-stop').addEventListener('click', stopBatch);

  document.getElementById('b-preview-format').addEventListener('change', updateBatchPreviewFields);
  document.getElementById('b-preview-webp-quality').addEventListener('input', () => {
    document.getElementById('b-preview-webp-quality-label').textContent = document.getElementById('b-preview-webp-quality').value;
  });

  document.getElementById('b-frames-format').addEventListener('change', updateBatchFramesFields);
  document.getElementById('b-frames-quality').addEventListener('input', () => {
    document.getElementById('b-frames-quality-label').textContent = document.getElementById('b-frames-quality').value;
  });

  updateBatchPreviewFields();
  updateBatchFramesFields();
  renderBatchList();
}

// 间隔截帧：PNG 无损 → 隐藏画质
function updateBatchFramesFields() {
  const fmt = document.getElementById('b-frames-format').value;
  const el = document.getElementById('b-fr-quality');
  if (el) el.style.display = fmt === 'png' ? 'none' : '';
}

function updateBatchPreviewFields() {
  const fmt = document.getElementById('b-preview-format').value;
  const t = (id, show) => { const el = document.getElementById(id); if (el) el.style.display = show ? '' : 'none'; };
  t('b-pv-codec', fmt === 'mp4');
  t('b-pv-gifcolors', fmt === 'gif');
  t('b-pv-webpquality', fmt === 'webp');
}

async function addBatchFiles() {
  if (batchRunning) return;
  const paths = await window.api.selectFiles();
  (paths || []).forEach(addBatchPath);
  renderBatchList();
}

function addBatchPath(p) {
  if (!p) return;
  if (batchFiles.some(f => f.path === p)) return; // 去重
  batchFiles.push({ path: p, name: p.split(/[/\\]/).pop(), status: 'pending', tasks: [], okCount: 0, total: 0, folder: '' });
}

const BATCH_TASK_NAMES = { audio: '音频', sprite: '雪碧图', preview: '预览', frames: '截帧' };

function btStateText(tk) {
  if (tk.status === 'processing') return Math.round(tk.pct) + '%';
  if (tk.status === 'done') return '✓';
  if (tk.status === 'error') return '✗';
  if (tk.status === 'skipped') return t('已跳过');
  return t('等待');
}

function batchBadge(f) {
  if (f.status === 'processing') return { cls: 'processing', txt: t('处理中') };
  if (f.status === 'done') return { cls: 'done', txt: t('完成') + ' ' + f.okCount + '/' + f.total };
  if (f.status === 'error') return { cls: 'error', txt: t('失败') + ' ' + f.okCount + '/' + f.total };
  if (f.status === 'stopped') return { cls: '', txt: t('已停止') };
  return { cls: '', txt: t('等待') };
}

function renderBatchList() {
  const list = document.getElementById('batch-list');
  const drop = document.getElementById('batch-drop');
  if (!list) return;
  document.getElementById('batch-count').textContent = batchFiles.length;
  if (drop) drop.style.display = batchFiles.length ? 'none' : '';
  list.innerHTML = '';
  batchFiles.forEach((f, i) => {
    const row = document.createElement('div');
    const borderCls = ['processing', 'done', 'error'].includes(f.status) ? ' ' + f.status : '';
    row.className = 'batch-item' + borderCls;
    row.dataset.index = i;

    // 顶部：文件名 + 状态徽章 + 文件夹/移除
    const top = document.createElement('div');
    top.className = 'batch-item-top';
    const name = document.createElement('span');
    name.className = 'batch-item-name';
    name.textContent = f.name;
    name.title = f.path;
    top.appendChild(name);

    const b = batchBadge(f);
    const badge = document.createElement('span');
    badge.className = 'batch-item-status' + (b.cls ? ' ' + b.cls : '');
    badge.textContent = b.txt;
    top.appendChild(badge);

    if (f.status === 'done' && f.folder) {
      const fb = document.createElement('button');
      fb.className = 'batch-item-folder';
      fb.title = t('文件夹');
      fb.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>' + t('文件夹');
      fb.addEventListener('click', () => window.api.openFolder(f.folder));
      top.appendChild(fb);
    }

    if (!batchRunning) {
      const rm = document.createElement('button');
      rm.className = 'batch-item-remove';
      rm.textContent = '✕';
      rm.title = t('移除');
      rm.addEventListener('click', () => {
        if (batchRunning) return;
        batchFiles.splice(i, 1);
        renderBatchList();
      });
      top.appendChild(rm);
    }
    row.appendChild(top);

    // 任务竖排：各任务独立进度
    if (f.tasks && f.tasks.length) {
      const tasksEl = document.createElement('div');
      tasksEl.className = 'batch-item-tasks';
      f.tasks.forEach(tk => {
        const tr = document.createElement('div');
        tr.className = 'batch-task-row';
        tr.dataset.key = tk.key;

        const tn = document.createElement('span');
        tn.className = 'bt-name';
        tn.textContent = t(BATCH_TASK_NAMES[tk.key] || tk.key);
        tr.appendChild(tn);

        const bar = document.createElement('span');
        bar.className = 'bt-bar';
        const fill = document.createElement('span');
        fill.className = 'bt-bar-fill';
        fill.style.width = (tk.status === 'done' ? 100 : (tk.status === 'processing' ? Math.round(tk.pct) : 0)) + '%';
        bar.appendChild(fill);
        tr.appendChild(bar);

        const state = document.createElement('span');
        state.className = 'bt-state ' + tk.status;
        state.textContent = btStateText(tk);
        tr.appendChild(state);

        tasksEl.appendChild(tr);
      });
      row.appendChild(tasksEl);
    }

    list.appendChild(row);
  });
}

// 进行中轻量更新某个任务的进度条与状态（不重建整行，避免闪烁）
function updateBatchTaskState(i, key) {
  const f = batchFiles[i];
  if (!f) return;
  const tk = f.tasks.find(x => x.key === key);
  if (!tk) return;
  const tr = document.querySelector('.batch-item[data-index="' + i + '"] .batch-task-row[data-key="' + key + '"]');
  if (!tr) return;
  const fill = tr.querySelector('.bt-bar-fill');
  if (fill) fill.style.width = (tk.status === 'done' ? 100 : (tk.status === 'processing' ? Math.round(tk.pct) : 0)) + '%';
  const state = tr.querySelector('.bt-state');
  if (state) { state.className = 'bt-state ' + tk.status; state.textContent = btStateText(tk); }
}

function setBatchProgress(msg) {
  const el = document.getElementById('batch-progress');
  if (el) el.textContent = msg;
}

function collectBatchTasks() {
  const gi = (id, d) => parseInt(document.getElementById(id).value) || d;
  const gf = (id, d) => parseFloat(document.getElementById(id).value) || d;
  const gv = id => document.getElementById(id).value;
  const chk = id => document.getElementById(id).checked;
  const tasks = {};
  // 批量模式无法逐个文件选轨，因此只给「全部音轨 / 仅默认音轨」两种模式
  if (chk('b-audio-enable')) tasks.audio = {
    codec: gv('b-audio-codec'), bitrate: gv('b-audio-bitrate'),
    trackMode: chk('b-audio-all-tracks') ? 'all' : 'default',
  };
  if (chk('b-sprite-enable')) tasks.sprite = { width: gi('b-sprite-width', 160), cols: gi('b-sprite-cols', 10), interval: gi('b-sprite-interval', 10), quality: 75, format: 'webp' };
  if (chk('b-preview-enable')) tasks.preview = {
    width: gi('b-preview-width', 640), codec: gv('b-preview-codec'), format: gv('b-preview-format'),
    fps: gf('b-preview-fps', 0), gifColors: gi('b-preview-gif-colors', 256), webpQuality: gi('b-preview-webp-quality', 70),
    clips: gi('b-preview-clips', 10), clipDuration: gf('b-preview-clip-duration', 1), random: true, includeAudio: false
  };
  if (chk('b-frames-enable')) tasks.frames = { interval: gi('b-frames-interval', 5), format: gv('b-frames-format'), height: gi('b-frames-size', 0), quality: gi('b-frames-quality', 85) };
  return tasks;
}

async function runBatch() {
  if (batchRunning) return;
  if (batchFiles.length === 0) { alert(t('请先添加视频文件')); return; }
  const tasks = collectBatchTasks();
  if (Object.keys(tasks).length === 0) { alert(t('请至少启用一个任务')); return; }

  batchRunning = true;
  batchCancelAll = false;
  document.getElementById('batch-run').disabled = true;
  document.getElementById('batch-stop').disabled = false;
  document.getElementById('batch-add').disabled = true;

  const enabledKeys = ['audio', 'sprite', 'preview', 'frames'].filter(k => tasks[k]);
  batchFiles.forEach(f => {
    f.status = 'pending';
    f.okCount = 0;
    f.total = enabledKeys.length;
    f.tasks = enabledKeys.map(k => ({ key: k, status: 'pending', pct: 0 }));
  });
  renderBatchList();

  let done = 0, failed = 0;
  for (let i = 0; i < batchFiles.length; i++) {
    if (batchCancelAll) break;
    const f = batchFiles[i];
    batchActiveIndex = i;
    f.status = 'processing';
    renderBatchList();
    setBatchProgress((window.I18n.lang === 'en' ? 'Processing ' : '处理中 ') + (i + 1) + '/' + batchFiles.length + (window.I18n.lang === 'en' ? ': ' : '：') + f.name);

    const outputDir = settings.outputDir || f.path.replace(/[/\\][^/\\]+$/, '');
    const res = await processOneFile(f, i, outputDir, tasks);

    // 该文件的输出文件夹（<输出目录>/<文件名>）
    const sep = f.path.includes('\\') ? '\\' : '/';
    f.folder = outputDir + sep + f.name.replace(/\.[^.]+$/, '');

    f.okCount = res.okCount;
    if (res.cancelled) { f.status = 'stopped'; renderBatchList(); break; }
    if (res.ok) { f.status = 'done'; done++; }
    else { f.status = 'error'; failed++; }
    renderBatchList();
  }

  batchActiveIndex = -1;
  batchRunning = false;
  document.getElementById('batch-run').disabled = false;
  document.getElementById('batch-stop').disabled = true;
  document.getElementById('batch-add').disabled = false;
  if (window.I18n.lang === 'en') {
    setBatchProgress('Batch done: ' + done + ' ok, ' + failed + ' failed' + (batchCancelAll ? ' (stopped)' : ''));
  } else {
    setBatchProgress('批量结束：成功 ' + done + '，失败 ' + failed + (batchCancelAll ? '（已停止）' : ''));
  }
  renderBatchList();
}

// 单个文件：启用的任务并行执行；每个任务完成即更新自己的进度行
async function processOneFile(f, i, outputDir, tasks) {
  const inputPath = f.path;
  const calls = {
    audio: o => window.api.extractAudio(o),
    sprite: o => window.api.generateSprite(o),
    preview: o => window.api.generatePreview(o),
    frames: o => window.api.extractFrames(o),
  };
  const res = { ok: true, okCount: 0, total: f.tasks.length, cancelled: false };

  const jobs = f.tasks.map(tk =>
    calls[tk.key]({ inputPath, outputDir, options: tasks[tk.key] })
      .then(r => {
        if (r && r.success) { tk.status = 'done'; tk.pct = 100; res.okCount++; }
        else if (r && r.cancelled) { tk.status = 'error'; res.cancelled = true; }
        else if (r && r.skipped) { tk.status = 'skipped'; } // 无音轨等：跳过，不算失败
        else { tk.status = 'error'; res.ok = false; }
      })
      .catch(() => { tk.status = 'error'; res.ok = false; })
      .then(() => updateBatchTaskState(i, tk.key))
  );
  await Promise.all(jobs);
  if (res.cancelled) res.ok = false;
  return res;
}

function stopBatch() {
  if (!batchRunning) return;
  batchCancelAll = true;
  ['audio', 'sprite', 'preview'].forEach(t => window.api.cancelTask(t));
  setBatchProgress(t('正在停止…（当前文件结束后停止）'));
}

// ============ 预设 ============
function setupPresets() {
  document.getElementById('preset-select').addEventListener('change', onPresetSelect);
  document.getElementById('preset-save').addEventListener('click', openPresetModal);
  document.getElementById('preset-delete').addEventListener('click', deletePreset);
  document.getElementById('btn-close-preset').addEventListener('click', closePresetModal);
  document.getElementById('btn-cancel-preset').addEventListener('click', closePresetModal);
  document.getElementById('btn-confirm-preset').addEventListener('click', confirmPreset);
  renderPresets();
}

function getPresets() {
  return (settings.presets && typeof settings.presets === 'object') ? settings.presets : {};
}

function renderPresets() {
  const sel = document.getElementById('preset-select');
  if (!sel) return;
  const cur = sel.value;
  const presets = getPresets();
  sel.innerHTML = '';
  const def = document.createElement('option');
  def.value = '';
  def.textContent = t('预设：自定义');
  sel.appendChild(def);
  Object.keys(presets).forEach(name => {
    const o = document.createElement('option');
    o.value = name;
    o.textContent = name;
    sel.appendChild(o);
  });
  if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
}

function onPresetSelect() {
  const name = document.getElementById('preset-select').value;
  if (!name) return;
  const cfg = getPresets()[name];
  if (cfg) applyBatchConfig(cfg);
}

function getBatchConfig() {
  const v = id => document.getElementById(id).value;
  const c = id => document.getElementById(id).checked;
  return {
    audio: { enabled: c('b-audio-enable'), codec: v('b-audio-codec'), bitrate: v('b-audio-bitrate'), allTracks: c('b-audio-all-tracks') },
    sprite: { enabled: c('b-sprite-enable'), width: v('b-sprite-width'), cols: v('b-sprite-cols'), interval: v('b-sprite-interval') },
    preview: { enabled: c('b-preview-enable'), format: v('b-preview-format'), codec: v('b-preview-codec'), width: v('b-preview-width'), fps: v('b-preview-fps'), gifColors: v('b-preview-gif-colors'), webpQuality: v('b-preview-webp-quality'), clips: v('b-preview-clips'), clipDuration: v('b-preview-clip-duration') },
    frames: { enabled: c('b-frames-enable'), interval: v('b-frames-interval'), format: v('b-frames-format'), size: v('b-frames-size'), quality: v('b-frames-quality') },
  };
}

function applyBatchConfig(cfg) {
  const setV = (id, val) => { const el = document.getElementById(id); if (el && val !== undefined && val !== null) el.value = val; };
  const setC = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };
  // allTracks 是后加的字段，老预设里没有 → 默认按「全部音轨」处理
  if (cfg.audio) { setC('b-audio-enable', cfg.audio.enabled); setV('b-audio-codec', cfg.audio.codec); setV('b-audio-bitrate', cfg.audio.bitrate); setC('b-audio-all-tracks', cfg.audio.allTracks !== false); }
  if (cfg.sprite) { setC('b-sprite-enable', cfg.sprite.enabled); setV('b-sprite-width', cfg.sprite.width); setV('b-sprite-cols', cfg.sprite.cols); setV('b-sprite-interval', cfg.sprite.interval); }
  if (cfg.preview) {
    setC('b-preview-enable', cfg.preview.enabled);
    setV('b-preview-format', cfg.preview.format);
    setV('b-preview-codec', cfg.preview.codec);
    setV('b-preview-width', cfg.preview.width);
    setV('b-preview-fps', cfg.preview.fps);
    setV('b-preview-gif-colors', cfg.preview.gifColors);
    setV('b-preview-webp-quality', cfg.preview.webpQuality);
    setV('b-preview-clips', cfg.preview.clips);
    setV('b-preview-clip-duration', cfg.preview.clipDuration);
  }
  if (cfg.frames) {
    setC('b-frames-enable', cfg.frames.enabled);
    setV('b-frames-interval', cfg.frames.interval);
    setV('b-frames-format', cfg.frames.format);
    setV('b-frames-size', cfg.frames.size);
    setV('b-frames-quality', cfg.frames.quality);
  }
  document.getElementById('b-preview-webp-quality-label').textContent = document.getElementById('b-preview-webp-quality').value;
  document.getElementById('b-frames-quality-label').textContent = document.getElementById('b-frames-quality').value;
  updateBatchPreviewFields();
  updateBatchFramesFields();
}

function openPresetModal() {
  document.getElementById('preset-name-input').value = '';
  document.getElementById('modal-preset').classList.remove('hidden');
  setTimeout(() => document.getElementById('preset-name-input').focus(), 50);
}

function closePresetModal() {
  document.getElementById('modal-preset').classList.add('hidden');
}

function confirmPreset() {
  const name = document.getElementById('preset-name-input').value.trim();
  if (!name) { alert(t('请输入预设名称')); return; }
  if (!settings.presets) settings.presets = {};
  settings.presets[name] = getBatchConfig();
  window.api.saveSettings(settings);
  renderPresets();
  document.getElementById('preset-select').value = name;
  closePresetModal();
}

function deletePreset() {
  const name = document.getElementById('preset-select').value;
  if (!name) { alert(t('请先在下拉里选择一个预设')); return; }
  if (settings.presets) delete settings.presets[name];
  window.api.saveSettings(settings);
  renderPresets();
}
