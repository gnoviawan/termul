//! Consecutive `available_commands_update` dedupe.
//!
//! Some agents (Devin) re-send their whole command list every ~15 s while
//! idle, with the entries shuffled but the set unchanged. Each re-send would
//! take a seq, a durable JSONL record (60–114 KB), a live event and an idle
//! touch that keeps the agent from ever being reaped. The driver drops an
//! update whose set equals the last one fanned out for the session, before
//! any of that happens, so no seq hole or head-ahead mark can arise.

use std::collections::HashMap;

use agent_client_protocol::schema::v1::AvailableCommand;

/// Last fanned-out command list per session, sorted by name.
#[derive(Default)]
pub(super) struct LastCommands {
    sessions: HashMap<String, SeenCommands>,
}

struct SeenCommands {
    sorted: Vec<AvailableCommand>,
    /// The current run of repeats was already logged.
    dropping: bool,
}

impl LastCommands {
    /// Whether `commands` repeats the session's last fanned-out set. Order
    /// is ignored (both sides sorted by name), entries compare with the
    /// typed `PartialEq`, never as bytes: the wire order of keys and entries
    /// varies between otherwise identical updates. A changed set replaces
    /// the remembered one and is not a repeat.
    pub(super) fn is_repeat(&mut self, session_id: &str, commands: &[AvailableCommand]) -> bool {
        let mut sorted: Vec<&AvailableCommand> = commands.iter().collect();
        sorted.sort_by(|a, b| a.name.cmp(&b.name));
        if let Some(seen) = self.sessions.get_mut(session_id) {
            if seen.sorted.len() == sorted.len()
                && seen.sorted.iter().zip(&sorted).all(|(a, b)| a == *b)
            {
                if !seen.dropping {
                    seen.dropping = true;
                    log::info!(
                        "[acp] session {}: dropping repeated available_commands_update \
                         (same {} commands)",
                        crate::logging::redact_session_id(session_id),
                        sorted.len()
                    );
                }
                return true;
            }
        }
        self.sessions.insert(
            session_id.to_string(),
            SeenCommands {
                sorted: sorted.into_iter().cloned().collect(),
                dropping: false,
            },
        );
        false
    }

    /// Forget the session's last list, so its next update fans out.
    pub(super) fn forget(&mut self, session_id: &str) {
        self.sessions.remove(session_id);
    }
}
