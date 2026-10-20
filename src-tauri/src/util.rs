//! Shared helpers for the task modules: progress events, output folders, option parsing,
//! and the compatibility-oriented video filter chain.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Runtime};

use crate::ff::FfError;
use crate::probe::VideoStream;

pub fn emit<R: Runtime>(app: &AppHandle<R>, task: &str, progress: f64, message: impl Into<String>) {
    let _ = app.emit("task-progress", json!({ "taskId": task, "progress": progress.round(), "message": message.into() }));
}

/// 所有产物放进「以视频文件名命名的文件夹」，避免批量处理时混在一起
pub fn job_dir(output_dir: &str, input: &Path) -> Result<PathBuf, FfError> {
    let stem = input.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "output".into());
    let dir = Path::new(output_dir).join(stem);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

pub fn remove_files(paths: &[PathBuf]) {
    for p in paths {
        let _ = std::fs::remove_file(p);
    }
}

// ---- 前端传来的 options 类型不严格（数字可能是字符串），统一宽松读取 ----

pub fn opt_f64(o: &Value, k: &str) -> Option<f64> {
    match &o[k] {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

pub fn opt_i64(o: &Value, k: &str) -> Option<i64> {
    opt_f64(o, k).map(|v| v.round() as i64)
}

pub fn opt_str(o: &Value, k: &str) -> Option<String> {
    o[k].as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

pub fn opt_bool(o: &Value, k: &str) -> Option<bool> {
    o[k].as_bool()
}

/// 统一的失败返回（形状与旧 Electron 版一致：success/error/details/cancelled）
pub fn fail_json(e: &FfError) -> Value {
    if e.is_cancelled() {
        json!({ "success": false, "cancelled": true })
    } else {
        json!({ "success": false, "error": e.message(), "details": e.stderr() })
    }
}

// ---------------- filter chain ----------------

pub fn is_hdr(v: &VideoStream) -> bool {
    matches!(v.color_transfer.as_str(), "smpte2084" | "arib-std-b67")
}

/// HDR(PQ/HLG) → SDR BT.709：先转线性光，hable 曲线压缩高光，再转回 BT.709。
/// 不做这步 iPhone HDR 视频的预览/截帧会明显发灰。
pub fn tonemap_chain() -> Vec<String> {
    [
        "zscale=t=linear:npl=100",
        "format=gbrpf32le",
        "zscale=p=bt709",
        "tonemap=tonemap=hable:desat=0",
        "zscale=t=bt709:m=bt709:r=tv",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

pub struct ChainOpts {
    /// 目标宽度（0 = 不缩放）；只缩小不放大
    pub width: i64,
    /// 目标高度（0 = 不缩放），与 width 二选一
    pub height: i64,
    pub fps: f64,
    pub deinterlace: bool,
    /// 最终像素格式，None = 不强制
    pub pix_fmt: Option<&'static str>,
}

/// 兼容性优先的滤镜链：反交错 → 方形像素 → 缩放 → HDR 色调映射 → 帧率 → 像素格式
pub fn video_chain(v: Option<&VideoStream>, o: &ChainOpts) -> String {
    let mut f: Vec<String> = Vec::new();
    if o.deinterlace {
        // 只处理被标记为交错的帧，逐行源不受影响
        f.push("yadif=deint=interlaced".into());
    }
    if let Some(v) = v {
        if v.sar.0 != v.sar.1 {
            // 变形宽银幕：GIF/WebP/部分播放器忽略 SAR，先展开成方形像素
            f.push("scale=trunc(iw*sar/2)*2:ih".into());
            f.push("setsar=1".into());
        }
    }
    let (src_w, src_h) = v.map(|v| display_size(v)).unwrap_or((0, 0));
    if o.width > 0 && (src_w == 0 || o.width < src_w) {
        f.push(format!("scale={}:-2", o.width));
    } else if o.height > 0 && (src_h == 0 || o.height < src_h) {
        f.push(format!("scale=-2:{}", o.height));
    }
    if v.is_some_and(is_hdr) {
        f.extend(tonemap_chain());
    }
    if o.fps > 0.0 {
        f.push(format!("fps={}", o.fps));
    }
    if let Some(p) = o.pix_fmt {
        f.push(format!("format={p}"));
    }
    if f.is_empty() {
        "null".into()
    } else {
        f.join(",")
    }
}

/// 考虑旋转与 SAR 后的显示尺寸
pub fn display_size(v: &VideoStream) -> (i64, i64) {
    let mut w = v.width;
    let h = v.height;
    if v.sar.0 != v.sar.1 && v.sar.1 > 0 {
        w = w * v.sar.0 / v.sar.1;
    }
    if v.rotation.abs() % 180 == 90 {
        (h, w)
    } else {
        (w, h)
    }
}
