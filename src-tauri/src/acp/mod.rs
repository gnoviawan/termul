//! ACP (Agent Client Protocol) backend module — ADR-003 P0.
//!
//! Provides the Rust runtime layer that spawns ACP coding-agent subprocesses,
//! completes the JSON-RPC handshake, manages sessions, streams prompt turns,
//! and bridges agent events to the renderer over Tauri IPC.
//!
//! This is the backend-only P0 deliverable; the React chat UI is deferred to
//! P1+. See `docs/adr/adr-003-acp-agent-chat-ui-architecture.md` and
//! `_bmad-output/implementation-artifacts/spec-adr-003-p0-rust-acp-core.md`.

pub mod client;
pub mod commands;
pub mod config;
pub mod events;
pub mod manager;
pub mod session;

// Re-exported for the renderer bridge (P1+) and `lib.rs` wiring. `AcpManager`
// is used now (managed in `lib.rs`); the config/id types are part of the public
// surface the chat UI will consume, so they are intentionally re-exported even
// though nothing inside the crate references them through this path yet.
#[allow(unused_imports)]
pub use config::{AgentConfig, AgentId, SessionId};
pub use manager::AcpManager;

#[cfg(test)]
mod tests;
