//! The per-project `fs` watch over the production relay loop (real time, real
//! filesystem events): `authenticate` → `watch` → state and change deltas on
//! the wire, and connection close releasing the watch.

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

/// Every `fs` watch frame of `project` the peer has received, in arrival order.
fn fs_frames(conn: &Conn, project: &str) -> Vec<Value> {
    conn.peer
        .events_of("watch")
        .into_iter()
        .filter(|frame| frame["watch"] == "fs" && frame["scope"] == project)
        .cloned()
        .collect()
}

#[tokio::test]
async fn fs_watch_delivers_state_then_change_deltas_to_the_subscribed_connection_only() {
    let host = Host::new(|_, _| {});
    let dir = project_dir("deliver");
    host.state.registry.seed_root_if_no_usable_project(&dir);
    let project = crate::web::project_registry::SEEDED_PROJECT_ID;

    let mut watcher = host.connect();
    watcher.authenticate().await;
    let mut bystander = host.connect();
    bystander.authenticate().await;

    let reply = watcher
        .request("w1", "watch", json!({ "watch": "fs", "scope": project }))
        .await;
    assert_eq!(reply["ok"], true, "{reply}");
    let state = fs_frames(&watcher, project);
    assert_eq!(state.len(), 1, "the state frame is queued before the reply");
    assert_eq!(state[0]["reset"], true);
    assert_eq!(state[0]["state"]["root"], json!(dir.display().to_string()));
    assert!(
        host.relay.fs_watches().wait_armed(project, WAIT).await,
        "watcher armed"
    );

    std::fs::write(dir.join("hello.txt"), "x").expect("write file");

    let delta = tokio::time::timeout(WAIT, async {
        loop {
            let frames = fs_frames(&watcher, project);
            if let Some(frame) = frames.iter().find(|frame| frame.get("delta").is_some()) {
                break frame.clone();
            }
            watcher.peer.read_for(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("an fs delta reaches the subscribed connection");
    assert_eq!(delta["revision"]["n"], 2);
    assert_eq!(delta["delta"]["root"], json!(dir.display().to_string()));
    assert!(delta["delta"]["paths"]
        .as_array()
        .expect("paths")
        .iter()
        .any(|p| p.as_str().is_some_and(|p| p.ends_with("/hello.txt"))));

    bystander.peer.read_for(Duration::from_millis(500)).await;
    assert!(
        fs_frames(&bystander, project).is_empty(),
        "a connection that did not subscribe gets no fs frame"
    );
    assert!(
        bystander.peer.events_of("fs_changed").is_empty(),
        "no seq-0 fs_changed event leaves the relay"
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
        .request("w1", "watch", json!({ "watch": "fs", "scope": project }))
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
