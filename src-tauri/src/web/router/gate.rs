//! The bearer-token gate in front of the API routes.

use std::sync::Arc;

use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    Json, Router,
};

use crate::canvas::bundle_path::{is_bundle_path, redact_canvas_path};
use crate::web::auth::{BearerVerified, WebAuth};

/// Apply the web auth middleware to the router when the gate is active.
/// Public paths (`/health`, `/ws`, `/terminal/ws`, `/oauth/callback`, and all
/// non-API static/SPA paths) always pass — see [`web_auth_gate`]. Generic over
/// the router's (still-missing) state type so both `router` and
/// `router_with_static` can call it before `with_state`.
pub(super) fn maybe_gate_api<S>(web_auth: Option<Arc<WebAuth>>, r: Router<S>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    match web_auth {
        Some(auth) => r.layer(middleware::from_fn_with_state(auth, web_auth_gate)),
        None => r,
    }
}

/// Exact paths that never require the token: the liveness probe, both WS
/// endpoints (they gate in-protocol, after the upgrade), and the OAuth
/// redirect target (the authorization server cannot carry the token).
pub(super) const PUBLIC_PATHS: &[&str] = &["/health", "/ws", "/terminal/ws", "/oauth/callback"];

/// API route prefixes that require the token when the gate is active
/// (every endpoint). Everything else — the static bundle and
/// SPA client routes — stays public so the login page can load.
const GATED_PREFIXES: &[&str] = &[
    "/host/",
    "/projects",
    "/project/",
    "/mcp-servers",
    "/mcp-catalog/",
    "/fs/",
    "/git/",
    "/github/",
    "/search/",
    "/skills",
    "/log/",
    "/shells",
    "/acp/",
    "/worktree/",
    // Automations and their runs, agents and secrets.
    "/api/automation",
    // The /canvas/ API routes require the token. The /canvas/<id>/* bundle
    // paths are exempt — see [`is_bundle_path`] (canvas-token authed
    // in the sub-router).
    "/canvas/",
];


/// Whether `path` is a gated API route. Pure decision fn (unit-testable).
pub(super) fn requires_token(path: &str) -> bool {
    if PUBLIC_PATHS.contains(&path) {
        return false;
    }
    // Canvas bundle paths carry their own canvas token in the path; the
    // outer bearer gate skips them.
    if is_bundle_path(path) {
        return false;
    }
    GATED_PREFIXES.iter().any(|prefix| path.starts_with(prefix))
}

/// Extract the presented token from the `Authorization: Bearer <token>`
/// header (scheme match is case-insensitive, RFC 7235). There is
/// deliberately NO `?token=` query-param fallback on gated API routes:
/// query strings end up in access logs, proxy logs, and `Referer` headers,
/// which is exactly where a bearer credential must not live. The bootstrap
/// URL carries the token in the URL FRAGMENT (`#token=`) instead —
/// fragments are never sent to the server — and the browser client moves it
/// to localStorage + the `Authorization` header on first load
/// (`src/renderer/lib/web-auth-token.ts`).
fn presented_token(request: &Request) -> Option<String> {
    let value = request.headers().get(axum::http::header::AUTHORIZATION)?;
    let value = value.to_str().ok()?;
    let bytes = value.as_bytes();
    if bytes.len() > 7 && value[..6].eq_ignore_ascii_case("bearer") && bytes[6] == b' ' {
        return Some(value[7..].to_string());
    }
    None
}

/// Axum middleware enforcing the web auth gate on gated API routes. The 401
/// body mirrors the `IpcBody` failure shape (`{success, error, code}`) the
/// renderer's REST helpers parse; the token is never logged or echoed.
async fn web_auth_gate(
    State(auth): State<Arc<WebAuth>>,
    mut request: Request,
    next: Next,
) -> Response {
    if !requires_token(request.uri().path()) {
        return next.run(request).await;
    }
    let presented = presented_token(&request);
    match presented {
        Some(token) if auth.accepts(&token) => {
            request.extensions_mut().insert(BearerVerified);
            next.run(request).await
        }
        _ => {
            tracing::warn!(
                target: "termul::web::router",
                path = %redact_canvas_path(request.uri().path()),
                "web auth gate refused API request"
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
