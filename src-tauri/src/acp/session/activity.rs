//! Host-observed agent activity: the evidence the idle reaper reads.
//!
//! The reap decision depends only on what the host itself can see on the
//! agent's driver thread: running prompt turns, unanswered permission /
//! question / elicitation tickets, reopens in flight, running agent-owned ACP
//! terminals, and how long ago any of these (or a session update) last
//! happened. Connections, subscriptions, presence and tabs never feed it.

use std::time::{Duration, Instant};

/// Instant of the most recent host-observed activity on one agent. Starts at
/// driver-state creation so a freshly spawned agent is not instantly idle.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ActivityClock(Instant);

impl ActivityClock {
    /// Stamp "something happened just now".
    pub(crate) fn touch(&mut self) {
        self.0 = Instant::now();
    }

    pub(crate) fn last(&self) -> Instant {
        self.0
    }
}

impl Default for ActivityClock {
    fn default() -> Self {
        Self(Instant::now())
    }
}

/// One agent's activity evidence at a point in time, answered by the agent's
/// own driver thread.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentActivity {
    /// Sessions with an in-flight prompt turn (including cancel grace).
    pub active_turns: usize,
    /// Permission requests waiting for an answer.
    pub pending_permissions: usize,
    /// Structured questions waiting for an answer.
    pub pending_questions: usize,
    /// Form or URL elicitations waiting for an answer.
    pub pending_elicitations: usize,
    /// Agent-owned ACP terminals whose command is still running ("reported
    /// background work").
    pub running_terminals: usize,
    /// Session reopens (load/resume) in flight.
    pub reopens_in_flight: usize,
    /// When any of the above, a session update, or a prompt send last
    /// happened.
    pub last_active_at: Instant,
}

impl AgentActivity {
    /// True when something is happening right now that must keep the agent
    /// alive, however long ago the last stamp was.
    #[must_use]
    pub fn has_evidence(&self) -> bool {
        self.active_turns > 0
            || self.pending_permissions > 0
            || self.pending_questions > 0
            || self.pending_elicitations > 0
            || self.running_terminals > 0
            || self.reopens_in_flight > 0
    }

    /// True when no evidence exists and the agent has been quiet for the whole
    /// `window` as of `now`. A stamp newer than `now` (activity after the
    /// caller took its clock reading) is never quiet.
    #[must_use]
    pub fn is_reapable(&self, now: Instant, window: Duration) -> bool {
        !self.has_evidence()
            && now
                .checked_duration_since(self.last_active_at)
                .is_some_and(|quiet| quiet >= window)
    }
}
