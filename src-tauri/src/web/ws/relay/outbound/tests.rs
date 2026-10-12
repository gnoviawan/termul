use std::sync::Arc;
use std::time::Duration;

use futures_util::sink;
use tokio_util::sync::CancellationToken;

use super::super::watchdog::PING_INTERVAL;
use super::super::writer::run_writer;
use super::*;
use axum::extract::ws::Message;

fn event_frame() -> Outbound {
    Outbound::Event(crate::web::ws::SequencedEvent::new(
        None,
        0,
        "probe",
        serde_json::json!({}),
    ))
}

#[test]
fn try_enqueue_distinguishes_full_from_closed() {
    let (tx, rx) = outbound_channel(2, 100);
    assert_eq!(tx.try_enqueue(event_frame()), EnqueueOutcome::Enqueued);
    assert_eq!(tx.try_enqueue(event_frame()), EnqueueOutcome::Enqueued);
    assert_eq!(
        tx.try_enqueue(event_frame()),
        EnqueueOutcome::Full,
        "a full queue refuses the frame without closing the connection"
    );
    assert!(!tx.closing().is_cancelled());
    drop(rx);
    assert_eq!(
        tx.try_enqueue(event_frame()),
        EnqueueOutcome::Closed,
        "a dropped receiver means the connection is gone"
    );
}

#[tokio::test(start_paused = true)]
async fn full_windows_close_the_peer_at_the_tolerance() {
    let (tx, _rx) = outbound_channel(1, 3);
    assert_eq!(tx.try_enqueue(event_frame()), EnqueueOutcome::Enqueued);
    assert_eq!(tx.try_enqueue(event_frame()), EnqueueOutcome::Full);
    tokio::time::sleep(FULL_QUEUE_ATTEMPT).await;
    assert_eq!(tx.try_enqueue(event_frame()), EnqueueOutcome::Full);
    assert!(!tx.closing().is_cancelled(), "two failed windows are within the tolerance of 3");
    tokio::time::sleep(FULL_QUEUE_ATTEMPT).await;
    assert_eq!(
        tx.try_enqueue(event_frame()),
        EnqueueOutcome::Closed,
        "the third consecutive failed window closes the peer"
    );
    assert!(tx.closing().is_cancelled());
    assert_eq!(tx.try_enqueue(event_frame()), EnqueueOutcome::Closed);
}

#[tokio::test(start_paused = true)]
async fn a_burst_of_failures_inside_one_window_counts_once() {
    let (tx, _rx) = outbound_channel(1, 3);
    assert_eq!(tx.try_enqueue(event_frame()), EnqueueOutcome::Enqueued);
    for _ in 0..50 {
        assert_eq!(tx.try_enqueue(event_frame()), EnqueueOutcome::Full);
    }
    assert!(
        !tx.closing().is_cancelled(),
        "fifty hits in one window are one failed attempt, not fifty"
    );
}

#[tokio::test(start_paused = true)]
async fn many_concurrent_producers_do_not_amplify_the_failure_count() {
    let tolerance = 15;
    let (tx, mut rx) = outbound_channel(1, tolerance);
    assert_eq!(tx.try_enqueue(event_frame()), EnqueueOutcome::Enqueued);
    let producers: Vec<_> = (0..40)
        .map(|_| {
            let tx = tx.clone();
            tokio::spawn(async move { tx.enqueue(event_frame()).await })
        })
        .collect();

    // 40 producers wait on the full queue; the peer has been full for only a
    // few windows, far below 15.
    tokio::time::sleep(FULL_QUEUE_ATTEMPT * 5).await;
    assert!(
        !tx.closing().is_cancelled(),
        "40 concurrent waiters closed a peer that was full for only 5 windows"
    );

    // The peer stays full for the whole tolerance: now it is closed.
    tokio::time::sleep(FULL_QUEUE_ATTEMPT * (tolerance as u32 + 1)).await;
    assert!(tx.closing().is_cancelled());
    for producer in producers {
        assert_eq!(producer.await.unwrap(), EnqueueOutcome::Closed);
    }
    rx.close();
}

#[tokio::test(start_paused = true)]
async fn a_successful_enqueue_resets_the_failure_count() {
    let (tx, mut rx) = outbound_channel(1, 3);
    assert_eq!(tx.try_enqueue(event_frame()), EnqueueOutcome::Enqueued);
    for _ in 0..2 {
        assert_eq!(tx.try_enqueue(event_frame()), EnqueueOutcome::Full);
        tokio::time::sleep(FULL_QUEUE_ATTEMPT).await;
    }
    // The peer drains, then fills again: the earlier failures no longer count.
    rx.try_recv().expect("queued frame");
    assert_eq!(tx.try_enqueue(event_frame()), EnqueueOutcome::Enqueued);
    for _ in 0..2 {
        assert_eq!(tx.try_enqueue(event_frame()), EnqueueOutcome::Full);
        tokio::time::sleep(FULL_QUEUE_ATTEMPT).await;
    }
    assert!(
        !tx.closing().is_cancelled(),
        "failures are consecutive: a success in between resets the count"
    );
}

#[tokio::test(start_paused = true)]
async fn a_reliable_enqueue_waits_for_room_instead_of_dropping() {
    let (tx, mut rx) = outbound_channel(1, 15);
    assert_eq!(tx.enqueue(event_frame()).await, EnqueueOutcome::Enqueued);

    let sender = tx.clone();
    let waiting = tokio::spawn(async move {
        sender
            .enqueue(Outbound::Reply(crate::web::ws::WsReply::ok("late", None)))
            .await
    });
    tokio::time::sleep(FULL_QUEUE_ATTEMPT / 2).await;
    assert!(!waiting.is_finished(), "the reply waits while the queue is full");

    rx.recv().await.expect("first frame");
    assert_eq!(waiting.await.unwrap(), EnqueueOutcome::Enqueued);
    assert!(
        matches!(rx.recv().await, Some(Outbound::Reply(reply)) if reply.id == "late"),
        "the waiting reply is delivered, not dropped"
    );
    assert!(!tx.closing().is_cancelled());
}

#[tokio::test(start_paused = true)]
async fn a_reliable_enqueue_closes_a_peer_that_stays_full() {
    let tolerance = 4;
    let (tx, _rx) = outbound_channel(1, tolerance);
    assert_eq!(tx.enqueue(event_frame()).await, EnqueueOutcome::Enqueued);

    let started = tokio::time::Instant::now();
    let outcome = tx
        .enqueue(Outbound::Reply(crate::web::ws::WsReply::ok("lost", None)))
        .await;
    assert_eq!(
        outcome,
        EnqueueOutcome::Closed,
        "a reply that cannot be queued closes the connection instead of vanishing"
    );
    assert!(tx.closing().is_cancelled());
    // One failed attempt per wait window after the first immediate failure.
    assert_eq!(started.elapsed(), FULL_QUEUE_ATTEMPT * (tolerance as u32 - 1));
}

#[test]
fn senders_are_the_same_channel_only_when_cloned() {
    let (a, _rx_a) = outbound_channel(1, 1);
    let (b, _rx_b) = outbound_channel(1, 1);
    assert!(a.same_channel(&a.clone()));
    assert!(!a.same_channel(&b));
}

/// A queue that never empties while the socket drains slowly must not starve
/// the keepalive: Pings still go out every `PING_INTERVAL`, so a busy but
/// healthy peer keeps answering them and is not reaped by the watchdog.
#[tokio::test(start_paused = true)]
async fn the_keepalive_ping_is_not_starved_by_a_queue_that_never_empties() {
    let pings = Arc::new(parking_lot::Mutex::new(Vec::<Duration>::new()));
    let started = tokio::time::Instant::now();
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
