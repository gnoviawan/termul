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

const REDIRECT: &str = "http://127.0.0.1:8080/oauth/callback";

async fn pending_flow(created_at: Instant) -> mcp_oauth::PendingOAuthFlow {
    let manager = rmcp::transport::auth::AuthorizationManager::new("https://mcp.example.com/mcp")
        .await
        .unwrap();
    mcp_oauth::PendingOAuthFlow {
        server_url: "https://mcp.example.com/mcp".to_string(),
        redirect_uri: REDIRECT.to_string(),
        session: AuthorizationSession::for_scope_upgrade(
            manager,
            "https://auth.example.com/authorize?state=s1".to_string(),
            REDIRECT,
        ),
        created_at,
    }
}

async fn flows_with(state: &str, created_at: Instant) -> PendingFlows {
    let mut flows = PendingFlows::new();
    flows.insert(state.to_string(), pending_flow(created_at).await);
    flows
}

fn claim_pasted(flows: &mut PendingFlows, pasted: &str) -> Result<ClaimedFlow, CompleteError> {
    let url = Url::parse(pasted).unwrap();
    claim_flow(
        flows,
        OAuthCallbackQuery::from_url(&url),
        Some(&url),
        Instant::now(),
    )
}

#[tokio::test]
async fn pasted_redirect_claims_its_flow_with_code_state_and_issuer() {
    let mut flows = flows_with("s1", Instant::now()).await;
    let claimed = claim_pasted(
        &mut flows,
        "http://127.0.0.1:8080/oauth/callback?code=c%2B1&state=s1&iss=https%3A%2F%2Fauth.example.com",
    )
    .unwrap_or_else(|e| panic!("claim failed: {e:?}"));
    assert_eq!(claimed.code, "c+1");
    assert_eq!(claimed.csrf_token, "s1");
    assert_eq!(claimed.iss.as_deref(), Some("https://auth.example.com"));
    assert_eq!(claimed.flow.server_url, "https://mcp.example.com/mcp");
    assert!(flows.is_empty(), "a claimed flow leaves the map");
}

#[tokio::test]
async fn pasted_address_off_the_redirect_endpoint_is_refused_and_the_flow_kept() {
    let mut flows = flows_with("s1", Instant::now()).await;
    for pasted in [
        "https://127.0.0.1:8080/oauth/callback?code=c&state=s1",
        "http://localhost:8080/oauth/callback?code=c&state=s1",
        "http://127.0.0.1:9090/oauth/callback?code=c&state=s1",
        "http://127.0.0.1:8080/oauth/other?code=c&state=s1",
        "http://evil.example.com/oauth/callback?code=c&state=s1",
    ] {
        let error = claim_pasted(&mut flows, pasted).err().unwrap();
        assert_eq!(error.code(), "OAUTH_BAD_REDIRECT", "{pasted}");
        assert_eq!(error.status(), StatusCode::BAD_REQUEST, "{pasted}");
    }
    let error = claim_pasted(&mut flows, "http://127.0.0.1:8080/oauth/callback?code=c")
        .err()
        .unwrap();
    assert_eq!(error.code(), "OAUTH_BAD_REDIRECT");
    let error = claim_pasted(&mut flows, "http://127.0.0.1:8080/oauth/callback?state=s1")
        .err()
        .unwrap();
    assert_eq!(error.code(), "OAUTH_BAD_REDIRECT");
    assert!(
        flows.contains_key("s1"),
        "a bad paste keeps the flow for a retry"
    );
}

#[tokio::test]
async fn denied_consent_reports_the_provider_error_and_drops_the_flow() {
    let mut flows = flows_with("s1", Instant::now()).await;
    let error = claim_pasted(
        &mut flows,
        "http://127.0.0.1:8080/oauth/callback?error=access_denied&error_description=User+said+no&state=s1",
    )
    .err()
    .unwrap();
    assert_eq!(error, CompleteError::Denied("User said no".to_string()));
    assert_eq!(error.code(), "OAUTH_DENIED");
    assert!(flows.is_empty());

    let mut flows = flows_with("s2", Instant::now()).await;
    let error = claim_pasted(
        &mut flows,
        "http://127.0.0.1:8080/oauth/callback?error=access_denied&state=s2",
    )
    .err()
    .unwrap();
    assert_eq!(error, CompleteError::Denied("access_denied".to_string()));
}

#[tokio::test]
async fn unknown_or_expired_state_is_refused() {
    let mut flows = flows_with("s1", Instant::now()).await;
    let error = claim_pasted(
        &mut flows,
        "http://127.0.0.1:8080/oauth/callback?code=c&state=other",
    )
    .err()
    .unwrap();
    assert_eq!(error, CompleteError::UnknownState);
    assert_eq!(error.code(), "OAUTH_UNKNOWN_STATE");

    let stale =
        Instant::now() - std::time::Duration::from_secs(mcp_oauth::OAUTH_FLOW_TIMEOUT_SECS + 1);
    let mut flows = flows_with("s1", stale).await;
    let error = claim_pasted(
        &mut flows,
        "http://127.0.0.1:8080/oauth/callback?code=c&state=s1",
    )
    .err()
    .unwrap();
    assert_eq!(error, CompleteError::UnknownState);
    assert!(flows.is_empty(), "expired flows are pruned");
}

#[tokio::test]
async fn direct_callback_skips_the_redirect_match() {
    let mut flows = flows_with("s1", Instant::now()).await;
    let query = OAuthCallbackQuery {
        code: Some("c".to_string()),
        state: Some("s1".to_string()),
        ..Default::default()
    };
    let claimed = claim_flow(&mut flows, query, None, Instant::now())
        .unwrap_or_else(|e| panic!("claim failed: {e:?}"));
    assert_eq!(claimed.code, "c");
    assert_eq!(claimed.iss, None);
}

fn test_state() -> AppState {
    use crate::acp::AcpManager;
    use crate::web::sink::WsRelaySink;
    use std::sync::Arc;
    let pty = crate::web::test_pty_manager();
    AppState {
        acp: Arc::new(AcpManager::new(vec![])),
        terminal_events: pty.terminal_events(),
        cwd_tracker: pty.cwd_tracker(),
        git_tracker: pty.git_tracker(),
        exit_code_tracker: pty.exit_code_tracker(),
        pty,
        relay: Arc::new(WsRelaySink::new()),
        registry: crate::web::project_registry::ProjectRegistry::seeded_for_test(
            &std::env::temp_dir(),
        ),
        history_mode: crate::web::ws::HistoryMode::LiveOnly,
        acp_catalog: None,
        acp_install: None,
        store: None,
        web_auth: None,
        allow_remote_writes: false,
        shared_live_writes_denied: false,
        pending_oauth_flows: Arc::new(parking_lot::RwLock::new(HashMap::new())),
        oauth_base_url: "http://127.0.0.1:8080".to_string(),
        connections: Default::default(),
        server_admin: None,
    }
}

async fn complete(
    state: &AppState,
    project_id: &str,
    callback_url: &str,
) -> (StatusCode, IpcBody<()>) {
    complete_from(
        state,
        SocketAddr::from(([127, 0, 0, 1], 54321)),
        project_id,
        callback_url,
    )
    .await
}

async fn complete_from(
    state: &AppState,
    peer: SocketAddr,
    project_id: &str,
    callback_url: &str,
) -> (StatusCode, IpcBody<()>) {
    let (status, Json(body)) = oauth_complete(
        State(state.clone()),
        ConnectInfo(peer),
        Json(OAuthCompleteRequest {
            project_id: project_id.to_string(),
            callback_url: callback_url.to_string(),
        }),
    )
    .await;
    (status, body)
}

#[tokio::test]
async fn complete_route_answers_each_refusal_with_its_code() {
    let state = test_state();
    let flow = pending_flow(Instant::now()).await;
    state
        .pending_oauth_flows
        .write()
        .insert("s1".to_string(), flow);
    let project = crate::web::project_registry::SEEDED_PROJECT_ID;

    let (status, body) = complete(&state, project, "not a url").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body.code.as_deref(), Some("OAUTH_BAD_REDIRECT"));

    let (status, body) = complete(
        &state,
        project,
        "http://127.0.0.1:8080/oauth/callback?code=c&state=nope",
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body.code.as_deref(), Some("OAUTH_UNKNOWN_STATE"));

    let (_, body) = complete(
        &state,
        "no-such-project",
        "http://127.0.0.1:8080/oauth/callback?code=c&state=s1",
    )
    .await;
    assert_eq!(body.code.as_deref(), Some("NOT_FOUND"));
    assert!(state.pending_oauth_flows.read().contains_key("s1"));

    let (status, body) = complete(
        &state,
        project,
        "http://127.0.0.1:8080/oauth/callback?error=access_denied&state=s1",
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(!body.success);
    assert_eq!(body.code.as_deref(), Some("OAUTH_DENIED"));
    assert_eq!(body.error.as_deref(), Some("access_denied"));
    assert!(state.pending_oauth_flows.read().is_empty());
}

#[tokio::test]
async fn failed_exchange_drops_the_flow_and_reports_it() {
    let state = test_state();
    let flow = pending_flow(Instant::now()).await;
    state
        .pending_oauth_flows
        .write()
        .insert("s1".to_string(), flow);
    let (status, body) = complete(
        &state,
        crate::web::project_registry::SEEDED_PROJECT_ID,
        "http://127.0.0.1:8080/oauth/callback?code=c&state=s1",
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(body.code.as_deref(), Some("OAUTH_EXCHANGE_FAILED"));
    assert!(state.pending_oauth_flows.read().is_empty());
}

#[tokio::test]
async fn complete_is_refused_to_a_remote_peer_and_in_shared_live_mode() {
    let pasted = "http://127.0.0.1:8080/oauth/callback?code=c&state=s1";
    let project = crate::web::project_registry::SEEDED_PROJECT_ID;

    let state = test_state();
    let flow = pending_flow(Instant::now()).await;
    state
        .pending_oauth_flows
        .write()
        .insert("s1".to_string(), flow);
    let remote = SocketAddr::from(([192, 168, 1, 50], 40000));
    let (_, body) = complete_from(&state, remote, project, pasted).await;
    assert!(!body.success, "a remote peer must be refused");
    assert_eq!(body.code.as_deref(), Some("FORBIDDEN"));
    assert!(state.pending_oauth_flows.read().contains_key("s1"));

    let mut state = test_state();
    state.shared_live_writes_denied = true;
    let flow = pending_flow(Instant::now()).await;
    state
        .pending_oauth_flows
        .write()
        .insert("s1".to_string(), flow);
    let (_, body) = complete(&state, project, pasted).await;
    assert!(
        !body.success,
        "shared-live must refuse even a loopback peer"
    );
    assert_eq!(body.code.as_deref(), Some("FORBIDDEN"));
    assert!(state.pending_oauth_flows.read().contains_key("s1"));
}

/// Build a flow the way `oauth_start` does (discovery, registration, PKCE)
/// against a local authorization server. `oauth_start` itself refuses the
/// loopback authorization URL such a server produces, so the test builds the
/// session directly. Returns the flow's state and the URL's PKCE challenge.
async fn start_local_flow(state: &AppState, server_url: &str) -> (String, String) {
    use rmcp::transport::auth::{AuthorizationManager, AuthorizationRequest};
    let mut manager = AuthorizationManager::new(server_url).await.unwrap();
    let resolution = manager.resolve_metadata().await.unwrap();
    manager.set_metadata(resolution.metadata);
    let session = AuthorizationSession::new(
        manager,
        AuthorizationRequest::new(REDIRECT).with_client_name("Troupe"),
    )
    .await
    .map_err(|(_, e)| e)
    .unwrap();
    let auth_url = Url::parse(session.get_authorization_url()).unwrap();
    let param = |name: &str| {
        auth_url
            .query_pairs()
            .find_map(|(key, value)| (key == name).then(|| value.into_owned()))
            .unwrap()
    };
    let (csrf, challenge) = (param("state"), param("code_challenge"));
    state.pending_oauth_flows.write().insert(
        csrf.clone(),
        mcp_oauth::PendingOAuthFlow {
            server_url: server_url.to_string(),
            redirect_uri: session.redirect_uri.clone(),
            session,
            created_at: Instant::now(),
        },
    );
    (csrf, challenge)
}

#[tokio::test]
async fn pasted_redirect_exchanges_with_the_start_session_and_stores_the_token() {
    let _tokens = crate::acp::mcp_oauth::tests::TokenDirGuard::new("paste-ok");
    let (server_url, requests) =
        crate::acp::mcp_oauth::tests::serve_token_endpoint(serde_json::json!({
            "access_token": "fresh-access",
            "token_type": "Bearer",
            "expires_in": 3600,
            "refresh_token": "fresh-refresh",
        }))
        .await;
    let state = test_state();
    let (csrf, challenge) = start_local_flow(&state, &server_url).await;

    let (status, body) = complete(
        &state,
        crate::web::project_registry::SEEDED_PROJECT_ID,
        &format!("{REDIRECT}?code=the-code&state={csrf}"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{:?}", body.error);
    assert!(body.success);
    assert!(state.pending_oauth_flows.read().is_empty());

    let form: HashMap<String, String> = {
        let requests = requests.lock();
        assert_eq!(requests.len(), 1);
        url::form_urlencoded::parse(requests[0].as_bytes())
            .into_owned()
            .collect()
    };
    assert_eq!(form["grant_type"], "authorization_code");
    assert_eq!(form["code"], "the-code");
    assert_eq!(form["client_id"], "client-1", "the start session's client");
    let verifier = oauth2::PkceCodeVerifier::new(form["code_verifier"].clone());
    assert_eq!(
        oauth2::PkceCodeChallenge::from_code_verifier_sha256(&verifier).as_str(),
        challenge,
        "the start session's PKCE verifier"
    );

    let stored = mcp_oauth::load_stored_token(&server_url)
        .unwrap()
        .expect("the token is stored");
    assert_eq!(stored.access_token, "fresh-access");
    assert_eq!(stored.refresh_token.as_deref(), Some("fresh-refresh"));
    assert_eq!(stored.client_id, "client-1");
    assert_eq!(stored.server_url, server_url);
}

#[tokio::test]
async fn pasted_issuer_reaches_the_issuer_check() {
    let _tokens = crate::acp::mcp_oauth::tests::TokenDirGuard::new("paste-iss");
    let (server_url, requests) = crate::acp::mcp_oauth::tests::serve_token_endpoint(
        serde_json::json!({ "access_token": "a", "token_type": "Bearer" }),
    )
    .await;
    let state = test_state();
    let (csrf, _) = start_local_flow(&state, &server_url).await;

    // This server publishes no issuer, so any `iss` on the redirect cannot be
    // validated and the exchange must stop before `/token`.
    let (status, body) = complete(
        &state,
        crate::web::project_registry::SEEDED_PROJECT_ID,
        &format!("{REDIRECT}?code=c&state={csrf}&iss=https%3A%2F%2Fforged.example.com"),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(body.code.as_deref(), Some("OAUTH_EXCHANGE_FAILED"));
    assert!(requests.lock().is_empty(), "no token request was made");
    assert!(mcp_oauth::load_stored_token(&server_url).unwrap().is_none());
}

mod routes {
    use std::sync::Arc;

    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use serde_json::{json, Value};
    use tower::ServiceExt;

    use crate::acp::AcpManager;
    use crate::web::mcp_registry::STORE_KEY;
    use crate::web::project_registry::{ProjectRegistry, ProjectSummary};
    use crate::web::sink::WsRelaySink;
    use crate::web::store::{Precondition, StorePolicy, WebStore};
    use crate::web::test_pty_manager;
    use crate::web::ws::{AppState, ClientIdentity, HistoryMode};

    const LOOPBACK: std::net::SocketAddr =
        std::net::SocketAddr::new(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), 54321);

    fn app(registry: Arc<ProjectRegistry>, store: Option<Arc<WebStore>>) -> axum::Router {
        let pty = test_pty_manager();
        let state = AppState {
            acp: Arc::new(AcpManager::new(vec![])),
            terminal_events: pty.terminal_events(),
            cwd_tracker: pty.cwd_tracker(),
            git_tracker: pty.git_tracker(),
            exit_code_tracker: pty.exit_code_tracker(),
            pty,
            relay: Arc::new(WsRelaySink::new()),
            registry,
            history_mode: HistoryMode::LiveOnly,
            pending_oauth_flows: Arc::new(parking_lot::RwLock::new(
                std::collections::HashMap::new(),
            )),
            oauth_base_url: "http://127.0.0.1".to_string(),
            acp_catalog: None,
            acp_install: None,
            store,
            web_auth: None,
            allow_remote_writes: false,
            shared_live_writes_denied: false,
            connections: Default::default(),
            server_admin: None,
        };
        axum::Router::new()
            .route(
                "/mcp-servers/oauth/start",
                axum::routing::post(super::oauth_start),
            )
            .route(
                "/mcp-servers/oauth/status",
                axum::routing::post(super::oauth_status),
            )
            .route(
                "/mcp-servers/oauth/disconnect",
                axum::routing::post(super::oauth_disconnect),
            )
            .with_state(state)
    }

    fn store_with(dir: &std::path::Path, servers: Value) -> Arc<WebStore> {
        let store = WebStore::open(dir.join("store.json"), StorePolicy::default()).unwrap();
        let client = ClientIdentity {
            device_id: "browser".into(),
            client_instance_id: "tab".into(),
        };
        store
            .write(
                STORE_KEY,
                json!({ "_version": 1, "data": servers }),
                Precondition::default(),
                &client,
                1,
            )
            .unwrap();
        Arc::new(store)
    }

    fn request(route: &str, project_id: &str, server_url: &str) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(format!("/mcp-servers/oauth/{route}"))
            .header("content-type", "application/json")
            .extension(axum::extract::ConnectInfo(LOOPBACK))
            .body(Body::from(
                json!({ "projectId": project_id, "serverUrl": server_url }).to_string(),
            ))
            .unwrap()
    }

    async fn code_of(app: &axum::Router, request: Request<Body>) -> Value {
        let response = app.clone().oneshot(request).await.unwrap();
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        body["code"].clone()
    }

    /// The host list authorizes a URL for every project: one configured
    /// while project A was open is authorized for project B. A URL that is
    /// not listed, or whose entry is off or stdio, is not.
    #[tokio::test]
    async fn start_authorizes_urls_of_the_host_list_for_every_project() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (dir.path().join("a"), dir.path().join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let registry =
            ProjectRegistry::with_roots_for_test(&[("pa", a.as_path()), ("pb", b.as_path())]);
        let store = store_with(
            dir.path(),
            json!([
                { "id": "h", "type": "http", "name": "H", "url": "http://127.0.0.1:1/mcp/" },
                { "id": "off", "type": "sse", "name": "Off", "url": "http://127.0.0.1:2/sse",
                  "enabled": false }
            ]),
        );
        let app = app(registry, Some(store));

        for project in ["pa", "pb"] {
            // Authorized: it fails later, at discovery against a closed port.
            assert_eq!(
                code_of(&app, request("start", project, "http://127.0.0.1:1/mcp")).await,
                "OAUTH_START_FAILED",
                "{project}"
            );
        }
        for url in ["http://127.0.0.1:2/sse", "http://127.0.0.1:3/other"] {
            assert_eq!(
                code_of(&app, request("start", "pb", url)).await,
                "UNAUTHORIZED_SERVER_URL",
                "{url}"
            );
        }
    }

    #[tokio::test]
    async fn start_authorizes_nothing_without_a_stored_list() {
        let dir = tempfile::tempdir().unwrap();
        let registry = ProjectRegistry::with_roots_for_test(&[("pa", dir.path())]);
        let empty = Arc::new(
            WebStore::open(dir.path().join("store.json"), StorePolicy::default()).unwrap(),
        );
        for store in [None, Some(empty)] {
            let app = app(registry.clone(), store);
            assert_eq!(
                code_of(&app, request("start", "pa", "http://127.0.0.1:1/mcp")).await,
                "UNAUTHORIZED_SERVER_URL"
            );
        }
    }

    /// Unknown, archived and pathless projects are refused `NOT_FOUND` by
    /// start, status and disconnect alike.
    #[tokio::test]
    async fn unknown_archived_and_pathless_projects_are_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let registry = ProjectRegistry::with_roots_for_test(&[("archived", dir.path())]);
        assert!(registry.update("archived", None, None, Some(true)));
        registry.upsert(ProjectSummary {
            id: "nopath".to_string(),
            name: "No path".to_string(),
            color: "blue".to_string(),
            path: None,
            is_archived: false,
            is_default: false,
        });
        let store = store_with(
            dir.path(),
            json!([{ "id": "h", "type": "http", "name": "H", "url": "https://mcp.example.com" }]),
        );
        let app = app(registry, Some(store));

        for project in ["archived", "nopath", "never-registered", ""] {
            for route in ["start", "status", "disconnect"] {
                assert_eq!(
                    code_of(&app, request(route, project, "https://mcp.example.com")).await,
                    "NOT_FOUND",
                    "{route} {project}"
                );
            }
        }
    }
}
