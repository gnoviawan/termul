//! Keepalive constants and the independent liveness watchdog (AD-19).
//!
//! The watchdog runs on its own timer task, never inside the write loop's
//! ping arm: a peer that stopped reading stalls the write loop in a send, and
//! a check that lived there would never run. It looks only at the last
//! inbound frame, so it closes a silent peer regardless of outbound traffic.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use tracing::warn;

use super::elapsed_ms;

/// Keepalive Ping interval for the `/ws` relay.
///
/// Browser WebSockets never send their own pings (the WS API hides
/// ping/pong control frames from JavaScript), so without a server-emitted
/// Ping the socket goes silent during long agent turns — especially the
/// "thinking"/reasoning phase, which can produce no `session/update` chunks
/// for tens of seconds. Idle NAT/proxy hops and backgrounded mobile browser
/// tabs then RST the TCP connection (surfacing in the log as
/// "Connection reset without closing handshake" and in the chat UI as a
/// mid-response disconnect). 20s is well under common idle timeouts
/// (60–300s) yet light enough not to spam a recovering link.
pub(in crate::web::ws) const PING_INTERVAL: Duration = Duration::from_secs(20);

/// Host heartbeat interval: the write loop sends a `heartbeat` frame this
/// often, straight to the socket, so a client can tell a live host from a dead
/// link without a ping round trip. The client treats 2.5 intervals of silence
/// as a dead link.
pub(in crate::web::ws) const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(10);

/// How long without ANY client→server frame (a Pong answering our keepalive
/// Ping, a request, or a client Ping) before the server declares the
/// connection half-open and tears it down. ~3.5× the ping interval to absorb
/// jitter on slow/mobile links while still bounding a dead socket so the
/// relay reaps subscriptions + denies outstanding permissions and the
/// browser's reconnect+cursor-resubscribe path can engage.
pub(in crate::web::ws) const PONG_TIMEOUT: Duration = Duration::from_secs(75);

/// Signal-gated keepalive ceiling (CAP-3): while a web client has sent a
/// `type:"background"` control frame and not yet sent `foreground` (or any
/// normal frame), the watchdog tolerates up to 5 minutes of inactivity so a
/// backgrounded mobile tab (whose `setInterval` the OS throttles/pauses)
/// survives an app-switch round-trip. `PONG_TIMEOUT` is NOT raised — the
/// 5-min ceiling applies only while `backgrounded=true`. 5 min balances
/// mobile battery against reconnect latency (codeg tolerates 1h; buzz 30s).
pub(in crate::web::ws) const BACKGROUND_TIMEOUT: Duration = Duration::from_secs(300);

/// How often the watchdog re-checks the peer's last inbound frame. A stale
/// peer is reaped at most one tick after its deadline.
pub(in crate::web::ws) const WATCHDOG_TICK: Duration = Duration::from_secs(5);

/// Reusable Ping payload (opaque; browsers must echo it back in the Pong, but
/// the relay does not correlate — any inbound frame resets the watchdog).
/// Must stay under 125 bytes per RFC 6455 control-frame limits.
pub(in crate::web::ws) const PING_PAYLOAD: &[u8] = b"keepalive";

/// Pure keepalive-watchdog decision: returns true when no inbound frame
/// (text request, Pong, or client Ping) has arrived for longer than `ceiling`
/// — `PONG_TIMEOUT` for an active/foreground connection, or `BACKGROUND_TIMEOUT`
/// while a `background` signal is in effect (CAP-3). Extracted so the
/// threshold semantics (strict `>`) are unit-testable without spinning up a
/// real socket.
pub(in crate::web::ws) fn watchdog_is_stale(
    last_activity_ms: u64,
    now_ms_value: u64,
    ceiling_ms: u64,
) -> bool {
    now_ms_value.saturating_sub(last_activity_ms) > ceiling_ms
}

/// One connection's liveness state: when the peer last sent a frame and
/// whether it announced it is backgrounded (CAP-3). Time is the tokio clock,
/// so a paused test runtime drives the watchdog deterministically.
pub(super) struct Liveness {
    epoch: tokio::time::Instant,
    last_activity_ms: AtomicU64,
    backgrounded: AtomicBool,
}

impl Liveness {
    pub(super) fn new() -> Self {
        let epoch = tokio::time::Instant::now();
        Self {
            epoch,
            last_activity_ms: AtomicU64::new(elapsed_ms(epoch)),
            backgrounded: AtomicBool::new(false),
        }
    }

    /// Any inbound frame (text request, Pong, client Ping) proves the peer is
    /// live.
    pub(super) fn touch(&self) {
        self.last_activity_ms
            .store(elapsed_ms(self.epoch), Ordering::Relaxed);
    }

    /// The flag `background` / `foreground` control frames toggle.
    pub(super) fn backgrounded(&self) -> &AtomicBool {
        &self.backgrounded
    }

    /// `Some((silent_for_ms, ceiling))` when the peer has been silent past its
    /// ceiling: [`BACKGROUND_TIMEOUT`] after a `background` frame, otherwise
    /// [`PONG_TIMEOUT`].
    fn stale(&self) -> Option<(u64, Duration)> {
        let last = self.last_activity_ms.load(Ordering::Relaxed);
        let now = elapsed_ms(self.epoch);
        let ceiling = if self.backgrounded.load(Ordering::Relaxed) {
            BACKGROUND_TIMEOUT
        } else {
            PONG_TIMEOUT
        };
        watchdog_is_stale(last, now, ceiling.as_millis() as u64)
            .then(|| (now.saturating_sub(last), ceiling))
    }
}

/// The watchdog task: completes when the peer has been silent past its
/// ceiling, which ends the connection.
pub(super) async fn run_watchdog(liveness: std::sync::Arc<Liveness>) {
    let mut tick = tokio::time::interval(WATCHDOG_TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        if let Some((silent_ms, ceiling)) = liveness.stale() {
            warn!(
                "[ws] keepalive: no client activity for {silent_ms} ms \
                 (>{ceiling:?}); closing connection"
            );
            return;
        }
    }
}
