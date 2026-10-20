// 模块公开仅供 tests/selftest.rs 端到端自测使用
#[doc(hidden)]
pub mod audio;
#[doc(hidden)]
pub mod compat;
#[doc(hidden)]
pub mod ff;
#[doc(hidden)]
pub mod frames;
mod mediaserver;
#[doc(hidden)]
pub mod mp4box;
#[doc(hidden)]
pub mod preview;
#[doc(hidden)]
pub mod probe;
#[doc(hidden)]
pub mod sprite;
#[doc(hidden)]
pub mod util;

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

// ---------------- probe ----------------

/// 导入视频：基础信息（与旧版字段一致）+ 兼容性分析
#[tauri::command]
async fn probe_video(file_path: String) -> Value {
    let path = PathBuf::from(&file_path);
    match probe::probe(&path).await {
        Ok(info) => {
            let compat = compat::analyze(&path, &info);
            let first_audio = info.audio_tracks.iter().find(|t| t.is_default).or(info.audio_tracks.first());
            json!({
                "success": true,
                "data": {
                    "duration": info.duration,
                    "size": info.size,
                    "bitrate": info.bitrate,
                    "format": info.format,
                    "video": info.video.as_ref().map(|v| {
                        let (dw, dh) = util::display_size(v);
                        json!({
                            "codec": v.codec, "width": v.width, "height": v.height, "fps": v.fps,
                            "profile": v.profile, "pixFmt": v.pix_fmt, "displayWidth": dw, "displayHeight": dh,
                            "hdr": util::is_hdr(v),
                        })
                    }),
                    // audio 保留为「第一条音轨」，供只关心有无音频的旧逻辑使用
                    "audio": first_audio.map(|a| json!({ "codec": a.codec, "sampleRate": a.sample_rate, "channels": a.channels })),
                    "audioTracks": info.audio_tracks,
                    "compat": compat,
                }
            })
        }
        Err(e) => util::fail_json(&e),
    }
}

#[tauri::command]
fn cancel_task(task_id: String) {
    ff::cancel(&task_id);
}

/// 自带 ffmpeg 的位置与版本（关于页 / 排错用）
#[tauri::command]
async fn ffmpeg_info() -> Value {
    let path = ff::tool_path("ffmpeg");
    let version = tokio::process::Command::new(&path)
        .arg("-version")
        .output()
        .await
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).lines().next().map(str::to_string))
        .unwrap_or_default();
    json!({ "path": util::path_str(&path), "version": version, "bundled": path.is_absolute() })
}

// ---------------- settings ----------------

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("settings.json"))
}

fn read_settings(app: &AppHandle) -> Value {
    settings_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({ "outputDir": "" }))
}

#[tauri::command]
fn load_settings(app: AppHandle) -> Value {
    read_settings(&app)
}

/// 合并写入：前端只更新它关心的字段
#[tauri::command]
fn save_settings(app: AppHandle, settings: Value) -> bool {
    let mut cur = read_settings(&app);
    if let (Some(c), Some(n)) = (cur.as_object_mut(), settings.as_object()) {
        for (k, v) in n {
            c.insert(k.clone(), v.clone());
        }
    }
    let Some(p) = settings_path(&app) else { return false };
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    serde_json::to_string_pretty(&cur).ok().is_some_and(|s| std::fs::write(Path::new(&p), s).is_ok())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 开发版开放 WebView2 远程调试（CDP 9333），供自动化 UI 测试连接；发布版不开
    if cfg!(debug_assertions) && std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").is_none() {
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--remote-debugging-port=9333");
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            ff::init(app.handle());
            if let Err(e) = mediaserver::start() {
                eprintln!("media server failed: {e}");
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            probe_video,
            cancel_task,
            // 本地媒体服务器地址：前端用 base + encodeURIComponent(path) 播放视频
            mediaserver::media_base,
            ffmpeg_info,
            load_settings,
            save_settings,
            frames::extract_frames,
            frames::export_frames,
            frames::grab_frame,
            audio::extract_audio,
            sprite::generate_sprite,
            preview::generate_preview,
            preview::get_hw_encoders,
        ])
        .run(tauri::generate_context!())
        .expect("error while running CM FrameKit");
}
