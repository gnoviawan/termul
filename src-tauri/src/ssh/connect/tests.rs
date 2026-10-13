use super::*;
use std::sync::atomic::AtomicBool;

fn target<'a>(host: &'a str, port: u16, username: &'a str) -> Target<'a> {
    Target {
        host,
        port,
        username,
        auth_method: "password",
        key_path: None,
    }
}

/// Trusts every host key; can be cancelled.
#[derive(Default)]
struct TestHooks {
    cancelled: AtomicBool,
    asked: AtomicBool,
}

impl ConnectHooks for TestHooks {
    fn host_key(
        &self,
        _info: HostKeyInfo,
        _status: HostKeyStatus,
    ) -> BoxFuture<'_, HostKeyDecision> {
        self.asked.store(true, Ordering::SeqCst);
        Box::pin(async { HostKeyDecision::Trust })
    }

    fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

fn closed_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

#[test]
fn validate_rejects_empty_and_malformed_targets() {
    let cases = [
        target("", 22, "u"),
        target("   ", 22, "u"),
        target("bad host", 22, "u"),
        target("ho\nst", 22, "u"),
        target("host", 0, "u"),
        target("host", 22, " "),
    ];
    for case in cases {
        let err = validate_target(&case).expect_err("target must be rejected");
        assert_eq!(err.kind, ConnectErrorKind::InvalidTarget);
    }
    assert!(validate_target(&target("example.com", 22, "root")).is_ok());
    assert!(validate_target(&target("::1", 2222, "root")).is_ok());
}

#[test]
fn every_kind_has_a_distinct_code() {
    use ConnectErrorKind::*;
    let kinds = [
        InvalidTarget,
        DnsFailed,
        ConnectionRefused,
        Timeout,
        Unreachable,
        HandshakeFailed,
        HostKeyRejected,
        HostKeyChanged,
        HostKeyUnknown,
        PasswordRequired,
        PassphraseRequired,
        PassphraseIncorrect,
        AuthFailed,
        AuthMethodUnavailable,
        KeyNotFound,
        KeyInvalid,
        AgentUnavailable,
        Cancelled,
        ShellFailed,
        Internal,
    ];
    let codes: std::collections::HashSet<_> = kinds.iter().map(|k| k.code()).collect();
    assert_eq!(codes.len(), kinds.len());
    assert!(codes.iter().all(|c| c.starts_with("SSH_")));
}

#[test]
fn io_errors_map_to_network_kinds() {
    use std::io::{Error, ErrorKind};
    assert_eq!(
        classify_io(&Error::from(ErrorKind::ConnectionRefused)),
        ConnectErrorKind::ConnectionRefused
    );
    assert_eq!(
        classify_io(&Error::from(ErrorKind::TimedOut)),
        ConnectErrorKind::Timeout
    );
    assert_eq!(
        classify_io(&Error::from(ErrorKind::Other)),
        ConnectErrorKind::Unreachable
    );
}

#[test]
fn keyboard_interactive_answers_only_the_first_hidden_round() {
    // Password prompt (hidden) plus a visible one, first round.
    assert_eq!(
        kbd_answers(&[false, true], "secret", false),
        vec!["secret".to_string(), String::new()]
    );
    // A later round (one-time code) never gets the password.
    assert_eq!(kbd_answers(&[false], "secret", true), vec![String::new()]);
}

#[tokio::test]
async fn unresolvable_host_is_a_dns_failure() {
    let err = connect_tcp("nonexistent.invalid.example.test.", 22)
        .await
        .expect_err("unresolvable host should fail");
    assert_eq!(err.kind, ConnectErrorKind::DnsFailed);
}

#[tokio::test]
async fn closed_local_port_is_refused() {
    let err = connect_tcp("127.0.0.1", closed_port())
        .await
        .expect_err("closed port should fail");
    assert!(
        matches!(
            err.kind,
            ConnectErrorKind::ConnectionRefused | ConnectErrorKind::Timeout
        ),
        "unexpected kind: {:?}",
        err.kind
    );
}

#[tokio::test]
async fn ipv6_literal_reaches_a_connection_attempt() {
    // A bare IPv6 literal resolves without bracket form; a closed port must
    // not look like a DNS failure.
    let err = connect_tcp("::1", 1)
        .await
        .expect_err("closed port should fail");
    assert_ne!(err.kind, ConnectErrorKind::DnsFailed);
}

#[tokio::test]
async fn non_ssh_server_fails_the_handshake() {
    use tokio::io::AsyncWriteExt;
    // A server that speaks something other than SSH and hangs up.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        if let Ok((mut stream, _)) = listener.accept().await {
            let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n").await;
        }
    });
    let Err(err) = connect(
        &target("127.0.0.1", port, "user"),
        Some("pw"),
        Arc::new(TestHooks::default()),
    )
    .await
    else {
        panic!("handshake must fail");
    };
    assert_eq!(err.kind, ConnectErrorKind::HandshakeFailed);
    server.await.unwrap();
}

#[tokio::test]
async fn cancel_aborts_a_silent_server() {
    // Accepts TCP but never speaks SSH.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move { listener.accept().await.map(|(s, _)| s) });
    let hooks = Arc::new(TestHooks::default());
    let canceller = hooks.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        canceller.cancelled.store(true, Ordering::SeqCst);
    });
    let started = Instant::now();
    let Err(err) = connect(&target("127.0.0.1", port, "user"), Some("pw"), hooks).await else {
        panic!("cancelled connect must fail");
    };
    assert_eq!(err.kind, ConnectErrorKind::Cancelled);
    assert!(started.elapsed() < Duration::from_secs(5));
    drop(server.await);
}

/// Authentication against a real sshd. Run with:
/// `TERMUL_SSH_TEST_HOST=127.0.0.1 TERMUL_SSH_TEST_PORT=2222 TERMUL_SSH_TEST_USER=u
///  TERMUL_SSH_TEST_PASSWORD=p TERMUL_SSH_TEST_KEYS=<dir> TERMUL_SSH_TEST_KEY_PASSPHRASE=k
///  TERMUL_SSH_TEST_KBD_USER=u2 TERMUL_SSH_TEST_KBD_PASSWORD=p2 cargo test --lib -- --ignored real_server_auth`
/// `<dir>` holds `id_ed25519_plain`, `id_ed25519_enc`, `id_rsa_pem` (authorized) and
/// `id_ed25519_unauthorized`.
#[tokio::test]
#[ignore]
async fn real_server_auth_matrix() {
    let var = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("{name} not set"));
    let host = var("TERMUL_SSH_TEST_HOST");
    let port: u16 = var("TERMUL_SSH_TEST_PORT").parse().unwrap();
    let user = var("TERMUL_SSH_TEST_USER");
    let password = var("TERMUL_SSH_TEST_PASSWORD");
    let keys = std::path::PathBuf::from(var("TERMUL_SSH_TEST_KEYS"));
    let passphrase = var("TERMUL_SSH_TEST_KEY_PASSPHRASE");
    let kbd_user = var("TERMUL_SSH_TEST_KBD_USER");
    let kbd_password = var("TERMUL_SSH_TEST_KBD_PASSWORD");
    let key = |name: &str| Some(keys.join(name).to_string_lossy().to_string());

    let run = |username: String,
               method: &'static str,
               key_path: Option<String>,
               secret: Option<String>| {
        let host = host.clone();
        async move {
            connect(
                &Target {
                    host: &host,
                    port,
                    username: &username,
                    auth_method: method,
                    key_path: key_path.as_deref(),
                },
                secret.as_deref(),
                Arc::new(TestHooks::default()),
            )
            .await
            .map(|_| true)
            .map_err(|e| e.kind)
        }
    };

    use ConnectErrorKind::*;
    type Outcome = Result<bool, ConnectErrorKind>;
    let cases: Vec<(&str, Outcome, Outcome)> = vec![
        (
            "password ok",
            run(user.clone(), "password", None, Some(password.clone())).await,
            Ok(true),
        ),
        (
            "password wrong",
            run(user.clone(), "password", None, Some("wrong".into())).await,
            Err(AuthFailed),
        ),
        (
            "password missing",
            run(user.clone(), "password", None, None).await,
            Err(PasswordRequired),
        ),
        (
            "keyboard-interactive only",
            run(
                kbd_user.clone(),
                "password",
                None,
                Some(kbd_password.clone()),
            )
            .await,
            Ok(true),
        ),
        (
            "keyboard-interactive wrong",
            run(kbd_user.clone(), "password", None, Some("nope".into())).await,
            Err(AuthFailed),
        ),
        (
            "ed25519 key",
            run(user.clone(), "key", key("id_ed25519_plain"), None).await,
            Ok(true),
        ),
        (
            "rsa pem key",
            run(user.clone(), "key", key("id_rsa_pem"), None).await,
            Ok(true),
        ),
        (
            "encrypted key, no passphrase",
            run(user.clone(), "key", key("id_ed25519_enc"), None).await,
            Err(PassphraseRequired),
        ),
        (
            "encrypted key, wrong passphrase",
            run(
                user.clone(),
                "key",
                key("id_ed25519_enc"),
                Some("wrong-pass".into()),
            )
            .await,
            Err(PassphraseIncorrect),
        ),
        (
            "encrypted key, right passphrase",
            run(
                user.clone(),
                "key",
                key("id_ed25519_enc"),
                Some(passphrase.clone()),
            )
            .await,
            Ok(true),
        ),
        (
            "unauthorized key",
            run(user.clone(), "key", key("id_ed25519_unauthorized"), None).await,
            Err(AuthFailed),
        ),
        (
            "missing key file",
            run(user.clone(), "key", key("does-not-exist"), None).await,
            Err(KeyNotFound),
        ),
        (
            "public key picked",
            run(user.clone(), "key", key("id_ed25519_plain.pub"), None).await,
            Err(KeyInvalid),
        ),
    ];

    let mut failures = Vec::new();
    for (name, actual, expected) in &cases {
        let ok = actual == expected;
        println!("{} {name}: {actual:?}", if ok { "PASS" } else { "FAIL" });
        if !ok {
            failures.push(format!("{name}: expected {expected:?}, got {actual:?}"));
        }
    }
    // Agent availability depends on the machine; report it without failing.
    println!(
        "info agent: {:?}",
        run(user.clone(), "agent", None, None).await
    );
    assert!(failures.is_empty(), "{failures:#?}");
}
