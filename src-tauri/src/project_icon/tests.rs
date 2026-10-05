//! Sibling unit tests for the project-icon resolver (spec-project-icon).
//! Parser/sniff/square/ICO fixtures + tempdir candidate-ordering tests; the
//! remote chain is exercised via real `git` in a tempdir (guarded by
//! `git_available` like `worktree/tests.rs`) — no live network is hit.

use super::local::{decode_image, href_candidates, resolve_local, Decode};
use super::remote::{fetch_targets, is_refused_host, parse_remote_url, RemoteParse};
use super::{resolve, ProjectIconSource};
use std::path::{Path, PathBuf};

// -------------------------------------------------------------------------
// Byte fixtures — headers carry real dims; body padding keeps them plausible.
// -------------------------------------------------------------------------

fn png_bytes(width: u32, height: u32) -> Vec<u8> {
    let mut b = b"\x89PNG\r\n\x1a\n".to_vec();
    b.extend_from_slice(&13u32.to_be_bytes());
    b.extend_from_slice(b"IHDR");
    b.extend_from_slice(&width.to_be_bytes());
    b.extend_from_slice(&height.to_be_bytes());
    b.extend_from_slice(&[8, 6, 0, 0, 0]);
    b.extend_from_slice(&[0xAA; 32]);
    b
}

fn gif_bytes(width: u16, height: u16) -> Vec<u8> {
    let mut b = b"GIF89a".to_vec();
    b.extend_from_slice(&width.to_le_bytes());
    b.extend_from_slice(&height.to_le_bytes());
    b.extend_from_slice(&[0x80, 0, 0]);
    b
}

fn jpeg_bytes(width: u16, height: u16) -> Vec<u8> {
    let mut b = vec![0xFF, 0xD8];
    // APP0 marker (length 2 = no payload) then SOF0 with dims.
    b.extend_from_slice(&[0xFF, 0xE0, 0x00, 0x02]);
    b.extend_from_slice(&[0xFF, 0xC0]);
    b.extend_from_slice(&11u16.to_be_bytes()); // segment length
    b.push(8); // precision
    b.extend_from_slice(&height.to_be_bytes());
    b.extend_from_slice(&width.to_be_bytes());
    b.push(3); // components
    b.extend_from_slice(&[0xBB; 8]);
    b
}

fn webp_bytes(width: u32, height: u32) -> Vec<u8> {
    let mut b = b"RIFF".to_vec();
    b.extend_from_slice(&0u32.to_le_bytes());
    b.extend_from_slice(b"WEBP");
    b.extend_from_slice(b"VP8X");
    b.extend_from_slice(&10u32.to_le_bytes());
    b.extend_from_slice(&[0; 4]);
    let w = width - 1;
    let h = height - 1;
    b.extend_from_slice(&[w as u8, (w >> 8) as u8, (w >> 16) as u8]);
    b.extend_from_slice(&[h as u8, (h >> 8) as u8, (h >> 16) as u8]);
    b
}

fn ico_bytes(frames: &[(u8, u8, Vec<u8>)]) -> Vec<u8> {
    let mut b = vec![0, 0, 1, 0];
    b.extend_from_slice(&(frames.len() as u16).to_le_bytes());
    let mut offset = 6 + frames.len() * 16;
    for (width, height, data) in frames {
        b.push(*width);
        b.push(*height);
        b.push(0); // palette
        b.push(0); // reserved
        b.extend_from_slice(&1u16.to_le_bytes()); // planes
        b.extend_from_slice(&32u16.to_le_bytes()); // bit depth
        b.extend_from_slice(&(data.len() as u32).to_le_bytes());
        b.extend_from_slice(&(offset as u32).to_le_bytes());
        offset += data.len();
    }
    for (_, _, data) in frames {
        b.extend_from_slice(data);
    }
    b
}

fn svg_bytes() -> Vec<u8> {
    br##"<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#fff"/></svg>"##.to_vec()
}

fn git_available() -> bool {
    std::process::Command::new("git")
        .arg("--version")
        .output()
        .is_ok_and(|out| out.status.success())
}

fn init_repo_with_remote(dir: &Path, remote: Option<&str>) {
    let run = |args: &[&str]| {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?} failed");
    };
    run(&["init", "--quiet"]);
    if let Some(url) = remote {
        run(&["remote", "add", "origin", url]);
    }
}

// -------------------------------------------------------------------------
// decode_image — magic-byte sniff, MIME, square checks, ICO frames
// -------------------------------------------------------------------------

#[test]
fn sniff_square_png_reports_image_png() {
    match decode_image(&png_bytes(64, 64)) {
        Decode::Icon(mime, _) => assert_eq!(mime, "image/png"),
        _ => panic!("square PNG must sniff image/png"),
    }
}

#[test]
fn sniff_non_square_png_is_rejected() {
    assert!(matches!(
        decode_image(&png_bytes(200, 60)),
        Decode::Rejected
    ));
}

#[test]
fn sniff_gif_jpeg_webp_dims() {
    for (bytes, mime) in [
        (gif_bytes(32, 32), "image/gif"),
        (jpeg_bytes(48, 48), "image/jpeg"),
        (webp_bytes(96, 96), "image/webp"),
    ] {
        match decode_image(&bytes) {
            Decode::Icon(m, _) => assert_eq!(m, mime),
            _ => panic!("expected {mime}"),
        }
    }
    assert!(matches!(decode_image(&gif_bytes(32, 64)), Decode::Rejected));
    assert!(matches!(
        decode_image(&jpeg_bytes(48, 32)),
        Decode::Rejected
    ));
    assert!(matches!(
        decode_image(&webp_bytes(96, 24)),
        Decode::Rejected
    ));
}

#[test]
fn sniff_svg_reports_image_svg() {
    match decode_image(&svg_bytes()) {
        Decode::Icon(mime, _) => assert_eq!(mime, "image/svg+xml"),
        _ => panic!("SVG must sniff image/svg+xml"),
    }
}

#[test]
fn sniff_random_bytes_is_unknown() {
    assert!(matches!(
        decode_image(b"PK\x03\x04 zip-ish"),
        Decode::Unknown
    ));
    assert!(matches!(decode_image(b""), Decode::Unknown));
    assert!(matches!(
        decode_image(b"<html><body>not svg</body></html>"),
        Decode::Unknown
    ));
}

#[test]
fn png_bytes_named_ico_still_sniff_png() {
    // A `favicon.ico` file holding PNG bytes must decode as image/png —
    // extension never wins over magic bytes.
    match decode_image(&png_bytes(64, 64)) {
        Decode::Icon(mime, _) => assert_eq!(mime, "image/png"),
        _ => panic!("PNG payload must sniff image/png regardless of name"),
    }
}

#[test]
fn ico_with_square_png_frame_extracts_png() {
    let ico = ico_bytes(&[(64, 64, png_bytes(64, 64))]);
    match decode_image(&ico) {
        Decode::Icon(mime, payload) => {
            assert_eq!(mime, "image/png");
            assert_eq!(payload, png_bytes(64, 64).as_slice());
        }
        _ => panic!("ICO with a square PNG frame must extract it"),
    }
}

#[test]
fn ico_with_square_bmp_frame_keeps_x_icon() {
    // A square non-PNG frame: serve the original .ico bytes.
    let ico = ico_bytes(&[(32, 32, vec![0x28, 0, 0, 0, 1, 2, 3])]);
    match decode_image(&ico) {
        Decode::Icon(mime, _) => assert_eq!(mime, "image/x-icon"),
        _ => panic!("square BMP-frame ICO must sniff image/x-icon"),
    }
}

#[test]
fn ico_with_only_non_square_frames_is_rejected() {
    let ico = ico_bytes(&[(200, 60, vec![0x28, 0, 0, 0]), (48, 16, vec![1, 2])]);
    assert!(matches!(decode_image(&ico), Decode::Rejected));
}

// -------------------------------------------------------------------------
// Local candidate scan — ordering, square continuation, href declarations
// -------------------------------------------------------------------------

#[test]
fn local_scan_prefers_root_favicon_svg_over_png() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("favicon.svg"), svg_bytes()).unwrap();
    std::fs::write(dir.path().join("favicon.png"), png_bytes(64, 64)).unwrap();
    let icon = resolve_local(dir.path()).expect("svg should resolve");
    assert_eq!(icon.mime, "image/svg+xml");
    assert_eq!(icon.source, ProjectIconSource::File);
    assert!(icon.data_uri.starts_with("data:image/svg+xml;base64,"));
}

#[test]
fn local_scan_finds_public_favicon_svg() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("public")).unwrap();
    std::fs::write(dir.path().join("public/favicon.svg"), svg_bytes()).unwrap();
    let icon = resolve_local(dir.path()).expect("public/favicon.svg should resolve");
    assert_eq!(icon.mime, "image/svg+xml");
}

#[test]
fn local_scan_skips_non_square_candidate_and_continues() {
    let dir = tempfile::tempdir().unwrap();
    // Root logo.png is earlier than… nothing else at root; the non-square
    // candidate must be skipped so a later candidate still wins.
    std::fs::write(dir.path().join("logo.png"), png_bytes(200, 60)).unwrap();
    std::fs::create_dir_all(dir.path().join("public")).unwrap();
    std::fs::write(dir.path().join("public/favicon.png"), png_bytes(48, 48)).unwrap();
    let icon = resolve_local(dir.path()).expect("public/favicon.png should win");
    assert_eq!(icon.mime, "image/png");
}

#[test]
fn local_scan_finds_idea_icon() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join(".idea")).unwrap();
    std::fs::write(dir.path().join(".idea/icon.svg"), svg_bytes()).unwrap();
    assert!(resolve_local(dir.path()).is_some());
}

#[test]
fn local_scan_ignores_oversized_candidate() {
    let dir = tempfile::tempdir().unwrap();
    let mut big = svg_bytes();
    big.extend_from_slice(&vec![b' '; 70 * 1024]);
    std::fs::write(dir.path().join("favicon.svg"), big).unwrap();
    assert!(resolve_local(dir.path()).is_none());
}

#[test]
fn local_scan_real_ico_file_decodes() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("favicon.ico"),
        ico_bytes(&[(16, 16, vec![0x28, 0, 0, 0])]),
    )
    .unwrap();
    let icon = resolve_local(dir.path()).expect("ico should resolve");
    assert_eq!(icon.mime, "image/x-icon");
}

#[test]
fn local_scan_resolves_link_rel_icon_html() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("public/branding")).unwrap();
    std::fs::write(
        dir.path().join("public/branding/app.png"),
        png_bytes(48, 48),
    )
    .unwrap();
    std::fs::write(
        dir.path().join("index.html"),
        r#"<html><head><link rel="icon" href="/branding/app.png"></head></html>"#,
    )
    .unwrap();
    let icon = resolve_local(dir.path()).expect("href-declared icon should resolve");
    assert_eq!(icon.mime, "image/png");
}

#[test]
fn local_scan_resolves_tsx_metadata_icon() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("app/routes")).unwrap();
    std::fs::create_dir_all(dir.path().join("public")).unwrap();
    std::fs::write(dir.path().join("public/meta.svg"), svg_bytes()).unwrap();
    std::fs::write(
        dir.path().join("app/routes/__root.tsx"),
        "export const links = () => [{ rel: 'icon', href: '/meta.svg' }]",
    )
    .unwrap();
    let icon = resolve_local(dir.path()).expect("tsx metadata icon should resolve");
    assert_eq!(icon.mime, "image/svg+xml");
}

#[test]
fn local_scan_refuses_off_repo_hrefs() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("index.html"),
        concat!(
            r#"<html><head>"#,
            r#"<link rel="icon" href="https://cdn.example.com/x.png">"#,
            r#"<link rel="icon" href="//cdn.example.com/y.png">"#,
            r#"<link rel="icon" href="../secret.png">"#,
            r#"</head></html>"#
        ),
    )
    .unwrap();
    std::fs::write(dir.path().join("secret.png"), png_bytes(8, 8)).unwrap();
    assert!(resolve_local(dir.path()).is_none());
}

#[test]
fn href_candidates_root_relative_uses_public_first() {
    let root = PathBuf::from("/repo");
    let got = href_candidates(&root, "index.html", "/x.png");
    assert_eq!(
        got,
        vec![root.join("public/x.png"), root.join("x.png")],
        "root-relative href tries public/ then root"
    );
}

#[test]
fn href_candidates_relative_uses_source_dir() {
    let root = PathBuf::from("/repo");
    let got = href_candidates(&root, "app/routes/__root.tsx", "img/i.png");
    assert_eq!(
        got,
        vec![
            root.join("app/routes/img/i.png"),
            root.join("public/img/i.png"),
            root.join("img/i.png")
        ],
        "relative href tries source dir, public/, then root"
    );
}

// -------------------------------------------------------------------------
// Remote URL parsing
// -------------------------------------------------------------------------

fn parsed(url: &str) -> super::remote::ParsedRemote {
    match parse_remote_url(url) {
        RemoteParse::Remote(p) => p,
        _ => panic!("expected remote for {url}"),
    }
}

#[test]
fn parse_https_remote() {
    let p = parsed("https://github.com/acme/widgets.git");
    assert_eq!(p.host, "github.com");
    assert_eq!(p.port, None);
    assert_eq!(p.owner.as_deref(), Some("acme"));
}

#[test]
fn parse_scp_like_remote() {
    let p = parsed("git@github.com:acme/w.git");
    assert_eq!(p.host, "github.com");
    assert_eq!(p.owner.as_deref(), Some("acme"));

    let p = parsed("git@gitlab.corp.example:team/sub/w.git");
    assert_eq!(p.host, "gitlab.corp.example");
    assert_eq!(p.owner.as_deref(), Some("team"));
}

#[test]
fn parse_ssh_url_drops_port_keeps_owner() {
    let p = parsed("ssh://git@gitlab.corp.example:2222/team/w.git");
    assert_eq!(p.host, "gitlab.corp.example");
    assert_eq!(p.port, None, "ssh port is not the https icon port");
    assert_eq!(p.owner.as_deref(), Some("team"));
}

#[test]
fn parse_https_url_keeps_port() {
    let p = parsed("https://gitea.example.com:8443/owner/repo.git");
    assert_eq!(p.host, "gitea.example.com");
    assert_eq!(p.port, Some(8443));
    assert_eq!(p.owner.as_deref(), Some("owner"));
}

#[test]
fn parse_git_plus_ssh_and_git_schemes() {
    let p = parsed("git+ssh://git@github.com/o/r.git");
    assert_eq!(p.host, "github.com");
    let p = parsed("git://github.com/o/r.git");
    assert_eq!(p.host, "github.com");
    assert_eq!(p.owner.as_deref(), Some("o"));
}

#[test]
fn parse_ssh_github_com_normalizes() {
    let p = parsed("git@ssh.github.com:o/r.git");
    assert_eq!(p.host, "github.com");
}

#[test]
fn parse_http_remote_is_refused() {
    assert!(matches!(
        parse_remote_url("http://internal.corp/w.git"),
        RemoteParse::HttpScheme
    ));
}

#[test]
fn parse_local_paths_are_not_remotes() {
    for raw in [
        "/home/user/repo",
        "C:\\Users\\repo",
        "../relative/repo",
        "file:///home/user/repo",
        "",
    ] {
        assert!(
            matches!(parse_remote_url(raw), RemoteParse::NotRemote),
            "{raw} must not parse as a remote"
        );
    }
}

// -------------------------------------------------------------------------
// SSRF host refusal
// -------------------------------------------------------------------------

#[test]
fn refused_hosts_cover_local_and_metadata() {
    for host in [
        "localhost",
        "db.localhost",
        "printer.local",
        "gw.home.arpa",
        "127.0.0.1",
        "0.0.0.0",
        "169.254.169.254",
        "224.0.0.1",
        "255.255.255.255",
        "::1",
        "::",
        "fe80::1",
        "::ffff:169.254.169.254",
    ] {
        assert!(is_refused_host(host), "{host} must be refused");
    }
}

#[test]
fn private_and_public_forge_hosts_are_allowed() {
    // RFC-1918 LAN forges (Gitea/GHES on a home or corp network) must work.
    for host in [
        "github.com",
        "gitlab.corp.example",
        "192.168.1.10",
        "10.0.0.5",
        "172.16.3.4",
        "fd00::1",
    ] {
        assert!(!is_refused_host(host), "{host} must be allowed");
    }
}

// -------------------------------------------------------------------------
// fetch_targets — remote chain through real git (no network)
// -------------------------------------------------------------------------

#[test]
fn github_remote_builds_avatar_then_favicon() {
    if !git_available() {
        eprintln!("skipped: git not available on PATH");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    init_repo_with_remote(dir.path(), Some("git@github.com:acme/w.git"));
    let targets = fetch_targets(dir.path());
    assert_eq!(targets.len(), 2);
    assert_eq!(targets[0].url, "https://github.com/acme.png?size=64");
    assert_eq!(targets[1].url, "https://github.com/favicon.ico");
    assert_eq!(targets[0].allowed_host, "github.com");
}

#[test]
fn non_github_forge_builds_favicon_only() {
    if !git_available() {
        eprintln!("skipped: git not available on PATH");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    init_repo_with_remote(dir.path(), Some("git@gitlab.corp.example:team/w.git"));
    let targets = fetch_targets(dir.path());
    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].url, "https://gitlab.corp.example/favicon.ico");
}

#[test]
fn https_remote_with_port_keeps_port_in_fetch_url() {
    if !git_available() {
        eprintln!("skipped: git not available on PATH");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    init_repo_with_remote(dir.path(), Some("https://gitea.example.com:8443/o/r.git"));
    let targets = fetch_targets(dir.path());
    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].url, "https://gitea.example.com:8443/favicon.ico");
}

#[test]
fn http_remote_yields_no_targets() {
    if !git_available() {
        eprintln!("skipped: git not available on PATH");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    init_repo_with_remote(dir.path(), Some("http://internal.corp/w.git"));
    assert!(fetch_targets(dir.path()).is_empty());
}

#[test]
fn refused_host_remote_yields_no_targets() {
    if !git_available() {
        eprintln!("skipped: git not available on PATH");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    init_repo_with_remote(dir.path(), Some("git@169.254.169.254:o/r.git"));
    assert!(fetch_targets(dir.path()).is_empty());
}

#[test]
fn repo_without_remote_yields_no_targets() {
    if !git_available() {
        eprintln!("skipped: git not available on PATH");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    init_repo_with_remote(dir.path(), None);
    assert!(fetch_targets(dir.path()).is_empty());
}

// -------------------------------------------------------------------------
// resolve() end-to-end — local-first, non-git dir, no-remote, miss
// -------------------------------------------------------------------------

#[tokio::test]
async fn resolve_prefers_local_file_over_remote() {
    if !git_available() {
        eprintln!("skipped: git not available on PATH");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    // A github remote AND a local icon — the local file must win (no fetch).
    init_repo_with_remote(dir.path(), Some("git@github.com:acme/w.git"));
    std::fs::write(dir.path().join("favicon.svg"), svg_bytes()).unwrap();
    let icon = resolve(dir.path().to_path_buf())
        .await
        .expect("local icon wins");
    assert_eq!(icon.source, ProjectIconSource::File);
    assert_eq!(icon.mime, "image/svg+xml");
}

#[tokio::test]
async fn resolve_non_git_dir_with_favicon_ico() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("favicon.ico"),
        ico_bytes(&[(16, 16, png_bytes(16, 16))]),
    )
    .unwrap();
    let icon = resolve(dir.path().to_path_buf())
        .await
        .expect("non-git dir icon resolves via file scan");
    assert_eq!(icon.source, ProjectIconSource::File);
    // ICO with embedded PNG frame → extracted.
    assert_eq!(icon.mime, "image/png");
}

#[tokio::test]
async fn resolve_repo_without_remote_or_files_is_none() {
    if !git_available() {
        eprintln!("skipped: git not available on PATH");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    init_repo_with_remote(dir.path(), None);
    assert!(resolve(dir.path().to_path_buf()).await.is_none());
}

#[tokio::test]
async fn resolve_plain_dir_without_files_is_none() {
    let dir = tempfile::tempdir().unwrap();
    assert!(resolve(dir.path().to_path_buf()).await.is_none());
}

// -------------------------------------------------------------------------
// Wire shape — the renderer contract { dataUri, mime, source }
// -------------------------------------------------------------------------

#[test]
fn project_icon_serializes_camel_case_shape() {
    let icon = super::ProjectIcon {
        data_uri: "data:image/png;base64,AAAA".to_string(),
        mime: "image/png".to_string(),
        source: ProjectIconSource::Remote,
    };
    let json = serde_json::to_value(&icon).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "dataUri": "data:image/png;base64,AAAA",
            "mime": "image/png",
            "source": "remote",
        })
    );
}
