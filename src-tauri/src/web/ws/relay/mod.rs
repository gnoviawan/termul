//! `/ws` upgrade handler + the per-connection relay supervisor (AD-19).
//!
//! One connection is four cooperating tasks owned by [`run_relay`]:
//!
//! - the **read loop** ([`reader`]) parses, validates and hands each request to
//!   the keyed executor; it never awaits a handler;
//! - the **executor** ([`executor`]) runs requests concurrently across
//!   entities and in arrival order within one;
//! - the **write loop** ([`writer`]) drains the bounded outbound queue
//!   ([`outbound`]) and owns the close handshakes;
//! - the **watchdog** ([`watchdog`]) closes a silent peer on its own timer.
//!
//! The first of them to finish ends the connection; the rest are aborted and
//! the connection's subscriptions are released exactly once.

use futures_util::{Sink, Stream};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use crate::web::connection_runtime::SocketLease;

use super::*;

mod conn;
mod executor;
mod outbound;
mod reader;
mod watchdog;
mod writer;

pub(super) use conn::{ConnState, HandlerEnv, Subscriptions};
#[cfg(test)]
pub(super) use conn::dispatch_connection_text;
#[cfg(test)]
pub(super) use executor::KeyedExecutor;
pub(crate) use outbound::{
    outbound_channel, EnqueueOutcome, OutboundSender, OUTBOUND_QUEUE_CAPACITY,
};
pub(super) use watchdog::{PING_INTERVAL, PONG_TIMEOUT};
#[cfg(test)]
pub(super) use watchdog::{watchdog_is_stale, BACKGROUND_TIMEOUT, WATCHDOG_TICK};

// ---------------------------------------------------------------------------
// WS upgrade handler + relay loop (AC1 + AC9 + AC10)
// ---------------------------------------------------------------------------

/// Outbound frame on a connection's write loop (event or reply). Queued
/// through the connection's bounded [`OutboundSender`].
pub(crate) enum Outbound {
    /// A sequenced event (server→client push).
    Event(SequencedEvent),
    /// A reply to a client request.
    Reply(WsReply),
    /// Terminal close handshake (CAP-11: after a binary-frame protocol error).
    /// The channel is FIFO, so everything enqueued ahead of it (the
    /// `unsupported` error reply) is flushed first; the write loop then sends
    /// `Message::Close` and breaks, guaranteeing reply-before-close ordering.
    Close(axum::extract::ws::CloseFrame),
}

/// The `auth_required` event type name (relay-level, not from `events.rs`).
pub const AUTH_REQUIRED_TYPE: &str = "auth_required";

/// Batched WS frame type: `{"type":"events","events":[{sid,seq,type,payload}]}`
/// — the write loop packs a drained burst into one frame; the client unwraps
/// inner events through the same `handleEvent` path (per-event seq intact).
pub const WS_BATCH_TYPE: &str = "events";

/// Max events per batched frame — a burst drains in ≤this-sized slices so a
/// sustained flood still yields progressively (no unbounded flush latency).
pub(super) const WS_BATCH_MAX_EVENTS: usize = 64;

/// Build the `auth_required` event (sid=null, seq=0, payload={}).
pub(super) fn auth_required_event() -> SequencedEvent {
    SequencedEvent::new(None, 0, AUTH_REQUIRED_TYPE, json!({}))
}

/// Axum WS upgrade handler for `/ws` (AC1).
///
/// The upgrade itself always proceeds; the token gate lives in the
/// first-frame `authenticate` handling (`pre_auth_reply`), so a wrong token
/// gets a structured `unauthorized` reply instead of a failed handshake. The
/// default bind stays localhost per `web/config.rs`.
///
/// The peer address (`ConnectInfo`) feeds the connection's capabilities,
/// resolved at `authenticate`; the router MUST be served with
/// `into_make_service_with_connect_info::<SocketAddr>()`.
///
/// The socket joins the host shutdown here, before the handler returns, so the
/// host's drain cannot miss a socket whose upgrade is still completing.
pub async fn ws_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
) -> impl IntoResponse {
    let lease = state.connections.shutdown.admit();
    ws.on_upgrade(move |socket| serve_socket(lease, socket, state, peer))
}

/// Serve an upgraded socket under its shutdown `lease`: [`run_relay`] until it
/// ends, or until the host's drain bound forces an abort.
pub(super) async fn serve_socket<S>(lease: SocketLease, socket: S, state: AppState, peer: SocketAddr)
where
    S: Stream<Item = Result<Message, axum::Error>> + Sink<Message, Error = axum::Error> + Send + 'static,
{
    let stop = lease.stop_token();
    lease.run(run_relay(socket, state, peer, stop)).await;
}

/// CAP-3: consume an id-less `background`/`foreground` lifecycle control frame.
/// Returns `true` when the frame was a lifecycle signal and the caller should
/// skip dispatch (no reply, no `WsRequest` parse). The `backgrounded` flag is
/// toggled ONLY when `authed` (an unauthenticated peer cannot manipulate the
/// watchdog ceiling); an unauthenticated signal is still consumed (ignored,
/// no dispatch, no error). Returns `false` for any other frame — the caller
/// then resets the flag ("any normal frame resets the normal timeout") and
/// dispatches as a normal ACP request.
pub(super) fn handle_lifecycle_signal(text: &str, authed: bool, backgrounded: &AtomicBool) -> bool {
    if let Some(type_) = peer_frame_type(text) {
        match type_.as_str() {
            "background" => {
                if authed {
                    backgrounded.store(true, Ordering::Relaxed);
                } else {
                    debug!("[ws] ignoring background signal from unauthenticated connection");
                }
                true
            }
            "foreground" => {
                if authed {
                    backgrounded.store(false, Ordering::Relaxed);
                }
                true
            }
            _ => false,
        }
    } else {
        false
    }
}

/// Run the per-connection relay: a write loop draining the bounded outbound
/// queue, a read loop routing requests into the executor, and the watchdog.
/// Returns when the first of them ends (or the connection must close), after
/// aborting the rest and releasing the connection's subscriptions.
///
/// Generic over the carrier so a host-level fault harness can drive the exact
/// production loop over an in-memory duplex; axum's `WebSocket` satisfies
/// both bounds, so the production path is unchanged. `stop` is the host
/// shutdown signal: the write loop answers it with `Close(1001)`.
pub(super) async fn run_relay<S>(socket: S, state: AppState, peer: SocketAddr, stop: CancellationToken)
where
    S: Stream<Item = Result<Message, axum::Error>>
        + Sink<Message, Error = axum::Error>
        + Send
        + 'static,
{
    let (sink, stream) = socket.split();
    let (out_tx, out_rx) = outbound_channel(
        OUTBOUND_QUEUE_CAPACITY,
        state.connections.overflow_tolerance,
    );
    let closing = out_tx.closing().clone();
    let subscriptions = Arc::new(Subscriptions::default());
    let cleanup = ConnectionCleanup::new(Arc::clone(&state.relay), Arc::clone(&subscriptions))
        .with_watch_conn(out_tx.clone());
    // AC9: emit auth_required on the connection before anything else.
    if out_tx.enqueue(Outbound::Event(auth_required_event())).await != EnqueueOutcome::Enqueued {
        return; // peer already gone.
    }

    let liveness = Arc::new(watchdog::Liveness::new());
    let conn = ConnState::new(
        ConnectionAccess::new(CapabilityPolicy::for_connection(Carrier::Ws, peer, &state)),
        subscriptions,
    );
    let env = HandlerEnv::new(&state, out_tx.clone(), &conn);

    // Dropping the set aborts every task, so even a cancelled `run_relay`
    // (the host aborting a straggler) leaves nothing running.
    let mut tasks = JoinSet::new();
    tasks.spawn(writer::run_writer(sink, out_rx, stop));
    tasks.spawn(watchdog::run_watchdog(Arc::clone(&liveness)));
    tasks.spawn(reader::run_reader(
        stream,
        conn,
        env,
        out_tx,
        liveness,
        closing.clone(),
    ));
    tokio::select! {
        _ = tasks.join_next() => {}
        () = closing.cancelled() => {}
    }
    tasks.shutdown().await;
    cleanup.run().await;
}

pub(super) struct ConnectionCleanup {
    relay: Arc<WsRelaySink>,
    subscriptions: Arc<Subscriptions>,
    /// This connection's outbound channel, the identity its `watch_project`
    /// subscriptions are keyed by; released with the rest of the cleanup.
    watch_conn: Option<OutboundSender>,
    state: Arc<std::sync::atomic::AtomicU8>,
}

impl ConnectionCleanup {
    pub(super) fn new(
        relay: Arc<WsRelaySink>,
        subscriptions: Arc<Subscriptions>,
    ) -> Self {
        Self {
            relay,
            subscriptions,
            watch_conn: None,
            state: Arc::new(std::sync::atomic::AtomicU8::new(0)),
        }
    }

    pub(super) fn with_watch_conn(mut self, conn: OutboundSender) -> Self {
        self.watch_conn = Some(conn);
        self
    }

    /// Drop this connection's per-project fs watch subscriptions (sync; safe
    /// from `Drop` outside a runtime).
    fn release_watches(&self) {
        if let Some(conn) = &self.watch_conn {
            self.relay.fs_watches().unsubscribe_all(conn);
        }
    }

    pub(super) async fn run(&self) {
        if self
            .state
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        self.release_watches();
        let relay = Arc::clone(&self.relay);
        let subscriptions = Arc::clone(&self.subscriptions);
        let state = Arc::clone(&self.state);
        let cleanup = tokio::spawn(async move {
            cleanup_connection_subscriptions(&relay, &subscriptions).await;
            state.store(2, Ordering::Release);
        });
        let _ = cleanup.await;
    }
}

impl Drop for ConnectionCleanup {
    fn drop(&mut self) {
        if self
            .state
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        self.release_watches();
        let relay = Arc::clone(&self.relay);
        let subscriptions = Arc::clone(&self.subscriptions);
        let state = Arc::clone(&self.state);
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                cleanup_connection_subscriptions(&relay, &subscriptions).await;
                state.store(2, Ordering::Release);
            });
        } else {
            warn!(
                target: "termul::web::ws",
                "connection cleanup dropped outside a Tokio runtime"
            );
        }
    }
}
