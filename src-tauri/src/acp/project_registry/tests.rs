//! NOTE: this module MUST NOT import `crate::web::*` — the
//! `web -> acp -> web` cycle invariant (see the module-level doc).
//! These tests exercise the file-backed registry in isolation; the
//! VfsRoot -> ProjectSummary mapping + mode-selection seam is tested in
//! `web::project_registry` (which may import `acp`).

use super::*;
use std::path::PathBuf;

/// Minimal std-only temp dir (reuses `web::config`'s pid+nanos pattern —
/// no `tempfile` dev-dep). Caller must `cleanup` it.
fn tempdir_like(label: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "termul-registry-{label}-{}-{}",
        std::process::id(),
        now_nanos()
    ));
    fs::create_dir_all(&p).expect("create tempdir");
    p
}

fn cleanup(p: &Path) {
    let _ = fs::remove_dir_all(p);
}

/// A real, on-disk directory to use as a valid VFS root path.
fn real_dir(parent: &Path, name: &str) -> PathBuf {
    let d = parent.join(name);
    fs::create_dir_all(&d).expect("mkdir root");
    d
}

fn root(id: &str, path: &Path, archived: bool) -> VfsRoot {
    VfsRoot {
        id: id.to_string(),
        name: format!("Project {id}"),
        path: path.to_path_buf(),
        color: "blue".to_string(),
        is_archived: archived,
        mcp_servers: Vec::new(),
    }
}

fn write_json(path: &Path, json: &str) {
    fs::write(path, json).expect("write json");
}

// T5.1 — load reads VFS roots (schema 1, 2 roots, active id).
#[test]
fn load_reads_vfs_roots() {
    let dir = tempdir_like("load-reads");
    let root_a = real_dir(&dir, "proj-a");
    let root_b = real_dir(&dir, "proj-b");
    let file = dir.join("projects.json");
    write_json(
            &file,
            &serde_json::json!({
                "schemaVersion": 1,
                "activeProjectId": "p-1",
                "projects": [
                    { "id": "p-1", "name": "Project p-1", "path": root_a, "color": "blue", "isArchived": false },
                    { "id": "p-2", "name": "Project p-2", "path": root_b, "color": "green", "isArchived": false },
                ]
            })
            .to_string(),
        );

    let reg = FileProjectRegistry::load(&file).expect("load ok");
    assert_eq!(reg.roots().len(), 2, "two roots loaded");
    assert_eq!(reg.default_project_id(), Some("p-1"));
    let resolved = reg.resolve_path("p-1").expect("resolve p-1");
    // The loaded path is the canonical absolute form of root_a.
    assert!(resolved.is_absolute());
    assert_eq!(resolved, root_a.canonicalize().unwrap());
    cleanup(&dir);
}

// T5.2 — missing file => Ok(empty), NOT an error (the binary still serves).
#[test]
fn load_missing_file_returns_empty_not_error() {
    let dir = tempdir_like("load-missing");
    let missing = dir.join("does-not-exist.json");
    let reg = FileProjectRegistry::load(&missing).expect("missing => Ok(empty)");
    assert!(reg.is_empty());
    assert_eq!(reg.roots().len(), 0);
    assert_eq!(reg.default_project_id(), None);
    assert!(reg.resolve_path("anything").is_none());
    cleanup(&dir);
}

// T5.3 — corrupt JSON => Err(Parse) AND a .corrupt-<ts>.bak exists.
#[test]
fn load_backup_on_corrupt() {
    let dir = tempdir_like("load-corrupt");
    let file = dir.join("projects.json");
    fs::write(&file, "{ not valid json").expect("write garbage");

    let err = FileProjectRegistry::load(&file).expect_err("corrupt => Err");
    assert!(
        matches!(err, ProjectRegistryError::Parse(_)),
        "expected Parse, got {err:?}"
    );

    // A .corrupt-<ts>.bak backup must exist alongside the bad file.
    let mut backups: Vec<_> = fs::read_dir(&dir)
        .expect("read dir")
        .filter_map(Result::ok)
        .filter(|e| {
            e.file_name()
                .to_str()
                .map(|n| n.starts_with("projects.json.corrupt-") && n.ends_with(".bak"))
                .unwrap_or(false)
        })
        .collect();
    assert_eq!(backups.len(), 1, "exactly one corrupt backup");
    // The backup contains the original garbage.
    let bak_path = backups.remove(0).path();
    assert_eq!(fs::read_to_string(&bak_path).unwrap(), "{ not valid json");
    cleanup(&dir);
}

// T5.4 — bad schema version => Err(BadSchemaVersion { expected: 1, found: 99 }).
#[test]
fn load_rejects_bad_schema_version() {
    let dir = tempdir_like("load-bad-schema");
    let file = dir.join("projects.json");
    write_json(
        &file,
        &serde_json::json!({
            "schemaVersion": 99,
            "activeProjectId": null,
            "projects": []
        })
        .to_string(),
    );

    let err = FileProjectRegistry::load(&file).expect_err("bad schema => Err");
    assert!(
        matches!(
            err,
            ProjectRegistryError::BadSchemaVersion {
                expected: SCHEMA_VERSION,
                found: 99
            }
        ),
        "expected BadSchemaVersion {{expected:{SCHEMA_VERSION}, found:99}}, got {err:?}"
    );
    cleanup(&dir);
}

// T5.5 — save_atomic round-trips, consumes the temp, and replaces a stale file.
#[test]
fn save_atomic_round_trips_and_is_atomic() {
    let dir = tempdir_like("save-roundtrip");
    let root_a = real_dir(&dir, "proj-a");
    // Canonicalize so the round-trip deep-equals: load() canonicalizes
    // each root's path, so the saved registry must already hold canonical
    // paths for save -> reload to compare equal (Windows adds the `\\?\`
    // verbatim prefix on canonicalize).
    let root_a = root_a.canonicalize().expect("canonicalize root-a");
    let file = dir.join("projects.json");

    // A stale existing file must be replaced.
    fs::write(&file, "STALE").expect("write stale");

    let reg =
        FileProjectRegistry::from_roots(vec![root("p-1", &root_a, false)], Some("p-1".to_string()));
    reg.save_atomic(&file).expect("save_atomic ok");

    // The temp file must NOT linger (the rename consumed it).
    let temps: Vec<_> = fs::read_dir(&dir)
        .expect("read dir")
        .filter_map(Result::ok)
        .filter(|e| {
            e.file_name()
                .to_str()
                .map(|n| n.ends_with(".tmp"))
                .unwrap_or(false)
        })
        .collect();
    assert!(temps.is_empty(), "no lingering temp file: {temps:?}");

    // The target no longer contains the stale content.
    assert_ne!(fs::read_to_string(&file).unwrap(), "STALE");

    // Reload + deep-equal round-trip.
    let reloaded = FileProjectRegistry::load(&file).expect("reload ok");
    assert_eq!(reloaded.roots(), reg.roots());
    assert_eq!(reloaded.default_project_id(), reg.default_project_id());
    assert_eq!(reloaded, reg);
    cleanup(&dir);
}

// T5.6 — the temp is written in the SAME directory as the target (same-dir
// so rename is atomic; cross-device rename would fail CrossesDevices).
#[test]
fn save_atomic_writes_temp_in_same_dir() {
    let dir = tempdir_like("save-samedir");
    // A SEPARATE temp dir to prove the temp is NOT created there.
    let other = tempdir_like("save-other");
    let root_a = real_dir(&dir, "proj-a");
    let file = dir.join("projects.json");

    let reg = FileProjectRegistry::from_roots(vec![root("p-1", &root_a, false)], None);
    reg.save_atomic(&file).expect("save_atomic ok");

    // No temp file (or any file) created in the OTHER directory by save_atomic.
    let leaked: Vec<_> = fs::read_dir(&other)
        .expect("read other dir")
        .filter_map(Result::ok)
        .collect();
    assert!(
        leaked.is_empty(),
        "save_atomic must not write outside the target dir: {leaked:?}"
    );
    cleanup(&dir);
    cleanup(&other);
}

// T5.7 — resolve_path skips archived roots and empty paths.
#[test]
fn resolve_path_skips_archived_and_empty() {
    // Constructed directly (not via load, which canonicalizes/rejects).
    let reg = FileProjectRegistry::from_roots(
        vec![
            root("p-live", Path::new("/a/b"), false),
            root("p-archived", Path::new("/c/d"), true),
            VfsRoot {
                id: "p-empty".to_string(),
                name: "Empty".to_string(),
                path: PathBuf::new(),
                color: "blue".to_string(),
                is_archived: false,
                mcp_servers: Vec::new(),
            },
        ],
        None,
    );
    assert_eq!(
        reg.resolve_path("p-live").as_deref(),
        Some(std::path::Path::new("/a/b"))
    );
    // Archived => None (cannot switch).
    assert_eq!(reg.resolve_path("p-archived"), None);
    // Empty path => None (cannot switch).
    assert_eq!(reg.resolve_path("p-empty"), None);
    // Unknown id => None.
    assert_eq!(reg.resolve_path("missing"), None);
}

// P4 — from_roots drops a default_project_id that references a project not
// in the roots list (no dangling default). Also drops a default pointing
// at an archived or empty-path root (not switchable — same conditions as
// `set_default_project`).
#[test]
fn from_roots_drops_dangling_or_unswitchable_default() {
    let reg = FileProjectRegistry::from_roots(
        vec![
            root("p-live", Path::new("/a"), false),
            root("p-archived", Path::new("/b"), true),
            VfsRoot {
                id: "p-empty".to_string(),
                name: "Empty".to_string(),
                path: PathBuf::new(),
                color: "blue".to_string(),
                is_archived: false,
                mcp_servers: Vec::new(),
            },
        ],
        // Dangling (p-deleted doesn't exist) — must be dropped.
        Some("p-deleted".to_string()),
    );
    assert_eq!(reg.default_project_id(), None);

    // A valid switchable default survives.
    let reg = FileProjectRegistry::from_roots(
        vec![root("p-live", Path::new("/a"), false)],
        Some("p-live".to_string()),
    );
    assert_eq!(reg.default_project_id(), Some("p-live"));

    // An archived default is dropped (not switchable).
    let reg = FileProjectRegistry::from_roots(
        vec![root("p-archived", Path::new("/b"), true)],
        Some("p-archived".to_string()),
    );
    assert_eq!(reg.default_project_id(), None);

    // An empty-path default is dropped (not switchable).
    let reg = FileProjectRegistry::from_roots(
        vec![VfsRoot {
            id: "p-empty".to_string(),
            name: "Empty".to_string(),
            path: PathBuf::new(),
            color: "blue".to_string(),
            is_archived: false,
            mcp_servers: Vec::new(),
        }],
        Some("p-empty".to_string()),
    );
    assert_eq!(reg.default_project_id(), None);
}

#[test]
fn v1_migrates_to_v3_with_empty_mcp_configuration() {
    let dir = tempdir_like("migrate-v1");
    let root_a = real_dir(&dir, "proj-a");
    let file = dir.join("projects.json");
    write_json(
        &file,
        &serde_json::json!({
            "schemaVersion": 1,
            "activeProjectId": "p-1",
            "projects": [{
                "id": "p-1", "name": "Project p-1", "path": root_a,
                "color": "blue", "isArchived": false
            }]
        })
        .to_string(),
    );
    let reg = FileProjectRegistry::load(&file).expect("v1 migrates");
    assert!(reg.roots()[0].mcp_servers.is_empty());
    // The serde alias deserializes v1's `activeProjectId` into
    // `default_project_id` transparently.
    assert_eq!(reg.default_project_id(), Some("p-1"));
    reg.save_atomic(&file).expect("save v3");
    let saved: serde_json::Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    assert_eq!(saved["schemaVersion"], 3);
    assert_eq!(saved["defaultProjectId"], "p-1");
    assert!(
        saved.get("activeProjectId").is_none(),
        "v3 must serialize under the new field name"
    );
    cleanup(&dir);
}

/// v2 → v3 migration: a v2 file used `activeProjectId`; the serde alias on
/// `RegistryFile.default_project_id` deserializes it transparently, and the
/// migrate arm bumps the recorded schema version to 3. After a save→reload
/// the field is stored under the new `defaultProjectId` name.
#[test]
fn v2_migrates_to_v3_via_serde_alias() {
    let dir = tempdir_like("migrate-v2");
    let root_a = real_dir(&dir, "proj-a");
    let file = dir.join("projects.json");
    write_json(
        &file,
        &serde_json::json!({
            "schemaVersion": 2,
            "activeProjectId": "p-1",
            "projects": [{
                "id": "p-1", "name": "Project p-1", "path": root_a,
                "color": "blue", "isArchived": false
            }]
        })
        .to_string(),
    );
    let reg = FileProjectRegistry::load(&file).expect("v2 migrates to v3");
    // The serde alias carried `activeProjectId` into `default_project_id`.
    assert_eq!(reg.default_project_id(), Some("p-1"));
    // Re-saving persists under the new field name + bumps the version.
    reg.save_atomic(&file).expect("save v3");
    let saved: serde_json::Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    assert_eq!(saved["schemaVersion"], 3);
    assert_eq!(saved["defaultProjectId"], "p-1");
    assert!(
        saved.get("activeProjectId").is_none(),
        "v3 must serialize under the new field name only"
    );
    cleanup(&dir);
}

/// P4 — load drops a `default_project_id` that references a project not in
/// the file's roots (a stale id left by a deleted project must not survive
/// into the in-memory registry).
#[test]
fn load_drops_dangling_default_project_id() {
    let dir = tempdir_like("load-dangling-default");
    let root_a = real_dir(&dir, "proj-a");
    let file = dir.join("projects.json");
    write_json(
        &file,
        &serde_json::json!({
            "schemaVersion": 3,
            "defaultProjectId": "p-deleted",
            "projects": [{
                "id": "p-1", "name": "Project p-1", "path": root_a,
                "color": "blue", "isArchived": false
            }]
        })
        .to_string(),
    );
    let reg = FileProjectRegistry::load(&file).expect("load ok");
    // The dangling default is dropped (no project with id "p-deleted").
    assert_eq!(reg.default_project_id(), None);
    assert_eq!(reg.roots().len(), 1);
    cleanup(&dir);
}

#[test]
fn set_default_project_validates_before_mutating() {
    let reg_root = root("live", Path::new("/a"), false);
    let archived = root("archived", Path::new("/b"), true);
    let mut reg =
        FileProjectRegistry::from_roots(vec![reg_root, archived], Some("live".to_string()));
    assert!(reg.set_default_project("missing").is_err());
    assert_eq!(reg.default_project_id(), Some("live"));
    assert!(reg.set_default_project("archived").is_err());
    assert_eq!(reg.default_project_id(), Some("live"));
}

#[test]
fn restore_default_project_supports_persistence_rollback() {
    let dir = tempdir_like("default-rollback");
    let root_a = real_dir(&dir, "proj-a");
    let root_b = real_dir(&dir, "proj-b");
    let file = dir.join("projects.json");
    let mut reg = FileProjectRegistry::from_roots(
        vec![root("p-1", &root_a, false), root("p-2", &root_b, false)],
        Some("p-1".to_string()),
    );
    reg.save_atomic(&file).expect("seed registry");
    let previous = reg.default_project_id().map(str::to_string);
    reg.set_default_project("p-2").expect("set default");
    reg.save_atomic(&file).expect("persist default");

    reg.restore_default_project(previous);
    reg.save_atomic(&file).expect("persist rollback");
    let reloaded = FileProjectRegistry::load(&file).expect("reload rolled back registry");
    assert_eq!(reloaded.default_project_id(), Some("p-1"));
    cleanup(&dir);
}

#[test]
fn default_project_persists_across_reload() {
    let dir = tempdir_like("default-switch");
    let root_a = real_dir(&dir, "proj-a");
    let root_b = real_dir(&dir, "proj-b");
    let file = dir.join("projects.json");
    let mut reg = FileProjectRegistry::from_roots(
        vec![root("p-1", &root_a, false), root("p-2", &root_b, false)],
        Some("p-1".to_string()),
    );
    reg.save_atomic(&file).expect("seed registry");
    reg.set_default_project("p-2").expect("set default");
    reg.save_atomic(&file).expect("persist default");

    let reloaded = FileProjectRegistry::load(&file).expect("reload switched registry");
    assert_eq!(reloaded.default_project_id(), Some("p-2"));
    cleanup(&dir);
}
