//! Pending requests a resubscribing client gets back (issue #1595): every
//! still-unanswered `permission_request` of a session, with its original
//! payload, in queue order. An answered or released request is never listed.

#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;
use serde_json::json;

fn permissions() -> PermissionRendezvous {
    PermissionRendezvous::new(Arc::new(AcpManager::new(vec![])))
}

fn request(id: &str, session: &str) -> Value {
    json!({
        "agentId": "a1",
        "sessionId": session,
        "requestId": id,
        "toolCall": {"toolCallId": format!("tc-{id}"), "title": "Run tests"},
        "options": [{"optionId": "allow", "name": "Allow", "kind": "allow_once"}],
    })
}

fn ids(pending: &[Value]) -> Vec<&str> {
    pending
        .iter()
        .map(|request| request["requestId"].as_str().unwrap())
        .collect()
}

#[test]
fn pending_requests_keep_the_whole_payload_in_queue_order() {
    let rdz = permissions();
    rdz.register_event(&request("perm-1", "sess-1"));
    rdz.register_event(&request("perm-2", "sess-1"));
    rdz.register_event(&request("perm-3", "sess-2"));

    let pending = rdz.pending_requests("sess-1");
    assert_eq!(
        ids(&pending),
        vec!["perm-1", "perm-2"],
        "outstanding first, then queued"
    );
    assert_eq!(
        pending[0],
        request("perm-1", "sess-1"),
        "the original payload, tool call included"
    );
    assert_eq!(ids(&rdz.pending_requests("sess-2")), vec!["perm-3"]);
    assert!(rdz.pending_requests("sess-unknown").is_empty());
}

#[tokio::test]
async fn an_answered_request_leaves_the_list_and_the_next_one_stays() {
    let rdz = permissions();
    rdz.register_event(&request("perm-1", "sess-1"));
    rdz.register_event(&request("perm-2", "sess-1"));

    let answer = rdz
        .try_respond(ClientId::new(), "perm-1", Some("allow"))
        .await;
    assert_eq!(answer, Ok(RespondOutcome::Resolved));
    assert_eq!(ids(&rdz.pending_requests("sess-1")), vec!["perm-2"]);

    rdz.settle("perm-2");
    assert!(
        rdz.pending_requests("sess-1").is_empty(),
        "an answer given elsewhere is not pending"
    );
}

#[test]
fn a_released_session_has_nothing_pending() {
    let rdz = permissions();
    rdz.register_event(&request("perm-1", "sess-1"));
    rdz.register_event(&request("perm-2", "sess-1"));

    rdz.release_session("sess-1");
    assert!(rdz.pending_requests("sess-1").is_empty());
}

#[test]
fn a_request_without_an_id_or_with_a_host_id_is_not_registered() {
    let rdz = permissions();
    rdz.register_event(&json!({"sessionId": "sess-1", "options": []}));
    let host_id = format!("host:{}", uuid::Uuid::new_v4());
    assert!(PermissionRendezvous::is_host_ticket(&host_id));
    rdz.register_event(&request(&host_id, "sess-1"));
    assert!(rdz.pending_requests("sess-1").is_empty());
}

#[test]
fn a_field_registered_ticket_lists_its_fields() {
    let rdz = permissions();
    rdz.register(
        "perm-1".to_string(),
        AgentId("a1".to_string()),
        "sess-1".to_string(),
        json!([{"optionId": "allow"}]),
    );
    let pending = rdz.pending_requests("sess-1");
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0]["requestId"], "perm-1");
    assert_eq!(pending[0]["agentId"], "a1");
    assert_eq!(pending[0]["options"][0]["optionId"], "allow");
}
