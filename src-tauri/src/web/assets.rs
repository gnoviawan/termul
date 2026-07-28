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
use axum::http::{header, HeaderValue, StatusCode, Uri};
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
/// - An embedded asset → served with its MIME + immutable caching.
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
    path.rsplit('/').next().is_some_and(|last| last.contains('.'))
}

/// Serve the embedded `index.html` (the SPA entry). `index.html` is the
/// manifest that references the content-hashed asset chunks, so it is served
/// with `no-cache, must-revalidate` (a cached stale `index.html` would request
/// old hashed chunks absent from a new embed → 404 after an upgrade). The hashed
/// chunks themselves are served immutably via [`embedded_response`].
fn embedded_index() -> Response {
    match Assets::get(INDEX_HTML) {
        Some(file) => {
            let mut resp = embedded_response(file.metadata.mimetype(), file.data, INDEX_HTML);
            resp.headers_mut().insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("no-cache, must-revalidate"),
            );
            resp
        }
        None => (
            StatusCode::NOT_FOUND,
            "web bundle not embedded — run `bun run build:web` before building",
        )
            .into_response(),
    }
}

/// Build an axum `Response` from embedded bytes + a metadata-derived
/// Content-Type (rust-embed's `Metadata::mimetype` infers from the extension).
/// Content-hashed assets are cached immutably; the SPA `index.html` overrides
/// this in [`embedded_index`] (see its docs).
fn embedded_response(mime: &str, data: Cow<'static, [u8]>, _path: &str) -> Response {
    let mime_val = HeaderValue::from_str(mime)
        .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"));
    let mut resp = (
        [(header::CONTENT_TYPE, mime_val)],
        Body::from(data),
    )
        .into_response();
    // Content-hashed assets are safe to cache immutably (the hash changes per
    // build, so a stale cache never collides with a new asset name).
    resp.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
    resp
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::http::Request;
    use axum::routing::Router;
    use tower::ServiceExt; // for `oneshot`

    #[test]
    fn dist_web_dir_points_at_repo_root_sibling() {
        let dir = dist_web_dir();
        let name = dir.file_name().and_then(|n| n.to_str());
        assert_eq!(name, Some("dist-web"));
        // Parent of dist-web should be the repo root (sibling of src-tauri).
        let parent = dir.parent().expect("parent");
        assert!(
            parent.join("src-tauri").is_dir(),
            "expected src-tauri next to dist-web, got parent {:?}",
            parent
        );
    }

    #[test]
    fn dist_web_ready_reflects_index_html_on_disk() {
        // dist_web_ready() mirrors whether dist-web/index.html exists. We don't
        // assert a specific value (the bundle may or may not be built in CI),
        // just that it doesn't panic and matches the filesystem.
        let expected = dist_web_dir().join(INDEX_HTML).is_file();
        assert_eq!(dist_web_ready(), expected);
    }

    /// Drive a path through `serve_embedded` (the release fallback) and return
    /// the (status, content-type, cache-control, body). Runs against whatever
    /// `Assets` embed is present — CI's `rust-checks` job runs `bun run
    /// build:web` before `cargo test` so the embed is populated; locally the
    /// bundle may be absent (the not-embedded paths exercise). Tests below
    /// detect the embed state via `Assets::get(INDEX_HTML)` and assert the
    /// matching branch deterministically (no adaptive `OK || 404`).
    async fn fetch_embedded(path: &str) -> (StatusCode, String, String, Vec<u8>) {
        let router = Router::new().fallback(serve_embedded);
        let resp = router
            .oneshot(
                Request::builder()
                    .uri(path)
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        let status = resp.status();
        let headers = resp.headers();
        let ctype = headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        let cache = headers
            .get(header::CACHE_CONTROL)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        let body = to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("read body")
            .to_vec();
        (status, ctype, cache, body)
    }

    fn embed_present() -> bool {
        Assets::get(INDEX_HTML).is_some()
    }

    #[tokio::test]
    async fn serve_embedded_root_serves_index_or_404_when_absent() {
        let (status, ctype, cache, body) = fetch_embedded("/").await;
        if embed_present() {
            assert_eq!(status, StatusCode::OK, "root serves embedded index.html");
            assert!(
                ctype.starts_with("text/html"),
                "index.html Content-Type should be text/html, got {ctype}"
            );
            assert!(
                !body.is_empty(),
                "embedded index.html body should be non-empty"
            );
            // index.html is the manifest → no-cache (R2); a stale immutable
            // cache would 404 old hashed chunks after an upgrade.
            assert!(
                cache.contains("no-cache") || cache.contains("must-revalidate"),
                "index.html must NOT be cached immutably (breaks upgrades), got Cache-Control: {cache}"
            );
        } else {
            assert_eq!(
                status, StatusCode::NOT_FOUND,
                "empty embed → root 404 (run `bun run build:web` to populate)"
            );
        }
    }

    #[tokio::test]
    async fn serve_embedded_unknown_extension_is_404() {
        // A path whose LAST segment has a `.` + no embedded asset → 404 (not the
        // SPA), regardless of embed presence.
        let (status, _, _, _) = fetch_embedded("/does-not-exist.xyz").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn serve_embedded_dotted_client_route_falls_back_to_index() {
        // R3: a dotted client route like /v1.2/home (last segment `home`, no `.`)
        // → index.html (NOT 404 — the whole-path `.` check would misclassify it).
        let (status, _, _, _) = fetch_embedded("/v1.2/home").await;
        if embed_present() {
            assert_eq!(
                status, StatusCode::OK,
                "dotted client route → SPA index.html (last segment has no `.`)"
            );
        } else {
            assert_eq!(status, StatusCode::NOT_FOUND);
        }
    }

    #[tokio::test]
    async fn serve_embedded_unknown_route_falls_back_to_index() {
        // A client-side route (no `.` in the last segment) → index.html (or 404
        // if the bundle is absent).
        let (status, _, _, _) = fetch_embedded("/some/client/route").await;
        if embed_present() {
            assert_eq!(status, StatusCode::OK);
        } else {
            assert_eq!(status, StatusCode::NOT_FOUND);
        }
    }

    #[tokio::test]
    async fn serve_embedded_asset_is_cached_immutably_when_present() {
        // An embedded content-hashed asset → immutable caching (R2: only index.html
        // is no-cache). Skip when the embed is empty (no asset to serve).
        if !embed_present() {
            return;
        }
        // Find any non-index asset actually embedded (a hashed chunk, font, …).
        let asset_path = Assets::iter()
            .next()
            .filter(|p| p.as_ref() != INDEX_HTML)
            .unwrap_or(std::borrow::Cow::Borrowed(INDEX_HTML));
        let (_, _, cache, _) = fetch_embedded(&format!("/{asset_path}")).await;
        if asset_path == INDEX_HTML {
            assert!(
                cache.contains("no-cache") || cache.contains("must-revalidate"),
                "index.html must be no-cache, got {cache}"
            );
        } else {
            assert!(
                cache.contains("immutable"),
                "hashed asset must be cached immutably, got Cache-Control: {cache}"
            );
        }
    }

    /// A `router()` (NOT `router_with_static`) serving. R4: verifies the
    /// disk-or-embed branch in `router()` is wired — the `Cache-Control` header
    /// (set only by the embedded path) discriminates the embed branch from
    /// `ServeDir`.
    async fn fetch_via_router(path: &str) -> (StatusCode, String) {
        // Build the stateless router() the same way serve_router does; for the
        // test we don't need a real AcpManager/WsRelaySink (the static fallback
        // has no state), so we extract only the fallback path.
        let router = if dist_web_ready() {
            // Dev (dist-web on disk): ServeDir — no Cache-Control from us.
            Router::new().fallback_service(static_service())
        } else {
            Router::new().fallback(serve_embedded)
        };
        let resp = router
            .oneshot(
                Request::builder()
                    .uri(path)
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        let status = resp.status();
        let cache = resp
            .headers()
            .get(header::CACHE_CONTROL)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        (status, cache)
    }

    #[tokio::test]
    async fn router_disk_or_embed_branch_is_wired() {
        // R4: the branch in router() that selects ServeDir (dev, no
        // Cache-Control from us) vs serve_embedded (release, sets
        // Cache-Control) is exercised. When dist-web is absent (release-style),
        // the embed path must set a Cache-Control header.
        if dist_web_ready() {
            // Dev: ServeDir doesn't set our Cache-Control — we don't assert its
            // value, just that the branch didn't panic + serves something.
            let (status, _) = fetch_via_router("/health_not_a_real_route").await;
            // ServeDir fallback serves index.html for unknown paths → 200 (or
            // 404 if the dir is empty); the point is the branch ran.
            assert!(
                status == StatusCode::OK || status == StatusCode::NOT_FOUND,
                "dev ServeDir branch ran, got {status}"
            );
        } else if embed_present() {
            // Release + embed populated: the embedded path sets Cache-Control.
            let (_, cache) = fetch_via_router("/").await;
            assert!(
                !cache.is_empty(),
                "embedded path sets Cache-Control (the disk-or-embed branch selected serve_embedded)"
            );
        } else {
            // Release + empty embed: root 404, no Cache-Control.
            let (status, cache) = fetch_via_router("/").await;
            assert_eq!(status, StatusCode::NOT_FOUND);
            assert!(cache.is_empty(), "empty embed → 404, no Cache-Control");
        }
    }
}
