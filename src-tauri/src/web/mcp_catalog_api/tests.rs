use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode};
use axum::routing::{get, post};
use serde_json::{json, Value};
use tower::ServiceExt;

use crate::web::ws::{AppState, HistoryMode};

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

#[tokio::test]
async fn search_returns_a_page_of_rows() {
    let body = http_search("query=hooka&limit=5").await;
    assert_eq!(body["success"], true);
    let data = &body["data"];
    assert_eq!(data["total"], 1);
    assert_eq!(data["nextCursor"], Value::Null);
    assert!(data["updatedAt"].is_string());
    assert_eq!(data["sample"], true);
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
    assert_eq!(first["data"]["total"], 24);
    assert_eq!(first["data"]["items"].as_array().unwrap().len(), 20);
    assert_eq!(first["data"]["nextCursor"], "20");
    let second = http_search("limit=20&cursor=20").await;
    assert_eq!(second["data"]["items"].as_array().unwrap().len(), 4);
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

pub(crate) async fn http_status() -> Value {
    let response = axum::Router::new()
        .route("/mcp-catalog/status", get(super::status))
        .oneshot(
            Request::builder()
                .uri("/mcp-catalog/status")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    serde_json::from_slice(&bytes).expect("IpcBody json")
}

fn state(allow_remote_writes: bool, shared_live_writes_denied: bool) -> AppState {
    let pty = crate::web::test_pty_manager();
    AppState {
        acp: Arc::new(crate::acp::AcpManager::new(vec![])),
        terminal_events: pty.terminal_events(),
        cwd_tracker: pty.cwd_tracker(),
        git_tracker: pty.git_tracker(),
        exit_code_tracker: pty.exit_code_tracker(),
        pty,
        relay: Arc::new(crate::web::sink::WsRelaySink::new()),
        registry: crate::web::project_registry::ProjectRegistry::seeded_for_test(
            &std::env::temp_dir(),
        ),
        history_mode: HistoryMode::LiveOnly,
        pending_oauth_flows: Arc::new(parking_lot::RwLock::new(std::collections::HashMap::new())),
        oauth_base_url: "http://127.0.0.1".to_string(),
        acp_catalog: None,
        acp_install: None,
        store: None,
        web_auth: None,
        allow_remote_writes,
        shared_live_writes_denied,
        connections: Default::default(),
        server_admin: None,
    }
}

async fn http_set_sync(state: AppState, peer: [u8; 4], body: &str) -> Value {
    let response = axum::Router::new()
        .route("/mcp-catalog/sync", post(super::set_sync))
        .with_state(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/mcp-catalog/sync")
                .header("content-type", "application/json")
                .extension(ConnectInfo(SocketAddr::from((peer, 54321))))
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

#[tokio::test]
async fn status_names_the_sample_catalog_and_its_size() {
    let body = http_status().await;
    assert_eq!(body["success"], true);
    assert_eq!(body["data"]["sample"], true);
    assert_eq!(body["data"]["servers"], 24);
    assert_eq!(body["data"]["updatedAt"], "2026-10-31T10:35:51.229Z");
    assert_eq!(body["data"]["sync"], json!({ "state": "disabled" }));
}

#[tokio::test]
async fn set_sync_is_a_write_that_shared_live_and_remote_peers_cannot_make() {
    let enabled = r#"{"enabled":false}"#;
    for (state, peer) in [
        (state(true, true), [127, 0, 0, 1]),
        (state(false, false), [192, 168, 1, 20]),
    ] {
        let body = http_set_sync(state, peer, enabled).await;
        assert_eq!(body["success"], false);
        assert_eq!(body["code"], "FORBIDDEN");
    }
}

#[tokio::test]
async fn set_sync_validates_its_body_before_reaching_the_service() {
    let body = http_set_sync(
        state(false, false),
        [127, 0, 0, 1],
        r#"{"enabled":true,"x":1}"#,
    )
    .await;
    assert_eq!(body["code"], "VALIDATION_ERROR");
    let body = http_set_sync(state(false, false), [127, 0, 0, 1], r#"{"enabled":true}"#).await;
    assert_eq!(body["code"], "MCP_CATALOG_SYNC_UNAVAILABLE");
}

pub(crate) const LOOPBACK: ([u8; 4], u16) = ([127, 0, 0, 1], 54321);
const REMOTE: ([u8; 4], u16) = ([203, 0, 113, 9], 40000);

fn install_app(allow_remote_writes: bool, shared_live_writes_denied: bool) -> axum::Router {
    axum::Router::new()
        .route("/mcp-catalog/install/form", super::install_route(super::describe_install))
        .route("/mcp-catalog/install/plan", super::install_route(super::plan_install))
        .route("/mcp-catalog/install/commit", super::install_route(super::commit_install))
        .route("/mcp-catalog/install/cancel", super::install_route(super::cancel_install))
        .with_state(state(allow_remote_writes, shared_live_writes_denied))
}

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

pub(crate) async fn http_install_local(route: &str, body: &Value) -> Value {
    http_install(route, &body.to_string(), LOOPBACK, false, false).await
}

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

#[tokio::test]
async fn a_client_id_must_be_a_short_id_without_control_characters() {
    let message = "clientInstanceId must be a non-empty id of at most 128 bytes without control characters";
    for client in [String::new(), "t".repeat(129), "tab\u{0007}".to_string()] {
        for route in ["plan", "commit", "cancel"] {
            let body = json!({
                "clientInstanceId": client,
                "source": { "kind": "import", "json": "{}" },
                "planId": "p",
                "launchDigest": "sha256:00",
            });
            let reply = http_install_local(route, &body).await;
            assert_eq!(
                (reply["code"].as_str(), reply["error"].as_str()),
                (Some("VALIDATION_ERROR"), Some(message)),
                "{route} {client:?}"
            );
        }
    }
    let longest = http_install_local("plan", &import_plan_body(&"t".repeat(128))).await;
    assert_eq!(longest["success"], true, "{longest}");
}

#[tokio::test]
async fn an_install_body_over_the_route_limit_is_refused_unread() {
    let padding = "a".repeat(super::MAX_INSTALL_BODY_BYTES);
    let body = json!({ "clientInstanceId": "tab", "source": { "kind": "import", "json": padding } });
    let response = install_app(false, false)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/mcp-catalog/install/plan")
                .header("content-type", "application/json")
                .extension(ConnectInfo(SocketAddr::from(LOOPBACK)))
                .body(Body::from(body.to_string()))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

pub(crate) const FIXED_ICON: &[u8] = b"\x89PNG\r\n\x1a\nfixture";

pub(crate) async fn with_fixed_icons() {
    let dir = tempfile::tempdir().expect("icon dir").keep();
    crate::mcp_catalog::McpCatalogService::shared()
        .await
        .attach_fixed_icon(
            dir,
            crate::mcp_catalog::Icon {
                content_type: crate::mcp_catalog::IconType::Png,
                bytes: FIXED_ICON.into(),
            },
        );
}

pub(crate) async fn http_icon(encoded_name: &str) -> axum::response::Response {
    with_fixed_icons().await;
    axum::Router::new()
        .route("/mcp-catalog/icon/{*name}", get(super::icon))
        .oneshot(
            Request::builder()
                .uri(format!("/mcp-catalog/icon/{encoded_name}"))
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response")
}

#[tokio::test]
async fn rows_say_whether_the_host_has_a_logo_without_the_url() {
    let body = http_search("query=abmeter").await;
    let row = &body["data"]["items"][0];
    assert_eq!(row["name"], "ai.abmeter/abmeter");
    assert_eq!(row["hasIcon"], true);
    assert!(!body.to_string().contains("abmeter.ai/"));
    let hooka = http_search("query=hooka").await;
    assert_eq!(hooka["data"]["items"][0]["hasIcon"], false);
}

#[tokio::test]
async fn the_icon_route_serves_inert_image_bytes() {
    let response = http_icon("ai.abmeter%2Fabmeter").await;
    assert_eq!(response.status(), StatusCode::OK);
    let headers = response.headers().clone();
    assert_eq!(headers["content-type"], "image/png");
    assert_eq!(headers["x-content-type-options"], "nosniff");
    assert_eq!(
        headers["content-security-policy"],
        "default-src 'none'; style-src 'unsafe-inline'; sandbox"
    );
    assert_eq!(headers["cache-control"], "private, max-age=86400");
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    assert_eq!(&bytes[..], FIXED_ICON);

    let unescaped = http_icon("ai.abmeter/abmeter").await;
    assert_eq!(unescaped.status(), StatusCode::OK);
}

#[tokio::test]
async fn servers_without_a_logo_are_not_found() {
    for name in ["to.hooka%2Fmcp", "io.example%2Fmissing"] {
        let response = http_icon(name).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{name}");
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let body: Value = serde_json::from_slice(&bytes).expect("IpcBody json");
        assert_eq!(body["success"], false);
        assert_eq!(body["code"], "NOT_FOUND");
    }
}
