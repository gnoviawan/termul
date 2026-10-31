use super::super::tests::{route, test_env, test_outbound};
use super::*;
use crate::web::mcp_catalog_api::tests::{http_icon, http_search, http_status, FIXED_ICON};

async fn ws_search(payload: Value) -> WsReply {
    ws_request("search_mcp_catalog", payload).await
}

async fn ws_request(request_type: &str, payload: Value) -> WsReply {
    let relay = Arc::new(WsRelaySink::new());
    let acp = Arc::new(AcpManager::new(vec![]));
    let (tx, _rx) = test_outbound();
    let subscriptions = Arc::new(Subscriptions::default());
    let registry = Arc::new(ProjectRegistry::new());
    let frame = json!({ "id": "r1", "type": request_type, "payload": payload }).to_string();
    route(
        &frame,
        &test_env(&acp, &relay, &registry, &tx, &subscriptions),
    )
    .await
}

/// The WS reply as the `IpcResult` the desktop facade builds from it.
fn as_ipc_result(reply: WsReply) -> Value {
    match (reply.ok, reply.payload, reply.err) {
        (true, Some(data), None) => json!({ "success": true, "data": data }),
        (false, None, Some(err)) => {
            json!({ "success": false, "error": err.message, "code": err.code })
        }
        other => panic!("unexpected reply shape {other:?}"),
    }
}

#[tokio::test]
async fn ws_and_http_return_the_same_page() {
    let ws =
        as_ipc_result(ws_search(json!({ "query": "server", "limit": 3, "cursor": "1" })).await);
    let http = http_search("query=server&limit=3&cursor=1").await;
    assert_eq!(ws["success"], true);
    assert_eq!(ws["data"], http["data"]);
}

#[tokio::test]
async fn ws_and_http_return_the_same_validation_error() {
    let ws = as_ipc_result(ws_search(json!({ "limit": 500 })).await);
    let http = http_search("limit=500").await;
    assert_eq!(ws["code"], "VALIDATION_ERROR");
    assert_eq!(ws["code"], http["code"]);
    assert_eq!(ws["error"], http["error"]);

    let malformed = as_ipc_result(ws_search(json!({ "query": 7 })).await);
    assert_eq!(malformed["code"], "VALIDATION_ERROR");
}

#[tokio::test]
async fn ws_and_http_return_the_same_status() {
    let ws = as_ipc_result(ws_request("get_mcp_catalog_status", json!({})).await);
    assert_eq!(ws, http_status().await);
}

#[tokio::test]
async fn ws_set_sync_validates_then_reports_sync_unavailable_without_a_host() {
    let invalid = as_ipc_result(ws_request("set_mcp_catalog_sync", json!({ "on": true })).await);
    assert_eq!(invalid["code"], "VALIDATION_ERROR");
    let unattached =
        as_ipc_result(ws_request("set_mcp_catalog_sync", json!({ "enabled": true })).await);
    assert_eq!(unattached["code"], "MCP_CATALOG_SYNC_UNAVAILABLE");
}

#[tokio::test]
async fn ws_and_http_serve_the_same_icon_bytes() {
    use base64::Engine as _;
    let http = http_icon("ai.abmeter%2Fabmeter").await;
    let http_bytes = axum::body::to_bytes(http.into_body(), usize::MAX)
        .await
        .unwrap();
    let ws = as_ipc_result(
        ws_request(
            "get_mcp_catalog_icon",
            json!({ "name": "ai.abmeter/abmeter" }),
        )
        .await,
    );
    assert_eq!(ws["success"], true);
    assert_eq!(ws["data"]["contentType"], "image/png");
    let ws_bytes = base64::engine::general_purpose::STANDARD
        .decode(ws["data"]["base64"].as_str().unwrap())
        .unwrap();
    assert_eq!(ws_bytes, FIXED_ICON);
    assert_eq!(ws_bytes, http_bytes);

    let missing =
        as_ipc_result(ws_request("get_mcp_catalog_icon", json!({ "name": "to.hooka/mcp" })).await);
    assert_eq!(missing["code"], "NOT_FOUND");
    let invalid = as_ipc_result(ws_request("get_mcp_catalog_icon", json!({ "id": 1 })).await);
    assert_eq!(invalid["code"], "VALIDATION_ERROR");
}
