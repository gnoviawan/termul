//! `project_icon_resolve` — resolves a project's icon from local well-known
//! icon files or its parsed git remote (see [`crate::project_icon`]).
//! Mirrors the `git_*` command shape: `cwd`-keyed, path-validated, best-effort.

use super::{validate_project_path, IpcResult};
use crate::project_icon::ProjectIcon;

/// Resolve the project icon for the repository at `cwd`. Returns
/// `IpcResult::success(None)` when nothing resolves — the renderer falls back
/// to a colored monogram — and `IpcResult::error` only for an invalid `cwd`.
/// The shared resolver logs its own warn-level boundary events (refusals,
/// fetch failures) without credentials or full remote URLs.
#[tauri::command]
pub async fn project_icon_resolve(cwd: String) -> Result<IpcResult<Option<ProjectIcon>>, String> {
    let resolved = match validate_project_path(&cwd) {
        Ok(path) => path,
        Err(e) => return Ok(IpcResult::error(e, "PATH_VALIDATION_FAILED")),
    };
    Ok(IpcResult::success(
        crate::project_icon::resolve(resolved).await,
    ))
}
