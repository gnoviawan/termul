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
//!
//! The gate in front of the marker routine reads the log back from its end
//! once, and a closed verdict is memoized as the session's
//! [`SweepCheckpoint`]: on the next launch an unchanged log costs only a
//! re-read of the checkpoint's own line, and a grown one is read back only to
//! the checkpoint.

use super::*;

/// A closed verdict is memoized only when proving it read at least this much
/// (or the old checkpoint had gone stale): a shorter scan is cheaper to
/// repeat on the next launch than a metadata rewrite now.
const STAMP_MIN_SCAN_BYTES: u64 = 1024 * 1024;

/// What one session's sweep did. A marker or a checkpoint change leaves the
/// metadata to be persisted by the caller.
#[derive(Default)]
pub(super) struct SweepOutcome {
    /// An `interrupted` terminator was appended (`last_seq` moved).
    pub(super) swept: bool,
    /// `sweep_checkpoint` was stamped or cleared.
    pub(super) checkpoint_changed: bool,
    /// The checkpoint covered the whole log: only its own line was re-read.
    pub(super) checkpoint_hit: bool,
    pub(super) stamped: bool,
    pub(super) bytes_scanned: u64,
}

/// `recover()` totals over every swept session (its summary log).
#[derive(Default)]
pub(super) struct SweepTotals {
    pub(super) checkpoint_hits: u64,
    pub(super) rescans: u64,
    pub(super) bytes_scanned: u64,
    pub(super) swept: u64,
    pub(super) stamped: u64,
}

impl SweepTotals {
    pub(super) fn add(&mut self, outcome: &SweepOutcome) {
        if outcome.checkpoint_hit {
            self.checkpoint_hits += 1;
        } else {
            self.rescans += 1;
        }
        self.bytes_scanned += outcome.bytes_scanned;
        self.swept += u64::from(outcome.swept);
        self.stamped += u64::from(outcome.stamped);
    }
}

/// The gate's reading of one log.
struct Gate {
    /// A turn may be open, or the log could not be read: run the marker
    /// routine.
    may_be_open: bool,
    /// A read or candidate parse failed: never stamp from this pass.
    unreadable: bool,
    bytes_read: u64,
    /// The whole-log checkpoint when the verdict is closed.
    closed_at: Option<SweepCheckpoint>,
    /// The metadata carried a checkpoint that no longer describes the log.
    prior_stale: bool,
}

/// Whether the log might end inside an unfinished turn, read with the exact
/// rules of [`last_unmatched_user_prompt`] through the shared
/// [`open_turn_step`]. `Ok(None)` means the checkpoint covers the whole log:
/// only the checkpoint's own line was re-read.
///
/// A valid checkpoint is the fold state `None` at its `len`, so one backward
/// pass from the end to the newest `user_prompt`/`agent_switch` boundary, or
/// to the checkpoint, or to the head, decides exactly.
fn read_gate(
    path: &Path,
    session_id: &str,
    prior: Option<SweepCheckpoint>,
) -> io::Result<Option<Gate>> {
    let mut file = fs::File::open(path)?;
    let len = file.metadata()?.len();
    let valid_prior = match prior {
        Some(checkpoint) => checkpoint_holds(&mut file, len, session_id, checkpoint)?,
        None => false,
    };
    let floor = match prior {
        Some(checkpoint) if valid_prior && checkpoint.len == len => return Ok(None),
        Some(checkpoint) if valid_prior => checkpoint.len,
        _ => 0,
    };
    let scan = scan_fold_tail(&mut file, len, floor, session_id)?;
    let may_be_open = scan.unreadable || scan.open_turn().is_some();
    Ok(Some(Gate {
        may_be_open,
        unreadable: scan.unreadable,
        bytes_read: scan.bytes_read,
        closed_at: scan
            .last_line
            .filter(|line| line.terminated && !may_be_open)
            .map(|line| SweepCheckpoint { len, seq: line.seq }),
        prior_stale: prior.is_some() && !valid_prior,
    }))
}

/// Whether `checkpoint` still describes a prefix of the log: the byte before
/// `len` ends a line, and that line is this session's record with `seq`.
fn checkpoint_holds(
    file: &mut fs::File,
    file_len: u64,
    session_id: &str,
    checkpoint: SweepCheckpoint,
) -> io::Result<bool> {
    if checkpoint.len == 0 || checkpoint.len > file_len {
        return Ok(false);
    }
    Ok(probe_line_ending_at(file, checkpoint.len, session_id)?
        .is_some_and(|probe| probe.seq == checkpoint.seq))
}

/// Append the `interrupted` terminator for an unfinished turn of one
/// recovered session, and keep the session's [`SweepCheckpoint`] current.
///
/// The terminator is bookkeeping, not activity: `last_activity_at` keeps its
/// pre-crash value so the history list does not reorder on every host start.
pub(super) fn sweep_interrupted_turn(root: &Path, metadata: &mut SessionMetadata) -> SweepOutcome {
    let log_path = root.join(&metadata.storage_key).join(MESSAGES_FILE);
    let mut outcome = SweepOutcome::default();
    let gate = match read_gate(&log_path, &metadata.session_id, metadata.sweep_checkpoint) {
        Ok(Some(gate)) => gate,
        Ok(None) => {
            outcome.checkpoint_hit = true;
            return outcome;
        }
        Err(error) => {
            log::warn!(
                "[acp-history] sweep tail gate failed for session {}: {error}",
                crate::logging::redact_session_id(&metadata.session_id)
            );
            Gate {
                may_be_open: true,
                unreadable: true,
                bytes_read: 0,
                closed_at: None,
                prior_stale: false,
            }
        }
    };
    outcome.bytes_scanned = gate.bytes_read;
    let mut closed_at = gate.closed_at;
    if gate.may_be_open {
        let before = (metadata.last_seq, metadata.last_activity_at);
        let shared = Arc::new(Mutex::new(metadata.clone()));
        append_interrupted_marker_if_open(root, &shared, &mut TailState::default(), None);
        let updated = shared.lock().clone();
        if updated.last_seq != before.0 {
            *metadata = updated;
            metadata.last_activity_at = before.1;
            outcome.swept = true;
            // `last_seq` also moves when the append only repaired a bare
            // tail and then failed, so the log is gated again rather than
            // assumed closed: only a log that now folds to no open turn is
            // stamped. A gate that could not read the log proves nothing, so
            // it never stamps. (`closed_at` is still `None` here: the gate
            // found the log possibly open.)
            if !gate.unreadable {
                if let Ok(Some(after)) = read_gate(&log_path, &metadata.session_id, None) {
                    outcome.bytes_scanned += after.bytes_read;
                    closed_at = after.closed_at.filter(|_| !after.may_be_open);
                }
            }
        }
    }
    let stamp = closed_at.filter(|_| gate.prior_stale || gate.bytes_read >= STAMP_MIN_SCAN_BYTES);
    if let Some(checkpoint) = stamp {
        metadata.sweep_checkpoint = Some(checkpoint);
        outcome.stamped = true;
        outcome.checkpoint_changed = true;
    } else if gate.prior_stale {
        metadata.sweep_checkpoint = None;
        outcome.checkpoint_changed = true;
    }
    outcome
}
