#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::*;
use crate::acp::safe_url::UnsafeUrl;

fn refusal(raw: &str) -> Option<UnsafeUrl> {
    match remote_auth_url(raw) {
        Err(mcp_oauth::McpOAuthError::UnsafeUrl(refused)) => Some(refused),
        _ => None,
    }
}

#[test]
fn https_authorization_url_reaches_the_remote_browser_with_its_state() {
    assert_eq!(
        remote_auth_url("https://auth.example.com/authorize?client_id=c&state=xyz123").unwrap(),
        (
            "https://auth.example.com/authorize?client_id=c&state=xyz123".to_string(),
            "xyz123".to_string()
        )
    );
}

#[test]
fn authorization_url_without_state_is_refused() {
    let error = remote_auth_url("https://auth.example.com/authorize?client_id=c").unwrap_err();
    assert_eq!(
        error.to_string(),
        "Auth URL failed: authorization URL missing state parameter"
    );
}

#[test]
fn unsafe_authorization_url_is_refused_before_the_response_is_built() {
    assert_eq!(
        refusal("javascript:alert(1)//?state=xyz"),
        Some(UnsafeUrl::SchemeNotAllowed)
    );
    assert_eq!(
        refusal("file:///etc/passwd?state=xyz"),
        Some(UnsafeUrl::SchemeNotAllowed)
    );
    assert_eq!(
        refusal("http://auth.example.com/authorize?state=xyz"),
        Some(UnsafeUrl::HttpNotLoopback)
    );
}

#[test]
fn loopback_authorization_url_is_refused_for_the_remote_browser() {
    for raw in [
        "http://127.0.0.1:4100/authorize?state=xyz",
        "http://localhost:4100/authorize?state=xyz",
        "http://[::1]:4100/authorize?state=xyz",
    ] {
        assert_eq!(refusal(raw), Some(UnsafeUrl::LoopbackForRemote), "{raw}");
    }
}

#[test]
fn start_failure_codes_name_the_unsafe_url_refusal() {
    let unsafe_url = remote_auth_url("javascript:alert(1)").unwrap_err();
    assert_eq!(start_error_code(&unsafe_url), "MCP_UNSAFE_URL");
    assert_eq!(
        unsafe_url.to_string(),
        "refused an unsafe link: only https links are allowed"
    );
    let discovery = mcp_oauth::McpOAuthError::DiscoveryFailed("down".to_string());
    assert_eq!(start_error_code(&discovery), "OAUTH_START_FAILED");
}
