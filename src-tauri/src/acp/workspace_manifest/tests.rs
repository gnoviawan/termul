use super::*;
use serde_json::json;

fn temp_dir(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "termul-workspace-manifest-{label}-{}-{}",
        std::process::id(),
        now_millis()
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

fn sample_manifest(project_id: &str) -> WorkspaceManifest {
    WorkspaceManifest {
        project_id: project_id.to_string(),
        revision: 0, // host overwrites on write
        update_identity: Some("conn-1".to_string()),
        updated_at: 0,
        topology: Some(PaneNode::Leaf(LeafNode {
            id: "leaf-1".to_string(),
            terminal_ids: vec!["terminal-1".to_string()],
            editor_ids: vec![],
            active_tab_id: Some("tab-1".to_string()),
        })),
        active_pane_id: Some("leaf-1".to_string()),
        focused_session_id: Some("session-1".to_string()),
        terminals: vec![TerminalDescriptor {
            terminal_id: "terminal-1".to_string(),
            project_id: project_id.to_string(),
            shell: "pwsh".to_string(),
            cwd: "/dev/proj".to_string(),
            name: "main".to_string(),
            worktree_id: Some("wt-1".to_string()),
            claim_handle: Some("handle-1".to_string()),
        }],
        editors: vec![],
    }
}

// ---- I/O matrix row 1: Load missing manifest → Ok(None) ----
#[tokio::test]
async fn load_missing_manifest_returns_ok_none() {
    let root = temp_dir("load-missing");
    let service = WorkspaceManifestService::open(root.join("store"))
        .await
        .unwrap();
    let loaded = service.load("project-1").await.unwrap();
    assert!(loaded.is_none(), "missing manifest => Ok(None)");
    let _ = fs::remove_dir_all(root);
}

// ---- I/O matrix row 2: Load existing manifest after a write ----
#[tokio::test]
async fn load_existing_manifest_after_write() {
    let root = temp_dir("load-existing");
    let service = WorkspaceManifestService::open(root.join("store"))
        .await
        .unwrap();
    let manifest = sample_manifest("project-1");
    let outcome = service
        .write("project-1", None, manifest.clone())
        .await
        .unwrap();
    assert!(matches!(outcome, WriteOutcome::Updated { revision: 1, .. }));
    let loaded = service.load("project-1").await.unwrap().unwrap();
    assert_eq!(loaded.revision, 1);
    // updatedAt from the write matches what load returns.
    if let WriteOutcome::Updated { updated_at, .. } = outcome {
        assert_eq!(loaded.updated_at, updated_at);
    } else {
        panic!("expected Updated");
    }
    let _ = fs::remove_dir_all(root);
}

// ---- I/O matrix row 3: Initial write (basedRevision=null) ----
#[tokio::test]
async fn initial_write_with_null_based_revision() {
    let root = temp_dir("initial-write");
    let service = WorkspaceManifestService::open(root.join("store"))
        .await
        .unwrap();
    let outcome = service
        .write("project-1", None, sample_manifest("project-1"))
        .await
        .unwrap();
    assert!(matches!(
        outcome,
        WriteOutcome::Updated {
            revision: 1,
            updated_at: _
        }
    ));
    let _ = fs::remove_dir_all(root);
}

// ---- I/O matrix row 4: Subsequent write (basedRevision=1) ----
#[tokio::test]
async fn subsequent_write_with_based_revision_one() {
    let root = temp_dir("subsequent-write");
    let service = WorkspaceManifestService::open(root.join("store"))
        .await
        .unwrap();
    service
        .write("project-1", None, sample_manifest("project-1"))
        .await
        .unwrap();
    let outcome = service
        .write("project-1", Some(1), sample_manifest("project-1"))
        .await
        .unwrap();
    assert!(matches!(
        outcome,
        WriteOutcome::Updated {
            revision: 2,
            updated_at: _
        }
    ));
    let _ = fs::remove_dir_all(root);
}

// ---- I/O matrix row 5: Stale revision conflict (based=1, on-disk=3) ----
#[tokio::test]
async fn stale_revision_conflict_does_not_mutate() {
    let root = temp_dir("stale-conflict");
    let service = WorkspaceManifestService::open(root.join("store"))
        .await
        .unwrap();
    // Drive on-disk revision to 3.
    service
        .write("project-1", None, sample_manifest("project-1"))
        .await
        .unwrap();
    service
        .write("project-1", Some(1), sample_manifest("project-1"))
        .await
        .unwrap();
    let third = service
        .write("project-1", Some(2), sample_manifest("project-1"))
        .await
        .unwrap();
    assert!(matches!(third, WriteOutcome::Updated { revision: 3, .. }));

    // Snapshot the on-disk bytes BEFORE the stale write attempt.
    let path = service.project_path("project-1").unwrap();
    let before = fs::read(&path).unwrap();

    // Stale write: basedRevision=1 against on-disk=3 → Conflict.
    let outcome = service
        .write("project-1", Some(1), sample_manifest("project-1"))
        .await
        .unwrap();
    match outcome {
        WriteOutcome::Conflict {
            current_revision,
            current_updated_at,
            current_update_identity,
        } => {
            assert_eq!(current_revision, 3);
            let _ = current_updated_at;
            assert_eq!(current_update_identity.as_deref(), Some("conn-1"));
        }
        _ => panic!("expected Conflict"),
    }

    // On-disk state byte-for-byte unchanged.
    let after = fs::read(&path).unwrap();
    assert_eq!(before, after);
    let _ = fs::remove_dir_all(root);
}

// ---- I/O matrix row 6: Null basedRevision against existing → Conflict ----
#[tokio::test]
async fn null_based_revision_against_existing_conflicts() {
    let root = temp_dir("null-against-existing");
    let service = WorkspaceManifestService::open(root.join("store"))
        .await
        .unwrap();
    service
        .write("project-1", None, sample_manifest("project-1"))
        .await
        .unwrap();
    let outcome = service
        .write("project-1", None, sample_manifest("project-1"))
        .await
        .unwrap();
    assert!(matches!(
        outcome,
        WriteOutcome::Conflict {
            current_revision: 1,
            ..
        }
    ));
    let _ = fs::remove_dir_all(root);
}

// ---- I/O matrix row 7: Delete existing ----
#[tokio::test]
async fn delete_existing_manifest() {
    let root = temp_dir("delete-existing");
    let service = WorkspaceManifestService::open(root.join("store"))
        .await
        .unwrap();
    service
        .write("project-1", None, sample_manifest("project-1"))
        .await
        .unwrap();
    service.delete("project-1").await.unwrap();
    assert!(service.load("project-1").await.unwrap().is_none());
    let _ = fs::remove_dir_all(root);
}

// ---- I/O matrix row 8: Delete missing is idempotent ----
#[tokio::test]
async fn delete_missing_manifest_is_idempotent() {
    let root = temp_dir("delete-missing");
    let service = WorkspaceManifestService::open(root.join("store"))
        .await
        .unwrap();
    // No file exists; delete must return Ok.
    service.delete("project-1").await.unwrap();
    // And a second delete is still Ok.
    service.delete("project-1").await.unwrap();
    let _ = fs::remove_dir_all(root);
}

// ---- I/O matrix row 9: Corrupt file on load → backup + Ok(None) ----
#[tokio::test]
async fn corrupt_file_on_load_backed_up_and_returns_none() {
    let root = temp_dir("corrupt-load");
    let store = root.join("store");
    fs::create_dir_all(&store).unwrap();
    let path = store.join("project-1.json");
    fs::write(&path, b"{ not valid json").unwrap();

    let service = WorkspaceManifestService::open(store.clone()).await.unwrap();
    let loaded = service.load("project-1").await.unwrap();
    assert!(loaded.is_none());

    // Backup exists alongside the bad file.
    let backups: Vec<_> = fs::read_dir(&store)
        .unwrap()
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .map(|n| n.contains("corrupt-"))
                .unwrap_or(false)
        })
        .collect();
    assert_eq!(backups.len(), 1, "exactly one corrupt backup");
    let _ = fs::remove_dir_all(root);
}

// ---- I/O matrix row 10: Bad schema version on load → backup + Ok(None) ----
#[tokio::test]
async fn bad_schema_version_on_load_backed_up_and_returns_none() {
    let root = temp_dir("bad-schema");
    let store = root.join("store");
    fs::create_dir_all(&store).unwrap();
    let path = store.join("project-1.json");
    // Valid JSON, schema_version != 1.
    let bytes = br#"{"schemaVersion":99,"manifest":{"projectId":"project-1","revision":1,"updatedAt":0,"terminals":[],"editors":[]}}"#;
    fs::write(&path, bytes).unwrap();

    let service = WorkspaceManifestService::open(store.clone()).await.unwrap();
    let loaded = service.load("project-1").await.unwrap();
    assert!(loaded.is_none(), "bad schema version => fresh start");

    // Backup exists.
    let backups: Vec<_> = fs::read_dir(&store)
        .unwrap()
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .map(|n| n.contains("corrupt-"))
                .unwrap_or(false)
        })
        .collect();
    assert_eq!(backups.len(), 1);
    let _ = fs::remove_dir_all(root);
}

// ---- I/O matrix row 11: Concurrent writes same project → serialize ----
#[tokio::test]
async fn concurrent_writes_same_project_serialize() {
    let root = temp_dir("concurrent");
    let service = WorkspaceManifestService::open(root.join("store"))
        .await
        .unwrap();
    // Initial write so both concurrent writes present basedRevision=1
    // against on-disk revision=1.
    service
        .write("project-1", None, sample_manifest("project-1"))
        .await
        .unwrap();

    // Two concurrent writes with basedRevision=1.
    let s1 = Arc::clone(&service);
    let s2 = Arc::clone(&service);
    let (r1, r2) = tokio::join!(
        async move {
            s1.write("project-1", Some(1), sample_manifest("project-1"))
                .await
        },
        async move {
            s2.write("project-1", Some(1), sample_manifest("project-1"))
                .await
        },
    );
    let r1 = r1.unwrap();
    let r2 = r2.unwrap();
    // Exactly one Updated (revision=2), one Conflict (currentRevision=2).
    let updated_count = [&r1, &r2]
        .iter()
        .filter(|o| matches!(o, WriteOutcome::Updated { revision: 2, .. }))
        .count();
    let conflict_count = [&r1, &r2]
        .iter()
        .filter(|o| {
            matches!(
                o,
                WriteOutcome::Conflict {
                    current_revision: 2,
                    ..
                }
            )
        })
        .count();
    assert_eq!(updated_count, 1, "exactly one Updated");
    assert_eq!(conflict_count, 1, "exactly one Conflict");
    let _ = fs::remove_dir_all(root);
}

// ---- I/O matrix row 12: Payload with excluded field → deny_unknown_fields ----
#[tokio::test]
async fn payload_with_excluded_field_rejected_at_boundary() {
    let _root = temp_dir("excluded-field");
    // Construct a manifest JSON carrying an excluded field
    // (`envVars`). The host boundary's deny_unknown_fields must reject it.
    let payload_with_env = json!({
        "projectId": "project-1",
        "revision": 0,
        "updateIdentity": "conn-1",
        "updatedAt": 0,
        "terminals": [],
        "editors": [],
        "envVars": { "SECRET": "leaked" }
    });
    let manifest: std::result::Result<WorkspaceManifest, serde_json::Error> =
        serde_json::from_value(payload_with_env);
    match manifest {
        Ok(m) => {
            // Rejection at the host boundary is the expected path —
            // the Tauri command / HTTP route maps this to
            // `VALIDATION_ERROR`.
            let _ = fs::remove_dir_all(&_root);
            panic!("deny_unknown_fields must reject an envVars payload, got: {m:?}");
        }
        Err(_) => {
            // Expected — deny_unknown_fields rejected the payload.
            let _ = fs::remove_dir_all(&_root);
        }
    }
}

// ---- Excluded field: raw `claim` ----
#[tokio::test]
async fn payload_with_raw_claim_rejected_at_boundary() {
    let payload = json!({
        "terminalId": "terminal-1",
        "projectId": "project-1",
        "shell": "pwsh",
        "cwd": "/dev/proj",
        "name": "main",
        "claim": "raw-claim-credential"
    });
    let result: std::result::Result<TerminalDescriptor, serde_json::Error> =
        serde_json::from_value(payload);
    assert!(
        result.is_err(),
        "deny_unknown_fields must reject a raw `claim` payload"
    );
}

// ---- Excluded field: `fullscreenPaneId` (device-specific UI chrome) ----
#[tokio::test]
async fn payload_with_fullscreen_pane_id_rejected_at_boundary() {
    let payload = json!({
        "projectId": "project-1",
        "revision": 0,
        "updatedAt": 0,
        "terminals": [],
        "editors": [],
        "fullscreenPaneId": "leaf-1"
    });
    let result: std::result::Result<WorkspaceManifest, serde_json::Error> =
        serde_json::from_value(payload);
    assert!(
        result.is_err(),
        "deny_unknown_fields must reject a fullscreenPaneId payload"
    );
}

// ---- Atomic crash safety: write-then-reopen returns the persisted manifest ----
#[tokio::test]
async fn write_then_reopen_returns_persisted_manifest() {
    let root = temp_dir("write-reopen");
    let store = root.join("store");
    let service = WorkspaceManifestService::open(store.clone()).await.unwrap();
    let manifest = sample_manifest("project-1");
    let outcome = service
        .write("project-1", None, manifest.clone())
        .await
        .unwrap();
    let WriteOutcome::Updated {
        revision,
        updated_at,
    } = outcome
    else {
        panic!("expected Updated");
    };

    // Reopen the SAME root — the per-instance mutex map is fresh, but the
    // on-disk state survives (the mutex only avoids the lost-update race
    // between concurrent writers in the SAME process).
    let reopened = WorkspaceManifestService::open(store).await.unwrap();
    let loaded = reopened.load("project-1").await.unwrap().unwrap();
    assert_eq!(loaded.revision, revision);
    assert_eq!(loaded.updated_at, updated_at);
    assert_eq!(loaded.project_id, "project-1");
    assert_eq!(loaded.terminals.len(), 1);
    assert_eq!(loaded.terminals[0].terminal_id, "terminal-1");
    let _ = fs::remove_dir_all(root);
}

// ---- Project-id injection guard: separators / traversal rejected ----
#[tokio::test]
async fn project_id_with_separators_rejected() {
    let root = temp_dir("pid-separators");
    let service = WorkspaceManifestService::open(root.join("store"))
        .await
        .unwrap();
    let err = service.load("../escape").await.unwrap_err();
    assert!(matches!(
        err,
        WorkspaceManifestError::InvalidProjectId { .. }
    ));
    let err = service.load("a/b").await.unwrap_err();
    assert!(matches!(
        err,
        WorkspaceManifestError::InvalidProjectId { .. }
    ));
    let _ = fs::remove_dir_all(root);
}

// ---- Empty project-id guard ----
#[tokio::test]
async fn empty_project_id_rejected() {
    let root = temp_dir("pid-empty");
    let service = WorkspaceManifestService::open(root.join("store"))
        .await
        .unwrap();
    let err = service.load("").await.unwrap_err();
    assert!(matches!(
        err,
        WorkspaceManifestError::InvalidProjectId { .. }
    ));
    let _ = fs::remove_dir_all(root);
}

// ---- Patch 5: `foo..bar` is a legitimate id (NOT rejected); `.` and
// NUL-containing ids ARE rejected. ----
#[tokio::test]
async fn double_dot_substring_in_project_id_is_accepted() {
    // `foo..bar` is a legitimate project name — the `..` substring must
    // NOT be rejected (only the exact id `..` is dangerous). Patch 5
    // removed the over-broad `contains("..")` check.
    let root = temp_dir("pid-double-dot");
    let service = WorkspaceManifestService::open(root.join("store"))
        .await
        .unwrap();
    let outcome = service
        .write("foo..bar", None, sample_manifest("foo..bar"))
        .await
        .unwrap();
    assert!(matches!(outcome, WriteOutcome::Updated { revision: 1, .. }));
    let loaded = service.load("foo..bar").await.unwrap().unwrap();
    assert_eq!(loaded.project_id, "foo..bar");
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn single_dot_project_id_rejected() {
    let root = temp_dir("pid-single-dot");
    let service = WorkspaceManifestService::open(root.join("store"))
        .await
        .unwrap();
    let err = service.load(".").await.unwrap_err();
    assert!(matches!(
        err,
        WorkspaceManifestError::InvalidProjectId { .. }
    ));
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn double_dot_exact_project_id_rejected() {
    let root = temp_dir("pid-double-dot-exact");
    let service = WorkspaceManifestService::open(root.join("store"))
        .await
        .unwrap();
    let err = service.load("..").await.unwrap_err();
    assert!(matches!(
        err,
        WorkspaceManifestError::InvalidProjectId { .. }
    ));
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn project_id_with_nul_byte_rejected() {
    let root = temp_dir("pid-nul");
    let service = WorkspaceManifestService::open(root.join("store"))
        .await
        .unwrap();
    let err = service.load("evil\0root").await.unwrap_err();
    assert!(matches!(
        err,
        WorkspaceManifestError::InvalidProjectId { .. }
    ));
    let _ = fs::remove_dir_all(root);
}

// ---- Patch 3: lock map evicts on successful delete ----
#[tokio::test]
async fn delete_evicts_lock_entry() {
    let root = temp_dir("delete-evict");
    let service = WorkspaceManifestService::open(root.join("store"))
        .await
        .unwrap();
    service
        .write("project-1", None, sample_manifest("project-1"))
        .await
        .unwrap();
    // The lock entry was inserted by the write above.
    assert!(
        service.locks.lock().contains_key("project-1"),
        "write must insert a lock entry"
    );
    service.delete("project-1").await.unwrap();
    // Patch 3: the lock entry is evicted on a successful delete.
    assert!(
        !service.locks.lock().contains_key("project-1"),
        "delete must evict the lock entry"
    );
    // A fresh write re-creates the entry (re-acquire works).
    service
        .write("project-1", None, sample_manifest("project-1"))
        .await
        .unwrap();
    assert!(service.locks.lock().contains_key("project-1"));
    let _ = fs::remove_dir_all(root);
}

// ---- Patch 3: invalid project_id does NOT insert a lock entry ----
#[tokio::test]
async fn invalid_project_id_does_not_insert_lock_entry() {
    let root = temp_dir("pid-invalid-no-lock");
    let service = WorkspaceManifestService::open(root.join("store"))
        .await
        .unwrap();
    // An invalid id surfaces as InvalidProjectId; the lock map must NOT
    // have an entry for the bad id.
    let _ = service.write("", None, sample_manifest("ignored")).await;
    assert!(service.locks.lock().is_empty());
    let _ = service
        .write("../escape", None, sample_manifest("ignored"))
        .await;
    assert!(service.locks.lock().is_empty());
    let _ = fs::remove_dir_all(root);
}

// ---- Patch 18: `agentLauncherPaneId` inbound rejection ----
#[tokio::test]
async fn payload_with_agent_launcher_pane_id_rejected_at_boundary() {
    let payload = json!({
        "projectId": "project-1",
        "revision": 0,
        "updatedAt": 0,
        "terminals": [],
        "editors": [],
        "agentLauncherPaneId": "leaf-1"
    });
    let result: std::result::Result<WorkspaceManifest, serde_json::Error> =
        serde_json::from_value(payload);
    assert!(
            result.is_err(),
            "deny_unknown_fields must reject an agentLauncherPaneId payload (device-specific UI chrome)"
        );
}

// ---- Open rejects a non-directory root (degraded-mode source detection) ----
#[tokio::test]
async fn open_rejects_a_file_root() {
    let root = temp_dir("file-root");
    let file_path = root.join("not-a-dir");
    fs::write(&file_path, b"x").unwrap();
    let error = match WorkspaceManifestService::open(file_path).await {
        Ok(_) => panic!("a non-directory root must not open"),
        Err(error) => error,
    };
    assert!(
        matches!(error, WorkspaceManifestError::Io(_)),
        "a non-directory root must surface as an IO error, got: {error}"
    );
    let _ = fs::remove_dir_all(root);
}

// ---- Different projects progress independently ----
#[tokio::test]
async fn different_projects_progress_independently() {
    let root = temp_dir("independent");
    let service = WorkspaceManifestService::open(root.join("store"))
        .await
        .unwrap();
    // Initial writes to two different projects.
    let o1 = service
        .write("project-1", None, sample_manifest("project-1"))
        .await
        .unwrap();
    let o2 = service
        .write("project-2", None, sample_manifest("project-2"))
        .await
        .unwrap();
    assert!(matches!(o1, WriteOutcome::Updated { revision: 1, .. }));
    assert!(matches!(o2, WriteOutcome::Updated { revision: 1, .. }));
    // Subsequent writes based on the correct revisions both succeed.
    let o1 = service
        .write("project-1", Some(1), sample_manifest("project-1"))
        .await
        .unwrap();
    let o2 = service
        .write("project-2", Some(1), sample_manifest("project-2"))
        .await
        .unwrap();
    assert!(matches!(o1, WriteOutcome::Updated { revision: 2, .. }));
    assert!(matches!(o2, WriteOutcome::Updated { revision: 2, .. }));
    let _ = fs::remove_dir_all(root);
}

// ---- Serde shape: WriteOutcome camelCase + tag=status ----
#[test]
fn write_outcome_serializes_camel_case_with_status_tag() {
    let updated = WriteOutcome::Updated {
        revision: 5,
        updated_at: 1_700_000_000_000,
    };
    let value = serde_json::to_value(&updated).unwrap();
    assert_eq!(value["status"], "updated");
    assert_eq!(value["revision"], 5);
    assert_eq!(value["updatedAt"].as_u64().unwrap(), 1_700_000_000_000u64);

    let conflict = WriteOutcome::Conflict {
        current_revision: 7,
        current_updated_at: 1_700_000_000_001,
        current_update_identity: Some("conn-2".to_string()),
    };
    let value = serde_json::to_value(&conflict).unwrap();
    assert_eq!(value["status"], "conflict");
    assert_eq!(value["currentRevision"], 7);
    assert_eq!(
        value["currentUpdatedAt"].as_u64().unwrap(),
        1_700_000_000_001u64
    );
    assert_eq!(value["currentUpdateIdentity"], "conn-2");
}

// ---- Serde shape: WorkspaceManifest camelCase + deny_unknown_fields ----
#[test]
fn workspace_manifest_serializes_camel_case() {
    let manifest = sample_manifest("project-1");
    let value = serde_json::to_value(&manifest).unwrap();
    assert!(value.get("projectId").is_some());
    assert!(value.get("revision").is_some());
    assert!(value.get("updateIdentity").is_some());
    assert!(value.get("updatedAt").is_some());
    assert!(value.get("topology").is_some());
    assert!(value.get("activePaneId").is_some());
    assert!(value.get("focusedSessionId").is_some());
    assert!(value.get("terminals").is_some());
    assert!(value.get("editors").is_some());
    // No env/claim/viewport/fullscreen/windowState fields ever serialized.
    assert!(value.get("envVars").is_none());
    assert!(value.get("env").is_none());
    assert!(value.get("tokens").is_none());
    assert!(value.get("credentials").is_none());
    assert!(value.get("claim").is_none());
    assert!(value.get("viewport").is_none());
    assert!(value.get("windowState").is_none());
    assert!(value.get("fullscreenPaneId").is_none());
    assert!(value.get("agentLauncherPaneId").is_none());
}

// ---- Serde shape: TerminalDescriptor camelCase + deny_unknown_fields ----
#[test]
fn terminal_descriptor_serializes_camel_case() {
    let descriptor = TerminalDescriptor {
        terminal_id: "terminal-1".to_string(),
        project_id: "project-1".to_string(),
        shell: "pwsh".to_string(),
        cwd: "/dev/proj".to_string(),
        name: "main".to_string(),
        worktree_id: Some("wt-1".to_string()),
        claim_handle: Some("handle-1".to_string()),
    };
    let value = serde_json::to_value(&descriptor).unwrap();
    assert_eq!(value["terminalId"], "terminal-1");
    assert_eq!(value["projectId"], "project-1");
    assert_eq!(value["shell"], "pwsh");
    assert_eq!(value["cwd"], "/dev/proj");
    assert_eq!(value["name"], "main");
    assert_eq!(value["worktreeId"], "wt-1");
    assert_eq!(value["claimHandle"], "handle-1");
    // No raw `claim` field — deny_unknown_fields would reject it.
    let payload = json!({
        "terminalId": "t",
        "projectId": "p",
        "shell": "s",
        "cwd": "c",
        "name": "n",
        "claim": "raw"
    });
    assert!(serde_json::from_value::<TerminalDescriptor>(payload).is_err());
}

// ---- Serde shape: PaneNode tagged enum round-trips ----
#[test]
fn pane_node_tagged_enum_round_trips() {
    let leaf = PaneNode::Leaf(LeafNode {
        id: "leaf-1".to_string(),
        terminal_ids: vec!["t-1".to_string()],
        editor_ids: vec![],
        active_tab_id: Some("tab-1".to_string()),
    });
    let value = serde_json::to_value(&leaf).unwrap();
    assert_eq!(value["type"], "leaf");
    assert_eq!(value["id"], "leaf-1");
    assert_eq!(value["terminalIds"][0], "t-1");
    let back: PaneNode = serde_json::from_value(value).unwrap();
    assert_eq!(leaf, back);

    let split = PaneNode::Split(SplitNode {
        id: "split-1".to_string(),
        direction: PaneDirection::Horizontal,
        children: vec![leaf.clone()],
        sizes: vec![50.0, 50.0],
    });
    let value = serde_json::to_value(&split).unwrap();
    assert_eq!(value["type"], "split");
    assert_eq!(value["direction"], "horizontal");
    assert_eq!(value["children"][0]["type"], "leaf");
    let back: PaneNode = serde_json::from_value(value).unwrap();
    assert_eq!(split, back);
}

// ---- Non-directory root errors at write time, not just open time ----
#[tokio::test]
async fn project_path_rejects_empty_id_at_write_time() {
    let root = temp_dir("write-empty");
    let service = WorkspaceManifestService::open(root.join("store"))
        .await
        .unwrap();
    let err = service
        .write("", None, sample_manifest("ignored"))
        .await
        .unwrap_err();
    // Patch 4: validation failures surface as InvalidProjectId, not Io.
    assert!(matches!(
        err,
        WorkspaceManifestError::InvalidProjectId { .. }
    ));
    let _ = fs::remove_dir_all(root);
}

// ---- Value::Null toleration: an explicit null update_identity survives ----
#[tokio::test]
async fn null_update_identity_survives_round_trip() {
    let root = temp_dir("null-identity");
    let service = WorkspaceManifestService::open(root.join("store"))
        .await
        .unwrap();
    let mut manifest = sample_manifest("project-1");
    manifest.update_identity = None;
    service
        .write("project-1", None, manifest.clone())
        .await
        .unwrap();
    let loaded = service.load("project-1").await.unwrap().unwrap();
    assert_eq!(loaded.update_identity, None);
    let _ = fs::remove_dir_all(root);
}
