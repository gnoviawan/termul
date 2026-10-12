//! The read loop: stamps liveness on every inbound frame, consumes the CAP-3
//! lifecycle signals and the CAP-11 binary-frame protocol error, and hands text
//! requests to [`dispatch_connection_text`]. It never awaits a handler, so
//! pongs and requests keep flowing while a handler runs.

use futures_util::Stream;

use super::super::*;
use super::conn::{dispatch_connection_text, ConnState, HandlerEnv};
use super::executor::KeyedExecutor;
use super::outbound::OutboundSender;
use super::watchdog::Liveness;

/// Run the read loop until the peer closes, the stream errors, or the
/// connection is closing.
pub(super) async fn run_reader<St>(
    mut stream: St,
    mut conn: ConnState,
    env: HandlerEnv,
    out_tx: OutboundSender,
    liveness: Arc<Liveness>,
    executor: Arc<KeyedExecutor>,
) where
    St: Stream<Item = Result<Message, axum::Error>> + Unpin,
{
    // CAP-11: set once a binary frame poisons the connection. The error reply +
    // Close(1003) are already queued; further text requests must NOT dispatch
    // (they would execute before the close lands) — the loop just waits for
    // the write loop to finish the handshake.
    let mut protocol_error = false;
    while let Some(frame) = stream.next().await {
        let msg = match frame {
            Ok(msg) => msg,
            Err(error) => {
                warn!("[ws] read error: {error}");
                break;
            }
        };
        // Any frame from the client (text request, a Pong answering our
        // keepalive Ping, or a client Ping) proves the connection is live.
        liveness.touch();
        match msg {
            Message::Text(text) => {
                if protocol_error {
                    continue;
                }
                // CAP-3: consume id-less `background`/`foreground` lifecycle
                // control frames before the strict `WsRequest` parse (which
                // requires `id`). They are fire-and-forget (no reply) and toggle
                // the keepalive ceiling; an unauthenticated connection's signal
                // is ignored (no flag set, no dispatch, no error).
                if handle_lifecycle_signal(&text, conn.authed, liveness.backgrounded()) {
                    continue;
                }
                // Any other text frame resets the background flag (CAP-3:
                // "resets on foreground or any normal frame") and dispatches as
                // a normal request.
                liveness.backgrounded().store(false, Ordering::Relaxed);
                if !dispatch_connection_text(&text, &mut conn, &env, &executor).await {
                    break; // the connection is closing.
                }
            }
            Message::Binary(_) => {
                // Protocol error (CAP-11): the structured `unsupported` reply
                // MUST reach the client before the Close(1003) handshake. Do
                // NOT break here — ending this loop would let the supervisor
                // abort the write loop mid-queue, racing the queued reply +
                // close away. The write loop owns the handshake: `Outbound::Close`
                // flushes after the reply (FIFO) and ends the connection. The
                // latch suppresses duplicate replies on repeated binary frames.
                if protocol_error {
                    continue;
                }
                protocol_error = true;
                let replied = out_tx
                    .reply(WsReply::err(
                        "binary-frame",
                        WsErrorCode::Unsupported,
                        "binary frames are not supported by this protocol",
                    ))
                    .await;
                if replied {
                    out_tx
                        .enqueue(Outbound::Close(axum::extract::ws::CloseFrame {
                            code: 1003,
                            reason: "binary frames are not supported".into(),
                        }))
                        .await;
                }
            }
            // Axum auto-answers pings; Close ends the loop.
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) => {}
        }
    }
}
