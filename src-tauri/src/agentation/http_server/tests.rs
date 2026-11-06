use super::*;
use tower::ServiceExt;

const SECRET: &str = "run-secret";

fn test_state() -> AppState {
    AppState {
        store: Arc::new(SqliteStore::open_in_memory().unwrap()),
    }
}

#[tokio::test]
async fn test_create_session_route() {
    let app = router(test_state(), SECRET);
    let resp = app
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/run-secret/sessions")
                .header("content-type", "application/json")
                .body(axum::body::Body::from(r#"{"url":"https://example.com"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);
}

#[tokio::test]
async fn test_list_sessions_route() {
    let app = router(test_state(), SECRET);
    let resp = app
        .oneshot(
            axum::http::Request::builder()
                .method("GET")
                .uri("/run-secret/sessions")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn test_full_annotation_lifecycle() {
    let state = test_state();
    let app = router(state.clone(), SECRET);

    // Create session
    let resp = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/run-secret/sessions")
                .header("content-type", "application/json")
                .body(axum::body::Body::from(r#"{"url":"https://test.com"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let session: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let session_id = session["id"].as_str().unwrap();

    // Add annotation
    let app2 = router(state.clone(), SECRET);
    let resp = app2
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri(format!("/run-secret/sessions/{session_id}/annotations"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        r#"{"x":10,"y":20,"comment":"Fix this","element":"button","elementPath":"body > button","timestamp":12345}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);

    // Get pending
    let app3 = router(state.clone(), SECRET);
    let resp = app3
        .oneshot(
            axum::http::Request::builder()
                .method("GET")
                .uri(format!("/run-secret/sessions/{session_id}/pending"))
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let pending: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(pending["count"], 1);
}

/// Raw HTTP/1.1 GET over a real socket so the `Host` header is exactly the
/// one a rebinding page would send.
async fn raw_status(addr: SocketAddr, path: &str, host: &str) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let request = format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).await.unwrap();
    response.lines().next().unwrap_or_default().to_string()
}

/// A page that finds the port still cannot reach the routes: they answer
/// only under the endpoint's secret path, which only annotation-mode user
/// tabs are given.
#[tokio::test]
async fn the_listener_serves_its_routes_only_under_the_secret_path_and_its_own_hosts() {
    let listening = start_server(Arc::new(SqliteStore::open_in_memory().unwrap()))
        .await
        .unwrap();
    let addr = listening.addr;
    assert!(crate::host_perimeter::is_owned_port(addr.port()));
    let secret_path = listening
        .endpoint
        .strip_prefix(&format!("http://{addr}"))
        .unwrap()
        .to_string();
    assert_eq!(secret_path.len(), 33, "a 128-bit secret segment");
    let sessions = format!("{secret_path}/sessions");
    let local = addr.to_string();
    let localhost = format!("localhost:{}", addr.port());
    let attacker = format!("attacker.example:{}", addr.port());

    let mut seen = Vec::new();
    for (path, host) in [
        (sessions.as_str(), local.as_str()),
        (sessions.as_str(), localhost.as_str()),
        (sessions.as_str(), "attacker.example"),
        (sessions.as_str(), attacker.as_str()),
        ("/sessions", local.as_str()),
        ("/pending", local.as_str()),
        ("/run-secret/sessions", local.as_str()),
    ] {
        seen.push(raw_status(addr, path, host).await);
    }
    assert_eq!(
        seen,
        [
            "HTTP/1.1 200 OK",
            "HTTP/1.1 200 OK",
            "HTTP/1.1 403 Forbidden",
            "HTTP/1.1 403 Forbidden",
            "HTTP/1.1 404 Not Found",
            "HTTP/1.1 404 Not Found",
            "HTTP/1.1 404 Not Found",
        ]
    );

    listening.shutdown.cancel();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while crate::host_perimeter::is_owned_port(addr.port()) {
        assert!(std::time::Instant::now() < deadline, "port released after shutdown");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}
