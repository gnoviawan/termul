//! Tests for the per-project FS watch hub (#856): the pure filtering and
//! normalization decisions that decide which changes reach clients, plus the
//! hub's refcounting, targeted delivery and lifecycle over real filesystem
//! events.

use super::*;
use crate::web::ws::{outbound_channel, OutboundReceiver, OUTBOUND_QUEUE_CAPACITY};
use serde_json::json;

#[test]
fn reportable_paths_pass() {
    assert!(is_reportable_below_root(
        std::path::Path::new("/root/proj/src/main.rs"),
        std::path::Path::new("/root/proj")
    ));
    assert!(is_reportable_below_root(
        std::path::Path::new("/root/proj/README.md"),
        std::path::Path::new("/root/proj")
    ));
    assert!(is_reportable_below_root(
        std::path::Path::new("/root/proj/.termul/worktrees/a"),
        std::path::Path::new("/root/proj")
    ));
}

#[test]
fn ignored_directories_are_suppressed() {
    // Build churn and VCS internals must not refresh the explorer tree.
    for ignored in [
        "/root/proj/node_modules/pkg/index.js",
        "/root/proj/.git/index",
        "/root/proj/dist/bundle.js",
        "/root/proj/target/debug/termul",
        "/root/proj/src/__pycache__/mod.cpython-311.pyc",
    ] {
        assert!(
            !is_reportable_below_root(
                std::path::Path::new(ignored),
                std::path::Path::new("/root/proj")
            ),
            "{ignored} must be suppressed"
        );
    }
}

#[test]
fn ignored_name_as_plain_file_is_not_suppressed() {
    // A file literally NAMED "dist" (not a directory component on the
    // path) is still a reportable tree change.
    assert!(is_reportable_below_root(
        std::path::Path::new("/root/proj/dist"),
        std::path::Path::new("/root/proj")
    ));
}

#[test]
fn root_ancestors_are_not_inspected() {
    // CodeRabbit: a project root that itself lives under an ignored-named
    // directory (e.g. /home/u/build/myproj) must not suppress every event.
    assert!(is_reportable_below_root(
        std::path::Path::new("/home/u/build/myproj/src/main.rs"),
        std::path::Path::new("/home/u/build/myproj")
    ));
    // ...but an ignored dir BELOW the root still suppresses.
    assert!(!is_reportable_below_root(
        std::path::Path::new("/home/u/build/myproj/dist/bundle.js"),
        std::path::Path::new("/home/u/build/myproj")
    ));
}

#[test]
fn normalize_converts_backslashes_and_skips_empty() {
    #[cfg(windows)]
    {
        assert_eq!(
            normalize_path(std::path::Path::new("C:\\proj\\src\\a.rs")),
            Some("C:/proj/src/a.rs".to_string())
        );
    }
    assert_eq!(
        normalize_path(std::path::Path::new("/root/proj/a.rs")),
        Some("/root/proj/a.rs".to_string())
    );
    assert_eq!(normalize_path(std::path::Path::new("")), None);
}

/// `fs_changed` payload shape: camelCase `{projectId, root, paths}` — pinned
/// against the shared `FsChangedPayload` so the renderer contract cannot drift.
#[test]
fn fs_changed_payload_serializes_camelcase_project_root_and_paths() {
    let payload = FsChangedPayload {
        project_id: "p-1".to_string(),
        root: "/root/proj".to_string(),
        paths: vec!["/root/proj/src/main.rs".to_string()],
    };
    let value = serde_json::to_value(&payload).expect("serializes");
    assert_eq!(value["projectId"], json!("p-1"));
    assert_eq!(value["root"], json!("/root/proj"));
    assert_eq!(value["paths"], json!(["/root/proj/src/main.rs"]));
}

// ---- Hub: refcount, targeted delivery, lifecycle ----

const ARM_WAIT: Duration = Duration::from_secs(10);

type Conn = (OutboundSender, OutboundReceiver);

fn conn() -> Conn {
    outbound_channel(
        OUTBOUND_QUEUE_CAPACITY,
        crate::web::config::DEFAULT_OVERFLOW_TOLERANCE,
    )
}

fn temp_project_dir(label: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!(
        "termul-fswatch-{label}-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("create project dir");
    dir.canonicalize().expect("canonicalize project dir")
}

fn registry_with(projects: &[(&str, &PathBuf)]) -> Arc<ProjectRegistry> {
    use crate::web::project_registry::ProjectSummary;
    let registry = Arc::new(ProjectRegistry::new());
    registry.set(
        projects
            .iter()
            .map(|(id, dir)| ProjectSummary {
                id: (*id).to_string(),
                name: (*id).to_string(),
                color: "blue".to_string(),
                path: Some(dir.to_string_lossy().into_owned()),
                is_archived: false,
                is_default: false,
            })
            .collect(),
        None,
    );
    registry
}

/// Wait up to `wait` for one `fs_changed` event on `rx`.
async fn next_fs_changed(
    rx: &mut OutboundReceiver,
    wait: Duration,
) -> Option<serde_json::Value> {
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Some(Outbound::Event(event))) if event.type_ == "fs_changed" => {
                assert!(event.sid.is_none() && event.seq == 0, "agent-level event");
                return Some(event.payload);
            }
            Ok(Some(_)) => continue,
            Ok(None) | Err(_) => return None,
        }
    }
}

#[tokio::test]
async fn subscribe_rejects_unknown_and_archived_projects() {
    let dir = temp_project_dir("reject");
    let registry = registry_with(&[("p-1", &dir)]);
    let hub = FsWatchHub::default();
    let (tx, _rx) = conn();

    assert_eq!(
        hub.subscribe(&registry, "nope", &tx),
        Err(WatchError::NotFound)
    );
    assert!(registry.update("p-1", None, None, Some(true)));
    assert_eq!(
        hub.subscribe(&registry, "p-1", &tx),
        Err(WatchError::NotFound)
    );
    assert_eq!(hub.watched_project_count(), 0);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn watcher_is_refcounted_and_dropped_on_last_unsubscribe() {
    let dir = temp_project_dir("refcount");
    let registry = registry_with(&[("p-1", &dir)]);
    let hub = FsWatchHub::default();
    let (a, _ra) = conn();
    let (b, _rb) = conn();

    hub.subscribe(&registry, "p-1", &a).expect("a subscribes");
    hub.subscribe(&registry, "p-1", &a)
        .expect("re-subscribe is idempotent");
    hub.subscribe(&registry, "p-1", &b).expect("b subscribes");
    assert_eq!(hub.subscriber_count("p-1"), 2);
    assert_eq!(hub.watched_project_count(), 1, "one watcher shared by both");

    assert!(hub.unsubscribe("p-1", &a));
    assert!(!hub.unsubscribe("p-1", &a), "second unsubscribe is a no-op");
    assert_eq!(hub.watched_project_count(), 1, "still watched for b");
    assert!(hub.unsubscribe("p-1", &b));
    assert_eq!(
        hub.watched_project_count(),
        0,
        "last unsubscribe drops the watcher"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn connection_cleanup_drops_every_watch_of_that_connection() {
    let (d1, d2) = (temp_project_dir("c1"), temp_project_dir("c2"));
    let registry = registry_with(&[("p-1", &d1), ("p-2", &d2)]);
    let hub = FsWatchHub::default();
    let (gone, _rg) = conn();
    let (stay, _rs) = conn();
    hub.subscribe(&registry, "p-1", &gone).unwrap();
    hub.subscribe(&registry, "p-2", &gone).unwrap();
    hub.subscribe(&registry, "p-2", &stay).unwrap();

    hub.unsubscribe_all(&gone);

    assert_eq!(hub.subscriber_count("p-1"), 0);
    assert_eq!(hub.subscriber_count("p-2"), 1);
    assert_eq!(
        hub.watched_project_count(),
        1,
        "p-1 dropped, p-2 kept for the other connection"
    );
    for d in [d1, d2] {
        let _ = std::fs::remove_dir_all(d);
    }
}

#[tokio::test]
async fn fs_changed_reaches_only_connections_subscribed_to_that_project() {
    let (d1, d2) = (temp_project_dir("t1"), temp_project_dir("t2"));
    let registry = registry_with(&[("p-1", &d1), ("p-2", &d2)]);
    let hub = FsWatchHub::default();
    let (watching_p1, mut rx1) = conn();
    let (watching_p2, mut rx2) = conn();
    let (unsubscribed, mut rx3) = conn();
    hub.subscribe(&registry, "p-1", &watching_p1).unwrap();
    hub.subscribe(&registry, "p-2", &watching_p2).unwrap();
    assert!(hub.wait_armed("p-1", ARM_WAIT).await, "p-1 watcher armed");
    assert!(hub.wait_armed("p-2", ARM_WAIT).await, "p-2 watcher armed");

    std::fs::write(d1.join("hello.txt"), "x").expect("write file");

    let payload = next_fs_changed(&mut rx1, Duration::from_secs(10))
        .await
        .expect("subscriber of p-1 gets fs_changed");
    assert_eq!(payload["projectId"], json!("p-1"));
    assert_eq!(payload["root"], json!(d1.display().to_string()));
    assert!(payload["paths"]
        .as_array()
        .expect("paths")
        .iter()
        .any(|p| p.as_str().is_some_and(|p| p.ends_with("/hello.txt"))));
    assert!(
        next_fs_changed(&mut rx2, Duration::from_millis(800))
            .await
            .is_none(),
        "a connection watching ANOTHER project gets nothing"
    );
    assert!(
        next_fs_changed(&mut rx3, Duration::from_millis(100))
            .await
            .is_none(),
        "an unsubscribed connection gets nothing"
    );
    drop(unsubscribed);
    for d in [d1, d2] {
        let _ = std::fs::remove_dir_all(d);
    }
}

#[tokio::test]
async fn closed_subscriber_is_pruned_and_watcher_dropped_on_next_change() {
    let dir = temp_project_dir("prune");
    let registry = registry_with(&[("p-1", &dir)]);
    let hub = FsWatchHub::default();
    let (tx, rx) = conn();
    hub.subscribe(&registry, "p-1", &tx).unwrap();
    assert!(hub.wait_armed("p-1", ARM_WAIT).await, "watcher armed");
    drop(rx); // the connection's write half is gone

    std::fs::write(dir.join("a.txt"), "x").expect("write file");

    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while hub.watched_project_count() != 0 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(
        hub.watched_project_count(),
        0,
        "delivery to a closed channel drops the watch"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn archiving_or_removing_the_project_drops_its_watch() {
    let (d1, d2) = (temp_project_dir("arch"), temp_project_dir("rem"));
    let registry = registry_with(&[("p-1", &d1), ("p-2", &d2)]);
    let hub = FsWatchHub::default();
    let (tx, _rx) = conn();
    hub.subscribe(&registry, "p-1", &tx).unwrap();
    hub.subscribe(&registry, "p-2", &tx).unwrap();
    assert_eq!(hub.watched_project_count(), 2);
    // Archive/remove only counts once both watchers are live (otherwise the
    // tasks would just see the project gone on their first lookup).
    assert!(hub.wait_armed("p-1", ARM_WAIT).await, "p-1 watcher armed");
    assert!(hub.wait_armed("p-2", ARM_WAIT).await, "p-2 watcher armed");

    assert!(registry.update("p-1", None, None, Some(true)));
    assert!(registry.remove("p-2"));

    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    while hub.watched_project_count() != 0 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(
        hub.watched_project_count(),
        0,
        "archive/remove drops the watchers"
    );
    assert_eq!(hub.subscriber_count("p-1"), 0);
    for d in [d1, d2] {
        let _ = std::fs::remove_dir_all(d);
    }
}

/// A backing-off watcher notices an archived/removed project within a registry
/// tick, not after the whole (up to 30 s) delay.
#[tokio::test]
async fn backoff_ends_promptly_when_the_project_is_removed_or_moved() {
    let (d1, d2) = (temp_project_dir("bo1"), temp_project_dir("bo2"));
    let registry = registry_with(&[("p-1", &d1)]);
    let cancel = CancellationToken::new();
    let long = Duration::from_secs(30);

    let started = tokio::time::Instant::now();
    registry.remove("p-1");
    let outcome = backoff("p-1", &d1, long, &registry, &cancel).await;
    assert!(matches!(outcome, BackoffOutcome::ProjectGone));
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "must not wait out the delay"
    );

    let registry = registry_with(&[("p-1", &d2)]);
    let outcome = backoff("p-1", &d1, long, &registry, &cancel).await;
    assert!(matches!(outcome, BackoffOutcome::RootChanged));

    cancel.cancel();
    let outcome = backoff("p-1", &d2, long, &registry, &cancel).await;
    assert!(matches!(outcome, BackoffOutcome::Stopped));
    for d in [d1, d2] {
        let _ = std::fs::remove_dir_all(d);
    }
}

/// Subscribers are told when their watch ends because the project went away,
/// so the client can re-request it instead of waiting for events that never
/// come.
#[tokio::test]
async fn subscribers_get_fs_watch_ended_when_the_project_is_archived() {
    let dir = temp_project_dir("ended");
    let registry = registry_with(&[("p-1", &dir)]);
    let hub = FsWatchHub::default();
    let (tx, mut rx) = conn();
    hub.subscribe(&registry, "p-1", &tx).unwrap();
    assert!(hub.wait_armed("p-1", ARM_WAIT).await, "watcher armed");

    assert!(registry.update("p-1", None, None, Some(true)));

    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    let ended = loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Some(Outbound::Event(event))) if event.type_ == "fs_watch_ended" => {
                break Some(event.payload)
            }
            Ok(Some(_)) => continue,
            Ok(None) | Err(_) => break None,
        }
    };
    let payload = ended.expect("subscriber is told the watch ended");
    assert_eq!(payload["projectId"], json!("p-1"));
    assert_eq!(payload["reason"], json!("project_unavailable"));
    assert_eq!(hub.watched_project_count(), 0);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Moving a project's root re-arms the live watch at the new root: events
/// under the new directory arrive for the same subscription.
#[tokio::test]
async fn a_moved_project_root_re_arms_the_live_watch() {
    use crate::web::project_registry::ProjectSummary;
    let (old, new) = (temp_project_dir("mv-old"), temp_project_dir("mv-new"));
    let registry = registry_with(&[("p-1", &old)]);
    let hub = FsWatchHub::default();
    let (tx, mut rx) = conn();
    hub.subscribe(&registry, "p-1", &tx).unwrap();
    assert!(hub.wait_armed("p-1", ARM_WAIT).await, "watcher armed");

    registry.upsert(ProjectSummary {
        id: "p-1".to_string(),
        name: "p-1".to_string(),
        color: "blue".to_string(),
        path: Some(new.to_string_lossy().into_owned()),
        is_archived: false,
        is_default: false,
    });

    // Keep touching the new root until the re-armed watcher reports it (the
    // registry tick re-resolves within a second).
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    let mut seen = None;
    let mut n = 0;
    while seen.is_none() && tokio::time::Instant::now() < deadline {
        n += 1;
        std::fs::write(new.join(format!("f{n}.txt")), "x").expect("write file");
        seen = next_fs_changed(&mut rx, Duration::from_millis(700)).await;
    }
    let payload = seen.expect("events from the new root reach the subscription");
    assert_eq!(payload["root"], json!(new.display().to_string()));
    for d in [old, new] {
        let _ = std::fs::remove_dir_all(d);
    }
}

/// `fs_changed` goes through the subscriber's bounded queue: a full queue
/// misses the batch (never grows past its bound) and, once the overflow
/// tolerance is reached, the subscriber is closed and pruned (dropping the
/// watcher with its last subscriber).
#[test]
fn deliver_uses_the_bounded_queue_and_prunes_a_peer_that_stays_full() {
    let (tx, mut rx) = outbound_channel(1, 3);
    let watches: WatchMap = Arc::new(Mutex::new(HashMap::new()));
    watches.lock().insert(
        "p-full".to_string(),
        ProjectWatch {
            generation: 1,
            subscribers: vec![tx.clone()],
            cancel: CancellationToken::new(),
            armed: tokio::sync::watch::channel(false).1,
        },
    );
    let payload = FsChangedPayload {
        project_id: "p-full".to_string(),
        root: "/root".to_string(),
        paths: vec!["/root/a".to_string()],
    };

    assert!(deliver(&watches, "p-full", 1, &payload), "first batch queued");
    assert!(deliver(&watches, "p-full", 1, &payload), "full: batch missed, peer kept");
    assert!(deliver(&watches, "p-full", 1, &payload), "full again, within tolerance");
    assert!(!tx.closing().is_cancelled());
    assert!(
        !deliver(&watches, "p-full", 1, &payload),
        "third consecutive full batch reaches the tolerance: subscriber pruned, watch dropped"
    );
    assert!(tx.closing().is_cancelled(), "the overflowing peer's connection is closed");
    assert!(watches.lock().is_empty());
    assert!(rx.try_recv().is_ok(), "exactly the first batch was queued");
    assert!(rx.try_recv().is_err(), "the queue never grew past its bound");
}

/// `fs_watch_ended` is the client's only cue to re-request its watch, so a full
/// queue delays it instead of losing it.
#[tokio::test]
async fn watch_ended_is_delivered_once_a_full_queue_has_room() {
    let (tx, mut rx) = outbound_channel(1, 100);
    let filler = Outbound::Event(SequencedEvent::new(None, 0, "filler", json!({})));
    assert_eq!(tx.try_enqueue(filler), EnqueueOutcome::Enqueued);

    notify_watch_ended("p-gone", std::slice::from_ref(&tx));
    assert!(
        matches!(rx.recv().await, Some(Outbound::Event(event)) if event.type_ == "filler"),
        "the queued frame is delivered first"
    );
    let ended = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("fs_watch_ended was lost on a full queue")
        .expect("queue open");
    assert!(
        matches!(ended, Outbound::Event(event) if event.type_ == "fs_watch_ended"
            && event.payload["projectId"] == "p-gone"),
        "the watch-ended notice follows once there is room"
    );
}
