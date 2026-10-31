use super::*;

fn parsed(url: &str) -> ParsedRemote {
    parse_remote_url(url).unwrap_or_else(|| panic!("expected remote for {url}"))
}

#[test]
fn parse_https_remote() {
    assert_eq!(
        parsed("https://github.com/acme/widgets.git"),
        ParsedRemote {
            host: "github.com".to_string(),
            port: None,
            owner: Some("acme".to_string()),
            name: Some("widgets".to_string()),
            insecure_http: false,
        }
    );
}

#[test]
fn parse_scp_like_remote() {
    let p = parsed("git@github.com:acme/w.git");
    assert_eq!(p.host, "github.com");
    assert_eq!(p.owner.as_deref(), Some("acme"));
    assert_eq!(p.name.as_deref(), Some("w"));

    let p = parsed("git@gitlab.corp.example:team/sub/w.git");
    assert_eq!(p.host, "gitlab.corp.example");
    assert_eq!(p.owner.as_deref(), Some("team"));
    assert_eq!(p.name, None, "a subgroup path is not owner/name");
}

#[test]
fn parse_ssh_url_drops_port_keeps_owner() {
    let p = parsed("ssh://git@gitlab.corp.example:2222/team/w.git");
    assert_eq!(p.host, "gitlab.corp.example");
    assert_eq!(p.port, None, "ssh port is not the https icon port");
    assert_eq!(p.owner.as_deref(), Some("team"));
    assert_eq!(p.name.as_deref(), Some("w"));
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
    assert_eq!(p.name.as_deref(), Some("r"));
}

#[test]
fn parse_ssh_github_com_normalizes() {
    let p = parsed("git@ssh.github.com:o/r.git");
    assert_eq!(p.host, "github.com");
}

#[test]
fn parse_http_remote_is_flagged_insecure() {
    let p = parsed("http://internal.corp/o/w.git");
    assert_eq!(p.host, "internal.corp");
    assert!(p.insecure_http);
}

#[test]
fn parse_credentials_never_reach_parsed_fields() {
    let p = parsed("https://user:ghp_secret@github.com/o/r.git");
    assert_eq!(
        (p.host.as_str(), p.owner.as_deref(), p.name.as_deref()),
        ("github.com", Some("o"), Some("r"))
    );
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
        assert_eq!(
            parse_remote_url(raw),
            None,
            "{raw} must not parse as a remote"
        );
    }
}
