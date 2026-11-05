//! Shared last-read markers for agent chats.
//!
//! Reading a chat on any surface (a desktop pane, a shared-live phone, a
//! `termul-server` browser) must clear its "New activity" dot on every
//! surface. The host keeps, per session, the newest session-log seq a surface
//! has read; the chat's `chat_activity` record ([`crate::web::chat_activity`])
//! is unread while its newest turn end is past this marker.
//!
//! A marker is a point in one log incarnation: `(log_epoch, seq)`. It only
//! moves forward within that incarnation, so a lagging client that sends an
//! older seq changes nothing. It is clamped to the log head (no surface can
//! have read an event that does not exist yet) and replaced when the session's
//! log epoch changed (its seqs restarted). A read a surface reports against
//! another epoch than the head's numbers events of a log that no longer
//! exists, so it is ignored rather than clamped. Markers live in memory, like
//! the dots they clear.

use std::collections::HashMap;

use parking_lot::Mutex;
use serde_json::{json, Value};

use crate::web::sink::LogHead;

/// What [`ChatReads::mark`] did. Each carries the marker as it now stands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MarkOutcome {
    /// The marker moved: the chat's activity must be re-derived.
    Moved(ReadMark),
    /// The marker already covered the seq.
    Unchanged(ReadMark),
    /// The read was against another log epoch than the head's, so it was
    /// ignored. With no marker yet, it stands at seq 0 of the head's epoch.
    OtherEpoch(ReadMark),
}

/// How far surfaces have read a session, within one log incarnation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadMark {
    pub log_epoch: String,
    pub seq: u64,
}

impl ReadMark {
    /// The `mark_chat_read` reply: `{sessionId, seq, logEpoch}`.
    #[must_use]
    pub fn to_wire(&self, session_id: &str) -> Value {
        json!({ "sessionId": session_id, "seq": self.seq, "logEpoch": self.log_epoch })
    }
}

/// Per-session last-read markers of one host.
#[derive(Default)]
pub struct ChatReads {
    marks: Mutex<HashMap<String, ReadMark>>,
}

impl ChatReads {
    /// Record that a surface has read `session_id` up to `seq`, against the
    /// session's current log `head`. `log_epoch` is the epoch the surface's
    /// `seq` was issued under; `None` (a client that predates it) is taken as
    /// the head's.
    pub fn mark(
        &self,
        session_id: &str,
        head: &LogHead,
        log_epoch: Option<&str>,
        seq: u64,
    ) -> MarkOutcome {
        let mut marks = self.marks.lock();
        if log_epoch.is_some_and(|epoch| epoch != head.log_epoch) {
            return MarkOutcome::OtherEpoch(marks.get(session_id).cloned().unwrap_or_else(|| {
                ReadMark {
                    log_epoch: head.log_epoch.clone(),
                    seq: 0,
                }
            }));
        }
        let read = ReadMark {
            log_epoch: head.log_epoch.clone(),
            seq: seq.min(head.head_seq),
        };
        match marks.get_mut(session_id) {
            Some(mark) if mark.log_epoch == read.log_epoch && mark.seq >= read.seq => {
                MarkOutcome::Unchanged(mark.clone())
            }
            Some(mark) => {
                mark.clone_from(&read);
                MarkOutcome::Moved(read)
            }
            None => {
                marks.insert(session_id.to_string(), read.clone());
                MarkOutcome::Moved(read)
            }
        }
    }

    /// The marker of `session_id`, if any surface has read it.
    #[must_use]
    pub fn get(&self, session_id: &str) -> Option<ReadMark> {
        self.marks.lock().get(session_id).cloned()
    }
}

#[cfg(test)]
#[path = "chat_reads_tests.rs"]
mod tests;
