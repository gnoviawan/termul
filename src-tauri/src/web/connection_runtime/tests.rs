use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};

use futures_util::Sink;

use super::*;

/// A sink whose send buffer never has room (a peer that stopped reading).
struct Stalled;

impl Sink<Message> for Stalled {
    type Error = axum::Error;

    fn poll_ready(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Pending
    }
    fn start_send(self: Pin<&mut Self>, _item: Message) -> Result<(), Self::Error> {
        unreachable!("poll_ready never completes")
    }
    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }
    fn poll_close(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }
}

#[tokio::test(start_paused = true)]
async fn drain_waits_for_sockets_that_close_after_the_stop() {
    let shutdown = HostShutdown::default();
    let lease = shutdown.admit();
    let stop = lease.stop_token();
    let closed = Arc::new(AtomicBool::new(false));
    let socket_closed = Arc::clone(&closed);
    tokio::spawn(lease.run(async move {
        stop.cancelled().await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        socket_closed.store(true, Ordering::SeqCst);
    }));

    shutdown.begin();
    let leaked = shutdown.drain(SOCKET_DRAIN_BOUND).await;
    assert_eq!(leaked, 0);
    assert!(
        closed.load(Ordering::SeqCst),
        "drain returned before the socket finished closing"
    );
}

#[tokio::test(start_paused = true)]
async fn drain_aborts_a_straggler_that_ignores_the_stop() {
    struct Dropped(Arc<AtomicBool>);
    impl Drop for Dropped {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    let shutdown = HostShutdown::default();
    let lease = shutdown.admit();
    let aborted = Arc::new(AtomicBool::new(false));
    let guard = Dropped(Arc::clone(&aborted));
    tokio::spawn(lease.run(async move {
        let _guard = guard;
        // Never looks at the stop signal.
        std::future::pending::<()>().await;
    }));

    shutdown.begin();
    let started = tokio::time::Instant::now();
    let leaked = shutdown.drain(SOCKET_DRAIN_BOUND).await;
    assert_eq!(leaked, 0, "the aborted straggler unwound");
    assert!(aborted.load(Ordering::SeqCst), "the straggler's future was dropped");
    assert_eq!(
        started.elapsed(),
        SOCKET_DRAIN_BOUND,
        "the straggler is aborted exactly when the drain bound elapses"
    );
}

#[tokio::test(start_paused = true)]
async fn a_socket_admitted_after_the_stop_still_sees_it() {
    let shutdown = HostShutdown::default();
    shutdown.begin();
    let lease = shutdown.admit();
    assert!(lease.stop_token().is_cancelled());
}

#[tokio::test(start_paused = true)]
async fn the_close_attempt_gives_up_on_a_peer_that_stopped_reading() {
    let started = tokio::time::Instant::now();
    send_going_away(&mut Stalled).await;
    assert_eq!(started.elapsed(), CLOSE_DRAIN_TIMEOUT);
}
