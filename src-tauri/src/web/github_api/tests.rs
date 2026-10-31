use super::*;
use crate::acp::AcpManager;
use crate::trackers::GitTracker;
use crate::web::sink::WsRelaySink;
use crate::web::test_pty_manager;
use crate::web::ws::HistoryMode;
use axum::body::Body;
use axum::http::Request;
use axum::routing::post;
use std::sync::Arc;
use tower::ServiceExt;

fn test_state(root: &std::path::Path) -> AppState {
    let pty = test_pty_manager();
    AppState {
        acp: Arc::new(AcpManager::new(vec![])),
        terminal_events: pty.terminal_events(),
        cwd_tracker: pty.cwd_tracker(),
        git_tracker: pty.git_tracker(),
        exit_code_tracker: pty.exit_code_tracker(),
        pty,
        relay: Arc::new(WsRelaySink::new()),
        registry: crate::web::project_registry::ProjectRegistry::seeded_for_test(
            &root.canonicalize().unwrap_or_else(|_| root.to_path_buf()),
        ),
        history_mode: HistoryMode::LiveOnly,
        pending_oauth_flows: std::sync::Arc::new(parking_lot::RwLock::new(
            std::collections::HashMap::new(),
        )),
        oauth_base_url: "http://127.0.0.1".to_string(),
        acp_catalog: None,
        acp_install: None,
        store: None,
        web_auth: None,
        allow_remote_writes: false,
        shared_live_writes_denied: false,
        connections: Default::default(),
        server_admin: None,
    }
}

fn app(state: AppState) -> axum::Router {
    axum::Router::new()
        .route("/github/items", post(list_items))
        .route("/github/merge", post(merge))
        .route("/github/comment", post(comment))
        .route("/github/checkout-pr", post(checkout_pr))
        .with_state(state)
}

async fn post_json<T: serde::de::DeserializeOwned>(
    state: AppState,
    route: &str,
    body: serde_json::Value,
    peer: SocketAddr,
) -> IpcBody<T> {
    let resp = app(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(route)
                .header("content-type", "application/json")
                .extension(ConnectInfo(peer))
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .expect("build request"),
        )
        .await
        .expect("router response");
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .expect("read body");
    serde_json::from_slice(&bytes).expect("deserialize IpcBody")
}

fn loopback() -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], 54321))
}

fn list_body(cwd: &std::path::Path) -> serde_json::Value {
    serde_json::json!({
        "cwd": cwd.to_string_lossy(),
        "filter": { "repo": "origin", "kind": "all", "state": "open", "assignedToMe": false, "reviewRequested": false }
    })
}

#[tokio::test]
async fn items_reject_a_cwd_outside_every_project() {
    let inside = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let body: IpcBody<GithubListResult> = post_json(
        test_state(inside.path()),
        "/github/items",
        list_body(outside.path()),
        loopback(),
    )
    .await;
    assert_eq!(body.code.as_deref(), Some("OUTSIDE_PROJECT_ROOT"));
}

#[tokio::test]
async fn items_for_a_repo_without_a_github_remote_is_not_github() {
    let root = tempfile::tempdir().unwrap();
    let init = GitTracker::run_git_command(root.path().to_str().unwrap(), &["init", "-q"]);
    assert!(init.expect("git runs").status.success());
    let body: IpcBody<GithubListResult> = post_json(
        test_state(root.path()),
        "/github/items",
        list_body(root.path()),
        loopback(),
    )
    .await;
    assert!(!body.success);
    assert_eq!(body.code.as_deref(), Some("GH_NOT_GITHUB_REPO"));
}

#[tokio::test]
async fn merge_from_a_lan_peer_is_refused_before_any_gh_call() {
    let root = tempfile::tempdir().unwrap();
    let body: IpcBody<GithubMergeResult> = post_json(
        test_state(root.path()),
        "/github/merge",
        serde_json::json!({
            "cwd": root.path().to_string_lossy(),
            "repo": "origin",
            "number": 1,
            "action": { "kind": "merge", "method": "squash" }
        }),
        SocketAddr::from(([192, 168, 1, 20], 40000)),
    )
    .await;
    assert_eq!(body.code.as_deref(), Some("FORBIDDEN"));
}

#[tokio::test]
async fn comment_and_checkout_from_a_lan_peer_are_refused_before_any_gh_call() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().to_string_lossy();
    let lan = SocketAddr::from(([192, 168, 1, 20], 40000));
    let comment: IpcBody<GithubCommentResult> = post_json(
        test_state(root.path()),
        "/github/comment",
        serde_json::json!({
            "cwd": cwd, "repo": "origin", "kind": "issue", "number": 1,
            "target": { "kind": "conversation" }, "body": "hi"
        }),
        lan,
    )
    .await;
    assert_eq!(comment.code.as_deref(), Some("FORBIDDEN"));
    let checkout: IpcBody<GithubCheckoutPrResult> = post_json(
        test_state(root.path()),
        "/github/checkout-pr",
        serde_json::json!({ "cwd": cwd, "repo": "origin", "number": 1 }),
        lan,
    )
    .await;
    assert_eq!(checkout.code.as_deref(), Some("FORBIDDEN"));
}

#[tokio::test]
async fn checkout_into_the_project_checkout_itself_is_refused() {
    let root = tempfile::tempdir().unwrap();
    let init = GitTracker::run_git_command(root.path().to_str().unwrap(), &["init", "-q"]);
    assert!(init.expect("git runs").status.success());
    let body: IpcBody<GithubCheckoutPrResult> = post_json(
        test_state(root.path()),
        "/github/checkout-pr",
        serde_json::json!({ "cwd": root.path().to_string_lossy(), "repo": "origin", "number": 1 }),
        loopback(),
    )
    .await;
    assert_eq!(body.code.as_deref(), Some("PATH_VALIDATION_FAILED"));
}

#[tokio::test]
async fn context_reply_serializes_as_the_ts_contract() {
    let body = IpcBody::ok(GithubContext {
        auth: GithubAuthStatus::CliMissing,
        repo: GithubRepoResolution::Resolved {
            origin: GithubRepoRef {
                host: "github.com".into(),
                owner: "o".into(),
                name: "r".into(),
            },
            upstream: None,
        },
    });
    assert_eq!(
        serde_json::to_value(body).unwrap(),
        serde_json::json!({
            "success": true,
            "data": {
                "auth": { "state": "cli_missing" },
                "repo": {
                    "kind": "resolved",
                    "origin": { "host": "github.com", "owner": "o", "name": "r" },
                    "upstream": null
                }
            }
        })
    );
}
