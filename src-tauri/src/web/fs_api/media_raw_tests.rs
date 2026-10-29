use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use axum::Router;
use tower::ServiceExt;

use crate::acp::AcpManager;
use crate::web::auth::{WebAuth, WebAuthToken};
use crate::web::origin::OriginPolicy;
use crate::web::project_registry::ProjectRegistry;
use crate::web::router::router_with_static;
use crate::web::sink::WsRelaySink;

fn app(static_dir: &std::path::Path, token: Option<&str>) -> Router {
    router_with_static(
        Arc::new(AcpManager::new(vec![])),
        crate::web::test_pty_manager(),
        Arc::new(WsRelaySink::new()),
        Arc::new(ProjectRegistry::new()),
        static_dir,
        false,
        false,
        token.map(|t| Arc::new(WebAuth::new(WebAuthToken::new(t).expect("non-empty")))),
        OriginPolicy::default(),
    )
}

async fn get(app: Router, path: &str, bearer: Option<&str>) -> axum::response::Response {
    let query: String = url::form_urlencoded::byte_serialize(path.as_bytes()).collect();
    let mut req = Request::builder().uri(format!("/fs/raw?path={query}"));
    if let Some(token) = bearer {
        req = req.header("Authorization", format!("Bearer {token}"));
    }
    app.oneshot(req.body(Body::empty()).expect("request"))
        .await
        .expect("response")
}

async fn json_body(resp: axum::response::Response) -> serde_json::Value {
    let bytes = to_bytes(resp.into_body(), usize::MAX).await.expect("body");
    serde_json::from_slice(&bytes).expect("json body")
}

#[tokio::test]
async fn serves_bytes_with_the_table_mime_and_safety_headers() {
    let dir = tempfile::tempdir().expect("tempdir");
    let file = dir.path().join("chart.svg");
    std::fs::write(&file, b"<svg/>").expect("write");

    let resp = get(app(dir.path(), None), file.to_str().expect("utf8"), None).await;

    assert_eq!(resp.status(), StatusCode::OK);
    let headers = resp.headers();
    assert_eq!(headers["content-type"], "image/svg+xml");
    assert_eq!(headers["cache-control"], "no-store");
    assert_eq!(headers["x-content-type-options"], "nosniff");
    assert_eq!(
        headers["content-security-policy"],
        "default-src 'none'; style-src 'unsafe-inline'; sandbox"
    );
    let bytes = to_bytes(resp.into_body(), usize::MAX).await.expect("body");
    assert_eq!(&bytes[..], b"<svg/>");
}

#[tokio::test]
async fn serves_video_with_its_mime() {
    let dir = tempfile::tempdir().expect("tempdir");
    let file = dir.path().join("clip.webm");
    std::fs::write(&file, b"\x1a\x45\xdf\xa3").expect("write");

    let resp = get(app(dir.path(), None), file.to_str().expect("utf8"), None).await;

    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(resp.headers()["content-type"], "video/webm");
}

#[tokio::test]
async fn missing_file_is_404_with_the_ipc_failure_body() {
    let dir = tempfile::tempdir().expect("tempdir");
    let file = dir.path().join("gone.png");

    let resp = get(app(dir.path(), None), file.to_str().expect("utf8"), None).await;

    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        json_body(resp).await,
        serde_json::json!({ "success": false, "error": "file not found", "code": "NOT_FOUND" })
    );
}

#[tokio::test]
async fn unsupported_extension_is_415() {
    let dir = tempfile::tempdir().expect("tempdir");
    let file = dir.path().join("secrets.env");
    std::fs::write(&file, b"TOKEN=x").expect("write");

    let resp = get(app(dir.path(), None), file.to_str().expect("utf8"), None).await;

    assert_eq!(resp.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(json_body(resp).await["code"], "UNSUPPORTED_MEDIA");
}

#[tokio::test]
async fn oversized_image_is_413() {
    let dir = tempfile::tempdir().expect("tempdir");
    let file = dir.path().join("huge.png");
    std::fs::File::create(&file)
        .and_then(|f| f.set_len(25 * 1024 * 1024 + 1))
        .expect("sparse file");

    let resp = get(app(dir.path(), None), file.to_str().expect("utf8"), None).await;

    assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(json_body(resp).await["code"], "FILE_TOO_LARGE");
}

#[tokio::test]
async fn parent_dir_component_is_400_path_traversal() {
    let dir = tempfile::tempdir().expect("tempdir");
    let sub = dir.path().join("sub");
    std::fs::create_dir(&sub).expect("mkdir");
    std::fs::write(dir.path().join("chart.png"), b"PNG").expect("write");
    let traversal = format!("{}/../chart.png", sub.display());

    let resp = get(app(dir.path(), None), &traversal, None).await;

    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    assert_eq!(json_body(resp).await["code"], "PATH_TRAVERSAL");
}

#[tokio::test]
async fn gated_server_refuses_without_bearer_and_serves_with_it() {
    let dir = tempfile::tempdir().expect("tempdir");
    let file = dir.path().join("chart.png");
    std::fs::write(&file, b"PNG").expect("write");
    let path = file.to_str().expect("utf8");

    let refused = get(app(dir.path(), Some("t0ken")), path, None).await;
    assert_eq!(refused.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(json_body(refused).await["code"], "UNAUTHORIZED");

    let served = get(app(dir.path(), Some("t0ken")), path, Some("t0ken")).await;
    assert_eq!(served.status(), StatusCode::OK);
    assert_eq!(served.headers()["content-type"], "image/png");
}
