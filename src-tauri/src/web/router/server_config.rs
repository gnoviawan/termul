//! `/server/config` — standalone reconfigure routes (gh-1105).
//!
//! These two handlers are registered ONLY when `AppState.server_admin` is
//! `Some` — i.e. on the standalone `termul-server` (`web::serve` builds the
//! context from the merged `ServerConfig`). The desktop shared-live host
//! passes `None`, so the route never exists there. They sit behind the same
//! two guards as every host-state mutation: the `web_auth_gate` bearer
//! middleware (`/server/` is a `GATED_PREFIXES` entry) and the loopback /
//! `--allow-remote-writes` write admission (`fs_api::check_local_only`).

use std::net::SocketAddr;

use axum::{
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
use std::sync::atomic::Ordering;

use crate::web::auth;
use crate::web::config::BindMode;
use crate::web::fs_api::{self, IpcBody};
use crate::web::server_config_file::{
    self, ServerSetupAnswers, SetupFieldErrors,
};
use crate::web::ws::AppState;

/// `GET /server/config` success payload — `ServerConfigResponse` in the
/// shared contract (`src/shared/types/server-setup.types.ts`): the running
/// server's effective answers for the reconfigure form.
#[derive(Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerConfigResponse {
    config: ServerSetupAnswers,
}

/// `POST /server/config` validation-failure body — the `{ok, fieldErrors}`
/// `SetupValidateResponse` shape `POST /setup/apply` also returns at 400.
#[derive(Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerConfigFieldErrors {
    ok: bool,
    field_errors: SetupFieldErrors,
}

/// `POST /server/config` success payload — `SetupApplyResponse` in the
/// shared contract (same shape `POST /setup/apply` replies with).
#[derive(Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetupApplyResponse {
    ok: bool,
    /// The effective bind the restarted server will listen on.
    host: String,
    port: u16,
    /// The web-auth token the post-restart bind will demand — the browser
    /// needs it to land authenticated on the new origin (`#token=`). Only
    /// present when the post-restart bind will actually gate.
    #[serde(skip_serializing_if = "Option::is_none")]
    web_auth_token: Option<String>,
}

/// Extract the presented token from the `Authorization: Bearer <token>`
/// header (scheme match is case-insensitive, RFC 7235) — the same parse
/// `gate::presented_token` runs; duplicated here because the handler needs
/// the raw header map, not the request.
fn presented_token(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(axum::http::header::AUTHORIZATION)?;
    let value = value.to_str().ok()?;
    let bytes = value.as_bytes();
    if bytes.len() > 7 && value[..6].eq_ignore_ascii_case("bearer") && bytes[6] == b' ' {
        return Some(value[7..].to_string());
    }
    None
}

/// Whether the `Origin` header names a loopback host (`127.0.0.1`, `::1`,
/// `localhost`, `0.0.0.0`). On an ungated server this is the only signal
/// separating a real same-machine browser from a remote visitor arriving
/// through a same-host reverse proxy — the proxy makes every peer look
/// loopback to `check_local_only`, and browsers always send `Origin` on
/// POST. A missing or non-loopback origin is refused.
fn origin_is_loopback(headers: &HeaderMap) -> bool {
    let Some(origin) = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|v| v.to_str().ok())
    else {
        return false;
    };
    // `http://host[:port]` — strip the scheme, then the port.
    let host_port = origin
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(origin)
        .trim_end_matches('/');
    let host = host_port
        .strip_prefix('[')
        .and_then(|s| s.split_once(']').map(|(h, _)| h))
        .unwrap_or_else(|| host_port.split(':').next().unwrap_or(host_port));
    matches!(
        host.to_ascii_lowercase().as_str(),
        "127.0.0.1" | "::1" | "localhost" | "0.0.0.0"
    )
}

/// RAII latch release for `POST /server/config`: drops the
/// `ServerAdminContext::apply_in_flight` flag on scope exit. The success
/// path `std::mem::forget`s it instead so the latch stays set across the
/// pending-restart window (no second apply may run before the re-exec).
struct ApplyInFlight(std::sync::Arc<std::sync::atomic::AtomicBool>);

impl Drop for ApplyInFlight {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// `GET /server/config`: return the effective current settings
/// (`ServerAdminContext.current` — argv/env/file merged) for the reconfigure
/// form, wrapped in the same `{success, data}` IpcBody every other host read
/// uses so `getJson` parses it directly. 404 when `server_admin` is absent —
/// unreachable on the normal router since the route is registered only for
/// `Some`, but the guard keeps the handler honest.
pub(super) async fn server_config_get(State(state): State<AppState>) -> Response {
    let Some(admin) = &state.server_admin else {
        return StatusCode::NOT_FOUND.into_response();
    };
    Json(IpcBody::ok(ServerConfigResponse {
        config: admin.current.clone(),
    }))
    .into_response()
}

/// `POST /server/config`: normal-mode reconfigure (gh-1105). Validates the
/// answers, persists `<state_dir>/server-config.json`, replies
/// `SetupApplyResponse`, then schedules the self-restart that loads the new
/// config (the re-exec'd `server_main` resolves bind/token/state dir from
/// the file). Sequence: write guard → validate → persist → reply → restart —
/// an invalid or unpersistable apply writes nothing and never restarts.
pub(super) async fn server_config_post(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(answers): Json<ServerSetupAnswers>,
) -> Response {
    let Some(admin) = &state.server_admin else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // One apply at a time — and never a second one once a restart is
    // scheduled: it would write a file the caller is never redirected to.
    // The latch lives on the admin context so each server (and each test
    // router) gets its own; the re-exec clears it naturally.
    if admin
        .apply_in_flight
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "success": false,
                "error": "a server config apply is already in progress — the server is restarting",
                "code": "SERVER_CONFIG_APPLY_IN_PROGRESS",
            })),
        )
            .into_response();
    }
    // Released on every exit path EXCEPT success — `std::mem::forget` on
    // the success path keeps the latch set across the pending-restart
    // window; a failed apply must not lock the route.
    let apply_guard = ApplyInFlight(admin.apply_in_flight.clone());
    // Ungated + no remote-write opt-in: this route can rebind the server and
    // hand back a fresh web-auth token, so it must not trust the TCP peer
    // alone — a same-host reverse proxy makes every remote visitor look
    // loopback to `check_local_only`. Require a loopback `Origin` (browsers
    // always send it on POST); `--allow-remote-writes` is the explicit
    // opt-out for genuinely remote reconfiguration.
    if state.web_auth.is_none()
        && !state.allow_remote_writes
        && !origin_is_loopback(&headers)
    {
        tracing::warn!(
            target: "termul::web::router",
            "server config apply refused — non-loopback or missing Origin \
             on an ungated server (a same-host reverse proxy cannot \
             reconfigure it; use --web-auth-token or --allow-remote-writes)"
        );
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "success": false,
                "error": "reconfiguring an unauthenticated server requires a local browser",
                "code": "SERVER_CONFIG_LOCAL_ORIGIN_REQUIRED",
            })),
        )
            .into_response();
    }
    // Write admission — the SAME `check_local_only` predicate every host-state
    // mutation uses (loopback or `--allow-remote-writes`; shared-live denies).
    // The bearer gate already ran (outer layer). Refuses in the IpcBody shape
    // like its sibling mutations.
    if let Some(forbidden) = fs_api::check_local_only::<SetupApplyResponse>(
        peer,
        state.allow_remote_writes,
        state.shared_live_writes_denied,
        "/server/config",
    ) {
        return Json(forbidden).into_response();
    }
    // Validate the answers. `validate_answers` normalizes the host
    // ("localhost" → 127.0.0.1, "any" → 0.0.0.0) inside the persisted file.
    let validated = match server_config_file::validate_answers(&answers) {
        Ok(file) => file,
        Err(field_errors) => {
            tracing::info!(
                target: "termul::web::router",
                "server config apply rejected: validation failed {field_errors:?}"
            );
            // 200 + the `{ok:false, fieldErrors}` verdict in the IpcBody
            // envelope — app-level verdicts ride in the body so the renderer
            // can surface the per-field errors inline (same shape as
            // `POST /setup/validate`).
            return Json(IpcBody::ok(ServerConfigFieldErrors {
                ok: false,
                field_errors,
            }))
            .into_response();
        }
    };
    // `webAuthToken` for the reply — the token the post-restart bind will
    // demand. Two cases:
    //   • This server already gates (`web_auth: Some`): the re-exec honors
    //     the SAME token (a configured one rides the same argv; a file token
    //     is re-read from the same file) — the bearer the client already
    //     presented IS it. Echo it back so a host/port-change redirect can
    //     carry `#token=` to the new origin. Also handed back on a loopback
    //     post-restart bind: a configured token still gates there (harmless
    //     when the file-only token leaves it ungated — the client simply
    //     sends a header the server ignores).
    //   • This server is ungated (`web_auth: None` ⇒ no configured token in
    //     argv OR env) and the NEW bind is public: the restart's `resolve`
    //     will demand a token, so pre-resolve it now — load-or-generate +
    //     persist `<state_dir>/web-auth-token` exactly the way the re-exec'd
    //     boot will — and hand it to the client. Refuse the apply (before
    //     writing) when resolution fails: the restart would fail closed and
    //     strand the server with nothing written to recover.
    let post_restart_public = BindMode::parse(&validated.host) == Some(BindMode::All);
    let web_auth_token: Option<String> = if state.web_auth.is_some() {
        presented_token(&headers)
    } else if post_restart_public {
        match post_restart_public_bind_token(&admin.state_dir) {
            Ok(token) => Some(token),
            Err(error) => {
                tracing::error!(
                    target: "termul::web::router",
                    "server config apply refused — cannot resolve the \
                     post-restart web auth token: {error}"
                );
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({
                        "success": false,
                        "error": format!(
                            "cannot apply the server config: {error}"
                        ),
                        "code": "SERVER_CONFIG_AUTH_UNAVAILABLE",
                    })),
                )
                    .into_response();
            }
        }
    } else {
        None
    };
    // Persist before replying — the reply's `ok` must mean "the file is on
    // disk" because the scheduled restart loads it. NEVER log the token.
    if let Err(error) = server_config_file::save(&admin.state_dir, &validated) {
        tracing::error!(
            target: "termul::web::router",
            "server config apply failed — could not write '{}': {error}",
            server_config_file::server_config_path(&admin.state_dir).display(),
        );
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "success": false,
                "error": "could not write the server config file — check the server logs",
                "code": "SERVER_CONFIG_SAVE_FAILED",
            })),
        )
            .into_response();
    }
    // Durable boundary log (AGENTS.md): the applied bind + the fact that a
    // restart is scheduled. No token, no peer, no request body.
    tracing::info!(
        target: "termul::web::router",
        host = %validated.host,
        port = validated.port,
        post_restart_public,
        "server reconfigure applied — scheduling self-restart",
    );
    server_config_file::schedule_self_restart("server-config-apply");
    // Keep the latch set — the restart is pending; a second apply must not
    // run. `forget` leaks one Arc alloc per boot; the re-exec resets it.
    std::mem::forget(apply_guard);
    Json(IpcBody::ok(SetupApplyResponse {
        ok: true,
        host: validated.host,
        port: validated.port,
        web_auth_token,
    }))
    .into_response()
}

/// Resolve the token a post-restart PUBLIC bind will demand, exactly the way
/// the re-exec'd `server_main` resolves it — [`auth::resolve`] load-or-
/// generate + persist of `<state_dir>/web-auth-token` — then read the file
/// back for the reply (`WebAuth` deliberately never exposes the secret;
/// `persisted_web_auth_token` in `server_main` reads it the same way).
/// `Err` when resolution or the read-back fails — the caller refuses the
/// apply BEFORE the config is written, because the restart would fail closed
/// and strand the server.
fn post_restart_public_bind_token(state_dir: &std::path::Path) -> Result<String, String> {
    match auth::resolve(Some(BindMode::All), None, state_dir)? {
        auth::WebAuthResolution::Gated { .. } => {
            let path = state_dir.join(auth::WEB_AUTH_TOKEN_FILE);
            let contents = std::fs::read_to_string(&path).map_err(|error| {
                format!(
                    "could not read back the web auth token file '{}': {error}",
                    path.display(),
                )
            })?;
            auth::WebAuthToken::new(&contents)
                .map(|token| token.as_str().to_string())
                .ok_or_else(|| format!("web auth token file '{}' is empty", path.display()))
        }
        auth::WebAuthResolution::Ungated => Err(
            "web auth resolution unexpectedly resolved ungated for a public bind".to_string(),
        ),
    }
}
