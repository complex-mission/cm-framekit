//! Frames: interval batch export, saving frames captured in the UI, and server-side frame grabs
//! for sources the WebView cannot decode (AVI/WMV/MPEG-2/ProRes/HEVC without hardware …).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine;
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::ff::{self, FfError};
use crate::probe;
use crate::util::*;

/// 质量(0-100) → 各格式的编码参数
pub fn frame_codec_args(format: &str, quality: Option<i64>) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();
    match format {
        "jpg" | "jpeg" => {
            a.extend(["-c:v".into(), "mjpeg".into()]);
            if let Some(q) = quality {
                let qs = ((100 - q.clamp(0, 100)) as f64 / 100.0 * 30.0 + 2.0).round() as i64;
                a.extend(["-q:v".into(), qs.to_string()]);
            }
        }
        "webp" => {
            // 必须显式用 libwebp：默认的 libwebp_anim 会把整个序列塞进一个动画文件
            a.extend(["-c:v".into(), "libwebp".into()]);
            a.extend(["-quality".into(), quality.unwrap_or(80).clamp(0, 100).to_string()]);
        }
        _ => {
            a.extend(["-c:v".into(), "png".into()]);
            if let Some(q) = quality {
                let lvl = ((100 - q.clamp(0, 100)) as f64 / 100.0 * 9.0).round() as i64;
                a.extend(["-compression_level".into(), lvl.to_string()]);
            }
        }
    }
    a
}

/// 截图统一 8-bit：PNG 用 rgb24（10-bit 源否则会写出 48 位 PNG，体积翻倍）
pub fn frame_pix_fmt(format: &str) -> Option<&'static str> {
    match format {
        "png" => Some("rgb24"),
        "jpg" | "jpeg" => Some("yuvj420p"),
        _ => None,
    }
}

#[tauri::command]
pub async fn extract_frames(app: AppHandle, input_path: String, output_dir: String, options: Value) -> Value {
    let task = "frames";
    let cancel = ff::register(task);
    let r = async {
        let input = PathBuf::from(&input_path);
        let info = probe::probe(&input).await?;
        let dir = job_dir(&output_dir, &input)?.join("frames");
        std::fs::create_dir_all(&dir)?;
        let format = opt_str(&options, "format").unwrap_or_else(|| "png".into());
        let interval = opt_f64(&options, "interval").filter(|v| *v > 0.0).unwrap_or(5.0);
        let chain = video_chain(
            info.video.as_ref(),
            &ChainOpts { width: 0, height: opt_i64(&options, "height").unwrap_or(0), fps: 0.0, deinterlace: true, pix_fmt: frame_pix_fmt(&format) },
        );
        emit(&app, task, 0.0, "开始批量截帧...");
        let mut args: Vec<String> = vec!["-i".into(), input_path.clone(), "-an".into(), "-sn".into()];
        args.extend(["-vf".into(), format!("fps=1/{interval},{chain}")]);
        args.extend(frame_codec_args(&format, opt_i64(&options, "quality")));
        args.push(path_str(&dir.join(format!("frame_%06d.{format}"))));
        ff::ffmpeg(&args, Some(&cancel), info.duration, |p| emit(&app, task, p, "批量截帧中")).await?;
        let count = std::fs::read_dir(&dir)?
            .flatten()
            .filter(|e| {
                let n = e.file_name().to_string_lossy().into_owned();
                n.starts_with("frame_") && n.ends_with(&format!(".{format}"))
            })
            .count();
        emit(&app, task, 100.0, format!("批量截帧完成，共 {count} 帧"));
        Ok::<Value, FfError>(json!({ "success": true, "outputDir": path_str(&dir), "count": count }))
    }
    .await;
    ff::unregister(task);
    r.unwrap_or_else(|e| {
        if !e.is_cancelled() {
            emit(&app, task, -1.0, format!("批量截帧失败: {}", e.message()));
        }
        fail_json(&e)
    })
}

/// 保存界面里截下的帧（data URL），接着已有的 frame_xxxx 序号编号，多次导出不互相覆盖
#[tauri::command]
pub async fn export_frames(frames: Vec<Value>, format: String, output_dir: String, input_path: String) -> Value {
    let r = (|| {
        let dir = job_dir(&output_dir, Path::new(&input_path))?;
        let mut start = 0u32;
        for e in std::fs::read_dir(&dir)?.flatten() {
            let n = e.file_name().to_string_lossy().into_owned();
            if let Some(num) = n.strip_prefix("frame_").and_then(|r| r.split('.').next()).and_then(|d| d.parse::<u32>().ok()) {
                start = start.max(num);
            }
        }
        let ext: String = format.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
        let mut paths = Vec::new();
        let mut total = 0usize;
        for (i, f) in frames.iter().enumerate() {
            let url = f["dataUrl"].as_str().unwrap_or("");
            let b64 = url.split_once(";base64,").map(|(_, d)| d).unwrap_or(url);
            let bytes = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| FfError::msg(e.to_string()))?;
            let p = dir.join(format!("frame_{:04}.{ext}", start + i as u32 + 1));
            std::fs::write(&p, &bytes)?;
            total += bytes.len();
            paths.push(path_str(&p));
        }
        Ok::<Value, FfError>(json!({ "success": true, "paths": paths, "dir": path_str(&dir), "size": total }))
    })();
    r.unwrap_or_else(|e| fail_json(&e))
}

static GRAB_SEQ: AtomicU64 = AtomicU64::new(0);

/// 用 ffmpeg 解出某一时刻的画面（JPEG data URL）。WebView 放不了的格式靠它预览和截帧；
/// 同时做反交错 / 方形像素 / HDR 色调映射，与生成的产物观感一致。
#[tauri::command]
pub async fn grab_frame(input_path: String, time: f64, max_width: Option<i64>, full: Option<bool>) -> Value {
    let r = async {
        let input = PathBuf::from(&input_path);
        let info = probe::probe(&input).await?;
        let full = full.unwrap_or(false);
        let (fmt, ext) = if full { ("png", "png") } else { ("jpg", "jpg") };
        let chain = video_chain(
            info.video.as_ref(),
            &ChainOpts { width: if full { 0 } else { max_width.unwrap_or(1280) }, height: 0, fps: 0.0, deinterlace: true, pix_fmt: frame_pix_fmt(fmt) },
        );
        let tmp = std::env::temp_dir().join(format!("framekit_grab_{}_{}.{ext}", std::process::id(), GRAB_SEQ.fetch_add(1, Ordering::Relaxed)));
        let mut args: Vec<String> = vec!["-ss".into(), format!("{:.3}", time.max(0.0)), "-i".into(), input_path.clone()];
        args.extend(["-frames:v".into(), "1".into(), "-an".into(), "-sn".into(), "-vf".into(), chain]);
        args.extend(frame_codec_args(fmt, Some(if full { 100 } else { 85 })));
        args.extend(["-update".into(), "1".into(), path_str(&tmp)]);
        let res = ff::ffmpeg(&args, None, 0.0, |_| {}).await;
        let bytes = std::fs::read(&tmp);
        let _ = std::fs::remove_file(&tmp);
        res?;
        let bytes = bytes?;
        let mime = if full { "image/png" } else { "image/jpeg" };
        let data = base64::engine::general_purpose::STANDARD.encode(bytes);
        Ok::<Value, FfError>(json!({ "success": true, "dataUrl": format!("data:{mime};base64,{data}") }))
    }
    .await;
    r.unwrap_or_else(|e| fail_json(&e))
}
