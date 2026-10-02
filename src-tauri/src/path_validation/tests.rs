use super::*;
use std::fs;
use std::path::PathBuf;

fn setup_test_dir(name: &str) -> PathBuf {
    let test_dir = std::env::temp_dir().join(format!("termul_test_{}", name));
    if test_dir.exists() {
        fs::remove_dir_all(&test_dir).ok();
    }
    fs::create_dir_all(&test_dir).expect("Failed to create test directory");
    test_dir
}

fn cleanup_test_dir(dir: &Path) {
    fs::remove_dir_all(dir).ok();
}

#[test]
fn test_rejects_absolute_path_outside_project() {
    let project_root = setup_test_dir("reject_absolute");
    let outside_path = std::env::temp_dir().join("outside");
    fs::create_dir_all(&outside_path).ok();

    let result = validate_search_path(
        outside_path.to_str().unwrap(),
        project_root.to_str().unwrap(),
    );

    assert!(result.is_err());
    assert!(result.unwrap_err().contains("outside project boundary"));

    cleanup_test_dir(&project_root);
    fs::remove_dir_all(&outside_path).ok();
}

#[test]
fn test_rejects_path_traversal_with_dotdot() {
    let project_root = setup_test_dir("reject_traversal");

    let result = validate_search_path("../../etc/passwd", project_root.to_str().unwrap());

    assert!(result.is_err());
    assert!(result.unwrap_err().contains("path traversal"));

    cleanup_test_dir(&project_root);
}

#[test]
fn test_accepts_valid_relative_path_within_project() {
    let project_root = setup_test_dir("accept_relative");
    let subdir = project_root.join("src");
    fs::create_dir_all(&subdir).expect("Failed to create subdirectory");

    let result = validate_search_path("src", project_root.to_str().unwrap());

    assert!(result.is_ok());
    let canonical = result.unwrap();
    let canonical_project = fs::canonicalize(&project_root).unwrap();
    assert!(canonical.starts_with(&canonical_project));

    cleanup_test_dir(&project_root);
}

#[test]
fn test_accepts_valid_absolute_path_within_project() {
    let project_root = setup_test_dir("accept_absolute");
    let subdir = project_root.join("lib");
    fs::create_dir_all(&subdir).expect("Failed to create subdirectory");

    let result = validate_search_path(subdir.to_str().unwrap(), project_root.to_str().unwrap());

    assert!(result.is_ok());
    let canonical = result.unwrap();
    let canonical_project = fs::canonicalize(&project_root).unwrap();
    assert!(canonical.starts_with(&canonical_project));

    cleanup_test_dir(&project_root);
}

#[test]
#[cfg_attr(
    windows,
    ignore = "directory symlinks require elevated privileges on Windows"
)]
fn test_rejects_symlink_pointing_outside_project() {
    let project_root = setup_test_dir("reject_symlink");
    let outside_dir = std::env::temp_dir().join("outside_target");
    fs::create_dir_all(&outside_dir).ok();

    let symlink_path = project_root.join("evil_link");

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&outside_dir, &symlink_path)
            .expect("failed to create symlink for path validation test");
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_dir(&outside_dir, &symlink_path)
            .expect("failed to create directory symlink for path validation test");
    }

    let result = validate_search_path(
        symlink_path.to_str().unwrap(),
        project_root.to_str().unwrap(),
    );

    assert!(result.is_err());
    assert!(result.unwrap_err().contains("outside project boundary"));

    cleanup_test_dir(&project_root);
    fs::remove_dir_all(&outside_dir).ok();
}

#[test]
fn test_accepts_project_root_itself() {
    let project_root = setup_test_dir("accept_root");

    let result = validate_search_path(".", project_root.to_str().unwrap());

    assert!(result.is_ok());
    let canonical = result.unwrap();
    assert_eq!(canonical, fs::canonicalize(&project_root).unwrap());

    cleanup_test_dir(&project_root);
}

#[test]
fn test_accepts_directory_name_containing_double_dots() {
    let project_root = setup_test_dir("accept_dotdot_name");
    let weird_dir = project_root.join("foo..bar");
    fs::create_dir_all(&weird_dir).expect("Failed to create subdirectory");

    let result = validate_search_path(weird_dir.to_str().unwrap(), project_root.to_str().unwrap());

    assert!(result.is_ok());

    cleanup_test_dir(&project_root);
}

#[test]
fn test_rejects_nonexistent_path() {
    let project_root = setup_test_dir("reject_nonexistent");

    let result = validate_search_path("nonexistent/path", project_root.to_str().unwrap());

    assert!(result.is_err());
    assert!(result.unwrap_err().contains("does not exist"));

    cleanup_test_dir(&project_root);
}

#[test]
fn test_strip_verbatim_disk_prefix() {
    assert_eq!(
        strip_verbatim_prefix(r"\\?\C:\Users\foo").as_ref(),
        r"C:\Users\foo"
    );
}

#[test]
fn test_strip_verbatim_unc_prefix() {
    assert_eq!(
        strip_verbatim_prefix(r"\\?\UNC\server\share\foo").as_ref(),
        r"\\server\share\foo"
    );
}

#[test]
fn test_strip_verbatim_leaves_normal_path_unchanged() {
    assert_eq!(
        strip_verbatim_prefix(r"C:\Users\foo\bar"),
        r"C:\Users\foo\bar"
    );
    // No verbatim prefix -> returned verbatim (string).
    assert_eq!(
        strip_verbatim_prefix("/home/user/project").as_ref(),
        "/home/user/project"
    );
}

#[test]
fn test_strip_verbatim_disk_prefix_chosen_over_unc_match() {
    // A path like \\?\UNC... must collapse to \\server, never to just "UNC...".
    assert!(
        strip_verbatim_prefix(r"\\?\UNC\server\share").starts_with(r"\\server"),
        "UNC verbatim prefix must map to a UNC share path"
    );
}
