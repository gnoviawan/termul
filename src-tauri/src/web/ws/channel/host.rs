//! The desktop's Channel connection registry (`connId -> inbound queue +
//! cancel + owning window`) and the lifecycle of each connection.
//!
//! One connection is one [`run_relay`] instance over a [`ChannelCarrier`],
//! admitted into the host shutdown so the app-exit drain closes it with
//! `channel_closed` 1001 before agents are killed. Every way a connection
//! ends — `ws_channel_close`, the window `Destroyed` hook, the relay
//! returning on its own (watchdog, host stop) — goes through [`WsChannelHost::close`]
//! semantics: the entry is removed once and the relay's cleanup (subscriptions,
//! presence, fs watches) runs once.

use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::web::connection_runtime::{SocketLease, SOCKET_DRAIN_BOUND};

use super::super::*;
use super::{
    channel_closed_frame, ChannelCarrier, FrameSink, CHANNEL_CLOSE_ENDED,
    CHANNEL_CLOSE_ENDED_REASON, INBOUND_QUEUE_CAPACITY,
};

/// After a close request the relay gets this long to end gracefully (its read
/// loop sees the queue end) before it is dropped; its cleanup still runs.
const CLOSE_GRACE: Duration = Duration::from_secs(2);

/// Why a Channel command was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelError {
    /// No such connection, or it already closed.
    UnknownConnection,
    /// The connection's inbound queue is full.
    QueueFull,
    /// The host is stopping and takes no new connections.
    HostStopping,
}

impl fmt::Display for ChannelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::UnknownConnection => "unknown or closed ws channel connection",
            Self::QueueFull => "ws channel inbound queue full",
            Self::HostStopping => "host is stopping",
        })
    }
}

impl std::error::Error for ChannelError {}

struct Entry {
    inbound: mpsc::Sender<String>,
    cancel: CancellationToken,
    /// Label of the window whose webview opened the connection.
    window: String,
}

struct Inner {
    state: AppState,
    next_id: AtomicU64,
    connections: parking_lot::Mutex<HashMap<u64, Entry>>,
}

/// Managed Tauri state: every live Channel connection of the desktop app.
#[derive(Clone)]
pub struct WsChannelHost {
    inner: Arc<Inner>,
}

/// The peer address the desktop's own webview presents: loopback, so
/// capabilities resolve write.
fn local_peer() -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], 0))
}

impl WsChannelHost {
    /// A host serving `state` (see `AppState::desktop_local`).
    #[must_use]
    pub fn new(state: AppState) -> Self {
        Self {
            inner: Arc::new(Inner {
                state,
                next_id: AtomicU64::new(1),
                connections: parking_lot::Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Open one relay connection for `window`, delivering frames through
    /// `send`. Returns the connection id. Must run inside a Tokio runtime.
    pub fn open(&self, window: &str, send: FrameSink) -> Result<u64, ChannelError> {
        let shutdown = &self.inner.state.connections.shutdown;
        if shutdown.is_stopping() {
            return Err(ChannelError::HostStopping);
        }
        // Admitted before the task is spawned, like the `/ws` upgrade, so the
        // exit drain cannot miss a connection that has not started yet.
        let lease = shutdown.admit();
        let conn_id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (inbound_tx, inbound_rx) = mpsc::channel(INBOUND_QUEUE_CAPACITY);
        let cancel = CancellationToken::new();
        let terminal_sent = Arc::new(AtomicBool::new(false));
        self.inner.connections.lock().insert(
            conn_id,
            Entry {
                inbound: inbound_tx,
                cancel: cancel.clone(),
                window: window.to_owned(),
            },
        );
        log::info!("[ws-channel] conn={conn_id} opened window={window}");
        let carrier = ChannelCarrier::new(
            conn_id,
            inbound_rx,
            Arc::clone(&send),
            Arc::clone(&terminal_sent),
        );
        tokio::spawn(serve_connection(
            Arc::clone(&self.inner),
            conn_id,
            lease,
            carrier,
            cancel,
            send,
            terminal_sent,
        ));
        Ok(conn_id)
    }

    /// Enqueue one inbound text frame for `conn_id`. This is only an enqueue
    /// ack: replies and events come back on the connection's Channel.
    pub fn send(&self, conn_id: u64, frame: String) -> Result<(), ChannelError> {
        let inbound = self
            .inner
            .connections
            .lock()
            .get(&conn_id)
            .map(|entry| entry.inbound.clone())
            .ok_or(ChannelError::UnknownConnection)?;
        inbound.try_send(frame).map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => ChannelError::QueueFull,
            mpsc::error::TrySendError::Closed(_) => ChannelError::UnknownConnection,
        })
    }

    /// Close one connection. Idempotent: `false` when it was already closed.
    pub fn close(&self, conn_id: u64) -> bool {
        let Some(entry) = self.inner.connections.lock().remove(&conn_id) else {
            return false;
        };
        log::info!("[ws-channel] conn={conn_id} closing on request");
        entry.cancel.cancel();
        true
    }

    /// Close every connection a destroyed window opened. Returns how many.
    pub fn close_window(&self, window: &str) -> usize {
        let ids: Vec<u64> = self
            .inner
            .connections
            .lock()
            .iter()
            .filter(|(_, entry)| entry.window == window)
            .map(|(id, _)| *id)
            .collect();
        let closed = ids.into_iter().filter(|id| self.close(*id)).count();
        if closed > 0 {
            log::info!("[ws-channel] window={window} destroyed; closed {closed} connection(s)");
        }
        closed
    }

    /// Host stop (app exit): every connection gets `channel_closed` 1001 and
    /// is awaited, aborting stragglers past the drain bound. Run before the
    /// agents are killed.
    pub async fn drain(&self) {
        let shutdown = &self.inner.state.connections.shutdown;
        shutdown.begin();
        let stragglers = shutdown.drain(SOCKET_DRAIN_BOUND).await;
        log::info!("[ws-channel] drained at exit stragglers={stragglers}");
    }
}

/// Run one connection to its end, then forget it and tell the peer if the
/// host (not the peer) ended it.
async fn serve_connection(
    inner: Arc<Inner>,
    conn_id: u64,
    lease: SocketLease,
    carrier: ChannelCarrier,
    cancel: CancellationToken,
    send: FrameSink,
    terminal_sent: Arc<AtomicBool>,
) {
    let stop = lease.stop_token();
    lease
        .run(async {
            let relay = run_relay(carrier, inner.state.clone(), local_peer(), Carrier::Ipc, stop);
            tokio::pin!(relay);
            tokio::select! {
                () = &mut relay => {}
                () = close_deadline(&cancel) => {
                    log::warn!("[ws-channel] conn={conn_id} ignored close; dropping it");
                }
            }
        })
        .await;
    inner.connections.lock().remove(&conn_id);
    // A close the peer asked for needs no frame, and a `Close` the relay sent
    // already produced one. Anything else (silent-peer watchdog, overflow, a
    // drain abort) is host-initiated: say so before the Channel goes away.
    if !cancel.is_cancelled() && !terminal_sent.load(Ordering::Acquire) {
        let _ = send(channel_closed_frame(CHANNEL_CLOSE_ENDED, CHANNEL_CLOSE_ENDED_REASON));
    }
    log::info!("[ws-channel] conn={conn_id} ended");
}

/// Completes [`CLOSE_GRACE`] after `cancel` fired.
async fn close_deadline(cancel: &CancellationToken) {
    cancel.cancelled().await;
    tokio::time::sleep(CLOSE_GRACE).await;
}
