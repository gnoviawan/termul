//! Cross-carrier test peers (AD-16): one [`Wire`] contract over the
//! `FaultCarrier` [`Peer`] and the desktop Channel carrier ([`ChannelPeer`]),
//! so a contract test body written once runs through both. Both keep a
//! COMBINED arrival-order log (`reply:<id>` / `event:<type>`) so reply-vs-echo
//! order is observable. Fault knobs (stall / drop / delay) stay `Peer`-only.

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::mpsc;

use super::carrier::{decode_frame, Decoded, Peer};
use super::Host;
use crate::web::ws::channel::{FrameSink, WsChannelHost, WS_CHANNEL_CLOSED_TYPE};

/// One open client connection to a host under test.
pub(crate) trait Wire: Sized {
    /// The presence label of this carrier.
    const CARRIER_LABEL: &'static str;

    /// Open a connection on `host` (the relay is running; nothing sent yet).
    fn open(host: &Host) -> Self;
    /// Send one inbound text frame.
    fn send_text(&self, text: &str);
    fn send_json(&self, value: &Value) {
        self.send_text(&value.to_string());
    }
    async fn wait_reply(&mut self, id: &str) -> Value;
    async fn wait_event(&mut self, type_: &str) -> Value;
    /// Read (and log) frames for `window` of virtual time.
    async fn read_for(&mut self, window: Duration);
    /// Events delivered so far, in arrival order.
    fn events_of(&self, type_: &str) -> Vec<Value>;
    /// Every reply/event frame in ONE arrival order.
    fn arrivals(&self) -> Vec<String>;
    /// The host's final close: the `Close` frame / the `channel_closed` frame.
    async fn wait_close(&mut self) -> Option<(u16, String)>;
    /// The peer side hangs up (a `Close` frame / `ws_channel_close`).
    fn hang_up(&self);
    /// Read until the host has ended the connection (the wire is exhausted).
    async fn wait_end(&mut self);
    /// The next frame whose text contains `needle` is lost on delivery. A
    /// failed delivery ends a Channel connection; on the fault carrier the
    /// caller follows with [`Wire::kill`].
    fn lose_frames_containing(&self, needle: &str);
    /// The connection dies abruptly (reset); the relay must reap it.
    fn kill(self);
    /// The host starts stopping (app exit / server stop).
    async fn stop_host(host: &Host);
}

// ---- FaultCarrier ----------------------------------------------------------

impl Wire for Peer {
    const CARRIER_LABEL: &'static str = "ws";

    fn open(host: &Host) -> Self {
        host.connect().peer
    }

    fn send_text(&self, text: &str) {
        Peer::send_text(self, text);
    }

    async fn wait_reply(&mut self, id: &str) -> Value {
        Peer::wait_reply(self, id).await
    }

    async fn wait_event(&mut self, type_: &str) -> Value {
        Peer::wait_event(self, type_).await
    }

    async fn read_for(&mut self, window: Duration) {
        Peer::read_for(self, window).await;
    }

    fn events_of(&self, type_: &str) -> Vec<Value> {
        Peer::events_of(self, type_).into_iter().cloned().collect()
    }

    fn arrivals(&self) -> Vec<String> {
        self.arrivals.clone()
    }

    async fn wait_close(&mut self) -> Option<(u16, String)> {
        Peer::wait_close(self).await
    }

    fn hang_up(&self) {
        self.send_close(1000, "bye");
    }

    async fn wait_end(&mut self) {
        while self.next_frame().await.is_some() {}
    }

    fn lose_frames_containing(&self, needle: &str) {
        let needle = needle.to_owned();
        self.drop_outbound_where(move |message| {
            matches!(message, axum::extract::ws::Message::Text(text) if text.contains(&needle))
        });
    }

    fn kill(self) {
        self.reset();
    }

    async fn stop_host(host: &Host) {
        host.state.connections.shutdown.begin();
    }
}

// ---- Channel carrier -------------------------------------------------------

/// The Channel test peer: what the renderer's `ChannelSocket` is. `open` goes
/// through the desktop host's real registry; frames arrive through a
/// `Channel::new`-style closure (no webview).
pub(crate) struct ChannelPeer {
    host: WsChannelHost,
    id: u64,
    frames: mpsc::UnboundedReceiver<String>,
    /// Delivery of the next frame containing this text fails once.
    fail_once: Arc<parking_lot::Mutex<Option<String>>>,
    events: Vec<Value>,
    replies: Vec<Value>,
    arrivals: Vec<String>,
    close: Option<(u16, String)>,
}

impl ChannelPeer {
    pub(crate) const WINDOW: &'static str = "main";

    pub(crate) fn connection_id(&self) -> u64 {
        self.id
    }

    pub(crate) fn host(&self) -> &WsChannelHost {
        &self.host
    }

    /// Absorb the next delivered frame; `false` once the Channel ended.
    pub(crate) async fn next_frame(&mut self) -> bool {
        let Some(text) = self.frames.recv().await else {
            return false;
        };
        self.absorb(&text);
        true
    }

    fn absorb(&mut self, text: &str) {
        if let Ok(frame) = serde_json::from_str::<Value>(text) {
            if frame["type"] == WS_CHANNEL_CLOSED_TYPE {
                self.close = Some((
                    frame["code"].as_u64().expect("channel_closed carries a code") as u16,
                    frame["reason"].as_str().unwrap_or_default().to_owned(),
                ));
                self.arrivals.push("closed".to_owned());
                return;
            }
        }
        for frame in decode_frame(text) {
            self.arrivals.push(frame.label());
            match frame {
                Decoded::Event(event) => self.events.push(event),
                Decoded::Reply(reply) => self.replies.push(reply),
            }
        }
    }
}

impl Wire for ChannelPeer {
    const CARRIER_LABEL: &'static str = "ipc";

    fn open(host: &Host) -> Self {
        let (tx, frames) = mpsc::unbounded_channel();
        let fail_once = Arc::new(parking_lot::Mutex::new(None::<String>));
        let failing = Arc::clone(&fail_once);
        let send: FrameSink = Arc::new(move |text: String| {
            let mut failing = failing.lock();
            if failing.as_deref().is_some_and(|needle| text.contains(needle)) {
                *failing = None;
                return Err("simulated webview delivery failure".to_owned());
            }
            tx.send(text).map_err(|_| "channel receiver gone".to_owned())
        });
        let host = host.channel_host().clone();
        let id = host.open(Self::WINDOW, send).expect("the host accepts a connection");
        Self {
            host,
            id,
            frames,
            fail_once,
            events: Vec::new(),
            replies: Vec::new(),
            arrivals: Vec::new(),
            close: None,
        }
    }

    fn send_text(&self, text: &str) {
        self.host
            .send(self.id, text.to_owned())
            .expect("the connection accepts an inbound frame");
    }

    async fn wait_reply(&mut self, id: &str) -> Value {
        loop {
            if let Some(index) = self.replies.iter().position(|reply| reply["id"] == id) {
                return self.replies.remove(index);
            }
            if !self.next_frame().await {
                panic!("channel closed before the reply to `{id}` arrived");
            }
        }
    }

    async fn wait_event(&mut self, type_: &str) -> Value {
        loop {
            if let Some(event) = self.events.iter().find(|event| event["type"] == type_) {
                return event.clone();
            }
            if !self.next_frame().await {
                panic!("channel closed before a `{type_}` event arrived");
            }
        }
    }

    async fn read_for(&mut self, window: Duration) {
        let deadline = tokio::time::sleep(window);
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                () = &mut deadline => break,
                more = self.next_frame() => {
                    if !more {
                        break;
                    }
                }
            }
        }
    }

    fn events_of(&self, type_: &str) -> Vec<Value> {
        self.events
            .iter()
            .filter(|event| event["type"] == type_)
            .cloned()
            .collect()
    }

    fn arrivals(&self) -> Vec<String> {
        self.arrivals.clone()
    }

    async fn wait_close(&mut self) -> Option<(u16, String)> {
        while self.close.is_none() {
            if !self.next_frame().await {
                break;
            }
        }
        self.close.clone()
    }

    fn hang_up(&self) {
        self.host.close(self.id);
    }

    async fn wait_end(&mut self) {
        while self.next_frame().await {}
    }

    fn lose_frames_containing(&self, needle: &str) {
        *self.fail_once.lock() = Some(needle.to_owned());
    }

    fn kill(self) {
        // A failed delivery already ended the connection; closing is the
        // idempotent safety net for the rest.
        self.host.close(self.id);
    }

    async fn stop_host(host: &Host) {
        host.channel_host().drain().await;
    }
}

/// Run the versioned `authenticate` handshake on any wire and require `ok`.
pub(crate) async fn authenticate<W: Wire>(wire: &mut W) {
    let reply = request(wire, "auth", "authenticate", authenticate_payload()).await;
    assert_eq!(reply["ok"], true, "handshake refused: {reply}");
}

pub(crate) fn authenticate_payload() -> Value {
    serde_json::json!({
        "protocolVersion": crate::web::ws::WS_PROTOCOL_VERSION,
        "deviceId": "device-harness",
        "clientInstanceId": "tab-harness",
    })
}

/// Send a request frame and wait for its reply, on any wire.
pub(crate) async fn request<W: Wire>(wire: &mut W, id: &str, type_: &str, payload: Value) -> Value {
    send_request(wire, id, type_, payload);
    wire.wait_reply(id).await
}

pub(crate) fn send_request<W: Wire>(wire: &W, id: &str, type_: &str, payload: Value) {
    wire.send_json(&serde_json::json!({"id": id, "type": type_, "payload": payload}));
}
