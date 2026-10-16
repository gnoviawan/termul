//! Durable-ticket behaviour: a pending permission or question has no timer and
//! ends only by an answer or a lifecycle release. Every test runs on a paused
//! clock, so an hour of waiting costs no wall time and any timer the
//! rendezvous armed would fire during it.

#![allow(clippy::unwrap_used, clippy::expect_used)]
use std::time::Duration;

use super::*;
use serde_json::json;

/// More than any timeout the host used to apply (60 s ticket, 15 s grace).
const LONG_WAIT: Duration = Duration::from_secs(3600);

fn permissions() -> PermissionRendezvous {
    PermissionRendezvous::new(Arc::new(AcpManager::new(vec![])))
}

fn questions() -> QuestionRendezvous {
    QuestionRendezvous::new(Arc::new(AcpManager::new(vec![])))
}

fn allow() -> Value {
    json!([{ "optionId": "allow", "name": "allow", "kind": "auto" }])
}

fn plan() -> Value {
    json!([{ "value": "plan-a", "label": "plan-a" }])
}

fn ask(rdz: &PermissionRendezvous, id: &str, agent: &str, session: &str) {
    rdz.register(
        id.to_string(),
        AgentId(agent.to_string()),
        session.to_string(),
        allow(),
    );
}

fn ask_question(rdz: &QuestionRendezvous, id: &str, agent: &str, session: &str) {
    rdz.register(
        id.to_string(),
        AgentId(agent.to_string()),
        session.to_string(),
        plan(),
    );
}

async fn answer(rdz: &PermissionRendezvous, id: &str) -> Result<RespondOutcome, RespondError> {
    rdz.try_respond(ClientId::new(), id, Some("allow")).await
}

#[tokio::test(start_paused = true)]
async fn a_permission_waits_for_a_human_with_no_timer() {
    let rdz = permissions();
    ask(&rdz, "perm-1", "a1", "sess-1");

    tokio::time::sleep(LONG_WAIT).await;
    assert!(rdz.is_outstanding("perm-1"), "no timer may expire the ticket");

    assert_eq!(answer(&rdz, "perm-1").await, Ok(RespondOutcome::Resolved));
    assert_eq!(
        answer(&rdz, "perm-1").await,
        Err(RespondError::AlreadyResolved),
        "a second answer loses"
    );
}

#[tokio::test(start_paused = true)]
async fn a_question_waits_for_a_human_with_no_timer() {
    let rdz = questions();
    ask_question(&rdz, "q-1", "a1", "sess-1");

    tokio::time::sleep(LONG_WAIT).await;
    assert!(rdz.is_outstanding("q-1"), "no timer may expire the ticket");

    let values = vec!["plan-a".to_string()];
    assert_eq!(
        rdz.try_respond(ClientId::new(), "q-1", Some(&values)).await,
        Ok(QuestionRespondOutcome::Resolved)
    );
    assert_eq!(
        rdz.try_respond(ClientId::new(), "q-1", Some(&values)).await,
        Err(QuestionRespondError::AlreadyResolved)
    );
}

#[tokio::test(start_paused = true)]
async fn one_approval_stays_outstanding_through_a_long_wait_and_the_next_is_promoted_by_its_answer()
{
    let rdz = permissions();
    ask(&rdz, "perm-1", "a1", "sess-1");
    ask(&rdz, "perm-2", "a1", "sess-1");
    ask(&rdz, "perm-3", "a1", "sess-1");

    tokio::time::sleep(LONG_WAIT).await;
    assert!(rdz.is_outstanding("perm-1"));
    assert!(!rdz.is_outstanding("perm-2"), "only one ticket per session");
    assert_eq!(rdz.queued_count_for_session("sess-1"), 2);

    assert_eq!(answer(&rdz, "perm-1").await, Ok(RespondOutcome::Resolved));
    assert!(rdz.is_outstanding("perm-2"), "FIFO promotion");
    assert!(!rdz.is_outstanding("perm-3"));
    assert_eq!(rdz.queued_count_for_session("sess-1"), 1);

    tokio::time::sleep(LONG_WAIT).await;
    assert!(rdz.is_outstanding("perm-2"), "the promoted ticket has no timer either");
}

#[tokio::test(start_paused = true)]
async fn approvals_of_different_sessions_do_not_queue_behind_each_other() {
    let rdz = permissions();
    ask(&rdz, "perm-a", "a1", "sess-a");
    ask(&rdz, "perm-b", "a1", "sess-b");
    assert!(rdz.is_outstanding("perm-a"));
    assert!(rdz.is_outstanding("perm-b"));
}

/// The desktop answers the agent directly and reports it with `settle`: the
/// ticket must free the session's slot, and a later answer from another client
/// reads `already_resolved`.
#[tokio::test(start_paused = true)]
async fn an_answer_given_elsewhere_settles_the_ticket_and_promotes_the_next() {
    let rdz = permissions();
    ask(&rdz, "perm-1", "a1", "sess-1");
    ask(&rdz, "perm-2", "a1", "sess-1");

    rdz.settle("perm-1");
    assert!(rdz.is_outstanding("perm-2"), "settling promotes the queue");
    assert_eq!(answer(&rdz, "perm-1").await, Err(RespondError::AlreadyResolved));

    // A queued ticket settled before its promotion is forgotten as well and
    // never becomes outstanding.
    ask(&rdz, "perm-3", "a1", "sess-1");
    rdz.settle("perm-3");
    assert_eq!(rdz.queued_count_for_session("sess-1"), 0);
    assert_eq!(answer(&rdz, "perm-3").await, Err(RespondError::AlreadyResolved));

    // An id the rendezvous never saw leaves no tombstone.
    rdz.settle("perm-never");
    assert_eq!(answer(&rdz, "perm-never").await, Err(RespondError::NotFound));
}

#[tokio::test(start_paused = true)]
async fn releasing_a_session_drops_its_whole_queue_and_frees_the_slot() {
    let rdz = permissions();
    ask(&rdz, "perm-1", "a1", "sess-1");
    ask(&rdz, "perm-2", "a1", "sess-1");
    ask(&rdz, "perm-other", "a1", "sess-2");

    assert_eq!(rdz.release_session("sess-1"), 2);
    assert!(!rdz.is_outstanding("perm-1"));
    assert_eq!(rdz.queued_count_for_session("sess-1"), 0);
    assert!(rdz.is_outstanding("perm-other"), "another session is untouched");
    for id in ["perm-1", "perm-2"] {
        assert_eq!(answer(&rdz, id).await, Err(RespondError::AlreadyResolved), "{id}");
    }

    // The next turn's approval is outstanding at once: the slot is free.
    ask(&rdz, "perm-next", "a1", "sess-1");
    assert!(rdz.is_outstanding("perm-next"));
    assert_eq!(rdz.release_session("sess-unknown"), 0);
}

#[tokio::test(start_paused = true)]
async fn releasing_an_agent_drops_its_sessions_and_only_its_own() {
    let rdz = permissions();
    ask(&rdz, "perm-1", "a1", "sess-1");
    ask(&rdz, "perm-1b", "a1", "sess-1");
    ask(&rdz, "perm-2", "a1", "sess-2");
    ask(&rdz, "perm-3", "a2", "sess-3");

    assert_eq!(rdz.release_agent(&AgentId("a1".to_string())), 3);
    for id in ["perm-1", "perm-1b", "perm-2"] {
        assert!(!rdz.is_outstanding(id), "{id}");
        assert_eq!(answer(&rdz, id).await, Err(RespondError::AlreadyResolved), "{id}");
    }
    assert!(rdz.is_outstanding("perm-3"), "another agent is untouched");
    assert_eq!(rdz.release_agent(&AgentId("a1".to_string())), 0);
}

#[tokio::test(start_paused = true)]
async fn questions_are_released_by_session_and_by_agent() {
    let rdz = questions();
    ask_question(&rdz, "q-1", "a1", "sess-1");
    ask_question(&rdz, "q-2", "a1", "sess-2");
    ask_question(&rdz, "q-3", "a2", "sess-3");

    assert_eq!(rdz.release_session("sess-1"), 1);
    assert!(!rdz.is_outstanding("q-1"));
    assert!(rdz.is_outstanding("q-2"));

    assert_eq!(rdz.release_agent(&AgentId("a1".to_string())), 1);
    assert!(!rdz.is_outstanding("q-2"));
    assert!(rdz.is_outstanding("q-3"), "another agent is untouched");

    let values = vec!["plan-a".to_string()];
    for id in ["q-1", "q-2"] {
        assert_eq!(
            rdz.try_respond(ClientId::new(), id, Some(&values)).await,
            Err(QuestionRespondError::AlreadyResolved),
            "{id}"
        );
    }

    rdz.settle("q-3");
    assert_eq!(
        rdz.try_respond(ClientId::new(), "q-3", Some(&values)).await,
        Err(QuestionRespondError::AlreadyResolved)
    );
}
