//! Tests for the per-project FS watch hub (#856): the pure filtering and
//! normalization decisions that decide which changes reach clients, plus the
//! hub's refcounting, targeted delivery and lifecycle over real filesystem
//! events.

use super::*;
use serde_json::json;


#[test]
fn reportable_paths_pass() {
    assert!(is_reportable_below_root(std::path::Path::new("/root/proj/src/main.rs"), std::path::Path::new("/root/proj")));
    assert!(is_reportable_below_root(std::path::Path::new("/root/proj/README.md"), std::path::Path::new("/root/proj")));
    assert!(is_reportable_below_root(std::path::Path::new("/root/proj/.termul/worktrees/a"), std::path::Path::new("/root/proj")));
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
            !is_reportable_below_root(std::path::Path::new(ignored), std::path::Path::new("/root/proj")),
            "{ignored} must be suppressed"
        );
    }
}

#[test]
fn ignored_name_as_plain_file_is_not_suppressed() {
    // A file literally NAMED "dist" (not a directory component on the
    // path) is still a reportable tree change.
    assert!(is_reportable_below_root(std::path::Path::new("/root/proj/dist"), std::path::Path::new("/root/proj")));
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

type Conn = (
    UnboundedSender<Outbound>,
    tokio::sync::mpsc::UnboundedReceiver<Outbound>,
);

fn conn() -> Conn {
    tokio::sync::mpsc::unbounded_channel()
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
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<Outbound>,
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

    assert_eq!(hub.subscribe(&registry, "nope", &tx), Err(WatchError::NotFound));
    assert!(registry.update("p-1", None, None, Some(true)));
    assert_eq!(hub.subscribe(&registry, "p-1", &tx), Err(WatchError::NotFound));
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
    hub.subscribe(&registry, "p-1", &a).expect("re-subscribe is idempotent");
    hub.subscribe(&registry, "p-1", &b).expect("b subscribes");
    assert_eq!(hub.subscriber_count("p-1"), 2);
    assert_eq!(hub.watched_project_count(), 1, "one watcher shared by both");

    assert!(hub.unsubscribe("p-1", &a));
    assert!(!hub.unsubscribe("p-1", &a), "second unsubscribe is a no-op");
    assert_eq!(hub.watched_project_count(), 1, "still watched for b");
    assert!(hub.unsubscribe("p-1", &b));
    assert_eq!(hub.watched_project_count(), 0, "last unsubscribe drops the watcher");
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
    assert_eq!(hub.watched_project_count(), 1, "p-1 dropped, p-2 kept for the other connection");
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
        next_fs_changed(&mut rx2, Duration::from_millis(800)).await.is_none(),
        "a connection watching ANOTHER project gets nothing"
    );
    assert!(
        next_fs_changed(&mut rx3, Duration::from_millis(100)).await.is_none(),
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
    assert_eq!(hub.watched_project_count(), 0, "delivery to a closed channel drops the watch");
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
    assert_eq!(hub.watched_project_count(), 0, "archive/remove drops the watchers");
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
    assert!(started.elapsed() < Duration::from_secs(5), "must not wait out the delay");

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
