use super::*;

#[test]
fn sidecar_name_is_nonempty() {
    assert!(!cloudflared_sidecar_name().is_empty());
}

#[test]
fn resolve_path_returns_a_string_and_known_source() {
    let (path, source) = resolve_cloudflared_path();
    assert!(!path.is_empty());
    // "env" only with the env var set; "sidecar" when a bundled file is
    // found; "path" is the bare-name fallback (dev/CI without the binary).
    assert!(
        matches!(source.as_str(), "env" | "sidecar" | "path"),
        "unexpected source: {source}"
    );
}

#[test]
fn detect_caches_first_resolution() {
    let a = detect_cloudflared_path();
    let b = detect_cloudflared_path();
    assert_eq!(a, b, "detect_cloudflared_path must be idempotent");
}

#[test]
fn url_regex_matches_trycloudflare_hostnames() {
    let line = "2026-07-30 INF Your quick Tunnel has been created! Visit it at: https://foo-bar-baz.trycloudflare.com";
    let m = TRY_TUNNEL_URL_RE.find(line).expect("must match");
    assert_eq!(m.as_str(), "https://foo-bar-baz.trycloudflare.com");
}

#[test]
fn url_regex_matches_inside_json_logs() {
    let line = "{\"level\":\"info\",\"url\":\"https://random-words-1234.trycloudflare.com\"}";
    let m = TRY_TUNNEL_URL_RE.find(line).expect("must match");
    assert_eq!(m.as_str(), "https://random-words-1234.trycloudflare.com");
}

#[test]
fn url_regex_ignores_localhost_urls() {
    // The QR must encode the PUBLIC tunnel URL, never the local one.
    assert!(TRY_TUNNEL_URL_RE
        .find("listening on http://localhost:5123")
        .is_none());
}

#[test]
fn url_regex_ignores_arbitrary_https_urls() {
    assert!(TRY_TUNNEL_URL_RE
        .find("redirect to https://example.com/path")
        .is_none());
}

#[tokio::test]
async fn scanner_keeps_pipe_open_after_url_delivered() {
    use tokio::io::AsyncWriteExt;

    let (mut writer, reader) = tokio::io::duplex(1024);
    let (tx, rx) = oneshot::channel();
    let tx = std::sync::Arc::new(Mutex::new(Some(tx)));

    spawn_line_scanner(reader, tx);

    // Deliver the URL line.
    writer
        .write_all(b"Your quick Tunnel has been created at https://abc-123.trycloudflare.com\n")
        .await
        .expect("write URL line");
    let url = rx.await.expect("URL must be delivered");
    assert!(url.contains("trycloudflare"));

    // Let the scanner reach its next poll. With the pre-fix early `return`
    // the reader half was dropped here and the write below would fail —
    // the EPIPE the real cloudflared hits on its next log write (issue
    // #593). With the fix the scanner is parked on read_line and the
    // writer stays writable.
    tokio::task::yield_now().await;
    writer
        .write_all(b"2026-08-15 INF periodic keepalive log line\n")
        .await
        .expect("writer must stay writable after URL delivery — scanner must keep draining");

    // A dropped read end also surfaces as ConnectionReset on subsequent
    // writes; drain the line the scanner consumed, then a second write
    // must still succeed.
    writer
        .write_all(b"another log line\n")
        .await
        .expect("writer must stay writable across repeated writes");
}

#[cfg(unix)]
#[tokio::test]
async fn real_child_stays_alive_after_url_delivery() {
    // End-to-end mirror of issue #593: a subprocess that prints the tunnel
    // URL and then keeps writing log lines (like cloudflared's periodic
    // output). The child must stay alive after the URL is delivered — with
    // the pre-fix early `return` the pipe read end closed and the child
    // died on SIGPIPE/EPIPE within a second.
    use std::process::Stdio;

    let mut child = tokio::process::Command::new("sh")
        .arg("-c")
        .arg(
            "printf 'Your quick Tunnel at https://abc-123.trycloudflare.com\\n'; \
                 i=0; while [ $i -lt 4 ]; do echo tick-$i; sleep 1; i=$((i+1)); done",
        )
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn child");

    let stdout = child.stdout.take().expect("stdout pipe");
    let (tx, rx) = oneshot::channel();
    let tx = std::sync::Arc::new(Mutex::new(Some(tx)));
    spawn_line_scanner(stdout, tx);

    let url = rx.await.expect("URL must be delivered");
    assert!(url.contains("trycloudflare"));

    // The child keeps writing a log line every second. It must still be
    // alive well after URL delivery (it runs ~4s total), proving the pipe
    // read end stayed open and was drained.
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    assert!(
        child.try_wait().expect("try_wait").is_none(),
        "child must stay alive while the tunnel runs (issue #593)"
    );

    // Drain until the child exits naturally (EOF → scanner exits cleanly).
    let status = child.wait().await.expect("child wait");
    assert!(
        status.success(),
        "child should exit cleanly after its script"
    );
}

#[tokio::test]
async fn probe_returns_err_for_unreachable_url_near_deadline() {
    // Port 1 on loopback → connection refused (fast), so each GET returns
    // immediately; the 2s deadline bounds total elapsed time. Asserts the
    // probe gives up near the deadline (never hangs) + surfaces the error.
    let start = std::time::Instant::now();
    let result = probe_tunnel_ready_with(
        "http://127.0.0.1:1/",
        std::time::Duration::from_secs(2),
        std::time::Duration::from_millis(250),
    )
    .await;
    assert!(
        result.is_err(),
        "unreachable URL must not be reported ready"
    );
    // Tight bound: the deadline + capped retry sleep can't overshoot by a
    // full interval, so ~2s + small epsilon — well under 3s.
    assert!(
        start.elapsed() < std::time::Duration::from_secs(3),
        "probe must give up near the deadline, not hang; took {:?}",
        start.elapsed()
    );
    assert!(result.unwrap_err().contains("not reachable within 2s"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn probe_bounded_by_deadline_against_hanging_listener() {
    // A listener that accepts the TCP connection but never sends an HTTP
    // response — so the only thing that unblocks each GET is the probe's
    // per-request timeout. This exercises the timeout + capped-retry-sleep
    // path the port-1 (instant-refuse) test can't.
    let addr = spawn_hanging_listener().await;
    let url = format!("http://{addr}/");
    let start = std::time::Instant::now();
    let result = probe_tunnel_ready_with(
        &url,
        std::time::Duration::from_secs(2),
        std::time::Duration::from_millis(500),
    )
    .await;
    assert!(
        result.is_err(),
        "hanging listener must not be reported ready"
    );
    // The per-request timeout is capped to the remaining deadline, so total
    // wait must hug the 2s bound — not the 3s per-request default.
    assert!(
        start.elapsed() < std::time::Duration::from_secs(3),
        "probe overshot the deadline: {:?}",
        start.elapsed()
    );
}

/// A local TCP listener that accepts connections but never sends an HTTP
/// response, so a probe client's per-request timeout is the only unblock.
async fn spawn_hanging_listener() -> std::net::SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind hanging listener");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        // Accept connections but never send an HTTP response — a probe
        // client's per-request timeout is the only unblock.
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let _ = tokio::time::sleep(std::time::Duration::from_secs(120)).await;
                drop(stream);
            });
        }
    });
    addr
}
