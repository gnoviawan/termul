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

/// Backdate a file so the in-use guard does not mistake it for a live write.
fn age(path: &Path) {
    let old = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
    fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(old)
        .unwrap();
}

#[cfg(unix)]
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

// On Unix a real shared directory is user data and is left alone; on Windows it
// is a privately created entry from a failed `symlink_dir` and gets migrated
// (see the Windows tests below), so this behavior is Unix-only.
#[cfg(unix)]
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
fn merge_dir_copies_new_files_keeping_the_relative_layout() {
    let root = tempfile::tempdir().unwrap();
    let src = root.path().join("private");
    let dst = root.path().join("shared");
    fs::create_dir_all(src.join("sub")).unwrap();
    fs::create_dir_all(&dst).unwrap();
    fs::write(src.join("top.jsonl"), b"top").unwrap();
    fs::write(src.join("sub").join("deep.jsonl"), b"deep").unwrap();

    links::merge_dir(&src, &dst).unwrap();

    assert_eq!(fs::read(dst.join("top.jsonl")).unwrap(), b"top");
    assert_eq!(fs::read(dst.join("sub").join("deep.jsonl")).unwrap(), b"deep");
    // merge_dir copies; the caller removes the private dir afterwards.
    assert!(src.join("top.jsonl").is_file());
}

#[test]
fn merge_dir_never_overwrites_an_existing_shared_name() {
    let root = tempfile::tempdir().unwrap();
    let src = root.path().join("private");
    let dst = root.path().join("shared");
    fs::create_dir_all(src.join("sub")).unwrap();
    fs::create_dir_all(dst.join("sub")).unwrap();
    fs::write(src.join("same.jsonl"), b"private").unwrap();
    fs::write(dst.join("same.jsonl"), b"shared").unwrap();
    fs::write(src.join("sub").join("new.jsonl"), b"new").unwrap();

    links::merge_dir(&src, &dst).unwrap();

    // The shared copy wins the name conflict and is never overwritten.
    assert_eq!(fs::read(dst.join("same.jsonl")).unwrap(), b"shared");
    // A uniquely named private file is still merged in.
    assert_eq!(fs::read(dst.join("sub").join("new.jsonl")).unwrap(), b"new");
}

#[test]
fn a_clashing_private_file_is_kept_next_to_the_shared_one() {
    let root = tempfile::tempdir().unwrap();
    let src = root.path().join("private");
    let dst = root.path().join("shared");
    fs::create_dir_all(src.join("sub")).unwrap();
    fs::create_dir_all(dst.join("sub")).unwrap();
    fs::write(src.join("same.jsonl"), b"private").unwrap();
    fs::write(dst.join("same.jsonl"), b"shared").unwrap();
    fs::write(src.join("sub").join("deep.jsonl"), b"private deep").unwrap();
    fs::write(dst.join("sub").join("deep.jsonl"), b"shared deep").unwrap();

    links::merge_dir(&src, &dst).unwrap();

    // Both versions survive; the shared name keeps the shared content.
    assert_eq!(fs::read(dst.join("same.jsonl")).unwrap(), b"shared");
    assert_eq!(
        fs::read(dst.join("same.jsonl.private-backup")).unwrap(),
        b"private"
    );
    assert_eq!(
        fs::read(dst.join("sub").join("deep.jsonl")).unwrap(),
        b"shared deep"
    );
    assert_eq!(
        fs::read(dst.join("sub").join("deep.jsonl.private-backup")).unwrap(),
        b"private deep"
    );
}

#[test]
fn an_identical_private_file_is_not_duplicated() {
    let root = tempfile::tempdir().unwrap();
    let src = root.path().join("private");
    let dst = root.path().join("shared");
    fs::create_dir_all(&src).unwrap();
    fs::create_dir_all(&dst).unwrap();
    fs::write(src.join("same.jsonl"), b"identical").unwrap();
    fs::write(dst.join("same.jsonl"), b"identical").unwrap();

    links::merge_dir(&src, &dst).unwrap();

    assert!(!dst.join("same.jsonl.private-backup").exists());
    assert_eq!(fs::read(dst.join("same.jsonl")).unwrap(), b"identical");
}

#[test]
fn a_taken_backup_name_gets_a_numeric_suffix_and_a_rerun_adds_nothing() {
    let root = tempfile::tempdir().unwrap();
    let src = root.path().join("private");
    let dst = root.path().join("shared");
    fs::create_dir_all(&src).unwrap();
    fs::create_dir_all(&dst).unwrap();
    fs::write(src.join("a.jsonl"), b"private").unwrap();
    fs::write(dst.join("a.jsonl"), b"shared").unwrap();
    fs::write(dst.join("a.jsonl.private-backup"), b"someone else's backup").unwrap();

    links::merge_dir(&src, &dst).unwrap();

    assert_eq!(
        fs::read(dst.join("a.jsonl.private-backup")).unwrap(),
        b"someone else's backup"
    );
    assert_eq!(
        fs::read(dst.join("a.jsonl.private-backup-2")).unwrap(),
        b"private"
    );

    // An interrupted migration runs again over the same private dir.
    links::merge_dir(&src, &dst).unwrap();
    assert!(!dst.join("a.jsonl.private-backup-3").exists());
}

#[test]
fn a_private_file_clashing_with_a_shared_directory_is_kept_under_a_backup_name() {
    let root = tempfile::tempdir().unwrap();
    let src = root.path().join("private");
    let dst = root.path().join("shared");
    fs::create_dir_all(&src).unwrap();
    fs::create_dir_all(dst.join("name")).unwrap();
    fs::write(src.join("name"), b"private file").unwrap();

    links::merge_dir(&src, &dst).unwrap();

    assert!(dst.join("name").is_dir());
    assert_eq!(
        fs::read(dst.join("name.private-backup")).unwrap(),
        b"private file"
    );
}

/// Link creation for the migration tests: a symlink on Unix, a junction on
/// Windows (what the Windows migration uses).
fn make_link(target: &Path, link: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link)
    }
    #[cfg(windows)]
    {
        crate::junction::create_junction(target, link).map_err(std::io::Error::other)
    }
}

/// `<root>/account/projects` (private) and `<root>/shared/projects`.
struct MigrationFixture {
    _root: tempfile::TempDir,
    account: PathBuf,
    private: PathBuf,
    shared: PathBuf,
}

fn migration_fixture() -> MigrationFixture {
    let root = tempfile::tempdir().unwrap();
    let account = root.path().join("account");
    let private = account.join("projects");
    let shared = root.path().join("shared").join("projects");
    fs::create_dir_all(&private).unwrap();
    fs::create_dir_all(&shared).unwrap();
    MigrationFixture {
        account,
        private,
        shared,
        _root: root,
    }
}

fn migrating_leftovers(account: &Path) -> Vec<String> {
    fs::read_dir(account)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.contains(".migrating"))
        .collect()
}

fn never_link(_: &Path, _: &Path) -> std::io::Result<()> {
    panic!("the link must not be created");
}

#[test]
fn migration_keeps_both_versions_of_a_clashing_file_and_links_the_dir() {
    let f = migration_fixture();
    fs::write(f.private.join("s.jsonl"), b"private").unwrap();
    fs::write(f.private.join("only.jsonl"), b"only private").unwrap();
    fs::write(f.shared.join("s.jsonl"), b"shared").unwrap();
    age(&f.private.join("s.jsonl"));
    age(&f.private.join("only.jsonl"));

    assert!(links::migrate_private_dir(
        &f.account, "projects", &f.shared, make_link
    ));

    // The private dir is now a link to the shared one, and no temporary copy
    // is left behind.
    assert!(fs::symlink_metadata(&f.private)
        .unwrap()
        .file_type()
        .is_symlink());
    assert!(migrating_leftovers(&f.account).is_empty());
    assert_eq!(fs::read(f.shared.join("s.jsonl")).unwrap(), b"shared");
    assert_eq!(
        fs::read(f.shared.join("s.jsonl.private-backup")).unwrap(),
        b"private"
    );
    assert_eq!(
        fs::read(f.shared.join("only.jsonl")).unwrap(),
        b"only private"
    );
    assert_eq!(
        fs::read(f.private.join("only.jsonl")).unwrap(),
        b"only private"
    );
}

#[test]
fn a_failed_merge_keeps_the_private_dir_and_every_file_in_it() {
    let f = migration_fixture();
    fs::create_dir_all(f.private.join("sub")).unwrap();
    fs::write(f.private.join("top.jsonl"), b"top").unwrap();
    fs::write(f.private.join("sub").join("deep.jsonl"), b"deep").unwrap();
    // A shared FILE where the private side has a directory: the merge cannot
    // create `sub` and stops with an error.
    fs::write(f.shared.join("sub"), b"a file").unwrap();
    age(&f.private.join("top.jsonl"));
    age(&f.private.join("sub").join("deep.jsonl"));

    assert!(!links::migrate_private_dir(
        &f.account, "projects", &f.shared, never_link
    ));

    assert!(fs::symlink_metadata(&f.private).unwrap().is_dir());
    assert_eq!(fs::read(f.private.join("top.jsonl")).unwrap(), b"top");
    assert_eq!(
        fs::read(f.private.join("sub").join("deep.jsonl")).unwrap(),
        b"deep"
    );
    assert_eq!(fs::read(f.shared.join("sub")).unwrap(), b"a file");
    assert!(migrating_leftovers(&f.account).is_empty());
}

#[test]
fn a_failed_link_restores_the_private_dir_in_full() {
    let f = migration_fixture();
    fs::create_dir_all(f.private.join("proj")).unwrap();
    fs::write(f.private.join("a.jsonl"), b"a").unwrap();
    fs::write(f.private.join("proj").join("b.jsonl"), b"b").unwrap();
    age(&f.private.join("a.jsonl"));
    age(&f.private.join("proj").join("b.jsonl"));

    let migrated = links::migrate_private_dir(&f.account, "projects", &f.shared, |_, _| {
        Err(std::io::Error::other("link refused"))
    });

    assert!(!migrated);
    assert!(fs::symlink_metadata(&f.private).unwrap().is_dir());
    assert_eq!(fs::read(f.private.join("a.jsonl")).unwrap(), b"a");
    assert_eq!(
        fs::read(f.private.join("proj").join("b.jsonl")).unwrap(),
        b"b"
    );
    assert!(migrating_leftovers(&f.account).is_empty());
}

#[test]
fn a_partial_link_left_by_a_failed_link_is_cleared_before_the_restore() {
    let f = migration_fixture();
    fs::write(f.private.join("a.jsonl"), b"a").unwrap();
    age(&f.private.join("a.jsonl"));

    // The link step leaves an empty directory behind, then fails.
    let migrated = links::migrate_private_dir(&f.account, "projects", &f.shared, |_, at| {
        fs::create_dir(at)?;
        Err(std::io::Error::other("link refused"))
    });

    assert!(!migrated);
    assert_eq!(fs::read(f.private.join("a.jsonl")).unwrap(), b"a");
    assert!(migrating_leftovers(&f.account).is_empty());
}

#[test]
fn a_leftover_temporary_name_is_not_reused() {
    let f = migration_fixture();
    fs::create_dir_all(f.account.join("projects.migrating")).unwrap();
    fs::write(f.account.join("projects.migrating").join("old"), b"old").unwrap();
    fs::write(f.private.join("a.jsonl"), b"a").unwrap();
    age(&f.private.join("a.jsonl"));

    assert!(links::migrate_private_dir(
        &f.account, "projects", &f.shared, make_link
    ));

    // The earlier leftover is untouched; the new temporary copy is gone.
    assert_eq!(
        fs::read(f.account.join("projects.migrating").join("old")).unwrap(),
        b"old"
    );
    assert!(!f.account.join("projects.migrating-2").exists());
}

#[test]
fn a_private_dir_with_a_recent_write_is_left_untouched() {
    let f = migration_fixture();
    fs::create_dir_all(f.private.join("proj")).unwrap();
    fs::write(f.private.join("old.jsonl"), b"old").unwrap();
    age(&f.private.join("old.jsonl"));
    // A chat in progress is appending to its session file right now.
    fs::write(f.private.join("proj").join("live.jsonl"), b"live").unwrap();

    assert!(!links::migrate_private_dir(
        &f.account, "projects", &f.shared, never_link
    ));

    assert_eq!(fs::read(f.private.join("old.jsonl")).unwrap(), b"old");
    assert_eq!(
        fs::read(f.private.join("proj").join("live.jsonl")).unwrap(),
        b"live"
    );
    assert_eq!(
        fs::read_dir(&f.shared).unwrap().count(),
        0,
        "nothing is merged while the dir looks in use"
    );

    // Once the write is old enough, the next round migrates it.
    age(&f.private.join("proj").join("live.jsonl"));
    assert!(links::migrate_private_dir(
        &f.account, "projects", &f.shared, make_link
    ));
    assert_eq!(
        fs::read(f.shared.join("proj").join("live.jsonl")).unwrap(),
        b"live"
    );
}

#[cfg(unix)]
#[test]
fn migration_refuses_to_act_through_a_link() {
    let f = migration_fixture();
    // `account/linked` is a symlink to a real directory elsewhere.
    let elsewhere = f.account.parent().unwrap().join("elsewhere");
    fs::create_dir_all(&elsewhere).unwrap();
    fs::write(elsewhere.join("keep.jsonl"), b"keep").unwrap();
    age(&elsewhere.join("keep.jsonl"));
    std::os::unix::fs::symlink(&elsewhere, f.account.join("linked")).unwrap();

    assert!(!links::migrate_private_dir(
        &f.account, "linked", &f.shared, never_link
    ));

    assert_eq!(fs::read(elsewhere.join("keep.jsonl")).unwrap(), b"keep");
    assert!(fs::symlink_metadata(f.account.join("linked"))
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(fs::read_dir(&f.shared).unwrap().count(), 0);
}

#[test]
fn only_a_real_directory_directly_under_the_account_may_be_removed() {
    let f = migration_fixture();
    // A real directory directly under the account is accepted.
    assert!(links::ensure_real_dir_under(&f.private, &f.account).is_ok());
    // A directory one level deeper, a file, and a missing path are refused.
    fs::create_dir_all(f.private.join("nested")).unwrap();
    assert!(links::ensure_real_dir_under(&f.private.join("nested"), &f.account).is_err());
    fs::write(f.account.join("file"), b"x").unwrap();
    assert!(links::ensure_real_dir_under(&f.account.join("file"), &f.account).is_err());
    assert!(links::ensure_real_dir_under(&f.account.join("missing"), &f.account).is_err());
    // A directory that lives under a different parent is refused.
    assert!(links::ensure_real_dir_under(&f.shared, &f.account).is_err());
}

#[cfg(unix)]
#[test]
fn a_symlink_is_not_a_real_directory_for_removal() {
    let f = migration_fixture();
    let link = f.account.join("projects-link");
    std::os::unix::fs::symlink(&f.shared, &link).unwrap();
    assert!(links::ensure_real_dir_under(&link, &f.account).is_err());
}

#[cfg(windows)]
#[test]
fn a_directory_entry_is_linked_with_a_junction_to_the_shared_target() {
    use std::os::windows::fs::MetadataExt as _;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

    let f = fixture();
    let account = f.state.join("acct");
    fs::write(f.shared.join("projects").join("shared.jsonl"), b"s").unwrap();

    // A junction needs no symlink privilege, so linking succeeds unprivileged.
    let failed = links::ensure_links(&f.shared, &account).unwrap();
    assert_eq!(failed, 0);

    let link = account.join("projects");
    let attributes = fs::symlink_metadata(&link).unwrap().file_attributes();
    assert_ne!(
        attributes & FILE_ATTRIBUTE_REPARSE_POINT,
        0,
        "projects is a reparse point (junction)"
    );
    assert_eq!(
        fs::canonicalize(&link).unwrap(),
        fs::canonicalize(f.shared.join("projects")).unwrap()
    );
    assert!(link.join("shared.jsonl").is_file());
}

#[cfg(windows)]
#[test]
fn a_private_directory_is_merged_into_the_shared_dir_and_replaced_with_a_junction() {
    let f = fixture();
    let account = f.state.join("acct");
    fs::create_dir_all(account.join("projects").join("proj")).unwrap();
    fs::write(
        account.join("projects").join("proj").join("session.jsonl"),
        b"private",
    )
    .unwrap();
    fs::write(f.shared.join("projects").join("existing.jsonl"), b"shared").unwrap();

    age(&account.join("projects").join("proj").join("session.jsonl"));

    let failed = links::ensure_links(&f.shared, &account).unwrap();
    assert_eq!(failed, 0);

    // The private session moved into the shared dir, keeping its layout.
    assert_eq!(
        fs::read(f.shared.join("projects").join("proj").join("session.jsonl")).unwrap(),
        b"private"
    );
    // The private dir is now a junction that sees every shared project.
    let link = account.join("projects");
    assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
    assert!(link.join("existing.jsonl").is_file());
    assert!(link.join("proj").join("session.jsonl").is_file());
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
