//! MCP OAuth 2.1 authorization flow (RFC 9728 + PKCE + dynamic registration).
//!
//! When an HTTP/SSE MCP server returns 401 with WWW-Authenticate: Bearer
//! resource_metadata="...", the rmcp client surfaces AuthRequiredError.
//! This module detects that, runs the full OAuth flow, and persists tokens
//! as JSON files in the app data directory (the Windows Credential Manager
//! has a 2560-char limit that OAuth JWTs routinely exceed).

use rmcp::transport::auth::{
    AuthorizationCallback, AuthorizationManager, AuthorizationSession, CredentialStore,
    OAuthState, StoredCredentials,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const OAUTH_REDIRECT_PATH: &str = "/callback";
pub const OAUTH_FLOW_TIMEOUT_SECS: u64 = 300;

#[derive(Debug, Clone)]
pub struct PendingOAuthFlow {
    pub server_url: String,
    pub redirect_uri: String,
    pub csrf_token: String,
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
    Timeout,
    Keychain(String),
    Http(String),
    InvalidConfig(String),
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
            Self::Timeout => write!(f, "OAuth timed out"),
            Self::Keychain(m) => write!(f, "Keychain: {m}"),
            Self::Http(m) => write!(f, "HTTP: {m}"),
            Self::InvalidConfig(m) => write!(f, "Invalid config: {m}"),
        }
    }
}

impl std::error::Error for McpOAuthError {}

#[allow(dead_code)]
fn keychain_key(server_url: &str) -> String {
    format!("mcp:{}", server_url.trim_end_matches('/'))
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
            .map_err(|e| McpOAuthError::Keychain(format!("write: {e}")))
    }
    #[cfg(not(unix))]
    {
        std::fs::write(&path, json)
            .map_err(|e| McpOAuthError::Keychain(format!("write: {e}")))
    }
}

pub fn delete_stored_token(server_url: &str) -> Result<(), McpOAuthError> {
    let path = token_file_path(server_url)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(McpOAuthError::Keychain(format!("delete: {e}"))),
    }
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
    let base = std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("XDG_STATE_HOME"))
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
        .ok_or_else(|| McpOAuthError::Keychain("no data dir env var".to_string()))?;
    let dir = base.join("com.termul-manager.app").join("mcp-oauth");
    // Hash the normalized URL with a version-stable digest so filenames do
    // not change across Rust releases (DefaultHasher has no stability
    // guarantee) and trailing-slash variants (`https://x/mcp` vs
    // `https://x/mcp/`) map to one file.
    use sha2::{Digest, Sha256};
    let normalized = server_url.trim_end_matches('/');
    let hash = format!("{:x}", Sha256::digest(normalized.as_bytes()));
    Ok(dir.join(format!("{hash}.json")))
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

pub async fn get_valid_token(server_url: &str) -> Result<Option<String>, McpOAuthError> {
    let stored = load_stored_token(server_url)?;
    match stored {
        Some(t) if !is_token_expired(&t) => Ok(Some(t.access_token)),
        Some(t) if t.refresh_token.is_some() => match refresh_token(&t).await {
            Ok(new) => {
                store_token(server_url, &new)?;
                Ok(Some(new.access_token))
            }
            Err(_) => {
                let _ = delete_stored_token(server_url);
                Ok(None)
            }
        },
        Some(_) => {
            let _ = delete_stored_token(server_url);
            Ok(None)
        }
        None => Ok(None),
    }
}

/// Blocking variant of `get_valid_token` — loads the token from the file
/// without async. Used by `inject_oauth_tokens` which is called from a sync
/// context (session/new injection must not block the runtime).
pub fn get_valid_token_blocking(server_url: &str) -> Result<Option<String>, McpOAuthError> {
    let stored = load_stored_token(server_url)?;
    match stored {
        Some(token) if !is_token_expired(&token) => Ok(Some(token.access_token)),
        Some(token) if token.refresh_token.is_some() => {
            log::info!("[mcp-oauth] token expired for server (url redacted)");
            let _ = delete_stored_token(server_url);
            Ok(None)
        }
        Some(_) => {
            let _ = delete_stored_token(server_url);
            Ok(None)
        }
        None => Ok(None),
    }
}

async fn refresh_token(stored: &StoredToken) -> Result<StoredToken, McpOAuthError> {
    let mut manager = AuthorizationManager::new(&stored.issuer)
        .await
        .map_err(|e| McpOAuthError::DiscoveryFailed(e.to_string()))?;
    let metadata = manager
        .discover_metadata()
        .await
        .map_err(|e| McpOAuthError::DiscoveryFailed(e.to_string()))?;
    manager.set_metadata(metadata);
    let config = rmcp::transport::auth::OAuthClientConfig::new(
        stored.client_id.clone(),
        "http://127.0.0.1/callback",
    );
    manager.configure_client(config).ok();
    let tr = manager
        .refresh_token()
        .await
        .map_err(|e| McpOAuthError::TokenExchangeFailed(e.to_string()))?;
    use oauth2::TokenResponse;
    Ok(StoredToken {
        access_token: tr.access_token().secret().to_string(),
        refresh_token: tr.refresh_token().map(|t| t.secret().to_string()).or_else(|| stored.refresh_token.clone()),
        expires_at: tr.expires_in().map(|d| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|n| n.as_secs() + d.as_secs()).unwrap_or(0)).or(stored.expires_at),
        client_id: stored.client_id.clone(),
        issuer: stored.issuer.clone(),
        server_url: stored.server_url.clone(),
    })
}

pub async fn run_full_flow(server_url: &str, redirect_uri: &str, callback_url: String) -> Result<StoredToken, McpOAuthError> {
    let mut manager = AuthorizationManager::new(server_url)
        .await
        .map_err(|e| McpOAuthError::DiscoveryFailed(e.to_string()))?;
    let metadata = manager.discover_metadata().await
        .map_err(|e| McpOAuthError::DiscoveryFailed(e.to_string()))?;
    manager.set_metadata(metadata);
    let session = AuthorizationSession::new(manager, &[], redirect_uri, Some("Termul"), None)
        .await
        .map_err(|e| McpOAuthError::RegistrationFailed(e.to_string()))?;
    let callback = AuthorizationCallback::from_redirect_url(&callback_url)
        .map_err(|e| McpOAuthError::TokenExchangeFailed(format!("callback: {e}")))?;
    let mut state = OAuthState::Session(session);
    state.handle_callback(&callback.code, &callback.csrf_token).await
        .map_err(|e| McpOAuthError::TokenExchangeFailed(e.to_string()))?;
    let access_token = state.get_access_token().await
        .map_err(|e| McpOAuthError::TokenExchangeFailed(e.to_string()))?;
    let (client_id, refresh_token, expires_at) = match &state {
        OAuthState::Session(s) => {
            let c = s.auth_manager.get_credentials().await
                .map_err(|e| McpOAuthError::TokenExchangeFailed(e.to_string()))?;
            let refresh = c.1.as_ref().and_then(|tr| {
                use oauth2::TokenResponse;
                tr.refresh_token().map(|t| t.secret().to_string())
            });
            let exp = c.1.as_ref().and_then(|tr| {
                use oauth2::TokenResponse;
                tr.expires_in().map(|d| {
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|n| n.as_secs() + d.as_secs())
                        .unwrap_or(0)
                })
            });
            (c.0, refresh, exp)
        }
        OAuthState::Unauthorized(m) | OAuthState::Authorized(m) => {
            let c = m.get_credentials().await
                .map_err(|e| McpOAuthError::TokenExchangeFailed(e.to_string()))?;
            let refresh = c.1.as_ref().and_then(|tr| {
                use oauth2::TokenResponse;
                tr.refresh_token().map(|t| t.secret().to_string())
            });
            let exp = c.1.as_ref().and_then(|tr| {
                use oauth2::TokenResponse;
                tr.expires_in().map(|d| {
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|n| n.as_secs() + d.as_secs())
                        .unwrap_or(0)
                })
            });
            (c.0, refresh, exp)
        }
        _ => (String::new(), None, None),
    };
    let stored = StoredToken {
        access_token,
        refresh_token,
        expires_at,
        client_id,
        issuer: server_url.to_string(),
        server_url: server_url.to_string(),
    };
    store_token(server_url, &stored)?;
    log::info!("[mcp-oauth] token stored (url redacted), expires: {:?}", stored.expires_at);
    Ok(stored)
}
#[allow(dead_code)]
struct KeychainCredentialStore { server_url: String }

#[allow(dead_code)]
impl KeychainCredentialStore {
    fn new(server_url: &str) -> Self { Self { server_url: server_url.to_string() } }
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
            Err(e) => Err(rmcp::transport::auth::AuthError::InternalError(e.to_string())),
        }
    }
    async fn save(&self, _: StoredCredentials) -> Result<(), rmcp::transport::auth::AuthError> { Ok(()) }
    async fn clear(&self) -> Result<(), rmcp::transport::auth::AuthError> {
        let _ = delete_stored_token(&self.server_url);
        Ok(())
    }
}

#[allow(dead_code)]
pub async fn fetch_resource_metadata(header: &str) -> Result<Option<Value>, McpOAuthError> {
    match extract_resource_metadata_url(header) {
        Some(url) => {
            let resp = reqwest::Client::new().get(&url)
                .timeout(std::time::Duration::from_secs(10)).send().await
                .map_err(|e| McpOAuthError::Http(e.to_string()))?;
            let json: Value = resp.json().await
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
        if let Some(end) = rest.find('"') { return Some(rest[..end].to_string()); }
    }
    let marker = "resource_metadata=";
    if let Some(start) = header.find(marker) {
        let rest = &header[start + marker.len()..];
        let end = rest.find(|c: char| c.is_whitespace()).unwrap_or(rest.len());
        let url = &rest[..end];
        if !url.is_empty() && url != "Bearer" { return Some(url.to_string()); }
    }
    None
}


pub fn is_auth_required(header: &str) -> bool {
    let l = header.to_ascii_lowercase();
    l.contains("bearer") && (l.contains("resource_metadata") || l.contains("realm") || l.contains("error"))
}

pub fn bearer_header(token: &str) -> String { token.to_string() }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn extract_quoted() {
        let h = r#"Bearer resource_metadata="https://x.test/.well-known/oauth-protected-resource""#;
        assert_eq!(extract_resource_metadata_url(h), Some("https://x.test/.well-known/oauth-protected-resource".into()));
    }
    #[test]
    fn extract_missing() { assert!(extract_resource_metadata_url("Bearer realm=\"t\"").is_none()); }
    #[test]
    fn auth_required() {
        assert!(is_auth_required(r#"Bearer resource_metadata="https://x""#));
        assert!(is_auth_required(r#"Bearer error="invalid_token""#));
        assert!(!is_auth_required("Basic realm=\"t\""));
        assert!(!is_auth_required(""));
    }
    #[test]
    fn key_normalizes() {
        assert_eq!(keychain_key("https://x/mcp"), keychain_key("https://x/mcp/"));
    }
    #[test]
    fn expiry() {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
        assert!(is_token_expired(&StoredToken { access_token: "x".into(), refresh_token: None, expires_at: Some(now - 1), client_id: "c".into(), issuer: "i".into(), server_url: "u".into() }));
        assert!(!is_token_expired(&StoredToken { access_token: "x".into(), refresh_token: None, expires_at: Some(now + 3600), client_id: "c".into(), issuer: "i".into(), server_url: "u".into() }));
        assert!(!is_token_expired(&StoredToken { access_token: "x".into(), refresh_token: None, expires_at: None, client_id: "c".into(), issuer: "i".into(), server_url: "u".into() }));
    }

    #[test]
    fn token_file_path_normalizes_trailing_slash() {
        // Equivalent URLs (differing only by a trailing slash) MUST produce
        // the same token file path so a probe and a connect that differ only
        // by the trailing slash reuse the same stored token.
        let a = token_file_path("https://x/mcp").unwrap();
        let b = token_file_path("https://x/mcp/").unwrap();
        assert_eq!(a, b, "trailing slash must normalize to the same file");
    }

    #[test]
    fn expired_token_with_refresh_is_treatable_as_expired() {
        // A token that is already expired and has a refresh_token must be
        // reported as expired so `get_valid_token` attempts a refresh. This
        // is the precondition for the refresh path being reachable at all.
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let expired = StoredToken {
            access_token: "x".into(),
            refresh_token: Some("r".into()),
            expires_at: Some(now - 1),
            client_id: "c".into(),
            issuer: "i".into(),
            server_url: "u".into(),
        };
        assert!(is_token_expired(&expired));
    }
}
