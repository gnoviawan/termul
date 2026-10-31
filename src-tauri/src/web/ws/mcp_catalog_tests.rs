use super::super::tests::{route, test_env, test_outbound};
use super::*;
use crate::web::mcp_catalog_api::tests::{
    http_install_local, http_search, http_status, import_plan_body,
};

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

fn env() -> HandlerEnv {
    let relay = Arc::new(WsRelaySink::new());
    let acp = Arc::new(AcpManager::new(vec![]));
    let (tx, _rx) = test_outbound();
    let subscriptions = Arc::new(Subscriptions::default());
    let registry = Arc::new(ProjectRegistry::new());
    test_env(&acp, &relay, &registry, &tx, &subscriptions)
}

async fn ws_call(env: &HandlerEnv, request_type: &str, payload: Value) -> Value {
    let frame = json!({ "id": "r1", "type": request_type, "payload": payload }).to_string();
    as_ipc_result(route(&frame, env).await)
}

fn ws_plan_payload() -> Value {
    let mut body = import_plan_body("unused");
    body.as_object_mut().unwrap().remove("clientInstanceId");
    body
}

#[tokio::test]
async fn ws_and_http_describe_the_same_form() {
    let request = json!({ "source": { "kind": "catalog", "name": "com.tre-app/tre", "version": "0.2.0" } });
    let ws = ws_call(&env(), "describe_mcp_install", request.clone()).await;
    let http = http_install_local("form", &request).await;
    assert_eq!(ws["success"], true, "{ws}");
    assert_eq!(ws["data"], http["data"]);
}

#[tokio::test]
async fn ws_and_http_plan_commit_and_cancel_alike() {
    let env = env();
    let ws_planned = ws_call(&env, "plan_mcp_install", ws_plan_payload()).await;
    let http_planned = http_install_local("plan", &import_plan_body("tab-a")).await;
    assert_eq!(ws_planned["success"], true, "{ws_planned}");
    assert_eq!(http_planned["success"], true, "{http_planned}");
    let (ws_plan, http_plan) = (&ws_planned["data"]["plan"], &http_planned["data"]["plan"]);
    for key in ["name", "source", "choice", "config", "form", "consentView", "launchDigest"] {
        assert_eq!(ws_plan[key], http_plan[key], "{key}");
    }
    assert_ne!(ws_plan["planId"], http_plan["planId"]);

    let ws_committed = ws_call(
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

    let ws_again = ws_call(
        &env,
        "commit_mcp_install",
        json!({ "planId": ws_plan["planId"], "launchDigest": ws_plan["launchDigest"], "secretValues": {} }),
    )
    .await;
    assert_eq!(ws_again["code"], "MCP_PLAN_CONSUMED");

    let ws_cancelled = ws_call(&env, "cancel_mcp_install", json!({ "planId": ws_plan["planId"] })).await;
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
    let planned = ws_call(&maker, "plan_mcp_install", ws_plan_payload()).await;
    let plan = &planned["data"]["plan"];
    let other = env();
    let commit = json!({ "planId": plan["planId"], "launchDigest": plan["launchDigest"], "secretValues": {} });
    let refused = ws_call(&other, "commit_mcp_install", commit.clone()).await;
    assert_eq!(refused["code"], "MCP_PLAN_WRONG_CALLER");
    let wrong_digest = ws_call(
        &maker,
        "commit_mcp_install",
        json!({ "planId": plan["planId"], "launchDigest": "sha256:00", "secretValues": {} }),
    )
    .await;
    assert_eq!(wrong_digest["code"], "MCP_PLAN_MISMATCH");
    let gone = ws_call(&maker, "commit_mcp_install", commit).await;
    assert_eq!(gone["code"], "MCP_PLAN_NOT_FOUND");
}

#[tokio::test]
async fn ws_and_http_refuse_a_malformed_install_request_alike() {
    let ws = ws_call(&env(), "plan_mcp_install", json!({ "source": { "kind": "nope" } })).await;
    let http = http_install_local(
        "plan",
        &json!({ "clientInstanceId": "tab-a", "source": { "kind": "nope" } }),
    )
    .await;
    assert_eq!(ws["code"], "VALIDATION_ERROR");
    assert_eq!(http["code"], "VALIDATION_ERROR");
    let unsupported = ws_call(
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

#[tokio::test]
async fn a_closed_connection_drops_its_install_plans() {
    let env = env();
    let planned = ws_call(&env, "plan_mcp_install", ws_plan_payload()).await;
    let plan = &planned["data"]["plan"];
    let cleanup = ConnectionCleanup::new(Arc::new(WsRelaySink::new()), Arc::new(Subscriptions::default()))
        .with_install_plans(env.connection_id.to_string());
    cleanup.run().await;
    let commit = json!({ "planId": plan["planId"], "launchDigest": plan["launchDigest"], "secretValues": {} });
    let gone = ws_call(&env, "commit_mcp_install", commit).await;
    assert_eq!(gone["code"], "MCP_PLAN_NOT_FOUND");
}

#[tokio::test]
async fn a_commit_resent_with_its_command_id_runs_again_instead_of_replaying_secrets() {
    let env = env();
    let planned = ws_call(&env, "plan_mcp_install", ws_plan_payload()).await;
    let plan = &planned["data"]["plan"];
    let frame = json!({
        "id": "r1",
        "type": "commit_mcp_install",
        "commandId": "commit-1",
        "payload": { "planId": plan["planId"], "launchDigest": plan["launchDigest"], "secretValues": {} }
    });
    let send = || super::super::commands::execute_request(serde_json::from_value(frame.clone()).unwrap(), &env);
    let first = as_ipc_result(send().await);
    assert_eq!(first["data"]["secrets"][0]["value"], "from-file", "{first}");
    let resent = as_ipc_result(send().await);
    assert_eq!(resent["code"], "MCP_PLAN_CONSUMED", "{resent}");
}
