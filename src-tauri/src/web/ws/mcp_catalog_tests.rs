use super::super::tests::{route, test_env, test_outbound};
use super::*;
use crate::web::mcp_catalog_api::tests::{http_install_local, http_search, import_plan_body};

fn env() -> HandlerEnv {
    let relay = Arc::new(WsRelaySink::new());
    let acp = Arc::new(AcpManager::new(vec![]));
    let (tx, _rx) = test_outbound();
    let subscriptions = Arc::new(Subscriptions::default());
    let registry = Arc::new(ProjectRegistry::new());
    test_env(&acp, &relay, &registry, &tx, &subscriptions)
}

async fn ws_request(env: &HandlerEnv, request_type: &str, payload: Value) -> Value {
    let frame = json!({ "id": "r1", "type": request_type, "payload": payload }).to_string();
    as_ipc_result(route(&frame, env).await)
}

async fn ws_search(payload: Value) -> WsReply {
    let frame = json!({ "id": "r1", "type": "search_mcp_catalog", "payload": payload }).to_string();
    route(&frame, &env()).await
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

fn ws_plan_payload() -> Value {
    let mut body = import_plan_body("unused");
    body.as_object_mut().unwrap().remove("clientInstanceId");
    body
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
async fn ws_and_http_describe_the_same_form() {
    let request = json!({ "source": { "kind": "catalog", "name": "com.tre-app/tre", "version": "0.2.0" } });
    let ws = ws_request(&env(), "describe_mcp_install", request.clone()).await;
    let http = http_install_local("form", &request).await;
    assert_eq!(ws["success"], true, "{ws}");
    assert_eq!(ws["data"], http["data"]);
}

#[tokio::test]
async fn ws_and_http_plan_commit_and_cancel_alike() {
    let env = env();
    let ws_planned = ws_request(&env, "plan_mcp_install", ws_plan_payload()).await;
    let http_planned = http_install_local("plan", &import_plan_body("tab-a")).await;
    assert_eq!(ws_planned["success"], true, "{ws_planned}");
    assert_eq!(http_planned["success"], true, "{http_planned}");
    let (ws_plan, http_plan) = (&ws_planned["data"]["plan"], &http_planned["data"]["plan"]);
    for key in ["name", "source", "choice", "config", "form", "consentView", "launchDigest"] {
        assert_eq!(ws_plan[key], http_plan[key], "{key}");
    }
    assert_ne!(ws_plan["planId"], http_plan["planId"]);

    let ws_committed = ws_request(
        &env,
        "commit_mcp_install",
        json!({ "planId": ws_plan["planId"], "launchDigest": ws_plan["launchDigest"], "secretValues": {} }),
    )
    .await;
    let http_committed = http_install_local(
        "commit",
        &json!({
            "clientInstanceId": "tab-a",
            "planId": http_plan["planId"],
            "launchDigest": http_plan["launchDigest"],
            "secretValues": {}
        }),
    )
    .await;
    assert_eq!(ws_committed["success"], true, "{ws_committed}");
    assert_eq!(ws_committed, http_committed);

    let ws_again = ws_request(
        &env,
        "commit_mcp_install",
        json!({ "planId": ws_plan["planId"], "launchDigest": ws_plan["launchDigest"], "secretValues": {} }),
    )
    .await;
    assert_eq!(ws_again["code"], "MCP_PLAN_CONSUMED");

    let ws_cancelled = ws_request(&env, "cancel_mcp_install", json!({ "planId": ws_plan["planId"] })).await;
    let http_cancelled = http_install_local(
        "cancel",
        &json!({ "clientInstanceId": "tab-a", "planId": http_plan["planId"] }),
    )
    .await;
    assert_eq!(ws_cancelled, json!({ "success": true, "data": {} }));
    assert_eq!(ws_cancelled, http_cancelled);
}

#[tokio::test]
async fn a_plan_is_bound_to_the_connection_that_made_it() {
    let maker = env();
    let planned = ws_request(&maker, "plan_mcp_install", ws_plan_payload()).await;
    let plan = &planned["data"]["plan"];
    let other = env();
    let commit = json!({ "planId": plan["planId"], "launchDigest": plan["launchDigest"], "secretValues": {} });
    let refused = ws_request(&other, "commit_mcp_install", commit.clone()).await;
    assert_eq!(refused["code"], "MCP_PLAN_WRONG_CALLER");
    let wrong_digest = ws_request(
        &maker,
        "commit_mcp_install",
        json!({ "planId": plan["planId"], "launchDigest": "sha256:00", "secretValues": {} }),
    )
    .await;
    assert_eq!(wrong_digest["code"], "MCP_PLAN_MISMATCH");
    let gone = ws_request(&maker, "commit_mcp_install", commit).await;
    assert_eq!(gone["code"], "MCP_PLAN_NOT_FOUND");
}

#[tokio::test]
async fn ws_and_http_refuse_a_malformed_install_request_alike() {
    let ws = ws_request(&env(), "plan_mcp_install", json!({ "source": { "kind": "nope" } })).await;
    let http = http_install_local(
        "plan",
        &json!({ "clientInstanceId": "tab-a", "source": { "kind": "nope" } }),
    )
    .await;
    assert_eq!(ws["code"], "VALIDATION_ERROR");
    assert_eq!(http["code"], "VALIDATION_ERROR");
    let unsupported = ws_request(
        &env(),
        "plan_mcp_install",
        json!({ "source": { "kind": "import", "json": r#"{"command":"npx","env":{"NODE_OPTIONS":"x"}}"# }, "inputs": {} }),
    )
    .await;
    assert_eq!(
        unsupported["data"],
        json!({ "outcome": "unsupported", "reason": { "code": "denied-env", "name": "NODE_OPTIONS" } })
    );
}
