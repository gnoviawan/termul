//! HTTP adapter for the host-owned MCP catalog (spine AD-1).
//!
//! `GET /mcp-catalog/search?query=&cursor=&limit=` answers one page from
//! [`McpCatalogService`], the same call the `/ws` `search_mcp_catalog`
//! request makes, so both return the same `IpcBody` for the same request.
//! Search is a read: view-only and shared-live clients may call it.

use std::net::SocketAddr;

use axum::{
    body::Bytes,
    extract::{rejection::QueryRejection, ConnectInfo, DefaultBodyLimit, Query, State},
    handler::Handler,
    http::StatusCode,
    response::IntoResponse,
    routing::{post, MethodRouter},
    Json,
};
use serde::Deserialize;
use tracing::{info, warn};

use crate::mcp_catalog::{
    CancelRequest, CommitRequest, FormRequest, McpCatalogError, McpCatalogPage,
    McpCatalogSearchRequest, McpCatalogService, PlanCaller, PlanRequest, MAX_PLAN_REQUEST_BYTES,
};
use crate::web::fs_api::{check_local_only, IpcBody};
use crate::web::ws::{AppState, MAX_CLIENT_ID_LEN};

const TARGET: &str = "termul::web::mcp_catalog_api";

/// An install body is a plan request (bounded by [`MAX_PLAN_REQUEST_BYTES`]
/// once parsed) wrapped in JSON, whose string escaping can grow it.
pub const MAX_INSTALL_BODY_BYTES: usize = 4 * MAX_PLAN_REQUEST_BYTES;

/// `POST` for an install route, refusing a body over
/// [`MAX_INSTALL_BODY_BYTES`] before it is buffered.
pub fn install_route<H, T>(handler: H) -> MethodRouter<AppState>
where
    H: Handler<T, AppState>,
    T: 'static,
{
    post(handler).layer(DefaultBodyLimit::max(MAX_INSTALL_BODY_BYTES))
}

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
        Err(error) => (StatusCode::OK, Json(rejected("search", &error))),
    }
}

fn rejected<T>(route: &str, error: &McpCatalogError) -> IpcBody<T> {
    warn!(target: TARGET, route, code = error.code, error = %error.message, "install request rejected");
    IpcBody::err(error.message.clone(), error.code)
}

fn parse_body<T: serde::de::DeserializeOwned, R>(route: &str, body: &Bytes) -> Result<T, IpcBody<R>> {
    serde_json::from_slice(body).map_err(|error| {
        warn!(target: TARGET, route, category = ?error.classify(), "install request malformed");
        IpcBody::err(
            format!("invalid {route} request: {error}"),
            "VALIDATION_ERROR",
        )
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WithClient<T> {
    client_instance_id: String,
    #[serde(flatten)]
    request: T,
}

/// Parses the body and holds its `clientInstanceId` to the rule `/ws`
/// `authenticate` applies, since the id keys plans and reaches log lines.
fn parse_client_body<T: serde::de::DeserializeOwned, R>(
    route: &str,
    body: &Bytes,
) -> Result<(PlanCaller, T), IpcBody<R>> {
    let WithClient {
        client_instance_id: id,
        request,
    } = parse_body(route, body)?;
    if id.is_empty() || id.len() > MAX_CLIENT_ID_LEN || id.chars().any(char::is_control) {
        warn!(target: TARGET, route, "install request has an invalid client id");
        return Err(IpcBody::err(
            format!(
                "clientInstanceId must be a non-empty id of at most {MAX_CLIENT_ID_LEN} bytes without control characters"
            ),
            "VALIDATION_ERROR",
        ));
    }
    Ok((PlanCaller::Client(id), request))
}

/// `POST /mcp-catalog/install/form` body `McpInstallFormRequest` →
/// `IpcBody<McpInstallFormReply>`. A read.
pub async fn describe_install(body: Bytes) -> impl IntoResponse {
    let request: FormRequest = match parse_body("install/form", &body) {
        Ok(request) => request,
        Err(invalid) => return Json(invalid),
    };
    let reply = match McpCatalogService::shared()
        .await
        .describe_install(&request)
        .await
    {
        Ok(reply) => IpcBody::ok(reply),
        Err(error) => rejected("install/form", &error),
    };
    Json(reply)
}

fn write_guard<T>(state: &AppState, peer: SocketAddr, route: &'static str) -> Option<IpcBody<T>> {
    check_local_only::<T>(
        peer,
        state.allow_remote_writes,
        state.shared_live_writes_denied,
        route,
    )
}

/// `POST /mcp-catalog/install/plan` body `McpInstallPlanRequest &
/// { clientInstanceId }` → `IpcBody<McpInstallPlanReply>`.
pub async fn plan_install(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    body: Bytes,
) -> impl IntoResponse {
    if let Some(forbidden) = write_guard(&state, peer, "/mcp-catalog/install/plan") {
        return Json(forbidden);
    }
    let (caller, request): (PlanCaller, PlanRequest) = match parse_client_body("install/plan", &body) {
        Ok(parsed) => parsed,
        Err(invalid) => return Json(invalid),
    };
    let reply = match McpCatalogService::shared()
        .await
        .plan_install(&request, caller)
        .await
    {
        Ok(reply) => IpcBody::ok(reply),
        Err(error) => rejected("install/plan", &error),
    };
    Json(reply)
}

/// `POST /mcp-catalog/install/commit` body `McpInstallCommitRequest &
/// { clientInstanceId }` → `IpcBody<McpInstallCommitResult>`.
pub async fn commit_install(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    body: Bytes,
) -> impl IntoResponse {
    if let Some(forbidden) = write_guard(&state, peer, "/mcp-catalog/install/commit") {
        return Json(forbidden);
    }
    let (caller, request): (PlanCaller, CommitRequest) = match parse_client_body("install/commit", &body) {
        Ok(parsed) => parsed,
        Err(invalid) => return Json(invalid),
    };
    let reply = match McpCatalogService::shared()
        .await
        .commit_install(&request, &caller)
    {
        Ok(result) => IpcBody::ok(result),
        Err(error) => rejected("install/commit", &error),
    };
    Json(reply)
}

/// `POST /mcp-catalog/install/cancel` body `McpInstallCancelRequest &
/// { clientInstanceId }` → `IpcBody<{}>`.
pub async fn cancel_install(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    body: Bytes,
) -> impl IntoResponse {
    if let Some(forbidden) = write_guard(&state, peer, "/mcp-catalog/install/cancel") {
        return Json(forbidden);
    }
    let (caller, request): (PlanCaller, CancelRequest) = match parse_client_body("install/cancel", &body) {
        Ok(parsed) => parsed,
        Err(invalid) => return Json(invalid),
    };
    let reply = match McpCatalogService::shared()
        .await
        .cancel_install(&request, &caller)
    {
        Ok(()) => IpcBody::ok(serde_json::json!({})),
        Err(error) => rejected("install/cancel", &error),
    };
    Json(reply)
}

#[cfg(test)]
pub(crate) mod tests;
