//! HTTP handlers for the bug-report diagnostics + submit routes
//! (spec-bug-report-dialog).
//!
//! Mirrors the desktop `collect_bug_report_context` / `submit_bug_report`
//! commands over HTTP: the web client has no Tauri runtime to invoke, so
//! `POST /log/diagnostics` returns `IpcBody<BugReportContext>` and
//! `POST /log/report-bug` (body `BugReportSubmitRequest`) returns
//! `IpcBody<BugReportSubmitResult>` — the same `IpcResult` envelope shape
//! the other `/log/` + `/fs/` routes use (HTTP 200 for app-level outcomes;
//! only transport/parse failures are non-200).
//!
//! - **Admission:** both are guarded host-state operations, denied exactly
//!   like the other `/log/` mutations — `check_local_only`
//!   ([`crate::web::capabilities::write_decision`]) refuses non-loopback
//!   peers without `--allow-remote-writes` and EVERY peer on the desktop
//!   shared-live host (`shared_live_writes_denied`). The bearer gate is the
//!   `/log/` `GATED_PREFIXES` entry in `web::router`, unchanged by these
//!   routes. A denied collect never leaks the (redacted) host log tail and a
//!   denied submit never spawns `gh` on the host.
//! - **Log resolution:** `AppState` carries neither an `AppHandle` nor the
//!   `ServerConfig`, so [`host_log_path`] re-resolves the single candidate
//!   the current deployment mode logs to — the desktop `termul.log` on a
//!   shared-live host (`shared_live_writes_denied`), `<state
//!   dir>/termul-server.log` on a standalone `termul-server`. A miss is
//!   `logAvailable: false` in the payload — never a route failure.
//! - **Blocking work:** the log-tail read and the `gh` probe/spawn are
//!   BLOCKING and run on `tokio::task::spawn_blocking`, never inline on the
//!   async path. `tracing` (not `log`) — the `web` module is the standalone
//!   boundary. Report contents are never logged.

use std::net::SocketAddr;
use std::path::PathBuf;

use axum::{
    extract::{ConnectInfo, DefaultBodyLimit, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{post, MethodRouter},
    Json,
};

use crate::diagnostics::{BugReportContext, BugReportSubmitRequest, BugReportSubmitResult};
use crate::web::config::ServerConfig;
use crate::web::fs_api::{check_local_only, IpcBody};
use crate::web::ws::AppState;

/// Standalone log file name — where `termul-server` logs actually land
/// depends on how it was launched: the onboard `setsid` path redirects
/// stdout/stderr to `<state dir>/termul-server.log` (`onboard.rs`), the
/// documented nohup recipe writes `/tmp/termul-server.log`
/// (`server_main.rs`), and a systemd-onboarded server logs to journald —
/// no file at all. Only the first is found here; for the other two
/// `logAvailable: false` is the expected outcome.
const SERVER_LOG_FILE_NAME: &str = "termul-server.log";

/// Cap on the `POST /log/report-bug` JSON body (`{title, body}`). Generous
/// over the 64 KiB diagnostics tail a composed report can carry; a tighter
/// content cap belongs to the report builder, not the transport.
const MAX_REPORT_BODY_BYTES: usize = 256 * 1024;

/// `POST /log/diagnostics` — collect the bounded, redacted diagnostics
/// bundle for the host this server runs on.
pub fn diagnostics_route() -> MethodRouter<AppState> {
    post(diagnostics)
}

/// `POST /log/report-bug` — submit the user-previewed report through the
/// host `gh` CLI.
pub fn report_bug_route() -> MethodRouter<AppState> {
    post(report_bug).layer(DefaultBodyLimit::max(MAX_REPORT_BODY_BYTES))
}

async fn diagnostics(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
) -> impl IntoResponse {
    // `shared_live` selects the desktop log candidate inside
    // `host_log_path`. That arm is unreachable today — `check_local_only`
    // denies every peer on a shared-live host before the collect closure
    // runs — but resolves correctly should the admission rules loosen.
    let shared_live = state.shared_live_writes_denied;
    diagnostics_inner(peer, &state, move || {
        crate::diagnostics::collect_bug_report_context(host_log_path(shared_live).as_deref())
    })
    .await
}

async fn report_bug(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<BugReportSubmitRequest>,
) -> impl IntoResponse {
    report_bug_inner(peer, &state, req, crate::diagnostics::submit_bug_report).await
}

/// The collect path behind an injectable `collect` seam so tests exercise
/// the guard + envelope branches without depending on host log state.
async fn diagnostics_inner(
    peer: SocketAddr,
    state: &AppState,
    collect: impl FnOnce() -> BugReportContext + Send + 'static,
) -> (StatusCode, Json<IpcBody<BugReportContext>>) {
    if let Some(forbidden) = check_local_only::<BugReportContext>(
        peer,
        state.allow_remote_writes,
        state.shared_live_writes_denied,
        "/log/diagnostics",
    ) {
        return (StatusCode::OK, Json(forbidden));
    }
    match tokio::task::spawn_blocking(collect).await {
        Ok(context) => (StatusCode::OK, Json(IpcBody::ok(context))),
        Err(error) => {
            tracing::warn!(
                target: "termul::web::diagnostics_api",
                "bug-report collect worker failed: {error}"
            );
            (
                StatusCode::OK,
                Json(IpcBody::err(
                    format!("diagnostics collection failed: {error}"),
                    "COLLECT_FAILED",
                )),
            )
        }
    }
}

/// The submit path behind an injectable `submit` seam so tests exercise the
/// guard + envelope branches without spawning a real `gh` (an authenticated
/// `gh` on a test host would file a real issue).
async fn report_bug_inner(
    peer: SocketAddr,
    state: &AppState,
    req: BugReportSubmitRequest,
    submit: impl Fn(&str, &str) -> BugReportSubmitResult + Send + 'static,
) -> (StatusCode, Json<IpcBody<BugReportSubmitResult>>) {
    if let Some(forbidden) = check_local_only::<BugReportSubmitResult>(
        peer,
        state.allow_remote_writes,
        state.shared_live_writes_denied,
        "/log/report-bug",
    ) {
        return (StatusCode::OK, Json(forbidden));
    }
    match tokio::task::spawn_blocking(move || submit(&req.title, &req.body)).await {
        Ok(result) => (StatusCode::OK, Json(IpcBody::ok(result))),
        Err(error) => {
            tracing::warn!(
                target: "termul::web::diagnostics_api",
                "bug-report submit worker failed: {error}"
            );
            (
                StatusCode::OK,
                Json(IpcBody::ok(BugReportSubmitResult::Failed {
                    reason: "the submit worker failed before a result was produced".to_string(),
                })),
            )
        }
    }
}

/// Best-effort path of the host's active log file. NOTE: the `shared_live`
/// arm is currently dead — a shared-live host denies every peer at the
/// `check_local_only` gate — it is kept so the candidate stays correct if
/// that admission rule ever changes.
///
/// `shared_live` says
/// WHICH host shape this process is (the route only ever runs inside one):
/// on the desktop shared-live host (`shared_live_writes_denied: true`)
/// only the desktop `termul.log` candidate is tried — a stale
/// `termul-server.log` left by a past standalone run must not win — while
/// on a standalone `termul-server` only `<state dir>/termul-server.log` is
/// tried, so a stale desktop log is never attached when the server log is
/// absent. `AppState` deliberately carries no `AppHandle` or `ServerConfig`,
/// so the candidate is re-resolved each call; a miss (or an unreadable
/// hit) degrades to `logAvailable: false` in the collect payload — the
/// route never fails over log access.
fn host_log_path(shared_live: bool) -> Option<PathBuf> {
    log_path_candidates(shared_live)
        .into_iter()
        .find(|path| path.is_file())
}

/// Log-path candidates for the current deployment mode: exactly one per
/// mode (see [`host_log_path`]).
fn log_path_candidates(shared_live: bool) -> Vec<PathBuf> {
    let candidate = if shared_live {
        desktop_log_path()
    } else {
        termul_server_log_path()
    };
    candidate.into_iter().collect()
}

/// `termul-server`: `<state dir>/termul-server.log` — written only by the
/// onboard `setsid` launch (the nohup recipe targets `/tmp`; systemd
/// onboards log to journald). The state dir is re-derived by parsing an
/// empty args list so the exact `ServerConfig::service_account_state_dir`
/// chain (`$XDG_STATE_HOME` / `$HOME` / `%LOCALAPPDATA%` / temp-dir
/// fallback) is reused rather than duplicated. An explicit `--state-dir`
/// flag is operator knowledge the router state does not retain — that
/// miss, like the nohup/journald cases, degrades to `logAvailable: false`,
/// never a failure.
fn termul_server_log_path() -> Option<PathBuf> {
    ServerConfig::from_args(std::iter::empty::<String>())
        .ok()
        .map(|cfg| cfg.service_account_state_dir().join(SERVER_LOG_FILE_NAME))
}

/// Desktop shared-live: the Tauri `app_log_dir` layout for the app
/// identifier `com.termul-manager.app` (`tauri.conf.json`) — the same paths
/// the GitHub issue template prints. Selected when
/// `shared_live_writes_denied` marks this process as a desktop-hosted
/// shared-live server.
#[cfg(target_os = "macos")]
fn desktop_log_path() -> Option<PathBuf> {
    std::env::home_dir().map(|home| {
        home.join("Library")
            .join("Logs")
            .join("com.termul-manager.app")
            .join("termul.log")
    })
}

/// See the macOS arm above.
#[cfg(all(unix, not(target_os = "macos")))]
fn desktop_log_path() -> Option<PathBuf> {
    let data_home = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty() && p.is_absolute())
        .or_else(|| std::env::home_dir().map(|home| home.join(".local").join("share")));
    data_home.map(|base| {
        base.join("com.termul-manager.app")
            .join("logs")
            .join("termul.log")
    })
}

/// See the macOS arm above.
#[cfg(windows)]
fn desktop_log_path() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|base| {
            base.join("com.termul-manager.app")
                .join("logs")
                .join("termul.log")
        })
}

/// Fallback for non-desktop, non-unix targets: no known log location.
#[cfg(not(any(unix, windows)))]
fn desktop_log_path() -> Option<PathBuf> {
    None
}

#[cfg(test)]
mod tests;
