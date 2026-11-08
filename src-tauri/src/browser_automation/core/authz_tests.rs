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
        hop_verdict(&target, class, true, |_| false),
        HopVerdict::Ungranted(PromptKind::Unlisted, origin.clone())
    );
    assert_eq!(
        hop_verdict(&target, class, true, |o| *o == origin),
        HopVerdict::Allow
    );
}

#[test]
fn with_the_site_prompt_off_promptable_origins_open_without_a_grant() {
    for target in ["https://new.example/", "http://192.168.1.1/"] {
        let target = url(target);
        let class = classify(&target, |_| false, &[]);
        assert!(matches!(class, OriginClass::Prompt(_)), "the class stays promptable");
        assert_eq!(hop_verdict(&target, class, false, |_| false), HopVerdict::Allow);
    }
    for (target, reason) in [
        ("http://169.254.169.254/", DenyReason::MetadataAddress),
        ("http://0.0.0.0/", DenyReason::UnspecifiedAddress),
        ("http://tauri.localhost/", DenyReason::AppOrigin),
        ("ftp://example.org/", DenyReason::Scheme),
    ] {
        let target = url(target);
        let class = classify(&target, |_| false, &[]);
        assert_eq!(
            hop_verdict(&target, class, false, |_| false),
            HopVerdict::Deny(reason),
            "hard denies stay hard with the prompt off"
        );
    }
}

#[test]
fn the_session_snapshot_decides_whether_new_sites_ask() {
    let grants = SessionGrants::default();
    assert!(
        matches!(grants.check_hop("s1", &url("https://new.example/")), HopVerdict::Ungranted(..)),
        "a session with no snapshot asks"
    );
    grants.set_policy("s1", 0, Vec::new(), false);
    assert_eq!(grants.check_hop("s1", &url("https://new.example/")), HopVerdict::Allow);
    assert_eq!(grants.check_hop("s1", &url("http://192.168.1.1/")), HopVerdict::Allow);
    assert!(grants.opened_unasked("s1", &url("https://new.example/")));
    assert!(!grants.opened_unasked("s1", &url("http://localhost:3000/")), "loopback is vouched");
    assert_eq!(
        grants.class_of("s1", &url("https://new.example/")),
        OriginClass::Prompt(PromptKind::Unlisted),
        "opened unasked is not allow-listed"
    );
    assert_eq!(
        grants.check_hop("s1", &url("http://127.0.0.1:61379/")),
        HopVerdict::Allow
    );
    grants.set_policy("s1", 0, Vec::new(), true);
    assert!(
        matches!(grants.check_hop("s1", &url("https://new.example/")), HopVerdict::Ungranted(..)),
        "turning the switch on asks again"
    );
    assert!(!grants.opened_unasked("s1", &url("https://new.example/")));
}

#[test]
fn a_linked_file_is_granted_only_while_its_source_is_held() {
    let grants = SessionGrants::default();
    let source = url("file:///C:/proj/index.html");
    let target = url("file:///C:/proj/about.html");
    let root = std::path::Path::new("C:/proj");
    assert!(!grants.grant_file_if_held("s1", &source, &target, root), "no session, no grant");
    grants.grant_file("s1", &source, root);
    assert!(grants.grant_file_if_held("s1", &source, &target, root));
    assert_eq!(grants.check_hop("s1", &target), HopVerdict::Allow);
    grants.revoke_session("s1");
    let next = url("file:///C:/proj/next.html");
    assert!(!grants.grant_file_if_held("s1", &target, &next, root), "a revoked source grants nothing");
    assert_eq!(grants.check_hop("s1", &next), HopVerdict::Deny(DenyReason::FileNotGranted));
}

/// An "allow once" file lasts while a tab stays on it.
#[test]
fn an_allow_once_file_ends_when_its_tab_leaves_it() {
    let grants = SessionGrants::default();
    let file = url("file:///C:/notes/a.html");
    let root = std::path::Path::new("C:/notes/a.html");
    grants.grant_file_once("s1", &file, root);
    assert_eq!(grants.tab_moved("s1", "tab-1", Some(&url("file:///C:/notes/a.html#part"))), 0, "the approved load lands");
    assert_eq!(grants.tab_moved("s1", "tab-1", Some(&url("file:///C:/notes/a.html?again"))), 0, "the same file again");
    assert_eq!(grants.check_hop("s1", &file), HopVerdict::Allow, "usable while the tab stays");
    assert_eq!(grants.tab_moved("s1", "tab-2", Some(&url("https://example.com/"))), 0, "another tab changes nothing");
    assert_eq!(grants.tab_moved("s1", "tab-1", Some(&url("https://example.com/"))), 1);
    assert_eq!(grants.check_hop("s1", &file), HopVerdict::Deny(DenyReason::FileNotGranted));

    grants.grant_file_once("s1", &file, root);
    grants.tab_moved("s1", "tab-3", Some(&file));
    assert_eq!(grants.tab_moved("s1", "tab-3", None), 1, "closing the tab ends it too");

    grants.grant_file_once("s1", &file, root);
    grants.revoke_file("s1", &file);
    assert_eq!(grants.check_hop("s1", &file), HopVerdict::Deny(DenyReason::FileNotGranted));
}

fn once(grants: &SessionGrants, file: &Url) {
    grants.grant_file_once("s1", file, std::path::Path::new("C:/notes/a.html"));
}

#[test]
fn a_tab_closed_before_its_load_committed_ends_the_grant() {
    let grants = SessionGrants::default();
    let file = url("file:///C:/notes/a.html");
    once(&grants, &file);
    grants.file_load_dispatched("s1", "tab-1", &file);
    assert_eq!(grants.tab_moved("s1", "tab-1", None), 1);
    assert_eq!(grants.check_hop("s1", &file), HopVerdict::Deny(DenyReason::FileNotGranted));
}

#[test]
fn a_failed_load_ends_the_grant() {
    let grants = SessionGrants::default();
    let file = url("file:///C:/notes/a.html");
    once(&grants, &file);
    grants.file_load_dispatched("s1", "tab-1", &file);
    assert!(grants.file_load_failed("s1", Some("tab-1"), &file));
    assert_eq!(grants.check_hop("s1", &file), HopVerdict::Deny(DenyReason::FileNotGranted));

    once(&grants, &file);
    assert!(grants.file_load_failed("s1", None, &file), "a load that never reached a tab ends it too");
}

#[test]
fn a_failed_load_in_one_tab_keeps_a_grant_another_tab_holds() {
    let grants = SessionGrants::default();
    let file = url("file:///C:/notes/a.html");
    once(&grants, &file);
    grants.file_load_dispatched("s1", "tab-1", &file);
    grants.tab_moved("s1", "tab-1", Some(&file));
    grants.file_load_dispatched("s1", "tab-2", &file);
    assert!(!grants.file_load_failed("s1", Some("tab-2"), &file));
    assert_eq!(grants.check_hop("s1", &file), HopVerdict::Allow);
}

#[test]
fn two_tabs_on_one_file_keep_it_until_both_leave() {
    let grants = SessionGrants::default();
    let file = url("file:///C:/notes/a.html");
    once(&grants, &file);
    for tab in ["tab-1", "tab-2"] {
        grants.file_load_dispatched("s1", tab, &file);
        grants.tab_moved("s1", tab, Some(&file));
    }
    assert_eq!(grants.tab_moved("s1", "tab-1", Some(&url("https://example.com/"))), 0);
    assert_eq!(grants.check_hop("s1", &file), HopVerdict::Allow, "the other tab still shows it");
    assert_eq!(grants.tab_moved("s1", "tab-2", None), 1);
    assert_eq!(grants.check_hop("s1", &file), HopVerdict::Deny(DenyReason::FileNotGranted));
}

/// A second tab that reached the granted file by a link holds it too.
#[test]
fn a_tab_that_reached_the_file_by_a_link_holds_it() {
    let grants = SessionGrants::default();
    let file = url("file:///C:/notes/a.html");
    once(&grants, &file);
    grants.file_load_dispatched("s1", "tab-1", &file);
    grants.tab_moved("s1", "tab-1", Some(&file));
    grants.tab_moved("s1", "tab-2", Some(&url("file:///C:/notes/a.html#more")));
    assert_eq!(grants.tab_moved("s1", "tab-1", Some(&url("https://example.com/"))), 0);
    assert_eq!(grants.check_hop("s1", &file), HopVerdict::Allow);
    assert_eq!(grants.tab_moved("s1", "tab-2", Some(&url("https://example.com/"))), 1);
}

#[test]
fn a_denied_prompt_or_a_revoke_ends_the_grant_whoever_holds_it() {
    let grants = SessionGrants::default();
    let file = url("file:///C:/notes/a.html");
    once(&grants, &file);
    grants.tab_moved("s1", "tab-1", Some(&file));
    grants.revoke_file("s1", &file);
    assert_eq!(grants.check_hop("s1", &file), HopVerdict::Deny(DenyReason::FileNotGranted));

    once(&grants, &file);
    grants.tab_moved("s1", "tab-1", Some(&file));
    grants.revoke_session("s1");
    assert_eq!(grants.check_hop("s1", &file), HopVerdict::Deny(DenyReason::FileNotGranted));
    assert_eq!(grants.tab_moved("s1", "tab-1", None), 0, "nothing left to end");
}

/// A project file's grant is not an "allow once": leaving it keeps it.
#[test]
fn a_project_file_grant_survives_its_tab_leaving() {
    let grants = SessionGrants::default();
    let file = url("file:///C:/proj/index.html");
    grants.grant_file("s1", &file, std::path::Path::new("C:/proj"));
    grants.tab_moved("s1", "tab-1", Some(&file));
    assert_eq!(grants.tab_moved("s1", "tab-1", Some(&url("https://example.com/"))), 0);
    assert_eq!(grants.check_hop("s1", &file), HopVerdict::Allow);
}

/// A call that read the policy before a refresh cannot write its older
/// snapshot back over the refresh.
#[test]
fn an_older_policy_snapshot_never_replaces_a_newer_one() {
    let grants = SessionGrants::default();
    grants.set_policy("s1", 0, Vec::new(), false);
    grants.refresh_policy("s1", 1, Vec::new(), true);
    grants.set_policy("s1", 0, Vec::new(), false);
    assert!(
        matches!(grants.check_hop("s1", &url("https://new.example/")), HopVerdict::Ungranted(..)),
        "the refresh's switch holds"
    );
    grants.set_policy("s1", 1, Vec::new(), false);
    assert_eq!(grants.check_hop("s1", &url("https://new.example/")), HopVerdict::Allow, "a current read lands");
    grants.refresh_policy("gone", 2, Vec::new(), true);
    assert!(!grants.session_ids().contains(&"gone".to_string()), "a refresh creates no session");
}

#[test]
fn file_urls_pass_only_on_an_exact_grant() {
    let grants = SessionGrants::default();
    grants.set_policy("s1", 0, Vec::new(), false);
    let page = url("file:///C:/proj/dist/index.html");
    assert_eq!(
        grants.check_hop("s1", &page),
        HopVerdict::Deny(DenyReason::FileNotGranted),
        "no prompt-free pass for files"
    );
    grants.grant_file("s1", &page, std::path::Path::new("C:/proj"));
    assert_eq!(grants.check_hop("s1", &page), HopVerdict::Allow);
    assert_eq!(
        grants.check_hop("s1", &url("file:///C:/proj/dist/index.html?x=1#top")),
        HopVerdict::Allow,
        "query and fragment are not part of the grant"
    );
    for other in [
        "file:///C:/proj/dist/other.html",
        "file:///C:/proj/dist/",
        "file:///C:/Users/me/.ssh/id_rsa",
        "file://server/share/dist/index.html",
    ] {
        assert_eq!(
            grants.check_hop("s1", &url(other)),
            HopVerdict::Deny(DenyReason::FileNotGranted),
            "{other}: grants are per exact file"
        );
    }
    assert_eq!(
        grants.check_hop("s2", &page),
        HopVerdict::Deny(DenyReason::FileNotGranted),
        "file grants are per session"
    );
    assert_eq!(
        grants.file_read_access("s1", &page),
        Some(std::path::PathBuf::from("C:/proj"))
    );
    grants.revoke_session("s1");
    assert_eq!(grants.check_hop("s1", &page), HopVerdict::Deny(DenyReason::FileNotGranted));
    assert_eq!(grants.file_read_access("s1", &page), None);
}

#[test]
fn a_unc_file_url_has_no_grant_key() {
    assert_eq!(file_key(&url("file://server/share/x.html")), None);
    assert_eq!(file_key(&url("https://example.org/")), None);
    assert_eq!(
        file_key(&url("file:///tmp/a.html#frag")),
        file_key(&url("file:///tmp/a.html?x=1")),
        "query and fragment are not part of the key"
    );
}

/// The engine, a page link and the host's own real-path URL may spell one
/// file differently: percent-encoded or not, upper- or lowercase hex, and
/// the drive letter in either case.
#[test]
fn one_file_has_one_grant_key_however_its_url_is_spelled() {
    let grants = SessionGrants::default();
    let granted = url("file:///C:/proj/my%20dir/caf%C3%A9.html");
    grants.grant_file("s1", &granted, std::path::Path::new("C:/proj"));
    let mut spellings = vec![
        "file:///C:/proj/my dir/café.html",
        "file:///C:/proj/my%20dir/caf%c3%a9.html",
        "file:///C:/proj/my dir/café.html#top",
    ];
    if WINDOWS {
        spellings.extend(["file:///c:/proj/my%20dir/caf%C3%A9.html", "file:///c:/proj/my dir/café.html#top"]);
    }
    for spelling in spellings {
        assert_eq!(grants.check_hop("s1", &url(spelling)), HopVerdict::Allow, "{spelling}");
        assert!(grants.file_read_access("s1", &url(spelling)).is_some(), "{spelling}");
    }
    assert_eq!(
        grants.check_hop("s1", &url("file:///C:/proj/my%20dir/cafe.html")),
        HopVerdict::Deny(DenyReason::FileNotGranted),
        "another file is another key"
    );
}

/// Whether this host's paths are Windows paths (the core keeps no
/// platform cfgs).
const WINDOWS: bool = std::path::MAIN_SEPARATOR == '\\';

/// Drive letters ignore case on Windows only; elsewhere `/C:` and `/c:`
/// are two different folders.
#[test]
fn a_lowercase_drive_letter_grant_meets_an_uppercase_url() {
    let grants = SessionGrants::default();
    grants.grant_file("s1", &url("file:///c:/proj/index.html"), std::path::Path::new("c:/proj"));
    let verdict = grants.check_hop("s1", &url("file:///C:/proj/index.html"));
    if WINDOWS {
        assert_eq!(verdict, HopVerdict::Allow);
    } else {
        assert_eq!(verdict, HopVerdict::Deny(DenyReason::FileNotGranted));
    }
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
    grants.set_policy(
        "s1",
        0,
        vec![OriginPattern::parse("https://*.corp.example").unwrap()],
        true,
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
