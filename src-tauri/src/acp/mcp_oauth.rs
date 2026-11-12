//! MCP OAuth 2.1 authorization flow (RFC 9728 + PKCE + dynamic registration).
//!
//! When an HTTP/SSE MCP server returns 401 with WWW-Authenticate: Bearer
//! resource_metadata="...", the rmcp client surfaces AuthRequiredError.
//! This module detects that, runs the full OAuth flow, and persists tokens
//! as JSON files in the app data directory (the Windows Credential Manager
//! has a 2560-char limit that OAuth JWTs routinely exceed).

use std::collections::HashMap;
use std::sync::LazyLock;

use parking_lot::Mutex;
use rmcp::transport::auth::{
    AuthorizationManager, AuthorizationSession, CredentialStore, InMemoryCredentialStore,
    OAuthTokenResponse, StoredCredentials,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const OAUTH_REDIRECT_PATH: &str = "/callback";
pub const OAUTH_FLOW_TIMEOUT_SECS: u64 = 300;

/// A web OAuth flow waiting for its authorization-server redirect, keyed by
/// its CSRF `state` in `AppState::pending_oauth_flows`. It holds the session
/// built at start, which carries the PKCE verifier and the registered client
/// id the code exchange needs.
pub struct PendingOAuthFlow {
    pub server_url: String,
    pub redirect_uri: String,
    pub session: AuthorizationSession,
    pub created_at: std::time::Instant,
}

impl PendingOAuthFlow {
    /// Whether the flow is older than [`OAUTH_FLOW_TIMEOUT_SECS`] at `now`.
    pub fn is_expired(&self, now: std::time::Instant) -> bool {
        now.saturating_duration_since(self.created_at).as_secs() >= OAUTH_FLOW_TIMEOUT_SECS
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredToken {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: Option<u64>,
    pub client_id: String,
    pub issuer: String,
    pub server_url: String,
}

#[derive(Debug)]
#[allow(dead_code)]
pub enum McpOAuthError {
    NotRequired,
    NoAuthorizationServers,
    DiscoveryFailed(String),
    RegistrationFailed(String),
    AuthUrlFailed(String),
    TokenExchangeFailed(String),
    /// The authorization server definitively rejected the refresh token
    /// (`invalid_grant`). No retry can succeed.
    RefreshRejected(String),
    Timeout,
    Keychain(String),
    Http(String),
    InvalidConfig(String),
    UnsafeUrl(crate::acp::safe_url::UnsafeUrl),
}

impl std::fmt::Display for McpOAuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotRequired => write!(f, "OAuth not required"),
            Self::NoAuthorizationServers => write!(f, "No authorization servers"),
            Self::DiscoveryFailed(m) => write!(f, "Discovery failed: {m}"),
            Self::RegistrationFailed(m) => write!(f, "Registration failed: {m}"),
            Self::AuthUrlFailed(m) => write!(f, "Auth URL failed: {m}"),
            Self::TokenExchangeFailed(m) => write!(f, "Token exchange failed: {m}"),
            Self::RefreshRejected(m) => write!(f, "Refresh token rejected: {m}"),
            Self::Timeout => write!(f, "OAuth timed out"),
            Self::Keychain(m) => write!(f, "Keychain: {m}"),
            Self::Http(m) => write!(f, "HTTP: {m}"),
            Self::InvalidConfig(m) => write!(f, "Invalid config: {m}"),
            Self::UnsafeUrl(refused) => write!(f, "{refused}"),
        }
    }
}

impl std::error::Error for McpOAuthError {}

#[allow(dead_code)]
fn keychain_key(server_url: &str) -> String {
    format!("mcp:{}", server_url.trim_end_matches('/'))
}

/// Per-server count of stored-token writes and deletes, keyed like the token
/// file. The MCP probe dedupe reads it so a probe that read the old token is
/// never joined after a sign-in or sign-out.
static TOKEN_GENERATIONS: LazyLock<Mutex<HashMap<String, u64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn token_generation(server_url: &str) -> u64 {
    TOKEN_GENERATIONS
        .lock()
        .get(server_url.trim_end_matches('/'))
        .copied()
        .unwrap_or(0)
}

fn bump_token_generation(server_url: &str) {
    *TOKEN_GENERATIONS
        .lock()
        .entry(server_url.trim_end_matches('/').to_string())
        .or_default() += 1;
}

pub fn load_stored_token(server_url: &str) -> Result<Option<StoredToken>, McpOAuthError> {
    let path = token_file_path(server_url)?;
    match std::fs::read_to_string(&path) {
        Ok(json) => {
            let token: StoredToken = serde_json::from_str(&json)
                .map_err(|e| McpOAuthError::Keychain(format!("parse: {e}")))?;
            Ok(Some(token))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(McpOAuthError::Keychain(format!("read: {e}"))),
    }
}

pub fn store_token(server_url: &str, token: &StoredToken) -> Result<(), McpOAuthError> {
    let path = token_file_path(server_url)?;
    let json = serde_json::to_string(token)
        .map_err(|e| McpOAuthError::Keychain(format!("serialize: {e}")))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| McpOAuthError::Keychain(format!("create dir: {e}")))?;
    }
    // Create the token file with owner-only permissions (0600) on Unix so
    // no other local account can read the bearer token. On non-Unix the
    // default ACL still restricts to the creating user under a typical
    // profile dir.
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)
            .map_err(|e| McpOAuthError::Keychain(format!("open: {e}")))?;
        file.write_all(json.as_bytes())
            .map_err(|e| McpOAuthError::Keychain(format!("write: {e}")))?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(&path, json).map_err(|e| McpOAuthError::Keychain(format!("write: {e}")))?;
    }
    bump_token_generation(server_url);
    Ok(())
}

pub fn delete_stored_token(server_url: &str) -> Result<(), McpOAuthError> {
    let path = token_file_path(server_url)?;
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(McpOAuthError::Keychain(format!("delete: {e}"))),
    }
    bump_token_generation(server_url);
    Ok(())
}

/// Resolve the file path for storing an OAuth token. Tokens are stored as
/// JSON files in the app's data directory under `mcp-oauth/`, keyed by a
/// hash of the server URL. This avoids the Windows Credential Manager's
/// 2560-character limit (OAuth JWT access tokens routinely exceed it).
fn token_file_path(server_url: &str) -> Result<std::path::PathBuf, McpOAuthError> {
    // Store tokens as JSON files under the app data dir (avoids the Windows
    // Credential Manager's 2560-char limit — OAuth JWTs routinely exceed it).
    // Uses the same env-var resolution as `web/config.rs` (LOCALAPPDATA on
    // Windows, XDG_STATE_HOME/HOME on Linux, HOME on macOS).
    // Hash the normalized URL with a version-stable digest so filenames do
    // not change across Rust releases (DefaultHasher has no stability
    // guarantee) and trailing-slash variants (`https://x/mcp` vs
    // `https://x/mcp/`) map to one file.
    use sha2::{Digest, Sha256};
    let normalized = server_url.trim_end_matches('/');
    let file = format!("{:x}.json", Sha256::digest(normalized.as_bytes()));
    #[cfg(test)]
    if let Some(dir) = tests::TOKEN_DIR_OVERRIDE.with(|dir| dir.borrow().clone()) {
        return Ok(dir.join(file));
    }
    let base = std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("XDG_STATE_HOME"))
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
        .ok_or_else(|| McpOAuthError::Keychain("no data dir env var".to_string()))?;
    let dir = base.join("com.termul-manager.app").join("mcp-oauth");
    Ok(dir.join(file))
}

pub fn is_token_expired(token: &StoredToken) -> bool {
    match token.expires_at {
        Some(exp) => {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            exp <= now + 60
        }
        None => false,
    }
}

/// Longest a caller waits for a token refresh before it continues without one.
const REFRESH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// One lock per normalized server URL, so a server that rotates refresh tokens
/// sees one refresh at a time. A second POST with the rotated-out token draws
/// `invalid_grant` and used to delete the fresh token.
static REFRESH_LOCKS: LazyLock<Mutex<HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn refresh_lock(server_url: &str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    REFRESH_LOCKS
        .lock()
        .entry(server_url.trim_end_matches('/').to_string())
        .or_default()
        .clone()
}

/// A usable access token for `server_url`, refreshing an expired one. Only a
/// definitive rejection of the refresh token deletes the stored token; a
/// connection error, a timeout or a server error keeps it for the next call
/// and the caller continues without a token.
pub async fn get_valid_token(server_url: &str) -> Result<Option<String>, McpOAuthError> {
    match load_stored_token(server_url)? {
        Some(t) if !is_token_expired(&t) => Ok(Some(t.access_token)),
        Some(t) if t.refresh_token.is_some() => {
            match tokio::time::timeout(REFRESH_TIMEOUT, refresh_expired(server_url)).await {
                Ok(result) => result,
                Err(_) => {
                    log::warn!("[mcp-oauth] token refresh timed out (url redacted)");
                    Ok(None)
                }
            }
        }
        Some(_) => {
            let _ = delete_stored_token(server_url);
            Ok(None)
        }
        None => Ok(None),
    }
}

async fn refresh_expired(server_url: &str) -> Result<Option<String>, McpOAuthError> {
    let lock = refresh_lock(server_url);
    let _guard = lock.lock().await;
    // A caller ahead in the queue may have refreshed or removed the token.
    let Some(stored) = load_stored_token(server_url)? else {
        return Ok(None);
    };
    if !is_token_expired(&stored) {
        return Ok(Some(stored.access_token));
    }
    match refresh_token(&stored).await {
        Ok(new) => {
            store_token(server_url, &new)?;
            log::info!("[mcp-oauth] expired token refreshed (url redacted)");
            Ok(Some(new.access_token))
        }
        Err(McpOAuthError::RefreshRejected(_)) => {
            log::warn!("[mcp-oauth] refresh token rejected, stored token removed (url redacted)");
            let _ = delete_stored_token(server_url);
            Ok(None)
        }
        Err(_) => {
            log::warn!("[mcp-oauth] token refresh failed, stored token kept (url redacted)");
            Ok(None)
        }
    }
}

async fn refresh_token(stored: &StoredToken) -> Result<StoredToken, McpOAuthError> {
    let mut manager = AuthorizationManager::new(&stored.issuer)
        .await
        .map_err(|e| McpOAuthError::DiscoveryFailed(e.to_string()))?;
    let resolution = manager
        .resolve_metadata()
        .await
        .map_err(|e| McpOAuthError::DiscoveryFailed(e.to_string()))?;
    manager.set_metadata(resolution.metadata);
    let config = rmcp::transport::auth::OAuthClientConfig::new(
        stored.client_id.clone(),
        "http://127.0.0.1/callback",
    );
    manager.configure_client(config).ok();
    // The manager refreshes from its credential store, which starts empty.
    let credentials: OAuthTokenResponse = serde_json::from_value(serde_json::json!({
        "access_token": stored.access_token,
        "token_type": "bearer",
        "refresh_token": stored.refresh_token,
    }))
    .map_err(|e| McpOAuthError::TokenExchangeFailed(format!("stored token: {e}")))?;
    let store = InMemoryCredentialStore::new();
    store
        .save(StoredCredentials::new(
            stored.client_id.clone(),
            Some(credentials),
            Vec::new(),
            None,
        ))
        .await
        .map_err(|e| McpOAuthError::TokenExchangeFailed(e.to_string()))?;
    manager.set_credential_store(store);
    let tr = manager.refresh_token().await.map_err(|e| match e {
        rmcp::transport::auth::AuthError::TokenRefreshRejected(m) => {
            McpOAuthError::RefreshRejected(m)
        }
        e => McpOAuthError::TokenExchangeFailed(e.to_string()),
    })?;
    use oauth2::TokenResponse;
    Ok(StoredToken {
        access_token: tr.access_token().secret().to_string(),
        refresh_token: tr
            .refresh_token()
            .map(|t| t.secret().to_string())
            .or_else(|| stored.refresh_token.clone()),
        expires_at: tr
            .expires_in()
            .map(|d| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|n| n.as_secs() + d.as_secs())
                    .unwrap_or(0)
            })
            .or(stored.expires_at),
        client_id: stored.client_id.clone(),
        issuer: stored.issuer.clone(),
        server_url: stored.server_url.clone(),
    })
}

/// Exchange an authorization code with the session that built the
/// authorization URL (same PKCE verifier and client id), validate the RFC 9207
/// `iss` when given, and persist the resulting token for `server_url`.
pub async fn finish_session(
    server_url: &str,
    session: AuthorizationSession,
    code: &str,
    csrf_token: &str,
    issuer: Option<&str>,
) -> Result<StoredToken, McpOAuthError> {
    use oauth2::TokenResponse;
    session
        .handle_callback_with_issuer(code, csrf_token, issuer)
        .await
        .map_err(|e| McpOAuthError::TokenExchangeFailed(e.to_string()))?;
    let manager = &session.auth_manager;
    let access_token = manager
        .get_access_token()
        .await
        .map_err(|e| McpOAuthError::TokenExchangeFailed(format!("access token: {e}")))?;
    let (client_id, token_response) = manager
        .get_credentials()
        .await
        .map_err(|e| McpOAuthError::TokenExchangeFailed(format!("credentials: {e}")))?;
    let refresh_token = token_response
        .as_ref()
        .and_then(|tr| tr.refresh_token().map(|t| t.secret().to_string()));
    let expires_at = token_response
        .as_ref()
        .and_then(|tr| tr.expires_in())
        .map(|d| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|n| n.as_secs() + d.as_secs())
                .unwrap_or(0)
        });
    let stored = StoredToken {
        access_token,
        refresh_token,
        expires_at,
        client_id,
        issuer: server_url.to_string(),
        server_url: server_url.to_string(),
    };
    store_token(server_url, &stored)?;
    Ok(stored)
}

#[allow(dead_code)]
struct KeychainCredentialStore {
    server_url: String,
}

#[allow(dead_code)]
impl KeychainCredentialStore {
    fn new(server_url: &str) -> Self {
        Self {
            server_url: server_url.to_string(),
        }
    }
}

#[async_trait::async_trait]
impl CredentialStore for KeychainCredentialStore {
    async fn load(&self) -> Result<Option<StoredCredentials>, rmcp::transport::auth::AuthError> {
        match load_stored_token(&self.server_url) {
            Ok(Some(t)) => Ok(Some(StoredCredentials::new(
                t.client_id,
                None,
                vec![],
                None,
            ))),
            Ok(None) => Ok(None),
            Err(e) => Err(rmcp::transport::auth::AuthError::InternalError(
                e.to_string(),
            )),
        }
    }
    async fn save(&self, _: StoredCredentials) -> Result<(), rmcp::transport::auth::AuthError> {
        Ok(())
    }
    async fn clear(&self) -> Result<(), rmcp::transport::auth::AuthError> {
        let _ = delete_stored_token(&self.server_url);
        Ok(())
    }
}

#[allow(dead_code)]
pub async fn fetch_resource_metadata(header: &str) -> Result<Option<Value>, McpOAuthError> {
    match extract_resource_metadata_url(header) {
        Some(url) => {
            let resp = reqwest::Client::new()
                .get(&url)
                .timeout(std::time::Duration::from_secs(10))
                .send()
                .await
                .map_err(|e| McpOAuthError::Http(e.to_string()))?;
            let json: Value = resp
                .json()
                .await
                .map_err(|e| McpOAuthError::Http(e.to_string()))?;
            Ok(Some(json))
        }
        None => Ok(None),
    }
}

#[allow(dead_code)]
pub fn extract_resource_metadata_url(header: &str) -> Option<String> {
    let marker = "resource_metadata=\"";
    if let Some(start) = header.find(marker) {
        let rest = &header[start + marker.len()..];
        if let Some(end) = rest.find('"') {
            return Some(rest[..end].to_string());
        }
    }
    let marker = "resource_metadata=";
    if let Some(start) = header.find(marker) {
        let rest = &header[start + marker.len()..];
        let end = rest.find(|c: char| c.is_whitespace()).unwrap_or(rest.len());
        let url = &rest[..end];
        if !url.is_empty() && url != "Bearer" {
            return Some(url.to_string());
        }
    }
    None
}

pub fn is_auth_required(header: &str) -> bool {
    let l = header.to_ascii_lowercase();
    l.contains("bearer")
        && (l.contains("resource_metadata") || l.contains("realm") || l.contains("error"))
}

pub fn bearer_header(token: &str) -> String {
    token.to_string()
}

#[cfg(test)]
pub(crate) mod tests;
