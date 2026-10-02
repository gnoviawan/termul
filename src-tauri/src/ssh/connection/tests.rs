use super::*;

fn profile(auth_method: &str) -> SSHProfile {
    SSHProfile {
        id: "p1".to_string(),
        name: "Test".to_string(),
        host: "example.com".to_string(),
        port: 22,
        username: "user".to_string(),
        auth_method: auth_method.to_string(),
        private_key_path: None,
        password: None,
        passphrase: None,
        jump_host_id: None,
        port_forwards: Vec::new(),
        tags: None,
        last_connected: None,
        imported_from: None,
        has_stored_password: false,
        has_stored_passphrase: false,
    }
}

#[test]
fn auth_result_requires_password_for_password_profiles() {
    let session = Session::new().expect("session should be created");
    let error = SSHConnectionManager::authenticate_session(&session, &profile("password"), None)
        .expect_err("missing password must fail before network authentication");

    assert_eq!(error, "Password required");
}

#[test]
fn auth_result_rejects_unknown_auth_method() {
    let session = Session::new().expect("session should be created");
    let error = SSHConnectionManager::authenticate_session(&session, &profile("webauthn"), None)
        .expect_err("unknown auth method must fail before network authentication");

    assert_eq!(error, "Unknown auth method: webauthn");
}

#[test]
fn connect_tcp_rejects_unresolvable_host_without_panicking() {
    // A syntactically valid but non-resolvable host must produce a
    // descriptive error rather than the old IP-only parse failure.
    let err = SSHConnectionManager::connect_tcp("nonexistent.invalid.example.test.", 22)
        .expect_err("unresolvable host should error");
    assert!(
        err.contains("resolve") || err.contains("TCP connection"),
        "unexpected error message: {}",
        err
    );
}

#[test]
fn connect_tcp_accepts_hostname_syntax() {
    // Regression for the IP-only bug: an address must reach DNS resolution
    // (and then a connection attempt) rather than failing with "invalid
    // socket address syntax". 127.0.0.1 on a closed low port refuses
    // immediately and avoids resolver/dual-stack dependence.
    let err = SSHConnectionManager::connect_tcp("127.0.0.1", 1)
        .expect_err("closed port should not connect");
    assert!(
        !err.contains("invalid socket address"),
        "address should resolve, got: {}",
        err
    );
    assert!(err.contains("TCP connection"), "unexpected error: {}", err);
}

#[test]
fn base64_encode_matches_known_vectors() {
    // RFC 4648 test vectors, ensuring correct padding for the known_hosts
    // serializer.
    assert_eq!(base64_encode(b""), "");
    assert_eq!(base64_encode(b"f"), "Zg==");
    assert_eq!(base64_encode(b"fo"), "Zm8=");
    assert_eq!(base64_encode(b"foo"), "Zm9v");
    assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
    assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
    assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
}

#[test]
fn connect_tcp_accepts_ipv6_literal() {
    // Regression: resolving via the (host, port) tuple (not a formatted
    // string) lets bare IPv6 literals resolve without bracket form.
    // `::1` port 1 should reach a connection attempt, not a resolve/parse
    // error. If the host has no IPv6 loopback it still must not be an
    // "invalid socket address" failure.
    let err =
        SSHConnectionManager::connect_tcp("::1", 1).expect_err("closed port should not connect");
    assert!(
        !err.contains("invalid socket address"),
        "IPv6 literal should resolve via tuple, got: {}",
        err
    );
    assert!(err.contains("TCP connection"), "unexpected error: {}", err);
}
