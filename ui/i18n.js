// 轻量 i18n：以中文原文为键的 中->英 字典。
// 静态界面：启动时快照可翻译文本节点/属性，切换语言时整体替换。
// 动态字符串：JS 调用 window.t('中文') 取译文。
// 帮助正文：中英两套，整体切换。
(function () {
  const EN = {
    // 标题栏
    'CM视频工具箱': 'CM Video Toolkit',
    '此格式内置播放器无法直接播放，已切换为逐帧预览（截帧与导出不受影响）': 'This format cannot play in the built-in player; switched to frame-by-frame preview (capture and export still work)',
    '截帧失败: ': 'Frame capture failed: ',
    '视频文件': 'Video files',
    '所有文件': 'All files',
    '选择视频文件': 'Select video file',
    '选择目录': 'Select folder',
    'AAC 128kbps 音质好，所有设备都能播放': 'AAC 128kbps — great quality, plays on every device',
    'H.264 + AAC 全平台兼容，H.265 体积更小但依赖硬件解码': 'H.264 + AAC plays everywhere; H.265 is smaller but needs hardware decoding',
    '设置': 'Settings',
    '帮助': 'Help',
    '帮助与说明': 'Help & Guide',
    '软件编码': 'Software',
    // 模式标签
    '单文件精修': 'Single File',
    '批量处理': 'Batch',
    // 文件导入
    '拖拽视频文件到此处': 'Drag a video file here',
    '点击选择': 'Choose File',
    '支持 mp4, mkv, avi, mov, webm, flv, wmv, ts, m4v': 'Supports mp4, mkv, avi, mov, webm, flv, wmv, ts, m4v',
    '最近打开': 'Recent',
    '清空': 'Clear',
    '更换文件': 'Change File',
    '加载视频后显示预览': 'Preview appears after loading a video',
    // 面板标题
    '截帧': 'Capture',
    '音频提取': 'Audio Extraction',
    '雪碧图生成': 'Sprite Sheet',
    '预览视频': 'Preview Video',
    '自动间隔截帧': 'Interval Frames',
    '待处理文件 (': 'Files (',
    '添加视频': 'Add Videos',
    // 表单标签
    '输出宽度 (px)': 'Output Width (px)',
    '编码': 'Codec',
    '编码格式': 'Codec',
    '输出格式': 'Output Format',
    '帧率 (fps)': 'Frame Rate (fps)',
    '片段数量': 'Clips',
    '每段时长 (秒)': 'Clip Length (s)',
    '排序': 'Order',
    '随机排序': 'Random order',
    '包含音频轨道': 'Include audio',
    '音频': 'Audio',
    '码率': 'Bitrate',
    '缩略图宽度': 'Thumb Width',
    '缩略图宽度 (px)': 'Thumb Width (px)',
    '列数': 'Columns',
    '每行列数': 'Columns',
    '间隔 (秒)': 'Interval (s)',
    '截取间隔 (秒)': 'Interval (s)',
    '颜色数量': 'Colors',
    '画质': 'Quality',
    '尺寸': 'Size',
    '格式': 'Format',
    '启用': 'Enable',
    '语言': 'Language',
    // 多音轨
    '音轨': 'Audio Tracks',
    '全选': 'All',
    '默认': 'default',
    '单声道': 'Mono',
    '立体声': 'Stereo',
    '导出全部音轨（多音轨视频每条一个文件）': 'Export all audio tracks (one file per track)',
    '请至少选择一条音轨': 'Please select at least one audio track',
    // 选项
    '原始尺寸': 'Original',
    '原始帧率': 'Original',
    'MP4 视频': 'MP4 Video',
    'GIF 动图': 'GIF',
    'WebP 动图': 'WebP',
    'H.264 (软件)': 'H.264 (Software)',
    'H.265 (软件)': 'H.265 (Software)',
    'PNG（无损）': 'PNG (Lossless)',
    '256 色（最佳）': '256 colors (best)',
    '128 色': '128 colors',
    '64 色（更小）': '64 colors (smaller)',
    '32 色（最小）': '32 colors (smallest)',
    '256 色': '256 colors',
    '64 色': '64 colors',
    '32 色': '32 colors',
    // 按钮
    '开始执行选中任务': 'Run Selected Tasks',
    '开始批量': 'Start Batch',
    '停止': 'Stop',
    '导出': 'Export',
    '保存': 'Save',
    '取消': 'Cancel',
    '删除': 'Delete',
    '选择': 'Browse',
    '知道了': 'Got it',
    '预设：自定义': 'Preset: Custom',
    '保存预设': 'Save Preset',
    '预设名称': 'Preset Name',
    // 任务队列
    '任务队列': 'Task Queue',
    '系统': 'System',
    '等待任务开始...': 'Waiting for tasks...',
    '空闲': 'Idle',
    '完成': 'Done',
    '失败': 'Failed',
    '已终止': 'Stopped',
    '详情': 'Details',
    '打开': 'Open',
    '文件夹': 'Folder',
    // 任务名（动态）
    '雪碧图': 'Sprite',
    '预览': 'Preview',
    '批量截帧': 'Batch Frames',
    // 导出弹窗
    '导出截帧': 'Export Frames',
    '导出范围': 'Range',
    '当前帧': 'Current frame',
    '全部已截帧 (': 'All captured (',
    '已截帧 (': 'Captured (',
    '导出尺寸': 'Size',
    '保持原始分辨率': 'Keep original resolution',
    'JPG 建议 85-95': 'JPG: 85–95 recommended',
    // 设置
    '默认输出目录': 'Default Output Folder',
    '与源文件相同目录': 'Same folder as source',
    // 批量
    '拖入视频文件，或点击「添加视频」': 'Drop video files, or click “Add Videos”',
    // 提示
    '间隔根据视频时长自动计算，WebP 格式画质 75': 'Interval auto-calculated by duration; WebP quality 75',
    'H.264 + MP3 128kbps 兼容性好，H.265 + Opus 64kbps 体积更小': 'H.264 + MP3 128kbps is most compatible; H.265 + Opus 64kbps is smaller',
    'Opus 32kbps 效率极高，适合语音场景': 'Opus 32kbps is very efficient, great for speech',
    '自动': 'Auto',
    // 动态状态/提示词
    '处理中': 'Processing',
    '等待': 'Pending',
    '已停止': 'Stopped',
    '准备中…': 'Preparing…',
    '准备中...': 'Preparing...',
    '正在终止...': 'Stopping...',
    '正在停止…（当前文件结束后停止）': 'Stopping… (after current file)',
    // 弹窗 alert
    '请至少选择一个任务': 'Please enable at least one task',
    '请至少启用一个任务': 'Please enable at least one task',
    '请先添加视频文件': 'Please add video files first',
    '请输入预设名称': 'Please enter a preset name',
    '请先在下拉里选择一个预设': 'Please select a preset first',
    '没有可导出的帧': 'No frames to export',
    '无法读取视频文件: ': 'Cannot read video file: ',
    '无音频': 'No audio',
    '含音频': 'With audio',
    '详情': 'Details',
    '已跳过': 'Skipped',
    '原视频没有音轨，已跳过': 'Source has no audio track — skipped',
    '等待任务开始...': 'Waiting for tasks...',
    // 进度/阶段文案（来自主进程）
    '提取音频中': 'Extracting audio',
    '生成缩略图中': 'Generating thumbnails',
    '拼接雪碧图中': 'Assembling sprite',
    '合并片段中': 'Merging clips',
    '转码为 GIF 中': 'Encoding GIF',
    '转码为 WebP 中': 'Encoding WebP',
    '批量截帧中': 'Extracting frames',
    '转码整段中': 'Transcoding whole clip',
    '开始截帧...': 'Capturing...',
    '截帧完成': 'Capture done',
    '开始批量截帧...': 'Starting frame extraction...',
    '开始生成雪碧图...': 'Generating sprite...',
    '雪碧图生成完成': 'Sprite done',
    '预览生成完成': 'Preview done',
    '音频提取完成': 'Audio extracted',
    // 标题(title)/占位(placeholder) 等属性
    '编码加速': 'Encoding acceleration',
    '最小化': 'Minimize',
    '最大化': 'Maximize',
    '关闭': 'Close',
    '清空已截帧': 'Clear captured frames',
    '清空列表': 'Clear list',
    '保存当前设置为预设': 'Save current settings as a preset',
    '删除所选预设': 'Delete selected preset',
    '移除': 'Remove',
    '例如：720p Web 预览': 'e.g. 720p Web preview',
    '无损': 'Lossless',
  };

  // 帮助正文（英文版，整体切换）
  const HELP_EN = `
    <div class="help-section">
      <h4>Website</h4>
      <p>Visit the official site for more: <a class="help-link" data-ext-url="https://vt.complexmission.com">vt.complexmission.com</a></p>
      <p>Source code: <a class="help-link" data-ext-url="https://github.com/complex-mission/video-toolkit">github.com/complex-mission/video-toolkit</a></p>
    </div>
    <div class="help-section">
      <h4>Hardware-Accelerated Encoding (in this app)</h4>
      <p>Hardware acceleration uses your GPU's dedicated unit to <b>encode video</b>. In this app it <b>only affects exporting the Preview Video</b> (the encoding step). <b>H.265 benefits the most.</b></p>
      <p>The following are <b>not affected</b> by it:</p>
      <ul>
        <li><b>Frame capture / preview</b>: only decodes and displays, no encoding.</li>
        <li><b>Audio extraction</b>: audio encoding, not the video encoder.</li>
        <li><b>Sprite sheet</b>: outputs images (WebP/JPG), not the video encoder.</li>
      </ul>
      <p><b>Speed vs quality:</b> hardware encoding is much faster and uses less CPU, but at the same settings the quality is usually slightly lower than CPU software encoding (libx264/libx265 compress more efficiently). <b>Want speed → hardware; want quality / smallest size → software.</b></p>
      <p><b>How to choose / disable GPU:</b> set it under "Preview Video → Codec". <b>The default is software (H.265 Software); GPU is never used automatically.</b> Pick whichever hardware option appears in the dropdown to use it, or keep "Software" to turn it off.</p>
      <p>The titlebar badge shows the hardware encoders detected on your machine: <b>AMF</b> (AMD), <b>NVENC</b> (NVIDIA), <b>QSV</b> (Intel), <b>VideoToolbox</b> (macOS); otherwise it shows "Software".</p>
      <p id="help-hw-detected" class="help-hw-detected"></p>
    </div>
    <div class="help-section">
      <h4>Video Codecs: H.264 vs H.265</h4>
      <ul>
        <li><b>H.264</b>: best compatibility, plays almost everywhere.</li>
        <li><b>H.265 (HEVC)</b>: about half the size at the same quality, but heavier to encode and unsupported on some older devices/browsers.</li>
      </ul>
    </div>
    <div class="help-section">
      <h4>Output Formats: MP4 / GIF / WebP</h4>
      <ul>
        <li><b>MP4</b>: general video, best size, can include audio.</li>
        <li><b>GIF</b>: most compatible but only 256 colors, larger, no audio. Fewer colors = smaller.</li>
        <li><b>Animated WebP</b>: smaller than GIF with better color; but large/long animations may play slower and slower (or stall) in <b>Safari</b> — keep them small, short, low fps.</li>
      </ul>
    </div>
    <div class="help-section">
      <h4>Sprite Sheet + VTT</h4>
      <p>A sprite sheet packs many thumbnails into one image; the accompanying VTT file records which region maps to each timestamp. After a player loads the VTT, hovering the progress bar shows a preview thumbnail (as seen on most video sites).</p>
    </div>
    <div class="help-section">
      <h4>Frame Rate (fps)</h4>
      <ul>
        <li><b>Original</b>: same as source, smoothest, largest.</li>
        <li><b>29.97</b>: NTSC (North America/Japan TV); <b>25</b>: PAL (Europe); <b>24</b>: cinematic.</li>
        <li><b>12–15</b>: enough for previews/thumbnails, noticeably smaller.</li>
      </ul>
    </div>
    <div class="help-section">
      <h4>Frame Export</h4>
      <ul>
        <li>Scaled by height, <b>only downscaled, never upscaled</b> (e.g. a 720p poster from a 4K source).</li>
        <li>Format: PNG lossless (largest); JPG / WebP have adjustable quality and smaller size.</li>
        <li>All outputs go into a <b>folder named after the video</b>; repeated exports auto-continue numbering without overwriting.</li>
      </ul>
    </div>
  `;

  let lang = 'zh';
  let staticNodes = [];
  let attrItems = [];
  let helpZh = null;
  let applyHook = null;

  function t(zh) {
    return (lang === 'en' && EN[zh] !== undefined) ? EN[zh] : zh;
  }

  function capture() {
    staticNodes = [];
    attrItems = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) {
      const key = n.nodeValue.trim();
      if (key && EN[key] !== undefined) staticNodes.push({ node: n, raw: n.nodeValue });
    }
    document.querySelectorAll('[placeholder], [title]').forEach(el => {
      ['placeholder', 'title'].forEach(attr => {
        const v = el.getAttribute(attr);
        if (v && EN[v.trim()] !== undefined) attrItems.push({ el, attr, raw: v });
      });
    });
    const hb = document.querySelector('#modal-help .modal-body');
    if (hb) helpZh = hb.innerHTML;
  }

  function apply(l) {
    lang = (l === 'en') ? 'en' : 'zh';
    document.documentElement.lang = (lang === 'en') ? 'en' : 'zh-CN';
    staticNodes.forEach(it => {
      const lead = it.raw.match(/^\s*/)[0];
      const trail = it.raw.match(/\s*$/)[0];
      const key = it.raw.trim();
      it.node.nodeValue = (lang === 'en' && EN[key] !== undefined) ? (lead + EN[key] + trail) : it.raw;
    });
    attrItems.forEach(it => {
      const key = it.raw.trim();
      it.el.setAttribute(it.attr, (lang === 'en' && EN[key] !== undefined) ? EN[key] : it.raw);
    });
    const hb = document.querySelector('#modal-help .modal-body');
    if (hb && helpZh !== null) hb.innerHTML = (lang === 'en') ? HELP_EN : helpZh;
    if (applyHook) applyHook(lang);
  }

  window.I18n = {
    t,
    capture,
    apply,
    get lang() { return lang; },
    setApplyHook(fn) { applyHook = fn; },
    detect() { return (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en'; }
  };
  window.t = t;
})();
