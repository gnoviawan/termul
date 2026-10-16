use std::collections::BTreeMap;

use super::*;

fn head(log_epoch: &str, head_seq: u64) -> LogHead {
    LogHead {
        log_epoch: log_epoch.to_string(),
        head_seq,
    }
}

#[test]
fn a_marker_only_moves_forward_within_one_log_epoch() {
    let reads = ChatReads::default();
    assert_eq!(reads.mark("s1", &head("e1", 40), 12), MarkOutcome::Moved(12));
    assert_eq!(reads.mark("s1", &head("e1", 40), 30), MarkOutcome::Moved(30));
    assert_eq!(reads.mark("s1", &head("e1", 40), 18), MarkOutcome::Unchanged(30));
    assert_eq!(reads.mark("s1", &head("e1", 40), 30), MarkOutcome::Unchanged(30));
    assert_eq!(reads.seq("s1"), Some(30));
}

#[test]
fn a_marker_never_passes_the_log_head() {
    let reads = ChatReads::default();
    assert_eq!(reads.mark("s1", &head("e1", 7), 900), MarkOutcome::Moved(7));
    assert_eq!(reads.seq("s1"), Some(7));
}

#[test]
fn a_new_log_epoch_replaces_the_marker_even_when_it_is_lower() {
    let reads = ChatReads::default();
    reads.mark("s1", &head("e1", 50), 50);
    assert_eq!(reads.mark("s1", &head("e2", 4), 3), MarkOutcome::Moved(3));
    assert_eq!(reads.seq("s1"), Some(3));
}

#[test]
fn the_snapshot_lists_every_session_marker() {
    let reads = ChatReads::default();
    reads.mark("b", &head("e", 9), 9);
    reads.mark("a", &head("e", 5), 2);
    assert_eq!(
        reads.snapshot(),
        BTreeMap::from([("a".to_string(), 2), ("b".to_string(), 9)])
    );
    assert_eq!(reads.seq("unknown"), None);
}
