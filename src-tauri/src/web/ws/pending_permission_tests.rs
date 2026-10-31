//! Issue #1595: a `permission_request` is not in the durable log, so a client
//! that reconnects into a snapshot, or with a cursor already past the request,
//! never sees it again. The `subscribe` and `recover_session_snapshot` replies
//! carry the session's still-pending requests (`pendingPermissions`) instead;
//! an answered request is not carried.

#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::tests::test_outbound;
use super::*;
use crate::web::permissions::{PermissionRendezvous, RespondOutcome};
use crate::web::sink::{AcpEvent, EventSink};

const SID: &str = "session-pending";

fn permission_request(request_id: &str) -> Value {
    json!({
        "agentId": "agent-1",
        "sessionId": SID,
        "requestId": request_id,
        "toolCall": {"toolCallId": "tc-1", "title": "Run tests"},
        "options": [{"optionId": "allow", "name": "Allow", "kind": "allow_once"}],
    })
}

fn emit(relay: &WsRelaySink, type_: &'static str, payload: Value) {
    relay.emit(&AcpEvent {
        sid: Some(SID.to_string()),
        type_,
        payload,
    });
}

fn pending_ids(payload: &Value) -> Vec<&str> {
    payload["pendingPermissions"]
        .as_array()
        .expect("the reply carries pendingPermissions")
        .iter()
        .map(|request| request["requestId"].as_str().unwrap())
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn subscribe_and_snapshot_replies_carry_a_still_pending_permission() {
    let root = std::env::temp_dir().join(format!("termul-ws-pending-{}", uuid::Uuid::new_v4()));
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = crate::acp::SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    persistence
        .register_session(crate::acp::SessionRegistration {
            session_id: SID.to_string(),
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    let relay = Arc::new(WsRelaySink::with_persistence(8, persistence.clone()));
    let rendezvous = Arc::new(PermissionRendezvous::default());
    relay.set_rendezvous(Arc::clone(&rendezvous));

    // seq 1 tool call, seq 2 the approval (non-durable), seq 3 a durable event
    // that lands while the approval waits.
    emit(&relay, "acp:tool_call", json!({"sessionId": SID, "n": 1}));
    emit(
        &relay,
        "acp:permission_request",
        permission_request("perm-1"),
    );
    emit(&relay, "acp:tool_call", json!({"sessionId": SID, "n": 2}));
    let epoch = persistence.log_epoch(SID).unwrap();
    let (tx, _rx) = test_outbound();
    let subs = Arc::new(Subscriptions::default());

    // A reconnect that installs a snapshot: the snapshot holds durable events
    // only, the pending approval rides beside it with its whole payload.
    let reply = handle_recover_session_snapshot(
        "r1".to_string(),
        &json!({ "sessionId": SID }),
        &relay,
        &tx,
        &subs,
        HistoryMode::Server,
    )
    .await;
    assert!(reply.ok, "{reply:?}");
    let payload = reply.payload.unwrap();
    let seqs: Vec<u64> = payload["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|event| event["seq"].as_u64().unwrap())
        .collect();
    assert_eq!(seqs, vec![1, 3], "the approval is not in the snapshot");
    assert_eq!(
        payload["pendingPermissions"],
        json!([permission_request("perm-1")])
    );

    // A reconnect whose cursor is already past the approval replays nothing,
    // and still gets the approval back.
    let reply = handle_subscribe(
        "s1".to_string(),
        &json!({"sessionId": SID, "lastSeq": 3, "logEpoch": epoch}),
        &relay,
        &tx,
        &subs,
    )
    .await;
    assert!(reply.ok, "{reply:?}");
    let payload = reply.payload.unwrap();
    assert_eq!(payload["replayed"], 0);
    assert_eq!(pending_ids(&payload), vec!["perm-1"]);

    // Answered: a later subscription carries an empty list, so the client
    // drops a card it still shows.
    let answer = rendezvous
        .try_respond(ClientId::new(), "perm-1", Some("allow"))
        .await;
    assert_eq!(answer, Ok(RespondOutcome::Resolved));
    let reply = handle_subscribe(
        "s2".to_string(),
        &json!({"sessionId": SID}),
        &relay,
        &tx,
        &subs,
    )
    .await;
    assert!(reply.ok, "{reply:?}");
    assert!(pending_ids(&reply.payload.unwrap()).is_empty());

    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

/// The relay registers the ticket before it publishes the event, so a
/// subscription made right after the publish already lists it.
#[tokio::test]
async fn a_ticket_is_listed_as_soon_as_its_event_is_published() {
    let relay = Arc::new(WsRelaySink::new());
    relay.seed_session_for_test(SID);
    relay.set_rendezvous(Arc::new(PermissionRendezvous::default()));
    emit(
        &relay,
        "acp:permission_request",
        permission_request("perm-1"),
    );
    emit(
        &relay,
        "acp:permission_request",
        permission_request("perm-2"),
    );

    let (tx, _rx) = test_outbound();
    let subs = Arc::new(Subscriptions::default());
    let reply = handle_subscribe(
        "s1".to_string(),
        &json!({"sessionId": SID}),
        &relay,
        &tx,
        &subs,
    )
    .await;
    assert!(reply.ok, "{reply:?}");
    assert_eq!(
        pending_ids(&reply.payload.unwrap()),
        vec!["perm-1", "perm-2"]
    );
}

/// Without a rendezvous the host knows no tickets: the reply has no list, and
/// the client keeps the approvals it already shows.
#[tokio::test]
async fn a_relay_without_a_rendezvous_adds_no_pending_list() {
    let relay = Arc::new(WsRelaySink::new());
    relay.seed_session_for_test(SID);
    let (tx, _rx) = test_outbound();
    let subs = Arc::new(Subscriptions::default());
    let reply = handle_subscribe(
        "s1".to_string(),
        &json!({"sessionId": SID}),
        &relay,
        &tx,
        &subs,
    )
    .await;
    assert!(reply.ok, "{reply:?}");
    assert!(reply.payload.unwrap().get("pendingPermissions").is_none());
}
