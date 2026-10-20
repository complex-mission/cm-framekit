// Tauri 版 window.api：保持与旧 Electron preload 相同的接口，app.js 基本不用改。
(() => {
  const T = window.__TAURI__;
  const invoke = T.core.invoke;
  const win = T.window.getCurrentWindow();
  const dialog = T.dialog;
  const opener = T.opener;

  const VIDEO_EXT = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'ts', 'm2ts', 'mts', 'm4v', 'mpg', 'mpeg', 'vob', 'mxf', '3gp'];
  const videoFilters = () => [
    { name: t('视频文件'), extensions: VIDEO_EXT },
    { name: t('所有文件'), extensions: ['*'] },
  ];
  const t = (s) => (typeof window.t === 'function' ? window.t(s) : s);

  let mediaBase = null;
  const ready = invoke('media_base').then((b) => { mediaBase = b; }).catch(() => {});

  window.api = {
    ready,

    // 窗口控制
    windowMinimize: () => win.minimize(),
    windowMaximize: () => win.toggleMaximize(),
    windowClose: () => win.close(),
    windowIsMaximized: () => win.isMaximized(),

    // 文件选择
    selectFile: async () => {
      const r = await dialog.open({ title: t('选择视频文件'), multiple: false, filters: videoFilters() });
      return r || null;
    },
    selectFiles: async () => {
      const r = await dialog.open({ title: t('选择视频文件'), multiple: true, filters: videoFilters() });
      return Array.isArray(r) ? r : (r ? [r] : []);
    },
    selectDirectory: async (title) => (await dialog.open({ title: title || t('选择目录'), directory: true })) || null,

    // 拖拽：Tauri 拦截了系统拖放，HTML5 drop 拿不到路径，改用 webview 事件。
    // cb(paths, element) —— element 为落点处的 DOM 元素；onHover(element|null) 用于高亮
    onFileDrop: (cb, onHover) => {
      const at = (pos) => {
        const dpr = window.devicePixelRatio || 1;
        return pos ? document.elementFromPoint(pos.x / dpr, pos.y / dpr) : null;
      };
      T.webview.getCurrentWebview().onDragDropEvent((e) => {
        const p = e.payload;
        if (p.type === 'over' || p.type === 'enter') onHover && onHover(at(p.position));
        else if (p.type === 'leave') onHover && onHover(null);
        else if (p.type === 'drop') {
          onHover && onHover(null);
          if (p.paths && p.paths.length) cb(p.paths, at(p.position));
        }
      });
    },

    // 本地 HTTP 媒体地址（支持 Range，可拖动）
    mediaUrl: (filePath) => (mediaBase ? mediaBase + encodeURIComponent(filePath) : null),

    // 视频信息（含兼容性分析 data.compat）
    probeVideo: (filePath) => invoke('probe_video', { filePath }),
    // ffmpeg 解出某时刻的画面：WebView 放不了的格式用它预览/截帧
    grabFrame: (inputPath, time, maxWidth, full) => invoke('grab_frame', { inputPath, time, maxWidth, full }),

    // 任务
    extractFrames: (p) => invoke('extract_frames', p),
    extractAudio: (p) => invoke('extract_audio', p),
    generateSprite: (p) => invoke('generate_sprite', p),
    generatePreview: (p) => invoke('generate_preview', p),
    cancelTask: (taskId) => invoke('cancel_task', { taskId }),
    getHwEncoders: () => invoke('get_hw_encoders'),
    ffmpegInfo: () => invoke('ffmpeg_info'),

    // 截帧导出
    exportFrames: (p) => invoke('export_frames', { frames: p.frames, format: p.format, outputDir: p.outputDir, inputPath: p.inputPath }),

    // 文件操作
    openFile: async (filePath) => {
      try { await opener.openPath(filePath); return { success: true }; } catch (e) { return { success: false, error: String(e) }; }
    },
    openFolder: async (filePath) => {
      try { await opener.revealItemInDir(filePath); return { success: true }; } catch (e) { return { success: false, error: String(e) }; }
    },
    openExternal: async (url) => {
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { success: false, error: 'invalid url' };
      try { await opener.openUrl(url); return { success: true }; } catch (e) { return { success: false, error: String(e) }; }
    },

    // 进度
    onProgress: (callback) => { T.event.listen('task-progress', (e) => callback(e.payload)); },

    // 设置
    loadSettings: () => invoke('load_settings'),
    saveSettings: (settings) => invoke('save_settings', { settings }),
  };
})();
