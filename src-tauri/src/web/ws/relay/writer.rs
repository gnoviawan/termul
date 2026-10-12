//! The write loop: drains the bounded outbound queue into the socket and
//! emits keepalive Pings. It owns the sink, so it also owns the close
//! handshakes (the CAP-11 protocol-error close and the host-stop
//! `Close(1001)`). Liveness is NOT checked here: a send to a peer that stopped
//! reading blocks this loop, which is exactly when the independent watchdog
//! has to be able to act.

use futures_util::{Sink, SinkExt};
use tokio_util::sync::CancellationToken;

use crate::web::connection_runtime::{send_close, send_going_away};

use super::super::*;
use super::outbound::OutboundReceiver;
use super::watchdog::{PING_INTERVAL, PING_PAYLOAD};

/// A socket send that gave way to the host stopping or failed.
enum SendEnd {
    /// The host is stopping: send `Close(1001)` instead.
    Stopping,
    /// The peer is gone.
    Failed,
}

/// Send one frame, giving way to a host stop even while the peer is not
/// draining (a blocked send would otherwise pin the loop past the stop).
async fn send<S>(sink: &mut S, message: Message, stop: &CancellationToken) -> Result<(), SendEnd>
where
    S: Sink<Message, Error = axum::Error> + Unpin,
{
    tokio::select! {
        biased;
        () = stop.cancelled() => Err(SendEnd::Stopping),
        sent = sink.send(message) => sent.map_err(|_| SendEnd::Failed),
    }
}

fn encode<T: Serialize>(frame: &T, describe: impl Fn() -> String) -> Option<String> {
    match serde_json::to_string(frame) {
        Ok(text) if !text.is_empty() => Some(text),
        Ok(_) => None,
        Err(error) => {
            warn!("[ws] failed to serialize {}: {error}", describe());
            None
        }
    }
}

/// Run the write loop until the peer is gone, a close handshake completes, the
/// queue's senders are all dropped, or the host stops.
pub(super) async fn run_writer<S>(mut sink: S, mut out_rx: OutboundReceiver, stop: CancellationToken)
where
    S: Sink<Message, Error = axum::Error> + Unpin,
{
    let mut ping = tokio::time::interval(PING_INTERVAL);
    // Steady, not bursty: if a slow client stalled the write loop, don't
    // ping-storm it on recovery — delay missed ticks to the next period.
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Discard the immediate first tick so the first keepalive lands one full
    // interval after connect (a fresh connection needs no keepalive yet and the
    // auth_required frame has just been queued).
    ping.tick().await;
    loop {
        let sent = tokio::select! {
            biased;
            // Ahead of everything queued: the host is stopping.
            () = stop.cancelled() => Err(SendEnd::Stopping),
            frame = out_rx.recv() => match frame {
                None => return,
                Some(frame) => write_frame(&mut sink, &mut out_rx, frame, &stop).await,
            },
            _ = ping.tick() => {
                // The browser auto-pongs at the protocol layer; that Pong (or
                // any client→server frame) is what the watchdog watches.
                send(&mut sink, Message::Ping(PING_PAYLOAD.to_vec().into()), &stop).await
            }
        };
        match sent {
            Ok(()) => {}
            Err(SendEnd::Failed) => return,
            Err(SendEnd::Stopping) => {
                send_going_away(&mut sink).await;
                return;
            }
        }
    }
}

/// One dequeued frame to the socket. A run of events behind the first is
/// coalesced into ONE `events` frame (zero added latency: only what the queue
/// already holds), so an 8-agent stream collapses ~160 per-event WS frames per
/// second into one frame per drain. The frame that ends the run follows,
/// preserving strict FIFO across frame kinds.
async fn write_frame<S>(
    sink: &mut S,
    out_rx: &mut OutboundReceiver,
    frame: Outbound,
    stop: &CancellationToken,
) -> Result<(), SendEnd>
where
    S: Sink<Message, Error = axum::Error> + Unpin,
{
    let mut next = Some(frame);
    while let Some(frame) = next.take() {
        match frame {
            Outbound::Event(first) => {
                let mut batch = vec![first];
                while batch.len() < WS_BATCH_MAX_EVENTS {
                    match out_rx.try_recv() {
                        Ok(Outbound::Event(event)) => batch.push(event),
                        Ok(other) => {
                            next = Some(other);
                            break;
                        }
                        Err(_) => break,
                    }
                }
                let text = if batch.len() == 1 {
                    encode(&batch[0], || format!("event {}", batch[0].type_))
                } else {
                    encode(&json!({ "type": WS_BATCH_TYPE, "events": batch }), || {
                        "event batch".to_string()
                    })
                };
                if let Some(text) = text {
                    send(sink, Message::Text(text.into()), stop).await?;
                }
            }
            Outbound::Reply(reply) => {
                if let Some(text) = encode(&reply, || format!("reply for {}", reply.id)) {
                    send(sink, Message::Text(text.into()), stop).await?;
                }
            }
            // CAP-11: the write loop owns the close handshake — flush
            // `Message::Close` AFTER everything queued ahead of it, then end
            // so the supervisor tears the connection down (not the other way
            // around, which would race the queued frames away).
            Outbound::Close(close) => {
                send_close(sink, close).await;
                return Err(SendEnd::Failed);
            }
        }
    }
    Ok(())
}
