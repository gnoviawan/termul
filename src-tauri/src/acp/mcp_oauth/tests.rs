use super::*;
#[test]
fn extract_quoted() {
    let h = r#"Bearer resource_metadata="https://x.test/.well-known/oauth-protected-resource""#;
    assert_eq!(
        extract_resource_metadata_url(h),
        Some("https://x.test/.well-known/oauth-protected-resource".into())
    );
}
#[test]
fn extract_missing() {
    assert!(extract_resource_metadata_url("Bearer realm=\"t\"").is_none());
}
#[test]
fn auth_required() {
    assert!(is_auth_required(r#"Bearer resource_metadata="https://x""#));
    assert!(is_auth_required(r#"Bearer error="invalid_token""#));
    assert!(!is_auth_required("Basic realm=\"t\""));
    assert!(!is_auth_required(""));
}
#[test]
fn key_normalizes() {
    assert_eq!(
        keychain_key("https://x/mcp"),
        keychain_key("https://x/mcp/")
    );
}
#[test]
fn expiry() {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    assert!(is_token_expired(&StoredToken {
        access_token: "x".into(),
        refresh_token: None,
        expires_at: Some(now - 1),
        client_id: "c".into(),
        issuer: "i".into(),
        server_url: "u".into()
    }));
    assert!(!is_token_expired(&StoredToken {
        access_token: "x".into(),
        refresh_token: None,
        expires_at: Some(now + 3600),
        client_id: "c".into(),
        issuer: "i".into(),
        server_url: "u".into()
    }));
    assert!(!is_token_expired(&StoredToken {
        access_token: "x".into(),
        refresh_token: None,
        expires_at: None,
        client_id: "c".into(),
        issuer: "i".into(),
        server_url: "u".into()
    }));
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

thread_local! {
    /// Test-only token directory for this thread. `token_file_path` uses it
    /// instead of the real store, so a test that sets it (through
    /// [`TokenDirGuard`]) never touches the user's tokens. Thread-local, not
    /// an env var, so parallel tests that read the env stay unaffected; a
    /// `#[tokio::test]` runtime and the tasks it spawns share one thread.
    pub(crate) static TOKEN_DIR_OVERRIDE: std::cell::RefCell<Option<std::path::PathBuf>> =
        const { std::cell::RefCell::new(None) };
}

/// Points this thread's token store at a fresh temp dir until dropped.
pub(crate) struct TokenDirGuard(std::path::PathBuf);

impl TokenDirGuard {
    pub(crate) fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "termul-mcp-oauth-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        TOKEN_DIR_OVERRIDE.with(|slot| *slot.borrow_mut() = Some(dir.clone()));
        Self(dir)
    }
}

impl Drop for TokenDirGuard {
    fn drop(&mut self) {
        TOKEN_DIR_OVERRIDE.with(|slot| *slot.borrow_mut() = None);
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// An MCP server that publishes no OAuth metadata, so a client falls back to
/// its legacy `/token` and `/register` endpoints. Answers every token request
/// with `body` and records the form bodies it received; each registration
/// gets the next client id (`client-1`, `client-2`, ...).
pub(crate) async fn serve_token_endpoint(
    body: serde_json::Value,
) -> (String, std::sync::Arc<Mutex<Vec<String>>>) {
    serve_token_endpoint_with_status(body, axum::http::StatusCode::OK).await
}

/// Like [`serve_token_endpoint`] but answers with `status`, so a test can drive
/// the error path (400 + `invalid_grant` is a rejected refresh).
pub(crate) async fn serve_token_endpoint_with_status(
    body: serde_json::Value,
    status: axum::http::StatusCode,
) -> (String, std::sync::Arc<Mutex<Vec<String>>>) {
    let requests = std::sync::Arc::new(Mutex::new(Vec::new()));
    let seen = requests.clone();
    let registrations = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let app = axum::Router::new()
        .route(
            "/token",
            axum::routing::post(move |form: String| {
                let seen = seen.clone();
                let body = body.clone();
                async move {
                    seen.lock().push(form);
                    (status, axum::Json(body))
                }
            }),
        )
        .route(
            "/register",
            axum::routing::post(move |axum::Json(request): axum::Json<serde_json::Value>| {
                let n = registrations.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                async move {
                    axum::Json(serde_json::json!({
                        "client_id": format!("client-{n}"),
                        "redirect_uris": request["redirect_uris"],
                    }))
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (url, requests)
}

pub(crate) fn expired_token_with_refresh(url: &str) -> StoredToken {
    StoredToken {
        access_token: "stale-access".into(),
        refresh_token: Some("stored-refresh".into()),
        expires_at: Some(1),
        client_id: "termul-client".into(),
        issuer: url.into(),
        server_url: url.into(),
    }
}

/// Issue #1345: an expired token that has a refresh token is refreshed at the
/// token endpoint and stored, not deleted.
#[tokio::test]
async fn expired_token_with_refresh_token_is_refreshed() {
    let (url, requests) = serve_token_endpoint(serde_json::json!({
        "access_token": "fresh-access",
        "token_type": "Bearer",
        "expires_in": 3600,
    }))
    .await;
    store_token(&url, &expired_token_with_refresh(&url)).unwrap();
    let generation = token_generation(&url);

    let token = get_valid_token(&url).await;
    let stored = load_stored_token(&url).unwrap();
    let refreshed_generation = token_generation(&url);
    delete_stored_token(&url).unwrap();

    assert_eq!(token.unwrap().as_deref(), Some("fresh-access"));
    assert_eq!(refreshed_generation, generation + 1);
    let stored = stored.expect("the refreshed token is stored");
    assert_eq!(stored.access_token, "fresh-access");
    assert_eq!(stored.refresh_token.as_deref(), Some("stored-refresh"));
    let requests = requests.lock();
    assert_eq!(requests.len(), 1);
    assert!(
        requests[0].contains("grant_type=refresh_token")
            && requests[0].contains("refresh_token=stored-refresh"),
        "{}",
        requests[0]
    );
}

/// Issue #1364: two concurrent `get_valid_token` calls share one refresh
/// against a server that rotates refresh tokens. One `/token` POST goes out and
/// both callers get the new access token. A second POST would send the rotated
/// refresh token, draw `invalid_grant` on a real server, and delete the fresh
/// token.
#[tokio::test]
async fn concurrent_get_valid_token_calls_share_one_refresh() {
    let _tokens = TokenDirGuard::new("single-flight");
    let (url, requests) = serve_token_endpoint(serde_json::json!({
        "access_token": "fresh-access",
        "token_type": "Bearer",
        "refresh_token": "rotated-refresh",
        "expires_in": 3600,
    }))
    .await;
    store_token(&url, &expired_token_with_refresh(&url)).unwrap();

    let (first, second) = tokio::join!(get_valid_token(&url), get_valid_token(&url));

    assert_eq!(first.unwrap().as_deref(), Some("fresh-access"));
    assert_eq!(second.unwrap().as_deref(), Some("fresh-access"));
    assert_eq!(requests.lock().len(), 1);
    let stored = load_stored_token(&url).unwrap().expect("token kept");
    assert_eq!(stored.refresh_token.as_deref(), Some("rotated-refresh"));
}

/// Issue #1364: a refresh that fails on a connection error keeps the stored
/// token so the next call can retry. The chat continues without it.
#[tokio::test]
async fn refresh_connection_error_keeps_stored_token() {
    let _tokens = TokenDirGuard::new("conn-error");
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    drop(listener);
    store_token(&url, &expired_token_with_refresh(&url)).unwrap();

    let token = get_valid_token(&url).await;

    assert_eq!(token.unwrap(), None);
    assert!(
        load_stored_token(&url).unwrap().is_some(),
        "a connection error must keep the token"
    );
}

/// Issue #1364: a refresh that outlives [`REFRESH_TIMEOUT`] keeps the stored
/// token and returns no token instead of pinning the caller.
#[tokio::test(start_paused = true)]
async fn refresh_timeout_keeps_stored_token() {
    let _tokens = TokenDirGuard::new("timeout");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((socket, _)) = listener.accept().await {
            held.push(socket);
        }
    });
    store_token(&url, &expired_token_with_refresh(&url)).unwrap();

    let token = get_valid_token(&url).await;

    assert_eq!(token.unwrap(), None);
    assert!(
        load_stored_token(&url).unwrap().is_some(),
        "a timeout must keep the token"
    );
}

/// Issue #1364: the one failure that still deletes. The authorization server
/// rejects the refresh token outright (`invalid_grant`).
#[tokio::test]
async fn rejected_refresh_deletes_stored_token() {
    let _tokens = TokenDirGuard::new("rejected");
    let (url, _requests) = serve_token_endpoint_with_status(
        serde_json::json!({
            "error": "invalid_grant",
            "error_description": "refresh token revoked",
        }),
        axum::http::StatusCode::BAD_REQUEST,
    )
    .await;
    store_token(&url, &expired_token_with_refresh(&url)).unwrap();

    let token = get_valid_token(&url).await;

    assert_eq!(token.unwrap(), None);
    assert!(load_stored_token(&url).unwrap().is_none());
}
