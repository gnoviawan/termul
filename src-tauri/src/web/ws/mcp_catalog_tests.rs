use super::super::tests::{route, test_env, test_outbound};
use super::*;
use crate::web::mcp_catalog_api::tests::http_search;

async fn ws_search(payload: Value) -> WsReply {
    let relay = Arc::new(WsRelaySink::new());
    let acp = Arc::new(AcpManager::new(vec![]));
    let (tx, _rx) = test_outbound();
    let subscriptions = Arc::new(Subscriptions::default());
    let registry = Arc::new(ProjectRegistry::new());
    let frame = json!({ "id": "r1", "type": "search_mcp_catalog", "payload": payload }).to_string();
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
