use serde_json::json;

use super::*;

const SID: &str = "s1";

fn end(seq: u64) -> TurnEnd {
    TurnEnd {
        log_epoch: "e1".to_string(),
        seq,
    }
}

fn mark(seq: u64) -> ReadMark {
    ReadMark {
        log_epoch: "e1".to_string(),
        seq,
    }
}

fn no_inputs() -> ActivityInputs {
    inputs(false, None)
}

fn inputs(needs_you: bool, read: Option<ReadMark>) -> ActivityInputs {
    ActivityInputs {
        needs_you,
        read,
        log_epoch: Some("e1".to_string()),
    }
}

fn opened() -> ActivityEvent {
    ActivityEvent::TurnOpened {
        agent_id: Some("a1".to_string()),
    }
}

#[test]
fn a_turn_is_busy_until_it_ends_unread() {
    let table = ChatActivities::default();
    let busy = table.observe(SID, 1, opened(), no_inputs).expect("changed");
    assert!(busy.busy && !busy.unread);

    let ended = table
        .observe(SID, 7, ActivityEvent::TurnEnded, no_inputs)
        .expect("changed");
    assert_eq!(
        ended,
        ChatActivity {
            busy: false,
            needs_you: false,
            unread: true,
            turn_end: Some(end(7)),
        }
    );
}

#[test]
fn a_read_marker_at_the_turn_end_clears_unread_and_an_older_one_does_not() {
    let table = ChatActivities::default();
    table.observe(SID, 7, ActivityEvent::TurnEnded, no_inputs);

    assert_eq!(
        table.refresh(SID, || inputs(false, Some(mark(6)))),
        None,
        "still unread"
    );
    let read = table
        .refresh(SID, || inputs(false, Some(mark(7))))
        .expect("changed");
    assert!(!read.unread);
    assert!(table.snapshot().is_empty(), "a read chat leaves the state");
    assert_eq!(table.get(SID), ChatActivity::default());
}

#[test]
fn a_read_marker_of_another_epoch_leaves_the_turn_end_unread() {
    let table = ChatActivities::default();
    table.observe(SID, 7, ActivityEvent::TurnEnded, no_inputs);
    let other_epoch = ReadMark {
        log_epoch: "e0".to_string(),
        seq: 99,
    };
    assert_eq!(
        table.refresh(SID, || inputs(false, Some(other_epoch))),
        None,
        "still unread"
    );
    assert!(table.get(SID).unread);
}

#[test]
fn an_unchanged_record_is_not_reported() {
    let table = ChatActivities::default();
    table.observe(SID, 1, opened(), no_inputs);
    assert_eq!(table.observe(SID, 2, opened(), no_inputs), None);
}

#[test]
fn closing_or_the_agent_dying_ends_the_work() {
    let table = ChatActivities::default();
    table.observe(
        SID,
        1,
        ActivityEvent::Working {
            agent_id: Some("a1".to_string()),
            working: true,
        },
        no_inputs,
    );
    assert!(table.get(SID).busy);
    assert_eq!(
        table.observe(SID, 2, ActivityEvent::Closed, no_inputs),
        Some(ChatActivity::default())
    );
    assert!(table.snapshot().is_empty(), "an idle chat leaves the state");

    table.observe(SID, 3, opened(), no_inputs);
    table.observe("s2", 1, opened(), no_inputs);
    table.observe(
        "other-agent",
        1,
        ActivityEvent::TurnOpened {
            agent_id: Some("a2".to_string()),
        },
        no_inputs,
    );
    let mut sessions = table.agent_ended("a1");
    sessions.sort();
    assert_eq!(sessions, vec![SID.to_string(), "s2".to_string()]);
    for sid in &sessions {
        table.refresh(sid, no_inputs);
    }
    assert!(!table.get(SID).busy && !table.get("s2").busy);
    assert!(
        table.get("other-agent").busy,
        "another agent's chat works on"
    );
}

/// A resumed chat's new owner starts unprompted work; the previous agent's
/// quiet sweep must not clear Working or reclaim ownership.
#[test]
fn stale_working_false_from_another_agent_is_ignored() {
    let table = ChatActivities::default();
    table.observe(
        SID,
        1,
        ActivityEvent::Working {
            agent_id: Some("a1".to_string()),
            working: true,
        },
        no_inputs,
    );
    // New owner takes over with unprompted work.
    table.observe(
        SID,
        2,
        ActivityEvent::Working {
            agent_id: Some("a2".to_string()),
            working: true,
        },
        no_inputs,
    );
    assert!(table.get(SID).busy);

    // Previous agent's quiet sweep arrives later — ignore it.
    assert_eq!(
        table.observe(
            SID,
            3,
            ActivityEvent::Working {
                agent_id: Some("a1".to_string()),
                working: false,
            },
            no_inputs,
        ),
        None,
        "stale clear must not change the record"
    );
    assert!(table.get(SID).busy, "new owner's Working stays");

    // Current owner clearing still works.
    let cleared = table
        .observe(
            SID,
            4,
            ActivityEvent::Working {
                agent_id: Some("a2".to_string()),
                working: false,
            },
            no_inputs,
        )
        .expect("changed");
    assert!(!cleared.busy);
}

#[test]
fn needs_you_follows_the_pending_prompts() {
    let table = ChatActivities::default();
    let raised = table
        .observe(SID, 1, ActivityEvent::Prompt { agent_id: None }, || {
            inputs(true, None)
        })
        .expect("changed");
    assert!(raised.needs_you);
    assert_eq!(table.needing_you(), vec![SID.to_string()]);
    assert_eq!(table.refresh(SID, no_inputs), Some(ChatActivity::default()));
    assert!(table.needing_you().is_empty());
}

#[test]
fn the_wire_record_names_every_field() {
    let activity = ChatActivity {
        busy: false,
        needs_you: true,
        unread: true,
        turn_end: Some(end(3)),
    };
    assert_eq!(
        activity.to_wire(SID),
        json!({
            "sessionId": SID,
            "busy": false,
            "needsYou": true,
            "unread": true,
            "turnEnd": { "seq": 3, "logEpoch": "e1" },
        })
    );
    assert_eq!(ChatActivity::default().to_record()["turnEnd"], json!(null));
}

#[test]
fn forgetting_reports_whether_anything_was_shown() {
    let table = ChatActivities::default();
    table.observe(SID, 1, opened(), no_inputs);
    assert!(table.forget(SID));
    assert!(!table.forget(SID));
    assert_eq!(table.get(SID), ChatActivity::default());
    assert_eq!(
        table.observe(SID, 2, ActivityEvent::TurnEnded, no_inputs),
        None,
        "a deleted chat takes no more events"
    );
    assert!(table.snapshot().is_empty());
}

/// The agent's first turn can end before persistence registers the session,
/// under a placeholder log epoch. Once registered, the turn end stands under
/// the persisted epoch, so a surface reading it there clears the dot.
#[tokio::test]
async fn a_turn_end_before_registration_is_read_under_the_persisted_epoch() {
    use crate::acp::session_persistence::{SessionPersistence, SessionRegistration};
    use crate::web::sink::{AcpEvent, EventSink, WsRelaySink};

    let root = std::env::temp_dir().join(format!("termul-activity-epoch-{}", uuid::Uuid::new_v4()));
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let persistence = SessionPersistence::open(root.join("sessions"))
        .await
        .unwrap();
    let relay = WsRelaySink::with_persistence(64, persistence.clone());
    relay.emit(&AcpEvent {
        sid: Some(SID.to_string()),
        type_: "acp:prompt_complete",
        payload: json!({ "sessionId": SID, "stopReason": "end_turn" }),
    });
    persistence
        .register_session(SessionRegistration {
            session_id: SID.to_string(),
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    relay.note_session_registered_inherent(SID);

    let persisted = persistence.log_epoch(SID).expect("minted at registration");
    let turn_end = relay.chat_activity().get(SID).turn_end.expect("unread");
    assert_eq!(
        turn_end,
        TurnEnd {
            log_epoch: persisted,
            seq: 1
        }
    );
    let head = relay.log_head(SID).expect("head");
    relay
        .chat_reads()
        .mark(SID, &head, Some(&turn_end.log_epoch), turn_end.seq);
    relay.refresh_chat_activity(SID);
    assert!(!relay.chat_activity().get(SID).unread);
    let _ = std::fs::remove_dir_all(&root);
}

/// Two threads can observe one session's events out of seq order: a turn end
/// numbered before the next turn opened must not close that turn.
#[test]
fn an_event_older_than_the_last_applied_one_is_ignored() {
    let table = ChatActivities::default();
    table.observe(SID, 6, opened(), no_inputs);

    assert_eq!(
        table.observe(SID, 5, ActivityEvent::TurnEnded, no_inputs),
        None
    );
    assert!(table.get(SID).busy, "the newer turn is still open");
}

fn working(agent: &str, working: bool) -> ActivityEvent {
    ActivityEvent::Working {
        agent_id: Some(agent.to_string()),
        working,
    }
}

/// A chat resumed on another live agent: the previous agent can still report
/// its own work on the chat ended. That must not end the new agent's work.
#[test]
fn the_previous_agent_ending_its_work_leaves_the_new_agents_work_on() {
    let table = ChatActivities::default();
    table.observe(SID, 1, working("a1", true), no_inputs);
    table.observe(SID, 2, working("a2", true), no_inputs);

    assert_eq!(table.observe(SID, 3, working("a1", false), no_inputs), None);
    assert!(table.get(SID).busy, "a2 still works");
    assert!(table.agent_ended("a1").is_empty(), "a2 owns the chat");

    let idle = table.observe(SID, 4, working("a2", false), no_inputs);
    assert_eq!(idle, Some(ChatActivity::default()));
}

/// The agent a chat moves to owns it: the previous agent's work outside a
/// turn ended with the move, and its late prompts do not take the chat back.
#[test]
fn a_new_agent_opening_a_turn_takes_the_chat_over() {
    let table = ChatActivities::default();
    table.observe(SID, 1, working("a1", true), no_inputs);
    table.observe(
        SID,
        2,
        ActivityEvent::TurnOpened {
            agent_id: Some("a2".to_string()),
        },
        no_inputs,
    );
    table.observe(
        SID,
        3,
        ActivityEvent::Prompt {
            agent_id: Some("a1".to_string()),
        },
        no_inputs,
    );

    let ended = table
        .observe(SID, 4, ActivityEvent::TurnEnded, no_inputs)
        .expect("changed");
    assert!(!ended.busy, "a1's work did not outlive the move");
    assert_eq!(table.agent_ended("a1"), Vec::<String>::new());
    assert_eq!(table.agent_ended("a2"), vec![SID.to_string()]);
}
