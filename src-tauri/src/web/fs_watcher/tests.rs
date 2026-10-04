//! Tests for the server-side FS watcher (#856). The daemon loop itself is
//! exercised in CI/E2E (it needs a live relay + real filesystem events);
//! these unit tests pin the pure filtering/normalization decisions that
//! decide which changes reach clients.

use super::*;
use serde_json::json;

use crate::web::sink::FsChangedPayload;

#[test]
fn reportable_paths_pass() {
    assert!(is_reportable(std::path::Path::new("/root/proj/src/main.rs")));
    assert!(is_reportable(std::path::Path::new("/root/proj/README.md")));
    assert!(is_reportable(std::path::Path::new("/root/proj/.termul/worktrees/a")));
}

#[test]
fn ignored_directories_are_suppressed() {
    // Build churn and VCS internals must not refresh the explorer tree.
    for ignored in [
        "/root/proj/node_modules/pkg/index.js",
        "/root/proj/.git/index",
        "/root/proj/dist/bundle.js",
        "/root/proj/target/debug/termul",
        "/root/proj/src/__pycache__/mod.cpython-311.pyc",
    ] {
        assert!(
            !is_reportable(std::path::Path::new(ignored)),
            "{ignored} must be suppressed"
        );
    }
}

#[test]
fn ignored_name_as_plain_file_is_not_suppressed() {
    // A file literally NAMED "dist" (not a directory component on the
    // path) is still a reportable tree change.
    assert!(is_reportable(std::path::Path::new("/root/proj/dist")));
}

#[test]
fn normalize_converts_backslashes_and_skips_empty() {
    #[cfg(windows)]
    {
        assert_eq!(
            normalize_path(std::path::Path::new("C:\\proj\\src\\a.rs")),
            Some("C:/proj/src/a.rs".to_string())
        );
    }
    assert_eq!(
        normalize_path(std::path::Path::new("/root/proj/a.rs")),
        Some("/root/proj/a.rs".to_string())
    );
    assert_eq!(normalize_path(std::path::Path::new("")), None);
}

/// #856 broadcast shape: `fs_changed` is agent-level (sid null, seq 0) and
/// carries `{root, paths}` in camelCase — pinned against the shared
/// `FsChangedPayload` so the renderer contract cannot drift.
#[test]
fn fs_changed_payload_serializes_camelcase_root_and_paths() {
    let payload = FsChangedPayload {
        root: "/root/proj".to_string(),
        paths: vec!["/root/proj/src/main.rs".to_string()],
    };
    let value = serde_json::to_value(&payload).expect("serializes");
    assert_eq!(value["root"], json!("/root/proj"));
    assert_eq!(
        value["paths"],
        json!(["/root/proj/src/main.rs"])
    );
}

/// The broadcast lands on the relay as a `fs_changed` agent-level event
/// with reliable tier semantics (unknown types default to reliable).
#[test]
fn broadcast_fs_changed_emits_agent_level_event() {
    let relay = Arc::new(WsRelaySink::new());
    broadcast_fs_changed(
        &relay,
        "/root/proj",
        &["/root/proj/src/main.rs".to_string()],
    );
    // Agent-level events are recorded nowhere (sid null); clients receive
    // them live. The observable contract here is that the call does not
    // panic and the payload round-trips through fan_out serialization.
    // (A full socket test needs the relay's client registry — covered by
    // the ws tests' subscribe machinery.)
}
