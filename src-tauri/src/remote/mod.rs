//! Desktop-hosted shared-live ACP web server module.
//!
//! Wraps the in-process Axum server from [`crate::web`] so the desktop shares
//! its live [`crate::acp::AcpManager`] sessions with a browser/phone client over
//! the LAN — "shared-live" mode. Lifecycle (start/stop/status) is driven by the
//! status-bar control through the `remote_server_*` Tauri commands.
//!
//! The legacy PTY bridge (separate WebSocket proxying live PTY I/O, a
//! renderer-published project tree, same-origin auth) has been removed; the ACP
//! web server has no `/api/projects` or `/api/spawn` routes — the phone connects
//! directly to a session via the WS URL. Auth / token-gating land in Epic 2.

pub mod host;

pub use host::{RemoteBindMode, RemoteServerState, RemoteStatus};
