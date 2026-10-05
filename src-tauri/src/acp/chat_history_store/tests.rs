use super::*;
use serde_json::json;

fn payload_with(id: &str, config: Option<&str>, project: &str, cwd: &str, activity: u64) -> Value {
    json!({
        "metadata": { "id": id, "agentId": "agent-1", "agentConfigId": config,
            "title": format!("Chat {id}"), "cwd": cwd, "projectId": project,
            "createdAt": 1, "lastActivityAt": activity, "messageCount": 1, "status": "closed" },
        "messages": [{ "id": "m-1" }]
    })
}
fn payload(id: &str, activity: u64) -> Value {
    payload_with(id, Some("config-1"), "project-1", "/project", activity)
}

#[test]
fn restart_uses_index_without_parsing_unindexed_payloads() {
    let root = temp_dir("index-fast-path");
    let store = ChatHistoryStore::open(root.clone()).unwrap();
    store.save("good", payload("good", 2)).unwrap();
    fs::write(root.join(PAYLOADS_DIR).join("junk.json"), b"bad").unwrap();
    let reopened = ChatHistoryStore::open(root.clone()).unwrap();
    assert_eq!(reopened.list().0.len(), 1);
    assert!(root.join(PAYLOADS_DIR).join("junk.json").exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn missing_or_corrupt_index_recovers_and_quarantines_noncanonical_payloads() {
    let root = temp_dir("recovery");
    let store = ChatHistoryStore::open(root.clone()).unwrap();
    store.save("good", payload("good", 2)).unwrap();
    drop(store);
    fs::remove_file(root.join(INDEX_FILE)).unwrap();
    let canonical = root.join(PAYLOADS_DIR).join(canonical_payload_name("good"));
    fs::copy(&canonical, root.join(PAYLOADS_DIR).join("wrong.json")).unwrap();
    let reopened = ChatHistoryStore::open(root.clone()).unwrap();
    assert_eq!(reopened.list().0.len(), 1);
    assert!(!root.join(PAYLOADS_DIR).join("wrong.json").exists());
    assert!(fs::read_dir(root.join(PAYLOADS_DIR))
        .unwrap()
        .flatten()
        .any(|entry| entry.file_name().to_string_lossy().contains("corrupt-")));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn recovery_quarantines_unsupported_payload_versions_and_keeps_valid_sessions() {
    let root = temp_dir("unsupported-payload-recovery");
    let store = ChatHistoryStore::open(root.clone()).unwrap();
    store.save("good", payload("good", 2)).unwrap();
    drop(store);
    fs::remove_file(root.join(INDEX_FILE)).unwrap();
    let future_path = root
        .join(PAYLOADS_DIR)
        .join(canonical_payload_name("future"));
    fs::write(
        &future_path,
        br#"{"schemaVersion":99,"payload":{"metadata":{"id":"future"}}}"#,
    )
    .unwrap();

    let reopened = ChatHistoryStore::open(root.clone()).unwrap();
    assert_eq!(reopened.list().0.len(), 1);
    assert_eq!(reopened.list().0[0].id, "good");
    assert!(!future_path.exists());
    assert!(fs::read_dir(root.join(PAYLOADS_DIR))
        .unwrap()
        .flatten()
        .any(|entry| entry.file_name().to_string_lossy().contains("corrupt-")));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn session_id_bound_keeps_filename_component_safe() {
    assert!(validate_session_id(&"x".repeat(MAX_SESSION_ID_BYTES)).is_ok());
    assert!(matches!(
        validate_session_id(&"x".repeat(MAX_SESSION_ID_BYTES + 1)),
        Err(ChatHistoryStoreError::InvalidSessionId)
    ));
    assert!(canonical_payload_name(&"x".repeat(MAX_SESSION_ID_BYTES)).len() <= 255);
}

#[test]
fn restart_round_trips_and_delete_does_not_resurrect() {
    let root = temp_dir("restart");
    let store = ChatHistoryStore::open(root.clone()).unwrap();
    let expected = payload("safe/session", 10);
    store.save("safe/session", expected.clone()).unwrap();
    assert_eq!(store.get("safe/session").unwrap(), expected);
    store.delete("safe/session").unwrap();
    drop(store);
    assert!(ChatHistoryStore::open(root.clone())
        .unwrap()
        .list()
        .0
        .is_empty());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn find_most_recent_filters_and_breaks_ties() {
    let store = ChatHistoryStore::new();
    let root = store.root().to_path_buf();
    for value in [
        payload_with("old", Some("one"), "p", "/a", 1),
        payload_with("new", Some("one"), "p", "/a", 5),
        payload_with("other-agent", Some("two"), "p", "/a", 9),
        payload_with("other-project", Some("one"), "x", "/a", 10),
        payload_with("other-cwd", Some("one"), "p", "/b", 11),
    ] {
        let id = value["metadata"]["id"].as_str().unwrap().to_string();
        store.save(&id, value).unwrap();
    }
    assert_eq!(
        store
            .find_most_recent_for_project("p", "/a", Some("config:one"))
            .unwrap()
            .id,
        "new"
    );
    assert_eq!(
        store
            .find_most_recent_for_project("p", "/a", None)
            .unwrap()
            .id,
        "other-agent"
    );
    assert!(store
        .find_most_recent_for_project("missing", "/a", None)
        .is_none());

    let mut a = payload_with("a", Some("one"), "tie", "/a", 7);
    let mut b = payload_with("b", Some("one"), "tie", "/a", 7);
    a["metadata"]["createdAt"] = json!(3);
    b["metadata"]["createdAt"] = json!(3);
    store.save("a", a).unwrap();
    store.save("b", b).unwrap();
    assert_eq!(
        store
            .find_most_recent_for_project("tie", "/a", None)
            .unwrap()
            .id,
        "b"
    );
    drop(store);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn future_schema_is_rejected_without_rewrite() {
    let root = temp_dir("future");
    let index = root.join(INDEX_FILE);
    let bytes = br#"{"schemaVersion":99,"sessions":[]}"#;
    fs::write(&index, bytes).unwrap();
    assert!(matches!(
        ChatHistoryStore::open(root.clone()),
        Err(ChatHistoryStoreError::UnsupportedVersion { found: 99 })
    ));
    assert_eq!(fs::read(index).unwrap(), bytes);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn legacy_import_marker_survives_restart() {
    let root = temp_dir("marker");
    let store = ChatHistoryStore::open(root.clone()).unwrap();
    store.mark_legacy_import_complete().unwrap();
    drop(store);
    assert!(ChatHistoryStore::open(root.clone()).unwrap().list().1);
    let _ = fs::remove_dir_all(root);
}

/// `classify_sync_error` treats `PermissionDenied` from `sync_all()` as Ok
/// on non-unix (Windows `FlushFileBuffers`-on-read-only-handle quirk), and
/// as a real error on unix. This is the resilience fix for the unload-path
/// flush that lost chat history with `os error 5` on Windows.
#[test]
fn sync_if_present_treats_windows_permission_denied_as_ok() {
    let error = io::Error::new(io::ErrorKind::PermissionDenied, "Access is denied");
    let classified = classify_sync_error(error);
    #[cfg(not(unix))]
    {
        assert!(
            classified.is_ok(),
            "PermissionDenied must be benign on non-unix"
        );
    }
    #[cfg(unix)]
    {
        assert!(
            classified.is_err(),
            "PermissionDenied must propagate as a real error on unix"
        );
    }
}

/// A non-benign I/O error (e.g. `UnexpectedEof`) must still propagate
/// through `classify_sync_error` on every platform — only
/// `PermissionDenied` is treated as Ok on non-unix.
#[test]
fn classify_sync_error_propagates_non_permission_errors() {
    let error = io::Error::new(io::ErrorKind::UnexpectedEof, "unexpected eof");
    assert!(
        classify_sync_error(error).is_err(),
        "non-PermissionDenied errors must propagate"
    );
}
