//! Preview video (several short clips joined) as MP4 / GIF / animated WebP, plus hardware
//! encoder detection.
//!
//! MP4 output is pinned to what every browser and Apple device decodes:
//!   video  8-bit 4:2:0 — H.264 High or HEVC Main tagged `hvc1` (ffmpeg's default `hev1` is
//!          rejected by Safari/iOS/QuickTime)
//!   audio  AAC-LC stereo 48 kHz (Opus-in-MP4 is silent/unplayable on Safari; MP3-in-MP4 is
//!          non-standard)
//!   +faststart (moov before mdat) and a keyframe at least every 2 s, so Safari can start and
//!   seek without downloading the whole file.
//! The written file is then scanned (mp4box) to prove all of the above.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde_json::{json, Value};
use tauri::{AppHandle, Runtime};
use tokio::sync::Mutex;

use crate::compat;
use crate::ff::{self, Cancel, FfError};
use crate::probe::{self, MediaInfo};
use crate::util::*;

struct Enc {
    vcodec: &'static str,
    opts: &'static [&'static str],
    pix_fmt: &'static str,
    hevc: bool,
}

// NVENC 的 -forced-idr：强制关键帧必须是 IDR，否则 MP4 里不算同步帧，Safari 拖动会落空
fn encoder(codec: &str) -> Enc {
    let e = |vcodec, opts, pix_fmt, hevc| Enc { vcodec, opts, pix_fmt, hevc };
    match codec {
        "h265" => e("libx265", &["-crf", "28", "-preset", "fast", "-profile:v", "main", "-x265-params", "log-level=error"], "yuv420p", true),
        "h264_nvenc" => e("h264_nvenc", &["-rc", "vbr", "-cq", "23", "-preset", "p5", "-profile:v", "high", "-forced-idr", "1"], "yuv420p", false),
        "hevc_nvenc" => e("hevc_nvenc", &["-rc", "vbr", "-cq", "28", "-preset", "p5", "-profile:v", "main", "-forced-idr", "1"], "yuv420p", true),
        "h264_qsv" => e("h264_qsv", &["-global_quality", "23", "-profile:v", "high"], "nv12", false),
        "hevc_qsv" => e("hevc_qsv", &["-global_quality", "28", "-profile:v", "main"], "nv12", true),
        "h264_amf" => e("h264_amf", &["-rc", "cqp", "-qp_i", "23", "-qp_p", "23", "-profile:v", "high"], "nv12", false),
        "hevc_amf" => e("hevc_amf", &["-rc", "cqp", "-qp_i", "28", "-qp_p", "28", "-profile:v", "main"], "nv12", true),
        _ => e("libx264", &["-crf", "23", "-preset", "fast", "-profile:v", "high"], "yuv420p", false),
    }
}

/// GIF/WebP 的中间片段：高质量 H.264，与所选编码器无关
fn intermediate() -> Enc {
    Enc { vcodec: "libx264", opts: &["-crf", "16", "-preset", "veryfast"], pix_fmt: "yuv420p", hevc: false }
}

/// 小型 xorshift，够打乱片段用，免去 rand 依赖
struct Rng(u64);
impl Rng {
    fn new() -> Self {
        let seed = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(1);
        Rng(seed | 1)
    }
    fn next(&mut self) -> f64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// 把视频均分成若干不重叠区间，每个区间取一个片段。返回 (起点列表, 每段时长 None=整段)
fn plan_clips(duration: f64, clips: i64, clip_dur: f64, random: bool) -> (Vec<f64>, Option<f64>) {
    let max_fit = if duration > 0.0 { (duration / clip_dur).floor() as i64 } else { 0 };
    if max_fit < 1 {
        // 连一个完整片段都放不下 → 整段转码
        return (vec![0.0], None);
    }
    let n = clips.clamp(1, max_fit);
    let bin = duration / n as f64;
    let mut rng = Rng::new();
    let mut pts: Vec<f64> = (0..n)
        .map(|i| {
            let off = if random { rng.next() * (bin - clip_dur).max(0.0) } else { 0.0 };
            ((i as f64 * bin + off) * 10.0).round() / 10.0
        })
        .collect();
    if random {
        for i in (1..pts.len()).rev() {
            let j = (rng.next() * (i + 1) as f64) as usize;
            pts.swap(i, j.min(i));
        }
    }
    (pts, Some(clip_dur))
}

fn clip_args(info: &MediaInfo, input: &Path, start: f64, dur: Option<f64>, vf: &str, enc: &Enc, audio: bool, out: &Path) -> Vec<String> {
    let mut a: Vec<String> = vec!["-ss".into(), format!("{start:.3}"), "-i".into(), path_str(input)];
    if let Some(d) = dur {
        a.extend(["-t".into(), format!("{d:.3}")]);
    }
    a.extend(["-map".into(), "0:v:0".into(), "-vf".into(), vf.to_string(), "-c:v".into(), enc.vcodec.into()]);
    a.extend(enc.opts.iter().map(|s| s.to_string()));
    // 至少每 2 秒一个关键帧：Safari 拖动进度条只能落在关键帧上
    a.extend(["-force_key_frames".into(), "expr:gte(t,n_forced*2)".into()]);
    if info.video.as_ref().is_some_and(is_hdr) {
        // 已色调映射为 SDR：显式写 BT.709 标记，免得播放器仍按 HDR 解释
        a.extend(["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"].iter().map(|s| s.to_string()));
    }
    let track = info.audio_tracks.iter().find(|t| t.is_default).or(info.audio_tracks.first());
    match (audio, track) {
        (true, Some(t)) => {
            a.extend(["-map".into(), format!("0:a:{}", t.index)]);
            // AAC-LC 双声道 48k：Safari/Chrome/Firefox/所有 Apple 设备通吃。
            // apad + -shortest：片段里音频比视频短时补静音，保证各片段音视频等长、拼接不跑偏
            a.extend(["-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000", "-af", "apad", "-shortest"].iter().map(|s| s.to_string()));
        }
        _ => a.push("-an".into()),
    }
    a.extend(["-sn".into(), "-dn".into(), "-f".into(), "mpegts".into(), path_str(out)]);
    a
}

/// concat 列表里的路径：单引号需写成 '\''
fn concat_line(p: &Path) -> String {
    let s = path_str(p).replace('\\', "/").replace('\'', r"'\''");
    format!("file '{s}'\n")
}

pub async fn generate<R: Runtime>(app: &AppHandle<R>, task: &str, input: &Path, output: &Path, options: &Value, cancel: Option<&Cancel>) -> Result<Vec<String>, FfError> {
    let info = probe::probe(input).await?;
    let v = info.video.as_ref().ok_or_else(|| FfError::msg("没有视频轨"))?;
    let format = opt_str(options, "format").unwrap_or_else(|| "mp4".into()).to_ascii_lowercase();
    let codec = opt_str(options, "codec").unwrap_or_else(|| "h264".into());
    let width = opt_i64(options, "width").filter(|w| *w > 0).unwrap_or(640);
    let fps = opt_f64(options, "fps").unwrap_or(0.0);
    let clips = opt_i64(options, "clips").unwrap_or(5);
    let clip_dur = opt_f64(options, "clipDuration").filter(|d| *d > 0.0).unwrap_or(1.0);
    let random = opt_bool(options, "random").unwrap_or(true);
    let is_mp4 = format == "mp4";
    // GIF/WebP 是动图，没有音频
    let audio = is_mp4 && opt_bool(options, "includeAudio").unwrap_or(false);

    let enc = if is_mp4 { encoder(&codec) } else { intermediate() };
    let vf = video_chain(Some(v), &ChainOpts { width, height: 0, fps, deinterlace: true, pix_fmt: Some(enc.pix_fmt) });
    let (points, seg) = plan_clips(info.duration, clips, clip_dur, random);

    let tmp = output.parent().unwrap_or(Path::new(".")).join("_preview_tmp");
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp)?;
    let result = async {
        let mut files: Vec<PathBuf> = Vec::new();
        let n = points.len();
        for (i, &t) in points.iter().enumerate() {
            if let Some(c) = cancel {
                c.check()?;
            }
            let msg = if seg.is_none() { "转码整段中".to_string() } else { format!("截取片段 {}/{n}", i + 1) };
            let clip = tmp.join(format!("clip_{i:03}.ts"));
            let args = clip_args(&info, input, t, seg, &vf, &enc, audio, &clip);
            let span = seg.unwrap_or(info.duration);
            ff::ffmpeg(&args, cancel, span, |p| emit(app, task, (i as f64 + p / 100.0) / n as f64 * 90.0, msg.clone())).await?;
            files.push(clip);
        }
        if let Some(c) = cancel {
            c.check()?;
        }

        let list = tmp.join("clips.txt");
        let body: String = files.iter().map(|f| concat_line(f)).collect();
        std::fs::write(&list, body)?;
        let mut args: Vec<String> = vec!["-f".into(), "concat".into(), "-safe".into(), "0".into(), "-i".into(), path_str(&list)];
        match format.as_str() {
            "gif" => {
                emit(app, task, 95.0, "转码为 GIF 中");
                let colors = opt_i64(options, "gifColors").unwrap_or(256).clamp(2, 256);
                args.extend([
                    "-filter_complex".into(),
                    format!("[0:v]split[a][b];[a]palettegen=max_colors={colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3"),
                    "-an".into(),
                    "-loop".into(),
                    "0".into(),
                ]);
            }
            "webp" => {
                emit(app, task, 95.0, "转码为 WebP 中");
                let q = opt_i64(options, "webpQuality").unwrap_or(70).clamp(0, 100);
                args.extend(["-c:v", "libwebp_anim", "-loop", "0", "-lossless", "0"].iter().map(|s| s.to_string()));
                args.extend(["-quality".into(), q.to_string(), "-an".into()]);
            }
            _ => {
                emit(app, task, 95.0, "合并片段中");
                args.extend(["-map".into(), "0".into(), "-c".into(), "copy".into()]);
                if enc.hevc {
                    // ffmpeg 默认写 hev1，Safari / iOS / QuickTime 只认 hvc1
                    args.extend(["-tag:v".into(), "hvc1".into()]);
                }
                args.extend(["-movflags".into(), "+faststart".into()]);
            }
        }
        args.push(path_str(output));
        ff::ffmpeg(&args, cancel, 0.0, |_| {}).await?;
        Ok(if is_mp4 { compat::verify_output(output) } else { Vec::new() })
    }
    .await;
    let _ = std::fs::remove_dir_all(&tmp);
    result
}

#[tauri::command]
pub async fn generate_preview(app: AppHandle, input_path: String, output_dir: String, options: Value) -> Value {
    let task = "preview";
    let cancel = ff::register(task);
    let input = PathBuf::from(&input_path);
    let format = opt_str(&options, "format").unwrap_or_else(|| "mp4".into()).to_ascii_lowercase();
    let ext = match format.as_str() {
        "gif" => "gif",
        "webp" => "webp",
        _ => "mp4",
    };
    let codec = opt_str(&options, "codec").unwrap_or_else(|| "h264".into());
    let mut output: Option<PathBuf> = None;
    let r = async {
        let out = job_dir(&output_dir, &input)?.join(format!("preview.{ext}"));
        output = Some(out.clone());
        emit(&app, task, 0.0, format!("开始生成预览 ({codec})..."));
        let warnings = generate(&app, task, &input, &out, &options, Some(&cancel)).await?;
        emit(&app, task, 100.0, "预览生成完成");
        let size = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
        Ok::<Value, FfError>(json!({ "success": true, "outputPath": path_str(&out), "size": size, "warnings": warnings }))
    }
    .await;
    ff::unregister(task);
    r.unwrap_or_else(|e| {
        if e.is_cancelled() {
            if let Some(o) = output {
                remove_files(&[o]);
            }
        } else {
            emit(&app, task, -1.0, format!("预览视频生成失败: {}", e.message()));
        }
        fail_json(&e)
    })
}

// ---------------- hardware encoders ----------------

/// 实测编码器是否真能用（编进 ffmpeg ≠ 有对应硬件/驱动）。用 stdin 喂 320×240 的原始帧，
/// 不依赖 lavfi（精简版 ffmpeg 不含 avdevice）。分辨率不能太小，否则 AMF 会 Init 失败被误判。
async fn test_encoder(name: &'static str) -> bool {
    let (w, h, frames) = (320usize, 240usize, 5usize);
    let mut frame = vec![16u8; w * h];
    frame.extend(vec![128u8; w * h / 2]);
    let input: Vec<u8> = frame.repeat(frames);
    let args: Vec<String> = [
        "-f", "rawvideo", "-pix_fmt", "yuv420p", "-s", "320x240", "-r", "10", "-i", "pipe:0",
        "-frames:v", "5", "-c:v", name, "-f", "null", "-",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    ff::ffmpeg_stdin_ok(&args, input, 10).await
}

#[tauri::command]
pub async fn get_hw_encoders() -> Value {
    static CACHE: OnceLock<Mutex<Option<Value>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    let mut guard = cache.lock().await;
    if let Some(v) = guard.as_ref() {
        return v.clone();
    }
    let candidates = [("nvenc", "NVENC", "h264_nvenc", "hevc_nvenc"), ("qsv", "QSV", "h264_qsv", "hevc_qsv"), ("amf", "AMF", "h264_amf", "hevc_amf")];
    let handles: Vec<_> = candidates
        .iter()
        .map(|&(key, label, h264, h265)| {
            tokio::spawn(async move {
                let (a, b) = tokio::join!(test_encoder(h264), test_encoder(h265));
                (a || b).then(|| json!({ "key": key, "label": label, "h264": a, "h265": b }))
            })
        })
        .collect();
    let mut found = Vec::new();
    for h in handles {
        if let Ok(Some(v)) = h.await {
            found.push(v);
        }
    }
    let v = json!(found);
    *guard = Some(v.clone());
    v
}
