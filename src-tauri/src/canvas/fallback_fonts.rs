//! System fonts the desktop lends the canvas editor for the characters its
//! embedded Inter lacks: symbols, CJK and emoji (#1421). The editor's web
//! build cannot read system fonts, so the desktop loopback listener serves
//! these files at `/canvas/<id>/<token>/host-fonts/<file>` and the renderer
//! passes their URLs to `host.fallbackFonts` before it loads the document.
//!
//! Only the loopback listener serves them, and only the desktop's open info
//! lists them. The fonts are licensed to this machine; `termul-server` and the
//! shared-live host would send them to the browser of another one.

use std::path::PathBuf;
use std::sync::OnceLock;

use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};

/// Where the files are served, under the bundle's token path.
pub const ROUTE: &str = "host-fonts/";

/// In fallback order: symbols first (their glyphs sit best next to Inter),
/// then Chinese with kana, Hangul, and colour emoji last.
#[cfg(windows)]
const FILES: &[&str] = &["seguisym.ttf", "msyh.ttc", "malgun.ttf", "seguiemj.ttf"];
#[cfg(not(windows))]
const FILES: &[&str] = &[];

#[cfg(windows)]
fn font_dir() -> PathBuf {
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
    PathBuf::from(root).join("Fonts")
}

#[cfg(not(windows))]
fn font_dir() -> PathBuf {
    PathBuf::new()
}

/// The files of [`FILES`] this machine has, in order. Looked up once.
fn available() -> &'static [&'static str] {
    static AVAILABLE: OnceLock<Vec<&'static str>> = OnceLock::new();
    AVAILABLE.get_or_init(|| {
        let dir = font_dir();
        let found: Vec<&'static str> = FILES
            .iter()
            .copied()
            .filter(|file| dir.join(file).is_file())
            .collect();
        log::info!(
            "[canvas] fallback fonts available={} of {}: {}",
            found.len(),
            FILES.len(),
            found.join(", ")
        );
        found
    })
}

/// The URLs, relative to the bundle page, the renderer hands `host.fallbackFonts`.
pub fn urls() -> Vec<String> {
    available()
        .iter()
        .map(|file| format!("{ROUTE}{file}"))
        .collect()
}

/// Serve `file` when it is one of the available fallback fonts; anything else
/// is a 404, so this route never reads another path.
pub async fn response(method: &Method, file: &str) -> Response {
    if *method != Method::GET {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let Some(file) = available().iter().find(|known| **known == file) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let bytes = match tokio::fs::read(font_dir().join(file)).await {
        Ok(bytes) => bytes,
        Err(error) => {
            log::warn!("[canvas] fallback font {file} could not be read: {error}");
            return StatusCode::NOT_FOUND.into_response();
        }
    };
    let content_type = if file.ends_with(".ttc") {
        "font/collection"
    } else {
        "font/ttf"
    };
    (
        [
            (header::CONTENT_TYPE, HeaderValue::from_static(content_type)),
            (
                header::CACHE_CONTROL,
                HeaderValue::from_static("private, max-age=3600"),
            ),
        ],
        bytes,
    )
        .into_response()
}
