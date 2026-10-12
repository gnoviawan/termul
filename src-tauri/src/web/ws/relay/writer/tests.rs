use std::sync::Arc;
use std::time::Duration;

use futures_util::sink;
use tokio::time::Instant;

use super::super::outbound::outbound_channel;
use super::*;

/// A queue that never empties while the socket drains slowly must not starve
/// the keepalive: Pings still go out every `PING_INTERVAL`, so a busy but
/// healthy peer keeps answering them and is not reaped by the watchdog.
#[tokio::test(start_paused = true)]
async fn the_keepalive_ping_is_not_starved_by_a_queue_that_never_empties() {
    let pings = Arc::new(parking_lot::Mutex::new(Vec::<Duration>::new()));
    let started = Instant::now();
    let seen = Arc::clone(&pings);
    // Each socket write takes one second: a drain of 64 coalesced events per
    // write cannot empty the queue below.
    let sink = Box::pin(sink::unfold((), move |(), message: Message| {
        let seen = Arc::clone(&seen);
        async move {
            tokio::time::sleep(Duration::from_secs(1)).await;
            if matches!(message, Message::Ping(_)) {
                seen.lock().push(started.elapsed());
            }
            Ok::<(), axum::Error>(())
        }
    }));
    let (tx, rx) = outbound_channel(4096, 15);
    for _ in 0..4000 {
        let event = crate::web::ws::SequencedEvent::new(None, 0, "probe", serde_json::json!({}));
        assert!(tx.try_enqueue(Outbound::Event(event)) == crate::web::ws::EnqueueOutcome::Enqueued);
    }
    let stop = CancellationToken::new();
    let writer = tokio::spawn(run_writer(sink, rx, stop.clone()));

    tokio::time::sleep(PING_INTERVAL * 2 + Duration::from_secs(5)).await;
    let delivered = pings.lock().clone();
    assert!(
        delivered.len() >= 2,
        "the queue was never empty for {:?} and only {} pings were sent",
        PING_INTERVAL * 2,
        delivered.len()
    );
    stop.cancel();
    drop(tx);
    let _ = writer.await;
}
