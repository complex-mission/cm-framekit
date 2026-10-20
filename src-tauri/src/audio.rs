//! Audio extraction: one file per selected track.
//! mp3 (.mp3) · aac (.m4a, faststart — plays everywhere incl. old Safari/iOS) · opus (.ogg, Safari 18.4+).

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::{AppHandle, Runtime};

use crate::compat;
use crate::ff::{self, Cancel, FfError};
use crate::probe::{self, AudioTrack};
use crate::util::*;

fn ext_for(codec: &str) -> &'static str {
    match codec {
        "opus" => "ogg",
        "aac" => "m4a",
        _ => "mp3",
    }
}

/// 单音轨仍叫 audio.xxx；多音轨加序号和语言标记
fn file_name(t: &AudioTrack, total: usize, ext: &str) -> String {
    if total <= 1 {
        return format!("audio.{ext}");
    }
    let mut name = format!("audio_t{}", t.index + 1);
    let lang: String = t.language.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(8).collect::<String>().to_ascii_lowercase();
    if !lang.is_empty() && lang != "und" {
        name.push('_');
        name.push_str(&lang);
    }
    format!("{name}.{ext}")
}

fn codec_args(codec: &str, bitrate: &str, t: &AudioTrack) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();
    match codec {
        "opus" => a.extend(["-c:a".into(), "libopus".into()]),
        "aac" => {
            // AAC-LC：所有浏览器/设备都能解；faststart 让 Safari 立即可播可拖
            a.extend(["-c:a".into(), "aac".into(), "-movflags".into(), "+faststart".into()]);
        }
        _ => {
            a.extend(["-c:a".into(), "libmp3lame".into()]);
            // LAME 只支持单/双声道，5.1/7.1 源必须下混，否则直接报错
            if t.channels > 2 {
                a.extend(["-ac".into(), "2".into()]);
            }
        }
    }
    a.extend(["-b:a".into(), bitrate.to_string()]);
    a
}

/// 导出音轨。选轨：options.tracks 数组 = 显式选择；trackMode=="default" = 只导默认轨；否则全部。
/// 出错/取消时只清理当前这条的半成品，已完成的保留。
pub async fn extract_tracks<R: Runtime>(app: &AppHandle<R>, task: &str, input: &Path, output_dir: &str, options: &Value, cancel: Option<&Cancel>) -> Result<Value, FfError> {
    let info = match probe::probe(input).await {
        Ok(i) => i,
        Err(_) => return Ok(json!({ "success": false, "skipped": true })),
    };
    let tracks = &info.audio_tracks;
    if tracks.is_empty() {
        return Ok(json!({ "success": false, "skipped": true }));
    }
    let codec = opt_str(options, "codec").unwrap_or_else(|| "mp3".into());
    let bitrate = opt_str(options, "bitrate").unwrap_or_else(|| "192k".into());
    let ext = ext_for(&codec);

    let mut wanted: Vec<usize> = if let Some(arr) = options["tracks"].as_array() {
        arr.iter().filter_map(|v| v.as_u64()).map(|v| v as usize).filter(|&i| i < tracks.len()).collect()
    } else if opt_str(options, "trackMode").as_deref() == Some("default") {
        vec![tracks.iter().find(|t| t.is_default).unwrap_or(&tracks[0]).index]
    } else {
        tracks.iter().map(|t| t.index).collect()
    };
    wanted.sort_unstable();
    wanted.dedup();
    if wanted.is_empty() {
        return Ok(json!({ "success": false, "skipped": true }));
    }

    emit(app, task, 0.0, format!("开始提取音频 ({codec})..."));
    let dir = job_dir(output_dir, input)?;
    let mut outputs: Vec<(PathBuf, &AudioTrack)> = Vec::new();
    let n_total = wanted.len();
    for (n, &ti) in wanted.iter().enumerate() {
        let t = &tracks[ti];
        let out = dir.join(file_name(t, tracks.len(), ext));
        let prefix = if n_total > 1 { format!("音轨 {}/{}：", n + 1, n_total) } else { String::new() };
        let mut args: Vec<String> = vec!["-i".into(), path_str(input), "-vn".into(), "-sn".into(), "-dn".into()];
        // 必须显式 -map：否则 ffmpeg 只挑一条「最佳」音轨，其余被静默丢弃
        args.extend(["-map".into(), format!("0:a:{}", t.index)]);
        args.extend(codec_args(&codec, &bitrate, t));
        args.push(path_str(&out));
        let res = ff::ffmpeg(&args, cancel, info.duration, |p| {
            emit(app, task, (n as f64 * 100.0 + p) / n_total as f64, format!("{prefix}提取音频中"));
        })
        .await;
        if let Err(e) = res {
            remove_files(&[out]);
            return Err(e);
        }
        outputs.push((out, t));
    }

    let mut warnings: Vec<String> = Vec::new();
    if codec == "aac" {
        for (p, _) in &outputs {
            warnings.extend(compat::verify_output(p));
        }
    }
    let paths: Vec<String> = outputs.iter().map(|(p, _)| path_str(p)).collect();
    let track_info: Vec<Value> = outputs
        .iter()
        .map(|(p, t)| {
            let mut v = serde_json::to_value(t).unwrap_or(Value::Null);
            v["outputPath"] = json!(path_str(p));
            v
        })
        .collect();
    let count = outputs.len();
    emit(app, task, 100.0, if count > 1 { format!("音频提取完成，共 {count} 条音轨") } else { "音频提取完成".into() });
    Ok(json!({
        "success": true,
        "outputPath": paths[0],
        "outputPaths": paths,
        "tracks": track_info,
        "count": count,
        "totalTracks": tracks.len(),
        "warnings": warnings,
    }))
}

#[tauri::command]
pub async fn extract_audio(app: AppHandle, input_path: String, output_dir: String, options: Value) -> Value {
    let task = "audio";
    let cancel = ff::register(task);
    let r = extract_tracks(&app, task, Path::new(&input_path), &output_dir, &options, Some(&cancel)).await;
    ff::unregister(task);
    r.unwrap_or_else(|e| {
        if !e.is_cancelled() {
            emit(&app, task, -1.0, format!("音频提取失败: {}", e.message()));
        }
        fail_json(&e)
    })
}
