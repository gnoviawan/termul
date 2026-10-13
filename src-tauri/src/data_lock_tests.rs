use super::*;

fn temp_dir(label: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!(
        "termul-data-lock-{label}-{}-{nanos}",
        std::process::id()
    ));
    fs::create_dir_all(&path).expect("create temp dir");
    path
}

#[test]
fn second_acquire_of_a_held_dir_is_busy_until_the_first_is_dropped() {
    let root = temp_dir("dir-busy");
    let dir = root.join("state");

    let mut first = DataLocks::new();
    first.lock_dir(&dir).expect("first host locks");

    let mut second = DataLocks::new();
    let error = second.lock_dir(&dir).expect_err("second host must be refused");
    assert!(error.is_busy(), "expected Busy, got {error:?}");
    let message = error.to_string();
    let canonical = fs::canonicalize(&dir).unwrap();
    assert!(
        message.contains(&canonical.display().to_string())
            && message.contains("another Termul host")
            && message.contains(&format!("by pid {}", std::process::id())),
        "message must name the path, the rival and its pid: {message}"
    );

    drop(first);
    second
        .lock_dir(&dir)
        .expect("lock is released when the holder drops");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn single_file_store_locks_a_sidecar_and_never_the_data_file() {
    let root = temp_dir("file-sidecar");
    let store = root.join("store.json");
    fs::write(&store, b"{}").unwrap();

    let mut first = DataLocks::new();
    first.lock_file(&store).unwrap();
    assert!(root.join("store.json.lock").exists());

    let mut second = DataLocks::new();
    assert!(second.lock_file(&store).unwrap_err().is_busy());

    // The data file stays replaceable by rename while the sidecar is held
    // (every store writes via temp + rename).
    crate::acp::atomic_file::replace(&store, b"{\"x\":1}").unwrap();
    assert_eq!(fs::read(&store).unwrap(), b"{\"x\":1}");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn locks_create_missing_parents() {
    let root = temp_dir("parents");
    let nested_dir = root.join("a").join("b").join("state");
    let nested_file = root.join("c").join("d").join("projects.json");

    let mut locks = DataLocks::new();
    locks.lock_dir(&nested_dir).unwrap();
    locks.lock_file(&nested_file).unwrap();

    assert!(nested_dir.join(DIR_LOCK_FILE_NAME).is_file());
    assert!(root.join("c/d/projects.json.lock").is_file());
    assert!(!nested_file.exists(), "the data file is never created");
    assert_eq!(locks.len(), 2);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn the_same_path_named_twice_is_locked_once_not_against_itself() {
    let root = temp_dir("dedupe");
    let dir = root.join("state");
    fs::create_dir_all(&dir).unwrap();
    // A non-canonical alias of the same directory.
    let alias = dir.join("..").join("state").join(".");

    let mut locks = DataLocks::new();
    locks.lock_dir(&dir).unwrap();
    locks.lock_dir(&alias).expect("alias is already held, not busy");
    locks.lock_dir(&dir).unwrap();
    assert_eq!(locks.len(), 1);
    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn symlink_aliases_share_one_lock() {
    let root = temp_dir("symlink");
    let real = root.join("real");
    fs::create_dir_all(&real).unwrap();
    let link = root.join("link");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let real_file = root.join("real-store.json");
    fs::write(&real_file, b"{}").unwrap();
    let link_file = root.join("link-store.json");
    std::os::unix::fs::symlink(&real_file, &link_file).unwrap();

    let mut ours = DataLocks::new();
    ours.lock_dir(&real).unwrap();
    ours.lock_dir(&link).expect("symlink to a held dir is the same lock");
    ours.lock_file(&real_file).unwrap();
    ours.lock_file(&link_file)
        .expect("symlink to a held file is the same lock");
    assert_eq!(ours.len(), 2);

    // Another host reaching the dir through the symlink is still refused.
    let mut rival = DataLocks::new();
    assert!(rival.lock_dir(&link).unwrap_err().is_busy());
    assert!(rival.lock_file(&link_file).unwrap_err().is_busy());
    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn a_symlink_planted_at_the_sidecar_path_is_refused_and_its_target_untouched() {
    let root = temp_dir("sidecar-symlink");
    let dir = root.join("state");
    fs::create_dir_all(&dir).unwrap();
    let victim = root.join("victim.txt");
    fs::write(&victim, b"precious").unwrap();
    std::os::unix::fs::symlink(&victim, dir.join(DIR_LOCK_FILE_NAME)).unwrap();

    let mut locks = DataLocks::new();
    let error = locks.lock_dir(&dir).expect_err("symlinked sidecar must be refused");
    assert!(!error.is_busy(), "a planted symlink is an I/O refusal: {error:?}");
    assert!(locks.is_empty());
    assert_eq!(fs::read(&victim).unwrap(), b"precious", "target not truncated/written");
    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn a_hard_link_at_the_sidecar_path_keeps_its_target_untouched() {
    let root = temp_dir("sidecar-hardlink");
    let dir = root.join("state");
    fs::create_dir_all(&dir).unwrap();
    let victim = root.join("victim.txt");
    fs::write(&victim, b"precious data").unwrap();
    fs::hard_link(&victim, dir.join(DIR_LOCK_FILE_NAME)).unwrap();

    let mut locks = DataLocks::new();
    locks.lock_dir(&dir).expect("a hard-linked sidecar still locks");
    assert_eq!(locks.len(), 1);
    assert_eq!(
        fs::read(&victim).unwrap(),
        b"precious data",
        "the pid record must not overwrite a hard-link target"
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn recorded_pid_is_readable_by_a_rival_and_never_leaves_stale_digits() {
    let root = temp_dir("pid-record");
    let dir = root.join("state");
    fs::create_dir_all(&dir).unwrap();
    // A previous (longer) record must not bleed through the new one.
    fs::write(dir.join(DIR_LOCK_FILE_NAME), "999999999999999999999999\n").unwrap();

    let mut first = DataLocks::new();
    first.lock_dir(&dir).unwrap();
    let mut second = DataLocks::new();
    match second.lock_dir(&dir).unwrap_err() {
        DataLockError::Busy { holder_pid, .. } => {
            assert_eq!(holder_pid, Some(std::process::id()));
        }
        other => panic!("expected Busy, got {other:?}"),
    }
    let _ = fs::remove_dir_all(root);
}

#[test]
fn desktop_lock_set_covers_app_data_and_its_overridable_stores() {
    let root = temp_dir("desktop");
    let app_data = root.join("com.termul.app");

    let held = lock_desktop_data(&app_data).unwrap();
    assert!(held.len() >= 6);
    let mut rival_install = DataLocks::new();
    assert!(rival_install
        .lock_dir(&app_data.join(ACP_INSTALL_DIR_NAME))
        .unwrap_err()
        .is_busy());

    // A second desktop is refused on the app data dir itself...
    assert!(lock_desktop_data(&app_data).unwrap_err().is_busy());

    // ...and a standalone server overridden into the desktop's data dir is
    // refused on the specific store it was pointed at.
    let mut rival = DataLocks::new();
    assert!(rival
        .lock_dir(&app_data.join("acp-sessions"))
        .unwrap_err()
        .is_busy());
    assert!(rival
        .lock_file(&desktop_store_file(&app_data))
        .unwrap_err()
        .is_busy());
    assert!(rival
        .lock_file(&desktop_projects_file(&app_data))
        .unwrap_err()
        .is_busy());
    drop(held);
    lock_desktop_data(&app_data).expect("released after the desktop exits");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn standalone_paths_follow_overrides_and_default_under_the_state_dir() {
    let root = temp_dir("standalone");
    let state = root.join("state");
    let mut cfg = ServerConfig::from_args(["--state-dir", state.to_str().unwrap()]).unwrap();
    cfg.store_file = None;
    cfg.acp_catalog_dir = None;

    let defaults = StandalonePaths::resolve(&cfg);
    assert_eq!(defaults.state_dir, state);
    assert_eq!(defaults.store_file, state.join("store.json"));
    assert_eq!(defaults.acp_catalog_dir, state.join("acp-catalog"));

    let elsewhere = root.join("elsewhere").join("store.json");
    cfg.store_file = Some(elsewhere.clone());
    assert_eq!(StandalonePaths::resolve(&cfg).store_file, elsewhere);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn two_standalone_hosts_on_one_state_dir_conflict_and_overlapping_overrides_dedupe() {
    let root = temp_dir("two-servers");
    let state = root.join("state");
    let cfg = ServerConfig::from_args(["--state-dir", state.to_str().unwrap()]).unwrap();
    let paths = StandalonePaths::resolve(&cfg);

    // The state dir plus defaults inside it, an override that points at the
    // state dir itself, and the default sessions dir all lock cleanly in one
    // host (no self-conflict).
    let mut overlapping = paths.clone();
    overlapping.sessions_dir = Some(state.clone());
    let first = overlapping.lock().expect("first server locks everything");

    let error = paths.lock().expect_err("second server is refused");
    assert!(error.is_busy());
    assert!(error.to_string().contains("another Termul host"));

    drop(first);
    paths.lock().expect("lockable again after the first exits");
    let _ = fs::remove_dir_all(root);
}
