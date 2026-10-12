use super::*;

fn temp_dir(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "termul-sessions-{label}-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

fn registration(session_id: &str, project_id: Option<&str>, cwd: &Path) -> SessionRegistration {
    SessionRegistration {
        session_id: session_id.to_string(),
        stable_agent_namespace: Some("config:test".to_string()),
        runtime_agent_id: Some("agent-1".to_string()),
        project_id: project_id.map(str::to_string),
        cwd: cwd.to_path_buf(),
        ..Default::default()
    }
}

/// Rewrites a persisted session's metadata without `projectId`, the shape a
/// record written before project attribution has.
fn strip_project_id(store: &Path, storage_key: &str) {
    let path = store.join(storage_key).join("metadata.json");
    let mut value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    value.as_object_mut().unwrap().remove("projectId");
    fs::write(&path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
}

#[tokio::test]
async fn new_sessions_are_stamped_with_the_given_project_or_the_unassigned_sentinel() {
    let root = temp_dir("stamp");
    let cwd = root.join("cwd");
    fs::create_dir_all(&cwd).unwrap();
    let persistence = SessionPersistence::open(root.join("store")).await.unwrap();

    let owned = persistence
        .register_session(registration("s-owned", Some("project-1"), &cwd))
        .await
        .unwrap();
    let orphan = persistence
        .register_session(registration("s-orphan", None, &cwd))
        .await
        .unwrap();
    let blank = persistence
        .register_session(registration("s-blank", Some("  "), &cwd))
        .await
        .unwrap();

    assert_eq!(owned.project_id.as_deref(), Some("project-1"));
    assert_eq!(orphan.project_id.as_deref(), Some(UNASSIGNED_PROJECT_ID));
    assert_eq!(blank.project_id.as_deref(), Some(UNASSIGNED_PROJECT_ID));
    persistence.shutdown().await.unwrap();
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn re_registering_a_discovered_session_never_rebinds_its_project() {
    let root = temp_dir("discovered-immutable");
    let cwd = root.join("cwd");
    fs::create_dir_all(&cwd).unwrap();
    let persistence = SessionPersistence::open(root.join("store")).await.unwrap();

    let first = persistence
        .register_discovered_session(registration("d-1", Some("project-1"), &cwd), None, Some(1))
        .await
        .unwrap();
    let second = persistence
        .register_discovered_session(registration("d-1", Some("project-2"), &cwd), None, Some(2))
        .await
        .unwrap();
    let third = persistence
        .register_discovered_session(registration("d-1", None, &cwd), None, Some(3))
        .await
        .unwrap();

    assert_eq!(first.project_id.as_deref(), Some("project-1"));
    assert_eq!(second.project_id.as_deref(), Some("project-1"));
    assert_eq!(third.project_id.as_deref(), Some("project-1"));
    assert_eq!(
        persistence.metadata("d-1").unwrap().project_id.as_deref(),
        Some("project-1")
    );
    persistence.shutdown().await.unwrap();
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn legacy_sessions_without_a_project_are_stamped_unassigned_exactly_once() {
    let root = temp_dir("migration");
    let cwd = root.join("cwd");
    fs::create_dir_all(&cwd).unwrap();
    let store = root.join("store");
    let persistence = SessionPersistence::open(store.clone()).await.unwrap();
    let legacy = persistence
        .register_session(registration("s-legacy", Some("project-1"), &cwd))
        .await
        .unwrap();
    let owned = persistence
        .register_session(registration("s-owned", Some("project-2"), &cwd))
        .await
        .unwrap();
    persistence.shutdown().await.unwrap();
    drop(persistence);

    // A store from before project attribution: no project on the record and
    // no migration marker.
    strip_project_id(&store, &legacy.storage_key);
    let _ = fs::remove_file(store.join(UNASSIGNED_MIGRATION_MARKER));

    let persistence = SessionPersistence::open(store.clone()).await.unwrap();
    assert_eq!(
        persistence
            .metadata("s-legacy")
            .unwrap()
            .project_id
            .as_deref(),
        Some(UNASSIGNED_PROJECT_ID)
    );
    assert_eq!(
        persistence
            .metadata("s-owned")
            .unwrap()
            .project_id
            .as_deref(),
        owned.project_id.as_deref(),
        "an attributed session keeps its project"
    );
    let index = persistence
        .list_sessions()
        .into_iter()
        .find(|entry| entry.session_id == "s-legacy")
        .unwrap();
    assert_eq!(index.project_id.as_deref(), Some(UNASSIGNED_PROJECT_ID));
    assert!(store.join(UNASSIGNED_MIGRATION_MARKER).is_file());
    persistence.shutdown().await.unwrap();
    drop(persistence);

    // The marker makes the migration one-shot: a record that loses its
    // project after the migration ran is not re-stamped.
    strip_project_id(&store, &legacy.storage_key);
    let persistence = SessionPersistence::open(store).await.unwrap();
    assert_eq!(persistence.metadata("s-legacy").unwrap().project_id, None);
    persistence.shutdown().await.unwrap();
    let _ = fs::remove_dir_all(root);
}

#[test]
fn the_sentinel_literal_matches_the_renderer_constant() {
    // `UNASSIGNED_PROJECT_ID` in `src/shared/types/web-projects.types.ts`.
    assert_eq!(UNASSIGNED_PROJECT_ID, "__unassigned__");
}

#[tokio::test]
async fn new_discovered_and_imported_records_are_stamped_like_created_ones() {
    let root = temp_dir("stamp-kinds");
    let cwd = root.join("cwd");
    fs::create_dir_all(&cwd).unwrap();
    let persistence = SessionPersistence::open(root.join("store")).await.unwrap();

    let discovered_bare = persistence
        .register_discovered_session(registration("d-bare", None, &cwd), None, Some(1))
        .await
        .unwrap();
    let discovered_owned = persistence
        .register_discovered_session(registration("d-owned", Some("p-1"), &cwd), None, Some(1))
        .await
        .unwrap();
    let imported_bare = persistence
        .register_imported_session(registration("i-bare", None, &cwd), 10, None)
        .await
        .unwrap();
    let imported_blank = persistence
        .register_imported_session(registration("i-blank", Some("  "), &cwd), 10, None)
        .await
        .unwrap();
    let imported_owned = persistence
        .register_imported_session(registration("i-owned", Some("p-2"), &cwd), 10, None)
        .await
        .unwrap();

    assert_eq!(
        discovered_bare.project_id.as_deref(),
        Some(UNASSIGNED_PROJECT_ID)
    );
    assert_eq!(discovered_owned.project_id.as_deref(), Some("p-1"));
    assert_eq!(
        imported_bare.project_id.as_deref(),
        Some(UNASSIGNED_PROJECT_ID)
    );
    assert_eq!(
        imported_blank.project_id.as_deref(),
        Some(UNASSIGNED_PROJECT_ID)
    );
    assert_eq!(imported_owned.project_id.as_deref(), Some("p-2"));
    persistence.shutdown().await.unwrap();
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn a_skipped_session_keeps_the_migration_open_until_every_session_is_visited() {
    let root = temp_dir("migration-skipped");
    let cwd = root.join("cwd");
    fs::create_dir_all(&cwd).unwrap();
    let store = root.join("store");
    let persistence = SessionPersistence::open(store.clone()).await.unwrap();
    let legacy = persistence
        .register_session(registration("s-legacy", Some("project-1"), &cwd))
        .await
        .unwrap();
    persistence.shutdown().await.unwrap();
    drop(persistence);
    strip_project_id(&store, &legacy.storage_key);
    let _ = fs::remove_file(store.join(UNASSIGNED_MIGRATION_MARKER));

    // A second store directory whose metadata cannot be decoded: its session
    // is skipped by the recover loop.
    let broken = store.join(Uuid::new_v4().to_string());
    fs::create_dir_all(&broken).unwrap();
    fs::write(broken.join("metadata.json"), b"not json").unwrap();

    let persistence = SessionPersistence::open(store.clone()).await.unwrap();
    assert_eq!(
        persistence
            .metadata("s-legacy")
            .unwrap()
            .project_id
            .as_deref(),
        Some(UNASSIGNED_PROJECT_ID),
        "the readable legacy session is still stamped"
    );
    assert!(
        !store.join(UNASSIGNED_MIGRATION_MARKER).exists(),
        "a skipped session must not close the migration"
    );
    persistence.shutdown().await.unwrap();
    drop(persistence);

    fs::remove_dir_all(&broken).unwrap();
    let persistence = SessionPersistence::open(store.clone()).await.unwrap();
    assert!(store.join(UNASSIGNED_MIGRATION_MARKER).is_file());
    persistence.shutdown().await.unwrap();
    let _ = fs::remove_dir_all(root);
}
