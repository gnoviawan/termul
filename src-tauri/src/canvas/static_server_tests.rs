use std::sync::Arc;
use std::time::Duration;

use axum::body::{to_bytes, Body};
use axum::http::{header, HeaderMap, HeaderValue, Method, Request, StatusCode, Uri};
use axum::response::Response;
use tower::ServiceExt;

use super::canvas_id_for_project;
use super::persistence::CloseMode;
use super::pin::pinned_tag;
use super::static_server::{
    bundle_router, bundle_tokens, canvas_cookie_name, close_canvas, open_canvas, same_origin_base,
    serve_bundle, Access, BundleTokens, CanvasBundleBase, CookiePolicy, StaticServer,
};
use crate::web::auth::{WebAuth, WebAuthToken};
use crate::web::canvas_api::{canvas_router, CanvasState};
use crate::web::capabilities::WriteFlags;

fn headers_with_cookie(name: &str, value: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::COOKIE,
        HeaderValue::from_str(&format!("{name}={value}")).unwrap(),
    );
    headers
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
    };
    let project = "project-open-canvas";
    let canvas_id = canvas_id_for_project(project);
    let ct_query = |token: &str| format!("embed=kiosk&ct={token}");
    let authorized = |token: &str| {
        bundle_tokens()
            .authorize(&canvas_id, Some(&ct_query(token)), &HeaderMap::new())
            .granted()
    };

    let first = open_canvas(base.clone(), project, "C:/p/design.figcraft".into(), None).unwrap();
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
        })
    );
    assert!(
        authorized(&first.canvas_token),
        "the minted ct opens the bundle"
    );

    let again = open_canvas(base.clone(), project, "C:/p/other.figcraft".into(), None).unwrap();
    assert_eq!(
        again.canvas_token, first.canvas_token,
        "a repeat open keeps the mounted iframe's URL valid"
    );
    assert!(
        again.mount_seq > first.mount_seq,
        "every open is a new mount with a new mountSeq"
    );

    close_canvas(project, CloseMode::Save).await.unwrap();
    assert!(!authorized(&first.canvas_token), "close revokes the token");
    close_canvas(project, CloseMode::Save).await.unwrap();

    let reopened = open_canvas(base, project, "C:/p/design.figcraft".into(), None).unwrap();
    assert_ne!(reopened.canvas_token, first.canvas_token);
    assert!(authorized(&reopened.canvas_token));
    close_canvas(project, CloseMode::Save).await.unwrap();
}

#[test]
fn authorize_accepts_query_token_or_own_cookie_only() {
    let tokens = BundleTokens::default();
    let token = tokens.issue("cv_auth_a").unwrap();
    let other = tokens.issue("cv_auth_b").unwrap();
    let none = HeaderMap::new();
    let query = format!("embed=kiosk&ct={token}");

    assert_eq!(
        tokens.authorize("cv_auth_a", Some(&query), &none),
        Access::Query
    );
    assert_eq!(
        tokens.authorize(
            "cv_auth_a",
            None,
            &headers_with_cookie(&canvas_cookie_name("cv_auth_a"), &token)
        ),
        Access::Cookie
    );

    let wrong_same_len = "0".repeat(32);
    for denied in [
        tokens.authorize("cv_auth_a", None, &none),
        tokens.authorize("cv_auth_a", Some("ct="), &none),
        tokens.authorize("cv_auth_a", Some(&format!("ct={wrong_same_len}")), &none),
        tokens.authorize("cv_auth_a", Some(&format!("ct={other}")), &none),
        tokens.authorize("cv_auth_unknown", Some(&query), &none),
        tokens.authorize(
            "cv_auth_a",
            None,
            &headers_with_cookie(&canvas_cookie_name("cv_auth_b"), &other),
        ),
        tokens.authorize(
            "cv_auth_a",
            None,
            &headers_with_cookie(&canvas_cookie_name("cv_auth_a"), &other),
        ),
    ] {
        assert_eq!(denied, Access::Denied);
    }
}

#[test]
fn a_stale_cookie_does_not_mask_the_current_one() {
    let tokens = BundleTokens::default();
    let token = tokens.issue("cv_dup").unwrap();
    let name = canvas_cookie_name("cv_dup");
    let mut headers = HeaderMap::new();
    headers.insert(
        header::COOKIE,
        HeaderValue::from_str(&format!("{name}=stale; other=1; {name}={token}")).unwrap(),
    );
    assert_eq!(tokens.authorize("cv_dup", None, &headers), Access::Cookie);
}

#[test]
fn bundle_base_has_the_same_shape_on_both_surfaces() {
    let web = serde_json::to_value(same_origin_base()).unwrap();
    assert_eq!(web["baseUrl"], "");
    assert_eq!(web["pinTag"], pinned_tag());

    let desktop = serde_json::to_value(super::static_server::CanvasBundleBase {
        base_url: "http://127.0.0.1:1".into(),
        pin_tag: pinned_tag().into(),
    })
    .unwrap();
    let keys = |value: &serde_json::Value| -> Vec<String> {
        let mut keys: Vec<String> = value.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        keys
    };
    assert_eq!(keys(&web), keys(&desktop));
}

#[tokio::test]
async fn web_route_reports_the_same_origin_base_behind_the_bearer() {
    let router = web_router(Some(Arc::new(WebAuth::new(
        WebAuthToken::new("bundle-base-token").unwrap(),
    ))));
    let denied = router
        .clone()
        .oneshot(
            Request::get("/canvas/bundle-base")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);

    let allowed = router
        .oneshot(
            Request::get("/canvas/bundle-base")
                .header(header::AUTHORIZATION, "Bearer bundle-base-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(allowed.status(), StatusCode::OK);
    let body: serde_json::Value = serde_json::from_str(&body_text(allowed).await).unwrap();
    assert_eq!(body["success"], true);
    assert_eq!(body["data"]["baseUrl"], "");
    assert_eq!(body["data"]["pinTag"], pinned_tag());
}

fn web_router(web_auth: Option<Arc<WebAuth>>) -> axum::Router {
    canvas_router::<()>(CanvasState {
        pool: None,
        web_auth,
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
        CookiePolicy::SameOrigin,
        &Method::GET,
        &format!("/canvas/{id}/index.html?ct=nope")
            .parse::<Uri>()
            .unwrap(),
        &HeaderMap::new(),
    );
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(response.headers().get(header::SET_COOKIE).is_none());
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

    fn get(policy: CookiePolicy, uri: &str, headers: &HeaderMap) -> Response {
        serve_bundle(policy, &Method::GET, &uri.parse::<Uri>().unwrap(), headers)
    }

    #[tokio::test]
    async fn first_gated_request_serves_the_page_and_sets_the_per_canvas_cookie() {
        let _bundle = Bundle::standard();
        let id = "cv_first_page";
        let token = bundle_tokens().issue(id).unwrap();

        let response = get(
            CookiePolicy::SameOrigin,
            &format!("/canvas/{id}/?embed=kiosk&ct={token}"),
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
        let cookie = response.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .to_string();
        assert_eq!(
            cookie,
            format!(
                "{}={token}; Path=/canvas/{id}/; HttpOnly; SameSite=Lax",
                canvas_cookie_name(id)
            )
        );
        assert_eq!(body_text(response).await, INDEX);
    }

    #[tokio::test]
    async fn loopback_cookie_is_third_party_safe() {
        let _bundle = Bundle::standard();
        let id = "cv_loopback_cookie";
        let token = bundle_tokens().issue(id).unwrap();
        let response = get(
            CookiePolicy::EmbeddedLoopback,
            &format!("/canvas/{id}/?ct={token}"),
            &HeaderMap::new(),
        );
        let cookie = response.headers()[header::SET_COOKIE].to_str().unwrap();
        assert!(
            cookie.ends_with("HttpOnly; SameSite=None; Secure"),
            "{cookie}"
        );
    }

    #[tokio::test]
    async fn sub_resources_are_authorized_by_the_cookie_alone() {
        let _bundle = Bundle::standard();
        let id = "cv_subresource";
        let token = bundle_tokens().issue(id).unwrap();
        let cookie = headers_with_cookie(&canvas_cookie_name(id), &token);

        let wasm = get(
            CookiePolicy::SameOrigin,
            &format!("/canvas/{id}/app_bg.wasm"),
            &cookie,
        );
        assert_eq!(wasm.status(), StatusCode::OK);
        assert_eq!(wasm.headers()[header::CONTENT_TYPE], "application/wasm");
        assert!(wasm.headers().get(header::SET_COOKIE).is_none());

        let bare = get(
            CookiePolicy::SameOrigin,
            &format!("/canvas/{id}/app_bg.wasm"),
            &HeaderMap::new(),
        );
        assert_eq!(bare.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn revoking_a_canvas_stops_its_cookie() {
        let _bundle = Bundle::standard();
        let id = "cv_revoked";
        let token = bundle_tokens().issue(id).unwrap();
        let cookie = headers_with_cookie(&canvas_cookie_name(id), &token);
        bundle_tokens().revoke(id);
        let response = get(
            CookiePolicy::SameOrigin,
            &format!("/canvas/{id}/app.js"),
            &cookie,
        );
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn revalidation_answers_304_and_head_has_no_body() {
        let _bundle = Bundle::standard();
        let id = "cv_etag";
        let token = bundle_tokens().issue(id).unwrap();
        let cookie = headers_with_cookie(&canvas_cookie_name(id), &token);
        let uri = format!("/canvas/{id}/app.js");

        let first = get(CookiePolicy::SameOrigin, &uri, &cookie);
        let etag = first.headers()[header::ETAG].clone();
        let mut revalidate = cookie.clone();
        revalidate.insert(header::IF_NONE_MATCH, etag);
        let second = get(CookiePolicy::SameOrigin, &uri, &revalidate);
        assert_eq!(second.status(), StatusCode::NOT_MODIFIED);

        let head = serve_bundle(
            CookiePolicy::SameOrigin,
            &Method::HEAD,
            &uri.parse::<Uri>().unwrap(),
            &cookie,
        );
        assert_eq!(head.status(), StatusCode::OK);
        assert_eq!(body_text(head).await, "");

        let post = serve_bundle(
            CookiePolicy::SameOrigin,
            &Method::POST,
            &uri.parse::<Uri>().unwrap(),
            &cookie,
        );
        assert_eq!(post.status(), StatusCode::METHOD_NOT_ALLOWED);
    }

    #[tokio::test]
    async fn paths_cannot_leave_the_bundle_directory() {
        let bundle = Bundle::standard();
        let id = "cv_traversal";
        let token = bundle_tokens().issue(id).unwrap();
        let cookie = headers_with_cookie(&canvas_cookie_name(id), &token);
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
                CookiePolicy::SameOrigin,
                &format!("/canvas/{id}/{attempt}"),
                &cookie,
            );
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{attempt}");
        }
    }

    #[tokio::test]
    async fn bare_canvas_path_redirects_to_the_trailing_slash_form_keeping_the_query() {
        let _bundle = Bundle::standard();
        let id = "cv_redirect";
        let token = bundle_tokens().issue(id).unwrap();
        let response = get(
            CookiePolicy::SameOrigin,
            &format!("/canvas/{id}?ct={token}"),
            &HeaderMap::new(),
        );
        assert_eq!(response.status(), StatusCode::PERMANENT_REDIRECT);
        assert_eq!(
            response.headers()[header::LOCATION],
            format!("/canvas/{id}/?ct={token}").as_str()
        );
    }

    #[tokio::test]
    async fn an_absent_bundle_answers_a_typed_error_not_a_panic() {
        let _bundle = Bundle::with(&[]);
        let id = "cv_missing_bundle";
        let token = bundle_tokens().issue(id).unwrap();
        let response = get(
            CookiePolicy::SameOrigin,
            &format!("/canvas/{id}/?ct={token}"),
            &HeaderMap::new(),
        );
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
        let uri = format!("/canvas/{id}/?embed=kiosk&ct={token}");

        let web = web_router(None)
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
        assert!(web.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .contains("SameSite=Lax"));
        assert!(desktop.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .contains("SameSite=None"));
        assert_eq!(body_text(web).await, body_text(desktop).await);

        for router in [web_router(None), bundle_router()] {
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
        let cookie = headers_with_cookie(&canvas_cookie_name(id), &token);

        let index = get(
            CookiePolicy::SameOrigin,
            &format!("/canvas/{id}/?ct={token}"),
            &HeaderMap::new(),
        );
        assert_eq!(index.status(), StatusCode::OK);
        assert!(
            body_text(index).await.contains(&name),
            "index.html references the wasm"
        );

        let served = get(
            CookiePolicy::SameOrigin,
            &format!("/canvas/{id}/{name}"),
            &cookie,
        );
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
            .get(format!("{}/canvas/{id}/?ct={token}", first.base_url))
            .send()
            .await
            .unwrap();
        assert_eq!(page.status(), 200);
        assert!(page.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .contains("Secure"));
        assert_eq!(page.text().await.unwrap(), INDEX);

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
            .get(format!("{}/canvas/{id}/?ct={token}", second.base_url))
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
