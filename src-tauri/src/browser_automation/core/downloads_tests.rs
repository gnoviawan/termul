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
        started: Instant::now(),
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

#[test]
fn a_download_stops_past_the_cap_when_it_stalls_or_at_its_deadline() {
    let held = pending("t1", "https://files.example/big.bin");
    let start = held.started;
    let at = |secs: u64| start + std::time::Duration::from_secs(secs);
    let downloads = Downloads::default();
    assert!(downloads.admit("s1", held));
    let progress = |received: u64, announced: Option<u64>, now: Instant| {
        let size = DownloadSize { received, announced };
        downloads.progress("t1", "https://files.example/big.bin", size, now)
    };
    assert_eq!(progress(0, Some(MAX_DOWNLOAD_BYTES + 1), at(0)), Err("too_large"));
    assert_eq!(progress(MAX_DOWNLOAD_BYTES + 1, None, at(1)), Err("too_large"));
    assert_eq!(progress(0, Some(MAX_DOWNLOAD_BYTES), at(1)), Ok(()), "announced at the cap");
    assert_eq!(progress(10, Some(MAX_DOWNLOAD_BYTES), at(50)), Ok(()));
    assert_eq!(progress(10, Some(MAX_DOWNLOAD_BYTES), at(110)), Ok(()), "60 s since the last new byte");
    assert_eq!(progress(10, Some(MAX_DOWNLOAD_BYTES), at(111)), Err("idle"));
    let total = budgets::DOWNLOAD_TOTAL.as_secs();
    for (n, second) in (112..total).step_by(30).enumerate() {
        assert_eq!(progress(20 + n as u64, None, at(second)), Ok(()), "growing at {second} s");
    }
    assert_eq!(progress(MAX_DOWNLOAD_BYTES, None, at(total + 1)), Err("deadline"));
    let elsewhere = DownloadSize { received: 5, announced: None };
    assert_eq!(
        downloads.progress("t1", "https://files.example/other.bin", elsewhere, at(total + 1)),
        Ok(()),
        "a download the host does not hold meets only the cap"
    );
}
