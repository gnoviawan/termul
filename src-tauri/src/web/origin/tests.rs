use super::*;

fn policy(list: &str) -> OriginPolicy {
    OriginPolicy::parse_list(list).expect("origin list")
}

#[test]
fn missing_origin_is_allowed_on_state_changing_and_websocket_routes() {
    let policy = OriginPolicy::default();
    for (method, path) in [
        ("POST", "/fs/write"),
        ("PUT", "/projects/id"),
        ("PATCH", "/mcp-servers"),
        ("DELETE", "/projects/id"),
        ("GET", "/ws"),
        ("GET", "/terminal/ws"),
    ] {
        assert!(
            origin_allowed(method, path, None, Some("127.0.0.1:8080"), &policy),
            "{method} {path} without Origin must be allowed"
        );
        assert!(
            origin_allowed(method, path, Some("   "), Some("127.0.0.1:8080"), &policy),
            "{method} {path} with a blank Origin must be allowed"
        );
    }
}

#[test]
fn same_host_and_port_is_allowed() {
    let policy = OriginPolicy::default();
    assert!(origin_allowed(
        "POST",
        "/fs/write",
        Some("http://127.0.0.1:8080"),
        Some("127.0.0.1:8080"),
        &policy
    ));
    assert!(origin_allowed(
        "GET",
        "/terminal/ws",
        Some("HTTP://LocalHost:8080"),
        Some("localhost:8080"),
        &policy
    ));
    assert!(origin_allowed(
        "GET",
        "/ws",
        Some("https://127.0.0.1:8080"),
        Some("127.0.0.1:8080"),
        &policy
    ));
    assert!(origin_allowed(
        "POST",
        "/git/commit",
        Some("https://termul.example"),
        Some("termul.example"),
        &policy
    ));
    assert!(origin_allowed(
        "POST",
        "/git/commit",
        Some("https://termul.example:443"),
        Some("termul.example"),
        &policy
    ));
    assert!(origin_allowed(
        "GET",
        "/ws",
        Some("http://[::1]:8080"),
        Some("[::1]:8080"),
        &policy
    ));
}

#[test]
fn foreign_origin_is_rejected_on_websocket_and_state_changing_routes() {
    let policy = OriginPolicy::default();
    for (method, path) in [
        ("GET", "/ws"),
        ("GET", "/terminal/ws"),
        ("POST", "/fs/write"),
        ("DELETE", "/projects/abc"),
    ] {
        assert!(
            !origin_allowed(
                method,
                path,
                Some("http://evil.example"),
                Some("127.0.0.1:8080"),
                &policy
            ),
            "{method} {path} must reject a foreign origin"
        );
    }
    assert!(!origin_allowed(
        "POST",
        "/fs/write",
        Some("http://127.0.0.1:9999"),
        Some("127.0.0.1:8080"),
        &policy
    ));
    assert!(!origin_allowed(
        "GET",
        "/ws",
        Some("http://localhost:8080"),
        Some("127.0.0.1:8080"),
        &policy
    ));
    assert!(!origin_allowed(
        "POST",
        "/fs/write",
        Some("null"),
        Some("127.0.0.1:8080"),
        &policy
    ));
    assert!(!origin_allowed(
        "GET",
        "/terminal/ws",
        Some("http://127.0.0.1:8080/path"),
        Some("127.0.0.1:8080"),
        &policy
    ));
    assert!(!origin_allowed(
        "POST",
        "/fs/write",
        Some("http://127.0.0.1:8080"),
        None,
        &policy
    ));
}

#[test]
fn read_only_routes_ignore_a_foreign_origin() {
    let policy = OriginPolicy::default();
    assert!(origin_allowed(
        "GET",
        "/health",
        Some("http://evil.example"),
        Some("127.0.0.1:8080"),
        &policy
    ));
    assert!(origin_allowed(
        "GET",
        "/projects",
        Some("http://evil.example"),
        Some("127.0.0.1:8080"),
        &policy
    ));
    assert!(origin_allowed(
        "HEAD",
        "/fs/read",
        Some("null"),
        Some("127.0.0.1:8080"),
        &policy
    ));
}

#[test]
fn allowlisted_origin_is_accepted_when_host_does_not_match() {
    let policy = policy("https://public.example, https://other.example:8443");
    assert!(origin_allowed(
        "GET",
        "/ws",
        Some("https://public.example"),
        Some("127.0.0.1:8080"),
        &policy
    ));
    assert!(origin_allowed(
        "GET",
        "/terminal/ws",
        Some("https://other.example:8443"),
        Some("127.0.0.1:8080"),
        &policy
    ));
    assert!(origin_allowed(
        "POST",
        "/fs/mkdir",
        Some("HTTPS://Public.Example:443"),
        Some("127.0.0.1:8080"),
        &policy
    ));
    assert!(!origin_allowed(
        "POST",
        "/fs/mkdir",
        Some("http://public.example"),
        Some("127.0.0.1:8080"),
        &policy
    ));
    assert!(!origin_allowed(
        "GET",
        "/ws",
        Some("https://not-listed.example"),
        Some("127.0.0.1:8080"),
        &policy
    ));
}

#[test]
fn parse_list_canonicalizes_and_rejects_bad_entries() {
    let parsed = policy(" https://Example.COM:443 , http://127.0.0.1:8080 ");
    assert!(parsed.contains("https://example.com"));
    assert!(parsed.contains("http://127.0.0.1:8080"));
    assert_eq!(
        parsed.to_string(),
        "http://127.0.0.1:8080, https://example.com"
    );

    assert!(OriginPolicy::parse_list("*").is_err());
    assert!(OriginPolicy::parse_list("").is_err());
    assert!(OriginPolicy::parse_list("null").is_err());
    assert!(OriginPolicy::parse_list("https://example.com/app").is_err());
    assert!(OriginPolicy::parse_list("ftp://example.com").is_err());
}

#[test]
fn repeated_lists_merge() {
    let merged = policy("https://a.example").merge(policy("https://b.example"));
    assert!(merged.contains("https://a.example"));
    assert!(merged.contains("https://b.example"));
}
