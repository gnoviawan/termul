//! Host-enforced terminal caps: a per-project limit and a global limit.
//!
//! The host is the only enforcer. A spawn reserves its slot under one lock
//! that also counts the live PTYs, so two concurrent spawns can never both
//! pass the check at the boundary, and a failed spawn frees its reservation
//! when the guard drops.
//!
//! Counting rule: every tracked PTY whose process has not exited counts,
//! detached ones included. A PTY that exited but is still tracked (kept only
//! so a client can read its last output) holds no process and counts toward
//! neither cap.

use super::*;

/// Which cap refused a spawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalLimitScope {
    /// The project already has its maximum number of live terminals.
    Project,
    /// The host already has the global maximum of live terminals.
    Global,
}

/// A spawn refused by a terminal cap. The message names both limits so the
/// user sees the numbers without any client-side copy of them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalLimitError {
    pub scope: TerminalLimitScope,
    /// The per-project limit in force when the spawn was refused.
    pub per_project: usize,
    /// The global limit in force when the spawn was refused.
    pub global: usize,
}

/// Wire code of a cap refusal on the terminal carriers (`/terminal/ws` reply
/// `code`, desktop `IpcResult.code`).
pub const TERMINAL_LIMIT_CODE: &str = "TERMINAL_LIMIT";

impl std::fmt::Display for TerminalLimitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let detail = match self.scope {
            TerminalLimitScope::Project => "this project is at its limit",
            TerminalLimitScope::Global => "the host is at its total limit",
        };
        write!(
            f,
            "Terminal limit reached ({} per project, {} total): {detail}",
            self.per_project, self.global
        )
    }
}

impl std::error::Error for TerminalLimitError {}

/// Why [`PtyManager::spawn`] did not produce a terminal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpawnError {
    /// A terminal cap refused the spawn (`TERMINAL_LIMIT`).
    Limit(TerminalLimitError),
    /// The PTY could not be created (`SPAWN_FAILED`).
    Failed(String),
}

impl SpawnError {
    /// Stable wire code of this refusal.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Limit(_) => TERMINAL_LIMIT_CODE,
            Self::Failed(_) => "SPAWN_FAILED",
        }
    }
}

impl std::fmt::Display for SpawnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Limit(limit) => limit.fmt(f),
            Self::Failed(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for SpawnError {}

impl From<String> for SpawnError {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}

/// Spawns that hold a slot but have not registered their PTY yet:
/// terminal id → project id.
pub(super) type PendingSpawns = Arc<parking_lot::Mutex<HashMap<String, Option<String>>>>;

/// A slot held by an in-flight spawn. Dropping it releases the hold; by then
/// the PTY is registered (and counted as a live terminal) or the spawn failed.
pub(super) struct TerminalSlotReservation {
    pending: PendingSpawns,
    id: String,
}

impl Drop for TerminalSlotReservation {
    fn drop(&mut self) {
        self.pending.lock().remove(&self.id);
    }
}

impl PtyManager {
    /// The per-project cap in force.
    #[must_use]
    pub fn max_terminals_per_project(&self) -> usize {
        self.max_terminals_per_project.load(Ordering::Relaxed)
    }

    /// Set the per-project cap (at least 1). Applies to later spawns; live
    /// terminals are never killed because the cap shrank.
    pub fn set_max_terminals_per_project(&self, max: usize) {
        self.max_terminals_per_project
            .store(max.max(1), Ordering::Relaxed);
    }

    /// Reserve a slot for terminal `id` of `project_id`, or name the cap that
    /// refuses it. Counting and reserving happen under one lock.
    pub(super) fn try_reserve_terminal_slot(
        &self,
        id: &str,
        project_id: Option<&str>,
    ) -> Result<TerminalSlotReservation, TerminalLimitError> {
        let project_id = project_id.filter(|project| !project.is_empty());
        let per_project = self.max_terminals_per_project();
        let mut pending = self.pending_spawns.lock();
        let terminals = self.terminals.read();

        let mut global = pending.len();
        let mut in_project = project_id.map_or(0, |project| {
            pending
                .values()
                .filter(|pending_project| pending_project.as_deref() == Some(project))
                .count()
        });
        for (terminal_id, instance) in terminals.iter() {
            // A pending spawn is already counted above, even once registered.
            if pending.contains_key(terminal_id) || instance.has_exited() {
                continue;
            }
            global += 1;
            if project_id.is_some_and(|project| instance.project_matches(project)) {
                in_project += 1;
            }
        }

        let scope = if project_id.is_some() && in_project >= per_project {
            Some(TerminalLimitScope::Project)
        } else if global >= GLOBAL_TERMINAL_LIMIT {
            Some(TerminalLimitScope::Global)
        } else {
            None
        };
        if let Some(scope) = scope {
            return Err(TerminalLimitError {
                scope,
                per_project,
                global: GLOBAL_TERMINAL_LIMIT,
            });
        }

        pending.insert(id.to_string(), project_id.map(str::to_string));
        Ok(TerminalSlotReservation {
            pending: Arc::clone(&self.pending_spawns),
            id: id.to_string(),
        })
    }

    /// Number of terminals that count toward the caps (live, not exited).
    #[must_use]
    pub fn live_terminal_count(&self) -> usize {
        let pending = self.pending_spawns.lock();
        let terminals = self.terminals.read();
        pending.len()
            + terminals
                .iter()
                .filter(|(id, instance)| !pending.contains_key(*id) && !instance.has_exited())
                .count()
    }
}
