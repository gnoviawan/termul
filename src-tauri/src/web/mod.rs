//! Web ACP Agent runtime — headless server + browser client support.
//!
//! This module owns the transport-neutral seams the `acp` dispatcher emits
//! through. The desktop app registers a [`sink::TauriEventSink`] (today's
//! `acp:*` Tauri events, byte-for-byte unchanged); the future standalone
//! `termul-server` binary (Story 1.2) will register a [`sink::WsRelaySink`]
//! wired to the WS relay (Story 1.4). The `acp` dispatcher never touches a
//! Tauri `AppHandle` directly — it fans events out through
//! `Vec<Arc<dyn EventSink>>`.
//!
//! Only `sink` lives here in Story 1.1; the router/ws/auth/sandbox/assets
//! submodules land in later stories.

pub mod sink;

// Re-exported for the dispatcher (`acp/`) and the desktop wiring (`lib.rs`).
// `AcpEvent` + `WsRelaySink` stay crate-local to `sink` (only the sink module
// and its tests reference them directly); re-exporting them here would be
// dead surface today.
pub use sink::{EventSink, TauriEventSink, fan_out};
