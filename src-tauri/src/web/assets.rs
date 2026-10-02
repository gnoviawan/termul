//! Static serving for the ACP web server — dev `ServeDir` + production embed.
//!
//! - **Dev** (`dist-web/` on disk, built by `bun run build:web`):
//!   `tower_http::services::ServeDir` from repo-root `dist-web/` (path resolved
//!   from `CARGO_MANIFEST_DIR`, not process CWD) so Vite output changes are
//!   served without a cargo rebuild.
//! - **Release** (`dist-web/` NOT on disk, e.g. a shipped `termul-server` or
//!   desktop binary on a user/VPS machine): serve from the embedded
//!   [`Assets`] (rust-embed) so the binary is self-contained (no CDN, no disk
//!   dependency). SPA `index.html` fallback for the hash-router client.
//!
//! Both paths share the SAME fallback: when `dist_web_ready()` is true the dev
//! ServeDir is used; otherwise the embedded bundle is served. The `/health` +
//! `/ws` routes are registered BEFORE this fallback so the static mount cannot
//! shadow them (Story 1.3 AC1).

use std::borrow::Cow;
use std::path::{Path, PathBuf};

use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, HeaderValue, StatusCode, Uri};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use tower_http::services::{ServeDir, ServeFile};

// Release builds with a missing/stale `dist-web/` fail clearly here (set by
// `build.rs` via the `web_embed_missing` cfg). Dev builds stay green: rust-embed's
// `#[allow_missing]` compiles an empty embed + `debug_assertions` skips this
// gate. A release `cargo build --release` without `bun run build:web` first
// hits this error rather than shipping a binary that 404s every static route.
#[cfg(all(not(debug_assertions), web_embed_missing))]
compile_error!(
    "dist-web/ is missing or stale — run `bun run build:web` before building a \
     release binary (rust-embed embeds the Vite bundle at cargo-build time)"
);

/// The SPA entry served for any non-asset path (the hash-router client).
const INDEX_HTML: &str = "index.html";

/// Repo-root `dist-web/` directory (sibling of `src-tauri/`).
///
/// Resolved via `CARGO_MANIFEST_DIR` so serving works regardless of process CWD.
pub fn dist_web_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist-web")
}

/// Whether `dist-web/index.html` exists on disk (dev diagnostics + the
/// disk-or-embed serving decision).
pub fn dist_web_ready() -> bool {
    dist_web_dir().join(INDEX_HTML).is_file()
}

/// ServeDir + SPA `index.html` fallback for the hash-router client (dev path).
pub fn static_service() -> ServeDir<ServeFile> {
    static_service_from(&dist_web_dir())
}

/// Same as [`static_service`], but with an injectable root (unit tests).
pub fn static_service_from(dir: &Path) -> ServeDir<ServeFile> {
    ServeDir::new(dir).fallback(ServeFile::new(dir.join(INDEX_HTML)))
}

/// Whether `path` is one of the unversioned shell/PWA files that must be
/// revalidated on every load (the disk `ServeDir` path sets no
/// `Cache-Control` of its own — without this, heuristic caching would let a
/// stale `sw.js`/manifest/`index.html` stall PWA updates in source-checkout
/// deployments). Vite-hashed `/assets/*` are deliberately NOT included — they
/// are safe to cache by name (the embedded path even serves them
/// `immutable`).
fn is_shell_or_pwa_path(path: &str) -> bool {
    path == "/"
        || path == "/index.html"
        || path == "/sw.js"
        || path == "/manifest.webmanifest"
        || path == "/favicon.ico"
        || path.starts_with("/icons/")
}

/// Axum middleware: `Cache-Control: no-cache, must-revalidate` on responses
/// for the unversioned shell/PWA files (`/`, `/index.html`, `/sw.js`,
/// `/manifest.webmanifest`, `/favicon.ico`, `/icons/*`) — and on ANY
/// `text/html` response, which covers the `ServeDir` SPA fallback serving
/// `index.html` for client routes (`/some/client/route`) whose request path
/// does not match the shell list. No API route produces `text/html`, so
/// response-type matching cannot touch API policies. Layered onto the web
/// router in [`super::router::router`] + [`super::router::router_with_static`]
/// so the dev `ServeDir` path matches the embedded release path's policy —
/// idempotent there (the embedded path already sets the same value).
pub async fn shell_no_cache_headers(request: Request, next: Next) -> Response {
    let is_shell = is_shell_or_pwa_path(request.uri().path());
    let mut response = next.run(request).await;
    // A client-route fallback returns the index.html BODY under an
    // unlisted request path — key on the response type, not just the URI.
    let is_html = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("text/html"));
    if is_shell || is_html {
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-cache, must-revalidate"),
        );
    }
    response
}

/// Embedded web bundle (rust-embed). Compiled into BOTH the standalone
/// `termul-server` binary and the desktop app — the desktop's in-process
/// shared-live server serves the SAME embedded bundle in a release install
/// (no `dist-web/` on disk). `#[allow_missing]` keeps dev/CI-compile green
/// when the bundle is absent; the release build fails clearly via `build.rs`
/// when it is missing (see the `web_embed_missing` cfg in `build.rs`).
#[derive(rust_embed::Embed)]
#[folder = "../dist-web/"]
#[allow_missing = true]
pub struct Assets;

/// Axum handler: serve a path from the embedded [`Assets`], with SPA
/// `index.html` fallback for the hash-router client. Used by
/// [`super::router::router`] when `dist-web/` is not on disk (release installs).
///
/// - The root (`/`) or `/index.html` → `index.html`.
/// - An embedded asset → served with its MIME + path-aware caching (see
///   [`embedded_response`]): only Vite-hashed `assets/` output is immutable;
///   everything else (`sw.js`, `manifest.webmanifest`, `icons/*`, …) is
///   `no-cache, must-revalidate` so PWA updates are never stalled.
/// - A path whose LAST segment has a `.` (looks like a static file, e.g.
///   `/assets/index-abc.js`) but is NOT embedded → 404 (a real missing asset,
///   not a route — mirrors the rust-embed axum-spa example). Checking only the
///   LAST segment (not the whole path) avoids misclassifying dotted client
///   routes like `/v1.2/home` (last segment `home`, no `.`) as assets.
/// - Anything else (a client-side route, no `.` in the last segment) →
///   `index.html` (the SPA boots + routes client-side).
pub async fn serve_embedded(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');

    if path.is_empty() || path == INDEX_HTML {
        return embedded_index();
    }

    match Assets::get(path) {
        Some(file) => embedded_response(file.metadata.mimetype(), file.data, path),
        None => {
            if last_segment_has_extension(path) {
                (StatusCode::NOT_FOUND, "404 Not Found").into_response()
            } else {
                embedded_index()
            }
        }
    }
}

/// `true` if the last path segment contains a `.` (looks like a static file,
/// e.g. `index-abc.js`, `style.css`, `font.woff2`). Used to distinguish a
/// missing asset (404) from a client-side route (SPA `index.html`).
fn last_segment_has_extension(path: &str) -> bool {
    path.rsplit('/')
        .next()
        .is_some_and(|last| last.contains('.'))
}

/// Serve the embedded `index.html` (the SPA entry). `index.html` is the
/// manifest that references the content-hashed asset chunks, so it must NOT be
/// cached immutably (a cached stale `index.html` would request old hashed
/// chunks absent from a new embed → 404 after an upgrade). The path-aware
/// policy in [`embedded_response`] already gives it `no-cache,
/// must-revalidate` — only `assets/` paths are immutable.
fn embedded_index() -> Response {
    match Assets::get(INDEX_HTML) {
        Some(file) => embedded_response(file.metadata.mimetype(), file.data, INDEX_HTML),
        None => (
            StatusCode::NOT_FOUND,
            "web bundle not embedded — run `bun run build:web` before building",
        )
            .into_response(),
    }
}

/// Build an axum `Response` from embedded bytes + a metadata-derived
/// Content-Type (rust-embed's `Metadata::mimetype` infers from the extension).
///
/// Cache policy is path-aware (`path` is the request path with the leading `/`
/// trimmed, i.e. the rust-embed key):
/// - `assets/*` — Vite content-hashed output — is cached immutably (the hash
///   changes per build, so a stale cache never collides with a new name).
/// - Everything else — `index.html`, `sw.js`, `manifest.webmanifest`,
///   `icons/*`, `favicon.ico` — is `no-cache, must-revalidate`. Immutable
///   caching on `sw.js`/the manifest would stall SW + install-metadata updates
///   behind a year-long cache entry.
fn embedded_response(mime: &str, data: Cow<'static, [u8]>, path: &str) -> Response {
    // mime_guess maps `.webmanifest` → `application/manifest+json` on current
    // versions, but pin it explicitly — a MIME DB that misses the extension
    // would serve the manifest as octet-stream and silently break install.
    let mime = if path.ends_with(".webmanifest") {
        "application/manifest+json"
    } else {
        mime
    };
    let mime_val = HeaderValue::from_str(mime)
        .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"));
    let mut resp = ([(header::CONTENT_TYPE, mime_val)], Body::from(data)).into_response();
    let cache_control = if path.starts_with("assets/") {
        HeaderValue::from_static("public, max-age=31536000, immutable")
    } else {
        HeaderValue::from_static("no-cache, must-revalidate")
    };
    resp.headers_mut()
        .insert(header::CACHE_CONTROL, cache_control);
    resp
}

#[cfg(test)]
mod tests;
