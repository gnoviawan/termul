//! Canvas subsystem tests. Per the spec: these NEVER require the sibling
//! OpenPencil repo — the handshake codec / argv / resolution are pure, the
//! pool is exercised through an injected spawner that runs real short-lived
//! child processes (the `remote/host/tests.rs` quick-exit precedent), and
//! the proxy is exercised against a local axum echo server.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::Request;
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use axum::{Json, Router};
use futures_util::future::BoxFuture;
use futures_util::{FutureExt, StreamExt};
use tokio::process::Command;
use tower::ServiceExt;

use super::managed::{
    parse_handshake_line, spawn_daemon_from_command, CanvasDaemon, DaemonSpawner,
};
use super::mcp_proxy;
use super::pool::{canonical_doc_key, CanvasDaemonPool};
use super::{canvas_id_for_project, CanvasError};

const TEST_ORIGIN: &str = "http://127.0.0.1:5180";
const HANDSHAKE_LINE: &str = r#"{"ok":true,"port":1,"token":"c0ffee","version":"0.8.5"}"#;

/// Handshake line announcing a hand-picked daemon port (lets the fake
/// spawner point pool-backed proxy tests at a local echo server).
fn handshake_line_for(port: u16) -> String {
    format!(r#"{{"ok":true,"port":{port},"token":"c0ffee","version":"0.8.5"}}"#)
}

// ---------------------------------------------------------------------------
// Handshake codec (pure)
// ---------------------------------------------------------------------------

#[test]
fn handshake_parses_valid_line() {
    let handshake = parse_handshake_line(HANDSHAKE_LINE).expect("valid handshake");
    assert_eq!(handshake.port, 1);
    assert_eq!(handshake.token, "c0ffee");
    assert_eq!(handshake.version, "0.8.5");
}

#[test]
fn handshake_parses_line_with_crlf() {
    let handshake = parse_handshake_line(&format!("{HANDSHAKE_LINE}\r\n")).expect("valid");
    assert_eq!(handshake.port, 1);
}

#[test]
fn handshake_rejects_invalid_lines() {
    for case in [
        "not json at all",
        "[1,2,3]",
        "null",
        r#"{"port":1,"token":"t","version":"v"}"#,          // missing ok
        r#"{"ok":false,"port":1,"token":"t","version":"v"}"#, // ok not true
        r#"{"ok":true,"port":65536,"token":"t","version":"v"}"#, // port out of range
        r#"{"ok":true,"port":0,"token":"t","version":"v"}"#, // port 0: meaningless post-bind
        r#"{"ok":true,"port":-1,"token":"t","version":"v"}"#, // negative port
        r#"{"ok":true,"port":1.5,"token":"t","version":"v"}"#, // non-integer port
        r#"{"ok":true,"port":1,"token":"","version":"v"}"#, // empty token
        r#"{"ok":true,"port":1,"token":"t"}"#,              // missing version
        r#"{"ok":true,"port":"1","token":"t","version":"v"}"#, // port as string
    ] {
        let err = parse_handshake_line(case)
            .err()
            .unwrap_or_else(|| panic!("expected rejection for {case:?}"));
        assert_eq!(err.code, "HANDSHAKE_INVALID", "case {case:?}");
    }
}

// ---------------------------------------------------------------------------
// argv builder (pure)
// ---------------------------------------------------------------------------

#[test]
fn managed_argv_matches_daemon_contract() {
    let argv = super::managed::build_managed_argv("/tmp/design.op", "http://127.0.0.1:5180");
    assert_eq!(
        argv,
        vec![
            "--serve-web",
            "--managed",
            "--port",
            "0",
            "--file",
            "/tmp/design.op",
            "--allow-origin",
            "http://127.0.0.1:5180",
        ]
    );
}

// ---------------------------------------------------------------------------
// Binary resolution (parameterized, no process env)
// ---------------------------------------------------------------------------

fn touch(path: &std::path::Path) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create parent");
    }
    std::fs::write(path, b"stub").expect("write stub binary");
}

#[cfg(target_os = "windows")]
fn expected_binary_name() -> &'static str {
    "op-host-web-server.exe"
}
#[cfg(not(target_os = "windows"))]
fn expected_binary_name() -> &'static str {
    "op-host-web-server"
}

#[test]
fn resolution_prefers_env_binary_without_bundle_root() {
    let dir = tempfile::tempdir().expect("tempdir");
    let binary = dir.path().join(expected_binary_name());
    touch(&binary);
    let resolved = super::managed::resolve_daemon_binary_from(
        Some(binary.to_str().expect("utf8 path")),
        None,
        &[],
    )
    .expect("env binary resolves");
    assert_eq!(resolved.binary, binary);
    assert!(resolved.bundle_root.is_none());
}

#[test]
fn resolution_env_binary_missing_is_typed_not_found() {
    let err = super::managed::resolve_daemon_binary_from(
        Some("/definitely/not/here/op-host-web-server"),
        None,
        &[],
    )
    .expect_err("missing env binary");
    assert_eq!(err.code, "BINARY_NOT_FOUND");
}

#[test]
fn resolution_from_root_prefers_release_then_debug() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("openpencil");
    touch(&root.join("target/debug").join(expected_binary_name()));
    let resolved =
        super::managed::resolve_daemon_binary_from(None, Some(root.to_str().unwrap()), &[])
            .expect("debug resolves");
    assert!(
        resolved
            .binary
            .ancestors()
            .any(|ancestor| ancestor.file_name().is_some_and(|name| name == "debug"))
    );
    assert!(resolved
        .binary
        .file_name()
        .expect("file name")
        .to_string_lossy()
        .contains("op-host-web-server"));
    assert_eq!(resolved.bundle_root.as_deref(), Some(root.as_path()));

    // Release wins once present.
    touch(&root.join("target/release").join(expected_binary_name()));
    let resolved =
        super::managed::resolve_daemon_binary_from(None, Some(root.to_str().unwrap()), &[])
            .expect("release resolves");
    assert!(
        resolved
            .binary
            .ancestors()
            .any(|ancestor| ancestor.file_name().is_some_and(|name| name == "release"))
    );
}

#[test]
fn resolution_without_any_source_is_typed_not_found() {
    let empty: Vec<std::path::PathBuf> = vec![];
    let err =
        super::managed::resolve_daemon_binary_from(None, None, &empty).expect_err("no source");
    assert_eq!(err.code, "BINARY_NOT_FOUND");
}

#[test]
fn resolution_discovers_sibling_checkout_from_base() {
    let dir = tempfile::tempdir().expect("tempdir");
    // Layout: <tmp>/openpencil (checkout) and <tmp>/termul/src-tauri (base).
    let checkout = dir.path().join("openpencil");
    touch(&checkout.join("target/release").join(expected_binary_name()));
    let base = dir.path().join("termul").join("src-tauri");
    std::fs::create_dir_all(&base).expect("create base");
    let resolved =
        super::managed::resolve_daemon_binary_from(None, None, &[base]).expect("sibling found");
    assert_eq!(resolved.bundle_root.as_deref(), Some(checkout.as_path()));
}

// ---------------------------------------------------------------------------
// Fake spawner: real short-lived children
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum FakeKind {
    /// Prints a valid handshake line, then exits 0 (crash after handshake).
    HandshakeThenExit,
    /// Prints a valid handshake line, then stays alive ~30s.
    HandshakeThenSleep,
    /// Prints garbage, then stays alive ~30s.
    GarbageThenSleep,
    /// Prints nothing, stays alive ~30s (handshake timeout path).
    Silent,
    /// Prints a valid handshake line after a ~500ms delay, then stays alive
    /// ~30s — lets tests act (release/reopen) while a spawn is inflight.
    DelayedHandshake,
    /// Binary that does not exist (spawn failure path).
    MissingBinary,
}

fn fake_daemon_command(kind: FakeKind) -> Command {
    fake_daemon_command_with_port(kind, 1)
}

pub(crate) fn fake_daemon_command_with_port(kind: FakeKind, port: u16) -> Command {
    let line = handshake_line_for(port);
    // NOTE: Windows fake children use powershell with SINGLE-quoted payloads
    // so the JSON's double quotes never hit Rust's argv escaping (a quoted
    // cmd arg would `\"`-escape them and corrupt the handshake line).
    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("powershell");
        command.arg("-NoProfile").arg("-Command");
        match kind {
            FakeKind::HandshakeThenExit => {
                command.arg(format!("Write-Output '{line}'"));
            }
            FakeKind::HandshakeThenSleep => {
                command.arg(format!("Write-Output '{line}'; Start-Sleep -Seconds 30"));
            }
            FakeKind::GarbageThenSleep => {
                command.arg("Write-Output 'not-a-handshake'; Start-Sleep -Seconds 30");
            }
            FakeKind::Silent => {
                command.arg("Start-Sleep -Seconds 30");
            }
            FakeKind::DelayedHandshake => {
                command.arg(format!(
                    "Start-Sleep -Milliseconds 500; Write-Output '{line}'; Start-Sleep -Seconds 30"
                ));
            }
            FakeKind::MissingBinary => {
                return Command::new("definitely-not-a-real-binary-termul-test");
            }
        }
        command
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut command = Command::new("sh");
        match kind {
            FakeKind::HandshakeThenExit => {
                command.arg("-c").arg(format!("printf '%s\\n' '{line}'"));
            }
            FakeKind::HandshakeThenSleep => {
                command
                    .arg("-c")
                    .arg(format!("printf '%s\\n' '{line}'; exec sleep 30"));
            }
            FakeKind::GarbageThenSleep => {
                command.arg("-c").arg("printf 'not-a-handshake\\n'; exec sleep 30");
            }
            FakeKind::Silent => {
                command.arg("-c").arg("exec sleep 30");
            }
            FakeKind::DelayedHandshake => {
                command
                    .arg("-c")
                    .arg(format!("sleep 0.5; printf '%s\\n' '{line}'; exec sleep 30"));
            }
            FakeKind::MissingBinary => {
                return Command::new("definitely-not-a-real-binary-termul-test");
            }
        }
        command
    }
}

pub(crate) struct FakeSpawner {
    calls: Arc<AtomicUsize>,
    kind: FakeKind,
    /// Daemon port announced in the fake handshake (defaults to 1; proxy
    /// tests point it at a local echo server).
    port: u16,
}

impl FakeSpawner {
    pub(crate) fn new(kind: FakeKind) -> Arc<Self> {
        Arc::new(Self {
            calls: Arc::new(AtomicUsize::new(0)),
            kind,
            port: 1,
        })
    }

    pub(crate) fn with_port(kind: FakeKind, port: u16) -> Arc<Self> {
        Arc::new(Self {
            calls: Arc::new(AtomicUsize::new(0)),
            kind,
            port,
        })
    }

    pub(crate) fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl DaemonSpawner for FakeSpawner {
    fn spawn(
        &self,
        doc_key: &str,
        allow_origin: &str,
    ) -> BoxFuture<'static, Result<Arc<CanvasDaemon>, CanvasError>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let kind = self.kind;
        let port = self.port;
        let doc_key = doc_key.to_string();
        let allow_origin = allow_origin.to_string();
        async move {
            spawn_daemon_from_command(
                &doc_key,
                &allow_origin,
                fake_daemon_command_with_port(kind, port),
                Duration::from_secs(10),
            )
            .await
        }
        .boxed()
    }
}

/// A temp `.op` document (the pool canonicalizes real paths).
pub(crate) fn temp_doc() -> (tempfile::TempDir, String) {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("design.op");
    std::fs::write(&path, b"{}").expect("write doc");
    (dir, path.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------
// Spawn + handshake via real children
// ---------------------------------------------------------------------------

#[tokio::test]
async fn spawn_reads_handshake_and_dispose_kills_stubborn_child() {
    let (dir, doc) = temp_doc();
    let doc_key = canonical_doc_key(&doc);
    let daemon = spawn_daemon_from_command(
        &doc_key,
        TEST_ORIGIN,
        fake_daemon_command(FakeKind::HandshakeThenSleep),
        Duration::from_secs(10),
    )
    .await
    .expect("handshake succeeds");
    assert_eq!(daemon.version, "0.8.5");
    assert_eq!(daemon.doc_key, doc_key);
    assert!(daemon.alive());
    // The stub child ignores stdin EOF, so dispose must enforce the 3s kill
    // grace — bounded here so the test cannot hang.
    tokio::time::timeout(Duration::from_secs(8), daemon.dispose())
        .await
        .expect("dispose completes within the kill grace");
    assert!(!daemon.alive());
    drop(dir);
}

#[tokio::test]
async fn spawn_handshake_timeout_is_typed() {
    let err = spawn_daemon_from_command(
        "doc",
        TEST_ORIGIN,
        fake_daemon_command(FakeKind::Silent),
        Duration::from_millis(400),
    )
    .await
    .expect_err("silent child times out");
    assert_eq!(err.code, "HANDSHAKE_TIMEOUT");
}

#[tokio::test]
async fn spawn_garbage_handshake_is_typed_invalid() {
    let err = spawn_daemon_from_command(
        "doc",
        TEST_ORIGIN,
        fake_daemon_command(FakeKind::GarbageThenSleep),
        Duration::from_secs(10),
    )
    .await
    .expect_err("garbage first line rejected");
    assert_eq!(err.code, "HANDSHAKE_INVALID");
}

#[tokio::test]
async fn spawn_missing_binary_is_typed_not_found() {
    let err = spawn_daemon_from_command(
        "doc",
        TEST_ORIGIN,
        fake_daemon_command(FakeKind::MissingBinary),
        Duration::from_secs(10),
    )
    .await
    .expect_err("missing binary rejected");
    assert_eq!(err.code, "BINARY_NOT_FOUND");
}

// ---------------------------------------------------------------------------
// Pool semantics
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pool_coalesces_concurrent_acquires_onto_one_spawn() {
    let (dir, doc) = temp_doc();
    let spawner = FakeSpawner::new(FakeKind::HandshakeThenSleep);
    let pool = CanvasDaemonPool::new(spawner.clone());
    let (first, second) = tokio::join!(
        pool.acquire(&doc, TEST_ORIGIN, "proj-1"),
        pool.acquire(&doc, TEST_ORIGIN, "proj-1"),
    );
    let (a, b) = (
        first.expect("first acquire"),
        second.expect("second acquire (coalesced)"),
    );
    assert!(Arc::ptr_eq(&a, &b), "both acquires share one daemon");
    assert_eq!(spawner.calls(), 1, "exactly one spawn for two acquires");
    drop(dir);
}

#[tokio::test]
async fn pool_spawn_failure_clears_inflight_for_retry() {
    let (dir, doc) = temp_doc();
    let spawner = FakeSpawner::new(FakeKind::MissingBinary);
    let pool = CanvasDaemonPool::new(spawner.clone());
    let err = pool
        .acquire(&doc, TEST_ORIGIN, "proj-1")
        .await
        .expect_err("first acquire fails");
    assert_eq!(err.code, "BINARY_NOT_FOUND");
    // The inflight slot was cleared, so a retry actually spawns again.
    let err = pool
        .acquire(&doc, TEST_ORIGIN, "proj-1")
        .await
        .expect_err("second acquire fails too");
    assert_eq!(err.code, "BINARY_NOT_FOUND");
    assert_eq!(spawner.calls(), 2, "retry attempts a fresh spawn");
    drop(dir);
}

#[tokio::test]
async fn pool_release_evicts_daemon_without_respawn() {
    let (dir, doc) = temp_doc();
    let spawner = FakeSpawner::new(FakeKind::HandshakeThenSleep);
    let pool = CanvasDaemonPool::new(spawner.clone());
    let daemon = pool
        .acquire(&doc, TEST_ORIGIN, "proj-1")
        .await
        .expect("acquire");
    assert!(pool.daemon_for_doc(&doc).is_some());
    pool.release(&doc).await;
    assert!(pool.daemon_for_doc(&doc).is_none(), "evict on close");
    assert!(!daemon.alive(), "daemon disposed (stdin EOF → kill)");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        spawner.calls(),
        1,
        "a dispose-driven exit must NOT respawn"
    );
    drop(dir);
}

#[tokio::test]
async fn pool_respawns_once_then_evicts() {
    let (dir, doc) = temp_doc();
    let spawner = FakeSpawner::new(FakeKind::HandshakeThenExit);
    let pool = CanvasDaemonPool::new(spawner.clone());
    // NOTE: no `alive()` assertion here — the child may exit before the
    // acquire returns on a current-thread runtime (raced the handshake
    // read); only the acquire success is deterministic.
    let _daemon = pool
        .acquire(&doc, TEST_ORIGIN, "proj-1")
        .await
        .expect("acquire succeeds before the child exits");

    // Crash → respawn once (2nd spawn) → crash again → evict.
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if spawner.calls() >= 2 && pool.daemon_for_doc(&doc).is_none() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "respawn-once-then-evict did not converge (spawns={})",
            spawner.calls()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    // No third spawn after the eviction.
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(spawner.calls(), 2, "respawn at most once");
    drop(dir);
}

#[tokio::test]
async fn pool_tracks_active_daemon_per_project_and_canvas_id() {
    let (dir, doc) = temp_doc();
    let spawner = FakeSpawner::new(FakeKind::HandshakeThenSleep);
    let pool = CanvasDaemonPool::new(spawner.clone());
    let daemon = pool
        .acquire(&doc, TEST_ORIGIN, "proj-7")
        .await
        .expect("acquire");

    assert_eq!(
        pool.active_daemon()
            .expect("globally active daemon")
            .port,
        daemon.port
    );
    assert!(pool.active_daemon_for_project("proj-7").is_some());
    assert!(pool.active_daemon_for_project("proj-8").is_none());
    let id = canvas_id_for_project("proj-7");
    assert!(pool.daemon_for_canvas_id(&id).is_some());
    assert!(pool.daemon_for_canvas_id(&canvas_id_for_project("proj-8")).is_none());

    let status = pool.status();
    assert_eq!(status.daemons.len(), 1);
    assert_eq!(status.active_doc_key.as_deref(), Some(daemon.doc_key.as_str()));

    pool.release(&doc).await;
    assert!(pool.active_daemon().is_none(), "release clears active tracking");
    assert!(pool.active_daemon_for_project("proj-7").is_none());
    drop(dir);
}

#[tokio::test]
async fn pool_shutdown_all_disposes_daemons_and_rejects_acquires() {
    let (dir, doc) = temp_doc();
    let spawner = FakeSpawner::new(FakeKind::HandshakeThenSleep);
    let pool = CanvasDaemonPool::new(spawner.clone());
    let daemon = pool
        .acquire(&doc, TEST_ORIGIN, "proj-1")
        .await
        .expect("acquire");
    pool.shutdown_all().await;
    assert!(!daemon.alive());
    assert!(pool.daemon_for_doc(&doc).is_none());
    let err = pool
        .acquire(&doc, TEST_ORIGIN, "proj-1")
        .await
        .expect_err("acquire after shutdown rejected");
    assert_eq!(err.code, "CANVAS_CLOSED");
    drop(dir);
}

#[test]
fn canvas_id_is_deterministic_and_url_safe() {
    assert_eq!(
        canvas_id_for_project("proj-1"),
        canvas_id_for_project("proj-1")
    );
    assert_ne!(
        canvas_id_for_project("proj-1"),
        canvas_id_for_project("proj-2")
    );
    assert!(canvas_id_for_project("proj-1").starts_with("cv"));
    assert!(
        canvas_id_for_project("proj-1")
            .chars()
            .all(|c| c.is_ascii_alphanumeric())
    );
}

// ---------------------------------------------------------------------------
// Shared proxy (against a local axum echo server)
// ---------------------------------------------------------------------------

async fn echo_any(request: Request) -> Response {
    let text = format!("{} {}", request.method(), request.uri());
    (
        StatusCode::OK,
        [("content-type", "text/plain"), ("x-echo", "path")],
        text,
    )
        .into_response()
}

/// SSE-shaped endpoint: yields one event immediately and NEVER completes —
/// a buffered proxy would hang the first read, a streaming one delivers it.
async fn echo_sse_never_ends() -> Response {
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<axum::body::Bytes, std::io::Error>>(8);
    tx.send(Ok(axum::body::Bytes::from_static(b"data: first\n\n")))
        .await
        .expect("seed SSE event");
    // Hold the sender open forever so the stream never reaches EOF.
    tokio::spawn(async move {
        std::future::pending::<()>().await;
        drop(tx);
    });
    Response::new(Body::from_stream(
        tokio_stream::wrappers::ReceiverStream::new(rx),
    ))
}

pub(crate) async fn spawn_echo_server() -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
    spawn_echo_server_marked("echo").await
}

/// Echo server whose `/mcp` and `/api/file/save` replies carry `marker` —
/// lets multi-daemon tests prove a request reached the RIGHT daemon.
pub(crate) async fn spawn_echo_server_marked(
    marker: &'static str,
) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
    let mcp_handler = move || async move {
        (
            StatusCode::OK,
            [("x-echo", "mcp")],
            Json(serde_json::json!({"proxied": true, "echo": marker})),
        )
            .into_response()
    };
    let app = Router::new()
        // NOTE: `/` needs an explicit route — matchit's `{*path}` catch-all
        // does not match the empty root path, and the embed-document proxy
        // forwards subpath "/" (the daemon root).
        .route("/", any(echo_any))
        .route("/mcp", post(mcp_handler))
        .route("/api/file/save", post(mcp_handler))
        .route("/api/mcp/events", get(echo_sse_never_ends))
        .route("/{*path}", any(echo_any));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind echo server");
    let addr = listener.local_addr().expect("echo addr");
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (addr, handle)
}

fn post_mcp_request(body: &'static str) -> Request {
    Request::builder()
        .method(Method::POST)
        .uri("/canvas/mcp")
        .header("content-type", "application/json")
        .body(Body::from(body))
        .expect("build MCP request")
}

#[tokio::test]
async fn proxy_mcp_rejects_get_with_405() {
    let request = Request::builder()
        .method(Method::GET)
        .uri("/canvas/mcp")
        .body(Body::empty())
        .expect("build GET");
    let resp = mcp_proxy::proxy_mcp_request(None, request).await;
    assert_eq!(resp.status(), StatusCode::METHOD_NOT_ALLOWED);
}

#[tokio::test]
async fn proxy_mcp_without_daemon_is_typed_502() {
    let request = post_mcp_request(r#"{"jsonrpc":"2.0","method":"tools/list","id":1}"#);
    let resp = mcp_proxy::proxy_mcp_request(None, request).await;
    assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .expect("read body");
    let parsed: serde_json::Value = serde_json::from_slice(&body).expect("json body");
    assert_eq!(parsed["code"], "DAEMON_DOWN");
}

#[tokio::test]
async fn proxy_mcp_forwards_post_body_status_and_headers() {
    let (addr, server) = spawn_echo_server().await;
    let daemon = super::managed::synthetic_daemon("doc", addr.port(), TEST_ORIGIN);
    let request = post_mcp_request(r#"{"jsonrpc":"2.0","method":"tools/list","id":1}"#);
    let resp = mcp_proxy::proxy_mcp_request(Some(&daemon), request).await;
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(
        resp.headers().get("x-echo").and_then(|v| v.to_str().ok()),
        Some("mcp")
    );
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .expect("read body");
    let parsed: serde_json::Value = serde_json::from_slice(&body).expect("json body");
    assert_eq!(parsed["proxied"], true);
    server.abort();
}

#[tokio::test]
async fn proxy_canvas_path_forwards_method_path_query_and_content_type() {
    let (addr, server) = spawn_echo_server().await;
    let daemon = super::managed::synthetic_daemon("doc", addr.port(), TEST_ORIGIN);
    let request = Request::builder()
        .method(Method::GET)
        .uri("/pkg/op_host_web.js?v=7")
        .body(Body::empty())
        .expect("build path request");
    let resp = mcp_proxy::proxy_canvas_path(Some(&daemon), request, "/pkg/op_host_web.js")
        .await;
    assert_eq!(resp.status(), StatusCode::OK);
    assert!(
        resp.headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.starts_with("text/plain")),
        "content-type forwarded"
    );
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .expect("read body");
    let text = String::from_utf8(body.to_vec()).expect("utf8");
    assert_eq!(text, "GET /pkg/op_host_web.js?v=7");
    server.abort();
}

#[tokio::test]
async fn proxy_canvas_path_without_daemon_is_typed_502() {
    let request = Request::builder()
        .method(Method::GET)
        .uri("/canvas/cv0/pkg/x.js")
        .body(Body::empty())
        .expect("build request");
    let resp = mcp_proxy::proxy_canvas_path(None, request, "/pkg/x.js").await;
    assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .expect("read body");
    let parsed: serde_json::Value = serde_json::from_slice(&body).expect("json body");
    assert_eq!(parsed["code"], "DAEMON_DOWN");
}

#[tokio::test]
async fn proxy_sse_streams_first_event_without_buffering() {
    let (addr, server) = spawn_echo_server().await;
    let daemon = super::managed::synthetic_daemon("doc", addr.port(), TEST_ORIGIN);
    let request = Request::builder()
        .method(Method::GET)
        .uri("/api/mcp/events")
        .body(Body::empty())
        .expect("build SSE request");
    let resp = mcp_proxy::proxy_canvas_path(Some(&daemon), request, "/api/mcp/events")
        .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let mut stream = resp.into_body().into_data_stream();
    // The echo stream NEVER completes — if the proxy buffered the response,
    // this read would hang until the timeout instead of yielding the first
    // SSE event.
    let chunk = tokio::time::timeout(Duration::from_secs(5), stream.next())
        .await
        .expect("first SSE chunk arrives while the stream is open")
        .expect("chunk is Ok")
        .expect("chunk is Some");
    let text = String::from_utf8(chunk.to_vec()).expect("utf8 chunk");
    assert!(text.contains("data: first"), "chunk: {text:?}");
    drop(stream);
    server.abort();
}

#[tokio::test]
async fn daemon_save_round_trips_through_the_daemon() {
    let (addr, server) = spawn_echo_server().await;
    let daemon = super::managed::synthetic_daemon("doc", addr.port(), TEST_ORIGIN);
    let value = mcp_proxy::daemon_save(daemon.as_ref())
        .await
        .expect("save proxied");
    assert_eq!(value["proxied"], true);
    server.abort();
}

// ---------------------------------------------------------------------------
// Web canvas routes (sub-router via tower oneshot)
// ---------------------------------------------------------------------------

fn web_canvas_app(pool: Option<Arc<CanvasDaemonPool>>) -> Router {
    crate::web::canvas_api::canvas_router(crate::web::canvas_api::CanvasState {
        pool,
        web_auth: None,
        boundary: None,
    })
}

/// Sub-router app whose doc-path validation boundary is rooted at `root`
/// (canonicalized like the production `AppState.project_root`).
fn web_canvas_app_with_boundary(
    pool: Option<Arc<CanvasDaemonPool>>,
    root: &std::path::Path,
) -> Router {
    let root = root.canonicalize().expect("canonicalize boundary root");
    crate::web::canvas_api::canvas_router(crate::web::canvas_api::CanvasState {
        pool,
        web_auth: None,
        boundary: Some(crate::web::canvas_api::CanvasProjectBoundary {
            project_root: Arc::new(parking_lot::RwLock::new(root)),
            registry: Arc::new(crate::web::project_registry::ProjectRegistry::new()),
        }),
    })
}

/// Sub-router app with an explicit web auth gate (for the bearer-OR-cookie
/// MCP tests).
fn web_canvas_app_gated(
    pool: Option<Arc<CanvasDaemonPool>>,
    token: &str,
) -> Router {
    crate::web::canvas_api::canvas_router(crate::web::canvas_api::CanvasState {
        pool,
        web_auth: Some(Arc::new(crate::web::auth::WebAuth::new(
            crate::web::auth::WebAuthToken::new(token).expect("non-empty"),
        ))),
        boundary: None,
    })
}

/// POST /canvas/open helper returning the parsed IpcBody JSON.
async fn web_open(
    app: Router,
    doc: &str,
    project_id: &str,
) -> serde_json::Value {
    let resp = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/canvas/open")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"docPath": doc, "projectId": project_id}).to_string(),
                ))
                .expect("build open request"),
        )
        .await
        .expect("router responds");
    assert_eq!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .expect("read body");
    serde_json::from_slice(&body).expect("IpcBody json")
}

#[tokio::test]
async fn web_open_returns_embed_path_with_canvas_session_token() {
    let (dir, doc) = temp_doc();
    let spawner = FakeSpawner::new(FakeKind::HandshakeThenSleep);
    let pool = Arc::new(CanvasDaemonPool::new(spawner));
    let app = web_canvas_app(Some(pool));
    let parsed = web_open(app, &doc, "proj-7").await;
    assert_eq!(parsed["success"], true);
    let expected_id = canvas_id_for_project("proj-7");
    let embed_url = parsed["data"]["embedUrl"].as_str().expect("embedUrl");
    // Shape: /canvas/<id>/?embed=vscode&ct=<32-hex> — raw query text.
    let (path_part, token) = embed_url
        .split_once("ct=")
        .unwrap_or_else(|| panic!("embed URL carries a ct param: {embed_url}"));
    assert_eq!(path_part, format!("/canvas/{expected_id}/?embed=vscode&"));
    assert_eq!(token.len(), 32, "32-hex-char canvas token");
    assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
    // The same token is returned for the renderer's op_canvas_ct cookie.
    assert_eq!(parsed["data"]["canvasToken"], *token);
    assert_eq!(parsed["data"]["canvasId"], expected_id);
    assert_eq!(parsed["data"]["mcpUrl"], "/canvas/mcp");
    assert!(parsed["data"]["docKey"].as_str().is_some_and(|k| k.ends_with("design.op")));
    drop(dir);
}

#[tokio::test]
async fn web_open_is_idempotent_for_a_live_session() {
    // A repeat open of a doc with a live daemon + live token returns the
    // SAME embed URL + token (no iframe rebuild, no live editor state
    // loss). Rotation happens only on a fresh spawn — i.e. after a close
    // evicted the entry.
    let (dir, doc) = temp_doc();
    let spawner = FakeSpawner::new(FakeKind::HandshakeThenSleep);
    let pool = Arc::new(CanvasDaemonPool::new(spawner));
    let app = web_canvas_app(Some(pool));

    let first = web_open(app.clone(), &doc, "proj-7").await;
    let first_url = first["data"]["embedUrl"].as_str().unwrap().to_string();
    let second = web_open(app.clone(), &doc, "proj-7").await;
    let second_url = second["data"]["embedUrl"].as_str().unwrap().to_string();
    assert_eq!(
        first_url, second_url,
        "repeat open of a live session keeps the same embed URL + token"
    );
    assert_eq!(
        first["data"]["canvasToken"], second["data"]["canvasToken"],
        "repeat open does not rotate the canvas token"
    );

    // Close evicts the entry (daemon + token); the next open is a fresh
    // spawn → fresh token.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/canvas/close")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::json!({"docPath": doc}).to_string()))
                .expect("build close request"),
        )
        .await
        .expect("router responds");
    assert_eq!(resp.status(), StatusCode::OK);
    let third = web_open(app, &doc, "proj-7").await;
    let third_url = third["data"]["embedUrl"].as_str().unwrap().to_string();
    assert_ne!(
        first_url, third_url,
        "a fresh spawn after close mints a fresh token"
    );
    drop(dir);
}


#[tokio::test]
async fn web_canvas_proxy_requires_valid_canvas_token() {
    let (addr, server) = spawn_echo_server().await;
    let (dir, doc) = temp_doc();
    let spawner = FakeSpawner::with_port(FakeKind::HandshakeThenSleep, addr.port());
    let pool = Arc::new(CanvasDaemonPool::new(spawner));
    let app = web_canvas_app(Some(pool));

    let parsed = web_open(app.clone(), &doc, "proj-7").await;
    assert_eq!(parsed["success"], true);
    let embed_url = parsed["data"]["embedUrl"].as_str().expect("embedUrl").to_string();
    let (canvas_path, token) = embed_url.rsplit_once("ct=").expect("ct param");
    let canvas_id = canvas_path.split('/').nth(2).expect("canvas id").to_string();

    // Valid ct: the embed document itself proxies through to the echo
    // daemon — the `ct` canvas session token is STRIPPED from the
    // forwarded query (the daemon may log URLs; the token never reaches
    // it), every other param kept verbatim.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(&embed_url)
                .body(Body::empty())
                .expect("build request"),
        )
        .await
        .expect("router responds");
    assert_eq!(resp.status(), StatusCode::OK, "valid ct authenticates");
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .expect("read body");
    let text = String::from_utf8(body.to_vec()).expect("utf8");
    assert_eq!(
        text,
        "GET /?embed=vscode",
        "the embed page proxies to the daemon root with the ct param stripped"
    );

    // Valid ct on a subpath: proxied through to the daemon.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(format!("/canvas/{canvas_id}/pkg/op_host_web.js?ct={token}"))
                .body(Body::empty())
                .expect("build request"),
        )
        .await
        .expect("router responds");
    assert_eq!(resp.status(), StatusCode::OK);

    // Missing ct → 401 (IpcBody mirror, code UNAUTHORIZED).
    for uri in [
        format!("/canvas/{canvas_id}/pkg/op_host_web.js"),
        format!("/canvas/{canvas_id}/"),
    ] {
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri(&uri)
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router responds");
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED, "uri {uri}");
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("read body");
        let parsed: serde_json::Value = serde_json::from_slice(&body).expect("json body");
        assert_eq!(parsed["code"], "UNAUTHORIZED");
    }

    // Wrong ct → 401.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(format!("/canvas/{canvas_id}/pkg/x.js?ct={:0<32}", "0"))
                .body(Body::empty())
                .expect("build request"),
        )
        .await
        .expect("router responds");
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    drop(dir);
    server.abort();
}

#[tokio::test]
async fn web_canvas_token_is_invalidated_on_close() {
    let (addr, server) = spawn_echo_server().await;
    let (dir, doc) = temp_doc();
    let spawner = FakeSpawner::with_port(FakeKind::HandshakeThenSleep, addr.port());
    let pool = Arc::new(CanvasDaemonPool::new(spawner));
    let app = web_canvas_app(Some(pool));

    let parsed = web_open(app.clone(), &doc, "proj-7").await;
    let embed_url = parsed["data"]["embedUrl"].as_str().expect("embedUrl").to_string();

    // Close the canvas (pool evicts the entry — the token goes with it).
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/canvas/close")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::json!({"docPath": doc}).to_string()))
                .expect("build close request"),
        )
        .await
        .expect("router responds");
    assert_eq!(resp.status(), StatusCode::OK);

    // The stale ct no longer authenticates.
    let resp = app
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(&embed_url)
                .body(Body::empty())
                .expect("build request"),
        )
        .await
        .expect("router responds");
    assert_eq!(
        resp.status(),
        StatusCode::UNAUTHORIZED,
        "stale ct after close must 401"
    );
    drop(dir);
    server.abort();
}

#[tokio::test]
async fn web_canvas_routes_trailing_slash_and_catch_all_reach_the_token_gate() {
    // The embed URL shape is `/canvas/<id>/` — it must route (via the
    // catch-all) into the token-gated proxy, which rejects without a ct
    // rather than 404ing.
    let app = web_canvas_app(None);
    for uri in ["/canvas/cv0123456789abcdef/", "/canvas/cv0123456789abcdef/pkg/x.js"] {
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri(uri)
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router responds");
        assert_eq!(
            resp.status(),
            StatusCode::UNAUTHORIZED,
            "uri {uri} must reach the canvas token gate, not 404"
        );
    }
}

#[tokio::test]
async fn web_canvas_api_routes_bypass_the_canvas_token_gate() {
    // open/close/save/mcp pass through the canvas-token middleware — the
    // API routes are authenticated by the OUTER bearer gate instead (they
    // never mint or check a ct). A GET /canvas/mcp without any ct still
    // reaches the handler and 405s (the daemon's method contract).
    let pool = Arc::new(CanvasDaemonPool::new(FakeSpawner::new(
        FakeKind::HandshakeThenSleep,
    )));
    let app = web_canvas_app(Some(pool));
    let resp = app
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri("/canvas/mcp")
                .body(Body::empty())
                .expect("build request"),
        )
        .await
        .expect("router responds");
    assert_eq!(
        resp.status(),
        StatusCode::METHOD_NOT_ALLOWED,
        "exempt route reaches the handler (no canvas-token 401)"
    );
}

#[tokio::test]
async fn web_open_without_pool_degrades_to_daemon_down() {
    let app = web_canvas_app(None);
    let resp = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/canvas/open")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"docPath": "C:/x/design.op", "projectId": "p"}).to_string(),
                ))
                .expect("build open request"),
        )
        .await
        .expect("router responds");
    assert_eq!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .expect("read body");
    let parsed: serde_json::Value = serde_json::from_slice(&body).expect("IpcBody json");
    assert_eq!(parsed["success"], false);
    assert_eq!(parsed["code"], "DAEMON_DOWN");
}

#[tokio::test]
async fn web_save_without_daemon_is_typed_daemon_down() {
    let (dir, doc) = temp_doc();
    let pool = Arc::new(CanvasDaemonPool::new(FakeSpawner::new(
        FakeKind::HandshakeThenSleep,
    )));
    let app = web_canvas_app(Some(pool));
    let resp = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/canvas/save")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"docPath": doc}).to_string(),
                ))
                .expect("build save request"),
        )
        .await
        .expect("router responds");
    assert_eq!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .expect("read body");
    let parsed: serde_json::Value = serde_json::from_slice(&body).expect("IpcBody json");
    assert_eq!(parsed["success"], false);
    assert_eq!(parsed["code"], "DAEMON_DOWN");
    drop(dir);
}

// ---------------------------------------------------------------------------
// Root canvas routes (the editor's absolute-path traffic) + MCP credentials
// ---------------------------------------------------------------------------

/// Open a canvas on `app` and return (embed_path_prefix, canvas_token).
async fn web_open_for_cookie(app: Router, doc: &str) -> (String, String) {
    let parsed = web_open(app, doc, "proj-7").await;
    assert_eq!(parsed["success"], true);
    let embed_url = parsed["data"]["embedUrl"].as_str().expect("embedUrl").to_string();
    let (path_part, token) = embed_url.rsplit_once("ct=").expect("ct param");
    (path_part.to_string(), token.to_string())
}

#[tokio::test]
async fn web_root_canvas_routes_proxy_to_active_daemon_with_cookie() {
    let (addr, server) = spawn_echo_server().await;
    let (dir, doc) = temp_doc();
    let spawner = FakeSpawner::with_port(FakeKind::HandshakeThenSleep, addr.port());
    let pool = Arc::new(CanvasDaemonPool::new(spawner));
    let app = web_canvas_app(Some(pool));
    let (_embed_path, token) = web_open_for_cookie(app.clone(), &doc).await;
    let canvas_id = canvas_id_for_project("proj-7");
    // Per-canvas cookie: op_canvas_ct_<canvasId>=<token>. No Referer → the
    // ACTIVE canvas is the target (single-canvas case here).
    let cookie = format!(
        "{}={token}",
        crate::web::canvas_api::canvas_cookie_name(&canvas_id)
    );
    // The editor's iframe page sends a Referer naming its canvas — the
    // Referer-scoped path targets that canvas.
    let referer = format!("http://127.0.0.1:1/canvas/{canvas_id}/?embed=vscode");

    // The editor's root-relative bundle/API paths proxy through to the
    // target echo daemon, path forwarded verbatim — both with the Referer
    // (iframe traffic) and without (direct client, active-canvas fallback).
    for (uri, with_referer) in [
        ("/pkg/op_host_web.js", true),
        ("/pkg/snippets/op-host-web-abc/src/op_ck_bridge.js", true),
        ("/canvaskit/canvaskit.js", true),
        ("/api/mcp/version", true),
        ("/api/mcp/events", false),
        ("/pkg/op_host_web.js", false),
    ] {
        let mut builder = Request::builder().method(Method::GET).uri(uri);
        if with_referer {
            builder = builder.header("referer", &referer);
        }
        let resp = app
            .clone()
            .oneshot(builder.header("cookie", &cookie).body(Body::empty()).expect("build request"))
            .await
            .expect("router responds");
        assert_eq!(
            resp.status(),
            StatusCode::OK,
            "uri {uri} (referer={with_referer}) with valid per-canvas cookie"
        );
    }

    // The echo server's catch-all replies with the request it received —
    // the root path must map 1:1 onto the daemon path.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri("/pkg/op_host_web.js?v=7")
                .header("cookie", &cookie)
                .header("referer", &referer)
                .body(Body::empty())
                .expect("build request"),
        )
        .await
        .expect("router responds");
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .expect("read body");
    assert_eq!(
        String::from_utf8(body.to_vec()).expect("utf8"),
        "GET /pkg/op_host_web.js?v=7",
        "root path + query forward verbatim"
    );

    // POST (the editor's /api/* pushes) also proxies.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/mcp/document")
                .header("cookie", &cookie)
                .header("referer", &referer)
                .body(Body::from("{}"))
                .expect("build request"),
        )
        .await
        .expect("router responds");
    assert_eq!(resp.status(), StatusCode::OK, "POST /api/* with valid cookie");

    drop(dir);
    server.abort();
}

#[tokio::test]
async fn web_root_canvas_routes_reject_missing_or_wrong_cookie() {
    let (addr, server) = spawn_echo_server().await;
    let (dir, doc) = temp_doc();
    let spawner = FakeSpawner::with_port(FakeKind::HandshakeThenSleep, addr.port());
    let pool = Arc::new(CanvasDaemonPool::new(spawner));
    let app = web_canvas_app(Some(pool));
    let (_embed_path, _token) = web_open_for_cookie(app.clone(), &doc).await;
    let canvas_id = canvas_id_for_project("proj-7");
    let cookie_name = crate::web::canvas_api::canvas_cookie_name(&canvas_id);
    let referer = format!("http://127.0.0.1:1/canvas/{canvas_id}/?embed=vscode");

    for (cookie_header, with_referer) in [
        // No cookie at all.
        (None, false),
        // Correct per-canvas name, wrong value.
        (Some(format!("{cookie_name}={:0<32}", "0")), false),
        // No canvas cookie (some other cookie only).
        (Some("other_cookie=x".to_string()), false),
        // The OLD shared bare name is gone — it must not authenticate
        // (the per-canvas name is required).
        (Some("op_canvas_ct=whatever".to_string()), true),
        // Correct name + value, but no Referer while another canvas is NOT
        // open — active-canvas fallback works, so this pair IS valid; see
        // the wrong-pairing case below for the isolation rejection.
    ] {
        let mut builder = Request::builder()
            .method(Method::GET)
            .uri("/pkg/op_host_web.js");
        if let Some(cookie) = &cookie_header {
            builder = builder.header("cookie", cookie);
        }
        if with_referer {
            builder = builder.header("referer", &referer);
        }
        let resp = app
            .clone()
            .oneshot(builder.body(Body::empty()).expect("build request"))
            .await
            .expect("router responds");
        assert_eq!(
            resp.status(),
            StatusCode::UNAUTHORIZED,
            "cookie {cookie_header:?} (referer={with_referer}) must not authenticate"
        );
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("read body");
        let parsed: serde_json::Value = serde_json::from_slice(&body).expect("json body");
        assert_eq!(parsed["code"], "UNAUTHORIZED");
        assert_eq!(
            parsed["error"], "canvas session cookie missing or invalid",
            "rejection names the canvas cookie layer"
        );
    }
    drop(dir);
    server.abort();
}

#[tokio::test]
async fn web_root_canvas_routes_without_active_daemon_are_502() {
    // A pool with no open canvas: the root routes report the typed
    // "canvas closed" signal instead of an auth failure.
    let app = web_canvas_app(Some(Arc::new(CanvasDaemonPool::new(FakeSpawner::new(
        FakeKind::HandshakeThenSleep,
    )))));
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri("/pkg/op_host_web.js")
                .header("cookie", "op_canvas_ct=whatever")
                .body(Body::empty())
                .expect("build request"),
        )
        .await
        .expect("router responds");
    assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .expect("read body");
    let parsed: serde_json::Value = serde_json::from_slice(&body).expect("json body");
    assert_eq!(parsed["code"], "DAEMON_DOWN");

    // Degraded composition (pool None) degrades the same way.
    let app = web_canvas_app(None);
    let resp = app
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri("/api/mcp/events")
                .body(Body::empty())
                .expect("build request"),
        )
        .await
        .expect("router responds");
    assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
}

#[tokio::test]
async fn web_canvas_mcp_accepts_bearer_or_cookie() {
    let (addr, server) = spawn_echo_server().await;
    let (dir, doc) = temp_doc();
    let spawner = FakeSpawner::with_port(FakeKind::HandshakeThenSleep, addr.port());
    let pool = Arc::new(CanvasDaemonPool::new(spawner));
    let app = web_canvas_app_gated(Some(pool), "t0ken");
    let (_embed_path, token) = web_open_for_cookie(app.clone(), &doc).await;

    let mcp_request = |headers: &[(&'static str, String)]| {
        let mut builder = Request::builder()
            .method(Method::POST)
            .uri("/canvas/mcp")
            .header("content-type", "application/json");
        for (name, value) in headers {
            builder = builder.header(*name, value);
        }
        builder.body(Body::from(r#"{"jsonrpc":"2.0","method":"tools/list","id":1}"#))
    };

    // (a) the web auth bearer token (agent clients) authenticates and
    // proxies to the echo daemon.
    let resp = app
        .clone()
        .oneshot(mcp_request(&[("authorization", "Bearer t0ken".to_string())]).expect("build"))
        .await
        .expect("router responds");
    assert_eq!(resp.status(), StatusCode::OK, "bearer authenticates");
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .expect("read body");
    let parsed: serde_json::Value = serde_json::from_slice(&body).expect("json body");
    assert_eq!(parsed["proxied"], true);

    // (b) the per-canvas canvas cookie (the embedded editor's MCP path)
    // authenticates — WITH a Referer naming the editor's canvas page (the
    // browser sends it from the iframe) and WITHOUT (active-canvas
    // fallback).
    let canvas_id = canvas_id_for_project("proj-7");
    let cookie = format!(
        "{}={token}",
        crate::web::canvas_api::canvas_cookie_name(&canvas_id)
    );
    let referer = format!("http://127.0.0.1:1/canvas/{canvas_id}/?embed=vscode");
    for headers in [
        vec![("cookie", cookie.clone())],
        vec![("cookie", cookie.clone()), ("referer", referer.clone())],
    ] {
        let headers: Vec<(&'static str, String)> = headers;
        let resp = app
            .clone()
            .oneshot(mcp_request(&headers).expect("build"))
            .await
            .expect("router responds");
        assert_eq!(
            resp.status(),
            StatusCode::OK,
            "canvas cookie authenticates (headers: {headers:?})"
        );
    }

    // Neither credential → 401 (the route is exempt from the outer bearer
    // gate, so this 401 comes from the canvas MCP layer itself).
    let resp = app
        .clone()
        .oneshot(mcp_request(&[]).expect("build"))
        .await
        .expect("router responds");
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .expect("read body");
    let parsed: serde_json::Value = serde_json::from_slice(&body).expect("json body");
    assert_eq!(parsed["code"], "UNAUTHORIZED");
    assert_eq!(
        parsed["error"], "canvas mcp requires a web auth bearer token or canvas cookie"
    );

    // A WRONG bearer is not accepted even when the cookie layer is also
    // wrong (both constant-time, neither matches); the old shared bare
    // cookie name is gone too.
    let resp = app
        .oneshot(
            mcp_request(&[
                ("authorization", "Bearer wrong".to_string()),
                ("cookie", "op_canvas_ct=wrong".to_string()),
            ])
            .expect("build"),
        )
        .await
        .expect("router responds");
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED, "no fallback open");

    drop(dir);
    server.abort();
}

#[tokio::test]
async fn web_root_routes_are_referer_scoped_per_canvas() {
    // CodeRabbit cross-canvas isolation (PR #834): canvas A's iframe must
    // keep working after canvas B opens, and no credential may execute in
    // another canvas's context. Per-canvas cookies + Referer-scoped routing
    // tie the credential AND the proxy target to the same canvas.
    struct RoutingSpawner {
        port_a: u16,
        port_b: u16,
    }
    impl DaemonSpawner for RoutingSpawner {
        fn spawn(
            &self,
            doc_key: &str,
            allow_origin: &str,
        ) -> BoxFuture<'static, Result<Arc<CanvasDaemon>, CanvasError>> {
            let port = if doc_key.ends_with("doc-a.op") {
                self.port_a
            } else {
                self.port_b
            };
            let doc_key = doc_key.to_string();
            let allow_origin = allow_origin.to_string();
            async move {
                spawn_daemon_from_command(
                    &doc_key,
                    &allow_origin,
                    fake_daemon_command_with_port(FakeKind::HandshakeThenSleep, port),
                    Duration::from_secs(10),
                )
                .await
            }
            .boxed()
        }
    }

    let (addr_a, server_a) = spawn_echo_server_marked("echo-a").await;
    let (addr_b, server_b) = spawn_echo_server_marked("echo-b").await;
    let dir = tempfile::tempdir().expect("tempdir");
    let doc_a = dir.path().join("doc-a.op");
    let doc_b = dir.path().join("doc-b.op");
    std::fs::write(&doc_a, b"{}").expect("write doc a");
    std::fs::write(&doc_b, b"{}").expect("write doc b");

    let pool = Arc::new(CanvasDaemonPool::new(Arc::new(RoutingSpawner {
        port_a: addr_a.port(),
        port_b: addr_b.port(),
    })));
    let app = web_canvas_app(Some(pool));

    // Open A, then B — B is the ACTIVE (last-opened) canvas afterwards.
    let parsed_a = web_open(app.clone(), &doc_a.to_string_lossy(), "proj-a").await;
    assert_eq!(parsed_a["success"], true);
    let parsed_b = web_open(app.clone(), &doc_b.to_string_lossy(), "proj-b").await;
    assert_eq!(parsed_b["success"], true);
    let token_a = parsed_a["data"]["canvasToken"].as_str().expect("token a").to_string();
    let token_b = parsed_b["data"]["canvasToken"].as_str().expect("token b").to_string();
    let id_a = canvas_id_for_project("proj-a");
    let id_b = canvas_id_for_project("proj-b");
    let cookie_name = crate::web::canvas_api::canvas_cookie_name;
    let cookie_a = format!("{}={token_a}", cookie_name(&id_a));
    let cookie_b = format!("{}={token_b}", cookie_name(&id_b));
    let referer_a = format!("http://127.0.0.1:1/canvas/{id_a}/?embed=vscode");
    let referer_b = format!("http://127.0.0.1:1/canvas/{id_b}/?embed=vscode");

    let post_json = |resp: axum::response::Response| async move {
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("read body");
        serde_json::from_slice::<serde_json::Value>(&body).expect("json body")
    };

    // A's cookie + A's Referer → A's daemon, even though B opened LAST.
    // (POST /api/file/save is a root canvas route whose echo reply carries
    // the marker, proving WHICH daemon served it.)
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/file/save")
                .header("cookie", &cookie_a)
                .header("referer", &referer_a)
                .body(Body::from("{}"))
                .expect("build request"),
        )
        .await
        .expect("router responds");
    assert_eq!(resp.status(), StatusCode::OK, "A's pairing authenticates");
    let parsed = post_json(resp).await;
    assert_eq!(
        parsed["echo"], "echo-a",
        "A's requests still reach A's daemon after B opened"
    );

    // The plain GET root routes route the same way (A's pairing → 200).
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri("/pkg/op_host_web.js")
                .header("cookie", &cookie_a)
                .header("referer", &referer_a)
                .body(Body::empty())
                .expect("build request"),
        )
        .await
        .expect("router responds");
    assert_eq!(resp.status(), StatusCode::OK, "A's GET root route");

    // WRONG pairing: A's cookie + B's Referer (and B's cookie + A's
    // Referer) → 401 — cross-canvas contamination is impossible.
    for (cookie, referer, label) in [
        (&cookie_a, &referer_b, "A cookie + B referer"),
        (&cookie_b, &referer_a, "B cookie + A referer"),
    ] {
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/file/save")
                    .header("cookie", cookie)
                    .header("referer", referer)
                    .body(Body::from("{}"))
                    .expect("build request"),
            )
            .await
            .expect("router responds");
        assert_eq!(
            resp.status(),
            StatusCode::UNAUTHORIZED,
            "wrong pairing ({label}) must be rejected"
        );
    }

    // No Referer + the ACTIVE canvas's (B's) cookie → B's daemon (the
    // direct-client fallback).
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/file/save")
                .header("cookie", &cookie_b)
                .body(Body::from("{}"))
                .expect("build request"),
        )
        .await
        .expect("router responds");
    assert_eq!(resp.status(), StatusCode::OK);
    let parsed = post_json(resp).await;
    assert_eq!(parsed["echo"], "echo-b", "no-Referer fallback routes to the active canvas");

    // No Referer + A's (non-active) cookie → 401: the credential does not
    // belong to the active canvas and is NEVER routed to a different canvas.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/file/save")
                .header("cookie", &cookie_a)
                .body(Body::from("{}"))
                .expect("build request"),
        )
        .await
        .expect("router responds");
    assert_eq!(
        resp.status(),
        StatusCode::UNAUTHORIZED,
        "a non-active canvas cookie without a Referer is rejected, not re-routed"
    );

    // Global /canvas/mcp cookie path: Referer-scoped the same way (A's
    // cookie + A's Referer → A's daemon, not the active one).
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/canvas/mcp")
                .header("content-type", "application/json")
                .header("cookie", &cookie_a)
                .header("referer", &referer_a)
                .body(Body::from(r#"{"jsonrpc":"2.0","method":"tools/list","id":1}"#))
                .expect("build request"),
        )
        .await
        .expect("router responds");
    assert_eq!(resp.status(), StatusCode::OK);
    let parsed = post_json(resp).await;
    assert_eq!(
        parsed["echo"], "echo-a",
        "the global MCP cookie path is Referer-scoped to A's daemon"
    );

    drop(dir);
    server_a.abort();
    server_b.abort();
}

#[tokio::test]
async fn web_open_rejects_doc_path_outside_project_boundary() {
    // The daemon receives `--file <path>` — a web client may only open a
    // doc inside the project boundary (same containment the fs/git routes
    // enforce), and the rejection happens BEFORE any daemon spawns.
    let inside = tempfile::tempdir().expect("tempdir (boundary root)");
    let outside = tempfile::tempdir().expect("tempdir (outside)");
    let (doc_dir, doc) = temp_doc(); // lives in its own temp dir → outside
    let spawner = FakeSpawner::new(FakeKind::HandshakeThenSleep);
    let pool = Arc::new(CanvasDaemonPool::new(spawner.clone()));

    let app = web_canvas_app_with_boundary(Some(pool), inside.path());
    let parsed = web_open(app, &doc, "proj-7").await;
    assert_eq!(parsed["success"], false);
    assert_eq!(parsed["code"], "PATH_VALIDATION_FAILED");
    assert!(
        parsed["error"]
            .as_str()
            .expect("error message")
            .contains("outside the project boundary"),
        "message names the containment failure"
    );
    assert_eq!(
        spawner.calls(),
        0,
        "no daemon may spawn for an out-of-boundary doc path"
    );
    drop(doc_dir);
    drop(outside);
    drop(inside);
}

#[tokio::test]
async fn web_open_accepts_doc_path_inside_project_boundary() {
    let root = tempfile::tempdir().expect("tempdir (boundary root)");
    let doc = root.path().join("design.op");
    std::fs::write(&doc, b"{}").expect("write doc");
    let spawner = FakeSpawner::new(FakeKind::HandshakeThenSleep);
    let pool = Arc::new(CanvasDaemonPool::new(spawner));
    let app = web_canvas_app_with_boundary(Some(pool), root.path());
    let parsed = web_open(
        app,
        &doc.to_string_lossy(),
        "proj-7",
    )
    .await;
    assert_eq!(parsed["success"], true, "doc inside the boundary opens");
}

#[tokio::test]
async fn pool_release_still_evicts_after_doc_file_deleted() {
    // The doc file can vanish (deleted/renamed) while its daemon is live —
    // `canonical_doc_key` falls back to the verbatim-stripped path so close
    // still evicts + disposes the daemon instead of erroring and leaking.
    let (dir, doc) = temp_doc();
    let spawner = FakeSpawner::new(FakeKind::HandshakeThenSleep);
    let pool = CanvasDaemonPool::new(spawner);
    let daemon = pool
        .acquire(&doc, TEST_ORIGIN, "proj-7")
        .await
        .expect("acquire");
    assert!(pool.daemon_for_doc(&doc).is_some());

    std::fs::remove_file(&doc).expect("delete the backing doc file");
    pool.release(&doc).await;

    assert!(
        pool.daemon_for_doc(&doc).is_none(),
        "close still evicts after the doc file is deleted"
    );
    assert!(!daemon.alive(), "the daemon was disposed, not leaked");
    drop(dir);
}

#[tokio::test]
async fn pool_reopen_while_spawn_inflight_succeeds() {
    // CodeRabbit reopen race: `release` during an inflight spawn leaves a
    // disposed slot holding the cancelled inflight. A reopen must NOT join
    // that dead future (CANVAS_CLOSED), and the superseded spawn's finalize
    // must NOT remove the reopen's fresh slot. The reopen spawns fresh and
    // succeeds; the first acquire resolves as a typed failure.
    let (dir, doc) = temp_doc();
    let spawner = FakeSpawner::new(FakeKind::DelayedHandshake);
    let pool = CanvasDaemonPool::new(spawner.clone());

    // Start the first acquire — it registers the inflight (the handshake
    // is ~500ms away) — but do not drive it to completion.
    let first = pool.acquire(&doc, TEST_ORIGIN, "proj-1");
    tokio::pin!(first);
    tokio::select! {
        _ = &mut first => panic!("first acquire cannot complete before the delayed handshake"),
        _ = tokio::time::sleep(Duration::from_millis(50)) => {}
    }

    // Close before the handshake lands: release cancels the inflight and
    // leaves a disposed slot in the map.
    pool.release(&doc).await;

    // Reopen immediately: must start a FRESH spawn and succeed — not fail
    // CANVAS_CLOSED by joining the cancelled inflight.
    let daemon = pool
        .acquire(&doc, TEST_ORIGIN, "proj-1")
        .await
        .expect("reopen while a spawn is inflight succeeds");
    assert_eq!(daemon.version, "0.8.5");
    assert!(
        spawner.calls() >= 2,
        "the reopen started a fresh spawn (calls={})",
        spawner.calls()
    );

    // The first acquire resolves as a typed failure (canvas closed while
    // starting) — never hangs, never installs.
    let outcome = tokio::time::timeout(Duration::from_secs(20), first)
        .await
        .expect("the cancelled first acquire resolves");
    assert!(
        outcome.is_err(),
        "the cancelled acquire fails with a typed error"
    );
    drop(dir);
}

// ---------------------------------------------------------------------------
// Proxy header / query hygiene (pure)
// ---------------------------------------------------------------------------

#[test]
fn proxy_strips_hop_by_hop_and_credential_headers() {
    use axum::http::HeaderName;
    // Credentials + hop-by-hop + framing never reach the daemon.
    for name in [
        "authorization",
        "cookie",
        "origin",
        "host",
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "content-length",
        "access-control-allow-origin",
        "access-control-allow-credentials",
        "access-control-allow-headers",
        "access-control-allow-methods",
        "access-control-expose-headers",
        "access-control-max-age",
    ] {
        assert!(
            crate::canvas::mcp_proxy::is_stripped_header(&HeaderName::from_static(name)),
            "{name} must be stripped before forwarding"
        );
    }
    // Application headers (content type, MCP session/protocol headers,
    // SSE resume cursors) forward verbatim.
    for name in [
        "content-type",
        "accept",
        "mcp-session-id",
        "mcp-protocol-version",
        "last-event-id",
        "x-echo",
    ] {
        assert!(
            !crate::canvas::mcp_proxy::is_stripped_header(&HeaderName::from_static(name)),
            "{name} must forward"
        );
    }
}

#[test]
fn proxy_query_strips_only_the_canvas_token() {
    let strip = crate::canvas::mcp_proxy::strip_canvas_token_query;
    // ct removed, everything else verbatim.
    assert_eq!(
        strip(Some("embed=vscode&ct=abc")).as_deref(),
        Some("embed=vscode")
    );
    assert_eq!(strip(Some("a=1&ct=2&b=3")).as_deref(), Some("a=1&b=3"));
    assert_eq!(strip(Some("ct=abc&x=1")).as_deref(), Some("x=1"));
    // ct alone (with or without a value) disappears entirely.
    assert_eq!(strip(Some("ct=abc")).as_deref(), None);
    assert_eq!(strip(Some("ct")).as_deref(), None);
    // Queries without ct pass through untouched.
    assert_eq!(strip(Some("embed=vscode")).as_deref(), Some("embed=vscode"));
    assert_eq!(strip(None), None);
}
