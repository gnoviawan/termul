use super::*;
use crate::mcp_catalog::{
    CancelRequest, CommitRequest, FormRequest, McpCatalogSearchRequest, McpCatalogService,
    PlanCaller, PlanRequest,
};

const TARGET: &str = "termul::web::ws";

fn invalid_request<T: serde::de::DeserializeOwned>(
    id: &str,
    request: &str,
    payload: &Value,
) -> Result<T, WsReply> {
    serde_json::from_value(payload.clone()).map_err(|error| {
        warn!(target: TARGET, request, category = ?error.classify(), "invalid mcp catalog request");
        WsReply::err_with_code(
            id.to_string(),
            "VALIDATION_ERROR",
            format!("invalid {request} request: {error}"),
        )
    })
}

fn refused(id: String, request: &str, error: &crate::mcp_catalog::McpCatalogError) -> WsReply {
    warn!(target: TARGET, request, code = error.code, error = %error.message, "mcp catalog request rejected");
    WsReply::err_with_code(id, error.code, error.message.clone())
}

pub(super) async fn handle_search_mcp_catalog(id: String, payload: &Value) -> WsReply {
    let request: McpCatalogSearchRequest = match invalid_request(&id, "search_mcp_catalog", payload)
    {
        Ok(request) => request,
        Err(reply) => return reply,
    };
    match McpCatalogService::shared().await.search(&request).await {
        Ok(page) => {
            info!(
                target: TARGET,
                query_chars = request.query.as_deref().map_or(0, |q| q.chars().count()),
                total = page.total,
                returned = page.items.len(),
                "search_mcp_catalog: served"
            );
            ok_with_payload(id, &page)
        }
        Err(error) => refused(id, "search_mcp_catalog", &error),
    }
}

pub(super) async fn handle_describe_mcp_install(id: String, payload: &Value) -> WsReply {
    let request: FormRequest = match invalid_request(&id, "describe_mcp_install", payload) {
        Ok(request) => request,
        Err(reply) => return reply,
    };
    match McpCatalogService::shared()
        .await
        .describe_install(&request)
        .await
    {
        Ok(reply) => ok_with_payload(id, &reply),
        Err(error) => refused(id, "describe_mcp_install", &error),
    }
}

pub(super) async fn handle_plan_mcp_install(id: String, payload: &Value, env: &HandlerEnv) -> WsReply {
    let request: PlanRequest = match invalid_request(&id, "plan_mcp_install", payload) {
        Ok(request) => request,
        Err(reply) => return reply,
    };
    let caller = PlanCaller::Connection(env.connection_id.to_string());
    match McpCatalogService::shared()
        .await
        .plan_install(&request, caller)
        .await
    {
        Ok(reply) => ok_with_payload(id, &reply),
        Err(error) => refused(id, "plan_mcp_install", &error),
    }
}

pub(super) async fn handle_commit_mcp_install(id: String, payload: &Value, env: &HandlerEnv) -> WsReply {
    let request: CommitRequest = match invalid_request(&id, "commit_mcp_install", payload) {
        Ok(request) => request,
        Err(reply) => return reply,
    };
    let caller = PlanCaller::Connection(env.connection_id.to_string());
    match McpCatalogService::shared()
        .await
        .commit_install(&request, &caller)
    {
        Ok(result) => ok_with_payload(id, &result),
        Err(error) => refused(id, "commit_mcp_install", &error),
    }
}

pub(super) async fn handle_cancel_mcp_install(id: String, payload: &Value, env: &HandlerEnv) -> WsReply {
    let request: CancelRequest = match invalid_request(&id, "cancel_mcp_install", payload) {
        Ok(request) => request,
        Err(reply) => return reply,
    };
    let caller = PlanCaller::Connection(env.connection_id.to_string());
    match McpCatalogService::shared()
        .await
        .cancel_install(&request, &caller)
    {
        Ok(()) => WsReply::ok(id, Some(json!({}))),
        Err(error) => refused(id, "cancel_mcp_install", &error),
    }
}

#[cfg(test)]
#[path = "mcp_catalog_tests.rs"]
mod tests;
