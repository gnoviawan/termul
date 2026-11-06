use std::net::SocketAddr;

use axum::{
    body::Bytes,
    extract::{rejection::QueryRejection, ConnectInfo, DefaultBodyLimit, Path, Query, State},
    handler::Handler,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{post, MethodRouter},
    Json,
};
use serde::{Deserialize, Serialize};
use tracing::{debug, info, warn};

use crate::mcp_catalog::{
    CancelRequest, CommitRequest, FormRequest, Icon, McpCatalogError, McpCatalogPage,
    McpCatalogSearchRequest, McpCatalogService, McpCatalogStatus, PlanCaller, PlanRequest,
    MAX_PLAN_REQUEST_BYTES,
};
use crate::web::fs_api::{check_local_only, IpcBody};
use crate::web::ws::{AppState, MAX_CLIENT_ID_LEN};

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SetMcpCatalogSyncRequest {
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct McpCatalogIconRequest {
    pub name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCatalogIconPayload {
    pub content_type: &'static str,
    pub base64: String,
}

impl From<Icon> for McpCatalogIconPayload {
    fn from(icon: Icon) -> Self {
        use base64::Engine as _;
        Self {
            content_type: icon.content_type.mime(),
            base64: base64::engine::general_purpose::STANDARD.encode(&icon.bytes),
        }
    }
}

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

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "{T}WithClient")]
pub(crate) struct WithClient<T> {
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
