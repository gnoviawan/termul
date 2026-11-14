use std::fs;
use std::io::Write as _;

use super::*;

fn executable_file(path: &std::path::Path, bytes: &[u8]) {
    let mut file = fs::File::create(path).unwrap();
    file.write_all(bytes).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = file.metadata().unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).unwrap();
    }
}

/// Zero is meaningless for the three strictly-positive timeouts and must
/// be rejected at the IPC boundary (the resolvers also filter it
/// defensively). Rejection happens BEFORE the override is stored, so
/// these assertions never mutate the shared override statics.
#[test]
fn zero_overrides_are_rejected_for_strictly_positive_timeouts() {
    assert!(acp_set_turn_idle_timeout(Some(0)).is_err());
    assert!(acp_set_session_new_timeout(Some(0)).is_err());
    assert!(acp_set_session_reopen_timeout(Some(0)).is_err());
    assert!(acp_set_agent_idle_window(Some(0)).is_err());
}

#[test]
fn unsafe_authorization_url_is_refused_with_its_code() {
    let refusal = host_auth_url("javascript:alert(1)").unwrap_err();
    assert!(!refusal.success);
    assert_eq!(refusal.code.as_deref(), Some("MCP_UNSAFE_URL"));
    assert_eq!(
        refusal.error.as_deref(),
        Some("refused an unsafe link: only https links are allowed")
    );
}

#[test]
fn host_opened_authorization_url_allows_https_and_loopback_http() {
    assert_eq!(
        host_auth_url("https://auth.example.com/authorize?state=abc")
            .map(String::from)
            .ok(),
        Some("https://auth.example.com/authorize?state=abc".to_string())
    );
    assert_eq!(
        host_auth_url("http://127.0.0.1:4100/authorize")
            .map(String::from)
            .ok(),
        Some("http://127.0.0.1:4100/authorize".to_string())
    );
}

#[test]
fn a_bare_codex_name_resolves_on_the_project_path() {
    let root = tempfile::tempdir().unwrap();
    let bin = root.path().join("bin");
    fs::create_dir(&bin).unwrap();
    let codex = bin.join("codex");
    executable_file(&codex, b"#!/bin/sh\nexit 0\n");

    let resolved = resolve_codex_probe_program("codex", bin.to_str().unwrap());

    assert_eq!(resolved.program, codex.to_string_lossy());
}

#[test]
fn an_explicit_codex_path_is_not_replaced_by_the_search_path() {
    let root = tempfile::tempdir().unwrap();
    let bin = root.path().join("bin");
    fs::create_dir(&bin).unwrap();
    executable_file(&bin.join("codex"), b"");
    let explicit = root.path().join("real-codex");
    executable_file(&explicit, b"");

    let resolved = resolve_codex_probe_program(explicit.to_str().unwrap(), bin.to_str().unwrap());

    assert_eq!(resolved.program, explicit.to_string_lossy());
}

#[test]
fn the_probe_search_path_keeps_a_project_path() {
    let project = "/opt/project-codex-bin";
    let search = codex_probe_search_path(Some(project));
    let delimiter = if cfg!(windows) { ';' } else { ':' };
    assert!(
        search.split(delimiter).any(|segment| segment == project),
        "{search}"
    );
    assert!(codex_probe_search_path(Some("  "))
        .split(delimiter)
        .all(|segment| segment != "  "));
}
