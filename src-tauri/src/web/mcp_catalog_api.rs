use std::net::SocketAddr;

use axum::{
    body::Bytes,
    extract::{rejection::QueryRejection, ConnectInfo, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use tracing::{info, warn};

use crate::mcp_catalog::{
    McpCatalogPage, McpCatalogSearchRequest, McpCatalogService, McpCatalogStatus,
};
use crate::web::fs_api::{check_local_only, IpcBody};
use crate::web::ws::AppState;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetMcpCatalogSyncRequest {
    pub enabled: bool,
}

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

pub async fn status() -> Json<IpcBody<McpCatalogStatus>> {
    Json(IpcBody::ok(McpCatalogService::shared().await.status()))
}

pub async fn set_sync(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    body: Bytes,
) -> Json<IpcBody<McpCatalogStatus>> {
    if let Some(forbidden) = check_local_only(
        peer,
        state.allow_remote_writes,
        state.shared_live_writes_denied,
        "/mcp-catalog/sync",
    ) {
        return Json(forbidden);
    }
    let request: SetMcpCatalogSyncRequest = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(error) => {
            warn!(target: TARGET, category = ?error.classify(), "set_sync: invalid request");
            return Json(IpcBody::err(
                format!("invalid mcp catalog sync request: {error}"),
                "VALIDATION_ERROR",
            ));
        }
    };
    match McpCatalogService::shared()
        .await
        .set_sync(request.enabled)
        .await
    {
        Ok(status) => {
            info!(target: TARGET, enabled = request.enabled, "set_sync: saved");
            Json(IpcBody::ok(status))
        }
        Err(error) => {
            warn!(target: TARGET, code = error.code, "set_sync: rejected");
            Json(IpcBody::err(error.message, error.code))
        }
    }
}

#[cfg(test)]
pub(crate) mod tests;
