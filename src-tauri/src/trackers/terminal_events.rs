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
    Exit {
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
    pub fn terminal_id(&self) -> &str {
        match self {
            Self::Exit { terminal_id, .. }
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

#[derive(Clone)]
pub struct TerminalEventHub {
    tx: Arc<broadcast::Sender<TerminalEvent>>,
    tauri: Option<AppHandle>,
    snapshots: Arc<RwLock<HashMap<String, TerminalStateSnapshot>>>,
}

impl TerminalEventHub {
    pub fn tauri(app_handle: AppHandle) -> Self {
        Self {
            tx: Arc::new(broadcast::channel(EVENT_CAPACITY).0),
            tauri: Some(app_handle),
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
        {
            let mut snapshots = self.snapshots.write();
            let terminal_id = match &event {
                TerminalEvent::Exit { terminal_id, .. }
                | TerminalEvent::CwdChanged { terminal_id, .. }
                | TerminalEvent::GitBranchChanged { terminal_id, .. }
                | TerminalEvent::GitStatusChanged { terminal_id, .. }
                | TerminalEvent::ExitCodeChanged { terminal_id, .. } => terminal_id.clone(),
            };
            let snapshot = snapshots.entry(terminal_id).or_default();
            match &event {
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
            TerminalEvent::Exit {
                terminal_id,
                exit_code,
                signal,
            } => app.emit(
                "terminal-exit",
                serde_json::json!({ "id": terminal_id, "exitCode": exit_code, "signal": signal }),
            ),
            TerminalEvent::CwdChanged { terminal_id, cwd } => app.emit(
                "terminal-cwd-changed",
                serde_json::json!({ "terminalId": terminal_id, "cwd": cwd }),
            ),
            TerminalEvent::GitBranchChanged {
                terminal_id,
                branch,
            } => app.emit(
                "terminal-git-branch-changed",
                serde_json::json!({ "terminalId": terminal_id, "branch": branch }),
            ),
            TerminalEvent::GitStatusChanged {
                terminal_id,
                status,
            } => app.emit(
                "terminal-git-status-changed",
                serde_json::json!({ "terminalId": terminal_id, "status": status }),
            ),
            TerminalEvent::ExitCodeChanged {
                terminal_id,
                exit_code,
            } => app.emit(
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
mod tests {
    use super::*;

    /// CAP-11: a terminal attaching before any cwd-tracking event sees the
    /// spawn-time cwd (seeded), not `null`.
    #[test]
    fn seed_cwd_fills_absent_snapshot_cwd() {
        let hub = TerminalEventHub::standalone();
        assert_eq!(hub.snapshot("t-1").cwd, None, "unseeded snapshot has no cwd");
        hub.seed_cwd("t-1", "/spawn/dir");
        assert_eq!(hub.snapshot("t-1").cwd.as_deref(), Some("/spawn/dir"));
    }

    /// CAP-11: the tracked cwd (from a real `CwdChanged` event) always wins —
    /// a seed never overrides it, and tracking overrides a prior seed.
    #[test]
    fn seed_cwd_yields_to_tracked_cwd_in_both_orders() {
        // Tracked first, seed second: the seed must not clobber the tracked cwd.
        let hub = TerminalEventHub::standalone();
        hub.emit(TerminalEvent::CwdChanged {
            terminal_id: "t-1".to_string(),
            cwd: "/tracked".to_string(),
        });
        hub.seed_cwd("t-1", "/spawn/dir");
        assert_eq!(hub.snapshot("t-1").cwd.as_deref(), Some("/tracked"));

        // Seed first, tracked second: the tracking event overrides the seed.
        let hub = TerminalEventHub::standalone();
        hub.seed_cwd("t-2", "/spawn/dir");
        hub.emit(TerminalEvent::CwdChanged {
            terminal_id: "t-2".to_string(),
            cwd: "/tracked".to_string(),
        });
        assert_eq!(hub.snapshot("t-2").cwd.as_deref(), Some("/tracked"));
    }
}
