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
            text: cap(&scrub_urls(text), TEXT_MAX).to_string(),
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

const TEXT_URL_SCHEMES: [&str; 4] = ["https://", "http://", "wss://", "ws://"];

/// `text` with every http(s) and ws(s) URL in it cut like [`strip_url`]:
/// no credentials, query string or fragment. Engines quote request URLs
/// in their own messages (CORS refusals, failed loads, stack traces), so
/// console text needs the same cut as the URL fields.
pub fn scrub_urls(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut i = 0;
    while i < bytes.len() {
        let at_word_start = i == 0 || !bytes[i - 1].is_ascii_alphanumeric();
        let scheme = at_word_start
            .then(|| {
                TEXT_URL_SCHEMES
                    .iter()
                    .find(|s| bytes.len() - i >= s.len() && bytes[i..i + s.len()].eq_ignore_ascii_case(s.as_bytes()))
            })
            .flatten();
        let Some(scheme) = scheme else {
            i += 1;
            continue;
        };
        let end = bytes[i..]
            .iter()
            .position(|b| b.is_ascii_whitespace() || br#""'`<>()[]{}\"#.contains(b))
            .map_or(bytes.len(), |n| i + n);
        out.push_str(&text[copied..i]);
        out.push_str(&scrub_url_token(&text[i..end], scheme.len()));
        copied = end;
        i = end;
    }
    out.push_str(&text[copied..]);
    out
}

/// One URL token: drop `user:pass@` from the authority and everything
/// from the first `?` or `#`.
fn scrub_url_token(token: &str, scheme_len: usize) -> String {
    let (scheme, rest) = token.split_at(scheme_len);
    let rest = rest.find(['?', '#']).map_or(rest, |cut| &rest[..cut]);
    let authority_end = rest.find('/').unwrap_or(rest.len());
    let host_start = rest[..authority_end].rfind('@').map_or(0, |at| at + 1);
    format!("{scheme}{}", &rest[host_start..])
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
