//! Crash remount (spine AD-31): `canvas.crash_timeouts` consecutive
//! `CANVAS_TIMEOUT`s on a ready mount, or the editor's `event.crashed`, mark
//! the mount crashed. Termul replaces it with a fresh `Loading` mount of the
//! same document under a new `mountSeq`, so the renderer loads the last
//! saved bytes into a new iframe, and reports what the crash lost.
//!
//! Only a call that went unanswered counts: any reply, a typed refusal such
//! as `CANVAS_HIDDEN` included, proves the editor alive and resets the count,
//! and so does a reply that arrives after its call timed out. Calls that
//! were already waiting when a timeout was counted belong to the same stall
//! and do not count again, so several agent calls in flight during one busy
//! spell count once.
//! A mount still loading does not count either: an editor started while the
//! page is hidden reaches `event.ready` only once it is shown (figcraft
//! SPIKE.md), which is not a crash.

use std::sync::Arc;

use serde::Serialize;

use super::{closed, CanvasPersistence, Lifecycle, Mount, MountState, Phase};
use crate::canvas::CanvasError;
use crate::commands::sanitize_log_field;

/// `canvas.crash_timeouts` when the renderer sends none.
pub const DEFAULT_CRASH_TIMEOUTS: u32 = 3;
const MAX_CRASH_TIMEOUTS: u32 = 20;

/// The host → renderer notice sent over the gateway when a timeout-driven
/// remount replaced the mount the renderer holds. Its params are the
/// [`Remount`]; the renderer answers it itself, it never reaches the editor.
pub const REMOUNTED_METHOD: &str = "host.remounted";

/// The threshold for a requested `canvas.crash_timeouts`, at least 1.
pub fn crash_timeouts(requested: Option<u32>) -> u32 {
    requested
        .unwrap_or(DEFAULT_CRASH_TIMEOUTS)
        .clamp(1, MAX_CRASH_TIMEOUTS)
}

pub(super) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

/// Edits the crashed editor held that were not on disk.
#[derive(Debug, Clone, Serialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LostChanges {
    /// `contentVersion - savedVersion`, at least 1.
    pub count: u64,
    /// Wall-clock ms of the first of them, when known.
    pub since_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Remount {
    pub previous_mount_seq: u64,
    pub mount_seq: u64,
    pub reason: String,
    pub lost: Option<LostChanges>,
}

impl CanvasPersistence {
    /// The editor reported `event.crashed`. Answers the remount; a repeat
    /// report of the same crash answers the same one.
    pub fn crashed(
        &self,
        project_id: &str,
        mount_seq: u64,
        reason: &str,
    ) -> Result<Remount, CanvasError> {
        let current = self
            .mounts
            .lock()
            .get(project_id)
            .cloned()
            .ok_or_else(closed)?;
        if let Some(remount) = current
            .remounted_from
            .as_ref()
            .filter(|remount| remount.previous_mount_seq == mount_seq)
        {
            return Ok(remount.clone());
        }
        if current.mount_seq != mount_seq {
            return Err(closed());
        }
        self.remount(
            project_id,
            &current,
            &format!("the editor crashed: {reason}"),
        )
        .ok_or_else(closed)
    }

    /// A forwarded call got its answer.
    pub(super) fn call_answered(&self, project_id: &str, mount_seq: u64) {
        if let Ok(mount) = self.mount_for(project_id, mount_seq) {
            Self::alive(&mut mount.state.lock());
        }
    }

    /// The editor of `mount_seq` on connection `holder_id` answered a call
    /// after it had timed out.
    pub(super) fn late_answer(&self, holder_id: &str, mount_seq: u64) {
        let mount = self
            .mounts
            .lock()
            .values()
            .find(|mount| mount.mount_seq == mount_seq)
            .cloned();
        if let Some(mount) = mount {
            let mut state = mount.state.lock();
            let same_connection = state
                .link
                .connection()
                .is_some_and(|connection| connection.holder().id() == holder_id);
            if same_connection {
                Self::alive(&mut state);
            }
        }
    }

    fn alive(state: &mut MountState) {
        state.timeouts = 0;
        state.stall_counted_at = None;
    }

    /// A forwarded call sent at `sent_at` timed out; the last allowed one
    /// remounts. A call sent before the last counted timeout fired waited
    /// through that same stall and is not counted again.
    pub(super) fn call_timed_out(
        &self,
        project_id: &str,
        mount_seq: u64,
        sent_at: tokio::time::Instant,
    ) {
        let Ok(mount) = self.mount_for(project_id, mount_seq) else {
            return;
        };
        let timeouts = {
            let mut state = mount.state.lock();
            if !matches!(state.phase, Phase::Ready(_)) || state.lifecycle != Lifecycle::Open {
                return;
            }
            if state
                .stall_counted_at
                .is_some_and(|counted| sent_at < counted)
            {
                return;
            }
            state.timeouts += 1;
            state.stall_counted_at = Some(tokio::time::Instant::now());
            state.timeouts
        };
        if timeouts >= mount.crash_timeouts {
            let reason = format!("{timeouts} consecutive calls timed out");
            self.remount(project_id, &mount, &reason);
        }
    }

    /// Replace `old` with a fresh mount of its document and tell the renderer
    /// holding `old` ([`REMOUNTED_METHOD`]). `None` when `old` is no longer
    /// the project's open mount (closed, closing, or already replaced).
    fn remount(&self, project_id: &str, old: &Arc<Mount>, reason: &str) -> Option<Remount> {
        let (lost, holder) = {
            let mut state = old.state.lock();
            if state.lifecycle != Lifecycle::Open {
                return None;
            }
            // Claimed here, under the lock a close also takes, so a close and
            // a remount cannot both act on this mount.
            state.lifecycle = Lifecycle::Closed;
            let lost = match &state.phase {
                Phase::Ready(persisted) if persisted.unsaved() => Some(LostChanges {
                    count: persisted
                        .content_version
                        .unwrap_or(0)
                        .saturating_sub(persisted.saved_version.unwrap_or(0))
                        .max(1),
                    since_ms: persisted.unsaved_since,
                }),
                _ => None,
            };
            (
                lost,
                state
                    .link
                    .connection()
                    .map(|connection| connection.holder().clone()),
            )
        };
        let remount = Remount {
            previous_mount_seq: old.mount_seq,
            mount_seq: self.next_mount_seq(),
            reason: reason.to_string(),
            lost,
        };
        let fresh = Mount::new(
            remount.mount_seq,
            self.tick(),
            old.request(),
            old.max_mounted,
            Some(remount.clone()),
        );
        if !self.install(project_id, Some(old), fresh) {
            return None;
        }
        if let Some(holder) = holder {
            let params = serde_json::to_string(&remount).unwrap_or_default();
            self.notify(&holder, project_id, old.mount_seq, REMOUNTED_METHOD, params);
        }
        log::warn!(
            "[canvas] remounted project_id={} mount_seq={}->{} lost_changes={} reason={}",
            sanitize_log_field(project_id),
            remount.previous_mount_seq,
            remount.mount_seq,
            remount.lost.as_ref().map_or(0, |lost| lost.count),
            sanitize_log_field(reason)
        );
        Some(remount)
    }
}
