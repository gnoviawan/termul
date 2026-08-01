//! Terminal state trackers module
//!
//! This module contains trackers for monitoring terminal state:
//! - CWD (Current Working Directory) tracking
//! - Git branch and status tracking
//! - Exit code tracking

pub mod cwd_tracker;
pub mod exit_code_tracker;
pub mod git_tracker;
pub mod terminal_events;

pub use cwd_tracker::CwdTracker;
pub use exit_code_tracker::ExitCodeTracker;
pub use git_tracker::{GitCommit, GitStatus, GitStatusDetail, GitTracker};
pub use terminal_events::{TerminalEvent, TerminalEventHub};
#[allow(unused_imports)]
pub use terminal_events::TerminalStateSnapshot;
