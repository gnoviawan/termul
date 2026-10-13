use super::*;
use std::sync::Arc;

fn sample(id: &str, path: Option<&str>, archived: bool) -> ProjectSummary {
    ProjectSummary {
        id: id.to_string(),
        name: format!("Proj {id}"),
        color: "blue".to_string(),
        path: path.map(str::to_string),
        is_archived: archived,
        is_default: false,
    }
}

#[test]
fn snapshot_defaults_to_empty() {
    let reg = ProjectRegistry::new();
    assert!(reg.is_empty());
    let snap = reg.snapshot();
    assert!(snap.projects.is_empty());
    assert_eq!(snap.default_project_id, None);
}

#[test]
fn set_replaces_and_snapshot_round_trips() {
    let reg = ProjectRegistry::new();
    reg.set(
        vec![sample("p-1", Some("/a"), false), sample("p-2", None, true)],
        Some("p-1".to_string()),
    );
    assert_eq!(reg.len(), 2);
    let snap = reg.snapshot();
    assert_eq!(snap.default_project_id.as_deref(), Some("p-1"));
    assert_eq!(snap.projects[0].id, "p-1");
    assert!(snap.projects[1].is_archived);

    // A second set fully supersedes the first.
    reg.set(vec![sample("p-3", Some("/c"), false)], None);
    assert_eq!(reg.len(), 1);
    let snap2 = reg.snapshot();
    assert_eq!(snap2.projects[0].id, "p-3");
    assert_eq!(snap2.default_project_id, None);
}

/// F-020 regression: `upsert` recomputes `is_default` from
/// `default_project_id` — upserting the current default can never clear
/// its flag while the default still points at it, and archiving the
/// default via upsert clears `default_project_id` (P4, same posture as
/// `update`/`remove`/`load`).
#[test]
fn upsert_recomputes_default_and_clears_archived_default() {
    let reg = ProjectRegistry::new();
    reg.set(
        vec![
            sample("p-1", Some("/a"), false),
            sample("p-2", Some("/b"), false),
        ],
        Some("p-1".to_string()),
    );

    // Upserting the default with is_default:false must NOT clear the
    // flag — the default still points at p-1.
    reg.upsert(sample("p-1", Some("/a"), false));
    let snap = reg.snapshot();
    assert_eq!(snap.default_project_id.as_deref(), Some("p-1"));
    assert!(
        snap.projects
            .iter()
            .find(|p| p.id == "p-1")
            .unwrap()
            .is_default,
        "upserting the default must keep is_default=true"
    );

    // Upserting a non-default never steals the flag.
    reg.upsert(sample("p-2", Some("/b2"), false));
    let snap = reg.snapshot();
    assert_eq!(snap.default_project_id.as_deref(), Some("p-1"));
    assert!(
        !snap
            .projects
            .iter()
            .find(|p| p.id == "p-2")
            .unwrap()
            .is_default,
        "upserting a non-default must not set is_default"
    );

    // Archiving the default via upsert clears default_project_id (P4).
    reg.upsert(sample("p-1", Some("/a"), true));
    let snap = reg.snapshot();
    assert_eq!(
        snap.default_project_id, None,
        "archiving the default via upsert must clear default_project_id"
    );
    assert!(
        !snap
            .projects
            .iter()
            .find(|p| p.id == "p-1")
            .unwrap()
            .is_default,
        "archived default must not keep is_default"
    );
}

#[test]
fn find_path_resolves_known_with_cwd() {
    let reg = ProjectRegistry::new();
    reg.set(
        vec![sample("p-1", Some("/a"), false), sample("p-2", None, false)],
        Some("p-1".to_string()),
    );
    assert_eq!(reg.find_path("p-1").as_deref(), Some("/a"));
    // No cwd → None (cannot switch).
    assert_eq!(reg.find_path("p-2"), None);
    // Unknown id → None.
    assert_eq!(reg.find_path("missing"), None);
    // Whitespace-only path → None.
    reg.set(vec![sample("p-x", Some("   "), false)], None);
    assert_eq!(reg.find_path("p-x"), None);
}

#[test]
fn replacing_with_an_empty_list_empties_the_registry() {
    let reg = ProjectRegistry::new();
    reg.set(
        vec![sample("p-1", Some("/a"), false)],
        Some("p-1".to_string()),
    );
    assert!(!reg.is_empty());
    reg.set(Vec::new(), None);
    assert!(reg.is_empty());
    assert_eq!(reg.snapshot().default_project_id, None);
    // Idempotent.
    reg.set(Vec::new(), None);
    assert!(reg.is_empty());
}

#[test]
fn project_summary_serializes_camel_case_with_optional_path() {
    let with_path = sample("p-1", Some("/a"), false);
    let v = serde_json::to_value(&with_path).unwrap();
    assert_eq!(v["id"], "p-1");
    assert_eq!(v["name"], "Proj p-1");
    assert_eq!(v["color"], "blue");
    assert_eq!(v["path"], "/a");
    assert_eq!(v["isArchived"], false);
    assert_eq!(v["isDefault"], false);

    let no_path = sample("p-2", None, true);
    let v2 = serde_json::to_value(&no_path).unwrap();
    // skip_serializing_if: path omitted (not null) when None.
    assert!(v2.get("path").is_none(), "path must be omitted, not null");
    assert_eq!(v2["isArchived"], true);
}

// T5.8 — VfsRoot -> ProjectSummary mapping round-trips identity/display
// fields and redacts-by-omission (no env-var field on ProjectSummary).
#[test]
fn vfs_root_maps_to_project_summary_redacting_env() {
    use crate::acp::VfsRoot;
    use std::path::PathBuf;

    let root = VfsRoot {
        id: "p-1".to_string(),
        name: "Project p-1".to_string(),
        path: PathBuf::from("/some/cwd"),
        color: "blue".to_string(),
        is_archived: false,
        mcp_servers: Vec::new(),
    };
    let summary: ProjectSummary = root.into();
    assert_eq!(summary.id, "p-1");
    assert_eq!(summary.name, "Project p-1");
    assert_eq!(summary.color, "blue");
    assert_eq!(summary.path.as_deref(), Some("/some/cwd"));
    assert!(!summary.is_archived);
    // is_default is left false per-entry; the registry derives it from the default id.
    assert!(!summary.is_default);

    // Redact-by-omission: the wire shape carries NO env-var field.
    let v = serde_json::to_value(&summary).unwrap();
    assert!(
        v.get("envVars").is_none(),
        "ProjectSummary must not carry env-var values"
    );

    // An empty-path VfsRoot surfaces path: None (mirrors find_path's skip).
    let empty_root = VfsRoot {
        id: "p-empty".to_string(),
        name: "Empty".to_string(),
        path: PathBuf::new(),
        color: "blue".to_string(),
        is_archived: false,
        mcp_servers: Vec::new(),
    };
    let s: ProjectSummary = empty_root.into();
    assert!(
        s.path.is_none(),
        "empty VfsRoot path => ProjectSummary.path None"
    );
}

#[test]
fn default_update_keeps_snapshot_flags_consistent() {
    let reg = ProjectRegistry::new();
    reg.set(
        vec![
            sample("p-1", Some("/a"), false),
            sample("p-2", Some("/b"), false),
        ],
        Some("p-1".to_string()),
    );
    assert!(reg.set_default_project("p-2"));
    let snap = reg.snapshot();
    assert_eq!(snap.default_project_id.as_deref(), Some("p-2"));
    assert!(!snap.projects[0].is_default);
    assert!(snap.projects[1].is_default);
}

#[test]
fn set_default_project_rejects_archived_and_pathless() {
    let reg = ProjectRegistry::new();
    reg.set(
        vec![
            sample("p-1", Some("/a"), false),
            sample("p-archived", Some("/b"), true),
            sample("p-pathless", None, false),
        ],
        None,
    );
    // Unknown id rejected.
    assert!(!reg.set_default_project("missing"));
    // Archived rejected.
    assert!(!reg.set_default_project("p-archived"));
    // Pathless rejected.
    assert!(!reg.set_default_project("p-pathless"));
    // Valid switchable accepted.
    assert!(reg.set_default_project("p-1"));
    let snap = reg.snapshot();
    assert_eq!(snap.default_project_id.as_deref(), Some("p-1"));
    assert!(snap.projects[0].is_default);
    assert!(!snap.projects[1].is_default);
    assert!(!snap.projects[2].is_default);
}

#[test]
fn switch_context_rejects_archived_and_carries_private_mcp() {
    let dir = tempdir_like("mcp-context");
    let live_dir = dir.join("live");
    std::fs::create_dir_all(&live_dir).unwrap();
    let file = dir.join("projects.json");
    std::fs::write(
        &file,
        serde_json::json!({
            "schemaVersion": 4,
            "defaultProjectId": "live",
            "projects": [
                { "id": "live", "name": "Live", "path": live_dir, "color": "blue", "isArchived": false,
                  "mcpServers": [{ "name": "project-mcp", "command": "mcp-bin", "args": [], "env": [] }] },
                { "id": "old", "name": "Old", "path": live_dir, "color": "blue", "isArchived": true }
            ]
        })
        .to_string(),
    )
    .unwrap();

    let reg = ProjectRegistry::open_durable(&file, RootCheck::Strict).expect("open");
    assert!(reg.switch_context("old").is_none());
    let context = reg.switch_context("live").expect("live context");
    assert_eq!(context.cwd, live_dir.canonicalize().unwrap().to_string_lossy());
    assert_eq!(context.mcp_servers.len(), 1);
    let public = serde_json::to_value(reg.snapshot()).expect("public snapshot");
    assert!(public["projects"][0].get("mcpServers").is_none());

    // A commit rewrites the file without losing the project's MCP config.
    reg.commit_update("live", Some("Renamed".to_string()), None, None, None).unwrap();
    let reopened = ProjectRegistry::open_durable(&file, RootCheck::Strict).expect("reopen");
    assert_eq!(reopened.switch_context("live").unwrap().mcp_servers.len(), 1);
    let _ = std::fs::remove_dir_all(dir);
}

/// CAP-2 attribution: `find_by_path` resolves an exact project path, and
/// falls back to the enclosing project for a nested cwd (worktree or
/// subfolder). A prefix that does not land on a separator is NOT a match,
/// archived projects are skipped, and empty input yields `None`.
#[test]
fn find_by_path_exact_ancestor_and_boundary() {
    let reg = ProjectRegistry::new();
    reg.set(
        vec![
            sample("p-app", Some("/dev/app"), false),
            sample("p-archived", Some("/dev/old"), true),
        ],
        None,
    );
    // Exact match wins.
    assert_eq!(reg.find_by_path("/dev/app").as_deref(), Some("p-app"));
    // Nested cwd falls back to the enclosing project.
    assert_eq!(
        reg.find_by_path("/dev/app/worktrees/feat").as_deref(),
        Some("p-app")
    );
    assert_eq!(reg.find_by_path("/dev/app/sub").as_deref(), Some("p-app"));
    // Separator-boundary guard: `/dev/application` is NOT inside `/dev/app`.
    assert_eq!(reg.find_by_path("/dev/application"), None);
    // Archived projects never match.
    assert_eq!(reg.find_by_path("/dev/old"), None);
    // Unrelated path / empty input.
    assert_eq!(reg.find_by_path("/elsewhere"), None);
    assert_eq!(reg.find_by_path("   "), None);
}

/// `find_by_path` resolves the MOST SPECIFIC ancestor, not the first
/// match. With nested projects `/dev` and `/dev/app`, a cwd inside the
/// child must attribute to the child regardless of iteration order.
#[test]
fn find_by_path_picks_longest_ancestor_for_nested_projects() {
    let reg = ProjectRegistry::new();
    // Parent registered FIRST, then the child — both non-archived.
    reg.set(
        vec![
            sample("p-dev", Some("/dev"), false),
            sample("p-app", Some("/dev/app"), false),
        ],
        None,
    );
    assert_eq!(
        reg.find_by_path("/dev/app/sub").as_deref(),
        Some("p-app"),
        "child `/dev/app` must win over parent `/dev`"
    );
    // The parent itself still resolves to the parent (exact match).
    assert_eq!(reg.find_by_path("/dev/other").as_deref(), Some("p-dev"));

    // Reverse the iteration order — the child must STILL win.
    reg.set(
        vec![
            sample("p-app", Some("/dev/app"), false),
            sample("p-dev", Some("/dev"), false),
        ],
        None,
    );
    assert_eq!(
        reg.find_by_path("/dev/app/sub").as_deref(),
        Some("p-app"),
        "child must win regardless of registration order"
    );
}

// ---- Registry-only boundary: cached canonical roots ----

fn tempdir_like(label: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let p = std::env::temp_dir().join(format!(
        "termul-reg-boundary-{label}-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&p).expect("create tempdir_like");
    p.canonicalize().expect("canonicalize tempdir_like")
}

fn path_str(p: &Path) -> &str {
    p.to_str().expect("utf-8 path")
}

/// The boundary is "inside ANY registered, non-archived project": both roots
/// admit, the default pointer is irrelevant, an outside path is refused.
#[test]
fn boundary_admits_every_registered_root_regardless_of_default() {
    let (a, b) = (tempdir_like("a"), tempdir_like("b"));
    let outside = tempdir_like("out");
    let reg = ProjectRegistry::new();
    reg.set(
        vec![
            sample("p-a", Some(path_str(&a)), false),
            sample("p-b", Some(path_str(&b)), false),
        ],
        Some("p-a".to_string()),
    );
    assert!(reg.is_within_any_registered_root(&a.join("src/lib.rs")));
    assert!(reg.is_within_any_registered_root(&b));
    assert!(!reg.is_within_any_registered_root(&outside));

    assert!(reg.set_default_project("p-b"));
    assert!(
        reg.is_within_any_registered_root(&a),
        "moving the default must not move the boundary"
    );
    for d in [a, b, outside] {
        let _ = std::fs::remove_dir_all(d);
    }
}

/// Every mutator invalidates the cached roots: archive, remove, path change,
/// upsert of a new project, clear.
#[test]
fn boundary_cache_follows_set_upsert_update_remove_clear() {
    let (a, b) = (tempdir_like("ca"), tempdir_like("cb"));
    let reg = ProjectRegistry::new();
    assert!(
        !reg.is_within_any_registered_root(&a),
        "empty registry admits nothing"
    );

    reg.upsert(sample("p-a", Some(path_str(&a)), false));
    assert!(reg.is_within_any_registered_root(&a));
    assert_eq!(reg.canonical_root("p-a").as_deref(), Some(a.as_path()));

    // Path change via upsert re-points the cached root.
    reg.upsert(sample("p-a", Some(path_str(&b)), false));
    assert!(!reg.is_within_any_registered_root(&a));
    assert!(reg.is_within_any_registered_root(&b));

    // Archive drops it (and canonical_root answers None); un-archive restores.
    assert!(reg.update("p-a", None, None, Some(true)));
    assert!(!reg.is_within_any_registered_root(&b));
    assert_eq!(reg.canonical_root("p-a"), None);
    assert!(reg.update("p-a", None, None, Some(false)));
    assert!(reg.is_within_any_registered_root(&b));

    assert!(reg.remove("p-a"));
    assert!(!reg.is_within_any_registered_root(&b));

    reg.set(vec![sample("p-b", Some(path_str(&a)), false)], None);
    assert!(reg.is_within_any_registered_root(&a));
    reg.set(Vec::new(), None);
    assert!(!reg.is_within_any_registered_root(&a));
    for d in [a, b] {
        let _ = std::fs::remove_dir_all(d);
    }
}

/// A root that does not exist when registered is retried lazily, so creating
/// the directory later admits it without a registry mutation; an unresolvable
/// root never matches (and has no canonical root).
#[test]
fn unresolvable_root_is_retried_lazily() {
    let parent = tempdir_like("lazy");
    let later = parent.join("later");
    let reg = ProjectRegistry::new();
    reg.set(vec![sample("p-later", Some(path_str(&later)), false)], None);
    assert!(!reg.is_within_any_registered_root(&later));
    assert_eq!(reg.canonical_root("p-later"), None);

    std::fs::create_dir_all(&later).expect("create later");
    let canonical = later.canonicalize().expect("canonicalize later");
    assert!(reg.is_within_any_registered_root(&canonical.join("x")));
    assert_eq!(reg.canonical_root("p-later"), Some(canonical));
    let _ = std::fs::remove_dir_all(&parent);
}

/// The empty-registry seed registers exactly one default project and never
/// overrides an existing registry.
#[test]
fn seed_root_registers_one_default_project_only_when_empty() {
    let dir = tempdir_like("seed");
    let reg = ProjectRegistry::new();
    assert!(reg.seed_root_if_no_usable_project(&dir));
    let snap = reg.snapshot();
    assert_eq!(snap.projects.len(), 1);
    assert_eq!(snap.default_project_id.as_deref(), Some(SEEDED_PROJECT_ID));
    assert_eq!(snap.projects[0].path.as_deref(), Some(path_str(&dir)));
    assert!(reg.is_within_any_registered_root(&dir));
    assert_eq!(reg.canonical_root(SEEDED_PROJECT_ID), dir.canonicalize().ok());

    let other = tempdir_like("seed2");
    assert!(
        !reg.seed_root_if_no_usable_project(&other),
        "non-empty registry is left alone"
    );
    assert_eq!(reg.len(), 1);
    for d in [dir, other] {
        let _ = std::fs::remove_dir_all(d);
    }
}

/// A root deleted AFTER the last cache rebuild stops matching (and stops
/// resolving) at once, instead of staying admitted from a stale cache.
#[test]
fn root_deleted_after_caching_stops_matching() {
    let dir = tempdir_like("stale");
    let reg = ProjectRegistry::new();
    reg.set(vec![sample("p-1", Some(path_str(&dir)), false)], None);
    assert!(reg.is_within_any_registered_root(&dir));
    assert_eq!(reg.canonical_root("p-1").as_deref(), Some(dir.as_path()));

    std::fs::remove_dir_all(&dir).expect("remove project dir");
    assert!(!reg.is_within_any_registered_root(&dir.join("src")));
    assert_eq!(reg.canonical_root("p-1"), None);
}

/// A seed racing a renderer sync never overwrites the synced list: whichever
/// order they land in, the synced projects win.
#[test]
fn seed_never_overwrites_a_concurrent_set() {
    let dir = tempdir_like("race");
    for _ in 0..50 {
        let reg = Arc::new(ProjectRegistry::new());
        let seeder = {
            let (reg, dir) = (Arc::clone(&reg), dir.clone());
            std::thread::spawn(move || reg.seed_root_if_no_usable_project(&dir))
        };
        reg.set(
            vec![sample("synced", Some(path_str(&dir)), false)],
            Some("synced".to_string()),
        );
        seeder.join().expect("seeder thread");
        let snap = reg.snapshot();
        assert_eq!(snap.projects.len(), 1);
        assert_eq!(snap.projects[0].id, "synced");
        assert_eq!(snap.default_project_id.as_deref(), Some("synced"));
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// A real usable project retires the synthetic seed and takes over as default;
/// the seed is also (re)planted when only archived/pathless projects exist.
#[test]
fn seed_is_retired_by_a_real_project_and_planted_when_none_is_usable() {
    let (seed_dir, real_dir) = (tempdir_like("sd"), tempdir_like("rl"));
    let reg = ProjectRegistry::new();
    reg.set(
        vec![
            sample("arch", Some(path_str(&real_dir)), true),
            sample("nopath", None, false),
        ],
        None,
    );
    assert!(
        reg.seed_root_if_no_usable_project(&seed_dir),
        "no usable project ⇒ seed"
    );
    assert_eq!(reg.len(), 3);
    assert!(reg.is_within_any_registered_root(&seed_dir));
    assert!(
        !reg.is_within_any_registered_root(&real_dir),
        "archived project stays outside"
    );

    reg.upsert(sample("real", Some(path_str(&real_dir)), false));
    let snap = reg.snapshot();
    assert!(
        snap.projects.iter().all(|p| p.id != SEEDED_PROJECT_ID),
        "seed retired"
    );
    assert_eq!(snap.default_project_id.as_deref(), Some("real"));
    assert!(reg.is_within_any_registered_root(&real_dir));
    assert!(
        !reg.is_within_any_registered_root(&seed_dir),
        "retired seed leaves the boundary"
    );
    for d in [seed_dir, real_dir] {
        let _ = std::fs::remove_dir_all(d);
    }
}

/// A read never uses a cache that is behind a mutation: even when the cache
/// rebuild has not run yet (mutator released the lock, rebuild pending), an
/// archived project is already outside the boundary.
#[test]
fn boundary_read_rebuilds_a_cache_that_is_behind_a_mutation() {
    let dir = tempdir_like("epoch");
    let reg = ProjectRegistry::new();
    reg.set(vec![sample("p-1", Some(path_str(&dir)), false)], None);
    assert!(reg.is_within_any_registered_root(&dir));

    // Simulate the window: the mutation landed, its rebuild has not.
    {
        let mut g = reg.inner.lock();
        g.projects[0].is_archived = true;
        reg.epoch.fetch_add(1, Ordering::AcqRel);
    }
    assert!(
        !reg.is_within_any_registered_root(&dir),
        "archived project must not be admitted"
    );
    assert_eq!(reg.canonical_root("p-1"), None);
    let _ = std::fs::remove_dir_all(&dir);
}
