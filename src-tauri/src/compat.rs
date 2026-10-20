//! Web / Apple-device compatibility: analysis of the imported video, and verification of what
//! we wrote. Rules reflect browser behaviour as of 2026:
//!  - Safari: H.264 8-bit 4:2:0, HEVC only as `hvc1` (not `hev1`), AV1 only with a hardware decoder
//!    (M3 / A17 Pro and newer — not M1/M2), no Opus in MP4, Ogg only from 18.4.
//!  - Chrome/Edge: HEVC only via hardware decode; no AC-3/E-AC-3 (Edge on Windows aside), no DTS.
//!  - Firefox: HEVC only on Windows with hardware + system HEVC support.
//!  - Nothing hardware-decodes H.264 High 10 / 4:2:2 / 4:4:4, so browsers refuse it.

use std::path::Path;

use serde::Serialize;

use crate::mp4box::{self, Mp4Info};
use crate::probe::{AudioTrack, MediaInfo, VideoStream};

#[derive(Debug, Clone, Serialize)]
pub struct Issue {
    /// "error" = 目标平台放不了；"warn" = 部分平台有问题；"info" = 提示
    pub level: &'static str,
    pub code: &'static str,
    pub zh: Text,
    pub en: Text,
}

#[derive(Debug, Clone, Serialize)]
pub struct Text {
    pub title: String,
    pub detail: String,
}

fn issue(level: &'static str, code: &'static str, zh: (&str, String), en: (&str, String)) -> Issue {
    Issue {
        level,
        code,
        zh: Text { title: zh.0.into(), detail: zh.1 },
        en: Text { title: en.0.into(), detail: en.1 },
    }
}

fn ext_of(path: &Path) -> String {
    path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

fn is_420_8bit(pix: &str) -> bool {
    matches!(pix, "yuv420p" | "yuvj420p" | "nv12")
}

fn is_hdr(v: &VideoStream) -> Option<&'static str> {
    match v.color_transfer.as_str() {
        "smpte2084" => Some("HDR10 / PQ"),
        "arib-std-b67" => Some("HLG"),
        _ => None,
    }
}

// ---------------- container ----------------

fn check_container(path: &Path, info: &MediaInfo, mp4: Option<&Mp4Info>, out: &mut Vec<Issue>) {
    let ext = ext_of(path);
    let web_ok = matches!(ext.as_str(), "mp4" | "m4v" | "mov" | "webm");
    if !web_ok {
        out.push(issue(
            "info",
            "container",
            ("容器不能直接在网页播放", format!(".{ext}（{}）浏览器不支持；本软件生成的 MP4 预览不受影响。", info.format)),
            ("Container not playable on the web", format!(".{ext} ({}) is not supported by browsers; previews generated here are MP4 and unaffected.", info.format)),
        ));
    }
    if ext == "webm" {
        out.push(issue(
            "warn",
            "webm",
            ("WebM 在 Safari 上支持不完整", "旧版 Safari / iOS 无法播放 WebM，Apple 设备请用 MP4（H.264 + AAC）。".into()),
            ("WebM is patchy on Safari", "Older Safari / iOS cannot play WebM; use MP4 (H.264 + AAC) for Apple devices.".into()),
        ));
    }
    if let Some(m) = mp4 {
        if m.faststart == Some(false) && !m.fragmented {
            out.push(issue(
                "warn",
                "moov_at_end",
                ("moov 在文件末尾（未 faststart）", "Safari / iOS 需先读取文件尾才能播放和拖动进度；若服务器 Range 支持不好，会出现无法快进、要等下载完才能播放。生成的预览已自动 faststart。".into()),
                ("moov atom at end of file (not faststart)", "Safari / iOS must read the file tail before playing or seeking; with weak HTTP Range support seeking fails until fully downloaded. Previews generated here are faststart.".into()),
            ));
        }
        if m.fragmented {
            out.push(issue(
                "info",
                "fragmented",
                ("分片 MP4（fMP4）", "直接作为文件播放时部分播放器无法显示总时长或拖动。".into()),
                ("Fragmented MP4", "Some players show no duration or cannot seek when it is played as a plain file.".into()),
            ));
        }
    }
}

// ---------------- video ----------------

fn check_video(v: &VideoStream, mp4: Option<&Mp4Info>, out: &mut Vec<Issue>) {
    let codec = v.codec.as_str();
    let prof = v.profile.to_ascii_lowercase();
    let pix = v.pix_fmt.as_str();
    let desc = format!("{} {} {}", v.codec, v.profile, v.pix_fmt);

    match codec {
        "h264" => {
            if !is_420_8bit(pix) || prof.contains("10") || prof.contains("4:2:2") || prof.contains("4:4:4") {
                out.push(issue(
                    "error",
                    "h264_highbit",
                    ("H.264 10-bit / 4:2:2 / 4:4:4：所有浏览器都放不了", format!("{desc}。没有任何 GPU（包括 Apple M 系列）硬解此规格，Safari、Chrome、Firefox 都会黑屏或报错。请用本软件生成的预览（已转为 8-bit 4:2:0）。")),
                    ("H.264 10-bit / 4:2:2 / 4:4:4: no browser plays it", format!("{desc}. No GPU (Apple Silicon included) decodes this in hardware; Safari, Chrome and Firefox all fail. Use the generated preview (8-bit 4:2:0).")),
                ));
            }
            if v.level > 52 || v.width * v.height > 4096 * 2304 {
                out.push(issue(
                    "warn",
                    "h264_level",
                    ("H.264 分辨率/级别超出常见硬解上限", format!("{}×{}，Level {:.1}。iPhone/低端设备可能卡顿或拒绝播放。", v.width, v.height, v.level as f64 / 10.0)),
                    ("H.264 beyond common hardware limits", format!("{}×{}, Level {:.1}. iPhones / low-end devices may stutter or refuse.", v.width, v.height, v.level as f64 / 10.0)),
                ));
            }
        }
        "hevc" => {
            if mp4.is_some_and(|m| m.video.iter().any(|t| t == "hev1")) {
                out.push(issue(
                    "error",
                    "hev1",
                    ("HEVC 标记为 hev1：Safari / iOS / QuickTime 无法播放", "Apple 只接受 hvc1 标记。可无损修复：ffmpeg -i in.mp4 -c copy -tag:v hvc1 -movflags +faststart out.mp4（本软件生成的 H.265 预览已使用 hvc1）。".into()),
                    ("HEVC tagged hev1: Safari / iOS / QuickTime refuse it", "Apple only accepts hvc1. Lossless fix: ffmpeg -i in.mp4 -c copy -tag:v hvc1 -movflags +faststart out.mp4 (H.265 previews generated here use hvc1).".into()),
                ));
            }
            if pix.contains("422") || pix.contains("444") || prof.contains("rext") || prof.contains("4:2:2") {
                out.push(issue(
                    "error",
                    "hevc_422",
                    ("HEVC 4:2:2 / 4:4:4：浏览器基本无法播放", format!("{desc}。仅部分较新的 Apple 芯片与 Intel 核显能硬解，Chrome/Firefox/多数 Mac 的 Safari 放不了。")),
                    ("HEVC 4:2:2 / 4:4:4: browsers mostly cannot play it", format!("{desc}. Only some newer Apple chips and Intel iGPUs decode it; Chrome, Firefox and Safari on most Macs fail.")),
                ));
            }
            out.push(issue(
                "warn",
                "hevc_browser",
                ("HEVC 依赖硬件解码", "Safari（Mac/iOS，含 M1）可播；Chrome/Edge 需显卡支持 HEVC 硬解；Firefox 仅 Windows 且有硬解时可播；Linux 基本不行。面向所有浏览器请选 H.264。".into()),
                ("HEVC needs hardware decoding", "Safari (Mac/iOS incl. M1) plays it; Chrome/Edge need a GPU HEVC decoder; Firefox only on Windows with hardware support; Linux mostly not. Pick H.264 to reach every browser.".into()),
            ));
        }
        "av1" => out.push(issue(
            "warn",
            "av1_apple",
            ("AV1：M1/M2 Mac 和较旧 iPhone 的 Safari 放不了", "Safari 只在有 AV1 硬解的设备（M3 / A17 Pro 及更新）上播放 AV1。Chrome/Firefox 可软解，但高分辨率很吃 CPU。".into()),
            ("AV1: Safari on M1/M2 Macs and older iPhones cannot play it", "Safari plays AV1 only with a hardware decoder (M3 / A17 Pro and newer). Chrome/Firefox decode in software, heavy at high resolutions.".into()),
        )),
        "vp9" | "vp8" => out.push(issue(
            "warn",
            "vpx_apple",
            ("VP8/VP9：Apple 设备支持不稳定", format!("{}：Safari 仅较新版本在 WebM 中支持，MP4 中的 VP9 不支持；iOS 支持更差。", v.codec.to_uppercase())),
            ("VP8/VP9: unreliable on Apple devices", format!("{}: only recent Safari supports it, in WebM only (not VP9-in-MP4); iOS is worse.", v.codec.to_uppercase())),
        )),
        "prores" => out.push(issue(
            "error",
            "prores",
            ("ProRes：仅 Mac 上的 Safari 能播", "Chrome、Firefox、Windows、Android 都不支持，且码率极高不适合网络播放。".into()),
            ("ProRes: only Safari on macOS plays it", "Chrome, Firefox, Windows and Android do not; the bitrate is also far too high for the web.".into()),
        )),
        _ => out.push(issue(
            "error",
            "vcodec",
            ("视频编码不被浏览器支持", format!("{}：网页无法播放，请使用生成的 MP4 预览。", v.codec)),
            ("Video codec not supported by browsers", format!("{}: cannot play on the web; use the generated MP4 preview.", v.codec)),
        )),
    }
    check_video_common(v, out);
}

fn check_video_common(v: &VideoStream, out: &mut Vec<Issue>) {
    if let Some(kind) = is_hdr(v) {
        out.push(issue(
            "warn",
            "hdr",
            ("HDR 视频", format!("{kind}。在 SDR 屏幕或不支持 HDR 的浏览器上会发灰、过曝。生成的预览/截帧会做色调映射转为 SDR（BT.709）。")),
            ("HDR video", format!("{kind}. Looks washed out on SDR screens or browsers without HDR. Generated previews / frames are tone-mapped to SDR (BT.709).")),
        ));
    }
    if v.dolby_vision && is_hdr(v).is_none() {
        out.push(issue(
            "error",
            "dovi_only",
            ("纯 Dolby Vision（无 HDR10/HLG 兼容层）", "非 Apple 设备会显示紫绿色画面。".into()),
            ("Dolby Vision without an HDR10/HLG base layer", "Shows purple/green colours outside Apple devices.".into()),
        ));
    }
    if matches!(v.field_order.as_str(), "tt" | "bb" | "tb" | "bt") {
        out.push(issue(
            "warn",
            "interlaced",
            ("隔行扫描视频", "浏览器不做反交错，运动画面会有梳齿纹。生成的预览已自动反交错。".into()),
            ("Interlaced video", "Browsers do not deinterlace; motion shows combing. Generated previews are deinterlaced.".into()),
        ));
    }
    if v.fps > 61.0 {
        out.push(issue(
            "info",
            "high_fps",
            ("高帧率", format!("{:.0} fps。部分手机和低端设备只能硬解到 60 fps；可在预览设置里降低帧率。", v.fps)),
            ("High frame rate", format!("{:.0} fps. Some phones and low-end devices only decode up to 60 fps; lower it in preview settings.", v.fps)),
        ));
    }
    if v.sar.0 != v.sar.1 {
        out.push(issue(
            "info",
            "anamorphic",
            ("非方形像素（变形宽银幕）", format!("SAR {}:{}。GIF/WebP 和部分播放器会忽略它导致画面被压扁；生成的预览已转为方形像素。", v.sar.0, v.sar.1)),
            ("Non-square pixels (anamorphic)", format!("SAR {}:{}. GIF/WebP and some players ignore it and squash the picture; generated previews use square pixels.", v.sar.0, v.sar.1)),
        ));
    }
}

// ---------------- audio ----------------

fn check_audio(tracks: &[AudioTrack], container: &str, out: &mut Vec<Issue>) {
    let Some(a) = tracks.iter().find(|t| t.is_default).or(tracks.first()) else { return };
    let mp4 = matches!(container, "mp4" | "m4v" | "mov" | "m4a");
    match a.codec.as_str() {
        "aac" => {}
        "mp3" if mp4 => out.push(issue(
            "info",
            "mp3_in_mp4",
            ("MP4 中的 MP3 音频", "多数浏览器可播，但 AAC 才是 MP4 的标准音频，兼容性最好。".into()),
            ("MP3 audio inside MP4", "Most browsers cope, but AAC is the standard MP4 audio and the safest.".into()),
        )),
        "mp3" => {}
        "opus" if mp4 => out.push(issue(
            "error",
            "opus_in_mp4",
            ("MP4 中的 Opus 音频：Safari 没声音/无法播放", "Safari / iOS 不支持 MP4 封装的 Opus。请改用 AAC。".into()),
            ("Opus audio inside MP4: Safari fails", "Safari / iOS do not support Opus in MP4. Use AAC.".into()),
        )),
        "opus" | "vorbis" => out.push(issue(
            "warn",
            "ogg_audio",
            ("Opus/Vorbis 音频：旧版 Safari 不支持", "Ogg 封装需 Safari 18.4+（macOS 15.4 / iOS 18.4）；WebM 中的 Opus 需 Safari 15+。".into()),
            ("Opus/Vorbis audio: old Safari lacks it", "Ogg needs Safari 18.4+ (macOS 15.4 / iOS 18.4); Opus in WebM needs Safari 15+.".into()),
        )),
        "ac3" | "eac3" => out.push(issue(
            "error",
            "dolby_audio",
            ("AC-3 / E-AC-3（杜比）音频：Chrome/Firefox 没声音", "Safari 与 Windows 上的 Edge 可播，Chrome 和 Firefox 不支持，画面正常但无声。".into()),
            ("AC-3 / E-AC-3 (Dolby) audio: silent in Chrome/Firefox", "Safari and Edge on Windows play it; Chrome and Firefox do not — video plays without sound.".into()),
        )),
        "dts" | "truehd" | "mlp" => out.push(issue(
            "error",
            "dts_audio",
            ("DTS / TrueHD 音频：所有浏览器都没声音", format!("{}：浏览器均不支持。", a.codec)),
            ("DTS / TrueHD audio: silent in every browser", format!("{}: unsupported by all browsers.", a.codec)),
        )),
        c if c.starts_with("pcm_") => out.push(issue(
            "warn",
            "pcm_audio",
            ("PCM 无压缩音频", "MP4/MOV 中的 PCM 浏览器支持不一，体积也大；网络播放请用 AAC。".into()),
            ("Uncompressed PCM audio", "PCM in MP4/MOV is unevenly supported and large; use AAC for the web.".into()),
        )),
        "flac" | "alac" => out.push(issue(
            "warn",
            "lossless_audio",
            ("无损音频（FLAC/ALAC）", "浏览器支持参差（ALAC 基本只有 Safari），体积大；网络播放请用 AAC。".into()),
            ("Lossless audio (FLAC/ALAC)", "Uneven browser support (ALAC is basically Safari-only) and large; use AAC for the web.".into()),
        )),
        other => out.push(issue(
            "error",
            "acodec",
            ("音频编码不被浏览器支持", format!("{other}：网页播放会没有声音。")),
            ("Audio codec not supported by browsers", format!("{other}: the web player will be silent.")),
        )),
    }
    if tracks.len() > 1 {
        out.push(issue(
            "info",
            "multi_audio",
            ("多条音轨", format!("共 {} 条。浏览器只播放默认音轨，无法切换；可用「提取音频」分别导出。", tracks.len())),
            ("Multiple audio tracks", format!("{} tracks. Browsers only play the default one; export them separately with Extract Audio.", tracks.len())),
        ));
    }
}

/// 导入视频后的兼容性分析
pub fn analyze(path: &Path, info: &MediaInfo) -> Vec<Issue> {
    let mp4 = if mp4box::is_mp4_like(path) { mp4box::scan(path).ok() } else { None };
    let mut out = Vec::new();
    check_container(path, info, mp4.as_ref(), &mut out);
    if let Some(v) = &info.video {
        check_video(v, mp4.as_ref(), &mut out);
    }
    check_audio(&info.audio_tracks, &ext_of(path), &mut out);
    // error → warn → info
    let rank = |l: &str| match l { "error" => 0, "warn" => 1, _ => 2 };
    out.sort_by_key(|i| rank(i.level));
    out
}

/// 校验我们写出的 MP4/M4A：faststart、hvc1、AAC。返回发现的问题（正常应为空）。
pub fn verify_output(path: &Path) -> Vec<String> {
    let mut problems = Vec::new();
    let m = match mp4box::scan(path) {
        Ok(m) => m,
        Err(e) => return vec![format!("无法读取输出文件：{e}")],
    };
    if m.faststart != Some(true) {
        problems.push("moov 不在文件头（未 faststart）".to_string());
    }
    for t in &m.video {
        if !matches!(t.as_str(), "avc1" | "hvc1") {
            problems.push(format!("视频 sample entry 为 {t}（应为 avc1/hvc1）"));
        }
    }
    for t in &m.audio {
        if t != "mp4a" {
            problems.push(format!("音频 sample entry 为 {t}（应为 mp4a/AAC）"));
        }
    }
    problems
}
