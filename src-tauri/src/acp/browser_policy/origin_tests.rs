use super::*;

fn origin(input: &str) -> CanonicalOrigin {
    CanonicalOrigin::parse(input).expect("valid origin")
}

#[test]
fn origins_are_canonicalized() {
    assert_eq!(
        origin("https://Example.COM:443/a/b?q=1#f").as_str(),
        "https://example.com"
    );
    assert_eq!(
        origin("http://example.com:80").as_str(),
        "http://example.com"
    );
    assert_eq!(
        origin("https://example.com:8443").as_str(),
        "https://example.com:8443"
    );
    assert_eq!(
        origin("https://bücher.example").as_str(),
        "https://xn--bcher-kva.example"
    );
    assert_eq!(
        origin("http://2130706433:4000").as_str(),
        "http://127.0.0.1:4000"
    );
    assert_eq!(origin("http://[::1]:3000").as_str(), "http://[::1]:3000");
}

#[test]
fn malformed_origins_are_refused_with_a_specific_error() {
    for (input, expected) in [
        ("", OriginError::Empty),
        ("   ", OriginError::Empty),
        ("example.com", OriginError::Malformed),
        ("https://exa mple.com", OriginError::Malformed),
        ("https://exa\nmple.com", OriginError::Malformed),
        ("ftp://example.com", OriginError::UnsupportedScheme),
        ("file:///etc/passwd", OriginError::UnsupportedScheme),
        ("tauri://localhost", OriginError::UnsupportedScheme),
        ("https://user:pw@example.com", OriginError::Userinfo),
        ("https://user@example.com", OriginError::Userinfo),
    ] {
        assert_eq!(
            CanonicalOrigin::parse(input).unwrap_err(),
            expected,
            "{input}"
        );
    }
}

#[test]
fn wildcards_are_only_a_leading_host_label() {
    for input in [
        "*",
        "*.example.com",
        "https://*",
        "https://*.*.example.com",
        "https://a.*.example.com",
        "https://example.*",
        "*://example.com",
        "https://example.com:*",
    ] {
        assert!(OriginPattern::parse(input).is_err(), "{input}");
    }
    assert_eq!(
        OriginPattern::parse("https://*.example.com")
            .unwrap()
            .to_canonical_string(),
        "https://*.example.com"
    );
}

#[test]
fn wildcards_need_a_registrable_domain() {
    for input in [
        "https://*.com",
        "https://*.localhost",
        "https://*.1.2.3.4",
        "https://*.[::1]",
    ] {
        assert!(OriginPattern::parse(input).is_err(), "{input}");
    }
}

#[test]
fn a_subdomain_pattern_matches_children_but_not_the_parent_or_lookalikes() {
    let pattern = OriginPattern::parse("https://*.example.com").unwrap();
    assert!(pattern.matches(&origin("https://a.example.com")));
    assert!(pattern.matches(&origin("https://a.b.example.com")));
    assert!(!pattern.matches(&origin("https://example.com")));
    assert!(!pattern.matches(&origin("https://badexample.com")));
    assert!(!pattern.matches(&origin("http://a.example.com")));
    assert!(!pattern.matches(&origin("https://a.example.com:8443")));

    let with_port = OriginPattern::parse("https://*.example.com:8443").unwrap();
    assert!(with_port.matches(&origin("https://a.example.com:8443")));
    assert!(!with_port.matches(&origin("https://a.example.com")));
}

#[test]
fn an_exact_pattern_matches_only_its_canonical_origin() {
    let pattern = OriginPattern::parse("https://Example.com:443/login").unwrap();
    assert!(pattern.matches(&origin("https://example.com")));
    assert!(!pattern.matches(&origin("https://a.example.com")));
    assert!(!pattern.matches(&origin("http://example.com")));
}

fn reserved(input: &str, ports: &[u16]) -> Option<ReservedKind> {
    match OriginPattern::parse_allowed(input, ports) {
        Err(OriginError::Reserved(kind)) => Some(kind),
        Ok(_) => None,
        Err(other) => panic!("{input}: unexpected {other:?}"),
    }
}

#[test]
fn app_origins_and_custom_protocol_hosts_are_reserved() {
    for input in [
        "http://tauri.localhost",
        "https://tauri.localhost",
        "https://tauri.localhost:8443",
        "http://ipc.localhost",
        "http://asset.localhost",
        "http://TAURI.localhost.",
    ] {
        assert_eq!(
            reserved(input, &[]),
            Some(ReservedKind::AppOrigin),
            "{input}"
        );
    }
    assert_eq!(
        reserved("https://*.tauri.localhost", &[]),
        Some(ReservedKind::AppOrigin)
    );
}

#[test]
fn unspecified_link_local_and_metadata_addresses_are_reserved() {
    assert_eq!(
        reserved("http://0.0.0.0:3000", &[]),
        Some(ReservedKind::Unspecified)
    );
    assert_eq!(
        reserved("http://[::]:3000", &[]),
        Some(ReservedKind::Unspecified)
    );
    for input in [
        "http://169.254.169.254",
        "http://169.254.1.1:8080",
        "http://[fe80::1]",
        "http://[fd00:ec2::254]",
        "http://100.100.100.200",
        "http://168.63.129.16",
        "http://metadata.google.internal",
        "http://metadata.goog",
        "http://instance-data",
        "http://2852039166",
    ] {
        assert_eq!(
            reserved(input, &[]),
            Some(ReservedKind::Metadata),
            "{input}"
        );
    }
}

#[test]
fn loopback_on_a_termul_port_is_reserved_in_every_spelling() {
    let ports = [4000];
    for input in [
        "http://localhost:4000",
        "http://127.0.0.1:4000",
        "http://127.8.8.8:4000",
        "http://[::1]:4000",
        "http://[::ffff:127.0.0.1]:4000",
        "http://2130706433:4000",
        "http://foo.localhost:4000",
        "http://localhost.:4000",
    ] {
        assert!(reserved(input, &ports).is_some(), "{input}");
    }
    assert_eq!(
        reserved("http://localhost:4000", &ports),
        Some(ReservedKind::TermulPort)
    );
}

#[test]
fn the_default_port_counts_when_termul_listens_on_it() {
    assert_eq!(
        reserved("http://localhost", &[80]),
        Some(ReservedKind::TermulPort)
    );
    assert_eq!(
        reserved("https://localhost", &[443]),
        Some(ReservedKind::TermulPort)
    );
    assert_eq!(reserved("https://localhost", &[80]), None);
}

#[test]
fn other_loopback_ports_and_remote_hosts_can_be_listed() {
    let ports = [4000];
    assert_eq!(reserved("http://localhost:3000", &ports), None);
    assert_eq!(reserved("http://127.0.0.1:5173", &ports), None);
    assert_eq!(reserved("https://example.com:4000", &ports), None);
    assert_eq!(reserved("https://*.example.com", &ports), None);
    assert_eq!(reserved("http://192.168.1.20:4000", &ports), None);
}
