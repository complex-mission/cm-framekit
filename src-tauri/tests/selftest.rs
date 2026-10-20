//! End-to-end check of every task against a folder of real/problem media, using the bundled
//! FFmpeg. Not part of the normal test run:
//!   FRAMEKIT_TEST_MEDIA=<dir> cargo test --test selftest -- --ignored --nocapture

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use framekit_lib::{audio, compat, ff, frames, mp4box, preview, probe, sprite, util};

fn media() -> Vec<PathBuf> {
    let dir = std::env::var("FRAMEKIT_TEST_MEDIA").expect("set FRAMEKIT_TEST_MEDIA");
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir).unwrap().flatten().map(|e| e.path()).filter(|p| p.is_file()).collect();
    v.sort();
    v
}

/// 输出流的关键参数：(vcodec, profile, pix_fmt, tag, acodec)
async fn stream_facts(p: &Path) -> (String, String, String, String, String) {
    let i = probe::probe(p).await.expect("probe output");
    let v = i.video.expect("output has video");
    let a = i.audio_tracks.first().map(|a| a.codec.clone()).unwrap_or_default();
    (v.codec, v.profile, v.pix_fmt, v.codec_tag, a)
}

fn check_mp4(p: &Path, want_video: &str) -> Vec<String> {
    let mut bad = compat::verify_output(p);
    let m = mp4box::scan(p).unwrap();
    if !m.video.iter().any(|t| t == want_video) {
        bad.push(format!("video tag {:?} != {want_video}", m.video));
    }
    bad
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn selftest() {
    let app = tauri::test::mock_app();
    let h = app.handle().clone();
    ff::init(&h);
    let out_root = std::env::temp_dir().join("framekit_selftest");
    let _ = std::fs::remove_dir_all(&out_root);
    let out = util::path_str(&out_root);
    let mut failures: Vec<String> = Vec::new();

    for f in media() {
        let name = f.file_name().unwrap().to_string_lossy().into_owned();
        let info = match probe::probe(&f).await {
            Ok(i) => i,
            Err(e) => {
                failures.push(format!("{name}: probe failed {}", e.message()));
                continue;
            }
        };
        let codes: Vec<&str> = compat::analyze(&f, &info).iter().map(|i| i.code).collect();
        println!("\n=== {name}  [{}]", codes.join(", "));
        let dir = util::job_dir(&out, &f).unwrap();
        let long = name.starts_with("long_");

        // MP4 预览：H.264 + 音频、H.265
        for (codec, tag) in [("h264", "avc1"), ("h265", "hvc1")] {
            if long && codec == "h265" {
                continue;
            }
            let o = dir.join(format!("preview_{codec}.mp4"));
            let opts = json!({ "format": "mp4", "codec": codec, "width": 640, "clips": 4, "clipDuration": 1.5, "includeAudio": true });
            match preview::generate(&h, "preview", &f, &o, &opts, None).await {
                Ok(_) => {
                    let bad = check_mp4(&o, tag);
                    let facts = stream_facts(&o).await;
                    println!("  preview {codec}: {:?} {}", facts, if bad.is_empty() { "OK".into() } else { format!("BAD {bad:?}") });
                    if facts.2 != "yuv420p" {
                        failures.push(format!("{name}: preview {codec} pix_fmt {}", facts.2));
                    }
                    if !info.audio_tracks.is_empty() && facts.4 != "aac" {
                        failures.push(format!("{name}: preview {codec} audio {}", facts.4));
                    }
                    if !bad.is_empty() {
                        failures.push(format!("{name}: preview {codec} {bad:?}"));
                    }
                }
                Err(e) => failures.push(format!("{name}: preview {codec} failed: {} | {}", e.message(), e.stderr())),
            }
        }

        // 动图（只测一个源，节省时间）
        if name.starts_with("hdr_") || name.starts_with("anamorphic") {
            for fmt in ["gif", "webp"] {
                let o = dir.join(format!("preview.{fmt}"));
                let opts = json!({ "format": fmt, "width": 320, "clips": 3, "clipDuration": 1 });
                match preview::generate(&h, "preview", &f, &o, &opts, None).await {
                    Ok(_) => println!("  preview {fmt}: {} bytes", std::fs::metadata(&o).map(|m| m.len()).unwrap_or(0)),
                    Err(e) => failures.push(format!("{name}: preview {fmt} failed: {}", e.message())),
                }
            }
        }

        // 音频
        if !info.audio_tracks.is_empty() {
            for codec in ["aac", "mp3", "opus"] {
                let opts = json!({ "codec": codec, "bitrate": "128k" });
                match audio::extract_tracks(&h, "audio", &f, &out, &opts, None).await {
                    Ok(v) if v["success"] == json!(true) => {
                        let w = v["warnings"].as_array().map(|a| a.len()).unwrap_or(0);
                        println!("  audio {codec}: {} file(s){}", v["count"], if w > 0 { format!(" WARN {}", v["warnings"]) } else { String::new() });
                        if w > 0 {
                            failures.push(format!("{name}: audio {codec} {}", v["warnings"]));
                        }
                    }
                    Ok(v) => failures.push(format!("{name}: audio {codec} {v}")),
                    Err(e) => failures.push(format!("{name}: audio {codec} failed: {} | {}", e.message(), e.stderr())),
                }
            }
        }

        // 雪碧图（长视频：故意超过 WebP 16383px 上限，验证分多张）
        let sopts: Value = if long {
            json!({ "interval": 0.5, "width": 640, "cols": 2, "format": "webp" })
        } else {
            json!({ "interval": 2, "width": 160, "cols": 5, "format": "webp" })
        };
        match sprite::generate(&h, "sprite", &f, &dir, &sopts, None).await {
            Ok(v) => {
                println!("  sprite: {} thumbs, {} sheet(s), {}x{}", v["thumbCount"], v["sheets"], v["width"], v["height"]);
                if long && v["sheets"].as_i64().unwrap_or(0) < 2 {
                    failures.push(format!("{name}: sprite expected multiple sheets"));
                }
            }
            Err(e) => failures.push(format!("{name}: sprite failed: {} | {}", e.message(), e.stderr())),
        }

        // 截帧（ffmpeg 抽帧：WebView 放不了时的预览与截帧路径）
        let r = frames::grab_frame(util::path_str(&f), 3.0, Some(640), Some(false)).await;
        if r["success"] != json!(true) {
            failures.push(format!("{name}: grab_frame {r}"));
        }
    }

    println!("\n================ {} failure(s)", failures.len());
    for f in &failures {
        println!("FAIL {f}");
    }
    assert!(failures.is_empty());
}
