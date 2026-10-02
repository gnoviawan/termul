use std::borrow::Cow;
use std::path::{Component, Path, PathBuf};

fn path_has_parent_dir(path: &str) -> bool {
    Path::new(path)
        .components()
        .any(|component| matches!(component, Component::ParentDir))
}

/// Strip the Windows verbatim (extended-length) path prefixes that
/// `std::fs::canonicalize` prepends on Windows: `\\?\C:\…` and `\\?\UNC\…`.
///
/// Those prefixes defeat external tools such as `git.exe`, which aborts with
/// `fatal: could not create leading directories of …: Invalid argument` when it
/// receives one. Canonicalization is still performed by the caller for security
/// (symlink resolution + existence checks); this only rewrites the *string*
/// representation back to a normal, tool-friendly path.
///
/// This is pure string rewriting, so the verbatim prefixes (which never occur on
/// Unix) are simply left untouched there.
///
/// Returns `Cow::Borrowed` when the path has no verbatim prefix — the common
/// case on every platform — so callers in a per-line hot loop (e.g. ripgrep
/// output streaming) do not allocate. The function does NOT trim leading
/// whitespace before the prefix check, so a relative path with intentional
/// leading whitespace is preserved (the previous implementation trimmed
/// unconditionally, which was a subtle correctness bug for such paths).
pub fn strip_verbatim_prefix(path: &str) -> Cow<'_, str> {
    const VERBATIM: &str = r"\\?\";
    const VERBATIM_UNC: &str = r"\\?\UNC\";

    // Order matters: the longer UNC prefix must be checked first.
    if let Some(rest) = path.strip_prefix(VERBATIM_UNC) {
        return Cow::Owned(format!(r"\\{}", rest));
    }
    if let Some(rest) = path.strip_prefix(VERBATIM) {
        return Cow::Owned(rest.to_string());
    }
    Cow::Borrowed(path)
}

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
pub fn validate_search_path(search_path: &str, project_root: &str) -> Result<PathBuf, String> {
    if path_has_parent_dir(search_path) {
        return Err(format!(
            "Invalid search path: path traversal detected in '{}'",
            search_path
        ));
    }

    if path_has_parent_dir(project_root) {
        return Err(format!(
            "Invalid project root: path traversal detected in '{}'",
            project_root
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
mod tests;
