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
