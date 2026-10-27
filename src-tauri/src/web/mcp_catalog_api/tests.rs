use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode};
use axum::routing::{get, post};
use serde_json::{json, Value};
use tower::ServiceExt;

use crate::acp::AcpManager;
use crate::web::sink::WsRelaySink;
use crate::web::test_pty_manager;
use crate::web::ws::{AppState, HistoryMode};

pub(crate) const LOOPBACK: ([u8; 4], u16) = ([127, 0, 0, 1], 54321);
const REMOTE: ([u8; 4], u16) = ([203, 0, 113, 9], 40000);

/// `GET /mcp-catalog/search?<query>` against the embedded dev fixture.
pub(crate) async fn http_search(query: &str) -> Value {
    let response = axum::Router::new()
        .route("/mcp-catalog/search", get(super::search))
        .oneshot(
            Request::builder()
                .uri(format!("/mcp-catalog/search?{query}"))
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    serde_json::from_slice(&bytes).expect("IpcBody json")
}

fn install_app(allow_remote_writes: bool, shared_live_writes_denied: bool) -> axum::Router {
    let pty = test_pty_manager();
    let state = AppState {
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
        history_mode: HistoryMode::LiveOnly,
        pending_oauth_flows: Arc::new(parking_lot::RwLock::new(
            std::collections::HashMap::new(),
        )),
        oauth_base_url: "http://127.0.0.1".to_string(),
        acp_catalog: None,
        acp_install: None,
        store: None,
        web_auth: None,
        allow_remote_writes,
        shared_live_writes_denied,
        connections: Default::default(),
    };
    axum::Router::new()
        .route("/mcp-catalog/install/form", post(super::describe_install))
        .route("/mcp-catalog/install/plan", post(super::plan_install))
        .route("/mcp-catalog/install/commit", post(super::commit_install))
        .route("/mcp-catalog/install/cancel", post(super::cancel_install))
        .with_state(state)
}

/// `POST /mcp-catalog/install/<route>` with `body` from `peer`, on a host
/// with the given write flags. Returns the `IpcBody` JSON.
pub(crate) async fn http_install(
    route: &str,
    body: &str,
    peer: ([u8; 4], u16),
    allow_remote_writes: bool,
    shared_live_writes_denied: bool,
) -> Value {
    let response = install_app(allow_remote_writes, shared_live_writes_denied)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/mcp-catalog/install/{route}"))
                .header("content-type", "application/json")
                .extension(ConnectInfo(SocketAddr::from(peer)))
                .body(Body::from(body.to_string()))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    serde_json::from_slice(&bytes).expect("IpcBody json")
}

/// The loopback, non-shared-live call every parity test starts from.
pub(crate) async fn http_install_local(route: &str, body: &Value) -> Value {
    http_install(route, &body.to_string(), LOOPBACK, false, false).await
}

/// A pasted `mcpServers` file: the one plan source that needs no runner on
/// the test host.
pub(crate) fn import_plan_body(client: &str) -> Value {
    json!({
        "clientInstanceId": client,
        "source": {
            "kind": "import",
            "json": r#"{"mcpServers":{"notes":{"command":"node","args":["srv.js"],"env":{"NOTES_TOKEN":"from-file"}}}}"#
        },
        "inputs": {}
    })
}

#[tokio::test]
async fn search_returns_a_page_of_rows() {
    let body = http_search("query=hooka&limit=5").await;
    assert_eq!(body["success"], true);
    let data = &body["data"];
    assert_eq!(data["total"], 1);
    assert_eq!(data["nextCursor"], Value::Null);
    assert!(data["snapshotFetchedAt"].is_string());
    let row = &data["items"][0];
    assert_eq!(row["name"], "to.hooka/mcp");
    assert_eq!(row["version"], "0.1.2");
    assert_eq!(row["status"], "active");
    assert_eq!(
        row["defaultOption"],
        serde_json::json!({ "kind": "package", "index": 0 })
    );
    assert!(row["state"] == "installable" || row["state"] == "needs-runtime");
}

#[tokio::test]
async fn search_pages_with_the_returned_cursor() {
    let first = http_search("limit=20").await;
    assert_eq!(first["data"]["total"], 21);
    assert_eq!(first["data"]["items"].as_array().unwrap().len(), 20);
    assert_eq!(first["data"]["nextCursor"], "20");
    let second = http_search("limit=20&cursor=20").await;
    assert_eq!(second["data"]["items"].as_array().unwrap().len(), 1);
    assert_eq!(second["data"]["nextCursor"], Value::Null);
}

#[tokio::test]
async fn invalid_requests_are_validation_errors() {
    for query in ["limit=0", "limit=abc", "cursor=nope", "unknown=1"] {
        let body = http_search(query).await;
        assert_eq!(body["success"], false, "{query}");
        assert_eq!(body["code"], "VALIDATION_ERROR", "{query}");
    }
}

#[tokio::test]
async fn the_form_route_describes_a_catalog_remote_from_the_fixture() {
    let body = http_install_local(
        "form",
        &json!({ "source": { "kind": "catalog", "name": "com.tre-app/tre", "version": "0.2.0" } }),
    )
    .await;
    assert_eq!(body["success"], true, "{body}");
    assert_eq!(body["data"]["outcome"], "form");
    assert_eq!(body["data"]["form"]["title"], "com.tre-app/tre");
    let fields = body["data"]["form"]["fields"].as_array().unwrap();
    assert_eq!(fields.len(), 1);
    assert_eq!(fields[0]["id"], "header/Authorization");
    assert_eq!(fields[0]["isSecret"], true);
}

#[tokio::test]
async fn plan_commit_and_cancel_round_trip_over_http() {
    let planned = http_install_local("plan", &import_plan_body("tab-a")).await;
    assert_eq!(planned["success"], true, "{planned}");
    assert_eq!(planned["data"]["outcome"], "plan");
    let plan = &planned["data"]["plan"];
    assert_eq!(plan["name"], "notes");
    assert_eq!(plan["consentView"]["argv"], json!(["node", "srv.js"]));
    assert_eq!(plan["consentView"]["env"][0]["value"], "from-file");
    assert_eq!(plan["consentView"]["warnings"], json!(["runs-local-code", "from-file"]));

    let committed = http_install_local(
        "commit",
        &json!({
            "clientInstanceId": "tab-a",
            "planId": plan["planId"],
            "launchDigest": plan["launchDigest"],
            "secretValues": {}
        }),
    )
    .await;
    assert_eq!(committed["success"], true, "{committed}");
    assert_eq!(committed["data"]["launchDigest"], plan["launchDigest"]);
    assert_eq!(
        committed["data"]["secrets"],
        json!([{ "slot": "env", "name": "NOTES_TOKEN", "value": "from-file" }])
    );

    let again = http_install_local(
        "commit",
        &json!({
            "clientInstanceId": "tab-a",
            "planId": plan["planId"],
            "launchDigest": plan["launchDigest"],
            "secretValues": {}
        }),
    )
    .await;
    assert_eq!(again["code"], "MCP_PLAN_CONSUMED");

    let cancelled = http_install_local(
        "cancel",
        &json!({ "clientInstanceId": "tab-a", "planId": plan["planId"] }),
    )
    .await;
    assert_eq!(cancelled, json!({ "success": true, "data": {} }));
}

#[tokio::test]
async fn another_client_cannot_commit_or_cancel_the_plan() {
    let planned = http_install_local("plan", &import_plan_body("tab-a")).await;
    let plan = &planned["data"]["plan"];
    let other = http_install_local(
        "commit",
        &json!({
            "clientInstanceId": "tab-b",
            "planId": plan["planId"],
            "launchDigest": plan["launchDigest"],
            "secretValues": {}
        }),
    )
    .await;
    assert_eq!(other["code"], "MCP_PLAN_WRONG_CALLER");
    let cancel = http_install_local(
        "cancel",
        &json!({ "clientInstanceId": "tab-b", "planId": plan["planId"] }),
    )
    .await;
    assert_eq!(cancel["code"], "MCP_PLAN_WRONG_CALLER");
}

#[tokio::test]
async fn a_plan_mutation_without_a_client_id_is_a_validation_error() {
    let mut body = import_plan_body("tab-a");
    body.as_object_mut().unwrap().remove("clientInstanceId");
    let planned = http_install_local("plan", &body).await;
    assert_eq!(planned["success"], false);
    assert_eq!(planned["code"], "VALIDATION_ERROR");
}

/// AD-12: shared-live denies every install mutation, a non-loopback peer
/// needs the opt-in, and the guard runs before the body is read.
#[tokio::test]
async fn install_mutations_carry_the_shared_write_guard() {
    for route in ["plan", "commit", "cancel"] {
        for (label, peer, allow_remote, shared_live) in [
            ("remote", REMOTE, false, false),
            ("shared-live-loopback", LOOPBACK, false, true),
            ("shared-live-optin", REMOTE, true, true),
        ] {
            let body = http_install(route, "{not json", peer, allow_remote, shared_live).await;
            assert_eq!(body["success"], false, "{route} {label}");
            assert_eq!(body["code"], "FORBIDDEN", "{route} {label}");
        }
        let admitted = http_install(route, "{not json", REMOTE, true, false).await;
        assert_eq!(admitted["code"], "VALIDATION_ERROR", "{route} remote-optin");
    }
    let form = http_install(
        "form",
        &json!({ "source": { "kind": "reapprove", "entryId": "e1" } }).to_string(),
        LOOPBACK,
        false,
        true,
    )
    .await;
    assert_eq!(form["code"], "MCP_PLAN_NOT_AVAILABLE", "the form stays a read in shared-live");
}
