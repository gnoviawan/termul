use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;

use super::{
    autosave_delay, document_loaded, parse_version, read_document, write_snapshot,
    CanvasPersistence, DirtyOutcome, CODE_CANVAS_NOT_READY, CODE_INVALID_PAYLOAD,
};
use crate::canvas::{CODE_CANVAS_CLOSED, CODE_PATH_VALIDATION_FAILED};

const PROJECT: &str = "project-persist";
const DEBOUNCE: Duration = Duration::from_millis(1500);

fn doc_in(dir: &tempfile::TempDir) -> PathBuf {
    dir.path().join("design.figcraft")
}

fn mounted(path: PathBuf) -> (CanvasPersistence, u64) {
    let mounts = CanvasPersistence::default();
    let seq = mounts.mount(PROJECT, path, DEBOUNCE);
    (mounts, seq)
}

fn snapshot_text(content_version: u64, bytes: &[u8]) -> String {
    format!(
        r#"{{"contentVersion":{content_version},"bytes":"{}"}}"#,
        BASE64.encode(bytes)
    )
}

fn version(text: Option<&str>) -> Option<String> {
    text.map(str::to_string)
}

#[test]
fn autosave_delay_defaults_to_1500ms_and_clamps() {
    assert_eq!(autosave_delay(None), Duration::from_millis(1500));
    assert_eq!(autosave_delay(Some(10)), Duration::from_millis(100));
    assert_eq!(
        autosave_delay(Some(3_600_000)),
        Duration::from_millis(60_000)
    );
    assert_eq!(autosave_delay(Some(2500)), Duration::from_millis(2500));
}

#[tokio::test(start_paused = true)]
async fn a_burst_of_edits_coalesces_into_one_save_after_the_debounce() {
    let dir = tempfile::tempdir().unwrap();
    let (mounts, seq) = mounted(doc_in(&dir));
    let mounts = Arc::new(mounts);
    mounts.document_loaded(PROJECT, seq, Some(1)).unwrap();

    let notify = |cv: u64| {
        let mounts = mounts.clone();
        tokio::spawn(async move { mounts.dirty_changed(PROJECT, seq, true, cv).await })
    };
    let first = notify(2);
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(500)).await;
    let second = notify(3);
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(500)).await;
    let last = notify(4);
    tokio::task::yield_now().await;

    assert_eq!(first.await.unwrap().unwrap(), DirtyOutcome::Superseded);
    assert_eq!(second.await.unwrap().unwrap(), DirtyOutcome::Superseded);

    tokio::time::advance(Duration::from_millis(1499)).await;
    tokio::task::yield_now().await;
    assert!(!last.is_finished(), "the save waits out the full debounce");
    tokio::time::advance(Duration::from_millis(1)).await;
    match last.await.unwrap().unwrap() {
        DirtyOutcome::SaveDue { view } => {
            assert!(view.dirty);
            assert_eq!(view.content_version, version(Some("4")));
            assert_eq!(view.saved_version, version(Some("1")));
        }
        other => panic!("expected SaveDue, got {other:?}"),
    }
}

#[tokio::test(start_paused = true)]
async fn a_clean_notification_is_idle_at_once_and_cancels_a_pending_save() {
    let dir = tempfile::tempdir().unwrap();
    let (mounts, seq) = mounted(doc_in(&dir));
    let mounts = Arc::new(mounts);
    mounts.document_loaded(PROJECT, seq, Some(1)).unwrap();
    let pending = {
        let mounts = mounts.clone();
        tokio::spawn(async move { mounts.dirty_changed(PROJECT, seq, true, 2).await })
    };
    tokio::task::yield_now().await;
    let clean = mounts.dirty_changed(PROJECT, seq, false, 2).await.unwrap();
    assert!(matches!(clean, DirtyOutcome::Idle { ref view } if !view.dirty));
    assert_eq!(pending.await.unwrap().unwrap(), DirtyOutcome::Superseded);
}

#[tokio::test(start_paused = true)]
async fn nothing_is_dirty_or_written_before_the_document_loaded() {
    let dir = tempfile::tempdir().unwrap();
    let path = doc_in(&dir);
    let (mounts, seq) = mounted(path.clone());

    let outcome = mounts.dirty_changed(PROJECT, seq, true, 7).await.unwrap();
    match outcome {
        DirtyOutcome::Idle { view } => {
            assert!(!view.ready);
            assert!(!view.dirty, "dirty cannot be set before ready");
            assert_eq!(view.content_version, None);
        }
        other => panic!("expected Idle while loading, got {other:?}"),
    }
    let refused = mounts
        .write_snapshot(PROJECT, seq, 7, b"early".to_vec())
        .await
        .unwrap_err();
    assert_eq!(refused.code, CODE_CANVAS_NOT_READY);
    assert!(!path.exists(), "no save before ready");
}

#[tokio::test]
async fn a_write_replaces_the_document_atomically_and_advances_the_saved_version() {
    let dir = tempfile::tempdir().unwrap();
    let path = doc_in(&dir);
    std::fs::write(&path, b"old document").unwrap();
    let (mounts, seq) = mounted(path.clone());
    mounts.document_loaded(PROJECT, seq, Some(3)).unwrap();
    mounts.dirty_changed(PROJECT, seq, true, 4).await.unwrap();

    let outcome = mounts
        .write_snapshot(PROJECT, seq, 4, b"new document".to_vec())
        .await
        .unwrap();
    assert_eq!(outcome.mark_saved, version(Some("4")));
    assert_eq!(outcome.view.saved_version, version(Some("4")));
    assert_eq!(outcome.view.save_error, None);
    assert_eq!(std::fs::read(&path).unwrap(), b"new document");
    let leftovers: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(leftovers, vec![std::ffi::OsString::from("design.figcraft")]);
}

#[tokio::test]
async fn the_first_save_of_a_new_document_creates_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = doc_in(&dir);
    let (mounts, seq) = mounted(path.clone());
    let view = mounts.document_loaded(PROJECT, seq, None).unwrap();
    assert!(view.ready);
    assert_eq!(view.saved_version, None);
    mounts.dirty_changed(PROJECT, seq, true, 2).await.unwrap();
    let outcome = mounts
        .write_snapshot(PROJECT, seq, 2, b"fresh".to_vec())
        .await
        .unwrap();
    assert_eq!(outcome.mark_saved, version(Some("2")));
    assert_eq!(std::fs::read(&path).unwrap(), b"fresh");
}

fn failing_write(_: &Path, _: &[u8]) -> std::io::Result<()> {
    Err(std::io::Error::other("disk full"))
}

#[tokio::test(start_paused = true)]
async fn a_failed_write_keeps_the_saved_version_and_the_save_due() {
    let dir = tempfile::tempdir().unwrap();
    let mounts = CanvasPersistence::with_writer(failing_write);
    let seq = mounts.mount(PROJECT, doc_in(&dir), DEBOUNCE);
    mounts.document_loaded(PROJECT, seq, Some(1)).unwrap();
    let due = mounts.dirty_changed(PROJECT, seq, true, 2).await.unwrap();
    assert!(matches!(due, DirtyOutcome::SaveDue { .. }));

    let outcome = mounts
        .write_snapshot(PROJECT, seq, 2, b"lost".to_vec())
        .await
        .unwrap();
    assert_eq!(outcome.mark_saved, None, "the editor is not told it saved");
    assert_eq!(outcome.view.saved_version, version(Some("1")));
    assert!(outcome
        .view
        .save_error
        .as_deref()
        .is_some_and(|error| error.contains("disk full")));
    assert!(outcome.view.dirty);
}

#[tokio::test]
async fn a_failed_real_write_leaves_the_saved_version() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("missing-dir").join("design.figcraft");
    let (mounts, seq) = mounted(path.clone());
    mounts.document_loaded(PROJECT, seq, Some(5)).unwrap();
    let outcome = mounts
        .write_snapshot(PROJECT, seq, 6, b"nowhere".to_vec())
        .await
        .unwrap();
    assert_eq!(outcome.mark_saved, None);
    assert_eq!(outcome.view.saved_version, version(Some("5")));
    assert!(outcome.view.save_error.is_some());
    assert!(!path.exists());
}

static COUNTED_WRITES: AtomicUsize = AtomicUsize::new(0);

fn counting_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    COUNTED_WRITES.fetch_add(1, Ordering::SeqCst);
    std::fs::write(path, bytes)
}

#[tokio::test]
async fn a_snapshot_older_than_the_saved_version_is_not_written() {
    let dir = tempfile::tempdir().unwrap();
    let mounts = CanvasPersistence::with_writer(counting_write);
    let seq = mounts.mount(PROJECT, doc_in(&dir), DEBOUNCE);
    mounts.document_loaded(PROJECT, seq, Some(5)).unwrap();
    let before = COUNTED_WRITES.load(Ordering::SeqCst);
    let outcome = mounts
        .write_snapshot(PROJECT, seq, 4, b"older".to_vec())
        .await
        .unwrap();
    assert_eq!(outcome.mark_saved, None);
    assert_eq!(outcome.view.saved_version, version(Some("5")));
    assert_eq!(COUNTED_WRITES.load(Ordering::SeqCst), before);
}

#[tokio::test]
async fn only_figcraft_documents_are_written() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("notes.txt");
    let (mounts, seq) = mounted(path.clone());
    mounts.document_loaded(PROJECT, seq, None).unwrap();
    let refused = mounts
        .write_snapshot(PROJECT, seq, 1, b"x".to_vec())
        .await
        .unwrap_err();
    assert_eq!(refused.code, CODE_PATH_VALIDATION_FAILED);
    assert!(!path.exists());
}

#[tokio::test(start_paused = true)]
async fn a_stale_mount_seq_is_closed_and_unmount_supersedes_the_debounce() {
    let dir = tempfile::tempdir().unwrap();
    let (mounts, seq) = mounted(doc_in(&dir));
    let mounts = Arc::new(mounts);
    mounts.document_loaded(PROJECT, seq, Some(1)).unwrap();
    assert_eq!(
        mounts.view(PROJECT, seq + 1).unwrap_err().code,
        CODE_CANVAS_CLOSED
    );
    let pending = {
        let mounts = mounts.clone();
        tokio::spawn(async move { mounts.dirty_changed(PROJECT, seq, true, 2).await })
    };
    tokio::task::yield_now().await;
    mounts.unmount(PROJECT);
    assert_eq!(pending.await.unwrap().unwrap(), DirtyOutcome::Superseded);
    assert_eq!(
        mounts.view(PROJECT, seq).unwrap_err().code,
        CODE_CANVAS_CLOSED
    );
    mounts.unmount(PROJECT);
}

#[tokio::test]
async fn a_remount_gets_a_new_mount_seq_and_starts_loading() {
    let dir = tempfile::tempdir().unwrap();
    let (mounts, first) = mounted(doc_in(&dir));
    mounts.document_loaded(PROJECT, first, Some(9)).unwrap();
    let second = mounts.mount(PROJECT, doc_in(&dir), DEBOUNCE);
    assert!(second > first);
    assert!(!mounts.view(PROJECT, second).unwrap().ready);
    assert_eq!(
        mounts.view(PROJECT, first).unwrap_err().code,
        CODE_CANVAS_CLOSED
    );
}

#[tokio::test]
async fn read_document_returns_base64_or_none_for_a_new_document() {
    let dir = tempfile::tempdir().unwrap();
    let path = doc_in(&dir);
    let (mounts, seq) = mounted(path.clone());
    assert_eq!(
        read_document(&mounts, PROJECT, seq).await.unwrap().bytes,
        None
    );
    std::fs::write(&path, [0u8, 1, 2, 255]).unwrap();
    let read = read_document(&mounts, PROJECT, seq).await.unwrap();
    assert_eq!(read.bytes, Some(BASE64.encode([0u8, 1, 2, 255])));
}

#[tokio::test]
async fn wire_versions_above_2_pow_53_survive_as_text() {
    let dir = tempfile::tempdir().unwrap();
    let path = doc_in(&dir);
    let (mounts, seq) = mounted(path.clone());
    let huge: u64 = (1 << 53) + 1;
    let view = document_loaded(
        &mounts,
        PROJECT,
        seq,
        Some(&format!(r#"{{"contentVersion":{huge}}}"#)),
    )
    .unwrap();
    assert_eq!(view.saved_version, Some("9007199254740993".to_string()));
    assert_eq!(parse_version("9007199254740993").unwrap(), huge);

    let outcome = write_snapshot(&mounts, PROJECT, seq, &snapshot_text(huge + 1, b"doc"))
        .await
        .unwrap();
    assert_eq!(outcome.mark_saved, Some("9007199254740994".to_string()));
    assert_eq!(std::fs::read(&path).unwrap(), b"doc");
}

#[tokio::test]
async fn malformed_wire_payloads_are_typed() {
    let dir = tempfile::tempdir().unwrap();
    let (mounts, seq) = mounted(doc_in(&dir));
    assert_eq!(
        parse_version("12.5").unwrap_err().code,
        CODE_INVALID_PAYLOAD
    );
    assert_eq!(
        document_loaded(&mounts, PROJECT, seq, Some("{}"))
            .unwrap_err()
            .code,
        CODE_INVALID_PAYLOAD
    );
    mounts.document_loaded(PROJECT, seq, None).unwrap();
    for bad in [
        "not json",
        r#"{"contentVersion":1}"#,
        r#"{"contentVersion":1,"bytes":"%%%"}"#,
    ] {
        assert_eq!(
            write_snapshot(&mounts, PROJECT, seq, bad)
                .await
                .unwrap_err()
                .code,
            CODE_INVALID_PAYLOAD,
            "{bad}"
        );
    }
}
