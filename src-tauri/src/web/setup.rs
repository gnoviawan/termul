//! Setup-mode router for `termul-server` (gh-1105).
//!
//! Served ONLY when `ServerConfig::setup_required()` holds — no completed
//! `server-config.json` in the state dir and no explicit config argv (see
//! `_bmad-output/implementation-artifacts/spec-gh-1105-web-onboarding.md`).
//! The router is deliberately minimal so a configured `AppState` /
//! `AcpManager` stack is never constructed before config exists, and so the
//! desktop shared-live host (which shares [`crate::web::router::router`])
//! never sees setup state:
//!
//! - `GET /health` — same body shape as the normal router plus
//!   `setupRequired: true`; the renderer's setup gate probes it pre-auth.
//! - `GET /setup/status` — `SetupStatusResponse`: the flag plus the
//!   server-side wizard defaults (`OnboardAnswers::defaults()`).
//! - `POST /setup/validate` — dry-run of the shared validators
//!   (`server_config_file::validate_answers` — the same rules the CLI
//!   wizard uses); always 200 with `{ok, fieldErrors}`.
//! - `POST /setup/apply` — validate → persist `server-config.json` → reply
//!   `{ok, host, port, webAuthToken?}` → `schedule_self_restart` re-execs
//!   into normal mode.
//!
//! All `/setup/*` replies ride the shared `IpcBody` envelope
//! (`{success, data}` for verdicts, `{success:false, error, code}` for
//! gate/transport refusals) — the renderer's `parseBody` only understands
//! that shape.
//!
//! Every `/setup/*` route requires this boot's one-time setup token via the
//! `?setup=` query param or `Authorization: Bearer` (spec Decision 1 — one
//! code path, loopback included). `/health` and the static/SPA fallback
//! stay public so the onboarding page can load. The whole router is wrapped
//! in `origin::layer` like the normal router — browser POSTs carry Origin.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Serialize;
use subtle::ConstantTimeEq;
use tokio::net::TcpListener;

use crate::onboard::OnboardAnswers;
use crate::web::assets;
use crate::web::config::BindMode;
use crate::web::fs_api::IpcBody;
use crate::web::origin::{self, OriginPolicy};
use crate::web::route_deadline;
use crate::web::server_config_file::{
    self, ServerSetupAnswers, SetupFieldErrors,
};

/// State behind the setup-mode router — a few resolved values, never a
/// configured `AppState`.
#[derive(Clone)]
pub struct SetupState {
    /// This boot's one-time setup token — required on every `/setup/*`
    /// call. In-memory only (spec: never written to the config file); it
    /// reaches the operator once via the printed `?setup=` URL.
    setup_token: String,
    /// `OnboardAnswers::defaults()` — the wizard's server-side pre-fill,
    /// advertised by `GET /setup/status`.
    defaults: ServerSetupAnswers,
    /// Resolved service-account state dir — apply writes
    /// `server-config.json` here.
    state_dir: PathBuf,
    /// The bearer token the post-restart server will demand while its gate
    /// is active, resolved by `web::auth::resolve` this boot (a generated
    /// token is already persisted to `<state dir>/web-auth-token`, so the
    /// re-exec'd server reloads the SAME secret). `None` when this boot
    /// resolved `Ungated`.
    web_auth_token: Option<String>,
    /// `true` when the gate token was operator-configured
    /// (`--web-auth-token`/`TERMUL_WEB_AUTH_TOKEN`) — a configured token
    /// keeps gating even a loopback post-setup bind, while a generated/
    /// loaded file token is only demanded on a non-loopback bind.
    web_auth_configured: bool,
    /// Runs after a successful apply; production wires
    /// [`server_config_file::schedule_self_restart`] (400ms delay →
    /// `restart_binary(current_exe())`). Tests substitute a recorder —
    /// the real hook re-execs the process binary.
    restart_hook: Arc<dyn Fn(&'static str) + Send + Sync>,
    /// One apply at a time, latched once a restart is scheduled — a second
    /// apply in the pending-restart window would write a config the caller
    /// is never redirected to (the re-exec loads the last file written).
    apply_in_flight: Arc<AtomicBool>,
}

impl SetupState {
    /// Production state: wizard defaults from [`OnboardAnswers::defaults`]
    /// — except the sessions/projects paths, which MUST come from the
    /// boot's resolved `ServerConfig` so they honor `--state-dir`
    /// (`OnboardAnswers::defaults()` resolves via platform dirs and would
    /// point a `--state-dir` install at ANOTHER host's data dir — the
    /// applied config would then fail the restarted server's data-lock
    /// check). `server_main` mints the setup token and threads in the
    /// `resolve` result (`web_auth_token` + `web_auth_configured`) for the
    /// apply reply's `webAuthToken` hand-off.
    pub fn new(
        setup_token: String,
        state_dir: PathBuf,
        sessions_dir: PathBuf,
        projects_file: PathBuf,
        web_auth_token: Option<String>,
        web_auth_configured: bool,
    ) -> Self {
        let mut answers = OnboardAnswers::defaults();
        answers.sessions_dir = sessions_dir;
        answers.projects_file = crate::onboard::normalize_projects_file_path(projects_file);
        Self {
            setup_token,
            defaults: ServerSetupAnswers::from(&answers),
            state_dir,
            web_auth_token,
            web_auth_configured,
            restart_hook: Arc::new(server_config_file::schedule_self_restart),
            apply_in_flight: Arc::new(AtomicBool::new(false)),
        }
    }
}

/// The active setup gate: one per-boot token, compared in constant time
/// (mirrors `web::auth::WebAuth::accepts` — no early-exit byte compare).
#[derive(Clone)]
struct SetupGate {
    token: String,
}

impl SetupGate {
    fn accepts(&self, presented: &str) -> bool {
        self.token
            .as_bytes()
            .ct_eq(presented.as_bytes())
            .into()
    }
}

/// Build the setup-mode router: `/health` + the token-gated `/setup/*` API
/// + the static/SPA fallback (same disk-`ServeDir`-or-embed mechanism as
///   `web::router::router`, so the onboarding page loads identically),
///   wrapped in `origin::layer`.
///
/// `allowed_origins` mirrors the normal router's policy — browser POSTs to
/// `/setup/*` carry Origin and must pass the same check.
pub fn router(state: SetupState, allowed_origins: OriginPolicy) -> Router {
    router_inner(state, allowed_origins, None)
}

/// Same as [`router`] but serves statics from `static_dir` — the
/// `router_with_static` test-variant pattern from `web::router` (kept in
/// sync: same route set, same layers).
pub fn router_with_static(
    state: SetupState,
    static_dir: &Path,
    allowed_origins: OriginPolicy,
) -> Router {
    router_inner(state, allowed_origins, Some(static_dir.to_path_buf()))
}

fn router_inner(
    state: SetupState,
    allowed_origins: OriginPolicy,
    static_dir: Option<PathBuf>,
) -> Router {
    // `/setup/*` behind the one-time setup token. `route_layer` wraps only
    // the routes already registered on this sub-router — `/health` (on the
    // outer router) and the static fallback stay open so the page can load.
    let setup_api = Router::new()
        .route("/setup/status", get(setup_status))
        .route("/setup/validate", post(setup_validate))
        .route("/setup/apply", post(setup_apply))
        .route_layer(middleware::from_fn_with_state(
            SetupGate {
                token: state.setup_token.clone(),
            },
            setup_token_gate,
        ));
    let mut r = Router::new().route("/health", get(health_check)).merge(setup_api);
    // Static fallback: disk ServeDir in dev (dist-web/), the embedded bundle
    // otherwise — identical decision to `web::router::router`.
    match static_dir {
        Some(dir) => r = r.fallback_service(assets::static_service_from(&dir)),
        None if assets::dist_web_ready() => {
            r = r.fallback_service(assets::static_service());
        }
        None => r = r.fallback(assets::serve_embedded),
    }
    // Same response layers as the normal router: no-cache shell/PWA files,
    // route deadlines (a no-op here — no /git//worktree/ routes exist), and
    // gzip + immutable Vite-hashed asset caching (#857).
    r = r.layer(middleware::from_fn(assets::shell_no_cache_headers));
    r = r.layer(middleware::from_fn(route_deadline::bound));
    r = r
        .layer(middleware::from_fn(assets::immutable_asset_cache_headers))
        .layer(assets::static_compression_layer());
    // Origin check is the outer layer (browser POSTs carry Origin); the
    // setup-token gate runs inside it on /setup/* only.
    origin::layer(r, allowed_origins).with_state(state)
}

/// Bind + serve the setup-mode router until SIGINT/SIGTERM — the same
/// signal contract as `web::serve` (which owns the shared
/// `shutdown_signal_future` this reuses). No `AppState`, no registry, no
/// store, no PTY stack — setup mode never constructs the configured stack.
pub async fn serve(
    state: SetupState,
    bind_addr: SocketAddr,
    allowed_origins: OriginPolicy,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let listener = TcpListener::bind(bind_addr).await?;
    let addr = listener.local_addr()?;
    tracing::info!(
        target: "termul::web::setup",
        "setup-mode server listening on http://{addr}"
    );
    if !assets::dist_web_ready() {
        tracing::warn!(
            "dist-web/index.html not found at {:?} — run `bun run build:web` before browsing; \
             /health + /setup/* still work, static routes will 404",
            assets::dist_web_dir()
        );
    }
    let app = router(state, allowed_origins);
    axum::serve(listener, app.into_make_service())
        .with_graceful_shutdown(super::shutdown_signal_future())
        .await?;
    tracing::info!(target: "termul::web::setup", "setup-mode server stopped");
    Ok(())
}

/// `GET /health` (setup mode) — the normal router's health body plus
/// `setupRequired: true` so the web client detects setup pre-auth (wire:
/// `server-setup.types.ts`). `allowRemoteWrites` is `false`: setup mode
/// mounts no write routes at all, so nothing can write.
async fn health_check() -> impl IntoResponse {
    (
        StatusCode::OK,
        Json(HealthBody {
            status: "ok",
            allow_remote_writes: false,
            case_insensitive_paths: PATHS_CASE_INSENSITIVE_BY_TARGET,
            setup_required: true,
        }),
    )
}

/// `GET /setup/status` — `SetupStatusResponse` inside the shared `IpcBody`
/// envelope (the renderer's `getJson`/`parseBody` only understands
/// `{success, data}`): `setupRequired` plus the server-side defaults
/// (`OnboardAnswers::defaults()`) the wizard pre-fills. When setup mode is
/// running because an EXISTING config file is corrupt (a hand-edit, a
/// partial write, or a sessions dir that became a file), `configError`
/// carries the load failure so the wizard can explain the recovery instead
/// of re-showing the form with no context.
async fn setup_status(State(state): State<SetupState>) -> impl IntoResponse {
    let config_error = server_config_file::load(&state.state_dir)
        .err()
        .map(|e| e.to_string());
    Json(IpcBody::ok(StatusBody {
        setup_required: true,
        config_error,
        defaults: state.defaults.clone(),
    }))
}

/// `POST /setup/validate` — dry-run the shared validators; always 200 with
/// `SetupValidateResponse` `{ok, fieldErrors}` in the `IpcBody` envelope
/// (absent field = valid). Writes nothing.
async fn setup_validate(Json(answers): Json<ServerSetupAnswers>) -> impl IntoResponse {
    match server_config_file::validate_answers(&answers) {
        Ok(_) => Json(IpcBody::ok(ValidateReply {
            ok: true,
            field_errors: SetupFieldErrors::default(),
        })),
        Err(field_errors) => {
            tracing::debug!(
                target: "termul::web::setup",
                "setup validate reported field errors: {field_errors:?}"
            );
            Json(IpcBody::ok(ValidateReply {
                ok: false,
                field_errors,
            }))
        }
    }
}

/// `POST /setup/apply` — validate → persist `server-config.json` → reply
/// `{ok, host, port, webAuthToken?}` in the `IpcBody` envelope → schedule the
/// re-exec restart (~400ms, inside `schedule_self_restart`) so the response
/// reaches the client first. A validation failure is the same 200 +
/// `{ok:false, fieldErrors}` verdict the dry-run returns (app-level verdicts
/// ride in the body, not the status — the renderer surfaces the per-field
/// errors inline) and writes nothing.
async fn setup_apply(
    State(state): State<SetupState>,
    Json(answers): Json<ServerSetupAnswers>,
) -> Response {
    // One apply at a time — and never a second one once the restart is
    // scheduled: it would write a config the caller is never redirected to
    // (the re-exec loads the last file written). `swap` keeps the flag set
    // on the success path; failure paths reset it below.
    if state.apply_in_flight.swap(true, Ordering::SeqCst) {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "success": false,
                "error": "a setup apply is already in progress — the server is restarting",
                "code": "SETUP_APPLY_IN_PROGRESS",
            })),
        )
            .into_response();
    }
    let validated = match server_config_file::validate_answers(&answers) {
        Ok(file) => file,
        Err(field_errors) => {
            tracing::info!(
                target: "termul::web::setup",
                "setup apply rejected invalid answers: {field_errors:?}"
            );
            state.apply_in_flight.store(false, Ordering::SeqCst);
            return Json(IpcBody::ok(ValidateReply {
                ok: false,
                field_errors,
            }))
            .into_response();
        }
    };
    // `webAuthToken` lets the client land on the post-restart origin already
    // authenticated (`#token=`). It is only sent when the restarted server
    // will actually demand a token: an operator-configured token gates ANY
    // post-setup bind (loopback included); otherwise the persisted file
    // token gates only a non-loopback post-setup bind. When this boot
    // resolved Ungated there is normally no token to hand over — UNLESS the
    // wizard picked a public bind (an explicit `--host 127.0.0.1` setup boot
    // never generated one). Mirror `server_config_post`: mint + persist the
    // post-restart token NOW, exactly the way the re-exec'd `resolve` will,
    // and refuse the apply BEFORE writing when that fails — the restart
    // would fail closed and strand the server with nothing to recover.
    let post_setup_public = BindMode::parse(&validated.host) == Some(BindMode::All);
    let post_setup_gated = state.web_auth_configured || post_setup_public;
    let mut web_auth_token = if post_setup_gated {
        state.web_auth_token.clone()
    } else {
        None
    };
    if web_auth_token.is_none() && post_setup_public {
        match post_setup_public_bind_token(&state.state_dir) {
            Ok(token) => web_auth_token = Some(token),
            Err(error) => {
                tracing::error!(
                    target: "termul::web::setup",
                    "setup apply refused — cannot resolve the post-restart web \
                     auth token: {error}"
                );
                state.apply_in_flight.store(false, Ordering::SeqCst);
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
    }
    if let Err(error) = server_config_file::save(&state.state_dir, &validated) {
        tracing::error!(
            target: "termul::web::setup",
            path = %server_config_file::server_config_path(&state.state_dir).display(),
            "setup apply could not write the server config: {error}"
        );
        state.apply_in_flight.store(false, Ordering::SeqCst);
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "success": false,
                "error": "could not write the server config file — check the server logs",
                "code": "CONFIG_WRITE_FAILED",
            })),
        )
            .into_response();
    }
    tracing::info!(
        target: "termul::web::setup",
        host = %validated.host,
        port = validated.port,
        "setup answers applied — server config written; restarting into normal mode"
    );
    (state.restart_hook)("setup-apply");
    Json(IpcBody::ok(ApplyReply {
        ok: true,
        host: validated.host,
        port: validated.port,
        web_auth_token,
    }))
    .into_response()
}

/// Resolve the token a post-setup PUBLIC bind will demand, exactly the way
/// the re-exec'd `server_main` resolves it — [`auth::resolve`] load-or-
/// generate + persist of `<state_dir>/web-auth-token` — then read the file
/// back for the reply. Needed only when this boot resolved Ungated (an
/// explicit `--host 127.0.0.1` setup boot) but the wizard chose a public
/// bind: without it the restarted server mints a NEW token the client never
/// sees. Mirrors `router.rs::post_restart_public_bind_token`.
fn post_setup_public_bind_token(state_dir: &Path) -> Result<String, String> {
    match crate::web::auth::resolve(Some(BindMode::All), None, state_dir)? {
        crate::web::auth::WebAuthResolution::Gated { .. } => {
            let path = state_dir.join(crate::web::auth::WEB_AUTH_TOKEN_FILE);
            let contents = std::fs::read_to_string(&path).map_err(|error| {
                format!(
                    "could not read back the web auth token file '{}': {error}",
                    path.display(),
                )
            })?;
            crate::web::auth::WebAuthToken::new(&contents)
                .map(|token| token.as_str().to_string())
                .ok_or_else(|| format!("web auth token file '{}' is empty", path.display()))
        }
        crate::web::auth::WebAuthResolution::Ungated => Err(
            "web auth resolution returned Ungated for a public bind".to_string(),
        ),
    }
}

/// Axum middleware enforcing the one-time setup token on `/setup/*`.
/// Accepts `?setup=<token>` (the bootstrap URL's query param) or
/// `Authorization: Bearer <token>` (what the web-setup facade sends). The
/// 401 body mirrors `web::router::web_auth_gate`'s `IpcBody`-ish shape; the
/// token is never logged or echoed.
async fn setup_token_gate(
    State(gate): State<SetupGate>,
    request: Request,
    next: Next,
) -> Response {
    match presented_setup_token(&request) {
        Some(presented) if gate.accepts(&presented) => next.run(request).await,
        _ => {
            tracing::warn!(
                target: "termul::web::setup",
                path = %request.uri().path(),
                "setup gate refused /setup request (missing or wrong setup token)"
            );
            (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({
                    "success": false,
                    "error": "Unauthorized",
                    "code": "UNAUTHORIZED",
                })),
            )
                .into_response()
        }
    }
}

/// The presented setup token: `Authorization: Bearer` wins, then the
/// `?setup=` query param (the bootstrap URL's query rides along when the
/// client proxies it onto API calls).
fn presented_setup_token(request: &Request) -> Option<String> {
    if let Some(token) = bearer_token(request) {
        return Some(token);
    }
    setup_query_token(request.uri().query()?)
}

/// `Authorization: Bearer <token>` — same extraction rule as
/// `web::router`'s gate (scheme match is case-insensitive, RFC 7235).
fn bearer_token(request: &Request) -> Option<String> {
    let value = request.headers().get(axum::http::header::AUTHORIZATION)?;
    let value = value.to_str().ok()?;
    let bytes = value.as_bytes();
    if bytes.len() > 7 && value[..6].eq_ignore_ascii_case("bearer") && bytes[6] == b' ' {
        return Some(value[7..].to_string());
    }
    None
}

/// The `?setup=` query value, percent-decoded (generated tokens are
/// base64url, so decoding is normally identity — it only normalizes a
/// client that encoded anyway).
fn setup_query_token(query: &str) -> Option<String> {
    for pair in query.split('&') {
        let Some((name, value)) = pair.split_once('=') else {
            continue;
        };
        if name == "setup" {
            return Some(percent_decode(value));
        }
    }
    None
}

/// Minimal `%XX` percent-decoding for a query value. `+` is deliberately
/// NOT translated — the setup token alphabet is base64url (`A-Z a-z 0-9 - _`),
/// so a literal `+` can never belong to a valid token.
fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_value(bytes[i + 1]), hex_value(bytes[i + 2])) {
                out.push(hi << 4 | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// The source of truth for the web client's path case rule (#641) — mirrors
/// the normal router's health body; kept identical so both routers report
/// the same filesystem folding behavior.
const PATHS_CASE_INSENSITIVE_BY_TARGET: bool = cfg!(any(windows, target_os = "macos"));

/// `GET /health` response body (setup mode): the normal router's shape plus
/// `setupRequired`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthBody {
    status: &'static str,
    allow_remote_writes: bool,
    case_insensitive_paths: bool,
    setup_required: bool,
}

/// `GET /setup/status` response body — `SetupStatusResponse`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusBody {
    setup_required: bool,
    /// Why the server is in setup mode despite a config file being present —
    /// the `server_config_file::load` failure (`Ok(None)`/valid file →
    /// absent). Lets the wizard say "your saved config was invalid" instead
    /// of silently re-onboarding.
    #[serde(skip_serializing_if = "Option::is_none")]
    config_error: Option<String>,
    defaults: ServerSetupAnswers,
}

/// `{ok, fieldErrors}` — `SetupValidateResponse`; reused as the 400 body of
/// `POST /setup/apply` validation failures.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ValidateReply {
    ok: bool,
    field_errors: SetupFieldErrors,
}

/// `SetupApplyResponse` — the `POST /setup/apply` success body.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplyReply {
    ok: bool,
    /// Effective host/port the server will bind after the restart.
    host: String,
    port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    web_auth_token: Option<String>,
}

#[cfg(test)]
mod tests;
