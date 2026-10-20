#!/usr/bin/env bash
# 编译 CM FrameKit 自带的精简 FFmpeg（Windows x64，MinGW）。
#   本地：Git Bash + WinLibs MinGW（gcc/cmake/ninja/nasm/mingw32-make 需在 PATH）
#   CI  ：MSYS2 MINGW64
# 产物：src-tauri/ffmpeg/{ffmpeg.exe,ffprobe.exe,*.dll}，由 Tauri 作为 resources 打包。
# 中间文件在 .ffbuild/，各库装好后有标记，重跑只会重建 FFmpeg 本身。

HERE=$(cd "$(dirname "$0")" && pwd)
source "$HERE/ffbuild/env.sh"
source "$HERE/ffbuild/libs.sh"
source "$HERE/ffbuild/ffmpeg.sh"

build_zlib
build_nvheaders
build_amf
build_x264
build_lame
build_opus
build_webp
build_dav1d
build_vpl
build_zimg
build_x265
build_ffmpeg
collect_ffmpeg
log "done"
