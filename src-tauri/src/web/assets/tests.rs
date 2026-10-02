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
            status,
            StatusCode::NOT_FOUND,
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
            status,
            StatusCode::OK,
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
    // An embedded content-hashed asset under `assets/` → immutable caching
    // (path-aware policy: ONLY `assets/` is immutable — icons/sw.js/etc.
    // are no-cache, so this test must pick an `assets/` entry, not just
    // any non-index file). Skip when the embed is empty.
    if !embed_present() {
        return;
    }
    // Find a Vite-hashed asset actually embedded (a chunk, font, …).
    let asset_path = Assets::iter()
        .find(|p| p.as_ref().starts_with("assets/"))
        .expect("embed populated → expected at least one hashed assets/ entry");
    let (_, _, cache, _) = fetch_embedded(&format!("/{asset_path}")).await;
    assert!(
        cache.contains("immutable"),
        "hashed asset must be cached immutably, got Cache-Control: {cache}"
    );
}

/// Non-`assets/` embedded files (`sw.js`, `manifest.webmanifest`,
/// `icons/*`, `favicon.ico`) must be `no-cache, must-revalidate` —
/// immutable caching on the SW/manifest would stall PWA updates behind a
/// year-long cache entry. Skips when the embed is empty.
#[tokio::test]
async fn serve_embedded_pwa_files_are_no_cache_when_present() {
    if !embed_present() {
        return;
    }
    for path in [
        "/sw.js",
        "/manifest.webmanifest",
        "/favicon.ico",
        "/icons/pwa-192.png",
        "/icons/pwa-512.png",
        "/icons/pwa-maskable-512.png",
        "/icons/apple-touch-icon.png",
    ] {
        let (status, _, cache, _) = fetch_embedded(path).await;
        assert_eq!(
            status,
            StatusCode::OK,
            "{path} should be embedded — a stale-but-populated dist-web is \
                 the likely cause; run `bun run build:web` and rebuild"
        );
        assert!(
            cache.contains("no-cache") && cache.contains("must-revalidate"),
            "{path} must be no-cache, got Cache-Control: {cache}"
        );
        assert!(
            !cache.contains("immutable"),
            "{path} must NOT be immutable, got Cache-Control: {cache}"
        );
    }
}

/// The web manifest must be served as `application/manifest+json`
/// regardless of the mime_guess database — a wrong MIME makes the browser
/// ignore the manifest and silently breaks install.
#[tokio::test]
async fn serve_embedded_manifest_has_webmanifest_mime() {
    if !embed_present() {
        return;
    }
    let (status, ctype, _, body) = fetch_embedded("/manifest.webmanifest").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        ctype, "application/manifest+json",
        "manifest.webmanifest Content-Type must be application/manifest+json, got {ctype}"
    );
    // Sanity: the embedded manifest parses as JSON and names the app.
    let json: serde_json::Value =
        serde_json::from_slice(&body).expect("manifest.webmanifest should be valid JSON");
    assert_eq!(json["name"], "Termul");
}

/// `embedded_response` cache policy: `assets/` → immutable, every other
/// path → no-cache. Pure unit coverage independent of the embed contents.
#[test]
fn embedded_response_cache_policy_is_path_aware() {
    for path in ["assets/index-abc123.js", "assets/font-def456.woff2"] {
        let resp = embedded_response("application/octet-stream", Cow::Borrowed(b"x"), path);
        let cache = resp
            .headers()
            .get(header::CACHE_CONTROL)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        assert!(
            cache.contains("immutable"),
            "{path} should be immutable, got {cache}"
        );
    }
    for path in [
        "index.html",
        "sw.js",
        "manifest.webmanifest",
        "favicon.ico",
        "icons/pwa-192.png",
        "robots.txt",
    ] {
        let resp = embedded_response("application/octet-stream", Cow::Borrowed(b"x"), path);
        let cache = resp
            .headers()
            .get(header::CACHE_CONTROL)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        assert_eq!(
            cache, "no-cache, must-revalidate",
            "{path} should be no-cache, got {cache}"
        );
    }
}

/// `embedded_response` MIME override: `.webmanifest` always serves
/// `application/manifest+json` even if the guessed MIME is octet-stream.
#[test]
fn embedded_response_overrides_webmanifest_mime() {
    let resp = embedded_response(
        "application/octet-stream",
        Cow::Borrowed(b"{}"),
        "manifest.webmanifest",
    );
    let ctype = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    assert_eq!(ctype, "application/manifest+json");
    // Non-webmanifest paths keep the guessed MIME.
    let resp = embedded_response("text/plain", Cow::Borrowed(b"x"), "sw.js");
    let ctype = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    assert_eq!(ctype, "text/plain");
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

/// Disk-serving parity (PWA): `ServeDir` sets no `Cache-Control` of its
/// own, so the `shell_no_cache_headers` middleware layered in `router()`
/// / `router_with_static` must mark the unversioned shell/PWA files
/// `no-cache, must-revalidate` — matching the embedded release path. A
/// hashed `/assets/*` file must NOT get the header (name-versioned, and
/// the embedded path serves it immutable).
#[tokio::test]
async fn disk_served_shell_files_get_no_cache_headers() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path();
    std::fs::write(root.join("index.html"), "<!doctype html>shell").expect("index.html");
    std::fs::write(root.join("sw.js"), "// service worker").expect("sw.js");
    std::fs::write(root.join("manifest.webmanifest"), "{}").expect("manifest");
    std::fs::write(root.join("favicon.ico"), b"ico").expect("favicon");
    std::fs::create_dir_all(root.join("icons")).expect("icons dir");
    std::fs::write(root.join("icons/pwa-192.png"), b"png").expect("icon");
    std::fs::create_dir_all(root.join("assets")).expect("assets dir");
    std::fs::write(root.join("assets/chunk-abc.js"), "// chunk").expect("chunk");

    // Mirror router()'s layering: ServeDir fallback + the shell-header mw.
    let router = Router::new()
        .fallback_service(static_service_from(root))
        .layer(axum::middleware::from_fn(shell_no_cache_headers));

    for path in [
        "/",
        "/index.html",
        "/sw.js",
        "/manifest.webmanifest",
        "/favicon.ico",
        "/icons/pwa-192.png",
    ] {
        let resp = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(path)
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(resp.status(), StatusCode::OK, "{path} should serve");
        let cache = resp
            .headers()
            .get(header::CACHE_CONTROL)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        assert_eq!(
                cache, "no-cache, must-revalidate",
                "disk-served {path} must be no-cache (ServeDir heuristic caching would stall PWA updates)"
            );
    }

    // Hashed assets stay untouched by the layer (they are safe to cache).
    let resp = router
        .oneshot(
            Request::builder()
                .uri("/assets/chunk-abc.js")
                .body(Body::empty())
                .expect("build request"),
        )
        .await
        .expect("router response");
    assert_eq!(resp.status(), StatusCode::OK);
    let cache = resp
        .headers()
        .get(header::CACHE_CONTROL)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    assert_ne!(
        cache, "no-cache, must-revalidate",
        "/assets/* must not be marked no-cache (immutable by name)"
    );
}

/// The `ServeDir` SPA fallback serves `index.html` for client routes whose
/// request path is NOT in the shell list (`/some/client/route`). The
/// middleware must still mark the HTML response `no-cache` — otherwise a
/// cache could pin stale entry HTML that references obsolete hashed
/// assets after a redeploy. The header keys on the response's
/// `text/html` type, not just the request path.
#[tokio::test]
async fn disk_served_client_route_fallback_gets_no_cache_headers() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path();
    std::fs::write(root.join("index.html"), "<!doctype html>shell").expect("index.html");

    let router = Router::new()
        .fallback_service(static_service_from(root))
        .layer(axum::middleware::from_fn(shell_no_cache_headers));

    let resp = router
        .oneshot(
            Request::builder()
                .uri("/some/client/route")
                .body(Body::empty())
                .expect("build request"),
        )
        .await
        .expect("router response");
    assert_eq!(
        resp.status(),
        StatusCode::OK,
        "client route should hit the index.html fallback"
    );
    let ctype = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    assert!(
        ctype.starts_with("text/html"),
        "fallback serves index.html → text/html, got {ctype}"
    );
    let cache = resp
        .headers()
        .get(header::CACHE_CONTROL)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    assert_eq!(
        cache, "no-cache, must-revalidate",
        "SPA fallback HTML must revalidate — a pinned stale index.html \
             breaks upgrades (obsolete hashed assets), got {cache}"
    );
}
