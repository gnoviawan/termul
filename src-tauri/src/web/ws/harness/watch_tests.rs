//! Per-project fs watch over the production relay loop (real time, real
//! filesystem events): `authenticate` → `watch_project` → `fs_changed` on the
//! wire, and connection close releasing the watch.

use super::*;

const WAIT: Duration = Duration::from_secs(15);

fn project_dir(label: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "termul-harness-watch-{label}-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).expect("create project dir");
    dir.canonicalize().expect("canonicalize project dir")
}

#[tokio::test]
async fn watch_project_delivers_fs_changed_to_the_subscribed_connection_only() {
    let host = Host::new(|_, _| {});
    let dir = project_dir("deliver");
    host.state.registry.seed_root_if_no_usable_project(&dir);
    let project = crate::web::project_registry::SEEDED_PROJECT_ID;

    let mut watcher = host.connect();
    watcher.authenticate().await;
    let mut bystander = host.connect();
    bystander.authenticate().await;

    let reply = watcher
        .request("w1", "watch_project", json!({ "projectId": project }))
        .await;
    assert_eq!(reply["ok"], true, "{reply}");
    assert!(
        host.relay.fs_watches().wait_armed(project, WAIT).await,
        "watcher armed"
    );

    std::fs::write(dir.join("hello.txt"), "x").expect("write file");

    let event = tokio::time::timeout(WAIT, watcher.peer.wait_event("fs_changed"))
        .await
        .expect("fs_changed reaches the subscribed connection");
    assert_eq!(event["payload"]["projectId"], json!(project));
    assert_eq!(event["payload"]["root"], json!(dir.display().to_string()));
    assert!(event["payload"]["paths"]
        .as_array()
        .expect("paths")
        .iter()
        .any(|p| p.as_str().is_some_and(|p| p.ends_with("/hello.txt"))));

    bystander.peer.read_for(Duration::from_millis(500)).await;
    assert!(
        bystander.peer.events_of("fs_changed").is_empty(),
        "a connection that did not subscribe gets no fs_changed"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn closing_the_connection_releases_its_watch() {
    let host = Host::new(|_, _| {});
    let dir = project_dir("close");
    host.state.registry.seed_root_if_no_usable_project(&dir);
    let project = crate::web::project_registry::SEEDED_PROJECT_ID;

    let mut conn = host.connect();
    conn.authenticate().await;
    let reply = conn
        .request("w1", "watch_project", json!({ "projectId": project }))
        .await;
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(host.relay.fs_watches().subscriber_count(project), 1);

    conn.peer.send_close(1000, "bye");
    let deadline = tokio::time::Instant::now() + WAIT;
    while host.relay.fs_watches().watched_project_count() != 0
        && tokio::time::Instant::now() < deadline
    {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(
        host.relay.fs_watches().watched_project_count(),
        0,
        "connection cleanup drops the watch"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
