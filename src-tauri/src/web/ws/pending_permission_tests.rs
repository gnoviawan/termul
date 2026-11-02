//! Issue #1595: a `permission_request` is not in the durable log, so a client
//! that reconnects into a snapshot, or with a cursor already past the request,
//! never sees it again. The `subscribe` and `recover_session_snapshot` replies
//! carry the session's still-pending requests (`pendingPermissions`) instead;
//! an answered request is not carried. Questions and elicitations ride the
//! same replies (`pendingQuestions`, `pendingElicitations`): the client drops
//! a replayed request its history already covers, since no event says it was
//! answered.

#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::tests::test_outbound;
use super::*;
use crate::web::permissions::{
    PermissionRendezvous, QuestionRendezvous, RespondError, RespondOutcome,
};
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

/// A turn end and the registration of a request of that turn are separate
/// `emit` calls. When the release runs first, the late request must not
/// become a ticket nothing releases: a reconnecting client would get an
/// approval back for a turn that already ended. A request of the next turn is
/// still registered.
#[tokio::test]
async fn a_request_registered_after_its_turn_ended_is_not_pending() {
    let relay = Arc::new(WsRelaySink::new());
    relay.seed_session_for_test(SID);
    let rendezvous = Arc::new(PermissionRendezvous::default());
    relay.set_rendezvous(Arc::clone(&rendezvous));
    let request_of = |request_id: &str, turn_id: &str| {
        let mut request = permission_request(request_id);
        request["turnId"] = json!(turn_id);
        request
    };

    // The release of turn-1 runs before the registration of its request.
    emit(
        &relay,
        "acp:prompt_complete",
        json!({"agentId": "agent-1", "sessionId": SID, "turnId": "turn-1", "stopReason": "cancelled"}),
    );
    emit(
        &relay,
        "acp:permission_request",
        request_of("perm-late", "turn-1"),
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
    assert!(
        pending_ids(&reply.payload.unwrap()).is_empty(),
        "a request of an ended turn is not restored"
    );
    assert_eq!(
        rendezvous
            .try_respond(ClientId::new(), "perm-late", Some("allow"))
            .await,
        Err(RespondError::AlreadyResolved),
        "its responder was cancelled with the turn"
    );

    // The next turn raises approvals as before.
    emit(
        &relay,
        "acp:permission_request",
        request_of("perm-next", "turn-2"),
    );
    let reply = handle_subscribe(
        "s2".to_string(),
        &json!({"sessionId": SID}),
        &relay,
        &tx,
        &subs,
    )
    .await;
    assert!(reply.ok, "{reply:?}");
    assert_eq!(pending_ids(&reply.payload.unwrap()), vec!["perm-next"]);
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
    let payload = reply.payload.unwrap();
    assert!(payload.get("pendingPermissions").is_none());
    assert!(payload.get("pendingQuestions").is_none());
    assert_eq!(
        payload["pendingElicitations"],
        json!([]),
        "the relay always keeps its elicitation tickets"
    );
}

fn question_request(question_id: &str) -> Value {
    json!({
        "agentId": "agent-1",
        "sessionId": SID,
        "questionId": question_id,
        "question": "Which plan?",
        "options": [{"value": "plan-a", "label": "Plan A"}],
        "allowFreeText": true,
        "multiSelect": false,
    })
}

fn elicitation_request(request_id: &str) -> Value {
    json!({
        "agentId": "agent-1",
        "sessionId": SID,
        "requestId": request_id,
        "mode": "form",
        "message": "Pick one",
        "fields": [{"name": "choice", "kind": "enum", "required": true}],
        "allowOther": false,
    })
}

fn ids<'a>(payload: &'a Value, list: &str, id: &str) -> Vec<&'a str> {
    payload[list]
        .as_array()
        .unwrap_or_else(|| panic!("the reply carries {list}"))
        .iter()
        .map(|request| request[id].as_str().unwrap())
        .collect()
}

fn relay_with_question_rendezvous() -> (Arc<WsRelaySink>, Arc<QuestionRendezvous>) {
    let relay = Arc::new(WsRelaySink::new());
    relay.seed_session_for_test(SID);
    let questions = Arc::new(QuestionRendezvous::default());
    relay.set_question_rendezvous(Arc::clone(&questions));
    (relay, questions)
}

async fn subscribe_reply(relay: &Arc<WsRelaySink>, payload: Value) -> Value {
    let (tx, _rx) = test_outbound();
    let subs = Arc::new(Subscriptions::default());
    let reply = handle_subscribe("s".to_string(), &payload, relay, &tx, &subs).await;
    assert!(reply.ok, "{reply:?}");
    reply.payload.unwrap()
}

/// A PWA reopened while a turn waits on a question or an elicitation gets
/// both back with their whole payloads, from a snapshot or from a cursor past
/// them.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn subscribe_and_snapshot_replies_carry_pending_questions_and_elicitations() {
    let root = std::env::temp_dir().join(format!("termul-ws-prompts-{}", uuid::Uuid::new_v4()));
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
    relay.set_question_rendezvous(Arc::new(QuestionRendezvous::default()));

    emit(&relay, "acp:tool_call", json!({"sessionId": SID, "n": 1}));
    emit(&relay, "acp:question_request", question_request("q-1"));
    emit(
        &relay,
        "acp:elicitation_request",
        elicitation_request("elicit-1"),
    );
    emit(&relay, "acp:tool_call", json!({"sessionId": SID, "n": 2}));
    let epoch = persistence.log_epoch(SID).unwrap();
    let (tx, _rx) = test_outbound();
    let subs = Arc::new(Subscriptions::default());

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
    assert_eq!(
        payload["pendingQuestions"],
        json!([question_request("q-1")])
    );
    assert_eq!(
        payload["pendingElicitations"],
        json!([elicitation_request("elicit-1")])
    );

    let head = payload["headSeq"].as_u64().unwrap();
    let payload = subscribe_reply(
        &relay,
        json!({"sessionId": SID, "lastSeq": head, "logEpoch": epoch}),
    )
    .await;
    assert_eq!(payload["replayed"], 0);
    assert_eq!(
        payload["pendingQuestions"],
        json!([question_request("q-1")])
    );
    assert_eq!(
        payload["pendingElicitations"],
        json!([elicitation_request("elicit-1")])
    );

    persistence.shutdown().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

/// Only what still waits is listed: a question answered on this or another
/// device and an elicitation answered through `respond_elicitation` drop out,
/// the rest stay in registration order.
#[tokio::test]
async fn answered_prompts_drop_out_of_the_pending_lists() {
    let (relay, questions) = relay_with_question_rendezvous();
    for question_id in ["q-a", "q-b"] {
        emit(
            &relay,
            "acp:question_request",
            question_request(question_id),
        );
    }
    for request_id in ["elicit-a", "elicit-b"] {
        emit(
            &relay,
            "acp:elicitation_request",
            elicitation_request(request_id),
        );
    }
    let payload = subscribe_reply(&relay, json!({"sessionId": SID})).await;
    assert_eq!(
        ids(&payload, "pendingQuestions", "questionId"),
        vec!["q-a", "q-b"]
    );
    assert_eq!(
        ids(&payload, "pendingElicitations", "requestId"),
        vec!["elicit-a", "elicit-b"]
    );

    assert_eq!(
        questions.try_respond(ClientId::new(), "q-a", None).await,
        Ok(crate::web::permissions::QuestionRespondOutcome::Resolved)
    );
    let acp = Arc::new(AcpManager::new(vec![]));
    acp.install_test_agent_with_sessions(
        crate::acp::AgentId("agent-1".to_string()),
        std::collections::HashSet::from([SID.to_string()]),
    );
    let reply = answer_elicitation(&acp, &relay, "elicit-a").await;
    assert!(reply.ok, "{reply:?}");
    let payload = subscribe_reply(&relay, json!({"sessionId": SID})).await;
    assert_eq!(ids(&payload, "pendingQuestions", "questionId"), vec!["q-b"]);
    assert_eq!(
        ids(&payload, "pendingElicitations", "requestId"),
        vec!["elicit-b"]
    );
}

async fn answer_elicitation(
    acp: &Arc<AcpManager>,
    relay: &WsRelaySink,
    request_id: &str,
) -> WsReply {
    handle_respond_elicitation(
        "e1".to_string(),
        &json!({"agentId": "agent-1", "requestId": request_id, "action": "accept"}),
        acp,
        relay,
    )
    .await
}

/// The agent no longer holds the elicitation (it was answered elsewhere or
/// withdrawn): the answer still succeeds and the request is not listed again.
#[tokio::test]
async fn an_elicitation_the_agent_no_longer_holds_is_not_listed_again() {
    let (relay, _questions) = relay_with_question_rendezvous();
    emit(
        &relay,
        "acp:elicitation_request",
        elicitation_request("elicit-1"),
    );
    let acp = Arc::new(AcpManager::new(vec![]));
    acp.install_test_agent_without_responders(crate::acp::AgentId("agent-1".to_string()));
    let reply = answer_elicitation(&acp, &relay, "elicit-1").await;
    assert!(reply.ok, "{reply:?}");
    let payload = subscribe_reply(&relay, json!({"sessionId": SID})).await;
    assert_eq!(payload["pendingElicitations"], json!([]));
}

/// An answer that names another agent does not clear the owner's ticket.
#[tokio::test]
async fn an_answer_naming_another_agent_keeps_the_elicitation_pending() {
    let (relay, _questions) = relay_with_question_rendezvous();
    emit(
        &relay,
        "acp:elicitation_request",
        elicitation_request("elicit-1"),
    );
    let acp = Arc::new(AcpManager::new(vec![]));
    acp.install_test_agent_without_responders(crate::acp::AgentId("agent-2".to_string()));
    let reply = handle_respond_elicitation(
        "e1".to_string(),
        &json!({"agentId": "agent-2", "requestId": "elicit-1", "action": "accept"}),
        &acp,
        &relay,
    )
    .await;
    assert!(reply.ok, "{reply:?}");
    let payload = subscribe_reply(&relay, json!({"sessionId": SID})).await;
    assert_eq!(
        ids(&payload, "pendingElicitations", "requestId"),
        vec!["elicit-1"]
    );
}

/// An answer the agent did not take leaves the elicitation pending, so a
/// reopened client can answer it again.
#[tokio::test]
async fn a_failed_elicitation_answer_keeps_it_pending() {
    let (relay, _questions) = relay_with_question_rendezvous();
    emit(
        &relay,
        "acp:elicitation_request",
        elicitation_request("elicit-1"),
    );
    let acp = Arc::new(AcpManager::new(vec![]));
    let reply = answer_elicitation(&acp, &relay, "elicit-1").await;
    assert!(!reply.ok, "{reply:?}");
    let payload = subscribe_reply(&relay, json!({"sessionId": SID})).await;
    assert_eq!(
        ids(&payload, "pendingElicitations", "requestId"),
        vec!["elicit-1"]
    );
}

/// A turn end, a session close or the agent's death cancels the parked
/// responders, so the next reply lists no question or elicitation.
#[tokio::test]
async fn lifecycle_ends_release_pending_questions_and_elicitations() {
    let (relay, _questions) = relay_with_question_rendezvous();
    let raise = |tag: &str| {
        emit(
            &relay,
            "acp:question_request",
            question_request(&format!("q-{tag}")),
        );
        emit(
            &relay,
            "acp:elicitation_request",
            elicitation_request(&format!("elicit-{tag}")),
        );
    };
    let ends: [(&str, Option<&str>, Value); 3] = [
        (
            "acp:prompt_complete",
            Some(SID),
            json!({"agentId": "agent-1", "sessionId": SID, "turnId": "turn-1", "stopReason": "cancelled"}),
        ),
        (
            "acp:session_closed",
            Some(SID),
            json!({"agentId": "agent-1", "sessionId": SID}),
        ),
        (
            "acp:agent_disconnected",
            None,
            json!({"agentId": "agent-1"}),
        ),
    ];
    for (n, (type_, sid, end)) in ends.into_iter().enumerate() {
        raise(&n.to_string());
        let payload = subscribe_reply(&relay, json!({"sessionId": SID})).await;
        assert_eq!(
            payload["pendingQuestions"].as_array().unwrap().len(),
            1,
            "{type_}"
        );
        assert_eq!(
            payload["pendingElicitations"].as_array().unwrap().len(),
            1,
            "{type_}"
        );

        relay.emit(&AcpEvent {
            sid: sid.map(str::to_string),
            type_,
            payload: end,
        });
        let payload = subscribe_reply(&relay, json!({"sessionId": SID})).await;
        assert_eq!(payload["pendingQuestions"], json!([]), "{type_}");
        assert_eq!(payload["pendingElicitations"], json!([]), "{type_}");
    }
}
