//! PTY (Pseudo-Terminal) management module
//!
//! This module handles terminal spawning, data I/O, and lifecycle management.

pub mod manager;

pub use manager::{PtyManager, SpawnOptions, TerminalInfo};
