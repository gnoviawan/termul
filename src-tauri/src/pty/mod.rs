//! PTY (Pseudo-Terminal) management module
//!
//! This module handles terminal spawning, data I/O, and lifecycle management.

pub mod da_filter;
pub mod env_refresh;
pub mod manager;

#[cfg(target_os = "windows")]
pub mod windows;

pub use da_filter::DaFilter;
pub use manager::{PtyManager, SpawnOptions, TerminalInfo};
