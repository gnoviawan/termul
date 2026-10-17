mod archive;
mod conflict;
mod git;
mod launch;
mod launch_registry;
mod manager;
mod merge;
mod rename;
mod types;
mod util;

pub use launch_registry::{take_launch_created, worktree_path_key};
pub use manager::WorktreeManager;
pub use types::{
    ArchiveEntry, ArchiveManifest, BaseBranchInfo, BranchEntry, ConflictFile, ConflictSuggestion,
    DirtyStatus, GitWorktreeEntry, GitignoreDir, IncludeCopyResult, IncludeSkipReason, MergePreview,
    RemoveResult, SymlinkResult, WorktreeError,
};

// Helpers shared by the sibling submodules. These stay private `use`s so
// `crate::worktree::<helper>` does not resolve outside this module tree — the
// test files still reach them through `use super::*`.
use conflict::{
    chrono_timestamp, create_dir_symlink, glob_to_regex, thirty_days_from_now, ConflictBlock,
};
use git::{ensure_valid_branch_name, run_git, run_git_streaming, worktree_add_args};
use launch_registry::note_launch_created;
use types::parse_git_stderr;
use util::{is_excluded_dir, is_single_safe_folder_name, quiet_command};

#[cfg(test)]
use git::{extract_lines, which_git};
#[cfg(test)]
use std::path::Path;

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests;

#[cfg(test)]
mod conflict_analysis_tests;

#[cfg(test)]
mod create_validation_tests;

#[cfg(test)]
mod launch_registry_tests;

#[cfg(test)]
mod merge_tests;

#[cfg(test)]
mod rename_tests;
