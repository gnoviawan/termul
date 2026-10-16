use super::{links, ClaudeAccountStore, BUILTIN_ACCOUNT_ID};
use std::fs;
use std::path::{Path, PathBuf};

struct Fixture {
    _root: tempfile::TempDir,
    state: PathBuf,
    shared: PathBuf,
}

fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let state = root.path().join("state");
    let shared = root.path().join("shared-claude");
    fs::create_dir_all(shared.join("projects")).unwrap();
    fs::write(shared.join("settings.json"), b"{}").unwrap();
    Fixture {
        state,
        shared,
        _root: root,
    }
}

fn store(f: &Fixture) -> ClaudeAccountStore {
    ClaudeAccountStore::new(&f.state, f.shared.clone())
}

fn is_link_to(link: &Path, target: &Path) -> bool {
    fs::symlink_metadata(link).is_ok_and(|m| m.file_type().is_symlink())
        && fs::read_link(link).is_ok_and(|t| t == target)
}

#[test]
fn a_new_store_has_only_the_builtin_default_account() {
    let f = fixture();
    let snapshot = store(&f).snapshot().unwrap();
    assert_eq!(snapshot.profiles.len(), 1);
    assert!(snapshot.profiles[0].builtin);
    assert_eq!(snapshot.default_account_id, BUILTIN_ACCOUNT_ID);
    assert!(snapshot.project_profiles.is_empty());
    assert_eq!(store(&f).resolve(Some("p1")).config_dir, None);
}

#[cfg(unix)]
#[test]
fn add_creates_a_linked_account_dir_and_keeps_the_login_private() {
    let f = fixture();
    let account = store(&f).add("  Work  ").unwrap();
    assert_eq!(account.name, "Work");
    let dir = store(&f).config_dir(&account.id).unwrap();
    assert!(is_link_to(
        &dir.join("projects"),
        &f.shared.join("projects")
    ));
    assert!(is_link_to(
        &dir.join("settings.json"),
        &f.shared.join("settings.json")
    ));
    // A missing shared dir is created in the shared root, then linked.
    assert!(f.shared.join("skills").is_dir());
    assert!(is_link_to(&dir.join("skills"), &f.shared.join("skills")));
    // A missing shared file is not linked.
    assert!(fs::symlink_metadata(dir.join("CLAUDE.md")).is_err());
    // The login file and `.claude.json` are never links.
    assert!(!links::SHARED_FILES.contains(&".claude.json"));
    assert!(!links::SHARED_FILES.contains(&".credentials.json"));
}

#[test]
fn add_rejects_empty_long_and_duplicate_names() {
    let f = fixture();
    let s = store(&f);
    assert!(s.add("   ").is_err());
    assert!(s.add(&"x".repeat(41)).is_err());
    assert!(s.add("bad\nname").is_err());
    s.add("Work").unwrap();
    assert!(s.add("work").is_err());
    assert!(s.add("default").is_err());
}

#[test]
fn a_project_uses_its_account_and_others_use_the_default() {
    let f = fixture();
    let s = store(&f);
    let work = s.add("Work").unwrap();
    let personal = s.add("Personal").unwrap();
    s.set_project_account("office", Some(&work.id)).unwrap();
    s.set_default(&personal.id).unwrap();

    let office = s.resolve(Some("office"));
    assert_eq!(office.account_id, work.id);
    assert_eq!(office.account_name, "Work");
    assert_eq!(office.config_dir, s.config_dir(&work.id));

    let other = s.resolve(Some("side-project"));
    assert_eq!(other.account_id, personal.id);
    assert_eq!(s.resolve(None).account_id, personal.id);

    s.set_project_account("office", None).unwrap();
    assert_eq!(s.resolve(Some("office")).account_id, personal.id);
}

#[test]
fn set_rejects_unknown_accounts_and_empty_projects() {
    let f = fixture();
    let s = store(&f);
    assert!(s.set_default("abc123").is_err());
    assert!(s.set_project_account("p1", Some("abc123")).is_err());
    assert!(s.set_project_account("  ", None).is_err());
}

#[test]
fn remove_moves_projects_back_and_keeps_shared_data() {
    let f = fixture();
    let s = store(&f);
    let work = s.add("Work").unwrap();
    s.set_project_account("office", Some(&work.id)).unwrap();
    s.set_default(&work.id).unwrap();
    fs::write(f.shared.join("projects").join("keep.jsonl"), b"x").unwrap();
    let dir = s.config_dir(&work.id).unwrap();
    fs::write(dir.join(".claude.json"), b"{}").unwrap();

    let moved = s.remove(&work.id).unwrap();
    assert_eq!(moved, vec!["office".to_string()]);
    assert!(!dir.exists());
    assert!(f.shared.join("projects").join("keep.jsonl").is_file());
    assert!(f.shared.join("settings.json").is_file());
    let snapshot = s.snapshot().unwrap();
    assert_eq!(snapshot.default_account_id, BUILTIN_ACCOUNT_ID);
    assert!(snapshot.project_profiles.is_empty());
}

#[test]
fn the_builtin_account_cannot_be_removed() {
    let f = fixture();
    assert!(store(&f).remove(BUILTIN_ACCOUNT_ID).is_err());
}

#[test]
fn rename_changes_the_name_and_rejects_duplicates() {
    let f = fixture();
    let s = store(&f);
    let work = s.add("Work").unwrap();
    s.add("Personal").unwrap();
    s.rename(&work.id, "Office").unwrap();
    assert_eq!(s.resolve(None).account_name, "Default");
    assert!(s
        .snapshot()
        .unwrap()
        .profiles
        .iter()
        .any(|a| a.name == "Office"));
    assert!(s.rename(&work.id, "personal").is_err());
    s.rename(BUILTIN_ACCOUNT_ID, "PERSONAL").unwrap_err();
    s.rename(BUILTIN_ACCOUNT_ID, "Main").unwrap();
    assert_eq!(s.resolve(None).account_name, "Main");
}

#[cfg(unix)]
#[test]
fn resolve_repairs_a_removed_link() {
    let f = fixture();
    let s = store(&f);
    let work = s.add("Work").unwrap();
    s.set_default(&work.id).unwrap();
    let dir = s.config_dir(&work.id).unwrap();
    fs::remove_file(dir.join("projects")).unwrap();
    let _ = s.resolve(None);
    assert!(is_link_to(
        &dir.join("projects"),
        &f.shared.join("projects")
    ));
}

#[test]
fn links_never_replace_a_real_entry() {
    let f = fixture();
    let account = f.state.join("acct");
    fs::create_dir_all(account.join("projects")).unwrap();
    fs::write(account.join("projects").join("own.jsonl"), b"x").unwrap();
    let failed = links::ensure_links(&f.shared, &account).unwrap();
    assert_eq!(failed, 1);
    assert!(account.join("projects").join("own.jsonl").is_file());
}

#[test]
fn a_damaged_store_fails_mutations_but_resolves_to_the_builtin_account() {
    let f = fixture();
    fs::create_dir_all(&f.state).unwrap();
    fs::write(f.state.join("claude-accounts.json"), b"{not json").unwrap();
    let s = store(&f);
    assert!(s.add("Work").is_err());
    let resolution = s.resolve(Some("p1"));
    assert_eq!(resolution.account_id, BUILTIN_ACCOUNT_ID);
    assert_eq!(resolution.config_dir, None);
}

#[test]
fn a_newer_store_version_is_refused() {
    let f = fixture();
    fs::create_dir_all(&f.state).unwrap();
    fs::write(
        f.state.join("claude-accounts.json"),
        br#"{"version":99,"accounts":[],"defaultAccountId":"default"}"#,
    )
    .unwrap();
    assert!(store(&f).snapshot().is_err());
}

#[test]
fn a_stale_project_choice_falls_back_to_the_default() {
    let f = fixture();
    fs::create_dir_all(&f.state).unwrap();
    fs::write(
        f.state.join("claude-accounts.json"),
        br#"{"version":1,"accounts":[],"defaultAccountId":"gone","projectAccounts":{"p1":"gone"}}"#,
    )
    .unwrap();
    let s = store(&f);
    let snapshot = s.snapshot().unwrap();
    assert_eq!(snapshot.default_account_id, BUILTIN_ACCOUNT_ID);
    assert!(snapshot.project_profiles.is_empty());
    assert_eq!(s.resolve(Some("p1")).account_id, BUILTIN_ACCOUNT_ID);
}

#[test]
fn account_ids_that_are_not_hex_never_map_to_a_path() {
    let f = fixture();
    let s = store(&f);
    assert_eq!(s.config_dir("../escape"), None);
    assert_eq!(s.config_dir(BUILTIN_ACCOUNT_ID), None);
}
