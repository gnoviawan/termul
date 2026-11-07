use super::*;

fn name(dir: &Path) -> String {
    dir.file_name().unwrap().to_string_lossy().into_owned()
}

#[test]
fn a_session_id_never_names_a_path_outside_its_root() {
    let root = Path::new("root");
    for id in ["../../etc", "C:\\Windows", "../", "a/b", "", "\u{202e}x"] {
        let dir = session_dir(root, id);
        assert_eq!(dir.parent(), Some(root), "{id:?}");
        assert!(
            name(&dir).chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            "{id:?} gave {dir:?}"
        );
    }
}

#[test]
fn two_session_ids_never_share_a_directory() {
    let root = Path::new("root");
    let ids = ["a.b", "ab", "a_b", "../", "..\\", "", "AB", "s1"];
    let dirs: std::collections::HashSet<PathBuf> = ids.iter().map(|id| session_dir(root, id)).collect();
    assert_eq!(dirs.len(), ids.len(), "{dirs:?}");
    assert_eq!(session_dir(root, "a.b"), session_dir(root, "a.b"), "stable");
}

#[test]
fn a_session_directory_keeps_a_readable_prefix_of_the_id() {
    let dir = session_dir(Path::new("root"), "sess-1_a");
    let file = name(&dir);
    let (prefix, hash) = file.rsplit_once('-').unwrap();
    assert_eq!(prefix, "sess-1_a");
    assert_eq!(hash.len(), 16);
    let long = session_dir(Path::new("root"), &"x".repeat(100));
    assert_eq!(name(&long).len(), SESSION_DIR_PREFIX + 1 + 16);
}

#[test]
fn the_startup_sweep_deletes_every_session_directory_and_nothing_else() {
    let root = tempfile::tempdir().unwrap();
    // An old-style directory (the id's safe characters) and a current one.
    let current = name(&session_dir(root.path(), "s2"));
    for session in ["s1", current.as_str()] {
        let profile = root.path().join(session).join("profile");
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::write(profile.join("Cookies"), b"x").unwrap();
    }
    std::fs::write(root.path().join("not-a-session"), b"x").unwrap();

    assert_eq!(sweep(root.path()), 2);
    let left: Vec<_> = std::fs::read_dir(root.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(left, ["not-a-session"]);
    assert_eq!(sweep(&root.path().join("missing")), 0);
}
