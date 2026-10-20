//! ffprobe → the media facts the UI and the compatibility check need.

use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use crate::ff::{self, FfError};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoStream {
    pub codec: String,
    pub profile: String,
    pub pix_fmt: String,
    pub level: i64,
    pub codec_tag: String,
    pub width: i64,
    pub height: i64,
    pub fps: f64,
    pub avg_fps: f64,
    pub field_order: String,
    pub color_transfer: String,
    pub color_primaries: String,
    /// 采样宽高比 SAR，如 (4,3)；方形像素为 (1,1)
    pub sar: (i64, i64),
    /// 旋转角度（手机竖拍常见 90/-90）
    pub rotation: i64,
    /// Dolby Vision 配置记录（iPhone HDR 视频常见）
    pub dolby_vision: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioTrack {
    /// 第几条音轨(0 基)，对应 -map 0:a:<index>
    pub index: usize,
    /// 容器内绝对流号，仅展示用
    pub stream_index: i64,
    pub codec: String,
    pub profile: String,
    pub channels: i64,
    pub channel_layout: String,
    pub sample_rate: i64,
    pub bitrate: i64,
    pub language: String,
    pub title: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub duration: f64,
    pub size: i64,
    pub bitrate: i64,
    pub format: String,
    pub video: Option<VideoStream>,
    pub audio_tracks: Vec<AudioTrack>,
}

fn s(v: &Value, k: &str) -> String {
    match &v[k] {
        Value::String(x) => x.trim().to_string(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

fn num(v: &Value, k: &str) -> f64 {
    match &v[k] {
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::String(x) => x.trim().parse().unwrap_or(0.0),
        _ => 0.0,
    }
}

/// "30000/1001" → 29.97（不用 eval）
fn rate(r: &str) -> f64 {
    match r.split_once('/') {
        Some((a, b)) => {
            let (a, b) = (a.trim().parse::<f64>().unwrap_or(0.0), b.trim().parse::<f64>().unwrap_or(0.0));
            if b > 0.0 { a / b } else { 0.0 }
        }
        None => r.trim().parse().unwrap_or(0.0),
    }
}

/// 不同容器的 tag 大小写不统一（MKV 常见全大写）
fn tag(stream: &Value, name: &str) -> String {
    stream["tags"]
        .as_object()
        .and_then(|m| m.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)))
        .and_then(|(_, v)| v.as_str())
        .map(|x| x.trim().to_string())
        .unwrap_or_default()
}

fn parse_video(st: &Value) -> VideoStream {
    let sar = s(st, "sample_aspect_ratio");
    let sar = sar
        .split_once(':')
        .and_then(|(a, b)| Some((a.parse().ok()?, b.parse().ok()?)))
        .filter(|&(a, b): &(i64, i64)| a > 0 && b > 0)
        .unwrap_or((1, 1));
    let mut rotation = 0;
    let mut dolby_vision = false;
    if let Some(list) = st["side_data_list"].as_array() {
        for sd in list {
            if let Some(r) = sd["rotation"].as_f64() {
                rotation = r as i64;
            }
            if s(sd, "side_data_type").to_ascii_lowercase().contains("dovi") {
                dolby_vision = true;
            }
        }
    }
    if rotation == 0 {
        rotation = tag(st, "rotate").parse().unwrap_or(0);
    }
    VideoStream {
        codec: s(st, "codec_name"),
        profile: s(st, "profile"),
        pix_fmt: s(st, "pix_fmt"),
        level: num(st, "level") as i64,
        codec_tag: s(st, "codec_tag_string"),
        width: num(st, "width") as i64,
        height: num(st, "height") as i64,
        fps: rate(&s(st, "r_frame_rate")),
        avg_fps: rate(&s(st, "avg_frame_rate")),
        field_order: s(st, "field_order"),
        color_transfer: s(st, "color_transfer"),
        color_primaries: s(st, "color_primaries"),
        sar,
        rotation,
        dolby_vision,
    }
}

pub async fn probe(path: &Path) -> Result<MediaInfo, FfError> {
    let args = vec![
        "-v".into(),
        "error".into(),
        "-print_format".into(),
        "json".into(),
        "-show_format".into(),
        "-show_streams".into(),
        path.to_string_lossy().into_owned(),
    ];
    let out = ff::ffprobe(&args).await?;
    let j: Value = serde_json::from_str(&out).map_err(|e| FfError::msg(format!("ffprobe 输出无法解析：{e}")))?;
    let fmt = &j["format"];
    let streams = j["streams"].as_array().cloned().unwrap_or_default();

    // 封面图（MP3/MP4 内嵌的 attached_pic）不算视频轨
    let video = streams
        .iter()
        .find(|st| s(st, "codec_type") == "video" && st["disposition"]["attached_pic"].as_i64() != Some(1))
        .map(parse_video);

    let audio_tracks = streams
        .iter()
        .filter(|st| s(st, "codec_type") == "audio")
        .enumerate()
        .map(|(i, st)| AudioTrack {
            index: i,
            stream_index: num(st, "index") as i64,
            codec: s(st, "codec_name"),
            profile: s(st, "profile"),
            channels: num(st, "channels") as i64,
            channel_layout: s(st, "channel_layout"),
            sample_rate: num(st, "sample_rate") as i64,
            bitrate: num(st, "bit_rate") as i64,
            language: tag(st, "language"),
            title: tag(st, "title"),
            is_default: st["disposition"]["default"].as_i64() == Some(1),
        })
        .collect();

    let mut duration = num(fmt, "duration");
    if duration <= 0.0 {
        // 部分 TS/MKV 只有流级时长
        duration = streams.iter().map(|st| num(st, "duration")).fold(0.0, f64::max);
    }
    Ok(MediaInfo {
        duration,
        size: num(fmt, "size") as i64,
        bitrate: num(fmt, "bit_rate") as i64,
        format: s(fmt, "format_name"),
        video,
        audio_tracks,
    })
}
