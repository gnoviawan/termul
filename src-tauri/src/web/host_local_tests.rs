#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::host_local::*;
use crate::web::auth::{WebAuth, WebAuthToken};

#[test]
fn issue_writes_an_owner_only_credential_the_gate_accepts() {
    let dir = tempfile::tempdir().unwrap();
    let (credential, path) = issue(dir.path()).unwrap();
    assert_eq!(path, dir.path().join(HOST_LOCAL_TOKEN_FILE));
    let on_disk = std::fs::read_to_string(&path).unwrap();
    assert_eq!(on_disk.trim(), credential.as_str());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "credential file must be 0600, got {mode:o}");
    }
    let gate = WebAuth::new(WebAuthToken::new("bearer").unwrap());
    assert!(!gate.accepts_host_local(on_disk.trim()), "no credential installed yet");
    gate.set_host_local_credential(credential);
    assert!(gate.accepts_host_local(on_disk.trim()));
    assert!(!gate.accepts_host_local(""));
    assert!(!gate.accepts_host_local("bearer"), "the bearer token is not the credential");
}

#[test]
fn each_boot_replaces_the_previous_credential() {
    let dir = tempfile::tempdir().unwrap();
    let (first, path) = issue(dir.path()).unwrap();
    let (second, _) = issue(dir.path()).unwrap();
    assert_ne!(first.as_str(), second.as_str());
    assert_eq!(std::fs::read_to_string(&path).unwrap().trim(), second.as_str());
    let leftovers: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(leftovers, vec![HOST_LOCAL_TOKEN_FILE.to_string()]);
}
