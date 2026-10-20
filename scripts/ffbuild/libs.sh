# Third-party codec libraries, all built as static libs into $PREFIX.
# Versions pinned here; bump deliberately.

ZLIB_VER=1.3.2
X264_SHA=b35605ace3ddf7c1a5d67a2eb553f034aef41d55   # stable branch
X265_VER=4.1
WEBP_VER=1.6.0
LAME_VER=3.100
OPUS_VER=1.5.2
DAV1D_VER=1.5.3
NVHDR_VER=12.1.14.0   # NVENC API 12.1: needs NVIDIA driver >= 531 (2023), wider reach than 13.x
AMF_VER=1.5.3
VPL_VER=2.17.0

build_zlib() {
  is_done zlib && return
  fetch "https://github.com/madler/zlib/releases/download/v$ZLIB_VER/zlib-$ZLIB_VER.tar.gz" zlib.tar.gz
  unpack zlib.tar.gz zlib
  log "build zlib"
  ( cd "$WORK/build/zlib"
    make -f win32/Makefile.gcc libz.a CC=gcc CFLAGS="-O2"
    mkdir -p "$PREFIX/include" "$PREFIX/lib"
    cp zlib.h zconf.h "$PREFIX/include/"
    cp libz.a "$PREFIX/lib/" )
  done_mark zlib
}

build_x264() {
  is_done x264 && return
  fetch "https://code.videolan.org/videolan/x264/-/archive/$X264_SHA/x264-$X264_SHA.tar.bz2" x264.tar.bz2
  unpack x264.tar.bz2 x264
  log "build x264"
  ( cd "$WORK/build/x264"
    ./configure --prefix="$PREFIX" --enable-static --disable-cli --disable-opencl \
      --disable-lavf --disable-swscale --disable-ffms --disable-gpac --disable-lsmash
    make -j"$JOBS" && make install-lib-static )
  done_mark x264
}

build_x265() {
  is_done x265 && return
  fetch "https://download.videolan.org/pub/videolan/x265/x265_$X265_VER.tar.gz" x265.tar.gz
  unpack x265.tar.gz x265
  log "build x265 (8-bit only: Main profile is what browsers decode)"
  ( cd "$WORK/build/x265"
    # 4.1 把 CMP0025/CMP0054 设为 OLD，CMake 4 已不允许 → 删掉，用 NEW 行为即可
    sed -i -E '/cmake_policy\(SET CMP00(25|54) OLD\)/d' source/CMakeLists.txt
    cmake -S source -B out "${CMAKE_COMMON[@]}" \
      -DENABLE_SHARED=OFF -DENABLE_CLI=OFF -DENABLE_ASSEMBLY=ON -DENABLE_HDR10_PLUS=OFF
    cmake --build out -j"$JOBS" && cmake --install out )
  # x265.pc 的 Libs.private 带 -lgcc_s（MinGW 下不存在）；换成静态 libstdc++
  sed -i 's/-lgcc_s//g; s/-lgcc//g' "$PREFIX/lib/pkgconfig/x265.pc"
  done_mark x265
}

build_webp() {
  is_done webp && return
  fetch "https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-$WEBP_VER.tar.gz" webp.tar.gz
  unpack webp.tar.gz webp
  log "build libwebp"
  ( cd "$WORK/build/webp"
    cmake -S . -B out "${CMAKE_COMMON[@]}" \
      -DWEBP_BUILD_ANIM_UTILS=OFF -DWEBP_BUILD_CWEBP=OFF -DWEBP_BUILD_DWEBP=OFF \
      -DWEBP_BUILD_GIF2WEBP=OFF -DWEBP_BUILD_IMG2WEBP=OFF -DWEBP_BUILD_VWEBP=OFF \
      -DWEBP_BUILD_WEBPINFO=OFF -DWEBP_BUILD_WEBPMUX=OFF -DWEBP_BUILD_EXTRAS=OFF
    cmake --build out -j"$JOBS" && cmake --install out )
  done_mark webp
}

build_lame() {
  is_done lame && return
  fetch "https://downloads.sourceforge.net/project/lame/lame/$LAME_VER/lame-$LAME_VER.tar.gz" lame.tar.gz
  unpack lame.tar.gz lame
  log "build lame"
  ( cd "$WORK/build/lame"
    # lame 3.100 是 2017 年的代码：GCC 15+ 默认 C23 会报错，钉回 gnu17
    CFLAGS="-O2 -std=gnu17 -Wno-error=incompatible-pointer-types" \
      ./configure --prefix="$PREFIX" --enable-static --disable-shared \
      --disable-frontend --disable-decoder --disable-gtktest --enable-nasm
    make -j"$JOBS" -C libmp3lame
    # libtool 在 configure 时写死了带空格的 bash 路径（C:/Program Files/...），make install 会失败；
    # FFmpeg 只需要静态库和头文件，直接拷贝
    mkdir -p "$PREFIX/include/lame" "$PREFIX/lib"
    cp include/lame.h "$PREFIX/include/lame/"
    cp libmp3lame/.libs/libmp3lame.a "$PREFIX/lib/" )
  done_mark lame
}

build_opus() {
  is_done opus && return
  fetch "https://github.com/xiph/opus/releases/download/v$OPUS_VER/opus-$OPUS_VER.tar.gz" opus.tar.gz
  unpack opus.tar.gz opus
  log "build opus"
  ( cd "$WORK/build/opus"
    # FORTIFY/stack-protector 在 MinGW 下会额外依赖 libssp-0.dll
    cmake -S . -B out "${CMAKE_COMMON[@]}" \
      -DOPUS_BUILD_TESTING=OFF -DOPUS_BUILD_PROGRAMS=OFF \
      -DOPUS_FORTIFY_SOURCE=OFF -DOPUS_STACK_PROTECTOR=OFF
    cmake --build out -j"$JOBS" && cmake --install out )
  done_mark opus
}

build_dav1d() {
  is_done dav1d && return
  fetch "https://code.videolan.org/videolan/dav1d/-/archive/$DAV1D_VER/dav1d-$DAV1D_VER.tar.bz2" dav1d.tar.bz2
  unpack dav1d.tar.bz2 dav1d
  # meson 不随工具链提供：装进构建目录自己的 venv
  local venv="$WORK/venv"
  if [ ! -d "$venv" ]; then python -m venv "$venv"; fi
  local py="$venv/Scripts/python"; [ -x "$py" ] || py="$venv/bin/python"
  "$py" -m pip install -q meson
  log "build dav1d"
  ( cd "$WORK/build/dav1d"
    "$py" -m mesonbuild.mesonmain setup out --prefix="$PREFIX" --libdir=lib \
      --buildtype=release --default-library=static \
      -Denable_tools=false -Denable_tests=false -Denable_examples=false
    ninja -C out -j"$JOBS" && ninja -C out install )
  done_mark dav1d
}

build_nvheaders() {
  is_done nvheaders && return
  fetch "https://github.com/FFmpeg/nv-codec-headers/releases/download/n$NVHDR_VER/nv-codec-headers-$NVHDR_VER.tar.gz" nvheaders.tar.gz
  unpack nvheaders.tar.gz nvheaders
  log "install nv-codec-headers"
  ( cd "$WORK/build/nvheaders" && make PREFIX="$PREFIX" install )
  done_mark nvheaders
}

build_amf() {
  is_done amf && return
  fetch "https://github.com/GPUOpen-LibrariesAndSDKs/AMF/releases/download/v$AMF_VER/AMF-headers-v$AMF_VER.tar.gz" amf.tar.gz
  rm -rf "$WORK/build/amf"; mkdir -p "$WORK/build/amf"
  tar -xf "$WORK/src/amf.tar.gz" -C "$WORK/build/amf"
  log "install AMF headers"
  local inc; inc=$(find "$WORK/build/amf" -type d -path '*/core' -printf '%h\n' | head -1)
  mkdir -p "$PREFIX/include/AMF"
  cp -r "$inc"/. "$PREFIX/include/AMF/"
  done_mark amf
}

build_vpl() {
  is_done vpl && return
  fetch "https://github.com/intel/libvpl/archive/refs/tags/v$VPL_VER.tar.gz" vpl.tar.gz
  unpack vpl.tar.gz vpl
  log "build libvpl (Intel QSV dispatcher)"
  ( cd "$WORK/build/vpl"
    cmake -S . -B out "${CMAKE_COMMON[@]}" \
      -DBUILD_TOOLS=OFF -DBUILD_EXAMPLES=OFF -DINSTALL_EXAMPLES=OFF -DBUILD_TESTS=OFF \
      -DINSTALL_DEV=ON -DINSTALL_LIB=ON
    cmake --build out -j"$JOBS" && cmake --install out )
  done_mark vpl
}

ZIMG_VER=3.0.6

# zimg（zscale：HDR→SDR 色调映射所需）只提供 autotools，工具链里没有 → 直接按文件名后缀
# 选 SIMD 编译参数逐个编译（与上游 Makefile.am 的分组一致）。
# -muse-unaligned-vector-move：Win64 上 GCC 无法保证 32 字节栈对齐，AVX 代码否则可能崩溃。
zimg_flags() {
  case "$1" in
    *_avx512_vnni.cpp) echo "-mavx512f -mavx512cd -mavx512vl -mavx512bw -mavx512dq -mavx512vnni" ;;
    *_avx512.cpp)      echo "-mavx512f -mavx512cd -mavx512vl -mavx512bw -mavx512dq" ;;
    *_avx2.cpp)        echo "-mavx2 -mf16c -mfma" ;;
    *f16c_ivb.cpp)     echo "-mavx -mf16c" ;;
    *_avx.cpp)         echo "-mavx" ;;
    *_sse2.cpp)        echo "-msse2" ;;
    *_sse.cpp)         echo "-msse" ;;
  esac
}

build_zimg() {
  is_done zimg && return
  fetch "https://github.com/sekrit-twc/zimg/archive/refs/tags/release-$ZIMG_VER.tar.gz" zimg.tar.gz
  unpack zimg.tar.gz zimg
  log "build zimg"
  ( cd "$WORK/build/zimg"
    mkdir -p obj
    export -f zimg_flags
    find src/zimg -name '*.cpp' -not -path '*/arm/*' | \
      xargs -P "$JOBS" -I{} bash -c 'f={}; o=obj/$(echo "$f" | tr / _).o;
        g++ -std=c++17 -O2 -DNDEBUG -DZIMG_X86 -DZIMG_X86_AVX512 -Isrc/zimg \
          -Wa,-muse-unaligned-vector-move $(zimg_flags "$f") -c "$f" -o "$o"'
    rm -f libzimg.a && ar rcs libzimg.a obj/*.o
    cp libzimg.a "$PREFIX/lib/"
    cp src/zimg/api/zimg.h src/zimg/api/zimg++.hpp "$PREFIX/include/"
    mkdir -p "$PREFIX/lib/pkgconfig"
    cat > "$PREFIX/lib/pkgconfig/zimg.pc" <<PC
prefix=$PREFIX
libdir=\${prefix}/lib
includedir=\${prefix}/include
Name: zimg
Description: Scaling, colorspace conversion, and dithering library
Version: $ZIMG_VER
Libs: -L\${libdir} -lzimg
Libs.private: -lstdc++
Cflags: -I\${includedir}
PC
  )
  done_mark zimg
}
