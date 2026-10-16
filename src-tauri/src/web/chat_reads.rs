//! Shared last-read markers for agent chats.
//!
//! Each renderer banks a chat's "New activity" dot itself, but reading the chat
//! on any surface (a desktop pane, a shared-live phone, a `termul-server`
//! browser) must clear the dot on every surface. The host keeps, per session,
//! the newest session-log seq a surface has read, and serves it to every
//! `chat_reads` watcher. A renderer clears its dot once the marker reaches the
//! newest turn end it has seen.
//!
//! A marker only moves forward within one log incarnation, so a lagging client
//! that sends an older seq changes nothing. It is clamped to the log head (no
//! surface can have read an event that does not exist yet) and replaced when
//! the session's log epoch changed (its seqs restarted). Markers live in
//! memory, like the dots they clear.

use std::collections::{BTreeMap, HashMap};

use parking_lot::Mutex;

use crate::web::sink::LogHead;

/// What [`ChatReads::mark`] did. Both carry the marker as it now stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarkOutcome {
    /// The marker moved: watchers must hear about it.
    Moved(u64),
    /// The marker already covered the seq.
    Unchanged(u64),
}

struct ReadMark {
    log_epoch: String,
    seq: u64,
}

/// Per-session last-read markers of one host.
#[derive(Default)]
pub struct ChatReads {
    marks: Mutex<HashMap<String, ReadMark>>,
}

impl ChatReads {
    /// Record that a surface has read `session_id` up to `seq`, against the
    /// session's current log `head`.
    pub fn mark(&self, session_id: &str, head: &LogHead, seq: u64) -> MarkOutcome {
        let seq = seq.min(head.head_seq);
        let mut marks = self.marks.lock();
        match marks.get_mut(session_id) {
            Some(mark) if mark.log_epoch == head.log_epoch && mark.seq >= seq => {
                MarkOutcome::Unchanged(mark.seq)
            }
            Some(mark) => {
                mark.log_epoch.clone_from(&head.log_epoch);
                mark.seq = seq;
                MarkOutcome::Moved(seq)
            }
            None => {
                marks.insert(
                    session_id.to_string(),
                    ReadMark {
                        log_epoch: head.log_epoch.clone(),
                        seq,
                    },
                );
                MarkOutcome::Moved(seq)
            }
        }
    }

    /// The marker of `session_id`, if any surface has read it.
    #[must_use]
    pub fn seq(&self, session_id: &str) -> Option<u64> {
        self.marks.lock().get(session_id).map(|mark| mark.seq)
    }

    /// Every marker, by session id.
    #[must_use]
    pub fn snapshot(&self) -> BTreeMap<String, u64> {
        self.marks
            .lock()
            .iter()
            .map(|(session_id, mark)| (session_id.clone(), mark.seq))
            .collect()
    }
}

#[cfg(test)]
#[path = "chat_reads_tests.rs"]
mod tests;
