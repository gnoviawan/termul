//! The scoped watches (`store`, `terminals`) and the agent-level events that
//! became watch deltas (`browser_open_request`, `worktree_branch_renamed`),
//! over the production relay loop: once per socket with no session
//! subscription, scope isolation, and no `seq = 0` event leaving the relay.

use super::*;
use crate::pty::SpawnOptions;
use crate::web::sink::{AcpEvent, EventSink};
use crate::web::store::{StorePolicy, WebStore};
use crate::web::watch::{attach_terminal_set_observer, WatchKind};

/// Every `watch` frame of `watch` + `scope` the peer has received, in order.
fn frames(conn: &Conn, watch: &str, scope: &str) -> Vec<Value> {
    conn.peer
        .events_of("watch")
        .into_iter()
        .filter(|frame| frame["watch"] == watch && frame["scope"] == scope)
        .cloned()
        .collect()
}

fn host_with_store() -> (Host, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("termul-watch-store-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("create store dir");
    let store = Arc::new(WebStore::open(dir.join("store.json"), StorePolicy::default()).expect("open store"));
    let mut host = Host::new(|_, _| {});
    host.state.store = Some(store);
    (host, dir)
}

async fn connect_as(host: &Host, device: &str, tab: &str) -> Conn {
    let mut conn = host.connect();
    conn.authenticate_as(device, tab).await;
    conn
}

#[tokio::test(start_paused = true)]
async fn a_shared_key_watch_sends_the_value_then_every_write_from_any_device() {
    let (host, dir) = host_with_store();
    let mut watcher = connect_as(&host, "dev-a", "tab-a").await;
    let mut writer = connect_as(&host, "dev-b", "tab-b").await;
    let key = "shared/lww/layout";
    let wrap = |data: Value| json!({ "_version": 1, "data": data });

    let reply = watcher
        .request("w1", "watch", json!({ "watch": "store", "scope": key }))
        .await;
    assert_eq!(reply["ok"], true, "{reply}");
    let state = frames(&watcher, "store", key);
    assert_eq!(state[0]["state"], json!({ "exists": false }), "absent key");

    let write = writer
        .request("s1", "store_write", json!({ "key": key, "value": wrap(json!({ "cols": 3 })) }))
        .await;
    assert_eq!(write["ok"], true, "{write}");
    writer
        .request(
            "s2",
            "store_write",
            json!({ "key": "shared/lww/other", "value": wrap(json!(1)) }),
        )
        .await;
    watcher.peer.read_for(Duration::from_millis(50)).await;

    let all = frames(&watcher, "store", key);
    let ns: Vec<u64> = all.iter().map(|f| f["revision"]["n"].as_u64().unwrap()).collect();
    assert_eq!(ns, vec![1, 2], "the other key published nothing here");
    assert_eq!(all[1]["delta"], json!({ "exists": true, "value": wrap(json!({ "cols": 3 })) }));
    assert!(frames(&writer, "store", key).is_empty(), "the writer did not watch");

    // A watch started later begins from the present value.
    let late = writer
        .request("w2", "watch", json!({ "watch": "store", "scope": key }))
        .await;
    assert_eq!(late["ok"], true);
    assert_eq!(
        frames(&writer, "store", key)[0]["state"],
        json!({ "exists": true, "value": wrap(json!({ "cols": 3 })) })
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test(start_paused = true)]
async fn a_device_key_watch_follows_writes_and_deletes_of_that_device_only() {
    let (host, dir) = host_with_store();
    let mut watcher = connect_as(&host, "desk", "tab-1").await;
    let mut writer = connect_as(&host, "desk", "tab-2").await;
    let mut stranger = connect_as(&host, "phone", "tab-3").await;
    let key = "device/desk/layout";

    let refused = stranger
        .request("w0", "watch", json!({ "watch": "store", "scope": key }))
        .await;
    assert_eq!(refused["ok"], false);
    assert_eq!(refused["err"]["code"], "STORE_KEY_SCOPE");

    let reply = watcher
        .request("w1", "watch", json!({ "watch": "store", "scope": key }))
        .await;
    assert_eq!(reply["ok"], true, "{reply}");
    writer
        .request("s1", "store_write", json!({ "key": key, "value": { "cols": 3 } }))
        .await;
    let delete = writer.request("s2", "store_delete", json!({ "key": key })).await;
    assert_eq!(delete["ok"], true, "{delete}");
    watcher.peer.read_for(Duration::from_millis(50)).await;

    let all = frames(&watcher, "store", key);
    assert_eq!(all[1]["delta"], json!({ "exists": true, "value": { "cols": 3 } }));
    assert_eq!(all[2]["delta"], json!({ "exists": false }));
    assert!(frames(&stranger, "store", key).is_empty());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test(start_paused = true)]
async fn a_store_watch_needs_a_store_and_a_key() {
    let host = Host::new(|_, _| {});
    let mut conn = host.connect();
    conn.authenticate().await;

    let no_store = conn
        .request("w1", "watch", json!({ "watch": "store", "scope": "shared/lww/k" }))
        .await;
    assert_eq!(no_store["ok"], false);
    assert_eq!(no_store["err"]["code"], "STORE_UNAVAILABLE");
    let no_key = conn.request("w2", "watch", json!({ "watch": "store" })).await;
    assert_eq!(no_key["err"]["code"], "unsupported");
}

#[tokio::test]
async fn the_terminal_set_watch_follows_spawn_attach_and_kill_of_one_project() {
    let host = Host::new(|_, _| {});
    attach_terminal_set_observer(&host.state.pty, &host.relay);
    let mut watcher = host.connect();
    watcher.authenticate().await;
    let mut other = host.connect();
    other.authenticate().await;
    watcher
        .request("w1", "watch", json!({ "watch": "terminals", "scope": "proj-a" }))
        .await;
    other
        .request("w2", "watch", json!({ "watch": "terminals", "scope": "proj-b" }))
        .await;
    assert_eq!(
        frames(&watcher, "terminals", "proj-a")[0]["state"],
        json!({ "terminals": [] })
    );

    let spawned = host
        .state
        .pty
        .spawn(
            SpawnOptions {
                project_id: Some("proj-a".to_string()),
                ..Default::default()
            },
            None,
        )
        .await
        .expect("spawn");
    let id = spawned.info.id.clone();
    let instance = host.state.pty.get(&id).expect("instance");
    instance.add_web_attachment();
    instance.remove_web_attachment();
    host.state.pty.force_kill(&id).await.expect("kill");
    watcher.peer.read_for(Duration::from_millis(100)).await;

    let all = frames(&watcher, "terminals", "proj-a");
    let sets: Vec<Value> = all[1..].iter().map(|f| f["delta"]["terminals"].clone()).collect();
    let entry = |attached: bool| {
        json!([{ "terminalId": id, "projectId": "proj-a", "cwd": spawned.info.cwd, "attached": attached }])
    };
    assert_eq!(
        sets,
        vec![entry(false), entry(true), entry(false), json!([])],
        "spawn, first attach, last detach, kill"
    );
    let ns: Vec<u64> = all.iter().map(|f| f["revision"]["n"].as_u64().unwrap()).collect();
    assert_eq!(ns, vec![1, 2, 3, 4, 5], "contiguous revisions");
    assert!(
        !all.iter().any(|f| f.to_string().contains("claim")),
        "no credential rides the watch"
    );
    other.peer.read_for(Duration::from_millis(50)).await;
    assert_eq!(frames(&other, "terminals", "proj-b").len(), 1, "another project's watch only has its state");
}

#[tokio::test(start_paused = true)]
async fn agent_level_events_reach_watches_and_never_leave_as_seq_zero_events() {
    let host = Host::new(|_, _| {});
    let mut watcher = host.connect();
    watcher.authenticate().await;
    watcher.request("w1", "watch", json!({ "watch": "agents" })).await;
    watcher
        .request("w2", "watch", json!({ "watch": "chat_history" }))
        .await;
    // A socket with a session subscription but no watch gets nothing.
    let mut bystander = host.connect();
    bystander.authenticate().await;
    bystander.subscribe("sub").await;

    host.relay.emit(&AcpEvent {
        sid: None,
        type_: "acp:browser_open_request",
        payload: json!({ "agentId": "a-1", "url": "https://auth.example/x" }),
    });
    host.relay.emit(&AcpEvent {
        sid: None,
        type_: "acp:worktree_branch_renamed",
        payload: json!({ "worktreePath": "/w", "oldBranch": "a", "newBranch": "b" }),
    });
    host.relay.emit(&AcpEvent {
        sid: None,
        type_: "acp:some_unknown_agent_event",
        payload: json!({}),
    });
    watcher.peer.read_for(Duration::from_millis(50)).await;
    bystander.peer.read_for(Duration::from_millis(50)).await;

    let agents = frames(&watcher, "agents", "");
    assert_eq!(agents[1]["delta"]["event"], "browser_open_request");
    assert_eq!(agents[1]["delta"]["payload"]["url"], "https://auth.example/x");
    assert_eq!(agents.len(), 2, "the unknown event reaches no watch");
    let history = frames(&watcher, "chat_history", "");
    assert_eq!(history[1]["delta"]["event"], "worktree_branch_renamed");
    assert_eq!(history[1]["delta"]["payload"]["newBranch"], "b");
    assert_eq!(history[1]["delta"]["changed"], json!([]));

    for conn in [&watcher, &bystander] {
        for retired in ["browser_open_request", "worktree_branch_renamed", "some_unknown_agent_event", "fs_changed", "fs_watch_ended"] {
            assert!(conn.peer.events_of(retired).is_empty(), "no `{retired}` event on the wire");
        }
        assert!(
            conn.peer
                .events
                .iter()
                .all(|e| e["type"] == "auth_required" || e["seq"].as_u64().unwrap_or(1) != 0 || e["type"] == "watch"),
            "no seq = 0 event except auth_required"
        );
    }
    assert!(frames(&bystander, "agents", "").is_empty());
}

#[tokio::test(start_paused = true)]
async fn closing_the_connection_releases_scoped_watches() {
    let (host, dir) = host_with_store();
    let mut conn = host.connect();
    conn.authenticate().await;
    conn.request("w1", "watch", json!({ "watch": "store", "scope": "shared/lww/k" })).await;
    conn.request("w2", "watch", json!({ "watch": "terminals", "scope": "p" })).await;
    assert_eq!(host.relay.watches().subscriber_count(WatchKind::Store, "shared/lww/k"), 1);
    assert_eq!(host.relay.watches().subscriber_count(WatchKind::Terminals, "p"), 1);

    conn.peer.send_close(1000, "bye");
    Conn::settle().await;
    assert!(conn.relay_finished().await);
    assert_eq!(host.relay.watches().subscriber_count(WatchKind::Store, "shared/lww/k"), 0);
    assert_eq!(host.relay.watches().subscriber_count(WatchKind::Terminals, "p"), 0);
    let _ = std::fs::remove_dir_all(dir);
}
