use super::super::tools::new_entry;
use super::super::{SubagentCaps, SubagentEndReason, SubagentState, SubagentTranscript};
use super::*;

const CAPS: SubagentCaps = SubagentCaps {
    stop: None,
    transcript: SubagentTranscript::Final,
    live_progress: false,
    usage: false,
};

fn add(records: &mut SubagentRecords, root: &str, call: &str, ended: bool) -> Option<Subagent> {
    records.upsert(
        root,
        call,
        || new_entry(root, call, SubagentSource::ToolHeuristic, CAPS, 1),
        |entry| {
            if ended {
                entry
                    .record
                    .set_state(SubagentState::idle(SubagentEndReason::Completed), 2);
            }
        },
    )
}

#[test]
fn upsert_reports_only_a_new_or_changed_record() {
    let mut records = SubagentRecords::default();
    assert!(add(&mut records, "chat", "a", false).is_some());
    assert!(add(&mut records, "chat", "a", false).is_none());
    let ended = add(&mut records, "chat", "a", true).expect("the end is a change");
    assert_eq!(ended.ended_at, Some(2));
    assert_eq!(records.record("chat", "a"), Some(&ended));
    assert!(records.record("other", "a").is_none(), "records are per chat");
}

#[test]
fn a_full_registry_evicts_the_oldest_settled_record_first() {
    let mut records = SubagentRecords::default();
    add(&mut records, "chat", "running-0", false);
    add(&mut records, "chat", "ended-1", true);
    for index in 2..MAX_TRACKED {
        add(&mut records, "chat", &format!("running-{index}"), false);
    }
    assert_eq!(records.len(), MAX_TRACKED);
    add(&mut records, "chat", "newest", false);
    assert_eq!(records.len(), MAX_TRACKED);
    assert!(records.record("chat", "ended-1").is_none());
    assert!(records.record("chat", "running-0").is_some());
    assert!(records.record("chat", "newest").is_some());
}

#[test]
fn forgetting_a_chat_drops_its_records_controls_and_threads() {
    let mut records = SubagentRecords::default();
    add(&mut records, "chat", "a", false);
    add(&mut records, "kept", "b", false);
    records.set_control("chat", "wait-1", SubagentSource::CodexCollab, vec!["a".to_string()]);
    assert!(records.set_codex_thread("chat", "t1", ThreadState::Running));
    assert!(!records.set_codex_thread("chat", "t1", ThreadState::Running));
    records.forget_root("chat");
    assert!(records.get("chat", "a").is_none());
    assert!(records.get("chat", "wait-1").is_none());
    assert!(records.codex_threads("chat").is_none());
    assert!(records.record("kept", "b").is_some());
}
