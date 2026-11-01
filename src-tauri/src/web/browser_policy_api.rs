//! Browser policy web routes: the HTTP twins of the `browser_policy_*` Tauri
//! commands. Both call [`BrowserPolicyService`], so a given operation
//! sequence returns the same body on either transport (`IpcBody`, HTTP 200
//! for app-level refusals).
//!
//! - `GET  /host/browser-policy/app`
//! - `POST /host/browser-policy/app` `{expectedRevision, op}`
//! - `GET  /host/browser-policy/project?projectId=`
//! - `POST /host/browser-policy/project` `{projectId, expectedRevision, op}`
//!
//! The `/host/` prefix is bearer-gated whenever the host runs a token gate.
//! The only credential a host issues is its web token, so a request that
//! passed the gate holds app scope. Without a gate only loopback peers are
//! served. The `POST` routes are host-state writes and take the shared
//! remote-write guard (`check_local_only`): a non-loopback peer needs
//! `--allow-remote-writes`, and the desktop shared-live host refuses every
//! edit, because a tunnel forwards public traffic from loopback and a leaked
//! token must not widen the allow-list or pre-approve prompts away.
//! A host with no policy service (`termul-server`) answers
//! `capability_unavailable`.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::rejection::JsonRejection;
use axum::extract::{ConnectInfo, Query, State};
use axum::http::request::Parts;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::Value;

use crate::acp::browser_policy::{
    AppPolicyView, BrowserPolicyService, CallerScope, PolicyRefusal, ProjectPolicyView,
};
use crate::web::auth::BearerVerified;
use crate::web::capabilities::WriteFlags;
use crate::web::fs_api::{check_local_only, IpcBody};

#[derive(Clone)]
pub struct PolicyRouteState {
    /// `None` on a host without browser policy.
    pub service: Option<Arc<BrowserPolicyService>>,
    /// Whether the host runs a bearer-token gate. Without one only loopback
    /// peers are served.
    pub token_gated: bool,
    /// Deployment flags for the shared remote-write guard on the `POST`
    /// routes.
    pub write_flags: WriteFlags,
}

const APP_ROUTE: &str = "/host/browser-policy/app";
const PROJECT_ROUTE: &str = "/host/browser-policy/project";

pub fn browser_policy_router<S>(state: PolicyRouteState) -> Router<S> {
    Router::new()
        .route(APP_ROUTE, get(get_app).post(apply_app))
        .route(PROJECT_ROUTE, get(get_project).post(apply_project))
        .with_state(state)
}

fn body<T>(result: Result<T, PolicyRefusal>) -> Json<IpcBody<T>> {
    Json(match result {
        Ok(data) => IpcBody::ok(data),
        Err(refusal) => IpcBody::err(refusal.envelope_error(), refusal.code().as_str()),
    })
}

fn refuse<T>(refusal: PolicyRefusal) -> Json<IpcBody<T>> {
    body(Err(refusal))
}

/// The service, once the caller is admitted. `write_route` names a `POST`
/// route, which also has to pass the remote-write guard.
fn caller<T>(
    state: &PolicyRouteState,
    parts: &Parts,
    peer: SocketAddr,
    write_route: Option<&str>,
) -> Result<Arc<BrowserPolicyService>, Json<IpcBody<T>>> {
    let admitted = parts.extensions.get::<BearerVerified>().is_some()
        || (!state.token_gated && peer.ip().is_loopback());
    if !admitted {
        tracing::warn!(
            target: "termul::web::browser_policy",
            peer = %peer,
            "browser policy request refused: no verified bearer token"
        );
        return Err(Json(IpcBody::err(
            "browser policy needs the host token",
            "FORBIDDEN",
        )));
    }
    if let Some(route) = write_route {
        if let Some(forbidden) = check_local_only::<T>(
            peer,
            state.write_flags.allow_remote_writes,
            state.write_flags.shared_live_writes_denied,
            route,
        ) {
            return Err(Json(forbidden));
        }
    }
    state
        .service
        .clone()
        .ok_or_else(|| refuse(PolicyRefusal::StoreUnavailable))
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectQuery {
    #[serde(default)]
    project_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApplyProjectBody {
    project_id: String,
    expected_revision: u64,
    // Parsed into a `ProjectOpWire` by the service; the spec documents that shape.
    #[schemars(with = "crate::acp::browser_policy::ProjectOpWire")]
    op: Value,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApplyAppBody {
    expected_revision: u64,
    // Parsed into an `AppOpWire` by the service; the spec documents that shape.
    #[schemars(with = "crate::acp::browser_policy::AppOpWire")]
    op: Value,
}

async fn get_app(
    State(state): State<PolicyRouteState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    parts: Parts,
) -> Json<IpcBody<AppPolicyView>> {
    match caller(&state, &parts, peer, None) {
        Ok(service) => body(service.app_view(&CallerScope::App).await),
        Err(refused) => refused,
    }
}

async fn apply_app(
    State(state): State<PolicyRouteState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    parts: Parts,
    request: Result<Json<ApplyAppBody>, JsonRejection>,
) -> Json<IpcBody<AppPolicyView>> {
    let service = match caller(&state, &parts, peer, Some(APP_ROUTE)) {
        Ok(service) => service,
        Err(refused) => return refused,
    };
    match request {
        Ok(Json(request)) => body(
            service
                .apply_app(&CallerScope::App, request.expected_revision, &request.op)
                .await,
        ),
        Err(_) => refuse(PolicyRefusal::MalformedOperation),
    }
}

async fn get_project(
    State(state): State<PolicyRouteState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    parts: Parts,
    Query(query): Query<ProjectQuery>,
) -> Json<IpcBody<ProjectPolicyView>> {
    match caller(&state, &parts, peer, None) {
        Ok(service) => body(
            service
                .project_view(&CallerScope::App, &query.project_id)
                .await,
        ),
        Err(refused) => refused,
    }
}

async fn apply_project(
    State(state): State<PolicyRouteState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    parts: Parts,
    request: Result<Json<ApplyProjectBody>, JsonRejection>,
) -> Json<IpcBody<ProjectPolicyView>> {
    let service = match caller(&state, &parts, peer, Some(PROJECT_ROUTE)) {
        Ok(service) => service,
        Err(refused) => return refused,
    };
    match request {
        Ok(Json(request)) => body(
            service
                .apply_project(
                    &CallerScope::App,
                    &request.project_id,
                    request.expected_revision,
                    &request.op,
                )
                .await,
        ),
        Err(_) => refuse(PolicyRefusal::MalformedOperation),
    }
}

#[cfg(test)]
#[path = "browser_policy_api_tests.rs"]
mod tests;
