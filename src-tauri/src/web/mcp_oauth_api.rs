//! MCP OAuth web routes (web parity for the desktop Tauri commands).
//!
//! `POST /mcp-servers/oauth/start` — discover + register + build auth URL.
//! `GET /oauth/callback` — the AS redirect target; exchanges code for token.
//! `POST /mcp-servers/oauth/status` — check for stored token.
//! `POST /mcp-servers/oauth/disconnect` — delete stored token.

use axum::extract::{Query, State};
use axum::response::{Redirect};
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::acp::mcp_oauth;
use crate::web::fs_api::IpcBody;
use crate::web::ws::AppState;

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

pub async fn oauth_start(
    State(state): State<AppState>,
    Json(request): Json<OAuthStartRequest>,
) -> Json<IpcBody<OAuthStartResponse>> {
    let redirect_uri = format!(
        "{}/oauth/callback",
        state.oauth_base_url.trim_end_matches('/')
    );
    match build_web_auth_url(&request.server_url, &redirect_uri).await {
        Ok((auth_url, registered_uri)) => {
            state.pending_oauth_flows.write().insert(
                request.server_url.clone(),
                mcp_oauth::PendingOAuthFlow {
                    server_url: request.server_url.clone(),
                    redirect_uri: registered_uri,
                    csrf_token: String::new(),
                },
            );
            Json(IpcBody::ok(OAuthStartResponse { auth_url, redirect_uri }))
        }
        Err(e) => Json(IpcBody::err(e.to_string(), "OAUTH_START_FAILED".to_string())),
    }
}

#[derive(Debug, Deserialize)]
pub struct OAuthCallbackQuery {
    pub code: String,
    pub state: String,
    pub iss: Option<String>,
}
pub async fn oauth_callback(
    State(state): State<AppState>,
    Query(query): Query<OAuthCallbackQuery>,
) -> Result<Redirect, (axum::http::StatusCode, String)> {
    // The full OAuth token exchange runs in a spawn_blocking to avoid
    // holding !Send futures in the axum handler (AuthorizationManager
    // internals are not guaranteed Send).
    let flows = state.pending_oauth_flows.read().clone();
    let flow = match flows.values().next() {
        Some(f) => f.clone(),
        None => return Err((axum::http::StatusCode::BAD_REQUEST, "No pending OAuth flow".to_string())),
    };
    let callback_url = format!(
        "{}/oauth/callback?code={}&state={}",
        state.oauth_base_url.trim_end_matches('/'),
        urlencode(&query.code),
        urlencode(&query.state)
    );
    let server_url = flow.server_url.clone();
    let redirect_uri = flow.redirect_uri.clone();

    let result = tokio::task::spawn(async move {
        mcp_oauth::run_full_flow(&server_url, &redirect_uri, callback_url).await
    }).await;

    match result {
        Ok(Ok(stored)) => {
            state.pending_oauth_flows.write().remove(&flow.server_url);
            log::info!("[mcp-oauth] web flow completed (url redacted), has refresh: {}", stored.refresh_token.is_some());
            Ok(Redirect::to("/"))
        }
        Ok(Err(e)) => Err((axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
        Err(e) => Err((axum::http::StatusCode::INTERNAL_SERVER_ERROR, format!("task join: {e}"))),
    }
}
fn urlencode(s: &str) -> String {
    s.replace('%', "%25").replace('&', "%26").replace('=', "%3D").replace('+', "%2B").replace(' ', "%20")
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

pub async fn oauth_status(Json(request): Json<OAuthStatusRequest>) -> Json<IpcBody<OAuthStatusResponse>> {
    let has_token = mcp_oauth::load_stored_token(&request.server_url)
        .map(|t| t.is_some())
        .unwrap_or(false);
    Json(IpcBody::ok(OAuthStatusResponse { has_token }))
}

pub async fn oauth_disconnect(Json(request): Json<OAuthStatusRequest>) -> Json<IpcBody<()>> {
    match mcp_oauth::delete_stored_token(&request.server_url) {
        Ok(()) => Json(IpcBody::ok(())),
        Err(e) => Json(IpcBody::err(e.to_string(), "OAUTH_DISCONNECT_FAILED".to_string())),
    }
}

async fn build_web_auth_url(server_url: &str, redirect_uri: &str) -> Result<(String, String), mcp_oauth::McpOAuthError> {
    use rmcp::transport::auth::{AuthorizationManager, AuthorizationSession};
    let mut manager = AuthorizationManager::new(server_url)
        .await
        .map_err(|e| mcp_oauth::McpOAuthError::DiscoveryFailed(e.to_string()))?;
    let metadata = manager.discover_metadata().await
        .map_err(|e| mcp_oauth::McpOAuthError::DiscoveryFailed(e.to_string()))?;
    manager.set_metadata(metadata);
    let session = AuthorizationSession::new(manager, &[], redirect_uri, Some("Termul"), None)
        .await
        .map_err(|e| mcp_oauth::McpOAuthError::RegistrationFailed(e.to_string()))?;
    Ok((session.get_authorization_url().to_string(), session.redirect_uri.clone()))
}
