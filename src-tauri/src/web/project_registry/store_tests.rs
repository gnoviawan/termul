//! Durability and commit-path behavior of the registry: what survives a
//! reopen, what a failed write leaves behind, and the one-shot import.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::*;
use crate::web::sink::WsRelaySink;

fn project_dir(root: &Path, name: &str) -> PathBuf {
    let dir = root.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::canonicalize(dir).unwrap()
}

fn summary(id: &str, dir: &Path) -> ProjectSummary {
    ProjectSummary {
        id: id.to_string(),
        name: format!("Project {id}"),
        color: "blue".to_string(),
        path: Some(dir.to_string_lossy().into_owned()),
        is_archived: false,
        is_default: false,
    }
}

fn open(file: &Path) -> ProjectRegistry {
    ProjectRegistry::open_durable(file, RootCheck::Strict).expect("open registry")
}

fn backups(dir: &Path, marker: &str) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.file_name().unwrap().to_string_lossy().contains(marker))
        .collect()
}

#[test]
fn a_missing_file_opens_empty_and_the_first_commit_creates_it() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("projects.json");
    let registry = open(&file);
    assert!(registry.is_empty());
    assert!(!file.exists(), "opening never writes");

    registry
        .commit_add(summary("p-1", &project_dir(tmp.path(), "one")))
        .unwrap();
    assert!(file.exists());
}

#[test]
fn projects_default_and_mcp_survive_a_reopen() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("projects.json");
    let dir_a = project_dir(tmp.path(), "a");
    let dir_b = project_dir(tmp.path(), "b");
    {
        let registry = open(&file);
        registry.commit_add(summary("my-api", &dir_a)).unwrap();
        registry.commit_add(summary("p-2", &dir_b)).unwrap();
        registry.commit_set_default("p-2").unwrap();
        registry
            .commit_update("my-api", Some("Renamed".to_string()), None, None)
            .unwrap();
    }
    let reopened = open(&file);
    let snapshot = reopened.snapshot();
    assert_eq!(
        snapshot
            .projects
            .iter()
            .map(|p| p.id.as_str())
            .collect::<Vec<_>>(),
        ["my-api", "p-2"],
        "operator-chosen ids are kept verbatim, in order"
    );
    assert_eq!(snapshot.projects[0].name, "Renamed");
    assert_eq!(snapshot.default_project_id.as_deref(), Some("p-2"));
    assert!(snapshot.projects[1].is_default);
}

#[test]
fn a_v3_file_loads_and_the_first_write_backs_it_up_as_v4() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("projects.json");
    let dir = project_dir(tmp.path(), "one");
    let v3 = serde_json::json!({
        "schemaVersion": 3,
        "defaultProjectId": "p-1",
        "projects": [{
            "id": "p-1", "name": "One", "path": dir, "color": "red",
            "isArchived": false, "mcpServers": []
        }]
    })
    .to_string();
    std::fs::write(&file, &v3).unwrap();

    let registry = open(&file);
    assert_eq!(registry.snapshot().default_project_id.as_deref(), Some("p-1"));
    assert!(!registry.is_imported(), "a v3 file has not been imported");
    assert!(
        backups(tmp.path(), ".pre-v4-").is_empty(),
        "loading alone keeps the file untouched"
    );

    registry
        .commit_update("p-1", Some("Two".to_string()), None, None)
        .unwrap();

    let saved: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(saved["schemaVersion"], 4);
    assert_eq!(saved["imported"], false);
    let kept = backups(tmp.path(), ".pre-v4-");
    assert_eq!(kept.len(), 1, "the original is kept before the first write");
    assert_eq!(std::fs::read_to_string(&kept[0]).unwrap(), v3);
}

#[test]
fn a_newer_schema_is_refused_and_left_untouched() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("projects.json");
    let newer = r#"{"schemaVersion":99,"projects":[],"future":true}"#;
    std::fs::write(&file, newer).unwrap();

    let error = ProjectRegistry::open_durable(&file, RootCheck::Lenient)
        .err()
        .expect("newer schema refused");
    assert!(matches!(
        error,
        crate::acp::ProjectRegistryError::BadSchemaVersion { found: 99, .. }
    ));

    // The desktop's empty fallback still never overwrites it.
    let fallback = ProjectRegistry::empty_durable(&file);
    let result = fallback.commit_add(summary("p-1", &project_dir(tmp.path(), "one")));
    assert!(matches!(result, Err(ProjectCommandError::Persist(_))));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), newer);
    assert!(fallback.is_empty(), "the failed commit changed nothing");
}

#[test]
fn a_corrupt_file_is_backed_up_and_the_empty_fallback_can_write_again() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("projects.json");
    std::fs::write(&file, "{ not json").unwrap();

    assert!(ProjectRegistry::open_durable(&file, RootCheck::Lenient).is_err());
    let backup = backups(tmp.path(), ".corrupt-");
    assert_eq!(backup.len(), 1);
    assert_eq!(std::fs::read_to_string(&backup[0]).unwrap(), "{ not json");

    let fallback = ProjectRegistry::empty_durable(&file);
    fallback
        .commit_add(summary("p-1", &project_dir(tmp.path(), "one")))
        .unwrap();
    assert_eq!(open(&file).len(), 1);
}

#[test]
fn a_root_that_vanished_stays_listed_when_lenient_and_fails_when_strict() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("projects.json");
    let gone = tmp.path().join("gone");
    std::fs::write(
        &file,
        serde_json::json!({
            "schemaVersion": 4,
            "projects": [{"id": "p-1", "name": "One", "path": gone, "color": "red", "isArchived": false}]
        })
        .to_string(),
    )
    .unwrap();

    assert!(ProjectRegistry::open_durable(&file, RootCheck::Strict).is_err());
    let lenient = ProjectRegistry::open_durable(&file, RootCheck::Lenient).unwrap();
    assert_eq!(lenient.len(), 1);
    assert!(
        lenient.canonical_root("p-1").is_none(),
        "an unresolvable root is not watchable until it reappears"
    );
}

#[test]
fn a_failed_write_changes_nothing_in_memory() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("projects.json");
    let dir = project_dir(tmp.path(), "one");
    let registry = open(&file);
    registry.commit_add(summary("p-1", &dir)).unwrap();
    let before = registry.snapshot();

    // The target can no longer be written: a directory now sits where the
    // file was.
    std::fs::remove_file(&file).unwrap();
    std::fs::create_dir(&file).unwrap();

    let add = registry.commit_add(summary("p-2", &dir));
    assert!(matches!(add, Err(ProjectCommandError::Persist(_))));
    let update = registry.commit_update("p-1", None, None, Some(true));
    assert!(matches!(update, Err(ProjectCommandError::Persist(_))));
    let remove = registry.commit_remove("p-1");
    assert!(matches!(remove, Err(ProjectCommandError::Persist(_))));
    let default = registry.commit_set_default("p-1");
    assert!(matches!(default, Err(ProjectCommandError::Persist(_))));

    assert_eq!(registry.snapshot(), before, "rollback is never swapping");
    assert!(
        registry.is_within_any_registered_root(&dir),
        "the boundary is unchanged too"
    );
}

#[test]
fn archiving_or_removing_the_default_clears_it_durably() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("projects.json");
    let registry = open(&file);
    for id in ["p-1", "p-2"] {
        registry
            .commit_add(summary(id, &project_dir(tmp.path(), id)))
            .unwrap();
    }

    registry.commit_set_default("p-1").unwrap();
    registry
        .commit_update("p-1", None, None, Some(true))
        .unwrap();
    assert_eq!(registry.snapshot().default_project_id, None);
    assert_eq!(open(&file).snapshot().default_project_id, None);

    registry.commit_set_default("p-2").unwrap();
    assert!(registry.commit_remove("p-2").unwrap().value);
    let reopened = open(&file).snapshot();
    assert_eq!(reopened.default_project_id, None);
    assert_eq!(reopened.projects.len(), 1);
    assert!(
        registry.commit_set_default("p-1").is_err(),
        "an archived project cannot become the default"
    );
}

#[test]
fn removing_an_absent_id_is_ok_and_writes_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("projects.json");
    let registry = open(&file);
    let committed = registry.commit_remove("never-was").unwrap();
    assert!(!committed.value);
    assert!(!committed.changed);
    assert!(!file.exists());
}

#[test]
fn the_synthetic_seed_is_never_persisted() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("projects.json");
    let seed_root = project_dir(tmp.path(), "seed");
    let registry = open(&file);
    assert!(registry.seed_root_if_no_usable_project(&seed_root));
    assert_eq!(registry.snapshot().default_project_id.as_deref(), Some("default"));
    assert!(!file.exists(), "seeding writes nothing");

    // A commit made while only the seed exists must not leak it to disk.
    registry.commit_import(Vec::new(), None).unwrap();
    let saved: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(saved["projects"], serde_json::json!([]));
    assert!(saved.get("defaultProjectId").is_none());

    // A real project retires the seed and takes over the default.
    registry
        .commit_add(summary("real", &project_dir(tmp.path(), "real")))
        .unwrap();
    let snapshot = registry.snapshot();
    assert_eq!(
        snapshot.projects.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
        ["real"]
    );
    assert_eq!(snapshot.default_project_id.as_deref(), Some("real"));
    assert_eq!(open(&file).snapshot(), snapshot);
}

#[test]
fn the_import_applies_the_renderer_default_over_the_seed() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("projects.json");
    let registry = open(&file);
    assert!(registry.seed_root_if_no_usable_project(&project_dir(tmp.path(), "seed")));

    // The first real project retires the seed; the renderer's own default must
    // still win over the project that happened to be listed first.
    registry
        .commit_import(
            vec![
                summary("first", &project_dir(tmp.path(), "first")),
                summary("chosen", &project_dir(tmp.path(), "chosen")),
            ],
            Some("chosen".to_string()),
        )
        .unwrap();
    let snapshot = registry.snapshot();
    assert_eq!(
        snapshot.projects.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
        ["first", "chosen"],
        "the seed is retired"
    );
    assert_eq!(snapshot.default_project_id.as_deref(), Some("chosen"));
    assert_eq!(open(&file).snapshot(), snapshot);
}

#[test]
fn the_import_keeps_a_real_default_over_the_renderer_default() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("projects.json");
    let registry = open(&file);
    registry
        .commit_add(summary("kept", &project_dir(tmp.path(), "kept")))
        .unwrap();
    registry.commit_set_default("kept").unwrap();

    registry
        .commit_import(
            vec![summary("other", &project_dir(tmp.path(), "other"))],
            Some("other".to_string()),
        )
        .unwrap();
    assert_eq!(registry.snapshot().default_project_id.as_deref(), Some("kept"));
}

#[test]
fn seeding_never_replaces_a_real_project_that_uses_the_seed_id() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("projects.json");
    let registry = open(&file);
    let mut archived = summary("default", &project_dir(tmp.path(), "real"));
    archived.is_archived = true;
    registry.commit_add(archived).unwrap();
    let before = registry.snapshot();

    assert!(!registry.seed_root_if_no_usable_project(&project_dir(tmp.path(), "seed")));
    assert_eq!(registry.snapshot(), before, "the real project is untouched");
    registry.commit_import(Vec::new(), None).unwrap();
    let saved = open(&file).snapshot();
    assert_eq!(saved.projects.len(), 1, "the real project is still on disk");
    assert!(saved.projects[0].is_archived);
}

#[test]
fn the_renderer_push_is_written_through() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("projects.json");
    let registry = open(&file);
    let dir = project_dir(tmp.path(), "one");
    registry
        .commit_replace_all(vec![summary("p-1", &dir), summary("p-2", &dir)], |list, _| {
            list.first().map(|p| p.id.clone())
        })
        .unwrap();
    assert_eq!(open(&file).snapshot(), registry.snapshot());
    assert_eq!(registry.snapshot().default_project_id.as_deref(), Some("p-1"));

    // A push that names the reserved id never registers it.
    registry
        .commit_replace_all(
            vec![summary(crate::acp::session_persistence::UNASSIGNED_PROJECT_ID, &dir)],
            |_, _| None,
        )
        .unwrap();
    assert!(registry.is_empty());
}

fn import(
    registry: &Arc<ProjectRegistry>,
    projects: Vec<ProjectSummary>,
    default: Option<&str>,
) -> bool {
    import_projects(
        registry,
        &Arc::new(WsRelaySink::new()),
        projects,
        default.map(str::to_string),
    )
    .expect("import")
    .imported
}

#[test]
fn the_import_runs_once_and_never_overwrites() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("projects.json");
    let dir = project_dir(tmp.path(), "one");
    let registry = Arc::new(open(&file));
    registry.commit_add(summary("kept", &dir)).unwrap();
    registry.commit_set_default("kept").unwrap();

    let mut renamed = summary("kept", &dir);
    renamed.name = "Renderer name".to_string();
    assert!(import(
        &registry,
        vec![renamed, summary("fresh", &dir)],
        Some("fresh")
    ));
    let snapshot = registry.snapshot();
    assert_eq!(
        snapshot.projects.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
        ["kept", "fresh"]
    );
    assert_eq!(snapshot.projects[0].name, "Project kept", "existing ids win");
    assert_eq!(
        snapshot.default_project_id.as_deref(),
        Some("kept"),
        "the imported default only applies when none is set"
    );

    // The second call — also after a restart — is an ok no-op.
    assert!(!import(&registry, vec![summary("late", &dir)], None));
    let reopened = Arc::new(open(&file));
    assert!(reopened.is_imported());
    assert!(!import(&reopened, vec![summary("late", &dir)], None));
    assert!(!reopened.contains("late"));
}

#[test]
fn an_empty_import_is_remembered_and_applies_the_default_when_none_is_set() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("projects.json");
    let registry = Arc::new(open(&file));
    assert!(import(&registry, Vec::new(), None));
    assert!(open(&file).is_imported(), "imported is durable for an empty list");
    assert!(!import(&registry, vec![summary("p-1", tmp.path())], None));

    let other = tmp.path().join("other.json");
    let registry = Arc::new(open(&other));
    let dir = project_dir(tmp.path(), "one");
    assert!(import(&registry, vec![summary("p-1", &dir)], Some("p-1")));
    assert_eq!(registry.snapshot().default_project_id.as_deref(), Some("p-1"));
}

#[test]
fn a_failed_import_write_can_be_retried() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("projects.json");
    let registry = Arc::new(open(&file));
    std::fs::create_dir(&file).unwrap();
    let relay = Arc::new(WsRelaySink::new());
    let dir = project_dir(tmp.path(), "one");
    assert!(import_projects(&registry, &relay, vec![summary("p-1", &dir)], None).is_err());
    assert!(!registry.is_imported());
    assert!(registry.is_empty());

    std::fs::remove_dir(&file).unwrap();
    assert!(import(&registry, vec![summary("p-1", &dir)], None));
}

#[test]
fn concurrent_commits_all_land_and_all_persist() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("projects.json");
    let dir = project_dir(tmp.path(), "shared");
    let registry = Arc::new(open(&file));
    let handles: Vec<_> = (0..16)
        .map(|i| {
            let registry = Arc::clone(&registry);
            let dir = dir.clone();
            std::thread::spawn(move || {
                registry
                    .commit_add(summary(&format!("p-{i}"), &dir))
                    .expect("commit");
            })
        })
        .collect();
    for handle in handles {
        handle.join().unwrap();
    }
    assert_eq!(registry.len(), 16);
    let reopened = open(&file);
    assert_eq!(reopened.len(), 16, "no commit overwrote another's write");
    let mut ids: Vec<_> = reopened.snapshot().projects.into_iter().map(|p| p.id).collect();
    ids.sort();
    let mut expected: Vec<_> = (0..16).map(|i| format!("p-{i}")).collect();
    expected.sort();
    assert_eq!(ids, expected);
}
