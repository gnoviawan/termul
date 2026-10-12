//! The bounded per-connection outbound queue (AD-19 / AD-8).
//!
//! Everything a connection sends — replies, pushed events, the close
//! handshake — goes through one bounded queue into the write loop. A peer that
//! stops draining it is closed rather than buffered: every enqueue that finds
//! the queue full is a failed attempt, a successful enqueue resets the count,
//! and `overflow_tolerance` consecutive failures trip the connection's close
//! signal. At most one failure is counted per [`FULL_QUEUE_ATTEMPT`] window per
//! connection, however many producers (one forwarder per subscribed session,
//! reply tasks, watch pushes) hit the full queue at once, so the tolerance
//! measures how long the peer stays full, not how many producers it has. Frames that must not be lost (replies, reliable events) wait
//! for room instead of being dropped; the lossy tiers can build on
//! [`OutboundSender::try_enqueue`].

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::warn;

use super::Outbound;

/// Frames the per-connection outbound queue holds before it counts as full.
/// The write loop coalesces up to `WS_BATCH_MAX_EVENTS` queued events into one
/// socket frame, so this bounds a stalled peer to a few thousand events.
pub(crate) const OUTBOUND_QUEUE_CAPACITY: usize = 1024;

/// The window one failed attempt is counted over: a reliable enqueue waits this
/// long for room, and a full queue counts at most one failure per window.
pub(crate) const FULL_QUEUE_ATTEMPT: Duration = Duration::from_secs(1);

/// Result of a non-blocking enqueue.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EnqueueOutcome {
    /// The frame is queued.
    Enqueued,
    /// The queue is full and the frame was NOT queued. Counts toward the
    /// overflow tolerance.
    Full,
    /// The connection is closing (peer gone, or it overflowed): nothing more
    /// will be delivered.
    Closed,
}

/// The receiving half, owned by the write loop.
pub(crate) type OutboundReceiver = mpsc::Receiver<Outbound>;

/// Overflow accounting shared by every clone of one connection's sender.
struct Overflow {
    tolerance: usize,
    /// The failure streak: its count and the start of the last counted window
    /// live under ONE lock, so a success ends both together and a concurrent
    /// failure cannot land between the two.
    streak: parking_lot::Mutex<Streak>,
    /// Whether `streak` may be non-empty: lets the common success path skip the
    /// lock. Only ever set under the `streak` lock.
    streak_active: AtomicBool,
    /// Fires when the peer overflowed or the connection must close for another
    /// reason; the relay supervisor ends the connection on it.
    closing: CancellationToken,
}

/// Consecutive failed windows since the last successful enqueue.
#[derive(Default)]
struct Streak {
    failures: usize,
    /// When the last failed attempt was counted (the window start).
    last_counted: Option<tokio::time::Instant>,
}

impl Overflow {
    /// Record a full-queue hit; `true` when the tolerance is reached (the close
    /// signal has then been raised). A hit inside the window of the last
    /// counted failure is the same failed attempt and counts nothing.
    fn record_full(&self) -> bool {
        let failures = {
            let mut streak = self.streak.lock();
            let now = tokio::time::Instant::now();
            if streak
                .last_counted
                .is_some_and(|at| now.duration_since(at) < FULL_QUEUE_ATTEMPT)
            {
                return self.closing.is_cancelled();
            }
            streak.last_counted = Some(now);
            streak.failures += 1;
            self.streak_active.store(true, Ordering::Release);
            streak.failures
        };
        if failures >= self.tolerance {
            if !self.closing.is_cancelled() {
                warn!(
                    target: "termul::web::ws",
                    failures,
                    "outbound queue stayed full for the overflow tolerance; closing the connection"
                );
            }
            self.closing.cancel();
            true
        } else {
            false
        }
    }

    /// Progress ends the failure streak and its window together: a full hit
    /// right after it starts a new streak instead of being absorbed into the
    /// old window. The lock is only taken when there was a streak to end.
    fn record_success(&self) {
        if !self.streak_active.load(Ordering::Acquire) {
            return;
        }
        let mut streak = self.streak.lock();
        *streak = Streak::default();
        self.streak_active.store(false, Ordering::Release);
    }
}

/// The sending half of a connection's bounded outbound queue. Cheap to clone;
/// every clone shares one overflow count and close signal.
#[derive(Clone)]
pub(crate) struct OutboundSender {
    tx: mpsc::Sender<Outbound>,
    overflow: Arc<Overflow>,
}

/// A new bounded outbound queue. A `tolerance` of 0 is treated as 1 (the
/// first failed enqueue closes the connection).
pub(crate) fn outbound_channel(
    capacity: usize,
    tolerance: usize,
) -> (OutboundSender, OutboundReceiver) {
    let (tx, rx) = mpsc::channel(capacity);
    (
        OutboundSender {
            tx,
            overflow: Arc::new(Overflow {
                tolerance: tolerance.max(1),
                streak: parking_lot::Mutex::new(Streak::default()),
                streak_active: AtomicBool::new(false),
                closing: CancellationToken::new(),
            }),
        },
        rx,
    )
}

impl OutboundSender {
    /// Queue `frame` without waiting. [`EnqueueOutcome::Full`] means the frame
    /// was dropped (the caller decides whether that is acceptable: lossy
    /// events and snapshot-repairable pushes, yes; replies, no — use
    /// [`Self::enqueue`]). The attempt that reaches the overflow tolerance
    /// raises the close signal and reports [`EnqueueOutcome::Closed`].
    pub(crate) fn try_enqueue(&self, frame: Outbound) -> EnqueueOutcome {
        if self.overflow.closing.is_cancelled() {
            return EnqueueOutcome::Closed;
        }
        match self.tx.try_send(frame) {
            Ok(()) => {
                self.overflow.record_success();
                EnqueueOutcome::Enqueued
            }
            Err(mpsc::error::TrySendError::Closed(_)) => EnqueueOutcome::Closed,
            Err(mpsc::error::TrySendError::Full(_)) => {
                if self.overflow.record_full() {
                    EnqueueOutcome::Closed
                } else {
                    EnqueueOutcome::Full
                }
            }
        }
    }

    /// Queue `frame`, waiting for room. Never drops the frame: it is either
    /// queued ([`EnqueueOutcome::Enqueued`]) or the connection is closing
    /// ([`EnqueueOutcome::Closed`]) — a peer that keeps the queue full for the
    /// overflow tolerance (one failed attempt per [`FULL_QUEUE_ATTEMPT`] of
    /// waiting) is closed, so a reply is never lost silently.
    pub(crate) async fn enqueue(&self, frame: Outbound) -> EnqueueOutcome {
        let mut frame = frame;
        loop {
            if self.overflow.closing.is_cancelled() {
                return EnqueueOutcome::Closed;
            }
            match self.tx.try_send(frame) {
                Ok(()) => {
                    self.overflow.record_success();
                    return EnqueueOutcome::Enqueued;
                }
                Err(mpsc::error::TrySendError::Closed(_)) => return EnqueueOutcome::Closed,
                Err(mpsc::error::TrySendError::Full(returned)) => frame = returned,
            }
            if self.overflow.record_full() {
                return EnqueueOutcome::Closed;
            }
            // Wait for room; running out the attempt window without any is the
            // next failed attempt.
            tokio::select! {
                () = self.overflow.closing.cancelled() => return EnqueueOutcome::Closed,
                room = tokio::time::timeout(FULL_QUEUE_ATTEMPT, self.tx.reserve()) => match room {
                    Ok(Ok(permit)) => {
                        permit.send(frame);
                        self.overflow.record_success();
                        return EnqueueOutcome::Enqueued;
                    }
                    Ok(Err(_)) => return EnqueueOutcome::Closed,
                    Err(_elapsed) => {}
                },
            }
        }
    }

    /// [`Self::enqueue`] for a reply: `false` when the connection is closing.
    pub(crate) async fn reply(&self, reply: super::WsReply) -> bool {
        self.enqueue(Outbound::Reply(reply)).await == EnqueueOutcome::Enqueued
    }

    /// The signal the relay supervisor ends the connection on: raised by an
    /// overflow or an executor fault.
    pub(crate) fn closing(&self) -> &CancellationToken {
        &self.overflow.closing
    }

    /// Whether both senders feed the same connection queue (watch-hub
    /// subscription identity).
    pub(crate) fn same_channel(&self, other: &Self) -> bool {
        self.tx.same_channel(&other.tx)
    }
}

#[cfg(test)]
mod tests;
