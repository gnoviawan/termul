//! Security validation for the remote terminal server.
//!
//! ## Access model (no token)
//!
//! Per product requirement the server is reachable by `ip:port` alone — there is
//! no auth token. The only network-level defense kept here is **same-origin
//! validation** to prevent Cross-Site WebSocket Hijacking (CSWSH).
//!
//! ### Why same-origin instead of an allowlist?
//!
//! Browsers always send an `Origin` header on WebSocket upgrades. An attacker
//! page hosted on `evil.com` that tries to open a socket to this server will
//! carry `Origin: https://evil.com`, which will not match the server's own
//! `Host`. We reject that. This works for *any* `ip:port` the server happens to
//! bind to (including a tunnel hostname) without needing a preconfigured list.
//! Non-browser clients (curl, scripts) that omit `Origin` are allowed through,
//! exactly as before — they are not a CSWSH vector.
//!
//! The Dozzle incident (GHSA-j643-x8pv-8m67) is the canonical example of what
//! goes wrong when origin checking is skipped: an `CheckOrigin: true` upgrader
//! let any site hijack the authenticated socket. Same-origin closes that hole.

use axum::http::{header, HeaderMap, StatusCode};
use parking_lot::Mutex;
use std::collections::HashMap;

/// Validate that a WebSocket upgrade is same-origin (CSWSH prevention).
///
/// Rules:
/// - No `Origin` header → reject (fail closed). Browsers always send `Origin`
///   on WebSocket upgrades per RFC 6455, so a missing one is anomalous; for a
///   PTY/RCE surface we prefer to reject rather than guess.
/// - `Origin` present → its host:port must equal the request `Host`. Otherwise
///   reject with `403 Forbidden`.
///
/// Comparing the *host[:port]* (not the scheme) keeps this correct whether the
/// page was served over http or wrapped in https by a tunnel.
pub fn validate_same_origin(headers: &HeaderMap) -> Result<(), (StatusCode, &'static str)> {
    let origin = match headers.get(header::ORIGIN) {
        Some(o) => o
            .to_str()
            .map_err(|_| (StatusCode::BAD_REQUEST, "Invalid Origin header encoding"))?,
        // Fail closed: no Origin on a WS upgrade is treated as a rejected request.
        None => return Err((StatusCode::FORBIDDEN, "Missing Origin header")),
    };

    // Strip the scheme to get host[:port].
    let origin_host = origin
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(origin)
        .trim_end_matches('/');

    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .ok_or((StatusCode::BAD_REQUEST, "Missing Host header"))?;

    if origin_host.eq_ignore_ascii_case(host) {
        Ok(())
    } else {
        Err((StatusCode::FORBIDDEN, "Cross-origin request rejected"))
    }
}

/// Per-terminal connection counter. Tracks how many WebSocket clients are
/// currently attached to each terminal. Used to enforce a per-terminal cap.
pub struct ConnectionTracker {
    counts: Mutex<HashMap<String, usize>>,
}

impl ConnectionTracker {
    pub fn new() -> Self {
        Self {
            counts: Mutex::new(HashMap::new()),
        }
    }

    /// Try to increment the counter for a terminal. Returns `true` if under limit.
    pub fn try_add(&self, terminal_id: &str, max: usize) -> bool {
        let mut map = self.counts.lock();
        let count = map.entry(terminal_id.to_string()).or_insert(0);
        if *count >= max {
            return false;
        }
        *count += 1;
        true
    }

    /// Decrement the counter for a terminal. Called on WebSocket disconnect.
    pub fn remove(&self, terminal_id: &str) {
        let mut map = self.counts.lock();
        if let Some(count) = map.get_mut(terminal_id) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                map.remove(terminal_id);
            }
        }
    }

    /// Get the current connection count for a terminal.
    #[allow(dead_code)]
    pub fn get(&self, terminal_id: &str) -> usize {
        self.counts.lock().get(terminal_id).copied().unwrap_or(0)
    }

    /// Get the total number of active connections across all terminals.
    pub fn total(&self) -> usize {
        self.counts.lock().values().sum()
    }
}

impl Default for ConnectionTracker {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(origin: Option<&str>, host: Option<&str>) -> HeaderMap {
        let mut h = HeaderMap::new();
        if let Some(o) = origin {
            h.insert(header::ORIGIN, HeaderValue::from_str(o).unwrap());
        }
        if let Some(host) = host {
            h.insert(header::HOST, HeaderValue::from_str(host).unwrap());
        }
        h
    }

    #[test]
    fn same_origin_accepts_matching_host() {
        let h = headers(Some("http://127.0.0.1:5180"), Some("127.0.0.1:5180"));
        assert!(validate_same_origin(&h).is_ok());
    }

    #[test]
    fn same_origin_accepts_https_origin_with_matching_host() {
        // A tunnel may terminate TLS: Origin https://, Host the same authority.
        let h = headers(
            Some("https://example.trycloudflare.com"),
            Some("example.trycloudflare.com"),
        );
        assert!(validate_same_origin(&h).is_ok());
    }

    #[test]
    fn cross_origin_is_rejected() {
        // CSWSH: attacker page on evil.com targeting the local server.
        let h = headers(Some("http://evil.com"), Some("127.0.0.1:5180"));
        assert!(validate_same_origin(&h).is_err());
    }

    #[test]
    fn missing_origin_is_rejected_fail_closed() {
        // A WS upgrade with no Origin is anomalous (browsers always send it);
        // we fail closed for the PTY/RCE surface.
        let h = headers(None, Some("127.0.0.1:5180"));
        assert!(validate_same_origin(&h).is_err());
    }

    #[test]
    fn connection_tracker_enforces_limit() {
        let t = ConnectionTracker::new();
        assert!(t.try_add("a", 2));
        assert!(t.try_add("a", 2));
        assert!(!t.try_add("a", 2));
        assert_eq!(t.get("a"), 2);
        assert_eq!(t.total(), 2);
        t.remove("a");
        assert_eq!(t.get("a"), 1);
    }
}
