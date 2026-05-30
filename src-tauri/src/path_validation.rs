use std::path::{Path, PathBuf};

/// Validates that a search path is within the allowed project boundary.
/// Returns the canonicalized path if valid, or an error if the path
/// attempts to escape the project root or contains path traversal.
///
/// # Arguments
/// * `search_path` - The path to validate (can be relative or absolute)
/// * `project_root` - The project root directory that bounds the search
///
/// # Returns
/// * `Ok(PathBuf)` - The canonicalized search path if valid
/// * `Err(String)` - Error message if validation fails
///
/// # Security
/// This function prevents:
/// - Path traversal attacks (../, ../../, etc.)
/// - Absolute paths that escape the project boundary
/// - Symlink attacks that point outside the project
pub fn validate_search_path(
    search_path: &str,
    project_root: &str,
) -> Result<PathBuf, String> {
    // Reject paths with explicit path traversal components
    if search_path.contains("..") {
        return Err(format!(
            "Invalid search path: path traversal detected in '{}'",
            search_path
        ));
    }

    // Canonicalize the project root
    let canonical_project = std::fs::canonicalize(project_root).map_err(|e| {
        format!(
            "Failed to canonicalize project root '{}': {}",
            project_root, e
        )
    })?;

    // Resolve the search path (can be relative or absolute)
    let search_path_obj = if Path::new(search_path).is_absolute() {
        PathBuf::from(search_path)
    } else {
        canonical_project.join(search_path)
    };

    // Check if the path exists
    if !search_path_obj.exists() {
        return Err(format!(
            "Search path does not exist: '{}'",
            search_path_obj.display()
        ));
    }

    // Canonicalize the search path to resolve symlinks and normalize
    let canonical_search = std::fs::canonicalize(&search_path_obj).map_err(|e| {
        format!(
            "Failed to canonicalize search path '{}': {}",
            search_path_obj.display(),
            e
        )
    })?;

    // Verify the canonicalized search path is within the project boundary
    if !canonical_search.starts_with(&canonical_project) {
        return Err(format!(
            "Search path '{}' is outside project boundary '{}'",
            canonical_search.display(),
            canonical_project.display()
        ));
    }

    Ok(canonical_search)
}

#[cfg(test)]
mod tests {
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
        assert!(result
            .unwrap_err()
            .contains("outside project boundary"));

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
        assert!(canonical.starts_with(&project_root));

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
        assert!(canonical.starts_with(&project_root));

        cleanup_test_dir(&project_root);
    }

    #[test]
    fn test_rejects_symlink_pointing_outside_project() {
        let project_root = setup_test_dir("reject_symlink");
        let outside_dir = std::env::temp_dir().join("outside_target");
        fs::create_dir_all(&outside_dir).ok();

        let symlink_path = project_root.join("evil_link");

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside_dir, &symlink_path).ok();
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_dir(&outside_dir, &symlink_path).ok();
        }

        if symlink_path.exists() {
            let result =
                validate_search_path(symlink_path.to_str().unwrap(), project_root.to_str().unwrap());

            assert!(result.is_err());
            assert!(result
                .unwrap_err()
                .contains("outside project boundary"));
        }

        cleanup_test_dir(&project_root);
        fs::remove_dir_all(&outside_dir).ok();
    }

    #[test]
    fn test_accepts_project_root_itself() {
        let project_root = setup_test_dir("accept_root");

        let result = validate_search_path(".", project_root.to_str().unwrap());

        assert!(result.is_ok());
        let canonical = result.unwrap();
        assert_eq!(
            canonical,
            fs::canonicalize(&project_root).unwrap()
        );

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
}
