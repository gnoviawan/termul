//! `/ws` adapter for the host-owned MCP catalog (spine AD-1). The desktop
//! channel and the web socket both route `search_mcp_catalog` here, and it
//! answers through the same [`McpCatalogService`] call as
//! `GET /mcp-catalog/search`.

use super::*;
use crate::mcp_catalog::{McpCatalogSearchRequest, McpCatalogService};

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

#[cfg(test)]
#[path = "mcp_catalog_tests.rs"]
mod tests;
