//! Locating the bundled FFmpeg / FFprobe and running them (progress, cancel, stderr tail).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use tauri::{AppHandle, Manager, Runtime};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::Notify;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

static TOOL_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();

fn exe(name: &str) -> String {
    if cfg!(windows) { format!("{name}.exe") } else { name.to_string() }
}

/// 查找顺序：FRAMEKIT_FFMPEG_DIR → 安装包 resources/ffmpeg → 开发时 src-tauri/ffmpeg → PATH
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(d) = std::env::var("FRAMEKIT_FFMPEG_DIR") {
        dirs.push(PathBuf::from(d));
    }
    if let Ok(r) = app.path().resource_dir() {
        dirs.push(r.join("ffmpeg"));
    }
    dirs.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("ffmpeg"));
    let found = dirs.into_iter().find(|d| d.join(exe("ffmpeg")).exists() && d.join(exe("ffprobe")).exists());
    let _ = TOOL_DIR.set(found);
}

pub fn tool_path(name: &str) -> PathBuf {
    match TOOL_DIR.get().and_then(|d| d.as_ref()) {
        Some(d) => d.join(exe(name)),
        None => PathBuf::from(exe(name)),
    }
}

fn command(name: &str) -> Command {
    let mut c = Command::new(tool_path(name));
    c.stdin(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

// ---------------- cancellation ----------------

#[derive(Default)]
pub struct Cancel {
    flag: AtomicBool,
    notify: Notify,
}

impl Cancel {
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }
    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }
    pub fn check(&self) -> Result<(), FfError> {
        if self.is_cancelled() { Err(FfError::Cancelled) } else { Ok(()) }
    }
}

/// taskId → 当前运行中任务的取消令牌（同一 taskId 同时只跑一个）
fn registry() -> &'static Mutex<HashMap<String, Arc<Cancel>>> {
    static R: OnceLock<Mutex<HashMap<String, Arc<Cancel>>>> = OnceLock::new();
    R.get_or_init(Default::default)
}

pub fn register(task: &str) -> Arc<Cancel> {
    let c = Arc::new(Cancel::default());
    registry().lock().unwrap().insert(task.to_string(), c.clone());
    c
}

pub fn unregister(task: &str) {
    registry().lock().unwrap().remove(task);
}

pub fn cancel(task: &str) {
    if let Some(c) = registry().lock().unwrap().get(task) {
        c.cancel();
    }
}

// ---------------- running ----------------

#[derive(Debug)]
pub enum FfError {
    Cancelled,
    Failed { message: String, stderr: String },
}

impl FfError {
    pub fn msg(message: impl Into<String>) -> Self {
        FfError::Failed { message: message.into(), stderr: String::new() }
    }
    pub fn is_cancelled(&self) -> bool {
        matches!(self, FfError::Cancelled)
    }
    pub fn message(&self) -> String {
        match self {
            FfError::Cancelled => "CANCELLED".into(),
            FfError::Failed { message, .. } => message.clone(),
        }
    }
    pub fn stderr(&self) -> String {
        match self {
            FfError::Cancelled => String::new(),
            FfError::Failed { stderr, .. } => stderr.clone(),
        }
    }
}

impl From<std::io::Error> for FfError {
    fn from(e: std::io::Error) -> Self {
        FfError::msg(e.to_string())
    }
}

fn tail(s: &str, max_lines: usize) -> String {
    let lines: Vec<&str> = s.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(max_lines)..].join("\n")
}

/// 从 stderr 里挑一行最像错误原因的给用户看
fn summarize(stderr: &str) -> String {
    let last = stderr
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| {
            let lc = l.to_ascii_lowercase();
            lc.contains("error") || lc.contains("invalid") || lc.contains("failed") || lc.contains("not ") || lc.contains("unknown")
        })
        .or_else(|| stderr.lines().rev().map(str::trim).find(|l| !l.is_empty()));
    last.unwrap_or("ffmpeg failed").to_string()
}

/// 跑 ffmpeg 到结束。`duration`>0 时用 -progress 的 out_time 换算百分比回调 on_progress(0..100)。
pub async fn ffmpeg(
    args: &[String],
    cancel: Option<&Cancel>,
    duration: f64,
    mut on_progress: impl FnMut(f64),
) -> Result<(), FfError> {
    if let Some(c) = cancel {
        c.check()?;
    }
    let mut cmd = command("ffmpeg");
    cmd.args(["-hide_banner", "-nostdin", "-nostats", "-y", "-progress", "pipe:1"])
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| FfError::msg(format!("无法启动 ffmpeg：{e}")))?;
    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();

    let err_task = tokio::spawn(async move {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s).await;
        s
    });

    let mut lines = BufReader::new(stdout).lines();
    let work = async {
        while let Ok(Some(line)) = lines.next_line().await {
            // out_time_us 与 out_time_ms 的值都是微秒（历史遗留命名）
            if let Some(v) = line.strip_prefix("out_time_us=").or_else(|| line.strip_prefix("out_time_ms=")) {
                if let Ok(us) = v.trim().parse::<i64>() {
                    if duration > 0.0 && us > 0 {
                        on_progress((us as f64 / 1e6 / duration * 100.0).clamp(0.0, 99.0));
                    }
                }
            }
        }
        child.wait().await
    };

    let status = match cancel {
        Some(c) => {
            tokio::select! {
                s = work => s?,
                _ = c.notify.notified() => {
                    // 丢弃 child 时 kill_on_drop 会杀掉进程
                    return Err(FfError::Cancelled);
                }
            }
        }
        None => work.await?,
    };
    let err = err_task.await.unwrap_or_default();
    if cancel.is_some_and(|c| c.is_cancelled()) {
        return Err(FfError::Cancelled);
    }
    if status.success() {
        Ok(())
    } else {
        Err(FfError::Failed { message: summarize(&err), stderr: tail(&err, 30) })
    }
}

/// 跑 ffprobe，返回 stdout
pub async fn ffprobe(args: &[String]) -> Result<String, FfError> {
    let out = command("ffprobe")
        .arg("-hide_banner")
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| FfError::msg(format!("无法启动 ffprobe：{e}")))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).into_owned();
        Err(FfError::Failed { message: summarize(&err), stderr: tail(&err, 30) })
    }
}

/// 把 stdin 数据喂给 ffmpeg 并等待退出（用于硬件编码器实测），超时视为失败
pub async fn ffmpeg_stdin_ok(args: &[String], input: Vec<u8>, timeout_secs: u64) -> bool {
    let mut cmd = command("ffmpeg");
    cmd.args(["-hide_banner", "-nostats", "-loglevel", "error"])
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let Ok(mut child) = cmd.spawn() else { return false };
    let mut stdin = child.stdin.take().unwrap();
    let run = async {
        let _ = stdin.write_all(&input).await;
        drop(stdin);
        child.wait().await.map(|s| s.success()).unwrap_or(false)
    };
    tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), run).await.unwrap_or(false)
}
