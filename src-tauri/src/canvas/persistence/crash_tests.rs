//! Crash remount (AD-31): consecutive timeouts or `event.crashed` replace a
//! mount with a fresh one of the same document under a new mountSeq.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;

use super::{crash_timeouts, CanvasPersistence, Remount, REMOUNTED_METHOD};
use crate::acp::host_mcp::canvas::{CanvasCallFrame, CanvasError, CanvasErrorCode, CanvasHolder};
use crate::canvas::CODE_CANVAS_CLOSED;

const PROJECT: &str = "project-crash";
const HOLDER: &str = "conn-crash";
const QUICK: Duration = Duration::from_millis(20);

struct Editor {
    mounts: Arc<CanvasPersistence>,
    seq: u64,
    doc: PathBuf,
    frames: mpsc::UnboundedReceiver<CanvasCallFrame>,
}

impl Editor {
    /// A mount run by a renderer whose frames the test reads; `loaded`
    /// decides whether the document reached ready.
    fn mounted(loaded: bool) -> Self {
        let mounts = Arc::new(CanvasPersistence::default());
        let doc = PathBuf::from("crash/design.figcraft");
        let seq = mounts.mount_configured(PROJECT, doc.clone(), Duration::from_secs(60), 3);
        if loaded {
            mounts.document_loaded(PROJECT, seq, Some(3)).unwrap();
        }
        let (tx, frames) = mpsc::unbounded_channel();
        let holder = CanvasHolder::new(
            HOLDER,
            super::test_renderer(),
            Arc::new(move |frame| tx.send(frame).is_ok()),
        );
        assert!(mounts.attach(PROJECT, seq, holder));
        Self {
            mounts,
            seq,
            doc,
            frames,
        }
    }

    /// An agent call nobody answers.
    async fn time_out(&mut self) {
        let outcome = self
            .mounts
            .call(PROJECT, "node.get", "{}".into(), QUICK)
            .await;
        assert_eq!(outcome.unwrap_err().code, CanvasErrorCode::CanvasTimeout);
        self.frames
            .recv()
            .await
            .expect("the call reached the renderer");
    }

    /// An agent call the editor answers with `reply`.
    async fn answered(&mut self, reply: Result<String, CanvasError>) {
        let mounts = Arc::clone(&self.mounts);
        let call = tokio::spawn(async move {
            mounts
                .call(PROJECT, "ui.inspect", "{}".into(), Duration::from_secs(5))
                .await
        });
        let frame = self
            .frames
            .recv()
            .await
            .expect("the call reached the renderer");
        self.mounts
            .reply(HOLDER, frame.call_id, frame.mount_seq, reply.clone());
        assert_eq!(call.await.unwrap(), reply);
    }

    fn still_mounted(&self) -> bool {
        self.mounts.view(PROJECT, self.seq).is_ok()
    }

    async fn remounted_notice(&mut self) -> Remount {
        let frame = self.frames.recv().await.expect("the remount notice");
        assert_eq!(frame.method, REMOUNTED_METHOD);
        assert_eq!(frame.mount_seq, self.seq, "sent to the mount it replaces");
        let notice: serde_json::Value = serde_json::from_str(&frame.params).unwrap();
        Remount {
            previous_mount_seq: notice["previousMountSeq"].as_u64().unwrap(),
            mount_seq: notice["mountSeq"].as_u64().unwrap(),
            reason: notice["reason"].as_str().unwrap().to_string(),
            lost: None,
        }
    }
}

#[test]
fn crash_timeouts_defaults_to_three_and_is_at_least_one() {
    assert_eq!(crash_timeouts(None), 3);
    assert_eq!(crash_timeouts(Some(0)), 1);
    assert_eq!(crash_timeouts(Some(5)), 5);
    assert_eq!(crash_timeouts(Some(1000)), 20);
}

#[tokio::test]
async fn three_consecutive_timeouts_remount_with_a_new_mount_seq() {
    let mut editor = Editor::mounted(true);
    editor.time_out().await;
    editor.time_out().await;
    assert!(editor.still_mounted(), "two are not a crash");
    editor.time_out().await;

    let notice = editor.remounted_notice().await;
    assert_eq!(notice.previous_mount_seq, editor.seq);
    assert!(notice.mount_seq > editor.seq);
    assert!(notice.reason.contains("3 consecutive calls timed out"));
    let fresh = editor.mounts.view(PROJECT, notice.mount_seq).unwrap();
    assert!(!fresh.ready, "the new mount loads the last saved bytes");
    assert_eq!(
        editor.mounts.doc_path(PROJECT, notice.mount_seq).unwrap(),
        editor.doc
    );
    assert_eq!(
        editor.mounts.view(PROJECT, editor.seq).unwrap_err().code,
        CODE_CANVAS_CLOSED
    );
    assert_eq!(
        editor.mounts.holder_of(PROJECT),
        None,
        "until the renderer reports it"
    );
}

#[tokio::test]
async fn an_answer_resets_the_count() {
    let mut editor = Editor::mounted(true);
    editor.time_out().await;
    editor.time_out().await;
    editor.answered(Ok("{}".into())).await;
    editor.time_out().await;
    editor.time_out().await;
    assert!(editor.still_mounted());
}

#[tokio::test]
async fn canvas_hidden_is_an_answer_not_a_timeout() {
    let mut editor = Editor::mounted(true);
    for _ in 0..2 {
        editor.time_out().await;
        editor
            .answered(Err(CanvasError::new(
                CanvasErrorCode::CanvasHidden,
                "the canvas tab is hidden",
            )))
            .await;
    }
    editor.time_out().await;
    editor.time_out().await;
    assert!(editor.still_mounted(), "never three in a row");
}

#[tokio::test]
async fn a_reply_the_renderer_gives_for_an_editor_that_never_ran_the_call_keeps_the_count() {
    for code in [
        CanvasErrorCode::CanvasTimeout,
        CanvasErrorCode::CanvasClosed,
    ] {
        let mut editor = Editor::mounted(true);
        editor.time_out().await;
        editor.time_out().await;
        editor
            .answered(Err(CanvasError::new(code, "answered by the renderer")))
            .await;
        editor.time_out().await;
        let notice = tokio::time::timeout(Duration::from_secs(2), editor.remounted_notice())
            .await
            .unwrap_or_else(|_| panic!("{code:?} reset the count: no remount"));
        assert!(
            notice.reason.contains("3 consecutive calls timed out"),
            "{code:?}: {}",
            notice.reason
        );
    }
}

#[tokio::test]
async fn timeouts_before_the_document_loaded_are_not_a_crash() {
    let mut editor = Editor::mounted(false);
    for _ in 0..4 {
        editor.time_out().await;
    }
    assert!(editor.still_mounted());
}

#[tokio::test]
async fn event_crashed_remounts_and_reports_the_lost_edits() {
    let mut editor = Editor::mounted(true);
    let mounts = Arc::clone(&editor.mounts);
    let seq = editor.seq;
    tokio::spawn(async move { mounts.dirty_changed(PROJECT, seq, true, 7).await });
    tokio::time::sleep(QUICK).await;

    let remount = editor.mounts.crashed(PROJECT, seq, "wasm panic").unwrap();
    assert_eq!(remount.previous_mount_seq, seq);
    assert!(remount.mount_seq > seq);
    assert!(remount.reason.contains("wasm panic"));
    let lost = remount.lost.clone().expect("unsaved edits were lost");
    assert_eq!(lost.count, 4, "contentVersion 7 - savedVersion 3");
    assert!(lost.since_ms.is_some());

    assert_eq!(
        editor.mounts.crashed(PROJECT, seq, "wasm panic").unwrap(),
        remount,
        "a repeat report answers the same remount"
    );
    assert_eq!(editor.remounted_notice().await.mount_seq, remount.mount_seq);
    assert_eq!(
        editor
            .mounts
            .crashed(PROJECT, remount.mount_seq + 1, "x")
            .unwrap_err()
            .code,
        CODE_CANVAS_CLOSED
    );
}

#[tokio::test]
async fn a_clean_crash_loses_nothing() {
    let editor = Editor::mounted(true);
    let remount = editor.mounts.crashed(PROJECT, editor.seq, "x").unwrap();
    assert_eq!(remount.lost, None);
}

#[tokio::test]
async fn presence_lookups_that_time_out_never_remount_nor_reset_the_count() {
    let mut editor = Editor::mounted(true);
    editor.time_out().await;
    editor.time_out().await;
    for _ in 0..4 {
        let outcome = editor
            .mounts
            .presence_call(PROJECT, "node.get", "{}".into(), QUICK)
            .await;
        assert_eq!(outcome.unwrap_err().code, CanvasErrorCode::CanvasTimeout);
        editor
            .frames
            .recv()
            .await
            .expect("the lookup reached the renderer");
    }
    assert!(editor.still_mounted(), "presence timeouts are not a crash");

    let mounts = Arc::clone(&editor.mounts);
    let lookup = tokio::spawn(async move {
        mounts
            .presence_call(PROJECT, "node.get", "{}".into(), Duration::from_secs(5))
            .await
    });
    let frame = editor.frames.recv().await.expect("the lookup");
    editor
        .mounts
        .reply(HOLDER, frame.call_id, frame.mount_seq, Ok("{}".into()));
    assert_eq!(lookup.await.unwrap(), Ok("{}".to_string()));
    editor.time_out().await;
    let notice = editor.remounted_notice().await;
    assert_eq!(
        notice.previous_mount_seq, editor.seq,
        "a presence answer does not reset the agent's timeouts"
    );
}

#[tokio::test]
async fn calls_that_time_out_together_in_one_stall_count_once() {
    let mut editor = Editor::mounted(true);
    let stalled: Vec<_> = (0..3)
        .map(|_| {
            let mounts = Arc::clone(&editor.mounts);
            tokio::spawn(async move { mounts.call(PROJECT, "node.get", "{}".into(), QUICK).await })
        })
        .collect();
    for call in stalled {
        assert_eq!(
            call.await.unwrap().unwrap_err().code,
            CanvasErrorCode::CanvasTimeout
        );
    }
    for _ in 0..3 {
        editor
            .frames
            .recv()
            .await
            .expect("each call reached the renderer");
    }
    editor.time_out().await;
    assert!(
        editor.still_mounted(),
        "one stall and one more timeout are two, not four"
    );
    editor.time_out().await;
    assert_eq!(
        editor.remounted_notice().await.previous_mount_seq,
        editor.seq
    );
}

#[tokio::test]
async fn a_late_answer_to_a_timed_out_call_resets_the_count() {
    let mut editor = Editor::mounted(true);
    editor.time_out().await;
    let outcome = editor
        .mounts
        .call(PROJECT, "node.get", "{}".into(), QUICK)
        .await;
    assert_eq!(outcome.unwrap_err().code, CanvasErrorCode::CanvasTimeout);
    let late = editor
        .frames
        .recv()
        .await
        .expect("the call reached the renderer");
    editor
        .mounts
        .reply(HOLDER, late.call_id, late.mount_seq, Ok("{}".into()));
    editor.time_out().await;
    editor.time_out().await;
    assert!(
        editor.still_mounted(),
        "the late answer proved the editor alive"
    );
}

#[tokio::test]
async fn calls_queued_behind_a_render_still_inside_its_wait_are_not_a_crash() {
    let mut editor = Editor::mounted(true);
    let mounts = Arc::clone(&editor.mounts);
    let render = tokio::spawn(async move {
        mounts
            .call(
                PROJECT,
                "host.renderPng",
                "{}".into(),
                Duration::from_secs(30),
            )
            .await
    });
    editor
        .frames
        .recv()
        .await
        .expect("the render reached the renderer");

    for _ in 0..4 {
        editor.time_out().await;
    }

    assert!(editor.still_mounted(), "the editor is busy rendering");
    render.abort();
}

#[tokio::test]
async fn once_a_render_outlasts_its_own_wait_timeouts_count_again() {
    let mut editor = Editor::mounted(true);
    let mounts = Arc::clone(&editor.mounts);
    let render = tokio::spawn(async move {
        mounts
            .call(
                PROJECT,
                "host.renderPng",
                "{}".into(),
                Duration::from_millis(300),
            )
            .await
    });
    editor
        .frames
        .recv()
        .await
        .expect("the render reached the renderer");
    editor.time_out().await;
    assert_eq!(
        render.await.unwrap().unwrap_err().code,
        CanvasErrorCode::CanvasTimeout
    );

    editor.time_out().await;
    editor.time_out().await;

    let notice = tokio::time::timeout(Duration::from_secs(2), editor.remounted_notice())
        .await
        .expect("the render and two calls after it are three in a row");
    assert!(notice.reason.contains("3 consecutive calls timed out"));
}
