# Shared environment for the minimal FFmpeg build (sourced by build-ffmpeg.sh).
# Works under Git Bash + WinLibs MinGW (local) and MSYS2 MINGW64 (CI).

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
WORK=${FFBUILD_DIR:-$ROOT/.ffbuild}
OUT=${FFMPEG_OUT:-$ROOT/src-tauri/ffmpeg}
JOBS=${JOBS:-$(nproc)}

mkdir -p "$WORK/src" "$WORK/build" "$WORK/prefix" "$WORK/tools"

# Windows 的 TEMP 带反斜杠，FFmpeg configure 拼路径会丢掉 → 用构建目录内的 POSIX 路径
export TMPDIR="$WORK/tmp"; mkdir -p "$TMPDIR"

# 原生 Windows 工具（gcc / pkgconf / cmake）只认 F:/x/y 形式的路径
winpath() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else echo "$1"; fi; }
PREFIX=$(winpath "$WORK/prefix")

# Git Bash 没有 make，只有 WinLibs 的 mingw32-make：包一层叫 make 的脚本
if ! command -v make >/dev/null; then
  cat > "$WORK/tools/make" <<'EOF'
#!/usr/bin/env bash
exec mingw32-make SHELL=sh "$@"
EOF
  chmod +x "$WORK/tools/make"
fi
export PATH="$WORK/tools:$PATH"

# pkg-config：优先 MinGW 自带的 pkgconf，避开 Strawberry Perl 的同名脚本
if command -v pkgconf >/dev/null; then PKGCONF=pkgconf; else PKGCONF=pkg-config; fi
export PKG_CONFIG="$PKGCONF"
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"

export CC=gcc CXX=g++
export CFLAGS="-O2 -I$PREFIX/include"
export CXXFLAGS="-O2"
export LDFLAGS="-L$PREFIX/lib"

CMAKE_COMMON=(
  -G Ninja
  -DCMAKE_BUILD_TYPE=Release
  -DCMAKE_INSTALL_PREFIX="$PREFIX"
  -DCMAKE_PREFIX_PATH="$PREFIX"
  -DBUILD_SHARED_LIBS=OFF
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5
)

# Windows 的 schannel 版 curl 遇到吊销服务器不可达会直接失败（CRYPT_E_REVOCATION_OFFLINE）
CURL_EXTRA=""
if curl -V | grep -qi schannel; then CURL_EXTRA="--ssl-revoke-best-effort"; fi

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

# fetch <url> <file>：下载到 src/ 缓存，已存在则跳过
fetch() {
  local url=$1 file="$WORK/src/$2"
  if [ ! -s "$file" ]; then
    log "download $2"
    curl -fL --retry 3 $CURL_EXTRA -o "$file.part" "$url"
    mv "$file.part" "$file"
  fi
}

# unpack <file> <dir>：解压到 build/<dir>（总是重新解压，保证干净）
unpack() {
  local file="$WORK/src/$1" dir="$WORK/build/$2"
  rm -rf "$dir"; mkdir -p "$dir"
  tar -xf "$file" -C "$dir" --strip-components=1
}

# 每个库装好后写一个标记，重跑脚本时跳过
done_mark() { touch "$WORK/prefix/.done-$1"; }
is_done() { [ -f "$WORK/prefix/.done-$1" ]; }
