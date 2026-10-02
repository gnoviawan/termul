mod archive;
mod conflict;
mod git;
mod launch;
mod manager;
mod merge;
mod types;
mod util;

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
use git::{run_git, run_git_streaming, worktree_add_args};
use types::parse_git_stderr;
use util::{is_excluded_dir, quiet_command};

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
