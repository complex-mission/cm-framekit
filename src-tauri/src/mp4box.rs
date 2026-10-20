//! Minimal ISO-BMFF (MP4/MOV) scanner: where the moov sits, and each track's sample-entry fourcc.
//!
//! Why: ffprobe reports neither. A moov after the mdat ("not faststart") makes Safari/iOS fetch
//! the file tail before playing and is the classic cause of "can't seek until fully loaded" on
//! servers with weak range support; `hev1` vs `hvc1` decides whether Apple players accept HEVC.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde::Serialize;

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mp4Info {
    /// true = moov 在 mdat 之前（faststart）；None = 没找到 moov 或 mdat
    pub faststart: Option<bool>,
    /// 含 moof（fragmented MP4）
    pub fragmented: bool,
    /// 视频轨 sample entry，如 "avc1" "hvc1" "hev1" "av01" "vp09"
    pub video: Vec<String>,
    /// 音频轨 sample entry，如 "mp4a" "Opus" ".mp3" "ac-3" "fLaC"
    pub audio: Vec<String>,
}

const MAX_MOOV: u64 = 64 << 20;

fn be32(b: &[u8]) -> u32 {
    u32::from_be_bytes([b[0], b[1], b[2], b[3]])
}

fn be64(b: &[u8]) -> u64 {
    u64::from_be_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]])
}

/// 遍历一段内存里的同级 box：回调 (type, payload)
fn each_box<'a>(mut data: &'a [u8], mut f: impl FnMut(&[u8; 4], &'a [u8])) {
    while data.len() >= 8 {
        let mut size = be32(data) as usize;
        let typ: [u8; 4] = data[4..8].try_into().unwrap();
        let mut hdr = 8;
        if size == 1 {
            if data.len() < 16 {
                return;
            }
            size = be64(&data[8..]) as usize;
            hdr = 16;
        } else if size == 0 {
            size = data.len();
        }
        if size < hdr || size > data.len() {
            return;
        }
        f(&typ, &data[hdr..size]);
        data = &data[size..];
    }
}

fn find<'a>(data: &'a [u8], want: &[u8; 4]) -> Option<&'a [u8]> {
    let mut out = None;
    each_box(data, |t, p| {
        if out.is_none() && t == want {
            out = Some(p);
        }
    });
    out
}

fn parse_moov(moov: &[u8], info: &mut Mp4Info) {
    each_box(moov, |t, trak| {
        if t != b"trak" {
            return;
        }
        let Some(mdia) = find(trak, b"mdia") else { return };
        // hdlr: version/flags(4) + pre_defined(4) + handler_type(4)
        let handler = find(mdia, b"hdlr").filter(|h| h.len() >= 12).map(|h| [h[8], h[9], h[10], h[11]]);
        let stsd = find(mdia, b"minf").and_then(|m| find(m, b"stbl")).and_then(|s| find(s, b"stsd"));
        let Some(stsd) = stsd else { return };
        if stsd.len() < 8 {
            return;
        }
        // stsd: version/flags(4) + entry_count(4)，之后是若干 sample entry box
        let mut tags = Vec::new();
        each_box(&stsd[8..], |e, _| tags.push(String::from_utf8_lossy(e).into_owned()));
        match handler.as_ref() {
            Some(b"vide") => info.video.extend(tags),
            Some(b"soun") => info.audio.extend(tags),
            _ => {}
        }
    });
}

pub fn scan(path: &Path) -> std::io::Result<Mp4Info> {
    let mut f = File::open(path)?;
    let len = f.metadata()?.len();
    let mut info = Mp4Info::default();
    let (mut moov_at, mut mdat_at) = (None, None);
    let mut pos = 0u64;
    let mut hdr = [0u8; 16];

    while pos + 8 <= len {
        f.seek(SeekFrom::Start(pos))?;
        f.read_exact(&mut hdr[..8])?;
        let typ: [u8; 4] = hdr[4..8].try_into().unwrap();
        let (size, hlen) = match be32(&hdr) as u64 {
            1 => {
                f.read_exact(&mut hdr[8..16])?;
                (be64(&hdr[8..]), 16)
            }
            0 => (len - pos, 8),
            s => (s, 8),
        };
        if size < hlen {
            break;
        }
        // 第一个 box 必须像个 MP4，否则别瞎解析
        if pos == 0 && !matches!(&typ, b"ftyp" | b"moov" | b"mdat" | b"free" | b"wide" | b"skip" | b"pnot") {
            return Ok(info);
        }
        match &typ {
            b"moov" if moov_at.is_none() => {
                moov_at = Some(pos);
                let body = size - hlen;
                if body <= MAX_MOOV {
                    let mut buf = vec![0u8; body as usize];
                    f.read_exact(&mut buf)?;
                    parse_moov(&buf, &mut info);
                }
            }
            b"mdat" if mdat_at.is_none() => mdat_at = Some(pos),
            b"moof" => info.fragmented = true,
            _ => {}
        }
        pos = pos.saturating_add(size);
    }

    info.faststart = match (moov_at, mdat_at) {
        (Some(m), Some(d)) => Some(m < d),
        (Some(_), None) => Some(true),
        _ => None,
    };
    Ok(info)
}

pub fn is_mp4_like(path: &Path) -> bool {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    matches!(ext.as_str(), "mp4" | "m4v" | "mov" | "m4a" | "3gp" | "3g2")
}
