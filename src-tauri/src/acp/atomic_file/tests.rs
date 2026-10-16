use super::*;

fn temp_dir(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "termul-atomic-{label}-{}-{}",
        std::process::id(),
        unique_suffix()
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

#[test]
fn round_trip_replacement_and_no_temp_leak() {
    let dir = temp_dir("replace");
    let target = dir.join("state.json");
    replace(&target, b"old").unwrap();
    replace(&target, b"new").unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"new");
    let entries: Vec<_> = fs::read_dir(&dir).unwrap().flatten().collect();
    assert_eq!(entries.len(), 1);
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn temp_file_is_same_directory() {
    let dir = temp_dir("same-dir");
    let target = dir.join("state.json");
    assert_eq!(temp_path(&target).parent(), Some(dir.as_path()));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn precommit_failure_preserves_old_target() {
    let dir = temp_dir("preserve");
    let target = dir.join("state.json");
    replace(&target, b"old").unwrap();
    let invalid = target.join("child");
    assert!(replace(&invalid, b"new").is_err());
    assert_eq!(fs::read(&target).unwrap(), b"old");
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn create_new_writes_only_when_absent() {
    let dir = temp_dir("create-new");
    let target = dir.join("state.json");
    create_new(&target, b"first").unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"first");
    let error = create_new(&target, b"second").unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
    assert_eq!(fs::read(&target).unwrap(), b"first");
    let entries: Vec<_> = fs::read_dir(&dir).unwrap().flatten().collect();
    assert_eq!(entries.len(), 1);
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn corrupt_backup_names_do_not_collide() {
    let dir = temp_dir("backup");
    let target = dir.join("state.json");
    let first = backup_corrupt(&target, b"bad").unwrap();
    let second = backup_corrupt(&target, b"bad2").unwrap();
    assert_ne!(first, second);
    assert_eq!(fs::read(first).unwrap(), b"bad");
    assert_eq!(fs::read(second).unwrap(), b"bad2");
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn pre_migration_backup_is_named_by_target_version_and_never_collides() {
    let dir = temp_dir("pre-migration");
    let target = dir.join("store.json");
    let first = backup_pre_migration(&target, b"one", 1).unwrap();
    let second = backup_pre_migration(&target, b"two", 1).unwrap();
    assert_ne!(first, second);
    let name = first.file_name().unwrap().to_string_lossy().into_owned();
    assert!(
        name.starts_with("store.json.pre-v1-") && name.ends_with(".bak"),
        "unexpected backup name {name}"
    );
    assert_eq!(fs::read(first).unwrap(), b"one");
    assert_eq!(fs::read(second).unwrap(), b"two");
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn newer_schema_is_recognised_even_when_the_rest_of_the_shape_is_unknown() {
    let path = Path::new("/data/x.json");
    let future = br#"{"schemaVersion":4,"somethingNew":[1,2,3]}"#;
    let error = NewerSchema::check(path, future, 3).unwrap_err();
    assert_eq!((error.found, error.supported), (4, 3));
    assert!(error.to_string().contains("/data/x.json"));

    assert!(NewerSchema::check(path, br#"{"schemaVersion":3}"#, 3).is_ok());
    assert!(NewerSchema::check(path, br#"{"a":1}"#, 3).is_ok());
    assert!(NewerSchema::check(path, b"not json", 3).is_ok());
    assert_eq!(peek_schema_version(br#"{"schemaVersion":"7"}"#), None);
}

#[cfg(unix)]
#[test]
fn backups_are_never_group_or_world_accessible() {
    use std::os::unix::fs::PermissionsExt;
    let dir = temp_dir("backup-mode");
    let target = dir.join("projects.json");
    // The source is world-readable; its backup must still be 0600 (the
    // registry/store hold MCP env secrets).
    fs::write(&target, b"secret").unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o644)).unwrap();
    for backup in [
        backup_pre_migration(&target, b"secret", 3).unwrap(),
        backup_corrupt(&target, b"secret").unwrap(),
    ] {
        let mode = fs::metadata(&backup).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode & 0o077, 0, "{} has mode {mode:o}", backup.display());
        assert_eq!(fs::read(&backup).unwrap(), b"secret");
    }
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn stale_temp_matches_only_old_temps_of_the_named_target() {
    let dir = temp_dir("stale-temp");
    let target = dir.join("sessions.json");
    let temp = temp_path(&target);
    let other_target = temp_path(&dir.join("metadata.json"));
    let backup = dir.join("sessions.json.corrupt-1-0.bak");
    for path in [&temp, &other_target, &backup] {
        fs::write(path, b"{}").unwrap();
    }
    let hour = Duration::from_secs(60 * 60);
    assert!(!is_stale_temp(&temp, "sessions.json", hour), "fresh temp");
    let two_hours_ago = SystemTime::now() - 2 * hour;
    for path in [&temp, &other_target, &backup] {
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(two_hours_ago)
            .unwrap();
    }
    assert!(is_stale_temp(&temp, "sessions.json", hour));
    assert!(!is_stale_temp(&other_target, "sessions.json", hour));
    assert!(!is_stale_temp(&backup, "sessions.json", hour));
    assert!(!is_stale_temp(
        &dir.join("sessions.json.12.ab.tmp"),
        "sessions.json",
        hour
    ));
    let _ = fs::remove_dir_all(dir);
}
