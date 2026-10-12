use super::*;

struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("termul-precondition-{label}-{nanos}"));
        fs::create_dir_all(&path).expect("temp dir");
        Self(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[cfg(unix)]
#[test]
fn a_checked_write_through_a_symlink_updates_the_target_and_keeps_the_link() {
    let dir = TempDir::new("symlink");
    let (target, link) = (dir.0.join("target.txt"), dir.0.join("link.txt"));
    fs::write(&target, "v1").unwrap();
    std::os::unix::fs::symlink(&target, &link).unwrap();

    let expected = Expected::Sha256(sha256_hex(b"v1"));
    assert_eq!(
        write_checked(&link, b"v2", &expected, false).unwrap(),
        CheckedWrite::Written
    );
    assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
    assert_eq!(fs::read_to_string(&target).unwrap(), "v2");
}

#[cfg(unix)]
#[test]
fn a_checked_create_through_a_dangling_symlink_creates_its_target() {
    let dir = TempDir::new("dangling");
    let (target, link) = (dir.0.join("later.txt"), dir.0.join("link.txt"));
    std::os::unix::fs::symlink("later.txt", &link).unwrap();

    assert_eq!(
        write_checked(&link, b"made", &Expected::Absent, false).unwrap(),
        CheckedWrite::Written
    );
    assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
    assert_eq!(fs::read_to_string(&target).unwrap(), "made");
}

#[cfg(unix)]
#[test]
fn a_checked_write_keeps_the_permissions_of_the_file_it_replaces() {
    use std::os::unix::fs::PermissionsExt;
    let dir = TempDir::new("perms");
    let file = dir.0.join("f.txt");
    fs::write(&file, "v1").unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o640)).unwrap();

    write_checked(&file, b"v2", &Expected::Sha256(sha256_hex(b"v1")), false).unwrap();
    assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o640);
    assert_eq!(fs::read_to_string(&file).unwrap(), "v2");
}

#[test]
fn a_concurrent_unchecked_write_cannot_land_inside_a_checked_writers_window() {
    let dir = TempDir::new("race");
    let file = dir.0.join("f.txt");
    fs::write(&file, "v0").unwrap();
    // Many rounds: every checked write either lands whole or is refused, and
    // an unchecked write is never half-applied or lost under the lock.
    for round in 0..50 {
        let current = fs::read(&file).unwrap();
        let expected = Expected::Sha256(sha256_hex(&current));
        let (a, b) = (file.clone(), file.clone());
        let checked_content = format!("checked-{round}");
        let unchecked_content = format!("unchecked-{round}");
        let (cc, uc) = (checked_content.clone(), unchecked_content.clone());
        let checked = std::thread::spawn(move || write_checked(&a, cc.as_bytes(), &expected, false));
        let unchecked = std::thread::spawn(move || write_unchecked(&b, uc.as_bytes()));
        let outcome = checked.join().unwrap().unwrap();
        unchecked.join().unwrap().unwrap();
        let after = fs::read_to_string(&file).unwrap();
        match outcome {
            // Checked ran first: the unchecked write follows and wins.
            CheckedWrite::Written => assert_eq!(after, unchecked_content),
            // Unchecked ran first: the checked write saw a changed file and
            // was refused instead of overwriting it blind.
            CheckedWrite::Stale => assert_eq!(after, unchecked_content),
        }
    }
}

#[cfg(unix)]
#[test]
fn a_new_file_is_never_executable_and_a_private_file_stays_private() {
    use std::os::unix::fs::PermissionsExt;
    let dir = TempDir::new("modes");
    let fresh = dir.0.join("fresh.txt");
    write_checked(&fresh, b"new", &Expected::Absent, false).unwrap();
    assert_eq!(fs::metadata(&fresh).unwrap().permissions().mode() & 0o111, 0);

    let private = dir.0.join("private.txt");
    fs::write(&private, "v1").unwrap();
    fs::set_permissions(&private, fs::Permissions::from_mode(0o600)).unwrap();
    write_unchecked(&private, b"v2").unwrap();
    assert_eq!(fs::metadata(&private).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(fs::read_to_string(&private).unwrap(), "v2");
}
