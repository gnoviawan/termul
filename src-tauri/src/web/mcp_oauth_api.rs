//! MCP OAuth web routes (web parity for the desktop Tauri commands).
//!
//! `POST /mcp-servers/oauth/start` — discover + register + build auth URL.
//! `GET /oauth/callback` — the AS redirect target; exchanges code for token.
//! `POST /mcp-servers/oauth/complete` — paste-back: a browser on another
//! machine cannot reach the loopback redirect, so the user pastes the address
//! it landed on and this route finishes the same exchange.
//! `POST /mcp-servers/oauth/status` — check for stored token.
//! `POST /mcp-servers/oauth/disconnect` — delete stored token.
//!
//! Every request names the `projectId` it acts for; an unknown, archived or
//! pathless project is refused `NOT_FOUND`. `start` authorizes the server URL
//! against THAT project's `.termul/mcp-servers.json` only. The token store
//! itself stays keyed by server URL and host-global (`acp::mcp_oauth`): a token
//! belongs to the host's credential for that URL, not to a project, so
//! `status`/`disconnect` validate the project but read and delete the one
//! URL-keyed token.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::time::Instant;

use axum::extract::{ConnectInfo, Query, State};
use axum::http::StatusCode;
use axum::response::Redirect;
use axum::Json;
use rmcp::transport::auth::AuthorizationSession;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::acp::mcp_oauth;
use crate::acp::safe_url::{check_safe_url, Opener, MCP_UNSAFE_URL};
use crate::web::fs_api::{check_local_only, IpcBody};
use crate::web::mcp_servers_api::project_root_or_not_found;
use crate::web::ws::AppState;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OAuthStartRequest {
    pub project_id: String,
    pub server_url: String,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OAuthStartResponse {
    pub auth_url: String,
    pub redirect_uri: String,
}

/// Start the OAuth flow: discover metadata, register the client (PKCE), and
/// build the authorization URL. The flow keeps the session (PKCE verifier and
/// client id) under its CSRF state so the redirect, reached directly or pasted
/// back, finishes the exchange with it. Redacted boundary logging records the
/// start + outcome.
pub async fn oauth_start(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(request): Json<OAuthStartRequest>,
) -> Json<IpcBody<OAuthStartResponse>> {
    if let Some(err) = check_local_only(
        peer,
        state.allow_remote_writes,
        state.shared_live_writes_denied,
        "/mcp-servers/oauth/start",
    ) {
        return Json(err);
    }
    // Restrict OAuth discovery to a configured MCP server URL so a web
    // client cannot make the host probe an attacker-selected internal
    // service. Resolve the URL against the persisted MCP server registry
    // (`.termul/mcp-servers.json`) — reject if no enabled HTTP/SSE entry
    // matches.
    let project_root =
        match project_root_or_not_found::<OAuthStartResponse>(&state.registry, &request.project_id)
        {
            Ok(root) => root,
            Err(body) => return Json(body),
        };
    if !is_authorized_mcp_server_url(&project_root, &request.server_url).await {
        log::warn!(
            "[mcp-oauth] web flow start rejected: server URL not in authorized registry (url redacted)"
        );
        return Json(IpcBody::err(
            "server URL is not a configured MCP server".to_string(),
            "UNAUTHORIZED_SERVER_URL".to_string(),
        ));
    }
    let redirect_uri = format!(
        "{}/oauth/callback",
        state.oauth_base_url.trim_end_matches('/')
    );
    match build_web_auth_url(&request.server_url, &redirect_uri).await {
        Ok((auth_url, csrf_token, session)) => {
            let now = Instant::now();
            let mut flows = state.pending_oauth_flows.write();
            prune_expired(&mut flows, now);
            flows.insert(
                csrf_token,
                mcp_oauth::PendingOAuthFlow {
                    server_url: request.server_url.clone(),
                    redirect_uri: session.redirect_uri.clone(),
                    session,
                    created_at: now,
                },
            );
            drop(flows);
            log::info!("[mcp-oauth] web flow started (url redacted)");
            Json(IpcBody::ok(OAuthStartResponse {
                auth_url,
                redirect_uri,
            }))
        }
        Err(e) => {
            log::warn!("[mcp-oauth] web flow start failed (url redacted): {e}");
            Json(IpcBody::err(
                e.to_string(),
                start_error_code(&e).to_string(),
            ))
        }
    }
}

fn start_error_code(error: &mcp_oauth::McpOAuthError) -> &'static str {
    match error {
        mcp_oauth::McpOAuthError::UnsafeUrl(_) => MCP_UNSAFE_URL,
        _ => "OAUTH_START_FAILED",
    }
}

/// The parameters of an authorization-server redirect, whether it reached
/// `GET /oauth/callback` or was pasted back. A denied consent carries
/// `error` (and maybe `error_description`) instead of `code`.
#[derive(Debug, Default, Deserialize, schemars::JsonSchema)]
pub struct OAuthCallbackQuery {
    pub code: Option<String>,
    pub state: Option<String>,
    pub iss: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
}

impl OAuthCallbackQuery {
    fn from_url(url: &Url) -> Self {
        let mut query = Self::default();
        for (key, value) in url.query_pairs() {
            let slot = match key.as_ref() {
                "code" => &mut query.code,
                "state" => &mut query.state,
                "iss" => &mut query.iss,
                "error" => &mut query.error,
                "error_description" => &mut query.error_description,
                _ => continue,
            };
            *slot = Some(value.into_owned());
        }
        query
    }
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OAuthCompleteRequest {
    pub project_id: String,
    /// The address the browser landed on after sign-in (the redirect URI with
    /// `code` and `state`, or `error`). Never fetched.
    pub callback_url: String,
}

/// Why a redirect could not finish its flow. Each maps to the wire `code` the
/// paste-back dialog branches on.
#[derive(Debug, PartialEq, Eq)]
enum CompleteError {
    /// Not a URL, not the flow's redirect endpoint, or no `state`/`code`.
    /// The flow is kept so the user can paste again.
    BadRedirect(&'static str),
    /// No pending flow for the `state` (never started, used, or expired).
    UnknownState,
    /// The provider reported an `error`; carries its description. The flow is
    /// removed.
    Denied(String),
    /// The token exchange failed. The flow is removed.
    ExchangeFailed(String),
}

impl CompleteError {
    fn code(&self) -> &'static str {
        match self {
            Self::BadRedirect(_) => "OAUTH_BAD_REDIRECT",
            Self::UnknownState => "OAUTH_UNKNOWN_STATE",
            Self::Denied(_) => "OAUTH_DENIED",
            Self::ExchangeFailed(_) => "OAUTH_EXCHANGE_FAILED",
        }
    }

    fn status(&self) -> StatusCode {
        match self {
            Self::ExchangeFailed(_) => StatusCode::BAD_GATEWAY,
            _ => StatusCode::BAD_REQUEST,
        }
    }

    fn message(&self) -> String {
        match self {
            Self::BadRedirect(why) => (*why).to_string(),
            Self::UnknownState => {
                "No pending sign-in matches this address. Start Connect again.".to_string()
            }
            Self::Denied(why) => why.clone(),
            Self::ExchangeFailed(why) => why.clone(),
        }
    }
}

type PendingFlows = HashMap<String, mcp_oauth::PendingOAuthFlow>;

fn prune_expired(flows: &mut PendingFlows, now: Instant) {
    flows.retain(|_, flow| !flow.is_expired(now));
}

/// A pending flow taken out of the map with the redirect values to exchange.
struct ClaimedFlow {
    flow: mcp_oauth::PendingOAuthFlow,
    code: String,
    csrf_token: String,
    iss: Option<String>,
}

/// Match a redirect to its pending flow by `state` and take the flow out.
/// When `pasted` is given (paste-back), its scheme, host, port and path must
/// equal the flow's registered redirect URI first. Expired flows are dropped
/// before the lookup.
fn claim_flow(
    flows: &mut PendingFlows,
    query: OAuthCallbackQuery,
    pasted: Option<&Url>,
    now: Instant,
) -> Result<ClaimedFlow, CompleteError> {
    prune_expired(flows, now);
    let Some(csrf_token) = query.state else {
        return Err(CompleteError::BadRedirect(
            "This address is not a sign-in redirect: it has no state parameter.",
        ));
    };
    let Some(flow) = flows.get(&csrf_token) else {
        return Err(CompleteError::UnknownState);
    };
    if let Some(url) = pasted {
        if !is_redirect_endpoint(url, &flow.redirect_uri) {
            return Err(CompleteError::BadRedirect(
                "This address is not the sign-in redirect. Paste the address the browser landed on after sign-in.",
            ));
        }
    }
    if let Some(error) = query.error {
        flows.remove(&csrf_token);
        let description = query
            .error_description
            .filter(|description| !description.trim().is_empty());
        return Err(CompleteError::Denied(description.unwrap_or(error)));
    }
    let Some(code) = query.code else {
        return Err(CompleteError::BadRedirect(
            "This address has no authorization code.",
        ));
    };
    let Some(flow) = flows.remove(&csrf_token) else {
        return Err(CompleteError::UnknownState);
    };
    Ok(ClaimedFlow {
        flow,
        code,
        csrf_token,
        iss: query.iss,
    })
}

/// Whether `url` names the same endpoint as the registered redirect URI:
/// scheme, host, port and path equal (query and fragment ignored).
fn is_redirect_endpoint(url: &Url, registered: &str) -> bool {
    let Ok(registered) = Url::parse(registered) else {
        return false;
    };
    url.scheme() == registered.scheme()
        && url.host_str() == registered.host_str()
        && url.port_or_known_default() == registered.port_or_known_default()
        && url.path() == registered.path()
}

/// Finish a flow from its redirect: claim it, then exchange the code with the
/// session stored at start and persist the token. Shared by the direct
/// callback and the paste-back route.
async fn complete_flow(
    flows: &parking_lot::RwLock<PendingFlows>,
    query: OAuthCallbackQuery,
    pasted: Option<&Url>,
) -> Result<mcp_oauth::StoredToken, CompleteError> {
    let ClaimedFlow {
        flow,
        code,
        csrf_token,
        iss,
    } = claim_flow(&mut flows.write(), query, pasted, Instant::now())?;
    let server_url = flow.server_url;
    let session: AuthorizationSession = flow.session;
    // The exchange runs in its own task so a client that disconnects
    // mid-request cannot drop it after the flow left the map.
    let joined = tokio::task::spawn(async move {
        mcp_oauth::finish_session(&server_url, session, &code, &csrf_token, iss.as_deref()).await
    })
    .await;
    match joined {
        Ok(Ok(stored)) => Ok(stored),
        Ok(Err(e)) => Err(CompleteError::ExchangeFailed(e.to_string())),
        Err(e) => Err(CompleteError::ExchangeFailed(format!("task join: {e}"))),
    }
}

/// Log a failed redirect: the code always, plus the reason for a provider
/// denial or a failed exchange (neither carries the code, state or URL).
fn log_failure(route: &str, error: &CompleteError) {
    match error {
        CompleteError::Denied(why) | CompleteError::ExchangeFailed(why) => log::warn!(
            "[mcp-oauth] web {route} failed (url redacted): {}: {why}",
            error.code()
        ),
        _ => log::warn!(
            "[mcp-oauth] web {route} failed (url redacted): {}",
            error.code()
        ),
    }
}

/// The OAuth authorization-server redirect target, reached when the browser
/// runs on the host's machine. Redirects to the app on success.
pub async fn oauth_callback(
    State(state): State<AppState>,
    Query(query): Query<OAuthCallbackQuery>,
) -> Result<Redirect, (StatusCode, String)> {
    match complete_flow(&state.pending_oauth_flows, query, None).await {
        Ok(stored) => {
            log::info!(
                "[mcp-oauth] web flow completed via callback (url redacted), has refresh: {}",
                stored.refresh_token.is_some()
            );
            Ok(Redirect::to("/"))
        }
        Err(e) => {
            log_failure("callback", &e);
            Err((e.status(), e.message()))
        }
    }
}

/// Paste-back: finish a flow from the redirect address the user copied out
/// of a browser that could not reach the host's loopback callback.
pub async fn oauth_complete(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(request): Json<OAuthCompleteRequest>,
) -> (StatusCode, Json<IpcBody<()>>) {
    if let Some(err) = check_local_only(
        peer,
        state.allow_remote_writes,
        state.shared_live_writes_denied,
        "/mcp-servers/oauth/complete",
    ) {
        return (StatusCode::OK, Json(err));
    }
    if let Err(body) = project_root_or_not_found(&state.registry, &request.project_id) {
        return (StatusCode::OK, Json(body));
    }
    let result = match Url::parse(request.callback_url.trim()) {
        Ok(url) => {
            let query = OAuthCallbackQuery::from_url(&url);
            complete_flow(&state.pending_oauth_flows, query, Some(&url)).await
        }
        Err(_) => Err(CompleteError::BadRedirect(
            "This is not a web address. Paste the full address from the browser's address bar.",
        )),
    };
    match result {
        Ok(stored) => {
            log::info!(
                "[mcp-oauth] web flow completed via paste-back (url redacted), has refresh: {}",
                stored.refresh_token.is_some()
            );
            (StatusCode::OK, Json(IpcBody::ok(())))
        }
        Err(e) => {
            log_failure("paste-back", &e);
            (e.status(), Json(IpcBody::err(e.message(), e.code())))
        }
    }
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OAuthStatusRequest {
    pub project_id: String,
    pub server_url: String,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OAuthStatusResponse {
    pub has_token: bool,
}

pub async fn oauth_status(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(request): Json<OAuthStatusRequest>,
) -> Json<IpcBody<OAuthStatusResponse>> {
    if let Some(err) = check_local_only(
        peer,
        state.allow_remote_writes,
        state.shared_live_writes_denied,
        "/mcp-servers/oauth/status",
    ) {
        return Json(err);
    }
    if let Err(body) = project_root_or_not_found(&state.registry, &request.project_id) {
        return Json(body);
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
    if let Some(err) = check_local_only(
        peer,
        state.allow_remote_writes,
        state.shared_live_writes_denied,
        "/mcp-servers/oauth/disconnect",
    ) {
        return Json(err);
    }
    if let Err(body) = project_root_or_not_found(&state.registry, &request.project_id) {
        return Json(body);
    }
    match mcp_oauth::delete_stored_token(&request.server_url) {
        Ok(()) => {
            log::info!("[mcp-oauth] web disconnect completed (url redacted)");
            Json(IpcBody::ok(()))
        }
        Err(e) => {
            log::warn!("[mcp-oauth] web disconnect failed (url redacted): {e}");
            Json(IpcBody::err(
                e.to_string(),
                "OAUTH_DISCONNECT_FAILED".to_string(),
            ))
        }
    }
}

/// Check whether the given `server_url` matches an enabled HTTP/SSE entry in
/// the persisted MCP server registry (`{project_root}/.termul/mcp-servers.json`) of the named project.
/// This prevents a web client from using the OAuth start endpoint to make the
/// host discover OAuth metadata for an attacker-selected URL.
async fn is_authorized_mcp_server_url(project_root: &std::path::Path, server_url: &str) -> bool {
    let path = crate::web::mcp_servers_api::registry_path(project_root);
    let Ok(bytes) = tokio::fs::read(&path).await else {
        return false;
    };
    let Ok(entries) = serde_json::from_slice::<Vec<serde_json::Value>>(&bytes) else {
        return false;
    };
    let normalized = server_url.trim_end_matches('/');
    entries.iter().any(|entry| {
        let r#type = entry
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("stdio");
        let url = entry.get("url").and_then(|v| v.as_str()).unwrap_or("");
        let enabled = entry
            .get("enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        enabled && (r#type == "http" || r#type == "sse") && url.trim_end_matches('/') == normalized
    })
}

/// Discover metadata, register a client (PKCE), and build the authorization URL.
/// Returns `(auth_url, csrf_token, session)`; the caller keys the pending flow
/// by the CSRF state and keeps the session for the code exchange.
async fn build_web_auth_url(
    server_url: &str,
    redirect_uri: &str,
) -> Result<(String, String, AuthorizationSession), mcp_oauth::McpOAuthError> {
    use rmcp::transport::auth::{AuthorizationManager, AuthorizationRequest};
    let mut manager = AuthorizationManager::new(server_url)
        .await
        .map_err(|e| mcp_oauth::McpOAuthError::DiscoveryFailed(e.to_string()))?;
    let resolution = manager
        .resolve_metadata()
        .await
        .map_err(|e| mcp_oauth::McpOAuthError::DiscoveryFailed(e.to_string()))?;
    manager.set_metadata(resolution.metadata);
    let request = AuthorizationRequest::new(redirect_uri).with_client_name("Troupe");
    let session = AuthorizationSession::new(manager, request)
        .await
        .map_err(|(_manager, e)| mcp_oauth::McpOAuthError::RegistrationFailed(e.to_string()))?;
    let (auth_url, csrf_token) = remote_auth_url(session.get_authorization_url())?;
    Ok((auth_url, csrf_token, session))
}

fn remote_auth_url(raw: &str) -> Result<(String, String), mcp_oauth::McpOAuthError> {
    let auth_url =
        check_safe_url(raw, Opener::Remote).map_err(mcp_oauth::McpOAuthError::UnsafeUrl)?;
    let csrf_token = auth_url
        .query_pairs()
        .find_map(|(key, value)| (key == "state").then(|| value.into_owned()))
        .ok_or_else(|| {
            mcp_oauth::McpOAuthError::AuthUrlFailed(
                "authorization URL missing state parameter".to_string(),
            )
        })?;
    Ok((String::from(auth_url), csrf_token))
}

#[cfg(test)]
#[path = "mcp_oauth_api_tests.rs"]
mod tests;
