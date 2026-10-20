# CM FrameKit

截帧 · 提取音频 · 雪碧图 · 预览视频 —— 输出面向**全浏览器 / 全 Apple 设备兼容**。

CM视频工具箱（Electron）的 Rust + Tauri 重写版，内置精简编译的 FFmpeg。

## 特性

- **截帧**：时间轴逐帧定位截图，批量按间隔导出（PNG / JPG / WebP）
- **提取音频**：AAC(.m4a) / MP3 / Opus，多音轨分别导出
- **雪碧图 + WebVTT**：超过 WebP 尺寸上限自动分多张
- **预览视频**：多片段拼接，MP4（H.264 / H.265，含 NVENC / QSV / AMF 硬件编码）/ GIF / 动画 WebP
- **网页兼容性**：
  - 导入时分析源文件：moov 位置、hev1、10-bit H.264、AV1 在 M1、AC-3/Opus 音频、HDR 等
  - 生成的 MP4 固定为 8-bit 4:2:0 + AAC + faststart + hvc1，并且写完会自动校验
  - 详见 [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)
- HDR → SDR 色调映射、自动反交错、非方形像素校正、竖拍旋转
- WebView 放不了的格式（AVI / WMV / MPEG-2 / ProRes …）自动切换为 ffmpeg 逐帧预览

## 开发

```bash
npm install
npm run ffmpeg      # 编译精简 FFmpeg → src-tauri/ffmpeg/（首次约 20–30 分钟，之后只重编 FFmpeg）
npm run dev         # 启动
npm run build       # 打包 NSIS 安装包
```

### 精简 FFmpeg

`scripts/build-ffmpeg.sh` 从源码编译（Git Bash + WinLibs MinGW，或 MSYS2 MINGW64）：

- `--disable-everything` 后只开启用到的组件
  - 输入面尽量宽：主流容器与编解码器，AV1 用 dav1d
  - 输出只有本软件会写的格式
- 编码库：x264、x265（8-bit）、libwebp、LAME、Opus、zimg（HDR 色调映射）
- 硬件编码：NVENC、AMF、QSV（libvpl）
- shared 构建：`ffmpeg.exe` / `ffprobe.exe` 共用一套 DLL，无 MinGW 运行时依赖
- 不含网络协议和 avdevice

FFmpeg 及 x264 / x265 为 GPL，作为独立可执行文件随软件分发，许可证见 `src-tauri/ffmpeg/LICENSE-FFmpeg-GPLv2.txt`。

### 自测

```bash
cd src-tauri
FRAMEKIT_TEST_MEDIA=<素材目录> cargo test --test selftest -- --ignored --nocapture
```

对目录里每个文件跑全部任务，并用 ffprobe 与内置 MP4 扫描器校验输出（像素格式、音频编码、faststart、hvc1、雪碧图分张）。
