# FFmpeg itself: --disable-everything, then only what CM FrameKit uses.
# Shared build: ffmpeg.exe / ffprobe.exe share one set of av*.dll (no codec code duplicated).

FFMPEG_VER=9.0.2

join() { local IFS=,; echo "$*"; }

# ---- 输入：尽量宽（用户的视频五花八门）----
DEMUXERS=(mov matroska avi flv asf mpegts mpegps mpegvideo mxf dv ivf ogg
  h264 hevc m4v vc1 av1 rawvideo image2 image_png_pipe image_jpeg_pipe image_webp_pipe concat
  wav w64 aiff mp3 aac ac3 eac3 dts truehd flac)
VDEC=(h264 hevc vp8 vp9 libdav1d mpeg1video mpeg2video mpeg4 msmpeg4v1 msmpeg4v2 msmpeg4v3
  wmv1 wmv2 wmv3 vc1 h263 h263p flv mjpeg prores dnxhd dvvideo theora png webp gif bmp rawvideo
  cfhd hap qtrle utvideo ffv1 huffyuv cinepak svq3)
ADEC=(aac aac_latm ac3 eac3 dca truehd mlp mp1 mp2 mp3 opus vorbis flac alac
  wmav1 wmav2 wmapro amrnb amrwb
  pcm_s16le pcm_s16be pcm_s24le pcm_s24be pcm_s32le pcm_f32le pcm_f64le pcm_u8 pcm_alaw pcm_mulaw pcm_bluray pcm_dvd)
PARSERS=(h264 hevc vp8 vp9 av1 mpegvideo mpeg4video h263 vc1 mjpeg png webp gif
  aac aac_latm ac3 dca mlp mpegaudio opus vorbis flac dvd_nav)

# ---- 输出：只有本软件会写的格式 ----
ENCODERS=(libx264 libx265 h264_nvenc hevc_nvenc h264_amf hevc_amf h264_qsv hevc_qsv
  aac libmp3lame libopus png mjpeg libwebp libwebp_anim gif wrapped_avframe)
MUXERS=(mp4 mov ipod mpegts mp3 ogg opus webm image2 gif webp null)
BSFS=(aac_adtstoasc h264_mp4toannexb hevc_mp4toannexb extract_extradata
  vp9_superframe vp9_superframe_split mpeg4_unpack_bframes null)
# transpose/hflip/vflip：手机竖拍视频自动旋转（autorotate）时 ffmpeg 会自动插入
# zscale+tonemap：HDR(PQ/HLG) → SDR BT.709，否则 iPhone HDR 视频的预览和截帧会发灰
FILTERS=(yadif bwdif scale fps split palettegen paletteuse tile format null anull
  aresample aformat setpts asetpts transpose hflip vflip setsar pad crop trim atrim
  zscale tonemap apad)

# x265 / zimg / libvpl 是 C++ 静态库：让它们按文件名链接静态 libstdc++ / winpthread。
# 写 -lstdc++ 会命中 libstdc++.dll.a（gcc 驱动下 -static-libstdc++ 不生效），
# 产物就多依赖 libstdc++-6.dll，再混入静态版还会符号重复。
static_cxx_pc() {
  local pc
  for pc in x265 zimg vpl; do
    pc="$PREFIX/lib/pkgconfig/$pc.pc"
    [ -f "$pc" ] || continue
    sed -i -E 's/^Libs\.private:.*/Libs.private: -l:libstdc++.a -l:libwinpthread.a/' "$pc"
    grep -q '^Libs.private:' "$pc" || echo 'Libs.private: -l:libstdc++.a -l:libwinpthread.a' >> "$pc"
  done
}

build_ffmpeg() {
  static_cxx_pc
  fetch "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VER.tar.xz" ffmpeg.tar.xz
  unpack ffmpeg.tar.xz ffmpeg
  log "configure ffmpeg $FFMPEG_VER"
  local inst="$PREFIX/ffmpeg"
  ( cd "$WORK/build/ffmpeg"
    ./configure --prefix="$inst" \
      --enable-shared --disable-static \
      --enable-gpl --disable-autodetect --enable-w32threads \
      --disable-debug --disable-doc --disable-network --disable-avdevice \
      --disable-ffplay --enable-ffmpeg --enable-ffprobe \
      --disable-everything \
      --enable-zlib --enable-libx264 --enable-libx265 --enable-libwebp \
      --enable-libmp3lame --enable-libopus --enable-libdav1d --enable-libzimg \
      --enable-ffnvcodec --enable-nvenc --enable-amf --enable-libvpl \
      --enable-protocol=file,pipe \
      --enable-demuxer="$(join "${DEMUXERS[@]}")" \
      --enable-decoder="$(join "${VDEC[@]}" "${ADEC[@]}")" \
      --enable-parser="$(join "${PARSERS[@]}")" \
      --enable-encoder="$(join "${ENCODERS[@]}")" \
      --enable-muxer="$(join "${MUXERS[@]}")" \
      --enable-bsf="$(join "${BSFS[@]}")" \
      --enable-filter="$(join "${FILTERS[@]}")" \
      --pkg-config="$PKGCONF" --pkg-config-flags=--static \
      --extra-cflags="-I$PREFIX/include" \
      --extra-ldflags="-L$PREFIX/lib -static-libgcc"
    make -j"$JOBS" && make install )
}

# 把 exe + dll 收拢到 $OUT，剥离符号，检查不依赖 MinGW 运行时 DLL
collect_ffmpeg() {
  local inst="$WORK/prefix/ffmpeg"
  log "collect -> $OUT"
  rm -rf "$OUT"; mkdir -p "$OUT"
  cp "$inst/bin/ffmpeg.exe" "$inst/bin/ffprobe.exe" "$OUT/"
  cp "$inst"/bin/*.dll "$OUT/"
  strip --strip-unneeded "$OUT"/*.exe "$OUT"/*.dll
  cp "$WORK/build/ffmpeg/COPYING.GPLv2" "$OUT/LICENSE-FFmpeg-GPLv2.txt"

  local bad
  bad=$(objdump -p "$OUT"/*.exe "$OUT"/*.dll | grep 'DLL Name' | grep -iE 'libgcc|libstdc|winpthread|libssp|zlib1' || true)
  if [ -n "$bad" ]; then echo "unexpected runtime DLL deps:"; echo "$bad"; exit 1; fi

  "$OUT/ffmpeg.exe" -hide_banner -version | head -1
  { echo "FFmpeg $FFMPEG_VER (minimal build for CM FrameKit)"
    echo "x264 $X264_SHA | x265 $X265_VER | libwebp $WEBP_VER | lame $LAME_VER | opus $OPUS_VER | dav1d $DAV1D_VER"
    echo "nv-codec-headers $NVHDR_VER | AMF $AMF_VER | libvpl $VPL_VER | zlib $ZLIB_VER | zimg $ZIMG_VER"
    echo; "$OUT/ffmpeg.exe" -hide_banner -buildconf
  } > "$OUT/BUILDINFO.txt"
  du -ch "$OUT"/* | tail -1
}
