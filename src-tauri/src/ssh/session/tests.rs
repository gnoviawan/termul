use super::*;
use std::sync::Mutex as StdMutex;
use std::time::Instant;

type Events = Arc<StdMutex<Vec<(String, serde_json::Value)>>>;

fn recording_manager() -> (Arc<SshSessionManager>, Events) {
    let events: Events = Arc::new(StdMutex::new(Vec::new()));
    let sink = events.clone();
    let manager = SshSessionManager::new(Arc::new(move |name, payload| {
        sink.lock().unwrap().push((name.to_string(), payload));
    }));
    (manager, events)
}

fn pty_manager() -> PtyManager {
    let events = crate::trackers::TerminalEventHub::standalone();
    let cwd = Arc::new(crate::trackers::CwdTracker::new(events.clone()));
    let git = Arc::new(crate::trackers::GitTracker::new(None, events.clone()));
    let exit = Arc::new(crate::trackers::ExitCodeTracker::new(events.clone()));
    PtyManager::new(events, cwd, git, exit)
}

fn target(host: &str, port: u16) -> SessionTarget {
    SessionTarget {
        profile_id: "p1".into(),
        host: host.into(),
        port,
        username: "user".into(),
        auth_method: "password".into(),
        key_path: None,
    }
}

#[test]
fn secret_cache_lives_as_long_as_its_sessions() {
    let (manager, _) = recording_manager();
    assert_eq!(manager.cached_secret("p1"), None);
    manager.retain_secret("p1", "one");
    manager.retain_secret("p1", "two");
    assert_eq!(manager.cached_secret("p1").as_deref(), Some("two"));
    manager.release_secret("p1");
    assert_eq!(manager.cached_secret("p1").as_deref(), Some("two"));
    manager.release_secret("p1");
    assert_eq!(manager.cached_secret("p1"), None);
    // Releasing an unknown host is a no-op.
    manager.release_secret("p1");
    manager.retain_secret("p2", "x");
    manager.forget_secret("p2");
    assert_eq!(manager.cached_secret("p2"), None);
}

#[test]
fn prompts_and_cancel_ignore_unknown_sessions() {
    let (manager, _) = recording_manager();
    assert!(!manager.respond_host_key("missing", true));
    assert!(!manager.cancel("missing"));
    assert!(manager.terminal_id("missing").is_none());
    assert!(manager.list().is_empty());
}

#[test]
fn end_payload_names_the_reason() {
    let exited = end_payload("s", Some("t"), &ShellEnd::Exited(Some(2)));
    assert_eq!(exited["reason"], "exited");
    assert_eq!(exited["exitCode"], 2);
    let lost = end_payload("s", None, &ShellEnd::Lost("reset".into()));
    assert_eq!(lost["reason"], "lost");
    assert_eq!(lost["detail"], "reset");
    assert!(lost["terminalId"].is_null());
    assert_eq!(
        end_payload("s", None, &ShellEnd::Closed)["reason"],
        "closed"
    );
}

#[tokio::test]
async fn failed_open_reports_progress_and_cleans_up() {
    let (manager, events) = recording_manager();
    let pty = pty_manager();
    let port = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    let err = manager
        .open(
            &pty,
            "s1",
            target("127.0.0.1", port),
            Some("pw".into()),
            80,
            24,
        )
        .await
        .expect_err("closed port must fail");
    assert!(matches!(
        err.kind,
        ConnectErrorKind::ConnectionRefused | ConnectErrorKind::Timeout
    ));
    // Nothing is left pending, so the id can be reused.
    assert!(!manager.cancel("s1"));
    assert!(manager.list().is_empty());
    let recorded = events.lock().unwrap();
    assert_eq!(recorded[0].0, EVENT_PROGRESS);
    assert_eq!(recorded[0].1["stage"], "connecting");
}

#[tokio::test]
async fn cancel_aborts_a_stalled_handshake() {
    let (manager, _) = recording_manager();
    let pty = pty_manager();
    // Accepts the TCP connection but never speaks SSH.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let holder = std::thread::spawn(move || listener.accept().map(|(stream, _)| stream));

    let canceller = manager.clone();
    let cancel_task = tokio::spawn(async move {
        // Wait until the connect registered, then cancel it.
        for _ in 0..50 {
            if canceller.cancel("s2") {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        false
    });
    let started = Instant::now();
    let err = manager
        .open(
            &pty,
            "s2",
            target("127.0.0.1", port),
            Some("pw".into()),
            80,
            24,
        )
        .await
        .expect_err("cancelled connect must fail");
    assert!(cancel_task.await.unwrap());
    assert_eq!(err.kind, ConnectErrorKind::Cancelled);
    assert!(started.elapsed() < Duration::from_secs(10));
    drop(holder.join());
}

/// Real-server check. Run with a reachable sshd:
/// `TERMUL_SSH_TEST_HOST=127.0.0.1 TERMUL_SSH_TEST_PORT=2222 TERMUL_SSH_TEST_USER=u
///  TERMUL_SSH_TEST_PASSWORD=p cargo test --lib ssh::session -- --ignored`
#[tokio::test]
#[ignore]
async fn real_server_shell_round_trip() {
    let host = std::env::var("TERMUL_SSH_TEST_HOST").expect("TERMUL_SSH_TEST_HOST");
    let port: u16 = std::env::var("TERMUL_SSH_TEST_PORT")
        .unwrap_or_else(|_| "22".into())
        .parse()
        .unwrap();
    let user = std::env::var("TERMUL_SSH_TEST_USER").expect("TERMUL_SSH_TEST_USER");
    let password = std::env::var("TERMUL_SSH_TEST_PASSWORD").expect("TERMUL_SSH_TEST_PASSWORD");

    let (manager, events) = recording_manager();
    // Trust whatever key the test server presents.
    let answering = manager.clone();
    let answer_events = events.clone();
    let answerer = tokio::spawn(async move {
        for _ in 0..200 {
            let asked = answer_events
                .lock()
                .unwrap()
                .iter()
                .any(|(name, _)| name == EVENT_HOST_KEY);
            if asked && answering.respond_host_key("real", true) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    });

    let pty = pty_manager();
    let mut session_target = target(&host, port);
    session_target.username = user;
    let opened = manager
        .open(&pty, "real", session_target, Some(password), 100, 30)
        .await
        .expect("session should open");
    answerer.abort();
    let terminal_id = opened.terminal.info.id.clone();
    assert!(manager.cached_secret("p1").is_some());

    pty.resize(&terminal_id, 120, 40).await.expect("resize");
    pty.write(&terminal_id, "stty size; echo termul-$((40+2))\r")
        .await
        .expect("write");

    let instance = pty.get(&terminal_id).expect("terminal registered");
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut output = String::new();
    while Instant::now() < deadline {
        output = instance
            .output_log
            .read()
            .iter()
            .map(|chunk| String::from_utf8_lossy(&chunk.data).to_string())
            .collect();
        if output.contains("termul-42") && output.contains("40 120") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(output.contains("termul-42"), "output was: {output}");
    assert!(output.contains("40 120"), "resize not applied: {output}");

    pty.kill(&terminal_id).await.expect("kill");
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline && !manager.list().is_empty() {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(manager.list().is_empty());
    assert_eq!(manager.cached_secret("p1"), None);
    let ended = events
        .lock()
        .unwrap()
        .iter()
        .find(|(name, _)| name == EVENT_ENDED)
        .map(|(_, payload)| payload.clone())
        .expect("ended event");
    assert_eq!(ended["reason"], "closed");
}
