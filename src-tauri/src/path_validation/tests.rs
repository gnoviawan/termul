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

#[test]
fn plain_windows_client_path_drops_a_verbatim_prefix_in_any_slash_style() {
    let plain = r"D:\work\proj\design.figcraft";
    for client in [
        r"\\?\D:\work\proj\design.figcraft",
        "//?/D:/work/proj/design.figcraft",
        r"\\?\D:\work\proj/design.figcraft",
        "D:/work/proj/design.figcraft",
        plain,
    ] {
        assert_eq!(plain_windows_client_path(client), plain, "{client}");
    }
    assert_eq!(
        plain_windows_client_path("//?/UNC/srv/share/p/a.figcraft"),
        r"\\srv\share\p\a.figcraft"
    );
}

#[test]
fn test_windows_git_path_strips_drive_and_unc_verbatim_for_git_exe() {
    // Mirrors the Windows CI failure in #1724: canonicalize + worktree add.
    assert_eq!(
        windows_git_path(r"\\?\C:\Users\runneradmin\AppData\Local\Temp\.tmpABC\main").as_ref(),
        r"C:\Users\runneradmin\AppData\Local\Temp\.tmpABC\main"
    );
    assert_eq!(
        windows_git_path(r"\\?\UNC\server\share\repo").as_ref(),
        r"\\server\share\repo"
    );
    assert_eq!(
        windows_git_path("/home/user/project").as_ref(),
        "/home/user/project"
    );
    assert_eq!(windows_git_path("chat/abc").as_ref(), "chat/abc");
}

#[test]
fn test_windows_git_path_keeps_verbatim_forms_without_a_plain_equivalent() {
    // Stripping these would leave a relative path git resolves against the
    // process cwd.
    let volume = r"\\?\Volume{0b1c2d3e-0000-0000-0000-000000000000}\repo";
    assert_eq!(windows_git_path(volume).as_ref(), volume);
    assert_eq!(windows_git_path(r"\\?\foo").as_ref(), r"\\?\foo");
}

#[test]
fn test_windows_git_path_keeps_verbatim_when_plain_form_names_another_folder() {
    // A verbatim path is literal; the plain form is normalized by Windows, so
    // stripping these would point git at a different location.
    for unsafe_path in [
        r"\\?\C:\repo/other",
        r"\\?\C:\repo\..\other",
        r"\\?\C:\repo\.\sub",
        r"\\?\C:\repo\.",
        r"\\?\C:\repo.\sub",
        r"\\?\C:\repo \sub",
        r"\\?\C:\repo\sub.",
        r"\\?\C:\repo\\sub",
        r"\\?\C:\repo\nul",
        r"\\?\C:\repo\COM1.txt",
        r"\\?\C:repo",
        r"\\?\UNC\server\share\..\other",
        r"\\?\UNC\server\share/repo",
        r"\\?\UNC\",
    ] {
        assert_eq!(
            windows_git_path(unsafe_path).as_ref(),
            unsafe_path,
            "{unsafe_path}"
        );
    }
}

#[test]
fn test_windows_git_path_still_strips_safe_verbatim_forms() {
    for (verbatim, plain) in [
        (r"\\?\C:\", r"C:\"),
        (r"\\?\C:\repo\", r"C:\repo\"),
        (r"\\?\D:\a b\.hidden\x.y", r"D:\a b\.hidden\x.y"),
        (r"\\?\C:\repo\console\com10", r"C:\repo\console\com10"),
        (r"\\?\UNC\server\share\repo\sub", r"\\server\share\repo\sub"),
    ] {
        assert_eq!(windows_git_path(verbatim).as_ref(), plain, "{verbatim}");
    }
}

#[cfg(not(windows))]
#[test]
fn test_git_path_keeps_literal_posix_backslash_names() {
    // On POSIX `\\?\foo` is a legal file name, not a verbatim prefix.
    assert_eq!(git_path(r"\\?\foo").as_ref(), r"\\?\foo");
    assert_eq!(git_path(r"\\?\C:\x").as_ref(), r"\\?\C:\x");
    assert_eq!(
        git_path("/home/user/project").as_ref(),
        "/home/user/project"
    );
}

#[cfg(windows)]
#[test]
fn test_git_path_strips_verbatim_on_windows() {
    assert_eq!(git_path(r"\\?\C:\repo").as_ref(), r"C:\repo");
}
