use parking_lot::RwLock;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::broadcast;

use super::git_tracker::GitStatus;

const EVENT_CAPACITY: usize = 256;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TerminalEvent {
    SessionLifecycle {
        #[serde(skip)]
        lifecycle_sequence: Option<u64>,
        terminal_id: String,
        session_id: String,
        kind: String,
        nonce: Option<String>,
        prompt_suppressed: bool,
        line_empty: bool,
        exit_code: Option<i32>,
        prompt_generation: Option<u64>,
        cwd: Option<String>,
    },
    Exit {
        #[serde(skip)]
        lifecycle_sequence: Option<u64>,
        terminal_id: String,
        exit_code: Option<i32>,
        signal: Option<i32>,
    },
    CwdChanged {
        terminal_id: String,
        cwd: String,
    },
    GitBranchChanged {
        terminal_id: String,
        branch: Option<String>,
    },
    GitStatusChanged {
        terminal_id: String,
        status: Option<GitStatus>,
    },
    ExitCodeChanged {
        terminal_id: String,
        exit_code: i32,
    },
}

impl TerminalEvent {
    pub fn lifecycle_sequence(&self) -> Option<u64> {
        match self {
            Self::SessionLifecycle {
                lifecycle_sequence, ..
            }
            | Self::Exit {
                lifecycle_sequence, ..
            } => *lifecycle_sequence,
            _ => None,
        }
    }

    pub(crate) fn set_lifecycle_sequence(&mut self, sequence: u64) {
        match self {
            Self::SessionLifecycle {
                lifecycle_sequence, ..
            }
            | Self::Exit {
                lifecycle_sequence, ..
            } => *lifecycle_sequence = Some(sequence),
            _ => unreachable!("only lifecycle events have a sequence"),
        }
    }

    pub fn terminal_id(&self) -> &str {
        match self {
            Self::SessionLifecycle { terminal_id, .. }
            | Self::Exit { terminal_id, .. }
            | Self::CwdChanged { terminal_id, .. }
            | Self::GitBranchChanged { terminal_id, .. }
            | Self::GitStatusChanged { terminal_id, .. }
            | Self::ExitCodeChanged { terminal_id, .. } => terminal_id,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStateSnapshot {
    pub cwd: Option<String>,
    pub git_branch: Option<String>,
    pub git_status: Option<GitStatus>,
    pub exit_code: Option<i32>,
    pub exited: bool,
}

type DesktopEmit = Arc<dyn Fn(&str, serde_json::Value) -> Result<(), tauri::Error> + Send + Sync>;

#[derive(Clone)]
pub struct TerminalEventHub {
    tx: Arc<broadcast::Sender<TerminalEvent>>,
    /// Desktop renderer bridge. Type-erased so this struct (and its drop glue)
    /// never names `AppHandle<Wry>`: the standalone server must not link the
    /// Wry runtime.
    tauri: Option<DesktopEmit>,
    snapshots: Arc<RwLock<HashMap<String, TerminalStateSnapshot>>>,
}

impl TerminalEventHub {
    pub fn tauri(app_handle: AppHandle) -> Self {
        Self {
            tx: Arc::new(broadcast::channel(EVENT_CAPACITY).0),
            tauri: Some(Arc::new(move |event, payload| {
                app_handle.emit(event, payload)
            })),
            snapshots: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn standalone() -> Self {
        Self {
            tx: Arc::new(broadcast::channel(EVENT_CAPACITY).0),
            tauri: None,
            snapshots: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<TerminalEvent> {
        self.tx.subscribe()
    }

    pub fn snapshot(&self, terminal_id: &str) -> TerminalStateSnapshot {
        self.snapshots
            .read()
            .get(terminal_id)
            .cloned()
            .unwrap_or_default()
    }

    /// Seed the snapshot cwd for a freshly spawned terminal (CAP-11). Called
    /// at spawn registration so a client attaching before the first
    /// cwd-tracking event sees the spawn-time cwd instead of `null`. Only
    /// fills an ABSENT cwd — once the tracker reports a `CwdChanged`, the
    /// tracked value wins (a re-seed never overrides it).
    pub fn seed_cwd(&self, terminal_id: &str, cwd: &str) {
        let mut snapshots = self.snapshots.write();
        let snapshot = snapshots.entry(terminal_id.to_string()).or_default();
        if snapshot.cwd.is_none() {
            snapshot.cwd = Some(cwd.to_string());
            // Durable boundary log: terminal ID only — the cwd is user data
            // (may contain sensitive paths) and is never logged.
            log::info!("[terminal-events] cwd seeded terminal_id={}", terminal_id);
        }
    }

    pub fn remove(&self, terminal_id: &str) {
        self.snapshots.write().remove(terminal_id);
    }

    pub fn emit(&self, event: TerminalEvent) {
        if !matches!(&event, TerminalEvent::SessionLifecycle { .. }) {
            let mut snapshots = self.snapshots.write();
            let terminal_id = match &event {
                TerminalEvent::SessionLifecycle { terminal_id, .. }
                | TerminalEvent::Exit { terminal_id, .. }
                | TerminalEvent::CwdChanged { terminal_id, .. }
                | TerminalEvent::GitBranchChanged { terminal_id, .. }
                | TerminalEvent::GitStatusChanged { terminal_id, .. }
                | TerminalEvent::ExitCodeChanged { terminal_id, .. } => terminal_id.clone(),
            };
            let snapshot = snapshots.entry(terminal_id).or_default();
            match &event {
                TerminalEvent::SessionLifecycle { .. } => {}
                TerminalEvent::Exit { exit_code, .. } => {
                    snapshot.exited = true;
                    snapshot.exit_code = *exit_code;
                }
                TerminalEvent::CwdChanged { cwd, .. } => snapshot.cwd = Some(cwd.clone()),
                TerminalEvent::GitBranchChanged { branch, .. } => {
                    snapshot.git_branch = branch.clone()
                }
                TerminalEvent::GitStatusChanged { status, .. } => {
                    snapshot.git_status = status.clone()
                }
                TerminalEvent::ExitCodeChanged { exit_code, .. } => {
                    snapshot.exit_code = Some(*exit_code)
                }
            }
        }
        let _ = self.tx.send(event.clone());
        let Some(app) = &self.tauri else {
            return;
        };
        let result = match event {
            TerminalEvent::SessionLifecycle { .. } => {
                app("terminal-session-lifecycle", serde_json::json!(&event))
            }
            TerminalEvent::Exit {
                terminal_id,
                exit_code,
                signal,
                ..
            } => app(
                "terminal-exit",
                serde_json::json!({ "id": terminal_id, "exitCode": exit_code, "signal": signal }),
            ),
            TerminalEvent::CwdChanged { terminal_id, cwd } => app(
                "terminal-cwd-changed",
                serde_json::json!({ "terminalId": terminal_id, "cwd": cwd }),
            ),
            TerminalEvent::GitBranchChanged {
                terminal_id,
                branch,
            } => app(
                "terminal-git-branch-changed",
                serde_json::json!({ "terminalId": terminal_id, "branch": branch }),
            ),
            TerminalEvent::GitStatusChanged {
                terminal_id,
                status,
            } => app(
                "terminal-git-status-changed",
                serde_json::json!({ "terminalId": terminal_id, "status": status }),
            ),
            TerminalEvent::ExitCodeChanged {
                terminal_id,
                exit_code,
            } => app(
                "terminal-exit-code-changed",
                serde_json::json!({ "terminalId": terminal_id, "exitCode": exit_code }),
            ),
        };
        if let Err(error) = result {
            log::error!("failed to emit terminal event to desktop renderer: {error}");
        }
    }
}

impl Default for TerminalEventHub {
    fn default() -> Self {
        Self::standalone()
    }
}

#[cfg(test)]
mod tests;
