use std::time::Duration;

use axum::body::{to_bytes, Body};
use axum::http::{header, HeaderMap, Method, Request, StatusCode, Uri};
use axum::response::Response;
use tower::ServiceExt;

use super::canvas_id_for_project;
use super::persistence::CloseMode;
use super::pin::pinned_tag;
use super::static_server::{
    bundle_router, bundle_tokens, close_canvas, close_current_canvas, open_canvas,
    same_origin_base, serve_bundle, BundleTokens, CanvasBundleBase, OpenRequest, StaticServer,
};
use crate::web::canvas_api::{canvas_router, CanvasState};
use crate::web::capabilities::WriteFlags;

fn tab(client_instance_id: &str) -> OpenRequest {
    OpenRequest {
        client_instance_id: client_instance_id.to_string(),
        autosave_ms: None,
        autosave_max_ms: None,
        lease_grace_ms: None,
        max_mounted: Some(16),
        crash_timeouts: None,
    }
}

async fn body_text(response: Response) -> String {
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    String::from_utf8_lossy(&bytes).into_owned()
}

#[test]
fn tokens_are_per_canvas_and_reused_until_revoked() {
    let tokens = BundleTokens::default();
    let first = tokens.issue("cv_tok_a").unwrap();
    assert_eq!(first.len(), 32);
    assert_eq!(
        tokens.issue("cv_tok_a").unwrap(),
        first,
        "repeat open reuses"
    );
    assert_ne!(tokens.issue("cv_tok_b").unwrap(), first);

    tokens.revoke("cv_tok_a");
    assert!(!tokens.is_issued("cv_tok_a"));
    assert!(tokens.is_issued("cv_tok_b"));
    assert_ne!(
        tokens.issue("cv_tok_a").unwrap(),
        first,
        "revoked token is not resurrected"
    );
}

#[tokio::test]
async fn open_canvas_mints_one_token_per_project_until_close() {
    let base = CanvasBundleBase {
        base_url: "http://127.0.0.1:4567".into(),
        pin_tag: "termul-test".into(),
        fallback_fonts: vec!["host-fonts/a.ttf".into()],
    };
    let project = "project-open-canvas";
    let canvas_id = canvas_id_for_project(project);
    let authorized = |token: &str| bundle_tokens().authorize(&canvas_id, token);

    let first = open_canvas(
        base.clone(),
        project,
        "C:/p/design.figcraft".into(),
        tab("tab-a"),
    )
    .await
    .unwrap();
    let wire = serde_json::to_value(&first).unwrap();
    assert_eq!(
        wire,
        serde_json::json!({
            "canvasId": canvas_id,
            "baseUrl": "http://127.0.0.1:4567",
            "canvasToken": first.canvas_token,
            "pinTag": "termul-test",
            "docKey": "C:/p/design.figcraft",
            "mountSeq": first.mount_seq,
            "evicted": [],
            "fallbackFonts": ["host-fonts/a.ttf"],
        })
    );
    assert!(
        authorized(&first.canvas_token),
        "the minted token opens the bundle"
    );

    let again = open_canvas(
        base.clone(),
        project,
        "C:/p/other.figcraft".into(),
        tab("tab-a"),
    )
    .await
    .unwrap();
    assert_eq!(
        again.canvas_token, first.canvas_token,
        "a repeat open keeps the mounted iframe's URL valid"
    );
    assert!(
        again.mount_seq > first.mount_seq,
        "every open is a new mount with a new mountSeq"
    );

    let stale = close_canvas(project, first.mount_seq, CloseMode::Save)
        .await
        .unwrap();
    assert!(!stale.unmounted, "the replaced mount's close is a no-op");
    assert!(
        authorized(&again.canvas_token),
        "the newer mount keeps the token"
    );
    close_canvas(project, again.mount_seq, CloseMode::Save)
        .await
        .unwrap();
    assert!(!authorized(&first.canvas_token), "close revokes the token");
    close_canvas(project, again.mount_seq, CloseMode::Save)
        .await
        .unwrap();

    let reopened = open_canvas(base, project, "C:/p/design.figcraft".into(), tab("tab-a"))
        .await
        .unwrap();
    assert_ne!(reopened.canvas_token, first.canvas_token);
    assert!(authorized(&reopened.canvas_token));
    close_canvas(project, reopened.mount_seq, CloseMode::Save)
        .await
        .unwrap();
}

/// Another window took the canvas over while this window's close was on its
/// way: the close lands after the takeover and must not unmount the new
/// holder's canvas or revoke the token its iframe loads with.
#[tokio::test]
async fn a_close_that_lands_after_a_takeover_leaves_the_new_mount_and_its_token() {
    let base = same_origin_base();
    let project = "project-late-close";
    let canvas_id = canvas_id_for_project(project);
    let doc = "C:/p/design.figcraft";

    let a = open_canvas(base.clone(), project, doc.into(), tab("tab-a"))
        .await
        .unwrap();
    let b = open_canvas(base, project, doc.into(), tab("tab-b"))
        .await
        .unwrap();
    assert_eq!(a.canvas_token, b.canvas_token);

    let late = close_canvas(project, a.mount_seq, CloseMode::Save)
        .await
        .unwrap();
    assert!(!late.unmounted);
    assert!(super::persistence::canvas_mounts()
        .view(project, b.mount_seq)
        .is_ok());
    assert!(bundle_tokens().authorize(&canvas_id, &b.canvas_token));

    close_current_canvas(project, CloseMode::Save)
        .await
        .unwrap();
    assert!(!bundle_tokens().authorize(&canvas_id, &b.canvas_token));
}

#[test]
fn authorize_accepts_only_the_canvas_own_token() {
    let tokens = BundleTokens::default();
    let token = tokens.issue("cv_auth_a").unwrap();
    let other = tokens.issue("cv_auth_b").unwrap();

    assert!(tokens.authorize("cv_auth_a", &token));
    let wrong_same_len = "0".repeat(32);
    for (canvas_id, presented) in [
        ("cv_auth_a", ""),
        ("cv_auth_a", wrong_same_len.as_str()),
        ("cv_auth_a", other.as_str()),
        ("cv_auth_a", &token[..31]),
        ("cv_auth_unknown", token.as_str()),
    ] {
        assert!(
            !tokens.authorize(canvas_id, presented),
            "{canvas_id} {presented}"
        );
    }
}

#[test]
fn bundle_base_has_the_same_shape_on_both_surfaces() {
    let web = serde_json::to_value(same_origin_base()).unwrap();
    assert_eq!(web["baseUrl"], "");
    assert_eq!(web["pinTag"], pinned_tag());

    let desktop = serde_json::to_value(super::static_server::CanvasBundleBase {
        base_url: "http://127.0.0.1:1".into(),
        pin_tag: pinned_tag().into(),
        fallback_fonts: Vec::new(),
    })
    .unwrap();
    let keys = |value: &serde_json::Value| -> Vec<String> {
        let mut keys: Vec<String> = value.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        keys
    };
    assert_eq!(keys(&web), keys(&desktop));
}

fn web_router() -> axum::Router {
    canvas_router::<()>(CanvasState {
        boundary: None,
        write_flags: WriteFlags {
            allow_remote_writes: false,
            shared_live_writes_denied: false,
        },
    })
}

#[tokio::test]
async fn unauthorized_bundle_request_never_reaches_the_bundle() {
    let id = "cv_unauth";
    bundle_tokens().issue(id).unwrap();
    let response = serve_bundle(
        &Method::GET,
        &format!("/canvas/{id}/nope/index.html")
            .parse::<Uri>()
            .unwrap(),
        &HeaderMap::new(),
    );
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let body = body_text(response).await;
    assert!(body.contains("UNAUTHORIZED"));
    assert!(!body.contains("nope"));
}

#[cfg(debug_assertions)]
mod served_from_dev_dir {
    use super::*;
    use parking_lot::{Mutex, MutexGuard};

    static ENV_LOCK: Mutex<()> = Mutex::new(());
    const INDEX: &str = "<!doctype html><title>figcraft</title>";

    struct Bundle {
        _guard: MutexGuard<'static, ()>,
        dir: Option<tempfile::TempDir>,
    }

    impl Bundle {
        fn with(files: &[(&str, &[u8])]) -> Self {
            let guard = ENV_LOCK.lock();
            let dir = tempfile::tempdir().unwrap();
            for (name, bytes) in files {
                let path = dir.path().join(name);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, bytes).unwrap();
            }
            std::env::set_var(crate::web::assets::CANVAS_BUNDLE_DIR_ENV, dir.path());
            Self {
                _guard: guard,
                dir: Some(dir),
            }
        }

        fn embedded() -> Self {
            let guard = ENV_LOCK.lock();
            std::env::remove_var(crate::web::assets::CANVAS_BUNDLE_DIR_ENV);
            Self {
                _guard: guard,
                dir: None,
            }
        }

        fn standard() -> Self {
            Self::with(&[
                ("index.html", INDEX.as_bytes()),
                ("app_bg.wasm", b"\0asm"),
                ("app.js", b"export default 1"),
            ])
        }
    }

    impl Drop for Bundle {
        fn drop(&mut self) {
            std::env::remove_var(crate::web::assets::CANVAS_BUNDLE_DIR_ENV);
        }
    }

    fn get(uri: &str, headers: &HeaderMap) -> Response {
        serve_bundle(&Method::GET, &uri.parse::<Uri>().unwrap(), headers)
    }

    #[tokio::test]
    async fn the_token_path_serves_the_page_without_setting_a_cookie() {
        let _bundle = Bundle::standard();
        let id = "cv_first_page";
        let token = bundle_tokens().issue(id).unwrap();

        let response = get(
            &format!("/canvas/{id}/{token}/?embed=kiosk"),
            &HeaderMap::new(),
        );
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "text/html; charset=utf-8"
        );
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "private, no-cache"
        );
        assert!(response.headers().get(header::SET_COOKIE).is_none());
        assert_eq!(body_text(response).await, INDEX);
    }

    #[tokio::test]
    async fn sub_resources_are_authorized_by_their_path_token_alone() {
        let _bundle = Bundle::standard();
        let id = "cv_subresource";
        let token = bundle_tokens().issue(id).unwrap();

        let wasm = get(
            &format!("/canvas/{id}/{token}/app_bg.wasm"),
            &HeaderMap::new(),
        );
        assert_eq!(wasm.status(), StatusCode::OK);
        assert_eq!(wasm.headers()[header::CONTENT_TYPE], "application/wasm");

        let bare = get(&format!("/canvas/{id}/app_bg.wasm"), &HeaderMap::new());
        assert_eq!(bare.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn revoking_a_canvas_stops_its_token_path() {
        let _bundle = Bundle::standard();
        let id = "cv_revoked";
        let token = bundle_tokens().issue(id).unwrap();
        bundle_tokens().revoke(id);
        let response = get(&format!("/canvas/{id}/{token}/app.js"), &HeaderMap::new());
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn revalidation_answers_304_and_head_has_no_body() {
        let _bundle = Bundle::standard();
        let id = "cv_etag";
        let token = bundle_tokens().issue(id).unwrap();
        let none = HeaderMap::new();
        let uri = format!("/canvas/{id}/{token}/app.js");

        let first = get(&uri, &none);
        let etag = first.headers()[header::ETAG].clone();
        let mut revalidate = HeaderMap::new();
        revalidate.insert(header::IF_NONE_MATCH, etag);
        let second = get(&uri, &revalidate);
        assert_eq!(second.status(), StatusCode::NOT_MODIFIED);

        let head = serve_bundle(&Method::HEAD, &uri.parse::<Uri>().unwrap(), &none);
        assert_eq!(head.status(), StatusCode::OK);
        assert_eq!(body_text(head).await, "");

        let post = serve_bundle(&Method::POST, &uri.parse::<Uri>().unwrap(), &none);
        assert_eq!(post.status(), StatusCode::METHOD_NOT_ALLOWED);
    }

    #[tokio::test]
    async fn paths_cannot_leave_the_bundle_directory() {
        let bundle = Bundle::standard();
        let id = "cv_traversal";
        let token = bundle_tokens().issue(id).unwrap();
        std::fs::write(
            bundle
                .dir
                .as_ref()
                .unwrap()
                .path()
                .parent()
                .unwrap()
                .join("secret.txt"),
            "top secret",
        )
        .unwrap();

        for attempt in [
            "../secret.txt",
            "a/../../secret.txt",
            "%2e%2e/secret.txt",
            "..%5Csecret.txt",
        ] {
            let response = get(
                &format!("/canvas/{id}/{token}/{attempt}"),
                &HeaderMap::new(),
            );
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{attempt}");
        }
    }

    #[tokio::test]
    async fn bare_token_path_redirects_to_the_trailing_slash_form_keeping_the_query() {
        let _bundle = Bundle::standard();
        let id = "cv_redirect";
        let token = bundle_tokens().issue(id).unwrap();
        let response = get(
            &format!("/canvas/{id}/{token}?embed=kiosk&ms=1"),
            &HeaderMap::new(),
        );
        assert_eq!(response.status(), StatusCode::PERMANENT_REDIRECT);
        assert_eq!(
            response.headers()[header::LOCATION],
            format!("/canvas/{id}/{token}/?embed=kiosk&ms=1").as_str()
        );
    }

    #[tokio::test]
    async fn an_absent_bundle_answers_a_typed_error_not_a_panic() {
        let _bundle = Bundle::with(&[]);
        let id = "cv_missing_bundle";
        let token = bundle_tokens().issue(id).unwrap();
        let response = get(&format!("/canvas/{id}/{token}/"), &HeaderMap::new());
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body: serde_json::Value = serde_json::from_str(&body_text(response).await).unwrap();
        assert_eq!(body["code"], "BUNDLE_MISSING");
        assert!(!body.to_string().contains(&token));
    }

    #[tokio::test]
    async fn web_router_and_desktop_router_serve_the_same_bundle() {
        let _bundle = Bundle::standard();
        let id = "cv_parity";
        let token = bundle_tokens().issue(id).unwrap();
        let uri = format!("/canvas/{id}/{token}/?embed=kiosk");

        let web = web_router()
            .oneshot(Request::get(&uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let desktop = bundle_router()
            .oneshot(Request::get(&uri).body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(web.status(), StatusCode::OK);
        assert_eq!(web.status(), desktop.status());
        assert_eq!(
            web.headers()[header::CONTENT_TYPE],
            desktop.headers()[header::CONTENT_TYPE]
        );
        assert_eq!(web.headers()[header::ETAG], desktop.headers()[header::ETAG]);
        assert_eq!(body_text(web).await, body_text(desktop).await);

        for router in [web_router(), bundle_router()] {
            let denied = router
                .oneshot(
                    Request::get(format!("/canvas/{id}/app.js"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
        }
    }

    async fn get_from(router: axum::Router, uri: String) -> Response {
        router
            .oneshot(Request::get(uri).body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn only_the_desktop_listener_lends_the_fallback_fonts() {
        let _bundle = Bundle::standard();
        let id = "cv_fallback_fonts";
        let token = bundle_tokens().issue(id).unwrap();
        assert!(
            same_origin_base().fallback_fonts.is_empty(),
            "termul-server and shared-live list none"
        );
        for url in super::super::fallback_fonts::urls() {
            let desktop = get_from(bundle_router(), format!("/canvas/{id}/{token}/{url}")).await;
            assert_eq!(desktop.status(), StatusCode::OK, "{url}");
            let content_type = desktop.headers()[header::CONTENT_TYPE].to_str().unwrap();
            assert!(content_type.starts_with("font/"), "{url}: {content_type}");
            assert!(!body_text(desktop).await.is_empty(), "{url}");
            let web = get_from(web_router(), format!("/canvas/{id}/{token}/{url}")).await;
            assert_eq!(web.status(), StatusCode::NOT_FOUND, "the web router: {url}");
            let stranger = get_from(bundle_router(), format!("/canvas/{id}/nope/{url}")).await;
            assert_eq!(stranger.status(), StatusCode::UNAUTHORIZED, "{url}");
        }
        for name in ["arial.ttf", "../index.html", "..%5C..%5Cwin.ini", ""] {
            let other = get_from(
                bundle_router(),
                format!("/canvas/{id}/{token}/host-fonts/{name}"),
            )
            .await;
            assert_eq!(other.status(), StatusCode::NOT_FOUND, "{name}");
        }
    }

    #[tokio::test]
    async fn fetched_bundle_is_served_through_the_embed_set_when_present() {
        let _bundle = Bundle::embedded();
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../canvas/bundle");
        let Some(wasm) = std::fs::read_dir(&dir).ok().and_then(|entries| {
            entries
                .filter_map(Result::ok)
                .find(|entry| entry.file_name().to_string_lossy().ends_with("_bg.wasm"))
        }) else {
            return;
        };
        let name = wasm.file_name().to_string_lossy().into_owned();
        let id = "cv_real_bundle";
        let token = bundle_tokens().issue(id).unwrap();

        let index = get(&format!("/canvas/{id}/{token}/"), &HeaderMap::new());
        assert_eq!(index.status(), StatusCode::OK);
        assert!(
            body_text(index).await.contains(&name),
            "index.html references the wasm"
        );

        let served = get(&format!("/canvas/{id}/{token}/{name}"), &HeaderMap::new());
        assert_eq!(served.status(), StatusCode::OK);
        assert_eq!(served.headers()[header::CONTENT_TYPE], "application/wasm");
        let bytes = to_bytes(served.into_body(), usize::MAX).await.unwrap();
        assert_eq!(bytes.len() as u64, wasm.metadata().unwrap().len());
    }

    #[tokio::test]
    async fn listener_binds_loopback_serves_and_rebinds_after_it_dies() {
        let _bundle = Bundle::standard();
        let id = "cv_listener";
        let token = bundle_tokens().issue(id).unwrap();
        let server = StaticServer::new();
        let supervisor = tokio::spawn(server.clone().run());

        let first = server
            .wait_for_base(Duration::from_secs(5))
            .await
            .expect("listener binds");
        assert!(
            first.base_url.starts_with("http://127.0.0.1:"),
            "{}",
            first.base_url
        );
        assert_eq!(first.pin_tag, pinned_tag());
        assert!(server.addr().unwrap().ip().is_loopback());

        let client = reqwest::Client::new();
        let page = client
            .get(format!("{}/canvas/{id}/{token}/", first.base_url))
            .send()
            .await
            .unwrap();
        assert_eq!(page.status(), 200);
        assert_eq!(page.text().await.unwrap(), INDEX);
        let script = client
            .get(format!("{}/canvas/{id}/{token}/app.js", first.base_url))
            .send()
            .await
            .unwrap();
        assert_eq!(script.status(), 200, "a sub-resource needs no cookie");

        server.drop_listener();
        let second = loop {
            if server.bind_count() == 2 {
                if let Some(base) = server.wait_for_base(Duration::from_secs(5)).await {
                    break base;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        let page = client
            .get(format!("{}/canvas/{id}/{token}/", second.base_url))
            .send()
            .await
            .unwrap();
        assert_eq!(page.status(), 200, "rebuilt base URL serves the bundle");

        server.shutdown();
        tokio::time::timeout(Duration::from_secs(5), supervisor)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(server.base(), None);
    }
}

#[test]
fn an_open_request_carries_the_autosave_max_wait_on_both_transports() {
    let request: OpenRequest = serde_json::from_str(
        r#"{"clientInstanceId":"tab","autosaveMs":1500,"autosaveMaxMs":2500}"#,
    )
    .unwrap();
    assert_eq!(request.autosave_max_ms, Some(2500));
    let absent: OpenRequest = serde_json::from_str(r#"{"clientInstanceId":"tab"}"#).unwrap();
    assert_eq!(absent.autosave_max_ms, None);
}
