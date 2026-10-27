use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::routing::get;
use serde_json::Value;
use tower::ServiceExt;

/// `GET /mcp-catalog/search?<query>` against the embedded dev fixture.
pub(crate) async fn http_search(query: &str) -> Value {
    let response = axum::Router::new()
        .route("/mcp-catalog/search", get(super::search))
        .oneshot(
            Request::builder()
                .uri(format!("/mcp-catalog/search?{query}"))
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    serde_json::from_slice(&bytes).expect("IpcBody json")
}

#[tokio::test]
async fn search_returns_a_page_of_rows() {
    let body = http_search("query=hooka&limit=5").await;
    assert_eq!(body["success"], true);
    let data = &body["data"];
    assert_eq!(data["total"], 1);
    assert_eq!(data["nextCursor"], Value::Null);
    assert!(data["snapshotFetchedAt"].is_string());
    let row = &data["items"][0];
    assert_eq!(row["name"], "to.hooka/mcp");
    assert_eq!(row["version"], "0.1.2");
    assert_eq!(row["status"], "active");
    assert_eq!(
        row["defaultOption"],
        serde_json::json!({ "kind": "package", "index": 0 })
    );
    assert!(row["state"] == "installable" || row["state"] == "needs-runtime");
}

#[tokio::test]
async fn search_pages_with_the_returned_cursor() {
    let first = http_search("limit=20").await;
    assert_eq!(first["data"]["total"], 21);
    assert_eq!(first["data"]["items"].as_array().unwrap().len(), 20);
    assert_eq!(first["data"]["nextCursor"], "20");
    let second = http_search("limit=20&cursor=20").await;
    assert_eq!(second["data"]["items"].as_array().unwrap().len(), 1);
    assert_eq!(second["data"]["nextCursor"], Value::Null);
}

#[tokio::test]
async fn invalid_requests_are_validation_errors() {
    for query in ["limit=0", "limit=abc", "cursor=nope", "unknown=1"] {
        let body = http_search(query).await;
        assert_eq!(body["success"], false, "{query}");
        assert_eq!(body["code"], "VALIDATION_ERROR", "{query}");
    }
}
