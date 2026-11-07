//! The AD-31 unmount sequence: quiesce, drain, save, verify, unmount.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use tokio::sync::mpsc;

use super::{CanvasPersistence, CloseMode, DirtyOutcome, ReplyMatch};
use crate::acp::host_mcp::canvas::{CanvasCallFrame, CanvasErrorCode, CanvasHolder};
use crate::canvas::{CODE_CANVAS_CLOSING, CODE_SAVE_FAILED};

const PROJECT: &str = "project-close";
const HOLDER: &str = "conn-1";
const CALL_TIMEOUT: Duration = Duration::from_secs(5);

struct Fixture {
    mounts: Arc<CanvasPersistence>,
    seq: u64,
    doc: PathBuf,
    frames: mpsc::UnboundedReceiver<CanvasCallFrame>,
    _dir: tempfile::TempDir,
}

impl Fixture {
    /// A ready mount whose document is on disk at version `saved`, run by a
    /// renderer connection whose frames the test answers.
    fn ready(saved: u64) -> Self {
        Self::loaded(Some(saved))
    }

    /// A ready mount of a new document: no file, never saved.
    fn new_document() -> Self {
        Self::loaded(None)
    }

    fn loaded(saved: Option<u64>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let doc = dir.path().join("design.figcraft");
        if saved.is_some() {
            std::fs::write(&doc, b"saved").unwrap();
        }
        let mounts = Arc::new(CanvasPersistence::default());
        let seq = mounts.mount(PROJECT, doc.clone(), Duration::from_secs(60));
        mounts.document_loaded(PROJECT, seq, saved).unwrap();
        let (tx, frames) = mpsc::unbounded_channel();
        let holder = CanvasHolder::new(
            HOLDER,
            crate::canvas::persistence::test_renderer(),
            Arc::new(move |frame| tx.send(frame).is_ok()),
        );
        assert!(mounts.attach(PROJECT, seq, holder));
        Self {
            mounts,
            seq,
            doc,
            frames,
            _dir: dir,
        }
    }

    /// Record an edit at `version` the way the renderer forwards it.
    async fn edit(&self, version: u64) -> tokio::task::JoinHandle<DirtyOutcome> {
        let mounts = Arc::clone(&self.mounts);
        let seq = self.seq;
        let waiter = tokio::spawn(async move {
            mounts
                .dirty_changed(PROJECT, seq, true, version)
                .await
                .unwrap()
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        waiter
    }

    fn close(
        &self,
        mode: CloseMode,
    ) -> tokio::task::JoinHandle<Result<super::CloseOutcome, crate::canvas::CanvasError>> {
        let mounts = Arc::clone(&self.mounts);
        tokio::spawn(async move { mounts.close(PROJECT, mode).await })
    }

    fn agent_call(&self) -> tokio::task::JoinHandle<crate::acp::host_mcp::canvas::CanvasOutcome> {
        let mounts = Arc::clone(&self.mounts);
        tokio::spawn(async move {
            mounts
                .call(PROJECT, "node.get", "{}".into(), CALL_TIMEOUT)
                .await
        })
    }

    async fn next(&mut self, method: &str) -> CanvasCallFrame {
        let frame = tokio::time::timeout(Duration::from_secs(2), self.frames.recv())
            .await
            .expect("a frame in time")
            .expect("the connection is open");
        assert_eq!(frame.method, method);
        frame
    }

    fn answer(&self, frame: &CanvasCallFrame, result: &str) {
        assert_eq!(
            self.mounts.reply(
                HOLDER,
                frame.call_id,
                frame.mount_seq,
                Ok(result.to_string())
            ),
            ReplyMatch::Resolved
        );
    }

    /// Answer `host.snapshot` with `bytes` at `version`, then the verify.
    async fn save_round(&mut self, version: u64, bytes: &[u8], verify_dirty: bool) {
        let snapshot = self.next("host.snapshot").await;
        self.answer(
            &snapshot,
            &format!(
                r#"{{"contentVersion":{version},"bytes":"{}"}}"#,
                BASE64.encode(bytes)
            ),
        );
        let verify = self.next("host.markSaved").await;
        assert_eq!(verify.params, format!(r#"{{"contentVersion":{version}}}"#));
        self.answer(
            &verify,
            &format!(r#"{{"dirty":{verify_dirty},"contentVersion":{version}}}"#),
        );
    }
}

#[tokio::test]
async fn a_dirty_mount_is_saved_verified_and_unmounted() {
    let mut fixture = Fixture::ready(1);
    let debounce = fixture.edit(2).await;
    let close = fixture.close(CloseMode::Save);
    fixture.save_round(2, b"edited", false).await;

    let outcome = close.await.unwrap().unwrap();
    assert!(outcome.unmounted);
    assert!(!outcome.discarded);
    assert_eq!(outcome.saved_version.as_deref(), Some("2"));
    assert_eq!(std::fs::read(&fixture.doc).unwrap(), b"edited");
    assert_eq!(debounce.await.unwrap(), DirtyOutcome::Superseded);
    let after = fixture.agent_call().await.unwrap();
    assert_eq!(after.unwrap_err().code, CanvasErrorCode::CanvasClosed);
    assert!(fixture.mounts.mounted_projects().is_empty());
}

#[tokio::test]
async fn quiesce_refuses_new_agent_calls_and_drains_the_ones_in_flight() {
    let mut fixture = Fixture::ready(1);
    let _debounce = fixture.edit(2).await;
    let in_flight = fixture.agent_call();
    let agent_frame = fixture.next("node.get").await;

    let close = fixture.close(CloseMode::Save);
    tokio::time::sleep(Duration::from_millis(50)).await;
    let refused = fixture.agent_call().await.unwrap();
    assert_eq!(refused.unwrap_err().code, CanvasErrorCode::CanvasClosing);
    assert!(
        fixture.frames.try_recv().is_err(),
        "no snapshot while an agent call is still in flight"
    );

    fixture.answer(&agent_frame, r#"{"id":1}"#);
    assert_eq!(in_flight.await.unwrap(), Ok(r#"{"id":1}"#.to_string()));
    fixture.save_round(2, b"edited", false).await;
    assert!(close.await.unwrap().unwrap().unmounted);
}

#[tokio::test]
async fn an_unanswered_presence_lookup_never_holds_up_a_close_by_mount_seq() {
    let mut fixture = Fixture::ready(1);
    let _debounce = fixture.edit(2).await;
    let lookup = {
        let mounts = Arc::clone(&fixture.mounts);
        tokio::spawn(async move {
            mounts
                .presence_call(PROJECT, "node.get", "{}".into(), CALL_TIMEOUT)
                .await
        })
    };
    fixture.next("node.get").await;

    let mounts = Arc::clone(&fixture.mounts);
    let seq = fixture.seq;
    let close =
        tokio::spawn(async move { mounts.close_mount(PROJECT, seq, CloseMode::Save).await });
    let snapshot = fixture.next("host.snapshot").await;
    assert!(
        !fixture
            .mounts
            .presence_notice(PROJECT, "host.guestHide", "{}".into()),
        "no guest notice while the mount closes"
    );
    let refused = fixture
        .mounts
        .presence_call(PROJECT, "node.get", "{}".into(), CALL_TIMEOUT)
        .await;
    assert_eq!(refused.unwrap_err().code, CanvasErrorCode::CanvasClosing);
    fixture.answer(
        &snapshot,
        &format!(
            r#"{{"contentVersion":2,"bytes":"{}"}}"#,
            BASE64.encode(b"edited")
        ),
    );
    let verify = fixture.next("host.markSaved").await;
    fixture.answer(&verify, r#"{"dirty":false,"contentVersion":2}"#);

    assert!(close.await.unwrap().unwrap().unmounted);
    assert!(
        lookup.await.unwrap().is_err(),
        "the lookup ends with the mount"
    );
    assert!(!fixture
        .mounts
        .presence_notice(PROJECT, "host.guestHide", "{}".into()));
}

#[tokio::test]
async fn an_editor_still_dirty_after_the_save_fails_the_verify_and_keeps_the_mount() {
    let mut fixture = Fixture::ready(1);
    let _debounce = fixture.edit(2).await;
    let close = fixture.close(CloseMode::Save);
    fixture.save_round(2, b"edited", true).await;

    let error = close.await.unwrap().unwrap_err();
    assert_eq!(error.code, CODE_SAVE_FAILED);
    assert_eq!(fixture.mounts.mounted_projects(), vec![PROJECT.to_string()]);
    let call = fixture.agent_call();
    let frame = fixture.next("node.get").await;
    fixture.answer(&frame, "{}");
    assert_eq!(
        call.await.unwrap(),
        Ok("{}".to_string()),
        "the mount is open again"
    );
}

#[tokio::test]
async fn a_failed_snapshot_keeps_the_mount_until_the_user_discards() {
    let mut fixture = Fixture::ready(1);
    let _debounce = fixture.edit(2).await;
    let close = fixture.close(CloseMode::Save);
    let snapshot = fixture.next("host.snapshot").await;
    assert_eq!(
        fixture.mounts.reply(
            HOLDER,
            snapshot.call_id,
            snapshot.mount_seq,
            Err(crate::acp::host_mcp::canvas::CanvasError::new(
                CanvasErrorCode::EngineError,
                "boom"
            )),
        ),
        ReplyMatch::Resolved
    );
    let error = close.await.unwrap().unwrap_err();
    assert_eq!(error.code, CODE_SAVE_FAILED);
    assert_eq!(std::fs::read(&fixture.doc).unwrap(), b"saved");

    let outcome = fixture.close(CloseMode::Discard).await.unwrap().unwrap();
    assert!(outcome.unmounted);
    assert!(outcome.discarded);
    assert_eq!(std::fs::read(&fixture.doc).unwrap(), b"saved");
    assert!(
        fixture.frames.try_recv().is_err(),
        "a discard asks the editor nothing"
    );
}

#[tokio::test]
async fn a_dirty_mount_with_no_renderer_cannot_be_saved() {
    let fixture = Fixture::ready(1);
    let _debounce = fixture.edit(2).await;
    let lost = fixture.mounts.release_holder(HOLDER);
    assert_eq!(
        lost.iter()
            .map(|lease| lease.project_id.as_str())
            .collect::<Vec<_>>(),
        vec![PROJECT]
    );
    let error = fixture.close(CloseMode::Save).await.unwrap().unwrap_err();
    assert_eq!(error.code, CODE_SAVE_FAILED);
    assert_eq!(fixture.mounts.mounted_projects(), vec![PROJECT.to_string()]);
}

#[tokio::test]
async fn an_edit_the_host_has_not_heard_of_yet_is_still_saved() {
    let mut fixture = Fixture::ready(1);
    let close = fixture.close(CloseMode::Save);
    let probe = fixture.next("host.markSaved").await;
    assert_eq!(probe.params, r#"{"contentVersion":1}"#);
    fixture.answer(&probe, r#"{"dirty":true,"contentVersion":3}"#);
    fixture.save_round(3, b"late edit", false).await;
    let outcome = close.await.unwrap().unwrap();
    assert_eq!(outcome.saved_version.as_deref(), Some("3"));
    assert_eq!(std::fs::read(&fixture.doc).unwrap(), b"late edit");
}

#[tokio::test]
async fn first_edits_to_a_new_document_the_host_has_not_heard_of_are_saved() {
    let mut fixture = Fixture::new_document();
    let close = fixture.close(CloseMode::Save);
    let probe = fixture.next("host.markSaved").await;
    assert_eq!(probe.params, r#"{"contentVersion":0}"#);
    fixture.answer(&probe, r#"{"dirty":true,"contentVersion":2}"#);
    fixture.save_round(2, b"first edits", false).await;
    let outcome = close.await.unwrap().unwrap();
    assert!(outcome.unmounted);
    assert_eq!(outcome.saved_version.as_deref(), Some("2"));
    assert_eq!(std::fs::read(&fixture.doc).unwrap(), b"first edits");
}

#[tokio::test]
async fn an_untouched_new_document_unmounts_without_a_file_once_the_editor_says_clean() {
    let mut fixture = Fixture::new_document();
    let close = fixture.close(CloseMode::Save);
    let probe = fixture.next("host.markSaved").await;
    fixture.answer(&probe, r#"{"dirty":false,"contentVersion":1}"#);
    let outcome = close.await.unwrap().unwrap();
    assert!(outcome.unmounted);
    assert_eq!(outcome.saved_version, None);
    assert!(
        !fixture.doc.exists(),
        "no file for a document nobody edited"
    );
}

#[tokio::test]
async fn a_clean_mount_unmounts_after_the_editor_confirms_it_is_clean() {
    let mut fixture = Fixture::ready(4);
    let close = fixture.close(CloseMode::Save);
    let probe = fixture.next("host.markSaved").await;
    fixture.answer(&probe, r#"{"dirty":false,"contentVersion":4}"#);
    let outcome = close.await.unwrap().unwrap();
    assert!(outcome.unmounted);
    assert_eq!(outcome.saved_version.as_deref(), Some("4"));
    assert_eq!(
        std::fs::read(&fixture.doc).unwrap(),
        b"saved",
        "nothing rewritten"
    );
}

#[tokio::test]
async fn a_loading_or_untouched_new_mount_unmounts_without_asking_the_editor() {
    let mounts = CanvasPersistence::default();
    let seq = mounts.mount(PROJECT, PathBuf::from("a.figcraft"), Duration::from_secs(1));
    let outcome = mounts.close(PROJECT, CloseMode::Save).await.unwrap();
    assert!(outcome.unmounted);

    let seq_new = mounts.mount(PROJECT, PathBuf::from("b.figcraft"), Duration::from_secs(1));
    assert!(seq_new > seq);
    mounts.document_loaded(PROJECT, seq_new, None).unwrap();
    let outcome = mounts.close(PROJECT, CloseMode::Save).await.unwrap();
    assert!(outcome.unmounted);
    assert_eq!(outcome.saved_version, None);

    let again = mounts.close(PROJECT, CloseMode::Save).await.unwrap();
    assert!(!again.unmounted, "closing is idempotent");
}

#[tokio::test]
async fn a_second_close_while_one_runs_is_canvas_closing() {
    let mut fixture = Fixture::ready(1);
    let _debounce = fixture.edit(2).await;
    let first = fixture.close(CloseMode::Save);
    let snapshot = fixture.next("host.snapshot").await;
    let second = fixture.close(CloseMode::Save).await.unwrap().unwrap_err();
    assert_eq!(second.code, CODE_CANVAS_CLOSING);
    fixture.answer(
        &snapshot,
        &format!(
            r#"{{"contentVersion":2,"bytes":"{}"}}"#,
            BASE64.encode(b"x")
        ),
    );
    let verify = fixture.next("host.markSaved").await;
    fixture.answer(&verify, r#"{"dirty":false,"contentVersion":2}"#);
    assert!(first.await.unwrap().unwrap().unmounted);
}

#[tokio::test]
async fn close_all_saves_every_mount_and_reports_each() {
    let mut fixture = Fixture::ready(1);
    let _debounce = fixture.edit(2).await;
    let mounts = Arc::clone(&fixture.mounts);
    let all = tokio::spawn(async move { mounts.close_all().await });
    fixture.save_round(2, b"edited", false).await;
    let closed = all.await.unwrap();
    assert_eq!(closed.len(), 1);
    assert_eq!(closed[0].0, PROJECT);
    assert!(closed[0].1.as_ref().unwrap().unmounted);
}
