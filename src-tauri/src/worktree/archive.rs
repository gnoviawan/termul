use std::path::Path;

use super::*;

impl WorktreeManager {
    /// Archive a worktree by moving it to `.termul/archives/<name>-<timestamp>/`.
    /// Creates an archive manifest entry for later recovery.
    pub fn archive(project_path: &str, worktree_path: &str) -> Result<(), WorktreeError> {
        let project_root = Path::new(project_path);
        let wt_path = Path::new(worktree_path);

        // Verify the worktree path is under the project using canonicalized paths
        // to prevent prefix-traversal bypasses (e.g., "/project" matching "/project-evil")
        let canonical_project =
            std::fs::canonicalize(project_root).map_err(|_| WorktreeError::ArchiveFailed)?;
        let canonical_worktree =
            std::fs::canonicalize(wt_path).map_err(|_| WorktreeError::ArchiveFailed)?;
        if !canonical_worktree.starts_with(&canonical_project) {
            return Err(WorktreeError::ArchiveFailed);
        }

        // Get worktree name from path
        let wt_name = wt_path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or(WorktreeError::ArchiveFailed)?;

        // Create archive directory
        let archive_dir = project_root.join(".termul").join("archives");
        let timestamp = chrono_timestamp();
        let archive_path = archive_dir.join(format!("{}-{}", wt_name, timestamp));

        std::fs::create_dir_all(&archive_dir).map_err(|e| WorktreeError::IoError(e.to_string()))?;

        // Read branch metadata BEFORE the rename (get_worktree_branch reads git data from the path)
        let branch_name =
            Self::get_worktree_branch(worktree_path).unwrap_or_else(|_| wt_name.to_string());

        // Move the worktree directory to the archive
        std::fs::rename(wt_path, &archive_path)
            .map_err(|e| WorktreeError::IoError(e.to_string()))?;

        // Read existing manifest or create new one
        let manifest_path = archive_dir.join("archive-manifest.json");
        let mut manifest = if manifest_path.exists() {
            let content = std::fs::read_to_string(&manifest_path)
                .map_err(|e| WorktreeError::IoError(e.to_string()))?;
            serde_json::from_str::<ArchiveManifest>(&content).unwrap_or(ArchiveManifest {
                entries: Vec::new(),
            })
        } else {
            ArchiveManifest {
                entries: Vec::new(),
            }
        };
        let archived_at = timestamp.clone();
        let expires_at = thirty_days_from_now();

        manifest.entries.push(ArchiveEntry {
            original_path: worktree_path.to_string(),
            archive_path: archive_path.to_string_lossy().to_string(),
            archived_at,
            expires_at,
            branch_name,
            worktree_path: worktree_path.to_string(),
        });

        // Write manifest
        let manifest_json = serde_json::to_string_pretty(&manifest)
            .map_err(|e| WorktreeError::IoError(e.to_string()))?;
        std::fs::write(&manifest_path, manifest_json)
            .map_err(|e| WorktreeError::IoError(e.to_string()))?;

        // Prune git worktree metadata
        let _ = run_git(&["worktree", "prune"], Some(project_path));

        Ok(())
    }

    /// Restore an archived worktree back to its original location.
    pub fn restore(project_path: &str, archive_path: &str) -> Result<(), WorktreeError> {
        let project_root = Path::new(project_path);
        let archive_dir = project_root.join(".termul").join("archives");
        let manifest_path = archive_dir.join("archive-manifest.json");

        if !manifest_path.exists() {
            return Err(WorktreeError::ArchiveNotFound);
        }

        let content = std::fs::read_to_string(&manifest_path)
            .map_err(|e| WorktreeError::IoError(e.to_string()))?;
        let mut manifest = serde_json::from_str::<ArchiveManifest>(&content)
            .map_err(|_| WorktreeError::ArchiveNotFound)?;

        // Find the archive entry
        let index = manifest
            .entries
            .iter()
            .position(|e| e.archive_path == archive_path)
            .ok_or(WorktreeError::ArchiveNotFound)?;

        let entry = &manifest.entries[index];
        let src = Path::new(&entry.archive_path);
        let dst = Path::new(&entry.original_path);

        if !src.exists() {
            return Err(WorktreeError::ArchiveNotFound);
        }

        // Move back to original location
        std::fs::rename(src, dst).map_err(|e| WorktreeError::IoError(e.to_string()))?;

        // Remove from manifest
        manifest.entries.remove(index);
        let manifest_json = serde_json::to_string_pretty(&manifest)
            .map_err(|e| WorktreeError::IoError(e.to_string()))?;
        std::fs::write(&manifest_path, manifest_json)
            .map_err(|e| WorktreeError::IoError(e.to_string()))?;

        Ok(())
    }
}
