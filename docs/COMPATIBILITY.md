# 输出格式兼容性评估

目标：本软件生成的文件放到网页（`<video>` / `<img>` / `<audio>`）里，在 **Safari（macOS / iOS，含 M1/M2 Mac）、Chrome / Edge、Firefox、Android** 上都能播放，并且能正常拖动进度条。

## 一、旧版（CM视频工具箱 / Electron）存在的问题

| # | 问题 | 后果 | 根因 |
|---|------|------|------|
| 1 | **H.265 预览写成 `hev1` 标记** | Safari / iOS / QuickTime **完全放不了** | ffmpeg 从 TS 片段 `-c copy` 合并进 MP4 时默认写 `hev1`；Apple 只认 `hvc1`。旧版**默认就选 H.265** |
| 2 | **H.265 预览配 Opus 音频（MP4 内）** | Safari 不支持 MP4 封装的 Opus → 无声或整片拒播 | `isHevcFamily → libopus` |
| 3 | H.264 预览配 MP3 音频（MP4 内） | 能放，但非标准；部分老设备/播放器无声 | `libmp3lame` |
| 4 | **MP4 未 faststart（moov 在文件尾）** | Safari/iOS 先要读文件尾；服务器 Range 支持不好时**无法快进、需下载完才能播** | 合并时没加 `-movflags +faststart` |
| 5 | 未强制像素格式 | 10-bit / 4:2:2 / 4:4:4 源 → 输出 H.264 High10/High422/High444 或 HEVC Main10/RExt，**所有浏览器（含 M1 硬解）都放不了** | 没有 `-pix_fmt yuv420p` |
| 6 | HDR（iPhone HLG / HDR10）源不做色调映射 | 预览、截帧、雪碧图发灰 | 无 tonemap |
| 7 | 非方形像素源（DV/DVD 变形宽银幕） | GIF/WebP 及部分播放器画面被压扁 | 未展开 SAR |
| 8 | 雪碧图超过 WebP 16383px 上限 | 长视频 + 小间隔时直接失败 | 单张拼接 |
| 9 | 音频提取默认 Opus(.ogg) 32kbps | Safari 18.4 以前（macOS 15.4 / iOS 18.4）放不了 Ogg | 默认值 |
| 10 | 5.1/7.1 源导出 MP3 | LAME 只支持双声道 → 报错 | 没有下混 |
| 11 | 内置预览用 `file://` 播放 | AVI/WMV/MPEG-2/ProRes 等 WebView 放不了，截帧功能失效 | 无回退 |

## 二、新版（CM FrameKit）的处理

### MP4 预览（固定为「全平台最大公约数」）

| 项目 | 设置 | 说明 |
|------|------|------|
| 视频 H.264 | High Profile，**8-bit 4:2:0**（`yuv420p`） | 所有浏览器、所有 Apple 设备硬解 |
| 视频 H.265 | Main Profile 8-bit，**`-tag:v hvc1`** | Safari 必需 hvc1；精简 ffmpeg 里 x265 只编 8-bit |
| 音频 | **AAC-LC 双声道 48kHz 128k** | 唯一在 MP4 里全平台通吃的音频 |
| 容器 | **`-movflags +faststart`** | moov 前置：Safari 立即播放、可拖动 |
| 关键帧 | 每 ≤2 秒强制关键帧（NVENC 另加 `-forced-idr 1`） | Safari 只能拖到同步帧 |
| 滤镜链 | 反交错 → 方形像素 → 缩放 → HDR 色调映射（zscale+tonemap hable → BT.709）→ 8-bit 4:2:0 | |
| 写完校验 | 内置 MP4 box 扫描器检查 moov 位置、`avc1/hvc1`、`mp4a` | 不合格会在任务日志里提示 |

### 其它输出

| 输出 | 格式 | 兼容性 |
|------|------|--------|
| 音频 | **AAC (.m4a，默认)** / MP3 / Opus (.ogg) | AAC、MP3 全平台；Opus(.ogg) 需 Safari 18.4+，界面有提示 |
| 雪碧图 | WebP（自动分多张，VTT 指向对应图） | Safari 14+（macOS 11 / iOS 14）及所有现代浏览器 |
| 动图 | GIF / 动画 WebP | GIF 全平台；动画 WebP Safari 14+ |
| 截帧 | PNG（8-bit rgb24）/ JPG / WebP | 全平台（WebP 需 Safari 14+） |

### 导入时的兼容性分析

载入视频后在文件信息下方显示「源文件网页兼容性」，逐条说明问题及影响的平台：

- 容器：MKV/AVI/FLV/WMV/TS 不能直接网页播放；WebM 在 Safari 支持不完整；**moov 在文件尾**；分片 MP4
- 视频：H.264 10-bit/4:2:2/4:4:4；H.264 超过 Level 5.2 / 4K；**HEVC `hev1`**；HEVC 4:2:2/4:4:4；HEVC 依赖硬解；**AV1 在 M1/M2 Mac 与旧 iPhone 的 Safari 放不了**；VP8/VP9 在 Apple 设备不稳定；ProRes 仅 Mac Safari；其它旧编码
- 画面：HDR（PQ/HLG）、纯 Dolby Vision（非 Apple 设备紫绿）、隔行扫描、>60fps、非方形像素
- 音频：**MP4 里的 Opus（Safari 无声）**、MP4 里的 MP3、Opus/Vorbis（旧 Safari）、**AC-3/E-AC-3（Chrome/Firefox 无声）**、DTS/TrueHD（所有浏览器无声）、PCM、FLAC/ALAC、多音轨（浏览器只播默认轨）

## 三、平台速查表（2026）

| 编码 / 封装 | Safari macOS | Safari iOS | M1/M2 Mac | Chrome/Edge | Firefox | 备注 |
|---|---|---|---|---|---|---|
| H.264 8-bit 4:2:0 + AAC / MP4 | ✓ | ✓ | ✓ | ✓ | ✓ | **推荐** |
| H.264 10-bit / 4:2:2 | ✕ | ✕ | ✕ | ✕ | ✕ | 无硬解 |
| HEVC Main/Main10 `hvc1` | ✓ | ✓ | ✓ | 需 GPU 硬解 | 仅 Win+硬解 | Linux 基本 ✕ |
| HEVC `hev1` | ✕ | ✕ | ✕ | 视硬解 | 视硬解 | 改 tag 即可无损修复 |
| AV1 | 仅 M3/A17 Pro+ | 仅 A17 Pro+ | ✕ | ✓（软解） | ✓（软解） | |
| VP9 / WebM | 部分 | 较差 | 部分 | ✓ | ✓ | |
| Opus in MP4 | ✕ | ✕ | ✕ | ✓ | ✓ | |
| Opus/Vorbis in Ogg | 18.4+ | 18.4+ | 18.4+ | ✓ | ✓ | |
| AC-3 / E-AC-3 | ✓ | ✓ | ✓ | Chrome ✕ / Edge(Win) ✓ | ✕ | |
| DTS / TrueHD | ✕ | ✕ | ✕ | ✕ | ✕ | |
| 动画 WebP / WebP 图 | 14+ | 14+ | ✓ | ✓ | ✓ | |

## 四、仍需注意（软件之外）

- **服务器必须支持 HTTP Range（206）**：Safari 播放视频严格依赖 Range 请求，否则即使 faststart 也无法拖动。
- 确认服务器返回正确的 `Content-Type`（`video/mp4`、`audio/mp4`、`image/webp`、`text/vtt`）。
- 雪碧图 VTT 需要播放器支持 `#xywh=` 片段（video.js / Plyr / ArtPlayer 等），浏览器原生控件不读缩略图轨。

## 参考

- FFmpeg trac #6860 / ffmpeg-devel “hev1 vs. hvc1”：Apple 播放器只接受 `hvc1`
- MDN / WebKit：Safari 18.4 起支持 Ogg 中的 Opus / Vorbis；Safari 15 起支持 WebM 中的 Opus
- Apple Developer Forums：Opus 仅支持 CAF，不支持 MP4
- Chrome 107 起默认启用 HEVC 硬解（需硬件）；Firefox 134 起 Windows 上启用 HEVC 硬解
