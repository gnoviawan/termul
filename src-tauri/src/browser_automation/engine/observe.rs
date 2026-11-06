//! Console and network observations: the entry shapes adapters publish.
//!
//! Every field is page-derived. Adapters build entries through the
//! constructors here, which cap text and strip URLs to origin and path at
//! the source, so a query string, fragment or credential never leaves the
//! adapter.

use serde::Serialize;

/// Cap for console text and stack locations, in bytes.
pub const TEXT_MAX: usize = 2 * 1024;
/// Cap for one network URL (origin and path), in bytes.
pub const URL_MAX: usize = 2 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConsoleLevel {
    Debug,
    Log,
    Info,
    Warn,
    Error,
}

impl ConsoleLevel {
    /// The level of a console method or engine log level name.
    pub fn parse(name: &str) -> Self {
        match name {
            "debug" | "verbose" => ConsoleLevel::Debug,
            "info" => ConsoleLevel::Info,
            "warn" | "warning" => ConsoleLevel::Warn,
            "error" | "assert" => ConsoleLevel::Error,
            _ => ConsoleLevel::Log,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConsoleEntry {
    pub level: ConsoleLevel,
    pub text: String,
    /// Where the message came from (script or resource URL), stripped.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

impl ConsoleEntry {
    pub fn new(level: ConsoleLevel, text: &str, source: Option<&str>) -> Self {
        Self {
            level,
            text: cap(text, TEXT_MAX).to_string(),
            source: source.filter(|s| !s.is_empty()).map(strip_url),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NetworkEntry {
    pub method: String,
    /// Origin and path only.
    pub url: String,
    /// HTTP status; absent when no response arrived.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    /// The engine's resource type (document, script, image, fetch, ...),
    /// where it reports one.
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub resource: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// The request failed or was cancelled before a response completed.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub failed: bool,
}

/// `scheme://host[:port]/path` for http(s) and ws(s) URLs; just the
/// scheme for anything else (`data:`, `blob:`, `about:`), whose remainder
/// can carry page data.
pub fn strip_url(raw: &str) -> String {
    let Ok(url) = raw.parse::<tauri::Url>() else {
        return String::new();
    };
    match url.scheme() {
        "http" | "https" | "ws" | "wss" => {
            let full = format!("{}{}", url.origin().ascii_serialization(), url.path());
            cap(&full, URL_MAX).to_string()
        }
        scheme => format!("{scheme}:"),
    }
}

/// Entries the console shim handed over: `{batches: [json text of
/// [{level, text, source}]]}`. Anything else in the reply is ignored, since
/// page script can feed the shim.
#[cfg_attr(target_os = "windows", allow(dead_code, reason = "WebView2 reads the console through CDP"))]
pub fn parse_console_batches(pulled: &serde_json::Value) -> Vec<ConsoleEntry> {
    let Some(batches) = pulled.get("batches").and_then(serde_json::Value::as_array) else {
        return Vec::new();
    };
    batches
        .iter()
        .filter_map(serde_json::Value::as_str)
        .filter_map(|batch| serde_json::from_str::<Vec<serde_json::Value>>(batch).ok())
        .flatten()
        .filter_map(|entry| {
            let text = entry.get("text")?.as_str()?;
            let level = entry.get("level").and_then(serde_json::Value::as_str).unwrap_or("log");
            let source = entry.get("source").and_then(serde_json::Value::as_str);
            Some(ConsoleEntry::new(ConsoleLevel::parse(level), text, source))
        })
        .collect()
}

/// Hard cut at `max` bytes on a char boundary.
pub fn cap(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut cut = max;
    while !s.is_char_boundary(cut) {
        cut -= 1;
    }
    &s[..cut]
}

#[cfg(test)]
#[path = "observe_tests.rs"]
mod tests;
