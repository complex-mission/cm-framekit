//! Sprite sheet(s) + WebVTT thumbnails track.
//! WebP caps a side at 16383 px (JPEG 65535): long videos are split over several sheets
//! instead of failing, and the VTT points at the right sheet.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::{AppHandle, Runtime};

use crate::ff::{self, Cancel, FfError};
use crate::frames::frame_codec_args;
use crate::probe;
use crate::util::*;

fn max_side(format: &str) -> i64 {
    if format == "webp" { 16383 } else { 65500 }
}

fn vtt_time(t: f64) -> String {
    let ms = (t * 1000.0).round() as i64;
    format!("{:02}:{:02}:{:02}.{:03}", ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000)
}

pub async fn generate<R: Runtime>(app: &AppHandle<R>, task: &str, input: &Path, dir: &Path, options: &Value, cancel: Option<&Cancel>) -> Result<Value, FfError> {
    let info = probe::probe(input).await?;
    let v = info.video.as_ref().ok_or_else(|| FfError::msg("没有视频轨"))?;
    let duration = info.duration;
    let interval = opt_f64(options, "interval").filter(|x| *x > 0.0).unwrap_or(10.0);
    let format = opt_str(options, "format").unwrap_or_else(|| "webp".into());
    let quality = opt_i64(options, "quality").unwrap_or(75);
    let limit = max_side(&format);

    // 按显示比例（含旋转/SAR）算缩略图尺寸，避免黑边和变形
    let (dw, dh) = display_size(v);
    let thumb_w = opt_i64(options, "width").filter(|x| *x > 0).unwrap_or(160).min(limit);
    let thumb_h = ((thumb_w as f64 * dh.max(1) as f64 / dw.max(1) as f64).round() as i64).max(2);
    let cols = opt_i64(options, "cols").filter(|x| *x > 0).unwrap_or(10).min(limit / thumb_w).max(1);

    let thumbs = dir.join("_sprite_thumbs");
    let _ = std::fs::remove_dir_all(&thumbs);
    std::fs::create_dir_all(&thumbs)?;
    let result = async {
        // 1) 抽帧为无损 PNG 中间文件（避免二次有损压缩），占进度 0~90%
        let pre = video_chain(Some(v), &ChainOpts { width: 0, height: 0, fps: 0.0, deinterlace: true, pix_fmt: None });
        let vf = format!("fps=1/{interval}:round=up,{pre},scale={thumb_w}:{thumb_h},setsar=1,format=rgb24");
        let args: Vec<String> = vec![
            "-i".into(), path_str(input), "-an".into(), "-sn".into(),
            "-vf".into(), vf, "-c:v".into(), "png".into(), "-compression_level".into(), "1".into(),
            path_str(&thumbs.join("thumb_%05d.png")),
        ];
        ff::ffmpeg(&args, cancel, duration, |p| emit(app, task, p * 0.9, "生成缩略图中")).await?;

        let mut count = std::fs::read_dir(&thumbs)?.flatten().filter(|e| e.file_name().to_string_lossy().starts_with("thumb_")).count() as i64;
        if count == 0 {
            return Err(FfError::msg("未能提取任何缩略图"));
        }
        // round=up 偶尔会在片尾多抽一帧，超出时长的不要
        let expected = (duration / interval).ceil() as i64;
        if expected > 0 && count > expected {
            count = expected;
        }

        // 2) 拼接：每张雪碧图最多 rows_per_sheet 行
        let rows_total = (count + cols - 1) / cols;
        let rows_per_sheet = (limit / thumb_h).max(1);
        let sheets = (rows_total + rows_per_sheet - 1) / rows_per_sheet;
        let per_sheet = rows_per_sheet * cols;
        let mut sheet_paths: Vec<PathBuf> = Vec::new();
        for s in 0..sheets {
            if let Some(c) = cancel {
                c.check()?;
            }
            emit(app, task, 90.0 + 8.0 * s as f64 / sheets as f64, "拼接雪碧图中");
            let first = s * per_sheet;
            let n = (count - first).min(per_sheet);
            let rows = (n + cols - 1) / cols;
            let name = if sheets == 1 { format!("sprite.{format}") } else { format!("sprite_{}.{format}", s + 1) };
            let out = dir.join(&name);
            let mut args: Vec<String> = vec![
                "-framerate".into(), "1".into(), "-start_number".into(), (first + 1).to_string(),
                "-i".into(), path_str(&thumbs.join("thumb_%05d.png")),
                "-frames:v".into(), "1".into(),
                "-vf".into(), format!("tile={cols}x{rows}:nb_frames={n}"),
            ];
            args.extend(frame_codec_args(&format, Some(quality)));
            args.extend(["-update".into(), "1".into(), path_str(&out)]);
            ff::ffmpeg(&args, cancel, 0.0, |_| {}).await?;
            sheet_paths.push(out);
        }

        // 3) WebVTT
        let mut vtt = String::from("WEBVTT\n\n");
        for i in 0..count {
            let s = i / per_sheet;
            let k = i % per_sheet;
            let (x, y) = ((k % cols) * thumb_w, (k / cols) * thumb_h);
            let start = i as f64 * interval;
            let end = ((i + 1) as f64 * interval).min(duration.max(start + 0.001));
            let name = sheet_paths[s as usize].file_name().unwrap().to_string_lossy().into_owned();
            vtt.push_str(&format!("{} --> {}\n{name}#xywh={x},{y},{thumb_w},{thumb_h}\n\n", vtt_time(start), vtt_time(end)));
        }
        let vtt_path = dir.join("sprite.vtt");
        std::fs::write(&vtt_path, vtt)?;

        let rows_first = rows_total.min(rows_per_sheet);
        Ok(json!({
            "spritePath": path_str(&sheet_paths[0]),
            "spritePaths": sheet_paths.iter().map(|p| path_str(p)).collect::<Vec<_>>(),
            "vttPath": path_str(&vtt_path),
            "width": cols * thumb_w,
            "height": rows_first * thumb_h,
            "thumbCount": count,
            "cols": cols,
            "rows": rows_total,
            "sheets": sheets,
        }))
    }
    .await;
    // 无论成功/失败/取消都清理中间文件
    let _ = std::fs::remove_dir_all(&thumbs);
    result
}

#[tauri::command]
pub async fn generate_sprite(app: AppHandle, input_path: String, output_dir: String, options: Value) -> Value {
    let task = "sprite";
    let cancel = ff::register(task);
    let input = PathBuf::from(&input_path);
    let format = opt_str(&options, "format").unwrap_or_else(|| "webp".into());
    let r = async {
        let dir = job_dir(&output_dir, &input).map_err(|e| (e, None))?;
        emit(&app, task, 0.0, "开始生成雪碧图...");
        let mut v = generate(&app, task, &input, &dir, &options, Some(&cancel)).await.map_err(|e| (e, Some(dir.clone())))?;
        emit(&app, task, 100.0, "雪碧图生成完成");
        v["success"] = json!(true);
        Ok::<Value, (FfError, Option<PathBuf>)>(v)
    }
    .await;
    ff::unregister(task);
    r.unwrap_or_else(|(e, dir)| {
        if e.is_cancelled() {
            if let Some(d) = dir {
                remove_files(&[d.join(format!("sprite.{format}")), d.join("sprite.vtt")]);
            }
        } else {
            emit(&app, task, -1.0, format!("雪碧图生成失败: {}", e.message()));
        }
        fail_json(&e)
    })
}
