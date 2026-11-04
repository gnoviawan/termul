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

fn no_inputs() -> (bool, Option<ReadMark>) {
    (false, None)
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
        .observe(
            SID,
            7,
            ActivityEvent::TurnEnded { end: Some(end(7)) },
            no_inputs,
        )
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
    table.observe(
        SID,
        7,
        ActivityEvent::TurnEnded { end: Some(end(7)) },
        no_inputs,
    );

    assert_eq!(
        table.refresh(SID, || (false, Some(mark(6)))),
        None,
        "still unread"
    );
    let read = table
        .refresh(SID, || (false, Some(mark(7))))
        .expect("changed");
    assert!(!read.unread);
    let other_epoch = ReadMark {
        log_epoch: "e0".to_string(),
        seq: 99,
    };
    assert!(
        table
            .refresh(SID, || (false, Some(other_epoch)))
            .expect("changed")
            .unread
    );
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
    let mut sessions = table.agent_ended("a1");
    sessions.sort();
    assert_eq!(sessions, vec![SID.to_string(), "s2".to_string()]);
    for sid in &sessions {
        table.refresh(sid, no_inputs);
    }
    assert!(!table.get(SID).busy && !table.get("s2").busy);
}

#[test]
fn needs_you_follows_the_pending_prompts() {
    let table = ChatActivities::default();
    let raised = table
        .observe(SID, 1, ActivityEvent::Prompt { agent_id: None }, || {
            (true, None)
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
}

/// Two threads can observe one session's events out of seq order: a turn end
/// numbered before the next turn opened must not close that turn.
#[test]
fn an_event_older_than_the_last_applied_one_is_ignored() {
    let table = ChatActivities::default();
    table.observe(SID, 6, opened(), no_inputs);

    assert_eq!(
        table.observe(
            SID,
            5,
            ActivityEvent::TurnEnded { end: Some(end(5)) },
            no_inputs
        ),
        None
    );
    assert!(table.get(SID).busy, "the newer turn is still open");
}
