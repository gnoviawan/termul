//! ACP (Agent Client Protocol) backend module — ADR-003 P0.
//!
//! Provides the Rust runtime layer that spawns ACP coding-agent subprocesses,
//! completes the JSON-RPC handshake, manages sessions, streams prompt turns,
//! and bridges agent events to the renderer over Tauri IPC.
//!
//! This is the backend-only P0 deliverable; the React chat UI is deferred to
//! P1+. See `docs/adr/adr-003-acp-agent-chat-ui-architecture.md` and
//! `_bmad-output/implementation-artifacts/spec-adr-003-p0-rust-acp-core.md`.

pub mod atomic_file;
pub mod catalog;
pub mod chat_history_store;
pub mod client;
pub mod commands;
pub mod config;
pub mod events;
pub mod history_import;
pub mod manager;
pub mod mcp_probe;
pub mod project_registry;
pub mod session;
pub mod session_payload;
pub mod session_persistence;
pub mod terminal;
pub mod workspace_manifest;

// Re-exported for the renderer bridge (P1+) and `lib.rs` wiring. `AcpManager`
// is used now (managed in `lib.rs`); the config/id types are part of the public
// surface the chat UI will consume, so they are intentionally re-exported even
// though nothing inside the crate references them through this path yet.
#[allow(unused_imports)]
pub use chat_history_store::{
    ChatHistoryIndexEntry, ChatHistoryStatus, ChatHistoryStore, ChatHistoryStoreError,
};
#[allow(unused_imports)]
pub use config::{AgentConfig, AgentId, SessionId};
#[allow(unused_imports)]
pub use catalog::{
    AcpCatalog, AcpCatalogService, CatalogAgent, CatalogConfigFile, CatalogError,
    CatalogRuntimeAvailability, CatalogSource, HostCapability, PlatformTarget,
    SetCatalogOptInRequest, SupportedAcpAgentStatus,
};
#[allow(unused_imports)]
pub use history_import::import_chat_history;
#[allow(unused_imports)]
pub use manager::{AcpManager, SessionCreationContext, SpawnOutcome};
pub use project_registry::{FileProjectRegistry, VfsRoot};
#[allow(unused_imports)]
pub use session_persistence::{
    PersistedEventRecord, PersistedSessionStatus, SessionIndexEntry, SessionPersistence,
    SessionPersistenceError, SessionRegistration,
};
#[allow(unused_imports)]
pub use workspace_manifest::{
    EditorDescriptor, LeafNode, PaneDirection, PaneNode, SplitNode, TerminalDescriptor,
    WorkspaceManifest, WorkspaceManifestError, WorkspaceManifestService, WriteOutcome,
    WORKSPACE_MANIFEST_SCHEMA_VERSION,
};

#[cfg(test)]
mod tests;
