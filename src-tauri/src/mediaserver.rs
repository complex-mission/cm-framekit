//! Local file server for the preview (video, proxies, sprite sheets, posters).
//!
//! Tauri's asset protocol answers each range request with at most 1 MB, reopening the file
//! every time, and hands the bytes to WebView2 through its custom-scheme callback. Measured in
//! the app's own WebView on a 6K HEVC original (204 Mbit/s): asset protocol 7.26 s of video per
//! 8 s of wall time with 2 stalls (a cold file: 3 s per 6 s), the same file over plain HTTP
//! from 127.0.0.1 7.97 s with none. So media goes over HTTP from this server.
//!
//! Bound to 127.0.0.1 on a random port; every URL carries a random per-session token, so other
//! local programs and web pages cannot read files through it. GET / HEAD with single ranges,
//! streamed (no per-request cap), keep-alive, CORS open (the token is the access control; the
//! preview reads frames into WebGL, which needs CORS).

use std::collections::hash_map::RandomState;
use std::fs::File;
use std::hash::{BuildHasher, Hasher};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::OnceLock;
use std::time::Duration;

static BASE: OnceLock<String> = OnceLock::new();

/// `http://127.0.0.1:<port>/<token>/` once started, for `media_base`.
pub fn base() -> Option<String> {
    BASE.get().cloned()
}

fn random_token() -> String {
    // RandomState is seeded from the OS RNG once per process; two independent 64-bit draws
    let mut out = String::new();
    for i in 0..2u64 {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(i ^ std::process::id() as u64);
        h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

pub fn start() -> std::io::Result<String> {
    if let Some(b) = BASE.get() {
        return Ok(b.clone());
    }
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    let token = random_token();
    let base = format!("http://127.0.0.1:{port}/{token}/");
    let _ = BASE.set(base.clone());
    std::thread::Builder::new().name("media-server".into()).spawn(move || {
        for conn in listener.incoming().flatten() {
            let token = token.clone();
            let _ = std::thread::Builder::new().name("media-conn".into()).spawn(move || serve(conn, &token, port));
        }
    })?;
    Ok(base)
}

fn mime(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "webm" | "weba" => "video/webm",
        "mp3" => "audio/mpeg",
        "m4a" | "aac" => "audio/mp4",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        _ => "application/octet-stream",
    }
}

/// %XX decoding of the path part (UTF-8); `None` on malformed input.
fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let h = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(h, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `bytes=a-b` / `bytes=a-` / `bytes=-n` → (start, end inclusive); `None` = not satisfiable.
fn parse_range(v: &str, len: u64) -> Option<(u64, u64)> {
    let r = v.trim().strip_prefix("bytes=")?;
    if r.contains(',') || len == 0 {
        return None; // multi-range: the media stack never asks for it
    }
    let (a, b) = r.split_once('-')?;
    let (start, end) = if a.is_empty() {
        let n: u64 = b.trim().parse().ok()?;
        (len.saturating_sub(n), len - 1)
    } else {
        let s: u64 = a.trim().parse().ok()?;
        let e: u64 = if b.trim().is_empty() { len - 1 } else { b.trim().parse::<u64>().ok()?.min(len - 1) };
        (s, e)
    };
    (start <= end && start < len).then_some((start, end))
}

fn serve(conn: TcpStream, token: &str, port: u16) {
    let _ = conn.set_nodelay(true);
    let _ = conn.set_read_timeout(Some(Duration::from_secs(120)));
    let Ok(mut out) = conn.try_clone() else { return };
    let mut reader = BufReader::new(conn);
    loop {
        // request line + headers
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        let mut parts = line.split_whitespace();
        let method = parts.next().unwrap_or("").to_string();
        let target = parts.next().unwrap_or("").to_string();
        let mut range: Option<String> = None;
        let mut host_ok = false;
        loop {
            let mut h = String::new();
            if reader.read_line(&mut h).unwrap_or(0) == 0 {
                return;
            }
            let h = h.trim_end();
            if h.is_empty() {
                break;
            }
            if let Some((k, v)) = h.split_once(':') {
                let k = k.trim().to_ascii_lowercase();
                let v = v.trim();
                if k == "range" {
                    range = Some(v.to_string());
                } else if k == "host" {
                    // DNS rebinding: only our own address
                    host_ok = v == format!("127.0.0.1:{port}") || v == format!("localhost:{port}");
                }
            }
        }
        let cors = "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Range\r\nAccess-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges\r\n";
        let reply = |out: &mut TcpStream, status: &str| out.write_all(format!("HTTP/1.1 {status}\r\n{cors}Content-Length: 0\r\nConnection: keep-alive\r\n\r\n").as_bytes());
        if method == "OPTIONS" {
            if reply(&mut out, "204 No Content").is_err() {
                return;
            }
            continue;
        }
        let path = target.split('?').next().unwrap_or("");
        let prefix = format!("/{token}/");
        let file_path = if host_ok && (method == "GET" || method == "HEAD") { path.strip_prefix(&prefix).and_then(percent_decode) } else { None };
        let Some(file_path) = file_path else {
            let _ = reply(&mut out, "404 Not Found");
            return;
        };
        let Ok(mut file) = File::open(&file_path) else {
            if reply(&mut out, "404 Not Found").is_err() {
                return;
            }
            continue;
        };
        let len = file.metadata().map(|m| m.len()).unwrap_or(0);
        let (status, start, end) = match range.as_deref() {
            Some(r) => match parse_range(r, len) {
                Some((s, e)) => ("206 Partial Content", s, e),
                None => {
                    let _ = out.write_all(format!("HTTP/1.1 416 Range Not Satisfiable\r\n{cors}Content-Range: bytes */{len}\r\nContent-Length: 0\r\n\r\n").as_bytes());
                    continue;
                }
            },
            None => ("200 OK", 0, len.saturating_sub(1)),
        };
        let n = if len == 0 { 0 } else { end + 1 - start };
        let mut head = format!("HTTP/1.1 {status}\r\n{cors}Content-Type: {}\r\nAccept-Ranges: bytes\r\nContent-Length: {n}\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n", mime(&file_path));
        if status.starts_with("206") {
            head.push_str(&format!("Content-Range: bytes {start}-{end}/{len}\r\n"));
        }
        head.push_str("\r\n");
        if out.write_all(head.as_bytes()).is_err() {
            return;
        }
        if method == "HEAD" || n == 0 {
            continue;
        }
        if file.seek(SeekFrom::Start(start)).is_err() {
            return;
        }
        // streamed: the media stack reads what it needs and drops the connection when seeking
        let mut body = file.take(n);
        let mut buf = vec![0u8; 512 * 1024];
        loop {
            match body.read(&mut buf) {
                Ok(0) => break,
                Ok(k) => {
                    if out.write_all(&buf[..k]).is_err() {
                        return;
                    }
                }
                Err(_) => return,
            }
        }
    }
}

/// Tauri command: the base URL (`…/<token>/`), or null when the server could not start (the UI
/// then falls back to the asset protocol).
#[tauri::command]
pub fn media_base() -> Option<String> {
    base()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(parse_range("bytes=0-", 100), Some((0, 99)));
        assert_eq!(parse_range("bytes=10-19", 100), Some((10, 19)));
        assert_eq!(parse_range("bytes=90-200", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=100-", 100), None);
        assert_eq!(parse_range("bytes=0-1,5-6", 100), None);
        assert_eq!(percent_decode("C%3A%5CUsers%5C%E4%B8%AD.mp4").as_deref(), Some("C:\\Users\\中.mp4"));
    }

    /// End to end: token required, Host checked, ranges served byte-exact over keep-alive.
    #[test]
    fn serves_ranges_with_token() {
        let dir = std::env::temp_dir().join(format!("cmcut_ms_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("a b.bin");
        let data: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&f, &data).unwrap();
        let base = start().unwrap();
        let rest = base.strip_prefix("http://").unwrap();
        let (hostport, token) = rest.split_once('/').unwrap();
        let token = token.trim_end_matches('/');
        let enc: String = f.to_string_lossy().bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
        let get = |path: &str, range: &str, host: &str| -> (String, Vec<u8>) {
            let mut s = TcpStream::connect(hostport).unwrap();
            s.write_all(format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nRange: {range}\r\nConnection: close\r\n\r\n").as_bytes()).unwrap();
            let mut all = Vec::new();
            s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut buf = [0u8; 65536];
            loop {
                match s.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(k) => all.extend_from_slice(&buf[..k]),
                }
                // the server keeps the connection open: stop once headers + body arrived
                if let Some(p) = all.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&all[..p]).to_string();
                    let clen: usize = head.lines().find_map(|l| l.strip_prefix("Content-Length: ")).and_then(|v| v.trim().parse().ok()).unwrap_or(0);
                    if all.len() >= p + 4 + clen {
                        return (head, all[p + 4..p + 4 + clen].to_vec());
                    }
                }
            }
            (String::from_utf8_lossy(&all).to_string(), Vec::new())
        };
        let (h, b) = get(&format!("/{token}/{enc}"), "bytes=1000-200999", hostport);
        assert!(h.starts_with("HTTP/1.1 206") && h.contains("Content-Range: bytes 1000-200999/300000"), "{h}");
        assert_eq!(b, data[1000..201000]);
        // wrong token, wrong host
        assert!(get(&format!("/{}/{enc}", "0".repeat(32)), "bytes=0-9", hostport).0.starts_with("HTTP/1.1 404"));
        assert!(get(&format!("/{token}/{enc}"), "bytes=0-9", "evil.example:80").0.starts_with("HTTP/1.1 404"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
