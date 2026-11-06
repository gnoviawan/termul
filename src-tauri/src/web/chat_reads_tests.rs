use super::*;

fn head(log_epoch: &str, head_seq: u64) -> LogHead {
    LogHead {
        log_epoch: log_epoch.to_string(),
        head_seq,
    }
}

fn read(log_epoch: &str, seq: u64) -> ReadMark {
    ReadMark {
        log_epoch: log_epoch.to_string(),
        seq,
    }
}

#[test]
fn a_marker_only_moves_forward_within_one_log_epoch() {
    let reads = ChatReads::default();
    let e1 = head("e1", 40);
    assert_eq!(reads.mark("s1", &e1, Some("e1"), 12), MarkOutcome::Moved(read("e1", 12)));
    assert_eq!(reads.mark("s1", &e1, Some("e1"), 30), MarkOutcome::Moved(read("e1", 30)));
    assert_eq!(reads.mark("s1", &e1, Some("e1"), 18), MarkOutcome::Unchanged(read("e1", 30)));
    assert_eq!(reads.mark("s1", &e1, None, 30), MarkOutcome::Unchanged(read("e1", 30)));
    assert_eq!(reads.get("s1"), Some(read("e1", 30)));
}

#[test]
fn a_marker_never_passes_the_log_head() {
    let reads = ChatReads::default();
    let moved = reads.mark("s1", &head("e1", 7), Some("e1"), 900);
    assert_eq!(moved, MarkOutcome::Moved(read("e1", 7)));
    assert_eq!(reads.mark("s1", &head("e1", 9), None, 900), MarkOutcome::Moved(read("e1", 9)));
    assert_eq!(reads.get("s1"), Some(read("e1", 9)));
}

#[test]
fn a_new_log_epoch_replaces_the_marker_even_when_it_is_lower() {
    let reads = ChatReads::default();
    reads.mark("s1", &head("e1", 50), Some("e1"), 50);
    assert_eq!(reads.mark("s1", &head("e2", 4), Some("e2"), 3), MarkOutcome::Moved(read("e2", 3)));
    assert_eq!(reads.get("s1"), Some(read("e2", 3)));
}

#[test]
fn a_read_from_another_log_epoch_never_moves_the_marker() {
    let reads = ChatReads::default();
    let e2 = head("e2", 40);
    assert_eq!(reads.mark("s1", &e2, Some("e1"), 900), MarkOutcome::OtherEpoch(read("e2", 0)));
    assert_eq!(reads.get("s1"), None);

    reads.mark("s1", &e2, Some("e2"), 3);
    assert_eq!(reads.mark("s1", &e2, Some("e1"), 50), MarkOutcome::OtherEpoch(read("e2", 3)));
    assert_eq!(reads.get("s1"), Some(read("e2", 3)));
}
