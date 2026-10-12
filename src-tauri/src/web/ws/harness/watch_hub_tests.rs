//! The state watches (projects, chat-history index, agent roster) over the
//! production relay loop: full state before the reply, once per socket with no
//! session subscription, contiguous revisions, resubscribe returning fresh
//! state and release on close.

use super::*;
use crate::acp::session_persistence::SessionPersistence;
use crate::web::sink::{AcpEvent, EventSink};
use crate::web::watch::{publish_agent_event, publish_chat_history, publish_projects};

/// Every `watch` frame of `watch` the peer has received, in arrival order.
fn frames(conn: &Conn, watch: &str) -> Vec<Value> {
    conn.peer
        .events_of("watch")
        .into_iter()
        .filter(|frame| frame["watch"] == watch)
        .cloned()
        .collect()
}

#[tokio::test(start_paused = true)]
async fn a_socket_without_session_subscriptions_gets_state_then_deltas() {
    let host = Host::new(|_, _| {});
    let mut conn = host.connect();
    conn.authenticate().await;

    let reply = conn
        .request("w1", "watch", json!({ "watch": "projects" }))
        .await;
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(reply["payload"]["revision"]["n"], 1);
    // The state frame is on the wire before the reply is.
    let state = frames(&conn, "projects");
    assert_eq!(state.len(), 1, "state frame queued before the reply");
    assert_eq!(state[0]["reset"], true);
    assert_eq!(state[0]["revision"]["n"], 1);
    assert_eq!(state[0]["revision"]["hostEpoch"], json!(host.relay.watches().host_epoch()));
    assert_eq!(state[0]["state"], json!({ "projects": [] }));

    publish_projects(&host.relay, &host.state.registry);
    publish_projects(&host.relay, &host.state.registry);
    conn.peer.read_for(Duration::from_millis(50)).await;

    let all = frames(&conn, "projects");
    let ns: Vec<u64> = all.iter().map(|f| f["revision"]["n"].as_u64().unwrap()).collect();
    assert_eq!(ns, vec![1, 2, 3]);
    assert_eq!(all[2]["delta"], json!({ "projects": [] }));
    assert!(all[2].get("reset").is_none());
}

#[tokio::test(start_paused = true)]
async fn a_resubscribe_returns_fresh_state_and_restarts_the_revision() {
    let host = Host::new(|_, _| {});
    let mut conn = host.connect();
    conn.authenticate().await;
    conn.request("w1", "watch", json!({ "watch": "chat_history" })).await;
    publish_chat_history(&host.relay, &["s-1"]);
    publish_chat_history(&host.relay, &["s-2"]);
    conn.peer.read_for(Duration::from_millis(50)).await;
    assert_eq!(frames(&conn, "chat_history").len(), 3);

    // The client saw a revision gap and asks again.
    let reply = conn.request("w2", "watch", json!({ "watch": "chat_history" })).await;
    assert_eq!(reply["payload"]["revision"]["n"], 1);
    publish_chat_history(&host.relay, &["s-3"]);
    conn.peer.read_for(Duration::from_millis(50)).await;

    let all = frames(&conn, "chat_history");
    let tail: Vec<(u64, bool)> = all[3..]
        .iter()
        .map(|f| (f["revision"]["n"].as_u64().unwrap(), f.get("reset").is_some()))
        .collect();
    assert_eq!(tail, vec![(1, true), (2, false)], "fresh state, then deltas from n = 2");
    assert_eq!(host.relay.watches().subscriber_count(crate::web::watch::WatchKind::ChatHistory, ""), 1);
}

#[tokio::test(start_paused = true)]
async fn the_agent_roster_reaches_the_agents_watch() {
    let host = Host::new(|_, _| {});
    let mut watcher = host.connect();
    watcher.authenticate().await;
    watcher.request("w1", "watch", json!({ "watch": "agents" })).await;

    host.relay.emit(&AcpEvent {
        sid: None,
        type_: "acp:agent_spawned",
        payload: json!({ "agentId": "a-1" }),
    });
    publish_agent_event(&host.relay, "agent_disconnected", &json!({ "agentId": "a-1" }));
    watcher.peer.read_for(Duration::from_millis(50)).await;

    let deltas = frames(&watcher, "agents");
    assert_eq!(deltas[1]["delta"]["event"], "agent_spawned");
    assert_eq!(deltas[2]["delta"]["event"], "agent_disconnected");
}

#[tokio::test(start_paused = true)]
async fn closing_the_connection_releases_its_watches() {
    let host = Host::new(|_, _| {});
    let mut conn = host.connect();
    conn.authenticate().await;
    conn.request("w1", "watch", json!({ "watch": "projects" })).await;
    conn.request("w2", "watch", json!({ "watch": "agents" })).await;
    assert_eq!(host.relay.watches().subscriber_count(crate::web::watch::WatchKind::Projects, ""), 1);

    conn.peer.send_close(1000, "bye");
    Conn::settle().await;
    assert!(conn.relay_finished().await);
    assert_eq!(host.relay.watches().subscriber_count(crate::web::watch::WatchKind::Projects, ""), 0);
    assert_eq!(host.relay.watches().subscriber_count(crate::web::watch::WatchKind::Agents, ""), 0);
}

#[tokio::test(start_paused = true)]
async fn unwatch_stops_the_deltas_and_bad_requests_are_refused() {
    let host = Host::new(|_, _| {});
    let mut conn = host.connect();
    conn.authenticate().await;
    conn.request("w1", "watch", json!({ "watch": "projects" })).await;
    let reply = conn.request("u1", "unwatch", json!({ "watch": "projects" })).await;
    assert_eq!(reply["ok"], true);
    publish_projects(&host.relay, &host.state.registry);
    conn.peer.read_for(Duration::from_millis(50)).await;
    assert_eq!(frames(&conn, "projects").len(), 1, "only the state frame");

    for payload in [
        json!({ "watch": "fs" }),
        json!({ "watch": "projects", "scope": "p-1" }),
        json!({}),
    ] {
        let reply = conn.request("bad", "watch", payload.clone()).await;
        assert_eq!(reply["ok"], false, "{payload}");
        assert_eq!(reply["err"]["code"], "unsupported", "{payload}");
    }
}

#[tokio::test(start_paused = true)]
async fn a_new_serve_start_changes_the_epoch_the_next_frame_carries() {
    let host = Host::new(|_, _| {});
    let mut conn = host.connect();
    conn.authenticate().await;
    conn.request("w1", "watch", json!({ "watch": "projects" })).await;
    let before = host.relay.watches().host_epoch();
    let after = host.relay.watches().renew_epoch();
    assert_ne!(before, after);

    publish_projects(&host.relay, &host.state.registry);
    conn.peer.read_for(Duration::from_millis(50)).await;

    let all = frames(&conn, "projects");
    assert_eq!(all[0]["revision"]["hostEpoch"], json!(before));
    assert_eq!(all[1]["revision"]["hostEpoch"], json!(after));
}

#[tokio::test(start_paused = true)]
async fn the_chat_history_state_is_the_persisted_index() {
    let root = std::env::temp_dir().join(format!("termul-watch-hub-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let persistence = SessionPersistence::open(root.join("sessions")).await.unwrap();
    persistence
        .register_session(crate::acp::SessionRegistration {
            session_id: "s-index".to_string(),
            stable_agent_namespace: Some("config:claude".to_string()),
            runtime_agent_id: Some("agent-1".to_string()),
            project_id: Some("p-1".to_string()),
            cwd: root.clone(),
            ..Default::default()
        })
        .await
        .unwrap();
    let relay = Arc::new(WsRelaySink::with_persistence(8, persistence.clone()));
    let acp = Arc::new(AcpManager::new(vec![relay.clone()]));
    let host = Host::from_parts(relay, acp, HistoryMode::Server);
    let mut conn = host.connect();
    conn.authenticate().await;

    conn.request("w1", "watch", json!({ "watch": "chat_history" })).await;

    let state = frames(&conn, "chat_history");
    let sessions = state[0]["state"].as_array().expect("index array");
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["sessionId"], "s-index");
    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

/// A stalled peer cannot grow the host's queue: deltas past the bound are
/// dropped, the revision shows the hole, a resync marker follows it, and the
/// client's resubscribe returns fresh state at `n = 1`.
#[tokio::test(start_paused = true)]
async fn a_dropped_delta_leaves_a_revision_gap_the_resubscribe_repairs() {
    let host = Host::new(|_, _| {});
    let mut conn = host.connect();
    conn.authenticate().await;
    conn.request("w1", "watch", json!({ "watch": "agents" })).await;
    conn.peer.stall_writes();

    let published = crate::web::ws::OUTBOUND_QUEUE_CAPACITY + 50;
    for index in 0..published {
        publish_agent_event(&host.relay, "agent_error", &json!({ "agentId": format!("a-{index}") }));
    }
    Conn::settle().await;
    conn.peer.resume_writes();
    conn.peer.read_for(Duration::from_secs(2)).await;

    let all = frames(&conn, "agents");
    let ns: Vec<u64> = all.iter().map(|f| f["revision"]["n"].as_u64().unwrap()).collect();
    let marker = all.last().expect("frames");
    assert_eq!(marker["delta"], json!({ "resync": true }), "the marker ends the stream");
    let before_marker = ns[ns.len() - 2];
    assert!(
        ns[ns.len() - 1] > before_marker + 1,
        "the dropped delta's n is a hole before the marker: {before_marker} then {}",
        ns[ns.len() - 1]
    );
    let contiguous = &ns[..ns.len() - 1];
    assert!(contiguous.windows(2).all(|w| w[1] == w[0] + 1), "everything before the hole is contiguous");
    assert!(
        contiguous.len() < published,
        "the queue stayed bounded: not every delta was delivered"
    );

    // The client saw the hole and asks again: fresh state, revision restarts.
    let reply = conn.request("w2", "watch", json!({ "watch": "agents" })).await;
    assert_eq!(reply["payload"]["revision"]["n"], 1);
    assert!(!conn.relay_finished().await, "a brief overflow never closes the connection");
}

#[tokio::test(start_paused = true)]
async fn the_agents_state_lists_each_live_agent_with_its_id_and_capabilities() {
    let host = Host::new(|acp, sessions| {
        acp.install_test_agent_with_turns(
            AgentId(AGENT.to_string()),
            sessions,
            vec![],
            false,
        );
    });
    let mut conn = host.connect();
    conn.authenticate().await;

    conn.request("w1", "watch", json!({ "watch": "agents" })).await;

    let state = frames(&conn, "agents");
    let agents = state[0]["state"].as_array().expect("agent array");
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0]["id"], AGENT);
    assert!(agents[0]["capabilities"].is_object(), "{}", agents[0]);
}
