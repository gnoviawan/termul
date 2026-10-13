//! Durable approvals and questions through the production relay loop: a
//! pending ticket has no timer and no disconnect deny, is answered by its id
//! from any connection, and ends only by an answer or a lifecycle event of its
//! turn, session or agent (the relay releases it from `emit`). Time is paused,
//! so a wait longer than the old 60 s timeout and 15 s reconnect grace is exact.

use crate::web::permissions::{PermissionRendezvous, QuestionRendezvous};
use crate::web::sink::{AcpEvent, EventSink};

use super::*;

/// Far past the old ticket timeout (60 s) and reconnect grace (15 s).
const LONG_WAIT: Duration = Duration::from_secs(900);

/// The agent that raises the tickets (the manager has none installed, so an
/// answer resolves the ticket and the agent call is logged and ignored).
const TICKET_AGENT: &str = "a1";

fn host() -> Host {
    host_with(|_, _| {})
}

/// A host whose manager also owns the ticket agent, so `cancel_prompt` and
/// `kill_agent` reach a driver.
fn host_with_agent() -> Host {
    host_with(|acp, sessions| {
        acp.install_test_agent_with_sessions(AgentId(TICKET_AGENT.to_string()), sessions);
    })
}

fn host_with(install: impl FnOnce(&Arc<AcpManager>, HashSet<String>)) -> Host {
    let host = Host::new(install);
    let acp = Arc::clone(&host.state.acp);
    host.relay
        .set_rendezvous(Arc::new(PermissionRendezvous::new(Arc::clone(&acp))));
    host.relay
        .set_question_rendezvous(Arc::new(QuestionRendezvous::new(acp)));
    host
}

fn permission_request(host: &Host, request_id: &str, agent: &str, session: &str) {
    host.relay.emit(&AcpEvent {
        sid: Some(session.to_string()),
        type_: "acp:permission_request",
        payload: json!({
            "agentId": agent, "sessionId": session, "requestId": request_id,
            "toolCall": {"toolCallId": "tc-1"}, "options": [{"optionId": "allow"}],
        }),
    });
}

fn question_request(host: &Host, question_id: &str, agent: &str, session: &str) {
    host.relay.emit(&AcpEvent {
        sid: Some(session.to_string()),
        type_: "acp:question_request",
        payload: json!({
            "agentId": agent, "sessionId": session, "questionId": question_id,
            "options": [{"value": "plan-a", "label": "plan-a"}],
        }),
    });
}

fn outstanding(host: &Host, request_id: &str) -> bool {
    host.relay
        .rendezvous()
        .expect("permission rendezvous")
        .session_for_request(request_id)
        .is_some()
}

fn question_outstanding(host: &Host, question_id: &str) -> bool {
    host.relay
        .question_rendezvous()
        .expect("question rendezvous")
        .session_for_question(question_id)
        .is_some()
}

async fn respond(conn: &mut Conn, id: &str, request_id: &str) -> Value {
    conn.request(id, "respond_permission", json!({"requestId": request_id, "optionId": "allow"}))
        .await
}

async fn answer_question(conn: &mut Conn, id: &str, question_id: &str) -> Value {
    conn.request(id, "answer_question", json!({"questionId": question_id, "values": ["plan-a"]}))
        .await
}

/// The last subscriber leaving, then a wait far beyond the old timers, changes
/// nothing: a brand-new connection that never subscribed answers by `requestId`
/// and `questionId`, and the second answer to each is `already_resolved`.
#[tokio::test(start_paused = true)]
async fn a_ticket_outlives_its_last_subscriber_and_is_answered_after_reconnect() {
    let host = host();
    let mut first = host.connect();
    first.authenticate().await;
    first.subscribe("sub").await;
    permission_request(&host, "perm-1", TICKET_AGENT, SESSION);
    question_request(&host, "q-1", TICKET_AGENT, SESSION);
    first.peer.wait_event("permission_request").await;

    first.peer.reset();
    tokio::time::timeout(Duration::from_secs(5), first.task)
        .await
        .expect("the relay ends on a reset")
        .expect("relay task did not panic");
    assert_eq!(host.relay.session_subscriber_count(SESSION), 0, "no viewer is left");

    tokio::time::sleep(LONG_WAIT).await;
    assert!(outstanding(&host, "perm-1"), "no timer or disconnect deny may drop the permission");
    assert!(question_outstanding(&host, "q-1"), "nor the question");

    let mut second = host.connect();
    second.authenticate().await;
    let permission = respond(&mut second, "r1", "perm-1").await;
    assert_eq!(permission["ok"], true, "{permission}");
    let question = answer_question(&mut second, "r2", "q-1").await;
    assert_eq!(question["ok"], true, "{question}");

    let mut third = host.connect();
    third.authenticate().await;
    let late_permission = respond(&mut third, "r3", "perm-1").await;
    assert_eq!(late_permission["err"]["code"], "already_resolved", "{late_permission}");
    let late_question = answer_question(&mut third, "r4", "q-1").await;
    assert_eq!(late_question["err"]["code"], "already_resolved", "{late_question}");
}

/// A turn, session or agent ending releases its tickets: nothing can answer
/// them any more, a later answer reads `already_resolved`, and the session's
/// slot is free, so the next approval is outstanding at once.
#[tokio::test(start_paused = true)]
async fn lifecycle_events_release_tickets_and_free_the_session_slot() {
    let events: [(&str, Option<&str>, Value); 4] = [
        ("acp:prompt_complete", Some(SESSION), json!({"sessionId": SESSION, "turnId": "turn-1"})),
        ("acp:session_closed", Some(SESSION), json!({"agentId": TICKET_AGENT, "sessionId": SESSION})),
        ("acp:agent_disconnected", None, json!({"agentId": TICKET_AGENT})),
        ("acp:agent_crashed", None, json!({"agentId": TICKET_AGENT})),
    ];
    for (type_, sid, payload) in events {
        let host = host();
        let mut conn = host.connect();
        conn.authenticate().await;
        permission_request(&host, "perm-1", TICKET_AGENT, SESSION);
        permission_request(&host, "perm-2", TICKET_AGENT, SESSION);
        question_request(&host, "q-1", TICKET_AGENT, SESSION);
        assert!(outstanding(&host, "perm-1"), "{type_}");
        assert!(!outstanding(&host, "perm-2"), "{type_}: the second waits in the queue");

        tokio::time::sleep(LONG_WAIT).await;
        host.relay.emit(&AcpEvent {
            sid: sid.map(str::to_string),
            type_,
            payload,
        });

        assert!(!outstanding(&host, "perm-1"), "{type_}");
        assert!(!question_outstanding(&host, "q-1"), "{type_}");
        for request_id in ["perm-1", "perm-2"] {
            let late = respond(&mut conn, request_id, request_id).await;
            assert_eq!(late["err"]["code"], "already_resolved", "{type_} {request_id}: {late}");
        }
        let late = answer_question(&mut conn, "late-q", "q-1").await;
        assert_eq!(late["err"]["code"], "already_resolved", "{type_}: {late}");

        permission_request(&host, "perm-next", TICKET_AGENT, SESSION);
        assert!(outstanding(&host, "perm-next"), "{type_}: the freed slot takes the next approval");
        let next = respond(&mut conn, "next", "perm-next").await;
        assert_eq!(next["ok"], true, "{type_}: {next}");
    }
}

/// A release reaches only the ending session or agent: another session of the
/// same agent survives a `session_closed`, and another agent survives an
/// `agent_disconnected`.
#[tokio::test(start_paused = true)]
async fn a_release_reaches_only_the_session_or_agent_that_ended() {
    let host = host();
    permission_request(&host, "perm-s1", "a1", "s1");
    permission_request(&host, "perm-s2", "a1", "s2");
    permission_request(&host, "perm-s3", "a2", "s3");

    host.relay.emit(&AcpEvent {
        sid: Some("s1".to_string()),
        type_: "acp:session_closed",
        payload: json!({"agentId": "a1", "sessionId": "s1"}),
    });
    assert!(!outstanding(&host, "perm-s1"));
    assert!(outstanding(&host, "perm-s2"), "another session of the agent is untouched");
    assert!(outstanding(&host, "perm-s3"));

    host.relay.emit(&AcpEvent {
        sid: None,
        type_: "acp:agent_disconnected",
        payload: json!({"agentId": "a1"}),
    });
    assert!(!outstanding(&host, "perm-s2"));
    assert!(outstanding(&host, "perm-s3"), "another agent is untouched");
}

/// The first answer wins across connections, and the answered ticket promotes
/// the session's next approval; neither waits on a timer.
#[tokio::test(start_paused = true)]
async fn an_answer_promotes_the_next_approval_after_a_long_wait() {
    let host = host();
    permission_request(&host, "perm-1", TICKET_AGENT, SESSION);
    permission_request(&host, "perm-2", TICKET_AGENT, SESSION);
    tokio::time::sleep(LONG_WAIT).await;
    assert!(outstanding(&host, "perm-1"), "one approval stays outstanding for the whole wait");
    assert!(!outstanding(&host, "perm-2"));

    let mut a = host.connect();
    a.authenticate().await;
    let mut b = host.connect();
    b.authenticate().await;
    let won = respond(&mut a, "a1", "perm-1").await;
    assert_eq!(won["ok"], true, "{won}");
    let lost = respond(&mut b, "b1", "perm-1").await;
    assert_eq!(lost["err"]["code"], "already_resolved", "{lost}");

    assert!(outstanding(&host, "perm-2"), "the answer promoted the queued approval");
    tokio::time::sleep(LONG_WAIT).await;
    assert!(outstanding(&host, "perm-2"));
}

/// The manager releases tickets itself on a turn cancel and on a kill, without
/// waiting for a lifecycle event: the cancelled session and the killed agent
/// lose theirs, and nothing else does.
#[tokio::test(start_paused = true)]
async fn a_turn_cancel_and_a_kill_release_their_tickets() {
    let host = host_with_agent();
    let mut conn = host.connect();
    conn.authenticate().await;
    permission_request(&host, "perm-1", TICKET_AGENT, SESSION);
    permission_request(&host, "perm-queued", TICKET_AGENT, SESSION);
    question_request(&host, "q-1", TICKET_AGENT, SESSION);
    permission_request(&host, "perm-other", TICKET_AGENT, "sess-other");

    let cancelled = conn
        .request("c1", "cancel_prompt", json!({"agentId": TICKET_AGENT, "sessionId": SESSION}))
        .await;
    assert_eq!(cancelled["ok"], true, "{cancelled}");
    assert!(!outstanding(&host, "perm-1"));
    assert!(!question_outstanding(&host, "q-1"));
    let late = respond(&mut conn, "r1", "perm-1").await;
    assert_eq!(late["err"]["code"], "already_resolved", "{late}");
    let late_queued = respond(&mut conn, "r2", "perm-queued").await;
    assert_eq!(late_queued["err"]["code"], "already_resolved", "{late_queued}");
    assert!(outstanding(&host, "perm-other"), "another session keeps its ticket");

    let killed = conn.request("k1", "kill_agent", json!({"agentId": TICKET_AGENT})).await;
    assert_eq!(killed["ok"], true, "{killed}");
    assert!(!outstanding(&host, "perm-other"), "a kill releases every ticket of the agent");
    let late_other = respond(&mut conn, "r3", "perm-other").await;
    assert_eq!(late_other["err"]["code"], "already_resolved", "{late_other}");
}
