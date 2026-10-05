use super::*;

#[test]
fn loopback_validation_accepts_loopback_forms() {
    for url in [
        "http://127.0.0.1:8080/callback?code=abc",
        "http://127.1.2.3/cb",
        "https://127.0.0.1/cb",
        "http://localhost:51113/callback?code=x&state=y",
        "http://foo.localhost:3000/cb",
        "http://[::1]:9000/cb",
        "https://[::1]/cb",
    ] {
        assert!(is_loopback_url(url), "expected loopback: {url}");
    }
}

#[test]
fn loopback_validation_rejects_non_loopback() {
    for url in [
        // Cloud metadata endpoint — the canonical SSRF target.
        "http://169.254.169.254/latest/meta-data",
        "https://169.254.169.254/",
        // Plain external hosts.
        "http://example.com/cb",
        "https://example.com",
        // Loopback-suffixed phishing: NOT a *.localhost subdomain.
        "http://localhost.evil.com/cb",
        "http://evil-localhost.com/",
        // Non-loopback literals.
        "http://10.0.0.1/",
        "http://192.168.1.1/",
        "http://[::ffff:8.8.8.8]/",
        "http://[2606:4700:4700::1111]/",
        // Non-http(s) schemes.
        "file:///etc/passwd",
        "ftp://127.0.0.1/",
        // Garbage.
        "not a url",
        "127.0.0.1",
    ] {
        assert!(!is_loopback_url(url), "expected rejection: {url}");
    }
}

#[cfg(unix)]
#[test]
fn inject_shim_env_prepends_path_and_sets_browser() {
    let dir = PathBuf::from("/tmp/termul-acp-shim/agent-1");
    let mut env = HashMap::from([("PATH".to_string(), "/usr/bin:/bin".to_string())]);
    inject_shim_env(&mut env, &dir);
    assert_eq!(
        env.get("PATH").map(String::as_str),
        Some("/tmp/termul-acp-shim/agent-1:/usr/bin:/bin"),
        "shim dir must be FIRST on PATH"
    );
    assert_eq!(
        env.get("BROWSER").map(String::as_str),
        Some("/tmp/termul-acp-shim/agent-1/xdg-open"),
    );
}

#[cfg(unix)]
#[test]
fn inject_shim_env_handles_missing_or_empty_path() {
    let dir = PathBuf::from("/tmp/shim");
    let mut env = HashMap::new();
    inject_shim_env(&mut env, &dir);
    assert_eq!(env.get("PATH").map(String::as_str), Some("/tmp/shim"));

    let mut env = HashMap::from([("PATH".to_string(), String::new())]);
    inject_shim_env(&mut env, &dir);
    assert_eq!(env.get("PATH").map(String::as_str), Some("/tmp/shim"));
}

#[cfg(unix)]
#[test]
fn install_shim_writes_executable_scripts_and_sink() {
    use std::os::unix::fs::PermissionsExt;
    let agent_id = AgentId(format!("test-shim-{}", uuid::Uuid::new_v4()));
    let dir = install_shim(&agent_id).expect("shim install must succeed");
    assert_eq!(dir, shim_dir_for(&agent_id));
    for program in SHIM_PROGRAMS {
        let path = dir.join(program);
        let meta = std::fs::metadata(&path).expect("script exists");
        assert!(
            meta.permissions().mode() & 0o111 != 0,
            "{program} not executable"
        );
        let body = std::fs::read_to_string(&path).unwrap();
        assert!(
            body.contains("urls"),
            "{program} must append to the urls sink"
        );
    }
    assert!(dir.join(SINK_FILE_NAME).exists());
    remove_shim(&agent_id);
    assert!(!dir.exists());
}

#[cfg(unix)]
#[test]
fn shim_script_appends_last_http_arg() {
    // Behavioral check: run the real installed script through `sh` and
    // confirm the sink captures the last http(s) argument.
    let agent_id = AgentId(format!("test-shim-run-{}", uuid::Uuid::new_v4()));
    let dir = install_shim(&agent_id).expect("shim install must succeed");
    let status = std::process::Command::new("sh")
        .arg(dir.join("xdg-open"))
        .arg("--flag")
        .arg("https://auth.example.com/login?state=1")
        .arg("http://127.0.0.1:9/cb")
        .status()
        .expect("run shim script");
    assert!(status.success());
    let sink = std::fs::read_to_string(dir.join(SINK_FILE_NAME)).unwrap();
    assert_eq!(sink, "http://127.0.0.1:9/cb\n");
    remove_shim(&agent_id);
}

#[cfg(unix)]
#[test]
fn watcher_fans_out_captured_urls() {
    struct Recorder(parking_lot::Mutex<Vec<(Option<String>, &'static str, serde_json::Value)>>);
    impl EventSink for Recorder {
        fn emit(&self, event: &crate::web::sink::AcpEvent) {
            self.0
                .lock()
                .push((event.sid.clone(), event.type_, event.payload.clone()));
        }
    }

    let agent_id = AgentId(format!("test-shim-watch-{}", uuid::Uuid::new_v4()));
    let dir = install_shim(&agent_id).expect("shim install must succeed");
    let recorder = Arc::new(Recorder(parking_lot::Mutex::new(Vec::new())));
    let sinks: Vec<Arc<dyn EventSink>> = vec![recorder.clone()];
    let watcher = ShimWatcher::spawn(agent_id.clone(), dir.clone(), sinks);

    std::fs::write(dir.join(SINK_FILE_NAME), "https://auth.example.com/a\n").unwrap();
    // Poll interval is 500ms; give the thread a few cycles.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if !recorder.0.lock().is_empty() {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "watcher did not emit");
        std::thread::sleep(Duration::from_millis(50));
    }
    let seen = recorder.0.lock();
    assert_eq!(seen.len(), 1);
    assert_eq!(
        seen[0].0, None,
        "browser_open_request is agent-level (sid=None)"
    );
    assert_eq!(seen[0].1, events::EVENT_BROWSER_OPEN_REQUEST);
    assert_eq!(
        seen[0].2,
        serde_json::json!({
            "agentId": agent_id.0,
            "url": "https://auth.example.com/a",
        })
    );
    drop(seen);
    drop(watcher);
    remove_shim(&agent_id);
}

/// Bind a one-shot loopback TCP listener on an ephemeral port, returning
/// the port and a handle that reads the first request and answers `status`.
/// Used to prove `deliver_auth_redirect` issues exactly one GET.
#[cfg(unix)]
fn one_shot_listener(status_line: &'static str) -> (u16, std::thread::JoinHandle<Vec<String>>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind listener");
    let port = listener.local_addr().unwrap().port();
    let handle = std::thread::spawn(move || {
        use std::io::{BufRead, BufReader, Write};
        let mut requests = Vec::new();
        // Accept exactly one connection, read its request line, answer.
        if let Ok((stream, _)) = listener.accept() {
            let mut reader = BufReader::new(&stream);
            let mut line = String::new();
            if reader.read_line(&mut line).is_ok() {
                requests.push(line.trim_end().to_string());
            }
            let mut stream = stream;
            let _ = stream.write_all(status_line.as_bytes());
        }
        requests
    });
    (port, handle)
}

#[cfg(unix)]
#[tokio::test]
async fn deliver_auth_redirect_issues_exactly_one_get() {
    let (port, handle) = one_shot_listener("HTTP/1.1 302 Found\r\nContent-Length: 0\r\n\r\n");
    let url = format!("http://127.0.0.1:{port}/cb?code=abc");
    let status = deliver_auth_redirect(&url)
        .await
        .expect("replay should succeed");
    assert_eq!(status, 302);
    let requests = handle.join().expect("listener thread");
    assert_eq!(requests.len(), 1, "expected exactly one GET");
    assert!(
        requests[0].starts_with("GET "),
        "expected a GET: {}",
        requests[0]
    );
}

#[cfg(unix)]
#[tokio::test]
async fn deliver_auth_redirect_rejects_non_loopback() {
    for url in [
        "http://169.254.169.254/latest/meta-data",
        "http://example.com/cb",
        "http://localhost.evil.com/cb",
        "http://10.0.0.1/",
    ] {
        let err = deliver_auth_redirect(url)
            .await
            .expect_err("non-loopback must be refused");
        assert!(err.contains("refused"), "expected refusal for {url}: {err}");
    }
}
