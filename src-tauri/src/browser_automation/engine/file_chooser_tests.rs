use std::path::PathBuf;

use tokio::sync::oneshot;

use super::*;

#[test]
fn a_chooser_with_nothing_staged_is_cancelled() {
    assert_eq!(answer("agent-none"), None);
}

#[test]
fn staged_files_answer_one_chooser_and_tell_the_upload() {
    let (tx, mut rx) = oneshot::channel();
    stage("agent-a", vec![PathBuf::from("/staging/report.pdf")], tx);
    assert_eq!(answer("agent-b"), None, "another tab's chooser");
    assert_eq!(
        answer("agent-a"),
        Some(vec![PathBuf::from("/staging/report.pdf")])
    );
    assert_eq!(rx.try_recv(), Ok(()));
    assert_eq!(answer("agent-a"), None, "a second chooser is cancelled");
}

#[test]
fn releasing_a_tab_drops_its_staged_files_and_closes_the_wait() {
    let (tx, mut rx) = oneshot::channel();
    stage("agent-c", vec![PathBuf::from("/staging/a.txt")], tx);
    release_tab("agent-c");
    assert_eq!(answer("agent-c"), None);
    assert_eq!(rx.try_recv(), Err(oneshot::error::TryRecvError::Closed));
}

#[test]
fn a_new_staging_replaces_the_earlier_one() {
    let (first, mut first_rx) = oneshot::channel();
    let (second, mut second_rx) = oneshot::channel();
    stage("agent-d", vec![PathBuf::from("/staging/old.txt")], first);
    stage("agent-d", vec![PathBuf::from("/staging/new.txt")], second);
    assert_eq!(
        first_rx.try_recv(),
        Err(oneshot::error::TryRecvError::Closed)
    );
    assert_eq!(
        answer("agent-d"),
        Some(vec![PathBuf::from("/staging/new.txt")])
    );
    assert_eq!(second_rx.try_recv(), Ok(()));
}
