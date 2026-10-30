//! Host-level routes: the `/health` capability probe and the idle-chat
//! window setting.

use std::net::SocketAddr;

use axum::{
    extract::{ConnectInfo, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};

use crate::web::ws::AppState;

/// Liveness + capability probe for the ACP web server. Returns JSON so the
/// web client can discover the server's write-admission policy
/// (`allowRemoteWrites`) instead of guessing from `window.location.hostname`
/// (wrong for Cloudflare tunnel domains). The admission bool mirrors the
/// EXACT per-request `check_local_only` admission for the requesting peer:
/// `!shared_live_writes_denied && (peer.is_loopback() || allow_remote_writes)`.
/// A loopback peer (e.g. a `localhost` browser on the standalone server, no
/// opt-in) is admitted regardless of `allow_remote_writes`, so `/health`
/// reports `true` for it — matching what its `/worktree/*` writes would face.
/// Desktop shared-live sets `shared_live_writes_denied`, so it reports `false`
/// for every peer (writes are genuinely denied there).
///
/// `setupRequired` (gh-1105) is `true` only when the standalone
/// `termul-server` carries a [`crate::web::server_config_file::ServerAdminContext`]
/// AND the resolved state dir has no completed `server-config.json` — i.e. a
/// fresh standalone install serving normal mode on explicit argv config.
/// `server_admin: None` (desktop shared-live, in-process channel state)
/// reports `false` without touching the filesystem. The flag probes the file
/// itself so a config written (or deleted) after boot is reflected on the
/// next poll.
pub(super) async fn health_check(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
) -> impl IntoResponse {
    // The same predicate `/ws`, `/terminal/ws` and the write routes use.
    let allow = crate::web::capabilities::write_decision(
        peer,
        crate::web::capabilities::WriteFlags::from_state(&state),
    )
    .is_allowed();
    let setup_required = state
        .server_admin
        .as_ref()
        .is_some_and(|a| !crate::web::server_config_file::is_onboarded(&a.state_dir));
    // Durable boundary log (AGENTS.md): record the capability-admission
    // decision. No peer address or credentials logged — only the decision
    // + whether the deployment-mode deny or opt-in governed it.
    tracing::debug!(
        target: "termul::web::router",
        allow_remote_writes = allow,
        shared_live_denied = state.shared_live_writes_denied,
        opt_in = state.allow_remote_writes,
        "health capability probe",
    );
    (
        StatusCode::OK,
        Json(HealthBody {
            status: "ok",
            allow_remote_writes: allow,
            case_insensitive_paths: PATHS_CASE_INSENSITIVE_BY_TARGET,
            setup_required,
        }),
    )
}

/// The source of truth for the web client's path case rule (#641). A per-volume
/// probe would need a path, and `/health` is host-wide.
const PATHS_CASE_INSENSITIVE_BY_TARGET: bool = cfg!(any(windows, target_os = "macos"));

/// `GET /health` response body.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthBody {
    status: &'static str,
    allow_remote_writes: bool,
    case_insensitive_paths: bool,
    /// `true` when the standalone server is running normal mode without a
    /// persisted `server-config.json` (gh-1105). Always `false` on desktop
    /// shared-live hosts (`server_admin: None`).
    setup_required: bool,
}

/// `GET /host/agent-idle-window` — the live idle-chat window. Same `IpcResult`
/// envelope as the other host reads so the web client can parse it with
/// `getJson`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentIdleWindowBody {
    success: bool,
    data: crate::web::agent_reaper::AgentIdleWindowStatus,
}

pub(super) async fn agent_idle_window() -> impl IntoResponse {
    let data = crate::web::agent_reaper::resolved_agent_idle_window();
    tracing::debug!(
        target: "termul::web::agent_reaper",
        secs = data.secs,
        source = data.source,
        "agent idle window probe"
    );
    (StatusCode::OK, Json(idle_window_ok(data)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SetAgentIdleWindowRequest {
    secs: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentIdleWindowError {
    success: bool,
    error: String,
    code: String,
}

fn idle_window_ok(data: crate::web::agent_reaper::AgentIdleWindowStatus) -> AgentIdleWindowBody {
    AgentIdleWindowBody {
        success: true,
        data,
    }
}

/// `POST /host/agent-idle-window` — save the Settings choice. A flag or
/// `$TERMUL_AGENT_IDLE_REAP_SECS` keeps the live window. View-only peers
/// (shared-live, or a remote peer without `--allow-remote-writes`) are refused.
pub(super) async fn set_agent_idle_window(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(body): Json<SetAgentIdleWindowRequest>,
) -> Response {
    let allowed = crate::web::capabilities::write_decision(
        peer,
        crate::web::capabilities::WriteFlags::from_state(&state),
    )
    .is_allowed();
    if !allowed {
        tracing::info!(
            target: "termul::web::agent_reaper",
            "agent idle window change refused for a view-only peer"
        );
        return (
            StatusCode::FORBIDDEN,
            Json(AgentIdleWindowError {
                success: false,
                error: "this connection cannot change host settings".to_string(),
                code: "FORBIDDEN".to_string(),
            }),
        )
            .into_response();
    }
    if matches!(body.secs, Some(0)) {
        return (
            StatusCode::BAD_REQUEST,
            Json(AgentIdleWindowError {
                success: false,
                error: "agent idle window must be greater than 0 seconds".to_string(),
                code: "INVALID_IDLE_WINDOW".to_string(),
            }),
        )
            .into_response();
    }
    crate::web::agent_reaper::set_agent_idle_window_override(body.secs);
    let data = crate::web::agent_reaper::resolved_agent_idle_window();
    (StatusCode::OK, Json(idle_window_ok(data))).into_response()
}
