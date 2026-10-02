use super::*;

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
fn clear_empties_the_mirror() {
    let reg = ProjectRegistry::new();
    reg.set(
        vec![sample("p-1", Some("/a"), false)],
        Some("p-1".to_string()),
    );
    assert!(!reg.is_empty());
    reg.clear();
    assert!(reg.is_empty());
    assert_eq!(reg.snapshot().default_project_id, None);
    // Clear is idempotent.
    reg.clear();
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

#[test]
fn projects_changed_payload_omits_none_default() {
    let p = ProjectsChangedPayload {
        default_project_id: None,
    };
    let v = serde_json::to_value(&p).unwrap();
    assert!(v.get("defaultProjectId").is_none());
    let p2 = ProjectsChangedPayload {
        default_project_id: Some("p-3".to_string()),
    };
    let v2 = serde_json::to_value(&p2).unwrap();
    assert_eq!(v2["defaultProjectId"], "p-3");
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
    // is_default is left false per-entry; seed_from_file derives it.
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
    use agent_client_protocol::schema::v1::{McpServer, McpServerStdio};

    let reg = ProjectRegistry::new();
    reg.set(
        vec![
            sample("live", Some("/a"), false),
            sample("old", Some("/b"), true),
        ],
        Some("live".to_string()),
    );
    reg.mcp_servers.lock().insert(
        "live".to_string(),
        vec![McpServer::Stdio(McpServerStdio::new(
            "project-mcp",
            std::path::PathBuf::from("mcp-bin"),
        ))],
    );
    assert!(reg.switch_context("old").is_none());
    let context = reg.switch_context("live").expect("live context");
    assert_eq!(context.cwd, "/a");
    assert_eq!(context.mcp_servers.len(), 1);
    let public = serde_json::to_value(reg.snapshot()).expect("public snapshot");
    assert!(public["projects"][0].get("mcpServers").is_none());
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

// ---- CAP-1: live project_root rebind edge cases ----

fn tempdir_like(label: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let p = std::env::temp_dir().join(format!(
        "termul-reg-rebind-{label}-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&p).expect("create tempdir_like");
    p
}

/// Row: "No default / empty path → warn! + keep the prior boundary" and
/// "No handle registered → no-op". With no handle registered, `set` on a
/// registry with no default must be a silent no-op (the start path falls
/// back to home separately; the rebind never widens mid-run).
#[test]
fn rebind_is_noop_when_no_handle_registered() {
    let reg = ProjectRegistry::new();
    // No handle set — set() must not panic and must not rebind anything.
    reg.set(vec![sample("p-1", Some("/a"), false)], None);
    // No default → default_project_path is None.
    assert!(reg.default_project_path().is_none());
}

/// Row: empty registry / no default at start. The rebind, when a handle IS
/// registered but the registry has no default, must keep the prior boundary
/// (do not widen to home mid-run; only the START path falls back to home).
#[test]
fn rebind_keeps_prior_boundary_when_no_default() {
    let reg = ProjectRegistry::new();
    let prior = PathBuf::from("/prior/boundary");
    let handle: Arc<RwLock<PathBuf>> = Arc::new(RwLock::new(prior.clone()));
    reg.set_project_root_handle(Arc::clone(&handle));
    // set() with no default → rebind skips (warns, keeps prior).
    reg.set(vec![sample("p-1", Some("/a"), false)], None);
    assert_eq!(
        *handle.read(),
        prior,
        "rebind with no default must keep the prior boundary, not widen"
    );
}

/// Row: canonicalization failure (deleted/moved default path) keeps the
/// prior boundary — a transient failure does not widen the jail.
#[test]
fn rebind_keeps_prior_boundary_when_default_path_unresolvable() {
    let reg = ProjectRegistry::new();
    let prior = PathBuf::from("/prior/boundary");
    let handle: Arc<RwLock<PathBuf>> = Arc::new(RwLock::new(prior.clone()));
    reg.set_project_root_handle(Arc::clone(&handle));
    // A default project whose path does NOT exist on disk — canonicalize
    // fails, so the rebind must keep the prior boundary.
    reg.set(
        vec![sample("p-ghost", Some("/this/path/does/not/exist"), false)],
        Some("p-ghost".to_string()),
    );
    assert_eq!(
        *handle.read(),
        prior,
        "rebind on an unresolvable default path must keep the prior boundary"
    );
}

/// Row: success path — rebind writes the canonical default path to the
/// handle so the containment boundary follows the active project.
#[test]
fn rebind_writes_canonical_default_path_to_handle() {
    let dir = tempdir_like("ok");
    let reg = ProjectRegistry::new();
    let prior = PathBuf::from("/prior/boundary");
    let handle: Arc<RwLock<PathBuf>> = Arc::new(RwLock::new(prior));
    reg.set_project_root_handle(Arc::clone(&handle));
    reg.set(
        vec![sample("p-live", Some(dir.to_str().unwrap()), false)],
        Some("p-live".to_string()),
    );
    let bound = handle.read().clone();
    assert!(
        bound.is_absolute(),
        "rebind must write a canonical absolute path, got: {}",
        bound.display()
    );
    // The canonical form must resolve to the same real directory (a second
    // canonicalize is idempotent).
    let again = bound.canonicalize().expect("canonicalize again");
    assert_eq!(bound, again, "rebind must write the canonical form");
    assert_ne!(
        bound,
        PathBuf::from("/prior/boundary"),
        "rebind must replace the prior boundary with the active project's path"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// `set_default_project` triggers a rebind too — switching the default
/// updates the handle to the new default's canonical path.
#[test]
fn set_default_project_rebinds_to_new_default_path() {
    let dir_a = tempdir_like("a");
    let dir_b = tempdir_like("b");
    let reg = ProjectRegistry::new();
    let handle: Arc<RwLock<PathBuf>> = Arc::new(RwLock::new(PathBuf::from("/prior")));
    reg.set_project_root_handle(Arc::clone(&handle));
    reg.set(
        vec![
            sample("p-a", Some(dir_a.to_str().unwrap()), false),
            sample("p-b", Some(dir_b.to_str().unwrap()), false),
        ],
        Some("p-a".to_string()),
    );
    let first = handle.read().clone();
    assert_eq!(
        first.canonicalize().expect("canonicalize a"),
        first,
        "initial rebind binds to p-a's canonical path"
    );
    // Switch default to p-b → rebind updates the handle.
    assert!(reg.set_default_project("p-b"));
    let second = handle.read().clone();
    assert_ne!(second, first, "switching default must rebind the boundary");
    assert_eq!(
        second.canonicalize().expect("canonicalize b"),
        second,
        "rebind after switch writes p-b's canonical path"
    );
    let _ = std::fs::remove_dir_all(&dir_a);
    let _ = std::fs::remove_dir_all(&dir_b);
}
