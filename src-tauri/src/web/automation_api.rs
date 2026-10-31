//! Automation web routes: the HTTP twins of the `automation_*` Tauri
//! commands, one per row of the contract's Operations table. Bodies and
//! query keys are snake_case. A success is the `IpcBody` envelope with HTTP
//! 200; a failure carries the service's stable code and an HTTP status:
//!
//! | code | status |
//! |---|---|
//! | `not_found` | 404 |
//! | `revision_conflict` (with `current_revision`), `not_approved` | 409 |
//! | `has_issues`, `invalid_ops`, `invalid_input`, `secret_missing` | 422 |
//! | `keychain_unavailable`, `unavailable` (no service on this host) | 503 |
//! | `FORBIDDEN` (no token, or the remote-write guard) | 403 |
//! | `internal` | 500 |
//!
//! Admission matches the browser policy routes: `/api/automation` is a
//! bearer-gated prefix, an ungated host serves only loopback peers, and every
//! mutation takes the shared remote-write guard (`check_local_only`), so the
//! desktop shared-live host refuses edits and a non-loopback peer of
//! `termul-server` needs `--allow-remote-writes`.
//!
//! [`forward_changes`] carries the service's change events to the `agents`
//! watch as `{event: "automation_changed", payload}`.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::rejection::JsonRejection;
use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::broadcast::{self, error::RecvError};

use crate::automation::model::{AutomationChanged, AutomationId, RunId, EVENT_AUTOMATION_CHANGED};
use crate::automation::service::{AutomationService, ServiceError, ServiceResult};
use crate::commands::automation::{
    delete_secret, parse_ops, preview_schedule, set_secret, UNAVAILABLE,
};
use crate::web::auth::BearerVerified;
use crate::web::capabilities::WriteFlags;
use crate::web::fs_api::{check_local_only, IpcBody};
use crate::web::sink::WsRelaySink;
use crate::web::watch::publish_agent_event;

const LOG_TARGET: &str = "termul::web::automation";
const DEFAULT_RUNS_LIMIT: usize = 50;

#[derive(Clone)]
pub struct AutomationRouteState {
    /// `None` when the host's automation store could not open.
    pub service: Option<Arc<AutomationService>>,
    /// Whether the host runs a bearer-token gate. Without one only loopback
    /// peers are served.
    pub token_gated: bool,
    /// Deployment flags for the remote-write guard on the mutations.
    pub write_flags: WriteFlags,
}

const AUTOMATIONS: &str = "/api/automations";
const PREVIEW: &str = "/api/automations/preview-schedule";
const AUTOMATION: &str = "/api/automations/{id}";
const OPS: &str = "/api/automations/{id}/ops";
const ENABLED: &str = "/api/automations/{id}/enabled";
const APPROVE: &str = "/api/automations/{id}/approve";
const RUN: &str = "/api/automations/{id}/run";
const RUNS: &str = "/api/automations/{id}/runs";
const SEEN: &str = "/api/automations/{id}/seen";
const CANCEL_RUN: &str = "/api/automation-runs/{run_id}/cancel";
const RUN_STEPS: &str = "/api/automation-runs/{run_id}/steps";
const AGENTS: &str = "/api/automation-agents";
const SECRETS: &str = "/api/automation-secrets";

pub fn automation_router<S>(state: AutomationRouteState) -> Router<S> {
    Router::new()
        .route(AUTOMATIONS, get(list).post(create))
        .route(PREVIEW, post(preview))
        .route(AUTOMATION, get(get_one).delete(delete_one))
        .route(OPS, post(apply_ops))
        .route(ENABLED, post(set_enabled))
        .route(APPROVE, post(approve))
        .route(RUN, post(run_now))
        .route(RUNS, get(list_runs))
        .route(SEEN, post(mark_seen))
        .route(CANCEL_RUN, post(cancel_run))
        .route(RUN_STEPS, get(run_steps))
        .route(AGENTS, get(list_agents))
        .route(
            SECRETS,
            get(list_secrets).put(put_secret).delete(remove_secret),
        )
        .with_state(state)
}

/// Handlers `?` admission and body parsing into the failure reply.
type Reply = Result<Response, Refusal>;

/// A failure reply: the `IpcBody` failure shape plus `current_revision` on a
/// revision conflict.
#[derive(Serialize)]
struct Refusal {
    #[serde(skip)]
    status: StatusCode,
    success: bool,
    error: String,
    code: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_revision: Option<u64>,
}

impl Refusal {
    fn new(status: StatusCode, code: &'static str, error: impl Into<String>) -> Self {
        Self {
            status,
            success: false,
            error: error.into(),
            code,
            current_revision: None,
        }
    }
}

impl IntoResponse for Refusal {
    fn into_response(self) -> Response {
        (self.status, Json(self)).into_response()
    }
}

fn status_of(code: &str) -> StatusCode {
    match code {
        "not_found" => StatusCode::NOT_FOUND,
        "revision_conflict" | "not_approved" => StatusCode::CONFLICT,
        "has_issues" | "invalid_ops" | "invalid_input" | "secret_missing" => {
            StatusCode::UNPROCESSABLE_ENTITY
        }
        "keychain_unavailable" => StatusCode::SERVICE_UNAVAILABLE,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn reply<T: Serialize>(route: &'static str, result: ServiceResult<T>) -> Reply {
    match result {
        Ok(data) => Ok(Json(IpcBody::ok(data)).into_response()),
        Err(error) => Err(refusal(route, &error)),
    }
}

fn refusal(route: &'static str, error: &ServiceError) -> Refusal {
    let code = error.code();
    let status = status_of(code);
    if status.is_server_error() {
        tracing::error!(target: LOG_TARGET, route, code, "automation request failed: {error}");
    } else {
        tracing::info!(target: LOG_TARGET, route, code, "automation request refused");
    }
    let mut refusal = Refusal::new(status, code, error.to_string());
    if let ServiceError::RevisionConflict { current } = error {
        refusal.current_revision = Some(*current);
    }
    refusal
}

fn invalid_body(route: &'static str, rejection: &JsonRejection) -> Refusal {
    refusal(
        route,
        &ServiceError::InvalidInput(format!("request body: {}", rejection.body_text())),
    )
}

/// The service, once the caller is admitted. `write` marks a mutation, which
/// also has to pass the remote-write guard.
fn admit(
    state: &AutomationRouteState,
    parts: &Parts,
    peer: SocketAddr,
    route: &'static str,
    write: bool,
) -> Result<Arc<AutomationService>, Refusal> {
    let admitted = parts.extensions.get::<BearerVerified>().is_some()
        || (!state.token_gated && peer.ip().is_loopback());
    if !admitted {
        tracing::warn!(target: LOG_TARGET, peer = %peer, route, "automation request refused: no verified bearer token");
        return Err(Refusal::new(
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
            "automations need the host token",
        ));
    }
    if write {
        let flags = state.write_flags;
        if let Some(forbidden) = check_local_only::<()>(
            peer,
            flags.allow_remote_writes,
            flags.shared_live_writes_denied,
            route,
        ) {
            return Err(Refusal::new(
                StatusCode::FORBIDDEN,
                "FORBIDDEN",
                forbidden.error.unwrap_or_default(),
            ));
        }
    }
    state.service.clone().ok_or_else(|| {
        tracing::warn!(target: LOG_TARGET, route, "automation request refused: no automation service");
        Refusal::new(
            StatusCode::SERVICE_UNAVAILABLE,
            UNAVAILABLE,
            "automations are unavailable on this host",
        )
    })
}

#[derive(Deserialize)]
struct ProjectQuery {
    #[serde(default)]
    project_id: String,
}

#[derive(Deserialize)]
struct RunsQuery {
    limit: Option<usize>,
}

#[derive(Deserialize)]
struct SecretQuery {
    #[serde(default)]
    project_id: String,
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
struct CreateBody {
    project_id: String,
    name: String,
}

#[derive(Deserialize)]
struct OpsBody {
    base_revision: u64,
    ops: Value,
}

#[derive(Deserialize)]
struct EnabledBody {
    enabled: bool,
}

#[derive(Deserialize)]
struct ApproveBody {
    revision: u64,
}

#[derive(Deserialize)]
struct PreviewBody {
    schedule: Value,
}

/// No `Debug`: the value is a secret.
#[derive(Deserialize)]
struct SecretBody {
    project_id: String,
    name: String,
    value: String,
}

type Peer = ConnectInfo<SocketAddr>;
type Body<T> = Result<Json<T>, JsonRejection>;

async fn list(
    State(state): State<AutomationRouteState>,
    ConnectInfo(peer): Peer,
    parts: Parts,
    Query(query): Query<ProjectQuery>,
) -> Reply {
    let service = admit(&state, &parts, peer, AUTOMATIONS, false)?;
    reply(AUTOMATIONS, service.list(&query.project_id))
}

async fn create(
    State(state): State<AutomationRouteState>,
    ConnectInfo(peer): Peer,
    parts: Parts,
    body: Body<CreateBody>,
) -> Reply {
    let service = admit(&state, &parts, peer, AUTOMATIONS, true)?;
    let Json(body) = body.map_err(|e| invalid_body(AUTOMATIONS, &e))?;
    reply(AUTOMATIONS, service.create(&body.project_id, &body.name))
}

async fn preview(
    State(state): State<AutomationRouteState>,
    ConnectInfo(peer): Peer,
    parts: Parts,
    body: Body<PreviewBody>,
) -> Reply {
    let service = admit(&state, &parts, peer, PREVIEW, false)?;
    let Json(body) = body.map_err(|e| invalid_body(PREVIEW, &e))?;
    reply(PREVIEW, Ok(preview_schedule(&service, body.schedule)))
}

async fn get_one(
    State(state): State<AutomationRouteState>,
    ConnectInfo(peer): Peer,
    parts: Parts,
    Path(id): Path<String>,
) -> Reply {
    let service = admit(&state, &parts, peer, AUTOMATION, false)?;
    reply(AUTOMATION, service.get(&AutomationId::from(id)))
}

async fn delete_one(
    State(state): State<AutomationRouteState>,
    ConnectInfo(peer): Peer,
    parts: Parts,
    Path(id): Path<String>,
) -> Reply {
    let service = admit(&state, &parts, peer, AUTOMATION, true)?;
    reply(AUTOMATION, service.delete(&AutomationId::from(id)))
}

async fn apply_ops(
    State(state): State<AutomationRouteState>,
    ConnectInfo(peer): Peer,
    parts: Parts,
    Path(id): Path<String>,
    body: Body<OpsBody>,
) -> Reply {
    let service = admit(&state, &parts, peer, OPS, true)?;
    let Json(body) = body.map_err(|e| invalid_body(OPS, &e))?;
    let result = parse_ops(body.ops)
        .and_then(|ops| service.apply_ops(&AutomationId::from(id), body.base_revision, &ops));
    reply(OPS, result)
}

async fn set_enabled(
    State(state): State<AutomationRouteState>,
    ConnectInfo(peer): Peer,
    parts: Parts,
    Path(id): Path<String>,
    body: Body<EnabledBody>,
) -> Reply {
    let service = admit(&state, &parts, peer, ENABLED, true)?;
    let Json(body) = body.map_err(|e| invalid_body(ENABLED, &e))?;
    reply(
        ENABLED,
        service.set_enabled(&AutomationId::from(id), body.enabled),
    )
}

async fn approve(
    State(state): State<AutomationRouteState>,
    ConnectInfo(peer): Peer,
    parts: Parts,
    Path(id): Path<String>,
    body: Body<ApproveBody>,
) -> Reply {
    let service = admit(&state, &parts, peer, APPROVE, true)?;
    let Json(body) = body.map_err(|e| invalid_body(APPROVE, &e))?;
    reply(
        APPROVE,
        service.approve(&AutomationId::from(id), body.revision),
    )
}

async fn run_now(
    State(state): State<AutomationRouteState>,
    ConnectInfo(peer): Peer,
    parts: Parts,
    Path(id): Path<String>,
) -> Reply {
    let service = admit(&state, &parts, peer, RUN, true)?;
    reply(RUN, service.run_now(&AutomationId::from(id)))
}

async fn list_runs(
    State(state): State<AutomationRouteState>,
    ConnectInfo(peer): Peer,
    parts: Parts,
    Path(id): Path<String>,
    Query(query): Query<RunsQuery>,
) -> Reply {
    let service = admit(&state, &parts, peer, RUNS, false)?;
    let limit = query.limit.unwrap_or(DEFAULT_RUNS_LIMIT);
    reply(RUNS, service.list_runs(&AutomationId::from(id), limit))
}

async fn mark_seen(
    State(state): State<AutomationRouteState>,
    ConnectInfo(peer): Peer,
    parts: Parts,
    Path(id): Path<String>,
) -> Reply {
    let service = admit(&state, &parts, peer, SEEN, true)?;
    reply(SEEN, service.mark_seen(&AutomationId::from(id)))
}

async fn cancel_run(
    State(state): State<AutomationRouteState>,
    ConnectInfo(peer): Peer,
    parts: Parts,
    Path(run_id): Path<String>,
) -> Reply {
    let service = admit(&state, &parts, peer, CANCEL_RUN, true)?;
    reply(CANCEL_RUN, service.cancel_run(&RunId::from(run_id)))
}

async fn run_steps(
    State(state): State<AutomationRouteState>,
    ConnectInfo(peer): Peer,
    parts: Parts,
    Path(run_id): Path<String>,
) -> Reply {
    let service = admit(&state, &parts, peer, RUN_STEPS, false)?;
    reply(RUN_STEPS, service.get_run_steps(&RunId::from(run_id)))
}

async fn list_agents(
    State(state): State<AutomationRouteState>,
    ConnectInfo(peer): Peer,
    parts: Parts,
) -> Reply {
    let service = admit(&state, &parts, peer, AGENTS, false)?;
    reply(AGENTS, Ok(service.list_agents()))
}

async fn list_secrets(
    State(state): State<AutomationRouteState>,
    ConnectInfo(peer): Peer,
    parts: Parts,
    Query(query): Query<ProjectQuery>,
) -> Reply {
    let service = admit(&state, &parts, peer, SECRETS, false)?;
    reply(SECRETS, service.list_secret_names(&query.project_id))
}

async fn put_secret(
    State(state): State<AutomationRouteState>,
    ConnectInfo(peer): Peer,
    parts: Parts,
    body: Body<SecretBody>,
) -> Reply {
    let service = admit(&state, &parts, peer, SECRETS, true)?;
    let Json(body) = body.map_err(|e| invalid_body(SECRETS, &e))?;
    reply(
        SECRETS,
        set_secret(service, body.project_id, body.name, body.value).await,
    )
}

async fn remove_secret(
    State(state): State<AutomationRouteState>,
    ConnectInfo(peer): Peer,
    parts: Parts,
    Query(query): Query<SecretQuery>,
) -> Reply {
    let service = admit(&state, &parts, peer, SECRETS, true)?;
    reply(
        SECRETS,
        delete_secret(service, query.project_id, query.name).await,
    )
}

/// Hands every [`AutomationChanged`] to `relay`'s `agents` watch, which
/// reaches web clients, the desktop's own carrier and shared-live peers, and
/// to `emit` (the desktop's Tauri event). The payload is the event as
/// serialized, unedited. Returns when the service is gone.
pub async fn forward_changes(
    mut changes: broadcast::Receiver<AutomationChanged>,
    relay: Arc<WsRelaySink>,
    emit: impl Fn(&Value),
) {
    loop {
        match changes.recv().await {
            Ok(change) => match serde_json::to_value(&change) {
                Ok(payload) => {
                    publish_agent_event(&relay, EVENT_AUTOMATION_CHANGED, &payload);
                    emit(&payload);
                }
                Err(error) => {
                    tracing::error!(target: LOG_TARGET, "automation change not serializable: {error}");
                }
            },
            Err(RecvError::Lagged(missed)) => {
                tracing::warn!(target: LOG_TARGET, missed, "automation change events dropped: forwarder lagged");
            }
            Err(RecvError::Closed) => return,
        }
    }
}

#[cfg(test)]
#[path = "automation_api_tests.rs"]
mod tests;
