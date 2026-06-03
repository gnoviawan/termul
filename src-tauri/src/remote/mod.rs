//! Remote terminal access module
//!
//! Provides HTTP + WebSocket server for accessing PTY terminals from web browsers.
//! Designed with security-first principles:
//! - Same-origin validation to prevent CSWSH (no token; reachable by ip:port)
//! - Per-terminal connection limits
//! - Defaults to localhost-only binding
//!
//! Architecture:
//! - Uses `tokio::sync::broadcast` to receive terminal output from PtyManager
//! - Replays per-terminal scrollback on connect for persistence/parity
//! - Uses Axum 0.8 (reuses existing tokio/hyper stack, no separate runtime)
//! - Supports multiple concurrent WebSocket clients per terminal
//! - Renderer publishes a project → terminal tree into `ProjectRegistry`

pub mod auth;
pub mod registry;
pub mod server;
pub mod ws;

pub use registry::ProjectTree;
pub use server::{RemoteServerState, RemoteStatus};
