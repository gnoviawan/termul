use super::*;
use crate::mcp_catalog::{McpCatalogSearchRequest, McpCatalogService};
use crate::web::mcp_catalog_api::{
    McpCatalogIconPayload, McpCatalogIconRequest, SetMcpCatalogSyncRequest,
};

pub(super) async fn handle_search_mcp_catalog(id: String, payload: &Value) -> WsReply {
    let request: McpCatalogSearchRequest = match serde_json::from_value(payload.clone()) {
        Ok(request) => request,
        Err(error) => {
            tracing::warn!(target: "termul::web::ws", category = ?error.classify(), "search_mcp_catalog: invalid request");
            return WsReply::err_with_code(
                id,
                "VALIDATION_ERROR",
                format!("invalid mcp catalog search request: {error}"),
            );
        }
    };
    match McpCatalogService::shared().await.search(&request).await {
        Ok(page) => {
            tracing::info!(
                target: "termul::web::ws",
                query_chars = request.query.as_deref().map_or(0, |q| q.chars().count()),
                total = page.total,
                returned = page.items.len(),
                "search_mcp_catalog: served"
            );
            ok_with_payload(id, &page)
        }
        Err(error) => {
            tracing::warn!(target: "termul::web::ws", code = error.code, error = %error.message, "search_mcp_catalog: rejected");
            WsReply::err_with_code(id, error.code, error.message)
        }
    }
}

pub(super) async fn handle_get_mcp_catalog_status(id: String) -> WsReply {
    ok_with_payload(id, &McpCatalogService::shared().await.status())
}

pub(super) async fn handle_set_mcp_catalog_sync(id: String, payload: &Value) -> WsReply {
    let request: SetMcpCatalogSyncRequest = match serde_json::from_value(payload.clone()) {
        Ok(request) => request,
        Err(error) => {
            tracing::warn!(target: "termul::web::ws", category = ?error.classify(), "set_mcp_catalog_sync: invalid request");
            return WsReply::err_with_code(
                id,
                "VALIDATION_ERROR",
                format!("invalid mcp catalog sync request: {error}"),
            );
        }
    };
    match McpCatalogService::shared()
        .await
        .set_sync(request.enabled)
        .await
    {
        Ok(status) => {
            tracing::info!(target: "termul::web::ws", enabled = request.enabled, "set_mcp_catalog_sync: saved");
            ok_with_payload(id, &status)
        }
        Err(error) => {
            tracing::warn!(target: "termul::web::ws", code = error.code, "set_mcp_catalog_sync: rejected");
            WsReply::err_with_code(id, error.code, error.message)
        }
    }
}

pub(super) async fn handle_get_mcp_catalog_icon(id: String, payload: &Value) -> WsReply {
    let request: McpCatalogIconRequest = match serde_json::from_value(payload.clone()) {
        Ok(request) => request,
        Err(error) => {
            tracing::warn!(target: "termul::web::ws", category = ?error.classify(), "get_mcp_catalog_icon: invalid request");
            return WsReply::err_with_code(
                id,
                "VALIDATION_ERROR",
                format!("invalid mcp catalog icon request: {error}"),
            );
        }
    };
    match McpCatalogService::shared().await.icon(&request.name).await {
        Ok(icon) => ok_with_payload(id, &McpCatalogIconPayload::from(icon)),
        Err(error) => {
            tracing::debug!(target: "termul::web::ws", code = error.code, "get_mcp_catalog_icon: unavailable");
            WsReply::err_with_code(id, error.code, error.message)
        }
    }
}

#[cfg(test)]
#[path = "mcp_catalog_tests.rs"]
mod tests;
