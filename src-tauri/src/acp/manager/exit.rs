//! Why an agent's driver thread is winding down.
//!
//! The host records its intent in the agent's [`ExitSignal`] BEFORE it asks the
//! driver to shut down. The driver's teardown reads it to decide which
//! lifecycle events every sink must see: an explicit kill and an idle reap are
//! announced with their reason, a process shutdown stays silent, and no
//! recorded intent means the agent ended on its own (a crash).

use std::sync::atomic::{AtomicU8, Ordering};

use crate::acp::events::AgentExitReason;

/// What the host asked the driver to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ExitIntent {
    /// An explicit kill from a client.
    Killed,
    /// The idle reaper stopped the agent.
    Reaped,
    /// Process shutdown (`kill_all`, or a spawn that lost the race with it).
    Shutdown,
}

// Stored values; `0` (the default) means no intent was recorded.
const KILLED: u8 = 1;
const REAPED: u8 = 2;
const SHUTDOWN: u8 = 3;

/// Shared between the registry entry (set by the host) and the driver thread
/// (read at teardown).
#[derive(Debug, Default)]
pub(super) struct ExitSignal(AtomicU8);

impl ExitSignal {
    pub(super) fn set(&self, intent: ExitIntent) {
        let value = match intent {
            ExitIntent::Killed => KILLED,
            ExitIntent::Reaped => REAPED,
            ExitIntent::Shutdown => SHUTDOWN,
        };
        self.0.store(value, Ordering::Release);
    }

    pub(super) fn get(&self) -> Option<ExitIntent> {
        match self.0.load(Ordering::Acquire) {
            KILLED => Some(ExitIntent::Killed),
            REAPED => Some(ExitIntent::Reaped),
            SHUTDOWN => Some(ExitIntent::Shutdown),
            _ => None,
        }
    }
}

/// The reason to announce for a teardown, or `None` when the teardown must
/// stay silent (process shutdown).
pub(super) fn announced_reason(intent: Option<ExitIntent>) -> Option<AgentExitReason> {
    match intent {
        None => Some(AgentExitReason::Crashed),
        Some(ExitIntent::Killed) => Some(AgentExitReason::Killed),
        Some(ExitIntent::Reaped) => Some(AgentExitReason::Reaped),
        Some(ExitIntent::Shutdown) => None,
    }
}
