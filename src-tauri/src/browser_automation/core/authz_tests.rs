use super::*;

fn url(s: &str) -> Url {
    s.parse().unwrap_or_else(|_| panic!("{s} must parse"))
}

fn class_of(s: &str, allow: &[&str]) -> OriginClass {
    let allow: Vec<OriginPattern> = allow
        .iter()
        .map(|p| OriginPattern::parse(p).expect("pattern parses"))
        .collect();
    classify(&url(s), |port| port == 5180 || port == 47_001, &allow)
}

#[test]
fn loopback_dev_ports_are_auto_granted_on_any_port() {
    for target in [
        "http://localhost:3000/app",
        "http://127.0.0.1:8080",
        "http://[::1]:5173",
        "http://127.8.9.10:9000",
        "http://2130706433:4000",
        "http://[::ffff:127.0.0.1]:3001",
        "http://api.localhost:3000",
        "https://localhost",
    ] {
        assert_eq!(class_of(target, &[]), OriginClass::Loopback, "{target}");
    }
}

#[test]
fn termul_owned_ports_and_app_origins_are_denied() {
    let table = [
        (
            "http://localhost:5180/tauri-index.html",
            DenyReason::TermulOwned,
        ),
        ("http://127.0.0.1:47001/mcp", DenyReason::TermulOwned),
        ("http://[::1]:47001", DenyReason::TermulOwned),
        ("http://tauri.localhost", DenyReason::AppOrigin),
        ("https://tauri.localhost/index.html", DenyReason::AppOrigin),
        ("http://ipc.localhost/plugin", DenyReason::AppOrigin),
        ("http://asset.localhost/x.png", DenyReason::AppOrigin),
        ("tauri://localhost", DenyReason::Scheme),
        ("http://0.0.0.0:3000", DenyReason::UnspecifiedAddress),
        ("http://[::]:3000", DenyReason::UnspecifiedAddress),
        (
            "http://169.254.169.254/latest/meta-data",
            DenyReason::MetadataAddress,
        ),
        ("http://[fd00:ec2::254]/", DenyReason::MetadataAddress),
        (
            "http://metadata.google.internal/computeMetadata",
            DenyReason::MetadataAddress,
        ),
        (
            "http://metadata.google.internal./x",
            DenyReason::MetadataAddress,
        ),
        ("http://169.254.10.1", DenyReason::LinkLocal),
        ("http://[fe80::1]/", DenyReason::LinkLocal),
        ("file:///etc/passwd", DenyReason::Scheme),
        ("javascript:alert(1)", DenyReason::Scheme),
        ("data:text/html,hi", DenyReason::Scheme),
    ];
    for (target, reason) in table {
        assert_eq!(
            class_of(target, &[]),
            OriginClass::Denied(reason),
            "{target}"
        );
    }
}

#[test]
fn denied_origins_cannot_be_allow_listed() {
    assert_eq!(
        class_of("http://169.254.169.254", &["http://169.254.169.254"]),
        OriginClass::Denied(DenyReason::MetadataAddress)
    );
    assert_eq!(
        class_of("http://localhost:5180", &["http://localhost:5180"]),
        OriginClass::Denied(DenyReason::TermulOwned)
    );
    assert_eq!(
        class_of("http://metadata.google.internal", &["http://*.google.internal"]),
        OriginClass::Denied(DenyReason::MetadataAddress)
    );
}

#[test]
fn allow_listed_origins_need_no_prompt_and_others_prompt() {
    assert_eq!(
        class_of("https://docs.example.com/a?b=1", &["https://*.example.com"]),
        OriginClass::AllowListed
    );
    assert_eq!(
        class_of("https://example.com", &["https://*.example.com"]),
        OriginClass::Prompt(PromptKind::Unlisted)
    );
    assert_eq!(
        class_of("https://example.org", &[]),
        OriginClass::Prompt(PromptKind::Unlisted)
    );
    for private in [
        "http://192.168.1.20:8080",
        "http://10.0.0.5",
        "http://100.72.1.1",
        "http://[fd12::1]",
    ] {
        assert_eq!(
            class_of(private, &[]),
            OriginClass::Prompt(PromptKind::LocalNetwork),
            "{private}"
        );
    }
    assert_eq!(
        class_of("http://192.168.1.20:8080", &["http://192.168.1.20:8080"]),
        OriginClass::AllowListed
    );
}

#[test]
fn hop_verdict_honours_session_grants() {
    let target = url("https://example.org/path?q=secret");
    let class = classify(&target, |_| false, &[]);
    let origin = CanonicalOrigin::parse("https://example.org").unwrap();
    assert_eq!(
        hop_verdict(&target, class, |_| false),
        HopVerdict::Ungranted(PromptKind::Unlisted, origin.clone())
    );
    assert_eq!(
        hop_verdict(&target, class, |o| *o == origin),
        HopVerdict::Allow
    );
}

#[test]
fn a_redirect_hop_to_an_ungranted_origin_is_not_allowed() {
    let grants = SessionGrants::default();
    grants.grant(
        "s1",
        CanonicalOrigin::parse("https://start.example").unwrap(),
    );
    assert_eq!(
        grants.check_hop("s1", &url("https://start.example/login")),
        HopVerdict::Allow
    );
    assert_eq!(
        grants.check_hop("s1", &url("https://collector.evil/steal?d=1")),
        HopVerdict::Ungranted(
            PromptKind::Unlisted,
            CanonicalOrigin::parse("https://collector.evil").unwrap()
        )
    );
    assert_eq!(
        grants.check_hop("s1", &url("http://169.254.169.254/")),
        HopVerdict::Deny(DenyReason::MetadataAddress)
    );
    assert_eq!(
        grants.check_hop("s1", &url("about:blank")),
        HopVerdict::Allow
    );
    assert_eq!(
        grants.check_hop("other", &url("https://start.example/")),
        HopVerdict::Ungranted(
            PromptKind::Unlisted,
            CanonicalOrigin::parse("https://start.example").unwrap()
        ),
        "grants are per session"
    );
}

#[test]
fn hop_checks_read_the_allow_list_snapshot_and_revocation_clears_grants() {
    let grants = SessionGrants::default();
    grants.set_allow_list(
        "s1",
        vec![OriginPattern::parse("https://*.corp.example").unwrap()],
    );
    assert_eq!(
        grants.check_hop("s1", &url("https://wiki.corp.example/x")),
        HopVerdict::Allow
    );

    let origin = CanonicalOrigin::parse("https://news.example").unwrap();
    grants.grant("s1", origin.clone());
    assert_eq!(
        grants.check_hop("s1", &url("https://news.example/a")),
        HopVerdict::Allow
    );
    grants.revoke_session("s1");
    assert_eq!(
        grants.check_hop("s1", &url("https://news.example/a")),
        HopVerdict::Ungranted(PromptKind::Unlisted, origin)
    );
    assert_eq!(
        grants.check_hop("s1", &url("https://wiki.corp.example/x")),
        HopVerdict::Allow,
        "revocation keeps the project allow-list"
    );
}

#[tokio::test]
async fn the_hop_check_and_policy_edits_read_one_owned_port_registry() {
    use crate::acp::browser_policy::{BrowserPolicyService, CallerScope, UnwiredProfileControl};
    let dir = tempfile::tempdir().unwrap();
    let policy = BrowserPolicyService::new(
        dir.path().to_path_buf(),
        std::sync::Arc::new(crate::host_perimeter::owned_ports),
        Vec::new(),
        std::sync::Arc::new(UnwiredProfileControl),
    );
    let add = |origin: &str| serde_json::json!({ "op": "add_origin", "origin": origin });
    policy
        .apply_project(&CallerScope::App, "p1", 0, &add("http://127.0.0.1:61377"))
        .await
        .expect("an unregistered loopback port can be allow-listed");

    let listener = crate::host_perimeter::OwnedPort::claim(61_378);
    assert_eq!(
        SessionGrants::default().check_hop("s1", &url("http://127.0.0.1:61378/")),
        HopVerdict::Deny(DenyReason::TermulOwned)
    );
    let refusal = policy
        .apply_project(&CallerScope::App, "p1", 1, &add("http://localhost:61378"))
        .await
        .unwrap_err();
    assert_eq!(refusal.reason(), "reserved_origin");

    drop(listener);
    assert_eq!(
        SessionGrants::default().check_hop("s1", &url("http://127.0.0.1:61378/")),
        HopVerdict::Allow,
        "a released port is an ordinary loopback port again"
    );
    policy
        .apply_project(&CallerScope::App, "p1", 1, &add("http://localhost:61378"))
        .await
        .expect("both consumers see the release");
}

#[test]
fn every_metadata_endpoint_the_policy_refuses_is_denied_at_the_hop() {
    for target in [
        "http://100.100.100.200/latest/meta-data",
        "http://168.63.129.16/machine",
        "http://metadata.goog/computeMetadata",
        "http://instance-data/latest",
    ] {
        assert_eq!(
            class_of(target, &[]),
            OriginClass::Denied(DenyReason::MetadataAddress),
            "{target}"
        );
    }
}
