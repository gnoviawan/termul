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
