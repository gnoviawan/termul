//! Host-wide connection runtime (AD-19): the shutdown coordination every
//! upgraded `/ws` and `/terminal/ws` socket joins, and the per-connection
//! overflow tolerance, both threaded through `AppState` by `serve_router`.
//!
//! `axum::serve`'s graceful shutdown only stops accepting and drains plain
//! HTTP requests: a connection that already upgraded is handed to a detached
//! task, so without this coordination a stopped host keeps serving its open
//! sockets. [`HostShutdown`] gives each upgraded socket a [`SocketLease`]
//! (taken in the upgrade handler, so it is registered before the handler
//! returns and therefore before axum's own drain completes). On stop the host
//! calls [`HostShutdown::begin`] (every socket sees [`SocketLease::stopping`]
//! fire and sends `Close(1001 host stopping)`), then [`HostShutdown::drain`]
//! awaits every lease and aborts what ignores the close.

use std::future::Future;
use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message};
use futures_util::{Sink, SinkExt};
use tokio_util::sync::CancellationToken;
use tokio_util::task::task_tracker::TaskTrackerToken;
use tokio_util::task::TaskTracker;
use tracing::warn;

/// RFC 6455 "going away": the close code sent to every socket when the host
/// stops.
pub const CLOSE_GOING_AWAY: u16 = 1001;
/// Close reason sent with [`CLOSE_GOING_AWAY`].
pub const CLOSE_REASON_HOST_STOPPING: &str = "host stopping";
/// How long a socket may spend trying to deliver its `Close` frame before it
/// gives up and closes anyway (a peer that stopped draining must not hold the
/// host open).
pub const CLOSE_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
/// How long [`HostShutdown::drain`] waits for the sockets to finish on their
/// own before aborting the stragglers: the close drain plus slack for the
/// per-connection cleanup that follows it.
pub const SOCKET_DRAIN_BOUND: Duration = Duration::from_secs(5);
/// Grace given to aborted stragglers to unwind before they are reported.
const ABORT_GRACE: Duration = Duration::from_secs(1);

/// Shutdown coordination shared by every upgraded socket of one host
/// (`serve_router` call). Cheap to clone.
#[derive(Clone, Default)]
pub struct HostShutdown {
    /// Fires when the host starts stopping.
    stop: CancellationToken,
    /// Fires when the drain bound elapsed: sockets still running are aborted.
    abort: CancellationToken,
    tracker: TaskTracker,
}

impl HostShutdown {
    /// Register one upgraded socket. Hold the lease for the socket task's
    /// whole life; [`Self::drain`] waits for every lease to drop.
    #[must_use]
    pub fn admit(&self) -> SocketLease {
        SocketLease {
            _registration: self.tracker.token(),
            stop: self.stop.clone(),
            abort: self.abort.clone(),
        }
    }

    /// Start stopping: every admitted socket is told to close. Idempotent.
    pub fn begin(&self) {
        self.stop.cancel();
    }

    /// Whether [`Self::begin`] has run.
    #[must_use]
    pub fn is_stopping(&self) -> bool {
        self.stop.is_cancelled()
    }

    /// Wait up to `bound` for every admitted socket to finish; then abort the
    /// ones still running and give them a short grace to unwind. Returns how
    /// many sockets were still running after the grace (0 on a clean drain).
    pub async fn drain(&self, bound: Duration) -> usize {
        self.tracker.close();
        if tokio::time::timeout(bound, self.tracker.wait()).await.is_ok() {
            return 0;
        }
        let stragglers = self.tracker.len();
        warn!(
            target: "termul::web::shutdown",
            stragglers,
            "sockets still open after the drain bound; aborting them"
        );
        self.abort.cancel();
        if tokio::time::timeout(ABORT_GRACE, self.tracker.wait())
            .await
            .is_ok()
        {
            return 0;
        }
        let leaked = self.tracker.len();
        warn!(
            target: "termul::web::shutdown",
            leaked,
            "aborted sockets did not unwind within the grace period"
        );
        leaked
    }
}

/// One admitted socket's membership in the host shutdown.
pub struct SocketLease {
    _registration: TaskTrackerToken,
    stop: CancellationToken,
    abort: CancellationToken,
}

impl SocketLease {
    /// The stop token, for handing to the socket's sub-tasks.
    #[must_use]
    pub fn stop_token(&self) -> CancellationToken {
        self.stop.clone()
    }

    /// Run the socket's `serve` future to completion, or drop it when the
    /// drain bound forces an abort. Dropping the future drops everything it
    /// owns, so the socket and its sub-tasks go with it. The lease is released
    /// when this returns.
    pub async fn run<F: Future<Output = ()>>(self, serve: F) {
        tokio::select! {
            () = serve => {}
            () = self.abort.cancelled() => {
                warn!(
                    target: "termul::web::shutdown",
                    "socket ignored the host stop; aborted"
                );
            }
        }
    }
}

/// Per-host connection settings and shutdown handle, carried in `AppState`.
#[derive(Clone)]
pub struct ConnectionRuntime {
    pub shutdown: HostShutdown,
    /// Consecutive failed outbound enqueues before a slow peer is closed
    /// (`ServerConfig::overflow_tolerance`).
    pub overflow_tolerance: usize,
}

impl ConnectionRuntime {
    #[must_use]
    pub fn new(overflow_tolerance: usize) -> Self {
        Self {
            shutdown: HostShutdown::default(),
            overflow_tolerance,
        }
    }
}

impl Default for ConnectionRuntime {
    /// A runtime that is never stopped, with the default tolerance (tests,
    /// and routers not built by `serve_router`).
    fn default() -> Self {
        Self::new(crate::web::config::DEFAULT_OVERFLOW_TOLERANCE)
    }
}

/// Try to deliver `Close(1001 host stopping)` on `sink`, bounded by
/// [`CLOSE_DRAIN_TIMEOUT`]. A peer that stopped draining makes this give up;
/// the caller closes the socket either way.
pub async fn send_going_away<S>(sink: &mut S)
where
    S: Sink<Message> + Unpin,
{
    send_close(
        sink,
        CloseFrame {
            code: CLOSE_GOING_AWAY,
            reason: CLOSE_REASON_HOST_STOPPING.into(),
        },
    )
    .await;
}

/// Try to deliver `frame` as a `Close` on `sink`, bounded by
/// [`CLOSE_DRAIN_TIMEOUT`].
pub async fn send_close<S>(sink: &mut S, frame: CloseFrame)
where
    S: Sink<Message> + Unpin,
{
    let code = frame.code;
    match tokio::time::timeout(CLOSE_DRAIN_TIMEOUT, sink.send(Message::Close(Some(frame)))).await {
        Ok(Ok(())) => {}
        Ok(Err(_)) => tracing::debug!(
            target: "termul::web::shutdown",
            code,
            "close frame not delivered: peer already gone"
        ),
        Err(_) => warn!(
            target: "termul::web::shutdown",
            code,
            "close frame not delivered within the drain timeout; closing anyway"
        ),
    }
}

#[cfg(test)]
mod tests;
