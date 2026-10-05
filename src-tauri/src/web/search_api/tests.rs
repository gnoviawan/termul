use super::*;
use crate::acp::AcpManager;
use crate::web::project_registry::ProjectRegistry;
use crate::web::sink::WsRelaySink;
use crate::web::test_pty_manager;
use axum::body::Body;
use axum::http::Request;
use axum::routing::{get, post};
use std::sync::Arc;
use tower::ServiceExt;

/// Minimal percent-encoding for test query strings (same shape as the
/// private helper in `fs_api/tests.rs` — kept local so test modules stay
/// decoupled).
fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            ' ' => out.push_str("%20"),
            '\\' => out.push_str("%5C"),
            ':' => out.push_str("%3A"),
            _ if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~' | '/') => {
                out.push(c)
            }
            _ => {
                let mut buf = [0u8; 4];
                for b in c.encode_utf8(&mut buf).as_bytes() {
                    out.push_str(&format!("%{:02X}", b));
                }
            }
        }
    }
    out
}

/// Deserializable mirror of `FileNameSearchResponse` for reading route
/// bodies in tests (`SearchFileHit` itself only implements `Serialize`).
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestFileHit {
    path: String,
    ignored: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestFileNameResponse {
    files: Vec<TestFileHit>,
    truncated: bool,
}

fn test_state() -> AppState {
    let pty = test_pty_manager();
    AppState {
        acp: Arc::new(AcpManager::new(vec![])),
        terminal_events: pty.terminal_events(),
        cwd_tracker: pty.cwd_tracker(),
        git_tracker: pty.git_tracker(),
        exit_code_tracker: pty.exit_code_tracker(),
        pty,
        relay: Arc::new(WsRelaySink::new()),
        registry: Arc::new(ProjectRegistry::new()),
        registry_persistence: None,
        projects_file: None,
        history_mode: crate::web::ws::HistoryMode::LiveOnly,
        project_root: Arc::new(parking_lot::RwLock::new(
            std::env::temp_dir()
                .canonicalize()
                .unwrap_or_else(|_| std::env::temp_dir()),
        )),
        workspace_manifest: None,
        acp_catalog: None,
        acp_install: None,
        store: None,
        web_auth: None,
        allow_remote_writes: false,
        shared_live_writes_denied: false,
        pending_oauth_flows: std::sync::Arc::new(parking_lot::RwLock::new(
            std::collections::HashMap::new(),
        )),
        oauth_base_url: "http://127.0.0.1".to_string(),
    }
}

fn test_router(state: AppState) -> axum::Router {
    axum::Router::new()
        .route("/search/rg-info", get(rg_info))
        .route("/search/content", post(content))
        .route("/search/file-names", get(file_names))
        .route("/search/cancel", post(cancel))
        .with_state(state)
}

async fn get_request(state: AppState, uri: &str) -> axum::http::Response<Body> {
    test_router(state)
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(uri)
                .body(Body::empty())
                .expect("build request"),
        )
        .await
        .expect("router response")
}

async fn post_json(
    state: AppState,
    uri: &str,
    body: &serde_json::Value,
) -> axum::http::Response<Body> {
    let bytes = serde_json::to_vec(body).expect("serialize body");
    test_router(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(uri)
                .header("content-type", "application/json")
                .body(Body::from(bytes))
                .expect("build request"),
        )
        .await
        .expect("router response")
}

async fn body_as_json<T: serde::de::DeserializeOwned>(body: Body) -> T {
    let bytes = axum::body::to_bytes(body, usize::MAX)
        .await
        .expect("read body");
    serde_json::from_slice(&bytes).expect("deserialize IpcBody")
}

#[tokio::test]
async fn rg_info_returns_info() {
    let resp = get_request(test_state(), "/search/rg-info").await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<RgInfoResponse> = body_as_json(resp.into_body()).await;
    assert!(body.success, "rg-info should succeed: {:?}", body.error);
    let data = body.data.expect("RgInfoResponse");
    assert!(!data.resolved_path.is_empty());
}

#[tokio::test]
async fn content_search_empty_query_returns_empty() {
    let req = serde_json::json!({
        "scopeRoot": "/tmp",
        "rootPath": "/tmp",
        "query": ""
    });
    let resp = post_json(test_state(), "/search/content", &req).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<FileSearchResponse> = body_as_json(resp.into_body()).await;
    assert!(body.success, "empty query should succeed: {:?}", body.error);
    let data = body.data.expect("FileSearchResponse");
    assert!(data.results.is_empty());
}

#[tokio::test]
async fn content_search_too_long_query_rejected() {
    let huge_query = "x".repeat(MAX_SEARCH_QUERY_LEN + 10);
    let req = serde_json::json!({
        "scopeRoot": "/tmp",
        "rootPath": "/tmp",
        "query": huge_query
    });
    let resp = post_json(test_state(), "/search/content", &req).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<FileSearchResponse> = body_as_json(resp.into_body()).await;
    assert!(!body.success, "too-long query should be rejected");
    assert_eq!(body.code.as_deref(), Some("QUERY_TOO_LONG"));
}

#[tokio::test]
async fn cancel_unknown_search_id_returns_success() {
    let req = serde_json::json!({ "searchId": "nonexistent-id" });
    let resp = post_json(test_state(), "/search/cancel", &req).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<()> = body_as_json(resp.into_body()).await;
    assert!(body.success, "cancel of unknown id should succeed");
}

// ----- `GET /search/file-names` (issue #848) ---------------------------------

/// One-shot filename search over a real temp workspace: files matching the
/// query are returned root-relative, ignored classification is applied when
/// `includeIgnored` is set, and the caps match the desktop stream.
#[tokio::test]
async fn file_names_search_returns_root_relative_hits() {
    let root = std::env::temp_dir().join(format!(
        "termul-search-fnames-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(root.join("src")).expect("create src dir");
    std::fs::write(root.join("src/alpha.rs"), "fn main() {}").expect("write alpha");
    std::fs::create_dir_all(root.join("node_modules")).expect("create node_modules");
    std::fs::write(root.join("node_modules/alpha.js"), "x").expect("write nm alpha");

    // The boundary check needs a registered project root covering the temp
    // dir (the default project_root points at temp_dir itself).
    let state = test_state();
    state.registry.set(
        vec![crate::web::project_registry::ProjectSummary {
            id: "p-test".to_string(),
            name: "Test".to_string(),
            color: "blue".to_string(),
            path: Some(root.to_string_lossy().to_string()),
            is_archived: false,
            is_default: false,
        }],
        None,
    );

    let root_str = root.to_string_lossy().to_string();
    let uri = format!(
        "/search/file-names?query=alpha&root={}",
        urlencoding(&root_str)
    );
    let resp = get_request(state, &uri).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<TestFileNameResponse> = body_as_json(resp.into_body()).await;
    assert!(body.success, "file-names search should succeed: {:?}", body.error);
    let data = body.data.expect("FileNameSearchResponse");
    // Default path: node_modules excluded by the ignore list; the hit is
    // root-relative with forward slashes.
    assert_eq!(data.files.len(), 1);
    assert_eq!(data.files[0].path, "src/alpha.rs");
    assert!(!data.files[0].ignored);
    assert!(!data.truncated);
    let _ = std::fs::remove_dir_all(&root);
}

/// `includeIgnored=true` surfaces node_modules hits with `ignored: true`,
/// ranked after non-ignored ones (ADR 0003 ranking).
#[tokio::test]
async fn file_names_search_include_ignored_tags_and_ranks() {
    let root = std::env::temp_dir().join(format!(
        "termul-search-fnames-ign-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(root.join("src")).expect("create src dir");
    std::fs::write(root.join("src/alpha.rs"), "fn main() {}").expect("write alpha");
    std::fs::create_dir_all(root.join("node_modules")).expect("create node_modules");
    std::fs::write(root.join("node_modules/alpha.js"), "x").expect("write nm alpha");

    let state = test_state();
    state.registry.set(
        vec![crate::web::project_registry::ProjectSummary {
            id: "p-test".to_string(),
            name: "Test".to_string(),
            color: "blue".to_string(),
            path: Some(root.to_string_lossy().to_string()),
            is_archived: false,
            is_default: false,
        }],
        None,
    );

    let root_str = root.to_string_lossy().to_string();
    let uri = format!(
        "/search/file-names?query=alpha&includeIgnored=true&root={}",
        urlencoding(&root_str)
    );
    let resp = get_request(state, &uri).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<TestFileNameResponse> = body_as_json(resp.into_body()).await;
    assert!(body.success, "file-names search should succeed: {:?}", body.error);
    let data = body.data.expect("FileNameSearchResponse");
    // Non-ignored first, ignored second (rank_search_hits).
    assert_eq!(data.files.len(), 2);
    assert_eq!(data.files[0].path, "src/alpha.rs");
    assert!(!data.files[0].ignored);
    assert_eq!(data.files[1].path, "node_modules/alpha.js");
    assert!(data.files[1].ignored);
    let _ = std::fs::remove_dir_all(&root);
}

/// Empty query short-circuits to an empty result (no rg spawned).
#[tokio::test]
async fn file_names_search_empty_query_returns_empty() {
    let uri = "/search/file-names?query=&root=/tmp";
    let resp = get_request(test_state(), uri).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<TestFileNameResponse> = body_as_json(resp.into_body()).await;
    assert!(body.success, "empty query should succeed: {:?}", body.error);
    let data = body.data.expect("FileNameSearchResponse");
    assert!(data.files.is_empty());
    assert!(!data.truncated);
}

/// Too-long queries are rejected with `QUERY_TOO_LONG` (security guard).
#[tokio::test]
async fn file_names_search_too_long_query_rejected() {
    let huge = "x".repeat(MAX_SEARCH_QUERY_LEN + 10);
    let uri = format!(
        "/search/file-names?query={}&root=/tmp",
        urlencoding(&huge)
    );
    let resp = get_request(test_state(), &uri).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<TestFileNameResponse> = body_as_json(resp.into_body()).await;
    assert!(!body.success, "too-long query should be rejected");
    assert_eq!(body.code.as_deref(), Some("QUERY_TOO_LONG"));
}

/// A root outside every registered project root is rejected with
/// `OUTSIDE_PROJECT_ROOT` (containment parity with `/search/content`).
#[tokio::test]
async fn file_names_search_outside_project_root_rejected() {
    // The default project_root in `test_state()` is the canonicalized temp
    // dir; `/` is outside it and outside every registered root (the registry
    // is empty here).
    let uri = "/search/file-names?query=zzz-no-such-file&root=/";
    let resp = get_request(test_state(), uri).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body: IpcBody<TestFileNameResponse> = body_as_json(resp.into_body()).await;
    assert!(!body.success, "outside root should be rejected");
    assert_eq!(body.code.as_deref(), Some("OUTSIDE_PROJECT_ROOT"));
}
