//! HTTP adapter for the host-owned MCP catalog (spine AD-1).
//!
//! `GET /mcp-catalog/search?query=&cursor=&limit=` answers one page from
//! [`McpCatalogService`], the same call the `/ws` `search_mcp_catalog`
//! request makes, so both return the same `IpcBody` for the same request.
//! Search is a read: view-only and shared-live clients may call it.

use axum::{
    extract::{rejection::QueryRejection, Query},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use tracing::{info, warn};

use crate::mcp_catalog::{McpCatalogPage, McpCatalogSearchRequest, McpCatalogService};
use crate::web::fs_api::IpcBody;

const TARGET: &str = "termul::web::mcp_catalog_api";

pub async fn search(
    query: Result<Query<McpCatalogSearchRequest>, QueryRejection>,
) -> impl IntoResponse {
    let request = match query {
        Ok(Query(request)) => request,
        Err(rejection) => {
            warn!(target: TARGET, error = %rejection.body_text(), "search: invalid request");
            return (
                StatusCode::OK,
                Json(IpcBody::<McpCatalogPage>::err(
                    format!(
                        "invalid mcp catalog search request: {}",
                        rejection.body_text()
                    ),
                    "VALIDATION_ERROR",
                )),
            );
        }
    };
    match McpCatalogService::shared().await.search(&request).await {
        Ok(page) => {
            info!(
                target: TARGET,
                query_chars = request.query.as_deref().map_or(0, |q| q.chars().count()),
                total = page.total,
                returned = page.items.len(),
                "search: served"
            );
            (StatusCode::OK, Json(IpcBody::ok(page)))
        }
        Err(error) => {
            warn!(target: TARGET, code = error.code, error = %error.message, "search: rejected");
            (
                StatusCode::OK,
                Json(IpcBody::err(error.message, error.code)),
            )
        }
    }
}

#[cfg(test)]
pub(crate) mod tests;
