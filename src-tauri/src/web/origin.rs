//! Request `Origin` check for the standalone server and the desktop
//! shared-live host.
//!
//! Browsers attach `Origin` on WebSocket upgrades and on state-changing
//! fetches. When the header is present it must name the same host and port
//! as the request's `Host` header, or an origin the operator listed
//! (`--allowed-origins` / `TERMUL_ALLOWED_ORIGINS`) for a reverse proxy whose
//! public origin does not match that `Host`. Clients that omit `Origin`
//! (scripts, other non-browser callers) are unchanged.
//!
//! The server does not emit `Access-Control-Allow-Origin`. Read-only methods
//! other than the WebSocket upgrade routes are not checked here.

use std::collections::BTreeSet;

use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;

/// Extra origins accepted in addition to the request's own host and port.
///
/// Empty means "same host and port only". Stored in canonical form
/// (`https://example.com`, `http://127.0.0.1:8080`) so default ports and
/// letter case do not create duplicates.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct OriginPolicy {
    extra: BTreeSet<String>,
}

impl OriginPolicy {
    /// Parse a comma-separated list of `http`/`https` origins.
    ///
    /// A wildcard is rejected. An empty list is rejected so a blank flag
    /// fails at startup instead of silently meaning "same host only".
    pub fn parse_list(raw: &str) -> Result<Self, String> {
        let mut extra = BTreeSet::new();
        let mut saw_entry = false;
        for part in raw.split(',') {
            let part = part.trim();
            if part.is_empty() {
                continue;
            }
            saw_entry = true;
            if part == "*" {
                return Err("wildcard '*' is not an accepted origin".into());
            }
            let parsed = parse_origin(part).ok_or_else(|| {
                format!("'{part}' is not an http(s) origin (no path, query, or userinfo)")
            })?;
            extra.insert(canonical(&parsed));
        }
        if !saw_entry || extra.is_empty() {
            return Err("expected at least one http(s) origin".into());
        }
        Ok(Self { extra })
    }

    /// CLI list wins when `cli` is `Some`. Otherwise read
    /// `TERMUL_ALLOWED_ORIGINS`. Unset or blank falls back to same-host only.
    /// An invalid environment value is a startup error.
    pub fn from_cli_or_env(cli: Option<Self>) -> Result<Self, String> {
        if let Some(policy) = cli {
            return Ok(policy);
        }
        match std::env::var("TERMUL_ALLOWED_ORIGINS") {
            Ok(value) if !value.trim().is_empty() => Self::parse_list(&value)
                .map_err(|error| format!("invalid TERMUL_ALLOWED_ORIGINS: {error}")),
            _ => Ok(Self::default()),
        }
    }

    pub fn merge(mut self, other: Self) -> Self {
        self.extra.extend(other.extra);
        self
    }

    pub fn is_empty(&self) -> bool {
        self.extra.is_empty()
    }

    /// Whether `origin` (any accepted spelling) is in the extra list.
    pub fn contains(&self, origin: &str) -> bool {
        parse_origin(origin).is_some_and(|parsed| self.extra.contains(&canonical(&parsed)))
    }
}

impl std::fmt::Display for OriginPolicy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        for (index, origin) in self.extra.iter().enumerate() {
            if index > 0 {
                write!(f, ", ")?;
            }
            write!(f, "{origin}")?;
        }
        Ok(())
    }
}

/// Apply [`OriginPolicy`] in front of the rest of the router.
pub fn layer<S>(router: axum::Router<S>, policy: OriginPolicy) -> axum::Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    router.layer(axum::middleware::from_fn_with_state(policy, enforce_origin))
}

async fn enforce_origin(
    State(policy): State<OriginPolicy>,
    request: Request,
    next: Next,
) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    if !requires_check(method.as_str(), &path) {
        return next.run(request).await;
    }
    let (origin, host, invalid) = origin_and_host(request.headers());
    if invalid
        || !origin_allowed(
            method.as_str(),
            &path,
            origin.as_deref(),
            host.as_deref(),
            &policy,
        )
    {
        return forbidden(&path, origin.as_deref());
    }
    next.run(request).await
}

/// `true` when the header block cannot be read as a single origin.
fn origin_and_host(headers: &HeaderMap) -> (Option<String>, Option<String>, bool) {
    let mut origins = headers.get_all(header::ORIGIN).iter();
    let first = origins.next();
    if origins.next().is_some() {
        return (None, None, true);
    }
    let origin = match first {
        None => None,
        Some(value) => match value.to_str() {
            Ok(text) => Some(text.to_owned()),
            Err(_) => return (None, None, true),
        },
    };
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    (origin, host, false)
}

fn forbidden(path: &str, origin: Option<&str>) -> Response {
    tracing::warn!(
        target: "termul::web::origin",
        path = %bounded(path),
        origin = %bounded(origin.unwrap_or("")),
        "rejected request origin"
    );
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({
            "success": false,
            "error": "origin is not allowed",
            "code": "FORBIDDEN",
        })),
    )
        .into_response()
}

fn bounded(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars().take(200) {
        if ch.is_control() {
            out.push(' ');
        } else {
            out.push(ch);
        }
    }
    out
}

/// WebSocket upgrade paths are always checked. Other routes are checked
/// only for state-changing methods. A missing `Origin` is allowed.
pub(crate) fn origin_allowed(
    method: &str,
    path: &str,
    origin: Option<&str>,
    host: Option<&str>,
    policy: &OriginPolicy,
) -> bool {
    if !requires_check(method, path) {
        return true;
    }
    let Some(origin) = origin.map(str::trim).filter(|value| !value.is_empty()) else {
        return true;
    };
    let Some(parsed) = parse_origin(origin) else {
        return false;
    };
    if policy.extra.contains(&canonical(&parsed)) {
        return true;
    }
    host.is_some_and(|host| matches_request_host(&parsed, host))
}

fn requires_check(method: &str, path: &str) -> bool {
    path == "/ws" || path == "/terminal/ws" || matches!(method, "POST" | "PUT" | "PATCH" | "DELETE")
}

struct ParsedOrigin {
    scheme: String,
    /// Lowercase host without brackets or a trailing dot.
    host: String,
    port: Option<u16>,
}

fn parse_origin(raw: &str) -> Option<ParsedOrigin> {
    let raw = raw.trim();
    if raw.is_empty() || raw.eq_ignore_ascii_case("null") {
        return None;
    }
    let (scheme, rest) = raw.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    if rest.is_empty()
        || rest.contains('/')
        || rest.contains('?')
        || rest.contains('#')
        || rest.contains('@')
        || rest.contains('\\')
        || rest.contains(' ')
        || rest.contains(',')
    {
        return None;
    }
    let (host, port) = split_host_port(rest)?;
    Some(ParsedOrigin { scheme, host, port })
}

fn split_host_port(raw: &str) -> Option<(String, Option<u16>)> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if let Some(rest) = raw.strip_prefix('[') {
        let (host, after) = rest.split_once(']')?;
        let port = if after.is_empty() {
            None
        } else {
            let port_str = after.strip_prefix(':')?;
            Some(parse_port(port_str)?)
        };
        return Some((normalize_host(host)?, port));
    }
    if raw.matches(':').count() > 1 {
        return None;
    }
    if let Some((host, port_str)) = raw.split_once(':') {
        return Some((normalize_host(host)?, Some(parse_port(port_str)?)));
    }
    Some((normalize_host(raw)?, None))
}

fn parse_port(raw: &str) -> Option<u16> {
    if raw.is_empty() || !raw.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    let port = raw.parse::<u16>().ok()?;
    (port != 0).then_some(port)
}

fn normalize_host(host: &str) -> Option<String> {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() || host.contains(['/', '@', ' ', '[', ']']) {
        None
    } else {
        Some(host)
    }
}

fn effective_port(origin: &ParsedOrigin) -> u16 {
    origin
        .port
        .unwrap_or(if origin.scheme == "https" { 443 } else { 80 })
}

fn canonical(origin: &ParsedOrigin) -> String {
    let display_host = if origin.host.contains(':') {
        format!("[{}]", origin.host)
    } else {
        origin.host.clone()
    };
    let port = effective_port(origin);
    let default_port = if origin.scheme == "https" { 443 } else { 80 };
    if port == default_port {
        format!("{}://{display_host}", origin.scheme)
    } else {
        format!("{}://{display_host}:{port}", origin.scheme)
    }
}

fn matches_request_host(origin: &ParsedOrigin, host_header: &str) -> bool {
    let Some((host, port)) = split_host_port(host_header) else {
        return false;
    };
    if host != origin.host {
        return false;
    }
    let origin_port = effective_port(origin);
    match port {
        Some(port) => port == origin_port,
        None => origin_port == if origin.scheme == "https" { 443 } else { 80 },
    }
}

#[cfg(test)]
mod tests;
