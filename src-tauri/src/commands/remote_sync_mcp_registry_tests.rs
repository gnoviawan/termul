use super::{default_after_sync, sync_mcp_registry_to_project_file};
use crate::web::mcp_servers_api::registry_path;
use crate::web::{ProjectRegistry, ProjectSummary};
use serde_json::json;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_dir(label: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!(
        "termul-mcp-sync-{label}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn registry_with_project(project_root: &Path) -> ProjectRegistry {
    let reg = ProjectRegistry::new();
    let project = ProjectSummary {
        id: "p1".to_string(),
        name: "P".to_string(),
        color: "blue".to_string(),
        path: Some(project_root.to_string_lossy().into_owned()),
        is_archived: false,
        is_default: false,
    };
    reg.set(vec![project], Some("p1".to_string()));
    reg
}

#[tokio::test]
async fn writes_registry_to_project_mcp_servers_file() {
    let dir = temp_dir("write");
    let reg = registry_with_project(&dir);
    let registry = json!([
        {"id":"one","type":"stdio","name":"fs","command":"npx","enabled":true}
    ]);

    let result = sync_mcp_registry_to_project_file(&reg, "p1", registry).await;
    assert!(result.success, "expected success, got {:?}", result.error);

    // The sync must write the exact file the web `GET /mcp-servers` route
    // reads (`{project_root}/.termul/mcp-servers.json`).
    let file = registry_path(&dir);
    let bytes = std::fs::read(&file).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value.as_array().map(Vec::len), Some(1));
    assert_eq!(value[0]["name"], "fs");
    assert_eq!(value[0]["command"], "npx");

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn overwrites_previous_registry_atomically() {
    let dir = temp_dir("overwrite");
    let reg = registry_with_project(&dir);

    // First write — one entry.
    let one = json!([{"id":"a","type":"stdio","name":"a","command":"x","enabled":true}]);
    let r1 = sync_mcp_registry_to_project_file(&reg, "p1", one).await;
    assert!(r1.success, "first write failed: {:?}", r1.error);

    // Second write — two entries. Must fully replace (not append).
    let two = json!([
        {"id":"b","type":"stdio","name":"b","command":"y","enabled":true},
        {"id":"c","type":"stdio","name":"c","command":"z","enabled":false}
    ]);
    let r2 = sync_mcp_registry_to_project_file(&reg, "p1", two).await;
    assert!(r2.success, "second write failed: {:?}", r2.error);

    let file = registry_path(&dir);
    let bytes = std::fs::read(&file).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let entries = value.as_array().unwrap();
    assert_eq!(entries.len(), 2, "registry must be replaced, not appended");
    assert_eq!(entries[0]["id"], "b");
    assert_eq!(entries[1]["id"], "c");

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn rejects_non_array_payload_without_writing() {
    let dir = temp_dir("reject");
    let reg = registry_with_project(&dir);
    let file = registry_path(&dir);
    assert!(!file.exists(), "precondition: no file yet");

    let result = sync_mcp_registry_to_project_file(&reg, "p1", json!({})).await;
    assert!(!result.success);
    assert_eq!(result.code.as_deref(), Some("MCP_REGISTRY_INVALID"));
    assert!(!file.exists(), "non-array must not write a file");

    let _ = std::fs::remove_dir_all(&dir);
}

/// Unknown, archived and pathless projects are refused `NOT_FOUND`; nothing is
/// written anywhere (no default or home-directory fallback exists any more).
#[tokio::test]
async fn refuses_unknown_archived_and_pathless_projects_without_writing() {
    let dir = temp_dir("refused");
    let reg = registry_with_project(&dir);
    let archived_dir = temp_dir("refused-archived");
    reg.upsert(summary("old", Some(&archived_dir.to_string_lossy()), true, false));
    reg.upsert(summary("nopath", None, false, false));
    let payload = json!([{"id":"x","type":"stdio","name":"x","command":"n","enabled":true}]);

    for project_id in ["missing", "old", "nopath", ""] {
        let result = sync_mcp_registry_to_project_file(&reg, project_id, payload.clone()).await;
        assert!(!result.success, "project '{project_id}' must be refused");
        assert_eq!(result.code.as_deref(), Some("NOT_FOUND"), "project '{project_id}'");
    }
    assert!(!registry_path(&dir).exists());
    assert!(!registry_path(&archived_dir).exists());

    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&archived_dir);
}

/// The named project's file is the only one written: a second registered project
/// (even the default) is untouched.
#[tokio::test]
async fn writes_only_the_named_projects_file() {
    let named = temp_dir("named");
    let other = temp_dir("other");
    let reg = registry_with_project(&other);
    reg.upsert(summary("p2", Some(&named.to_string_lossy()), false, false));
    let payload = json!([{"id":"n","type":"stdio","name":"n","command":"n","enabled":true}]);

    let result = sync_mcp_registry_to_project_file(&reg, "p2", payload).await;
    assert!(result.success, "expected success, got {:?}", result.error);

    assert!(registry_path(&named).exists());
    assert!(!registry_path(&other).exists(), "the default project's file must not be written");

    let _ = std::fs::remove_dir_all(&named);
    let _ = std::fs::remove_dir_all(&other);
}

fn summary(id: &str, path: Option<&str>, archived: bool, default: bool) -> ProjectSummary {
    ProjectSummary {
        id: id.to_string(),
        name: id.to_string(),
        color: "blue".to_string(),
        path: path.map(str::to_string),
        is_archived: archived,
        is_default: default,
    }
}

/// A project-list sync never moves the host default while it is still
/// switchable: the registry's current default wins (so a web-set default is
/// not reverted by the desktop's stale stored flag), then the stored
/// `is_default` flag, then the first switchable project.
#[test]
fn sync_default_keeps_current_then_stored_flag_then_first_switchable() {
    let list = vec![
        summary("a", Some("/a"), false, false),
        summary("b", Some("/b"), false, true),
        summary("c", Some("/c"), false, false),
    ];
    // The registry default (set elsewhere) beats the stored flag.
    assert_eq!(default_after_sync(&list, Some("a")).as_deref(), Some("a"));
    // No current default: the stored flag decides.
    assert_eq!(default_after_sync(&list, None).as_deref(), Some("b"));
    // A current default that vanished falls back to the flag.
    assert_eq!(default_after_sync(&list, Some("gone")).as_deref(), Some("b"));

    let unflagged = vec![
        summary("a", Some("/a"), false, false),
        summary("c", Some("/c"), false, false),
    ];
    assert_eq!(default_after_sync(&unflagged, Some("c")).as_deref(), Some("c"));
    assert_eq!(default_after_sync(&unflagged, Some("gone")).as_deref(), Some("a"));

    let unswitchable = vec![
        summary("arch", Some("/x"), true, true),
        summary("nopath", None, false, false),
        summary("blank", Some("  "), false, false),
    ];
    assert_eq!(default_after_sync(&unswitchable, Some("arch")), None);
    assert_eq!(default_after_sync(&[], None), None);
}

/// The sync derives the default under the registry lock: a `set_default_project`
/// that starts while the derivation is running waits for it, so it lands AFTER
/// the sync and is never overwritten by a default derived from a stale read.
#[test]
fn sync_derives_the_default_under_the_registry_lock() {
    use std::sync::{mpsc, Arc};
    let reg = Arc::new(ProjectRegistry::new());
    let list = || {
        vec![
            summary("a", Some("/a"), false, true),
            summary("b", Some("/b"), false, false),
        ]
    };
    assert_eq!(reg.set_with_default_from(list(), default_after_sync).as_deref(), Some("a"));

    let (entered_tx, entered_rx) = mpsc::channel();
    let setter = {
        let reg = Arc::clone(&reg);
        std::thread::spawn(move || {
            entered_rx.recv().expect("derivation started");
            // Starts while the sync still holds the registry lock.
            reg.set_default_project("b")
        })
    };
    let derived = reg.set_with_default_from(list(), |projects, current| {
        entered_tx.send(()).expect("signal the setter");
        std::thread::sleep(std::time::Duration::from_millis(150));
        default_after_sync(projects, current)
    });
    assert_eq!(derived.as_deref(), Some("a"), "the sync derived from the default it saw");
    assert!(setter.join().expect("setter thread"), "the explicit default was accepted");

    // The explicit default landed after the sync and survives.
    let snap = reg.snapshot();
    assert_eq!(snap.default_project_id.as_deref(), Some("b"));
    assert!(snap.projects.iter().find(|p| p.id == "b").is_some_and(|p| p.is_default));
}
