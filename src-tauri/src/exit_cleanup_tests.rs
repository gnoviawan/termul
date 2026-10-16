use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::time::Instant;

use super::{run_bounded, run_exit_cleanup, EXIT_CLEANUP_TIMEOUT};

#[tokio::test(start_paused = true)]
async fn a_cleanup_that_never_finishes_is_abandoned_at_the_deadline() {
    let started = Instant::now();

    run_bounded(std::future::pending(), EXIT_CLEANUP_TIMEOUT).await;

    assert_eq!(started.elapsed(), EXIT_CLEANUP_TIMEOUT);
}

#[tokio::test(start_paused = true)]
async fn a_cleanup_abandoned_at_the_deadline_does_not_resume_during_shutdown() {
    let resumed = Arc::new(AtomicBool::new(false));
    let flag = resumed.clone();

    run_bounded(
        async move {
            tokio::time::sleep(EXIT_CLEANUP_TIMEOUT * 2).await;
            flag.store(true, Ordering::SeqCst);
        },
        EXIT_CLEANUP_TIMEOUT,
    )
    .await;
    tokio::time::sleep(EXIT_CLEANUP_TIMEOUT * 2).await;

    assert!(
        !resumed.load(Ordering::SeqCst),
        "abandoned cleanup kept running after the deadline"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cleanup_blocking_its_thread_is_abandoned_at_the_deadline() {
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let started = std::time::Instant::now();

    run_bounded(
        async move {
            let _ = release_rx.recv();
        },
        Duration::from_millis(200),
    )
    .await;

    let elapsed = started.elapsed();
    drop(release_tx);
    assert!(
        elapsed < Duration::from_secs(5),
        "run_bounded waited {elapsed:?} for a blocked cleanup"
    );
}

#[tokio::test(start_paused = true)]
async fn a_cleanup_that_finishes_returns_without_waiting_for_the_deadline() {
    let ran = Arc::new(AtomicBool::new(false));
    let flag = ran.clone();
    let started = Instant::now();

    run_bounded(
        async move { flag.store(true, Ordering::SeqCst) },
        EXIT_CLEANUP_TIMEOUT,
    )
    .await;

    assert!(ran.load(Ordering::SeqCst));
    assert_eq!(started.elapsed(), Duration::ZERO);
}

#[tokio::test(start_paused = true)]
async fn a_panicking_cleanup_still_returns() {
    let started = Instant::now();

    run_bounded(async { panic!("teardown bug") }, EXIT_CLEANUP_TIMEOUT).await;

    assert_eq!(started.elapsed(), Duration::ZERO);
}

#[tokio::test(start_paused = true)]
async fn stuck_terminals_cannot_keep_chat_history_from_flushing() {
    let flushed = Arc::new(AtomicBool::new(false));
    let flag = flushed.clone();
    let started = Instant::now();

    run_exit_cleanup(
        async move {
            tokio::time::sleep(Duration::from_secs(5)).await;
            flag.store(true, Ordering::SeqCst);
        },
        tokio::time::sleep(Duration::from_secs(3 * 7)),
        EXIT_CLEANUP_TIMEOUT,
    )
    .await;

    assert!(
        flushed.load(Ordering::SeqCst),
        "chat history was not flushed before the deadline"
    );
    assert_eq!(started.elapsed(), EXIT_CLEANUP_TIMEOUT);
}
