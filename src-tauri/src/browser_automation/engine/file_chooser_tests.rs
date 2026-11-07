use std::path::PathBuf;

use serde_json::json;
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

#[test]
fn an_upload_lands_once_the_input_holds_the_files() {
    assert_eq!(upload_landed(&json!(1), 1, false), Ok(true));
    assert_eq!(
        upload_landed(&json!(0), 1, false),
        Ok(false),
        "not filled yet"
    );
}

#[test]
fn an_upload_the_page_cleared_in_its_change_handler_still_landed() {
    assert_eq!(upload_landed(&json!(0), 1, true), Ok(true));
}

#[test]
fn an_upload_lands_when_the_page_replaced_the_input_after_its_change() {
    assert_eq!(upload_landed(&json!(-1), 1, true), Ok(true));
}

#[test]
fn a_path_that_names_no_file_input_and_heard_nothing_fails() {
    assert_eq!(
        upload_landed(&json!(-1), 1, false).map_err(|e| e.kind),
        Err(EngineErrorKind::PageException)
    );
    assert_eq!(
        upload_landed(&json!(null), 1, false).map_err(|e| e.kind),
        Err(EngineErrorKind::PageException)
    );
}

#[test]
fn a_replaced_input_waits_for_the_watch_until_the_deadline() {
    assert_eq!(
        settle_poll(&json!(-1), 1, false, false),
        Ok(false),
        "the watch may not have answered yet"
    );
    assert_eq!(
        settle_poll(&json!(-1), 1, true, false),
        Ok(true),
        "a trusted change arrived while waiting"
    );
    assert_eq!(
        settle_poll(&json!(-1), 1, true, true),
        Ok(true),
        "heard on the last poll"
    );
    assert_eq!(
        settle_poll(&json!(-1), 1, false, true).map_err(|e| e.kind),
        Err(EngineErrorKind::PageException)
    );
}

#[test]
fn files_that_never_arrive_time_out_only_at_the_deadline() {
    assert_eq!(settle_poll(&json!(0), 1, false, false), Ok(false));
    assert_eq!(
        settle_poll(&json!(0), 1, false, true).map_err(|e| e.kind),
        Err(EngineErrorKind::Timeout)
    );
    assert_eq!(settle_poll(&json!(1), 1, false, true), Ok(true));
}

#[test]
fn only_a_watch_that_saw_the_input_change_counts() {
    let (tx, mut rx) = oneshot::channel();
    assert!(!heard_change(&mut rx), "still watching");
    tx.send(Ok("true".to_string())).unwrap();
    assert!(heard_change(&mut rx));

    let (tx, mut rx) = oneshot::channel();
    tx.send(Ok("false".to_string())).unwrap();
    assert!(!heard_change(&mut rx), "the watch ran out");

    let (tx, mut rx) = oneshot::channel();
    tx.send(Err(EngineErrorKind::PageException)).unwrap();
    assert!(!heard_change(&mut rx), "the watch failed");

    let (tx, mut rx) = oneshot::channel::<CallResult>();
    drop(tx);
    assert!(!heard_change(&mut rx), "the watch was never issued");
}
