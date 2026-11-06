use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::*;

fn reason(err: &BrowserError) -> (&'static str, Option<&'static str>) {
    (err.code, err.reason)
}

#[test]
fn a_stopped_session_refuses_every_call_until_the_next_turn() {
    let latch = StopLatch::default();
    assert!(latch.begin("s1").is_ok());
    assert!(latch.stop("s1", || {}), "first stop latches");
    assert!(!latch.stop("s1", || {}), "a second stop is a no-op");
    for _ in 0..3 {
        let err = latch.begin("s1").err().expect("latched");
        assert_eq!(
            reason(&err),
            ("confirmation_required", Some("stopped_by_user"))
        );
    }
    assert!(latch.begin("s2").is_ok(), "the latch is session-scoped");
    assert!(latch.resume("s1"));
    assert!(!latch.resume("s1"));
    assert!(latch.begin("s1").is_ok(), "the next prompt turn clears it");
}

#[tokio::test]
async fn stop_cancels_an_in_flight_call_at_its_next_await() {
    let latch = Arc::new(StopLatch::default());
    let token = latch.begin("s1").unwrap();
    let reached_end = Arc::new(AtomicBool::new(false));
    let end = reached_end.clone();
    let call = tokio::spawn(async move {
        token
            .guard(async {
                tokio::time::sleep(Duration::from_secs(30)).await;
                end.store(true, Ordering::SeqCst);
                Ok(())
            })
            .await
    });
    tokio::task::yield_now().await;
    latch.stop("s1", || {});
    let result = tokio::time::timeout(Duration::from_secs(1), call)
        .await
        .expect("stop ends the call promptly")
        .unwrap();
    assert_eq!(
        reason(&result.unwrap_err()),
        ("confirmation_required", Some("stopped_by_user"))
    );
    assert!(
        !reached_end.load(Ordering::SeqCst),
        "the work after the await never ran"
    );
}

#[tokio::test]
async fn every_queued_call_of_the_session_is_drained() {
    let latch = Arc::new(StopLatch::default());
    let calls: Vec<_> = (0..4)
        .map(|_| {
            let token = latch.begin("s1").unwrap();
            tokio::spawn(async move {
                token
                    .guard(std::future::pending::<Result<(), BrowserError>>())
                    .await
            })
        })
        .collect();
    let other = latch.begin("s2").unwrap();
    tokio::task::yield_now().await;
    latch.stop("s1", || {});
    for call in calls {
        let err = tokio::time::timeout(Duration::from_secs(1), call)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert_eq!(err.reason, Some("stopped_by_user"));
    }
    assert!(!other.is_stopped(), "another session keeps running");
}

#[test]
fn commit_after_stop_is_refused_and_commit_before_stop_is_revoked() {
    let latch = StopLatch::default();
    let granted = parking_lot::Mutex::new(Vec::<&str>::new());

    let early = latch.begin("s1").unwrap();
    latch
        .commit("s1", &early, || granted.lock().push("allow"))
        .unwrap();
    latch.stop("s1", || granted.lock().clear());
    assert!(
        granted.lock().is_empty(),
        "stop revokes what committed before it"
    );

    latch.resume("s1");
    let late = latch.begin("s1").unwrap();
    latch.stop("s1", || granted.lock().clear());
    let refused = latch.commit("s1", &late, || granted.lock().push("allow"));
    assert_eq!(refused.unwrap_err().reason, Some("stopped_by_user"));
    latch.resume("s1");
    let stale = latch.commit("s1", &late, || granted.lock().push("allow"));
    assert!(
        stale.is_err(),
        "a token from before the stop stays stale after resume"
    );
    assert!(granted.lock().is_empty());
}

#[test]
fn stop_beats_allow_under_every_interleaving() {
    for round in 0..200 {
        let latch = Arc::new(StopLatch::default());
        let granted = Arc::new(parking_lot::Mutex::new(false));
        let token = latch.begin("s1").unwrap();
        let (l1, g1) = (latch.clone(), granted.clone());
        let allow =
            std::thread::spawn(move || l1.commit("s1", &token, || *g1.lock() = true).is_ok());
        let (l2, g2) = (latch.clone(), granted.clone());
        let stop = std::thread::spawn(move || l2.stop("s1", || *g2.lock() = false));
        let allowed = allow.join().unwrap();
        stop.join().unwrap();
        assert!(
            !*granted.lock(),
            "round {round}: no grant survives a stop (allow won the lock: {allowed})"
        );
        assert!(
            latch.begin("s1").is_err(),
            "round {round}: the session stays stopped"
        );
    }
}

#[tokio::test]
async fn forgetting_a_session_cancels_its_tokens() {
    let latch = StopLatch::default();
    let token = latch.begin("s1").unwrap();
    latch.forget("s1");
    assert!(token.is_stopped());
    let result = token
        .guard(std::future::pending::<Result<(), BrowserError>>())
        .await;
    assert!(result.is_err());
    assert!(
        latch.begin("s1").is_ok(),
        "a forgotten session starts unlatched"
    );
}
