//! Local well-known icon-file detection — no network access.
//!
//! Ordered candidate scan (spec `FAVICON_CANDIDATES`/`ICON_SOURCE_FILES`
//! order): bounded ~64 KB reads, magic-byte MIME sniff (a `favicon.ico` that
//! holds PNG bytes is still accepted), square-only check for raster
//! candidates, and ICO→PNG frame extraction when a PNG frame exists. After
//! the named candidates, `<link rel="icon" href>` declarations in the
//! well-known source files contribute extra candidates — hrefs pointing off
//! the repo (scheme/protocol-relative/`..`) are refused.

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use lazy_static::lazy_static;
use regex::Regex;

use super::{ProjectIcon, ProjectIconSource};

/// Per-candidate read bound (~64 KB per spec); anything larger is skipped so
/// a stray multi-MB asset can't stall the scan.
const MAX_ICON_BYTES: u64 = 64 * 1024;
/// `<link rel="icon">` source-file reads are bounded so a generated bundle
/// can't stall the scan either.
const MAX_SOURCE_BYTES: u64 = 256 * 1024;

/// Ordered well-known candidates — root first, then priority directories.
/// Within each directory: `favicon.{svg,png,ico}`, `icon.{svg,png}`,
/// `logo.{svg,png}` (spec order — scalable formats outrank raster, raster
/// outranks ICO). `src-tauri/icons/icon.*` follows Orca's convention for
/// Tauri projects; `.idea/icon.svg` is the JetBrains project icon.
const FAVICON_CANDIDATES: &[&str] = &[
    "favicon.svg",
    "favicon.png",
    "favicon.ico",
    "icon.svg",
    "icon.png",
    "logo.svg",
    "logo.png",
    "public/favicon.svg",
    "public/favicon.png",
    "public/favicon.ico",
    "public/icon.svg",
    "public/icon.png",
    "public/logo.svg",
    "public/logo.png",
    "app/favicon.svg",
    "app/favicon.png",
    "app/favicon.ico",
    "app/icon.svg",
    "app/icon.png",
    "app/logo.svg",
    "app/logo.png",
    "src/app/favicon.svg",
    "src/app/favicon.png",
    "src/app/favicon.ico",
    "src/app/icon.svg",
    "src/app/icon.png",
    "src/app/logo.svg",
    "src/app/logo.png",
    "assets/favicon.svg",
    "assets/favicon.png",
    "assets/favicon.ico",
    "assets/icon.svg",
    "assets/icon.png",
    "assets/logo.svg",
    "assets/logo.png",
    "static/favicon.svg",
    "static/favicon.png",
    "static/favicon.ico",
    "static/icon.svg",
    "static/icon.png",
    "static/logo.svg",
    "static/logo.png",
    "src-tauri/icons/icon.png",
    "src-tauri/icons/icon.ico",
    ".idea/icon.svg",
];

/// Ordered source files scanned for `<link rel="icon" href>` declarations
/// (spec order: HTML entry points, then framework `root.tsx`/`__root.tsx`
/// metadata files).
const ICON_SOURCE_FILES: &[&str] = &[
    "index.html",
    "public/index.html",
    "src/index.html",
    "app/root.tsx",
    "src/root.tsx",
    "app/routes/__root.tsx",
    "src/routes/__root.tsx",
];

/// Local-detection result of the magic-byte pipeline.
pub(super) enum Decode<'a> {
    /// Recognized image type — `mime` + payload to encode (an ICO's embedded
    /// PNG frame when one exists, otherwise the original bytes).
    Icon(&'static str, &'a [u8]),
    /// Recognized type but unusable (non-square raster/ICO) — the candidate
    /// is skipped and the scan continues.
    Rejected,
    /// No known magic — the bytes are not a detectable icon.
    Unknown,
}

/// Run the local candidate scan for `root`; first passing candidate wins.
pub(super) fn resolve_local(root: &Path) -> Option<ProjectIcon> {
    for candidate in FAVICON_CANDIDATES {
        if let Some(icon) = icon_file(&root.join(candidate)) {
            return Some(icon);
        }
    }
    for source in ICON_SOURCE_FILES {
        for href in icon_hrefs(&root.join(source)) {
            for candidate in href_candidates(root, source, &href) {
                if let Some(icon) = icon_file(&candidate) {
                    return Some(icon);
                }
            }
        }
    }
    None
}

/// Read + decode one candidate file. `None` for anything that isn't a file,
/// exceeds the read bound, or fails the sniff/square pipeline — the scan
/// continues to the next candidate in every case.
fn icon_file(path: &Path) -> Option<ProjectIcon> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_ICON_BYTES {
        return None;
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    File::open(path)
        .ok()?
        .take(MAX_ICON_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_ICON_BYTES {
        return None;
    }
    match decode_image(&bytes) {
        Decode::Icon(mime, payload) => Some(ProjectIcon {
            data_uri: format!("data:{mime};base64,{}", B64.encode(payload)),
            mime: mime.to_string(),
            source: ProjectIconSource::File,
        }),
        Decode::Rejected | Decode::Unknown => None,
    }
}

/// Magic-byte sniff → square validation for raster types → ICO PNG-frame
/// extraction. Shared by the local scan (strict: only `Icon` is accepted)
/// and the remote fetch (which may fall back to the asserted `image/*`
/// content-type on `Unknown`, but never on `Rejected`).
pub(super) fn decode_image(bytes: &[u8]) -> Decode<'_> {
    for (dims_fn, mime) in [
        (png_dims as fn(&[u8]) -> Option<Dims>, "image/png"),
        (gif_dims, "image/gif"),
        (jpeg_dims, "image/jpeg"),
        (webp_dims, "image/webp"),
    ] {
        if let Some(dims) = dims_fn(bytes) {
            return if dims.square() {
                Decode::Icon(mime, bytes)
            } else {
                Decode::Rejected
            };
        }
    }
    if is_ico(bytes) {
        return ico_icon(bytes);
    }
    if looks_like_svg(bytes) {
        return Decode::Icon("image/svg+xml", bytes);
    }
    Decode::Unknown
}

struct Dims {
    width: u32,
    height: u32,
}

impl Dims {
    fn square(&self) -> bool {
        self.width == self.height && self.width > 0
    }
}

/// PNG magic + IHDR dimensions (big-endian u32 at offsets 16/20).
fn png_dims(bytes: &[u8]) -> Option<Dims> {
    const MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";
    if bytes.len() < 24 || !bytes.starts_with(MAGIC) {
        return None;
    }
    Some(Dims {
        width: u32::from_be_bytes(bytes[16..20].try_into().ok()?),
        height: u32::from_be_bytes(bytes[20..24].try_into().ok()?),
    })
}

/// GIF87a/89a — logical screen w/h as little-endian u16 at offsets 6/8.
fn gif_dims(bytes: &[u8]) -> Option<Dims> {
    if bytes.len() < 10 || !bytes.starts_with(b"GIF8") {
        return None;
    }
    if &bytes[4..6] != b"7a" && &bytes[4..6] != b"9a" {
        return None;
    }
    Some(Dims {
        width: u16::from_le_bytes([bytes[6], bytes[7]]) as u32,
        height: u16::from_le_bytes([bytes[8], bytes[9]]) as u32,
    })
}

/// JPEG SOI + segment walk to the first SOF marker (C0–CF minus
/// DHT/DAC/JPG-extension/RST entries) — SOF holds height@+5, width@+7 BE.
fn jpeg_dims(bytes: &[u8]) -> Option<Dims> {
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return None;
    }
    let mut i = 2usize;
    while i + 9 < bytes.len() {
        if bytes[i] != 0xFF {
            i += 1;
            continue;
        }
        let marker = bytes[i + 1];
        if (0xC0..=0xCF).contains(&marker) && !matches!(marker, 0xC4 | 0xC8 | 0xCC) {
            return Some(Dims {
                height: u16::from_be_bytes([bytes[i + 5], bytes[i + 6]]) as u32,
                width: u16::from_be_bytes([bytes[i + 7], bytes[i + 8]]) as u32,
            });
        }
        let len = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
        i += 2 + len;
    }
    None
}

/// WebP `RIFF…WEBP` + first chunk: `VP8X` (24-bit LE w-1/h-1 @24/27),
/// `VP8L` (packed 14-bit dims @21–24), `VP8 ` (lossy le16&0x3FFF @26/28).
fn webp_dims(bytes: &[u8]) -> Option<Dims> {
    if bytes.len() < 30 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return None;
    }
    match &bytes[12..16] {
        b"VP8X" => Some(Dims {
            width: (u32::from(bytes[24]) | u32::from(bytes[25]) << 8 | u32::from(bytes[26]) << 16)
                + 1,
            height: (u32::from(bytes[27]) | u32::from(bytes[28]) << 8 | u32::from(bytes[29]) << 16)
                + 1,
        }),
        b"VP8L" => {
            if bytes.len() < 25 || bytes[20] != 0x2F {
                return None;
            }
            let width = u32::from(bytes[21]) | (u32::from(bytes[22] & 0x3F) << 8);
            let height = (u32::from(bytes[22]) >> 6)
                | (u32::from(bytes[23]) << 2)
                | (u32::from(bytes[24] & 0x0F) << 10);
            Some(Dims {
                width: width + 1,
                height: height + 1,
            })
        }
        b"VP8 " => Some(Dims {
            width: (u16::from_le_bytes([bytes[26], bytes[27]]) & 0x3FFF) as u32,
            height: (u16::from_le_bytes([bytes[28], bytes[29]]) & 0x3FFF) as u32,
        }),
        _ => None,
    }
}

fn is_ico(bytes: &[u8]) -> bool {
    bytes.len() >= 6 && bytes[0..4] == [0, 0, 1, 0]
}

/// ICO handling: extract an embedded PNG frame when a SQUARE one exists
/// (webviews that can't decode .ico still render); otherwise accept the
/// original bytes as `image/x-icon` when at least one frame is declared
/// square; otherwise `Rejected` (non-square raster candidate — scan on).
fn ico_icon(bytes: &[u8]) -> Decode<'_> {
    let count = u16::from_le_bytes([bytes[4], bytes[5]]) as usize;
    let mut has_square_frame = false;
    for i in 0..count {
        let base = 6 + i * 16;
        if base + 16 > bytes.len() {
            break;
        }
        let width = if bytes[base] == 0 {
            256
        } else {
            u32::from(bytes[base])
        };
        let height = if bytes[base + 1] == 0 {
            256
        } else {
            u32::from(bytes[base + 1])
        };
        let size =
            u32::from_le_bytes(bytes[base + 8..base + 12].try_into().unwrap_or([0; 4])) as usize;
        let offset =
            u32::from_le_bytes(bytes[base + 12..base + 16].try_into().unwrap_or([0; 4])) as usize;
        let Some(end) = offset.checked_add(size) else {
            continue;
        };
        let Some(frame) = bytes.get(offset..end) else {
            continue;
        };
        if let Some(dims) = png_dims(frame) {
            if dims.square() {
                return Decode::Icon("image/png", frame);
            }
            // Non-square PNG frame — keep scanning other entries.
            continue;
        }
        if width == height && width > 0 {
            has_square_frame = true;
        }
    }
    if has_square_frame {
        Decode::Icon("image/x-icon", bytes)
    } else {
        Decode::Rejected
    }
}

/// Textual SVG check: `<`-led document containing an `<svg` element start
/// (bounded to the first 8 KB so a huge generated file is still cheap).
pub(super) fn looks_like_svg(bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    let trimmed = text.trim_start_matches(['\u{FEFF}', ' ', '\t', '\r', '\n']);
    if !trimmed.starts_with('<') {
        return false;
    }
    let head = &trimmed[..trimmed.len().min(8192)];
    let lower = head.to_ascii_lowercase();
    let Some(idx) = lower.find("<svg") else {
        return false;
    };
    match lower.as_bytes().get(idx + 4) {
        None => true,
        Some(&b) => !b.is_ascii_alphanumeric() && b != b'-',
    }
}

/// Extract `<link rel="icon">` hrefs from a well-known source file: HTML
/// `<link>` attributes plus framework metadata objects (`{ rel: 'icon',
/// href: '…' }`) in `.tsx` files. Bounded read; missing/unreadable files
/// yield an empty list.
pub(super) fn icon_hrefs(path: &Path) -> Vec<String> {
    let Ok(meta) = std::fs::metadata(path) else {
        return Vec::new();
    };
    if !meta.is_file() || meta.len() > MAX_SOURCE_BYTES {
        return Vec::new();
    }
    let mut bytes = Vec::new();
    if File::open(path)
        .map(|f| f.take(MAX_SOURCE_BYTES))
        .and_then(|mut f| f.read_to_end(&mut bytes))
        .is_err()
    {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut hrefs = html_icon_hrefs(&text);
    if path.extension().is_some_and(|ext| ext == "tsx") {
        hrefs.extend(metadata_icon_hrefs(&text));
    }
    hrefs
}

lazy_static! {
    static ref LINK_TAG: Regex = Regex::new(r"(?i)<link\b[^>]*>").unwrap();
    static ref REL_ATTR: Regex = Regex::new(r#"(?i)\brel\s*=\s*["']([^"']+)["']"#).unwrap();
    static ref HREF_ATTR: Regex = Regex::new(r#"(?i)\bhref\s*=\s*["']([^"']+)["']"#).unwrap();
    static ref REL_PROP: Regex = Regex::new(r#"(?i)\brel\s*:\s*["']([^"']+)["']"#).unwrap();
    static ref HREF_PROP: Regex = Regex::new(r#"(?i)\bhref\s*:\s*["']([^"']+)["']"#).unwrap();
}

fn rel_is_icon(value: &str) -> bool {
    value
        .split_whitespace()
        .any(|token| token.eq_ignore_ascii_case("icon"))
}

fn html_icon_hrefs(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for m in LINK_TAG.find_iter(text) {
        let tag = m.as_str();
        let is_icon = REL_ATTR.captures(tag).is_some_and(|c| rel_is_icon(&c[1]));
        if !is_icon {
            continue;
        }
        if let Some(c) = HREF_ATTR.captures(tag) {
            out.push(c[1].to_string());
        }
    }
    out
}

/// Metadata-object entries like `{ rel: 'icon', href: '/x.png' }`. Splitting
/// on `}` keeps one object from borrowing `rel`/`href` across a sibling —
/// matches Orca's brace-run approach.
fn metadata_icon_hrefs(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for chunk in text.split('}') {
        let is_icon = REL_PROP.captures(chunk).is_some_and(|c| rel_is_icon(&c[1]));
        if !is_icon {
            continue;
        }
        if let Some(c) = HREF_PROP.captures(chunk) {
            out.push(c[1].to_string());
        }
    }
    out
}

/// Resolve a declared href to repo-local candidate paths — schemes,
/// protocol-relative URLs, empty hrefs, and `..` segments are refused so a
/// declaration can never read outside the project root.
pub(super) fn href_candidates(root: &Path, source_rel: &str, href: &str) -> Vec<PathBuf> {
    let href = href
        .trim()
        .split('?')
        .next()
        .unwrap_or("")
        .split('#')
        .next()
        .unwrap_or("")
        .trim();
    if href.is_empty() || href.starts_with("//") || href.contains(':') {
        return Vec::new();
    }
    if href.split(['/', '\\']).any(|seg| seg == "..") {
        return Vec::new();
    }
    let rel = href.trim_start_matches('/');
    let mut out = Vec::new();
    if href.starts_with('/') {
        // Root-relative: the bundler's `public/` mirrors the served root.
        out.push(root.join("public").join(rel));
        out.push(root.join(rel));
    } else {
        // Relative: resolve against the declaring file's directory first,
        // then the usual public/root fallbacks.
        let source_dir = Path::new(source_rel).parent().unwrap_or(Path::new(""));
        out.push(root.join(source_dir).join(rel));
        out.push(root.join("public").join(rel));
        out.push(root.join(rel));
    }
    out
}
