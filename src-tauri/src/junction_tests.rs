use super::{create_junction, nt_path};
use std::os::windows::fs::MetadataExt as _;
use std::path::Path;

const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

#[test]
fn junction_resolves_when_source_and_target_names_contain_cmd_metacharacters() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("a&b");
    let target = dir.path().join("link&dir");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("marker.txt"), "hello").unwrap();

    create_junction(&source, &target).expect("junction is created");

    let attributes = std::fs::symlink_metadata(&target)
        .unwrap()
        .file_attributes();
    assert_ne!(
        attributes & FILE_ATTRIBUTE_REPARSE_POINT,
        0,
        "target is a reparse point"
    );
    assert_eq!(
        std::fs::read_to_string(target.join("marker.txt")).unwrap(),
        "hello"
    );
    assert_eq!(
        std::fs::canonicalize(&target).unwrap(),
        std::fs::canonicalize(&source).unwrap()
    );
}

#[test]
fn junction_to_a_missing_source_leaves_no_target_behind() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("link");

    create_junction(&dir.path().join("missing"), &target).expect_err("source does not exist");

    assert!(!target.exists());
    assert!(std::fs::symlink_metadata(&target).is_err());
}

#[test]
fn nt_path_maps_a_local_verbatim_path_and_refuses_a_network_path() {
    let local = nt_path(Path::new(r"\\?\C:\work\dir")).unwrap();
    assert_eq!(String::from_utf16(&local).unwrap(), r"\??\C:\work\dir");

    let error = nt_path(Path::new(r"\\?\UNC\server\share\dir")).unwrap_err();
    assert!(error.contains("network share"), "{error}");
}
