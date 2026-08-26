//! MCP OAuth web routes (web parity for the desktop Tauri commands).
//!
//! `POST /mcp-servers/oauth/start` — discover + register + build auth URL.
//! `GET /oauth/callback` — the AS redirect target; exchanges code for token.
//! `POST /mcp-servers/oauth/status` — check for stored token.
//! `POST /mcp-servers/oauth/disconnect` — delete stored token.

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, Query, State};
use axum::response::Redirect;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::acp::mcp_oauth;
use crate::web::fs_api::IpcBody;
use crate::web::ws::AppState;

/// Guard OAuth control routes (start/status/disconnect) the same way write
/// routes are guarded: deny when shared-live deployment mode is active, and
/// deny non-loopback peers without `--allow-remote-writes`. The
/// `/oauth/callback` route stays publicly reachable for AS redirects.
fn guard_oauth_control<T>(
    peer: SocketAddr,
    allow_remote_writes: bool,
    shared_live_writes_denied: bool,
    route: &str,
) -> Option<IpcBody<T>> {
    if shared_live_writes_denied {
        tracing::warn!(
            target: "termul::web::mcp_oauth_api",
            route = route,
            peer = %peer,
            "OAuth control guard REFUSED (shared-live deployment mode denies all writes)",
        );
        return Some(IpcBody::<T>::err(
            "shared-live deployment mode denies all remote writes".to_string(),
            "FORBIDDEN",
        ));
    }
    let is_loopback = peer.ip().is_loopback();
    if is_loopback || allow_remote_writes {
        None
    } else {
        tracing::warn!(
            target: "termul::web::mcp_oauth_api",
            route = route,
            peer = %peer,
            "OAuth control guard REFUSED (peer not loopback; no --allow-remote-writes)",
        );
        Some(IpcBody::<T>::err(
            format!("OAuth control routes are localhost-only (peer {peer} is not loopback)"),
            "FORBIDDEN",
        ))
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthStartRequest {
    pub server_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthStartResponse {
    pub auth_url: String,
    pub redirect_uri: String,
}

/// Start the OAuth flow: discover metadata, register the client (PKCE), and
/// build the authorization URL. The generated CSRF state is stored as the flow
/// key so callbacks can be correlated by `query.state` (not by an arbitrary
/// HashMap entry). Redacted boundary logging records the start + outcome.
pub async fn oauth_start(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(request): Json<OAuthStartRequest>,
) -> Json<IpcBody<OAuthStartResponse>> {
    if let Some(err) = guard_oauth_control(
        peer,
        state.allow_remote_writes,
        state.shared_live_writes_denied,
        "/mcp-servers/oauth/start",
    ) {
        return Json(err);
    }
    let redirect_uri = format!(
        "{}/oauth/callback",
        state.oauth_base_url.trim_end_matches('/')
    );
    match build_web_auth_url(&request.server_url, &redirect_uri).await {
        Ok((auth_url, registered_uri, csrf_token)) => {
            // Key the flow by its CSRF state so the callback can look it up
            // by `query.state` instead of selecting an arbitrary entry.
            state.pending_oauth_flows.write().insert(
                csrf_token.clone(),
                mcp_oauth::PendingOAuthFlow {
                    server_url: request.server_url.clone(),
                    redirect_uri: registered_uri,
                    csrf_token,
                },
            );
            log::info!("[mcp-oauth] web flow started (url redacted)");
            Json(IpcBody::ok(OAuthStartResponse { auth_url, redirect_uri }))
        }
        Err(e) => {
            log::warn!("[mcp-oauth] web flow start failed (url redacted): {e}");
            Json(IpcBody::err(e.to_string(), "OAUTH_START_FAILED".to_string()))
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct OAuthCallbackQuery {
    pub code: String,
    pub state: String,
    pub iss: Option<String>,
}

/// The OAuth authorization-server redirect target. Correlates the callback
/// with the pending flow by `query.state` (the CSRF token). Rejects unknown
/// or mismatched states before token exchange. Atomically removes the matched
/// flow only after validation succeeds.
pub async fn oauth_callback(
    State(state): State<AppState>,
    Query(query): Query<OAuthCallbackQuery>,
) -> Result<Redirect, (axum::http::StatusCode, String)> {
    // Correlate by the CSRF state — NOT an arbitrary HashMap entry. Reject
    // unknown states before token exchange.
    let flow = {
        let mut flows = state.pending_oauth_flows.write();
        match flows.remove(&query.state) {
            Some(f) => f,
            None => {
                log::warn!(
                    "[mcp-oauth] web callback rejected: unknown OAuth state (url redacted)"
                );
                return Err((
                    axum::http::StatusCode::BAD_REQUEST,
                    "No pending OAuth flow matching the provided state".to_string(),
                ));
            }
        }
    };

    let callback_url = format!(
        "{}/oauth/callback?code={}&state={}",
        state.oauth_base_url.trim_end_matches('/'),
        urlencode(&query.code),
        urlencode(&query.state)
    );
    let server_url = flow.server_url.clone();
    let redirect_uri = flow.redirect_uri.clone();

    // The full OAuth token exchange runs in a spawn to avoid holding !Send
    // futures in the axum handler (AuthorizationManager internals are not
    // guaranteed Send).
    let result = tokio::task::spawn(async move {
        mcp_oauth::run_full_flow(&server_url, &redirect_uri, callback_url).await
    })
    .await;

    match result {
        Ok(Ok(stored)) => {
            log::info!(
                "[mcp-oauth] web flow completed (url redacted), has refresh: {}",
                stored.refresh_token.is_some()
            );
            Ok(Redirect::to("/"))
        }
        Ok(Err(e)) => {
            log::warn!("[mcp-oauth] web flow token exchange failed (url redacted): {e}");
            Err((axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
        }
        Err(e) => {
            log::warn!("[mcp-oauth] web flow task join failed (url redacted): {e}");
            Err((
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("task join: {e}"),
            ))
        }
    }
}

fn urlencode(s: &str) -> String {
    s.replace('%', "%25")
        .replace('&', "%26")
        .replace('=', "%3D")
        .replace('+', "%2B")
        .replace(' ', "%20")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthStatusRequest {
    pub server_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthStatusResponse {
    pub has_token: bool,
}

pub async fn oauth_status(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(request): Json<OAuthStatusRequest>,
) -> Json<IpcBody<OAuthStatusResponse>> {
    if let Some(err) = guard_oauth_control(
        peer,
        state.allow_remote_writes,
        state.shared_live_writes_denied,
        "/mcp-servers/oauth/status",
    ) {
        return Json(err);
    }
    let has_token = mcp_oauth::load_stored_token(&request.server_url)
        .map(|t| t.is_some())
        .unwrap_or(false);
    Json(IpcBody::ok(OAuthStatusResponse { has_token }))
}

pub async fn oauth_disconnect(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(request): Json<OAuthStatusRequest>,
) -> Json<IpcBody<()>> {
    if let Some(err) = guard_oauth_control(
        peer,
        state.allow_remote_writes,
        state.shared_live_writes_denied,
        "/mcp-servers/oauth/disconnect",
    ) {
        return Json(err);
    }
    match mcp_oauth::delete_stored_token(&request.server_url) {
        Ok(()) => {
            log::info!("[mcp-oauth] web disconnect completed (url redacted)");
            Json(IpcBody::ok(()))
        }
        Err(e) => {
            log::warn!("[mcp-oauth] web disconnect failed (url redacted): {e}");
            Json(IpcBody::err(e.to_string(), "OAUTH_DISCONNECT_FAILED".to_string()))
        }
    }
}

/// Discover metadata, register a client (PKCE), and build the authorization URL.
/// Returns `(auth_url, redirect_uri, csrf_token)` so the caller can key the
/// pending flow by the CSRF state for callback correlation.
async fn build_web_auth_url(
    server_url: &str,
    redirect_uri: &str,
) -> Result<(String, String, String), mcp_oauth::McpOAuthError> {
    use rmcp::transport::auth::{AuthorizationManager, AuthorizationSession};
    let mut manager = AuthorizationManager::new(server_url)
        .await
        .map_err(|e| mcp_oauth::McpOAuthError::DiscoveryFailed(e.to_string()))?;
    let metadata = manager
        .discover_metadata()
        .await
        .map_err(|e| mcp_oauth::McpOAuthError::DiscoveryFailed(e.to_string()))?;
    manager.set_metadata(metadata);
    let session = AuthorizationSession::new(manager, &[], redirect_uri, Some("Termul"), None)
        .await
        .map_err(|e| mcp_oauth::McpOAuthError::RegistrationFailed(e.to_string()))?;
    let auth_url = session.get_authorization_url().to_string();
    let registered_uri = session.redirect_uri.clone();
    // Extract the CSRF state from the authorization URL query so the pending
    // flow can be keyed by it. The `state` parameter is the CSRF token the
    // authorization server echoes back on the callback. Parse manually to
    // avoid adding a direct `url` crate dependency.
    let csrf_token = extract_query_param(&auth_url, "state").ok_or_else(|| {
        mcp_oauth::McpOAuthError::AuthUrlFailed(
            "authorization URL missing state parameter".to_string(),
        )
    })?;
    Ok((auth_url, registered_uri, csrf_token))
}

/// Extract a query parameter value from a URL string. Returns `None` when the
/// parameter is absent. Minimal parser — avoids adding a direct `url` crate
/// dependency for this one extraction. The CSRF state token is a random
/// alphanumeric string, so no percent-decoding is needed (the rmcp library
/// generates it from `CsrfToken::secret()`, which is URL-safe).
fn extract_query_param(url: &str, key: &str) -> Option<String> {
    let query = url.split('?').nth(1)?;
    for pair in query.split('&') {
        let mut parts = pair.splitn(2, '=');
        let k = parts.next()?;
        let v = parts.next().unwrap_or("");
        if k == key {
            return Some(v.to_string());
        }
    }
    None
}
