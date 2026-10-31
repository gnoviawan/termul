use std::net::SocketAddr;

use axum::{
    body::Bytes,
    extract::{rejection::QueryRejection, ConnectInfo, Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use tracing::{debug, info, warn};

use crate::mcp_catalog::{
    Icon, McpCatalogPage, McpCatalogSearchRequest, McpCatalogService, McpCatalogStatus,
};
use crate::web::fs_api::{check_local_only, IpcBody};
use crate::web::ws::AppState;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetMcpCatalogSyncRequest {
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct McpCatalogIconRequest {
    pub name: String,
}

/// The `/ws` shape of a logo: JSON frames carry the bytes as base64.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCatalogIconPayload {
    pub content_type: &'static str,
    pub data: String,
}

impl From<Icon> for McpCatalogIconPayload {
    fn from(icon: Icon) -> Self {
        use base64::Engine as _;
        Self {
            content_type: icon.content_type.mime(),
            data: base64::engine::general_purpose::STANDARD.encode(&icon.bytes),
        }
    }
}

const TARGET: &str = "termul::web::mcp_catalog_api";

/// An SVG opened as a page instead of through `<img>` runs no script.
const ICON_CSP: &str = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
const ICON_CACHE_CONTROL: &str = "private, max-age=86400";

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

/// `GET /mcp-catalog/icon/<name>`: the logo bytes, for an `<img>` on every
/// web surface. The publisher URL never leaves the host (AD-15).
pub async fn icon(Path(name): Path<String>) -> Response {
    match McpCatalogService::shared().await.icon(&name).await {
        Ok(icon) => {
            debug!(target: TARGET, bytes = icon.bytes.len(), "icon: served");
            (
                [
                    (header::CONTENT_TYPE, icon.content_type.mime()),
                    (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
                    (header::CONTENT_SECURITY_POLICY, ICON_CSP),
                    (header::CACHE_CONTROL, ICON_CACHE_CONTROL),
                ],
                icon.bytes.to_vec(),
            )
                .into_response()
        }
        Err(error) => {
            debug!(target: TARGET, code = error.code, "icon: unavailable");
            (
                StatusCode::NOT_FOUND,
                Json(IpcBody::<()>::err(error.message, error.code)),
            )
                .into_response()
        }
    }
}

#[cfg(test)]
pub(crate) mod tests;
