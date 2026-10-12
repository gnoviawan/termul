//! Host-start sweep (AD-5): terminate every turn a crash left unfinished.
//!
//! `recover()` runs this per session, after the torn-tail repair and the
//! `last_seq` heal, so it executes inside `SessionPersistence::open` — before
//! the manager, the relay or any carrier exists. A turn is never replayed or
//! resumed: the sweep only appends `prompt_complete { stopReason:
//! "interrupted" }` through the same marker routine the shutdown path uses, so
//! seq assignment and the `turnId` match rules are shared, and a second host
//! start finds the terminator and adds nothing.
//!
//! A session an unclean shutdown left `Active` is already stamped `Closed` by
//! `recover()`; together with the `interrupted` terminator that is the
//! "unfinished entity stamped interrupted" outcome (no extra status variant).

use super::*;

/// Window sizes (in lines) of the bounded tail gate. A clean log ends in a
/// terminator within a few records; only a log whose tail is one very long
/// open run falls through to the full scan.
const GATE_WINDOWS: [usize; 3] = [64, 1024, TAIL_DEEPEN_MAX_LINES];

/// Whether the log might end inside an unfinished turn. Reads only the tail
/// (`recover()` deliberately never scans clean sessions' JSONL) and applies the
/// exact matching rules of [`last_unmatched_user_prompt`] — turn-id match, a
/// turnless prompt closed by any later completion, `agent_switch` abandoning a
/// turn — so the gate and the marker routine can never disagree.
///
/// The tail decides only when it holds a boundary that fixes the answer: a
/// `user_prompt` or `agent_switch` (every later record is in the window too),
/// or the head of the log. A window of only completions/chunks cannot tell
/// whether an unseen earlier prompt it fails to match is still open, so it
/// widens; `true` is also returned when the cap is hit or the tail is
/// unreadable. The marker routine then runs the full check, a no-op when the
/// turn turns out to be matched.
fn tail_may_have_open_turn(path: &Path, session_id: &str) -> bool {
    for (index, lines) in GATE_WINDOWS.into_iter().enumerate() {
        let slice = match load_jsonl_tail(path, session_id, lines) {
            Ok(slice) => slice,
            Err(error) => {
                log::warn!(
                    "[acp-history] sweep tail gate failed for session {}: {error}",
                    crate::logging::redact_session_id(session_id)
                );
                return true;
            }
        };
        if last_unmatched_user_prompt(&slice.records).is_some() {
            return true;
        }
        let decisive = slice.reached_head
            || slice
                .records
                .iter()
                .any(|record| matches!(record.type_.as_str(), "user_prompt" | "agent_switch"));
        if decisive {
            return false;
        }
        if index + 1 == GATE_WINDOWS.len() {
            return true;
        }
    }
    true
}

/// Append the `interrupted` terminator for an unfinished turn of one
/// recovered session. Returns `true` when a record was appended (the caller
/// persists the updated metadata).
///
/// The terminator is bookkeeping, not activity: `last_activity_at` keeps its
/// pre-crash value so the history list does not reorder on every host start.
pub(super) fn sweep_interrupted_turn(root: &Path, metadata: &mut SessionMetadata) -> bool {
    let log_path = root.join(&metadata.storage_key).join(MESSAGES_FILE);
    if !tail_may_have_open_turn(&log_path, &metadata.session_id) {
        return false;
    }
    let before = (metadata.last_seq, metadata.last_activity_at);
    let shared = Arc::new(Mutex::new(metadata.clone()));
    append_interrupted_marker_if_open(root, &shared, &mut TailState::default(), None);
    let updated = shared.lock().clone();
    if updated.last_seq == before.0 {
        return false;
    }
    *metadata = updated;
    metadata.last_activity_at = before.1;
    true
}
