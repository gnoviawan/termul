//! Tauri `ipc::Channel` carrier for the `/ws` relay (desktop, no socket).
//!
//! [`ChannelCarrier`] is the same `Stream + Sink` surface axum's `WebSocket`
//! has, so the UNMODIFIED [`run_relay`] serves it: same dispatch, executor,
//! outbound queue, watchdog and capabilities as `/ws`. Only frame IO differs:
//!
//! - **inbound** — a bounded queue of text frames fed by the `ws_channel_send`
//!   command (an enqueue ack only; replies travel the Channel);
//! - **outbound** — one string per message through a [`FrameSink`] (in
//!   production `tauri::ipc::Channel<String>::send`), in the relay's single
//!   ordered outbound order.
//!
//! `Ping`/`Pong` never cross the Channel and nothing auto-answers them:
//! liveness comes from the renderer's own frames (`ping` requests,
//! `background`/`foreground`), `ws_channel_close` and the window `Destroyed`
//! hook. A `Close` becomes a final `{"type":"channel_closed",..}` frame; the
//! end of the Channel is the terminal signal after it.
//!
//! [`host`] owns the connection registry; [`commands`] the Tauri surface.

use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};

use futures_util::{Sink, Stream};
use serde_json::json;
use tokio::sync::mpsc;

use super::*;

pub mod commands;
mod host;

pub use host::{ChannelError, WsChannelHost};

#[cfg(test)]
mod tests;

/// Top-level frame type the host sends last when IT ends a connection:
/// `{"type":"channel_closed","code":<u16>,"reason":"<string>"}`.
pub const WS_CHANNEL_CLOSED_TYPE: &str = "channel_closed";

/// Close code for a connection the relay ended without a close handshake
/// (silent-peer watchdog, outbound overflow, a failed send): "unexpected
/// condition", RFC 6455 1011.
pub const CHANNEL_CLOSE_ENDED: u16 = 1011;
/// Reason sent with [`CHANNEL_CLOSE_ENDED`].
pub const CHANNEL_CLOSE_ENDED_REASON: &str = "connection ended by host";

/// Max inbound frames queued between `ws_channel_send` and the read loop. A
/// full queue refuses the send (the renderer sees the invoke error) instead of
/// growing without bound behind a stalled handler.
pub const INBOUND_QUEUE_CAPACITY: usize = 256;

/// Delivers one outbound frame (the exact JSON text a `/ws` socket would
/// carry) to the peer. `Err` means the peer is gone.
pub type FrameSink = Arc<dyn Fn(String) -> Result<(), String> + Send + Sync>;

/// The `channel_closed` control frame text.
pub(crate) fn channel_closed_frame(code: u16, reason: &str) -> String {
    json!({ "type": WS_CHANNEL_CLOSED_TYPE, "code": code, "reason": reason }).to_string()
}

/// The relay-facing half of one Channel connection.
pub(crate) struct ChannelCarrier {
    conn_id: u64,
    inbound: mpsc::Receiver<String>,
    send: FrameSink,
    /// Set once a `channel_closed` frame went out (the relay's own `Close`),
    /// so the connection supervisor does not send a second one.
    terminal_sent: Arc<AtomicBool>,
}

impl ChannelCarrier {
    pub(crate) fn new(
        conn_id: u64,
        inbound: mpsc::Receiver<String>,
        send: FrameSink,
        terminal_sent: Arc<AtomicBool>,
    ) -> Self {
        Self {
            conn_id,
            inbound,
            send,
            terminal_sent,
        }
    }

    fn deliver(&self, text: String) -> Result<(), axum::Error> {
        (self.send)(text).map_err(|error| {
            log::warn!(
                "[ws-channel] conn={} delivery to the webview failed: {error}",
                self.conn_id
            );
            axum::Error::new(std::io::Error::new(std::io::ErrorKind::BrokenPipe, error))
        })
    }
}

impl Stream for ChannelCarrier {
    type Item = Result<Message, axum::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        // The queue ending (every sender dropped by a close) is the stream's
        // EOF: the read loop returns and the connection tears down.
        self.inbound
            .poll_recv(cx)
            .map(|frame| frame.map(|text| Ok(Message::Text(text.into()))))
    }
}

impl Sink<Message> for ChannelCarrier {
    type Error = axum::Error;

    fn poll_ready(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        // `Channel::send` hands the frame to the webview synchronously; the
        // relay's bounded outbound queue is the only buffer.
        Poll::Ready(Ok(()))
    }

    fn start_send(self: Pin<&mut Self>, message: Message) -> Result<(), Self::Error> {
        match message {
            Message::Text(text) => self.deliver(text.as_str().to_owned()),
            Message::Close(frame) => {
                let (code, reason) = frame.map_or((1005, String::new()), |frame| {
                    (frame.code, frame.reason.as_str().to_owned())
                });
                self.terminal_sent.store(true, Ordering::Release);
                self.deliver(channel_closed_frame(code, &reason))
            }
            // Keepalive control frames never reach the renderer; the relay
            // writes no binary frames.
            Message::Ping(_) | Message::Pong(_) | Message::Binary(_) => Ok(()),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn poll_close(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }
}
