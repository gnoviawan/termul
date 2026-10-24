use super::*;

fn url(s: &str) -> Url {
    s.parse().unwrap()
}

#[test]
fn host_names_keep_only_a_short_alphanumeric_extension() {
    let at = url("https://files.example/get?id=1");
    let name = host_file_name(Path::new("/dl/Invoice March.PDF"), &at);
    assert!(name.ends_with(".pdf"), "{name}");
    assert!(
        Uuid::parse_str(name.trim_end_matches(".pdf")).is_ok(),
        "{name}"
    );

    let from_url = host_file_name(
        Path::new(""),
        &url("https://files.example/a/archive.tar.gz"),
    );
    assert!(from_url.ends_with(".gz"), "{from_url}");
    for hostile in ["x.exe ", "x.pdf;rm", "x.verylongextension", "x.", "noext"] {
        let name = host_file_name(Path::new(hostile), &url("https://files.example/"));
        assert!(Uuid::parse_str(&name).is_ok(), "{hostile} gave {name}");
    }
}

#[test]
fn the_download_origin_is_the_url_the_blob_creator_or_the_tab() {
    let tab = "https://app.example/page";
    let origin = |u: &str| download_origin(&url(u), tab).map(|o| o.as_str().to_string());
    assert_eq!(
        origin("https://files.example/a.zip").as_deref(),
        Some("https://files.example")
    );
    assert_eq!(
        origin("blob:https://app.example/7d3c1c2e-0000-4000-8000-000000000000").as_deref(),
        Some("https://app.example")
    );
    assert_eq!(
        origin("data:text/plain,hello").as_deref(),
        Some("https://app.example")
    );
    assert_eq!(origin("file:///etc/passwd"), None);
    assert_eq!(origin("ftp://files.example/a"), None);
}

fn pending(tab: &str, url: &str) -> Pending {
    Pending {
        tab: tab.into(),
        url: url.into(),
        path: PathBuf::from("/x"),
        origin: CanonicalOrigin::parse("https://files.example").unwrap(),
        profile: TabProfile::Global,
    }
}

#[test]
fn a_session_starts_at_most_its_quota_and_finishes_match_tab_and_url() {
    let downloads = Downloads::default();
    for _ in 0..MAX_DOWNLOADS_PER_SESSION {
        assert!(downloads.admit("s1", pending("agent-a", "https://files.example/1")));
    }
    assert!(!downloads.admit("s1", pending("agent-a", "https://files.example/1")));
    assert!(downloads.admit("s2", pending("agent-b", "https://files.example/2")));

    assert!(downloads
        .take("agent-a", "https://files.example/2")
        .is_none());
    let (session, taken) = downloads
        .take("agent-b", "https://files.example/2")
        .unwrap();
    assert_eq!((session.as_str(), taken.tab.as_str()), ("s2", "agent-b"));
    assert!(downloads
        .take("agent-b", "https://files.example/2")
        .is_none());

    downloads.forget("s1");
    assert!(downloads.admit("s1", pending("agent-a", "https://files.example/1")));
}
