//! In-memory fault-injecting WebSocket carrier (AD-16).
//!
//! [`pair`] returns the carrier half handed to the production relay loop
//! (`run_relay`) and the [`Peer`] half a test drives like a browser. The
//! carrier implements the same `Stream + Sink` surface as axum's `WebSocket`,
//! so the relay under test is the unmodified production loop; only the wire
//! is replaced. The peer controls the wire faults a real network produces:
//!
//! - **stall** — the sink's `poll_ready` stays `Pending` (a full kernel send
//!   buffer towards a dead or slow peer);
//! - **half-open** — the peer stops answering `Ping`s while the sink still
//!   accepts writes (a NAT that silently dropped the flow);
//! - **drop** — frames matching a predicate are accepted by the sink and lost
//!   on the wire (a reply or echo that never arrives);
//! - **delay** — outbound frames reach the peer late, or an inbound frame is
//!   scheduled for later delivery;
//! - **abrupt close** — a connection reset, or a clean EOF with no `Close`
//!   frame.
//!
//! Time is the tokio clock, so `#[tokio::test(start_paused = true)]` drives
//! every delay and the relay's keepalive watchdog deterministically.

use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll, Waker};
use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message};
use futures_util::{Sink, Stream};
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::time::Instant;

type Inbound = Result<Message, axum::Error>;
type DropFilter = Box<dyn Fn(&Message) -> bool + Send + Sync>;

struct Outgoing {
    msg: Message,
    at: Instant,
}

struct Shared {
    stalled: AtomicBool,
    stall_waker: parking_lot::Mutex<Option<Waker>>,
    auto_pong: AtomicBool,
    /// Weak so the peer dropping its sender ends the relay's stream (EOF)
    /// even while the carrier still exists.
    pong_tx: mpsc::WeakUnboundedSender<Inbound>,
    drop_filter: parking_lot::Mutex<Option<DropFilter>>,
    dropped: AtomicUsize,
    /// One-way relay→peer delivery delay in microseconds ([`Peer::delay_outbound`]).
    /// Shared so the auto-pong is generated when the `Ping` reaches the peer,
    /// not when the relay writes it.
    outbound_delay_us: AtomicU64,
}

/// The relay-facing half: `Stream<Item = Result<Message, axum::Error>>` plus
/// `Sink<Message, Error = axum::Error>`.
pub(crate) struct FaultCarrier {
    inbound: mpsc::UnboundedReceiver<Inbound>,
    outbound: mpsc::UnboundedSender<Outgoing>,
    shared: Arc<Shared>,
}

/// Build a connected carrier + peer. The peer auto-answers keepalive `Ping`s
/// like a browser until [`Peer::set_auto_pong`]`(false)` makes it half-open.
pub(crate) fn pair() -> (FaultCarrier, Peer) {
    let (inbound_tx, inbound_rx) = mpsc::unbounded_channel();
    let (outbound_tx, outbound_rx) = mpsc::unbounded_channel();
    let shared = Arc::new(Shared {
        stalled: AtomicBool::new(false),
        stall_waker: parking_lot::Mutex::new(None),
        auto_pong: AtomicBool::new(true),
        pong_tx: inbound_tx.downgrade(),
        drop_filter: parking_lot::Mutex::new(None),
        dropped: AtomicUsize::new(0),
        outbound_delay_us: AtomicU64::new(0),
    });
    (
        FaultCarrier {
            inbound: inbound_rx,
            outbound: outbound_tx,
            shared: Arc::clone(&shared),
        },
        Peer {
            inbound: inbound_tx,
            outbound: outbound_rx,
            pending: None,
            shared,
            pings_seen: 0,
            events: Vec::new(),
            arrivals: Vec::new(),
            replies: Vec::new(),
            close: None,
        },
    )
}

impl Stream for FaultCarrier {
    type Item = Inbound;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.get_mut().inbound.poll_recv(cx)
    }
}

impl Sink<Message> for FaultCarrier {
    type Error = axum::Error;

    fn poll_ready(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        let shared = &self.shared;
        if shared.stalled.load(Ordering::Acquire) {
            *shared.stall_waker.lock() = Some(cx.waker().clone());
            // Re-check after publishing the waker so a concurrent resume
            // cannot slip between the load and the registration.
            if shared.stalled.load(Ordering::Acquire) {
                return Poll::Pending;
            }
        }
        Poll::Ready(Ok(()))
    }

    fn start_send(self: Pin<&mut Self>, item: Message) -> Result<(), Self::Error> {
        let this = self.get_mut();
        if let Some(filter) = this.shared.drop_filter.lock().as_ref() {
            if filter(&item) {
                this.shared.dropped.fetch_add(1, Ordering::AcqRel);
                return Ok(());
            }
        }
        if let Message::Ping(payload) = &item {
            // The browser answers when the Ping reaches it, so the Pong is
            // produced once the injected relay→peer delay has elapsed (the
            // peer→relay path is instantaneous: `delay_outbound` models the
            // whole round trip). Whether the peer is half-open is decided at
            // delivery time too.
            let delay =
                Duration::from_micros(this.shared.outbound_delay_us.load(Ordering::Acquire));
            let shared = Arc::clone(&this.shared);
            let payload = payload.clone();
            if delay.is_zero() {
                answer_ping(&shared, payload);
            } else {
                tokio::spawn(async move {
                    tokio::time::sleep(delay).await;
                    answer_ping(&shared, payload);
                });
            }
        }
        this.outbound
            .send(Outgoing {
                msg: item,
                at: Instant::now(),
            })
            .map_err(|_| axum::Error::new("carrier peer disconnected"))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn poll_close(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }
}

/// The peer's reply to a delivered keepalive `Ping`: a `Pong` echoing the
/// payload unless the peer is half-open.
fn answer_ping(shared: &Shared, payload: axum::body::Bytes) {
    if !shared.auto_pong.load(Ordering::Acquire) {
        return;
    }
    if let Some(tx) = shared.pong_tx.upgrade() {
        let _ = tx.send(Ok(Message::Pong(payload)));
    }
}

/// The browser-facing half. Frames the relay wrote are decoded into
/// [`Peer::events`] / replies as they are read, so assertions can scan
/// everything delivered so far.
pub(crate) struct Peer {
    inbound: mpsc::UnboundedSender<Inbound>,
    outbound: mpsc::UnboundedReceiver<Outgoing>,
    /// A frame read from the queue but still held back by `outbound_delay`.
    pending: Option<Outgoing>,
    shared: Arc<Shared>,
    /// Keepalive `Ping`s delivered so far (the carrier-level view of the
    /// relay's watchdog traffic).
    pub(crate) pings_seen: usize,
    /// Every event frame delivered so far (`events` batches flattened), in
    /// arrival order.
    pub(crate) events: Vec<Value>,
    /// Every decoded frame in ONE arrival order (`reply:<id>`,
    /// `event:<type>`), so a reply's position relative to the events around
    /// it is observable.
    pub(crate) arrivals: Vec<String>,
    replies: Vec<Value>,
    /// The `Close` frame the relay sent, as `(code, reason)`.
    pub(crate) close: Option<(u16, String)>,
}

impl Peer {
    // ---- inbound (peer → relay) -------------------------------------

    pub(crate) fn send_message(&self, message: Message) {
        let _ = self.inbound.send(Ok(message));
    }

    pub(crate) fn send_text(&self, text: impl Into<String>) {
        self.send_message(Message::Text(text.into().into()));
    }

    /// Send a JSON frame. A ledgered request type without a `command_id` is
    /// stamped with a fresh one (see `test_clock::stamp_ws_frame`); use
    /// [`Self::send_text`] to send a frame untouched.
    pub(crate) fn send_json(&self, value: &Value) {
        let mut frame = value.clone();
        crate::web::command_ledger::test_clock::stamp_ws_frame(&mut frame);
        self.send_text(frame.to_string());
    }

    pub(crate) fn send_close(&self, code: u16, reason: &str) {
        self.send_message(Message::Close(Some(CloseFrame {
            code,
            reason: reason.to_string().into(),
        })));
    }

    /// Deliver `message` to the relay after `delay` (a delayed pong, a slow
    /// request). Runs on the tokio clock.
    pub(crate) fn send_message_after(&self, delay: Duration, message: Message) {
        let tx = self.inbound.clone();
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            let _ = tx.send(Ok(message));
        });
    }

    // ---- wire faults ---------------------------------------------------

    /// Make the relay's sink block in `poll_ready` (send buffer full).
    pub(crate) fn stall_writes(&self) {
        self.shared.stalled.store(true, Ordering::Release);
    }

    /// Undo [`Self::stall_writes`] and wake the blocked writer.
    pub(crate) fn resume_writes(&self) {
        self.shared.stalled.store(false, Ordering::Release);
        if let Some(waker) = self.shared.stall_waker.lock().take() {
            waker.wake();
        }
    }

    /// `false` makes the peer half-open: it keeps accepting frames but never
    /// answers a `Ping`.
    pub(crate) fn set_auto_pong(&self, enabled: bool) {
        self.shared.auto_pong.store(enabled, Ordering::Release);
    }

    /// Lose every outbound frame `matches` accepts: the relay's `send`
    /// succeeds but nothing reaches the peer.
    pub(crate) fn drop_outbound_where(
        &self,
        matches: impl Fn(&Message) -> bool + Send + Sync + 'static,
    ) {
        *self.shared.drop_filter.lock() = Some(Box::new(matches));
    }

    pub(crate) fn clear_drop_filter(&self) {
        *self.shared.drop_filter.lock() = None;
    }

    /// How many outbound frames the drop filter has swallowed.
    pub(crate) fn dropped_frames(&self) -> usize {
        self.shared.dropped.load(Ordering::Acquire)
    }

    /// Frames written by the relay become visible to the peer this much later.
    /// This is the one-way relay→peer latency; a `Ping`'s auto-`Pong` is
    /// produced after the same delay, so keepalive round trips slow down too.
    pub(crate) fn delay_outbound(&mut self, delay: Duration) {
        self.shared
            .outbound_delay_us
            .store(delay.as_micros() as u64, Ordering::Release);
    }

    fn outbound_delay(&self) -> Duration {
        Duration::from_micros(self.shared.outbound_delay_us.load(Ordering::Acquire))
    }

    /// Connection reset: the relay's next read yields an error.
    pub(crate) fn reset(self) {
        let _ = self.inbound.send(Err(axum::Error::new(std::io::Error::new(
            std::io::ErrorKind::ConnectionReset,
            "connection reset by peer",
        ))));
    }

    // ---- outbound (relay → peer) ------------------------------------

    /// Next frame the relay wrote (honoring [`Self::delay_outbound`]), or
    /// `None` once the relay dropped its half and the queue is empty.
    /// Cancel-safe: a frame being held back for its delay survives a dropped
    /// future.
    pub(crate) async fn next_frame(&mut self) -> Option<Message> {
        if self.pending.is_none() {
            self.pending = Some(self.outbound.recv().await?);
        }
        let delay = self.outbound_delay();
        let due = self.pending.as_ref()?.at + delay;
        if !delay.is_zero() {
            tokio::time::sleep_until(due).await;
        }
        let outgoing = self.pending.take()?;
        self.absorb(&outgoing.msg);
        Some(outgoing.msg)
    }

    /// Read frames for `window` of (virtual) time.
    pub(crate) async fn read_for(&mut self, window: Duration) {
        let deadline = tokio::time::sleep(window);
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                () = &mut deadline => break,
                frame = self.next_frame() => {
                    if frame.is_none() {
                        break;
                    }
                }
            }
        }
    }

    /// Wait for the reply to request `id`, absorbing everything before it.
    pub(crate) async fn wait_reply(&mut self, id: &str) -> Value {
        loop {
            if let Some(index) = self.replies.iter().position(|reply| reply["id"] == id) {
                return self.replies.remove(index);
            }
            if self.next_frame().await.is_none() {
                panic!("carrier closed before the reply to `{id}` arrived");
            }
        }
    }

    /// Wait until an event of `type_` has been delivered; returns the first.
    pub(crate) async fn wait_event(&mut self, type_: &str) -> Value {
        loop {
            if let Some(event) = self.events.iter().find(|e| e["type"] == type_) {
                return event.clone();
            }
            if self.next_frame().await.is_none() {
                panic!("carrier closed before a `{type_}` event arrived");
            }
        }
    }

    /// Wait for the relay's `Close` frame and return `(code, reason)`.
    pub(crate) async fn wait_close(&mut self) -> Option<(u16, String)> {
        while self.close.is_none() {
            self.next_frame().await?;
        }
        self.close.clone()
    }

    /// Events of `type_` delivered so far.
    pub(crate) fn events_of(&self, type_: &str) -> Vec<&Value> {
        self.events.iter().filter(|e| e["type"] == type_).collect()
    }

    fn absorb(&mut self, message: &Message) {
        match message {
            Message::Text(text) => {
                for frame in decode_frame(text) {
                    self.arrivals.push(frame.label());
                    match frame {
                        Decoded::Event(event) => self.events.push(event),
                        Decoded::Reply(reply) => self.replies.push(reply),
                    }
                }
            }
            Message::Close(frame) => {
                self.close = Some(
                    frame
                        .as_ref()
                        .map_or((1005, String::new()), |f| (f.code, f.reason.to_string())),
                );
            }
            Message::Ping(_) => self.pings_seen += 1,
            Message::Binary(_) | Message::Pong(_) => {}
        }
    }
}

/// One decoded outbound text frame (a batch decodes to several).
pub(crate) enum Decoded {
    Event(Value),
    Reply(Value),
}

impl Decoded {
    /// The arrival-log label.
    pub(crate) fn label(&self) -> String {
        match self {
            Self::Event(event) => format!("event:{}", event["type"].as_str().unwrap_or("?")),
            Self::Reply(reply) => format!("reply:{}", reply["id"].as_str().unwrap_or("?")),
        }
    }
}

/// Classify one `/ws` text frame exactly as a client would: an `events` batch
/// flattens to its events, anything with `ok` is a reply, the rest (events,
/// heartbeat, gap) are events.
pub(crate) fn decode_frame(text: &str) -> Vec<Decoded> {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return Vec::new();
    };
    if value["type"] == crate::web::ws::WS_BATCH_TYPE {
        return value["events"]
            .as_array()
            .map(|batch| batch.iter().cloned().map(Decoded::Event).collect())
            .unwrap_or_default();
    }
    if value.get("ok").is_some() {
        return vec![Decoded::Reply(value)];
    }
    vec![Decoded::Event(value)]
}
