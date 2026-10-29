#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::*;

fn verdict(raw: &str, opener: Opener) -> Result<String, UnsafeUrl> {
    check_safe_url(raw, opener).map(String::from)
}

#[test]
fn https_is_allowed_for_every_opener() {
    for opener in [Opener::Host, Opener::Remote] {
        assert_eq!(
            verdict("https://auth.example.com/authorize?state=abc#x", opener),
            Ok("https://auth.example.com/authorize?state=abc#x".to_string())
        );
    }
}

#[test]
fn scheme_case_is_normalized_before_the_check() {
    assert_eq!(
        verdict("HTTPS://Auth.Example.com/a", Opener::Remote),
        Ok("https://auth.example.com/a".to_string())
    );
    assert_eq!(
        verdict("JAVASCRIPT:alert(1)", Opener::Host),
        Err(UnsafeUrl::SchemeNotAllowed)
    );
}

#[test]
fn loopback_http_is_allowed_only_when_the_host_opens_it() {
    let cases = [
        ("http://127.0.0.1:4100/cb", "http://127.0.0.1:4100/cb"),
        ("http://[::1]:4100/cb", "http://[::1]:4100/cb"),
        ("http://localhost:4100/cb", "http://localhost:4100/cb"),
        ("http://LOCALHOST/cb", "http://localhost/cb"),
    ];
    for (raw, opened) in cases {
        assert_eq!(verdict(raw, Opener::Host), Ok(opened.to_string()), "{raw}");
        assert_eq!(
            verdict(raw, Opener::Remote),
            Err(UnsafeUrl::LoopbackForRemote),
            "{raw}"
        );
    }
}

#[test]
fn http_to_a_non_loopback_host_is_refused() {
    let cases = [
        "http://auth.example.com/authorize",
        "http://10.0.0.5/authorize",
        "http://localhost.evil.example/authorize",
        "http://[::ffff:127.0.0.1]/authorize",
    ];
    for raw in cases {
        for opener in [Opener::Host, Opener::Remote] {
            assert_eq!(
                verdict(raw, opener),
                Err(UnsafeUrl::HttpNotLoopback),
                "{raw}"
            );
        }
    }
}

#[test]
fn other_schemes_are_refused() {
    let cases = [
        "javascript:alert(document.cookie)",
        "file:///C:/Windows/System32/calc.exe",
        "data:text/html,<script>alert(1)</script>",
        "vbscript:msgbox(1)",
        "foo:bar",
        "ms-msdt:/id",
        "ftp://example.com/x",
    ];
    for raw in cases {
        for opener in [Opener::Host, Opener::Remote] {
            assert_eq!(
                verdict(raw, opener),
                Err(UnsafeUrl::SchemeNotAllowed),
                "{raw}"
            );
        }
    }
}

#[test]
fn input_the_parser_would_clean_into_an_allowed_link_is_refused() {
    let cases = [
        (" https://auth.example.com/", "https://auth.example.com/"),
        (
            "\u{0}https://auth.example.com/",
            "https://auth.example.com/",
        ),
        ("https://auth.example.com/\n", "https://auth.example.com/"),
        ("https://auth.exam\tple.com/", "https://auth.example.com/"),
        ("http://local\thost/cb", "http://localhost/cb"),
        ("http://127.0.0.1\n/cb", "http://127.0.0.1/cb"),
    ];
    for (raw, cleaned) in cases {
        assert_eq!(
            url::Url::parse(raw).ok().map(String::from).as_deref(),
            Some(cleaned),
            "{raw:?}"
        );
        assert_eq!(
            verdict(raw, Opener::Host),
            Err(UnsafeUrl::ControlOrWhitespace),
            "{raw:?}"
        );
    }
}

#[test]
fn unparseable_input_is_refused() {
    for raw in ["", "not-a-url", "https://", "//auth.example.com/a"] {
        assert_eq!(
            verdict(raw, Opener::Host),
            Err(UnsafeUrl::Unparseable),
            "{raw:?}"
        );
    }
}

#[test]
fn the_refusal_message_never_contains_the_link() {
    let refused = check_safe_url(
        "http://evil.example/authorize?token=s3cret#frag",
        Opener::Host,
    )
    .unwrap_err();
    assert_eq!(
        refused.to_string(),
        "refused an unsafe link: http is allowed only for loopback addresses"
    );
}
