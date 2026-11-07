//! The mount cap (AD-26): which canvas is evicted, and that an eviction is a
//! save first.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use tokio::sync::mpsc;

use super::{mount_cap, test_renderer, CanvasPersistence, MountRequest, DEFAULT_MAX_MOUNTED};
use crate::acp::host_mcp::canvas::{CanvasCallFrame, CanvasErrorCode, CanvasHolder};
use crate::canvas::{CODE_CANVAS_CLOSED, CODE_SAVE_FAILED};

const AUTOSAVE: Duration = Duration::from_secs(60);
const CALL_TIMEOUT: Duration = Duration::from_millis(50);

struct Registry {
    mounts: Arc<CanvasPersistence>,
    dir: tempfile::TempDir,
}

impl Registry {
    fn new() -> Self {
        Self {
            mounts: Arc::new(CanvasPersistence::default()),
            dir: tempfile::tempdir().unwrap(),
        }
    }

    fn doc(&self, project: &str) -> PathBuf {
        self.dir.path().join(format!("{project}.figcraft"))
    }

    /// A ready mount at saved version 1, run by a renderer connection named
    /// after the project whose frames the test reads.
    fn mount(&self, project: &str) -> (u64, mpsc::UnboundedReceiver<CanvasCallFrame>) {
        std::fs::write(self.doc(project), b"saved").unwrap();
        let seq = self.mounts.mount(project, self.doc(project), AUTOSAVE);
        self.mounts.document_loaded(project, seq, Some(1)).unwrap();
        let (tx, frames) = mpsc::unbounded_channel();
        let holder = CanvasHolder::new(
            project.to_string(),
            test_renderer(),
            Arc::new(move |frame| tx.send(frame).is_ok()),
        );
        assert!(self.mounts.attach(project, seq, holder));
        (seq, frames)
    }

    /// The editor reports an unsaved edit; the debounce stays parked.
    async fn edit(&self, project: &str, seq: u64, version: u64) {
        let mounts = Arc::clone(&self.mounts);
        let project = project.to_string();
        tokio::spawn(async move { mounts.dirty_changed(&project, seq, true, version).await });
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    async fn admit(&self, project: &str, cap: usize) -> super::Admitted {
        self.mounts
            .open(
                project,
                MountRequest::for_test(self.doc(project), AUTOSAVE),
                cap,
            )
            .await
    }

    fn mounted(&self) -> Vec<String> {
        let mut projects = self.mounts.mounted_projects();
        projects.sort();
        projects
    }

    async fn agent_call(&self, project: &str) {
        let _ = self
            .mounts
            .call(project, "node.get", "{}".into(), CALL_TIMEOUT)
            .await;
    }
}

fn evicted(admitted: &super::Admitted) -> Vec<&str> {
    admitted
        .evicted
        .iter()
        .map(|eviction| eviction.project_id.as_str())
        .collect()
}

#[test]
fn the_cap_defaults_to_two_and_is_clamped() {
    assert_eq!(mount_cap(None), DEFAULT_MAX_MOUNTED);
    assert_eq!(mount_cap(Some(0)), 1);
    assert_eq!(mount_cap(Some(3)), 3);
    assert_eq!(mount_cap(Some(10_000)), 16);
    assert_eq!(mount_cap(Some(u64::MAX)), 16);
}

#[tokio::test]
async fn room_under_the_cap_evicts_nothing() {
    let registry = Registry::new();
    registry.mount("a");
    let admitted = registry.admit("b", 2).await;
    assert!(admitted.opened.is_ok());
    assert!(admitted.evicted.is_empty());
    assert_eq!(registry.mounted(), ["a", "b"]);
}

#[tokio::test]
async fn the_least_recently_mounted_is_evicted_first_with_the_cap_as_the_reason() {
    let registry = Registry::new();
    registry.mount("a");
    registry.mount("b");
    let admitted = registry.admit("c", 2).await;

    assert_eq!(evicted(&admitted), ["a"]);
    assert_eq!(admitted.evicted[0].reason, "mount cap reached");
    assert!(admitted.opened.is_ok());
    assert_eq!(registry.mounted(), ["b", "c"]);
}

#[tokio::test]
async fn an_evicted_canvas_reads_closed_until_it_is_reopened() {
    let registry = Registry::new();
    let (seq_a, _frames) = registry.mount("a");
    registry.mount("b");
    registry.admit("c", 2).await.opened.unwrap();

    assert_eq!(
        registry.mounts.view("a", seq_a).unwrap_err().code,
        CODE_CANVAS_CLOSED
    );
    let call = registry
        .mounts
        .call("a", "node.get", "{}".into(), CALL_TIMEOUT)
        .await;
    assert_eq!(call.unwrap_err().code, CanvasErrorCode::CanvasClosed);
    assert_eq!(
        registry
            .mounts
            .set_visible("a", seq_a, true)
            .unwrap_err()
            .code,
        CODE_CANVAS_CLOSED,
        "a renderer still showing it learns it is gone"
    );

    let reopened = registry.admit("a", 2).await;
    assert_eq!(evicted(&reopened), ["b"]);
    assert!(reopened.opened.unwrap().mount_seq > seq_a);
}

#[tokio::test]
async fn an_agent_call_keeps_a_hidden_canvas_from_being_the_victim() {
    let registry = Registry::new();
    registry.mount("a");
    registry.mount("b");
    registry.agent_call("a").await;

    let admitted = registry.admit("c", 2).await;
    assert_eq!(
        evicted(&admitted),
        ["b"],
        "a was mounted first, but an agent worked in it since"
    );
}

#[tokio::test]
async fn a_refused_agent_call_is_not_activity() {
    let registry = Registry::new();
    let (_, _frames) = registry.mount("a");
    registry.mount("b");
    registry.mounts.release_holder("a");
    registry.agent_call("a").await;

    let admitted = registry.admit("c", 2).await;
    assert_eq!(evicted(&admitted), ["a"]);
}

#[tokio::test]
async fn the_user_viewing_a_canvas_counts_as_activity() {
    let registry = Registry::new();
    let (seq_a, _a) = registry.mount("a");
    registry.mount("b");
    registry.mounts.set_visible("a", seq_a, true).unwrap();
    registry.mounts.set_visible("a", seq_a, false).unwrap();

    let admitted = registry.admit("c", 2).await;
    assert_eq!(
        evicted(&admitted),
        ["b"],
        "leaving a canvas is activity too"
    );
}

#[tokio::test]
async fn a_canvas_on_screen_outranks_one_touched_more_recently() {
    let registry = Registry::new();
    let (seq_a, _a) = registry.mount("a");
    let (seq_b, _) = registry.mount("b");
    registry.mounts.set_visible("a", seq_a, true).unwrap();
    registry.mounts.set_visible("b", seq_b, false).unwrap();

    let admitted = registry.admit("c", 2).await;
    assert_eq!(evicted(&admitted), ["b"], "a is still being looked at");
}

#[tokio::test]
async fn a_renderer_that_disconnects_stops_holding_its_canvas_on_screen() {
    let registry = Registry::new();
    let (seq_a, _a) = registry.mount("a");
    let (seq_b, _) = registry.mount("b");
    registry.mounts.set_visible("a", seq_a, true).unwrap();
    registry.mounts.set_visible("b", seq_b, false).unwrap();
    assert_eq!(registry.mounts.release_holder("a").len(), 1);

    let admitted = registry.admit("c", 2).await;
    assert_eq!(evicted(&admitted), ["a"], "its viewer is gone");
}

#[tokio::test]
async fn reopening_a_projects_own_canvas_does_not_evict_another() {
    let registry = Registry::new();
    registry.mount("a");
    registry.mount("b");
    let admitted = registry.admit("a", 2).await;
    assert!(admitted.evicted.is_empty());
    assert!(admitted.opened.is_ok());
    assert_eq!(registry.mounted(), ["a", "b"]);
}

#[tokio::test]
async fn an_eviction_saves_the_victim_before_it_unmounts() {
    let registry = Registry::new();
    let (seq_a, mut frames_a) = registry.mount("a");
    registry.mount("b");
    registry.edit("a", seq_a, 2).await;

    let mounts = Arc::clone(&registry.mounts);
    let doc = registry.doc("c");
    let admit = tokio::spawn(async move {
        mounts
            .open("c", MountRequest::for_test(doc, AUTOSAVE), 2)
            .await
    });

    let snapshot = next(&mut frames_a, "host.snapshot").await;
    assert_eq!(
        std::fs::read(registry.doc("a")).unwrap(),
        b"saved",
        "nothing is written before the editor snapshots"
    );
    answer(
        &registry,
        &snapshot,
        &format!(
            r#"{{"contentVersion":2,"bytes":"{}"}}"#,
            BASE64.encode(b"edited")
        ),
    );
    let verify = next(&mut frames_a, "host.markSaved").await;
    answer(&registry, &verify, r#"{"dirty":false,"contentVersion":2}"#);

    let admitted = admit.await.unwrap();
    assert_eq!(evicted(&admitted), ["a"]);
    assert!(admitted.opened.is_ok());
    assert_eq!(std::fs::read(registry.doc("a")).unwrap(), b"edited");
    assert_eq!(registry.mounted(), ["b", "c"]);
}

#[tokio::test]
async fn a_victim_that_cannot_be_saved_is_passed_over_for_the_next_least_active() {
    let registry = Registry::new();
    let (seq_a, _a) = registry.mount("a");
    registry.mount("b");
    registry.edit("a", seq_a, 2).await;
    registry.mounts.release_holder("a");

    let admitted = registry.admit("c", 2).await;
    assert!(admitted.opened.is_ok(), "{:?}", admitted.opened);
    assert_eq!(evicted(&admitted), ["b"]);
    assert_eq!(registry.mounted(), ["a", "c"], "the unsaved canvas stays");
    assert!(registry.mounts.view("a", seq_a).unwrap().dirty);
}

#[tokio::test]
async fn when_no_victim_can_be_saved_the_new_mount_is_blocked() {
    let registry = Registry::new();
    let (seq_a, _a) = registry.mount("a");
    let (seq_b, _b) = registry.mount("b");
    registry.edit("a", seq_a, 2).await;
    registry.edit("b", seq_b, 2).await;
    registry.mounts.release_holder("a");
    registry.mounts.release_holder("b");

    let admitted = registry.admit("c", 2).await;
    let error = admitted.opened.unwrap_err();
    assert_eq!(error.code, super::CODE_EVICTION_BLOCKED);
    assert!(
        error.message.contains("project a"),
        "names the canvas that could not be saved: {}",
        error.message
    );
    assert!(admitted.evicted.is_empty());
    assert_eq!(registry.mounted(), ["a", "b"], "nothing mounted or lost");
    assert!(registry.mounts.view("b", seq_b).unwrap().dirty);
    assert!(registry.mounts.view("a", seq_a).unwrap().dirty);

    let retry = registry
        .mounts
        .close("a", super::CloseMode::Save)
        .await
        .unwrap_err();
    assert_eq!(retry.code, CODE_SAVE_FAILED);
}

#[tokio::test]
async fn evictions_finished_before_a_later_victim_fails_are_still_reported() {
    let registry = Registry::new();
    registry.mounts.mount("a", registry.doc("a"), AUTOSAVE);
    let (seq_b, _b) = registry.mount("b");
    let (seq_d, _d) = registry.mount("d");
    registry.edit("b", seq_b, 2).await;
    registry.edit("d", seq_d, 2).await;
    registry.mounts.release_holder("b");
    registry.mounts.release_holder("d");

    let admitted = registry.admit("c", 2).await;
    assert_eq!(evicted(&admitted), ["a"]);
    assert_eq!(
        admitted.opened.unwrap_err().code,
        super::CODE_EVICTION_BLOCKED
    );
    assert_eq!(registry.mounted(), ["b", "d"]);
}

#[tokio::test]
async fn lowering_the_cap_unloads_as_many_canvases_as_it_takes() {
    let registry = Registry::new();
    registry.mount("a");
    registry.mount("b");
    registry.mount("c");
    let admitted = registry.admit("d", 2).await;
    assert_eq!(evicted(&admitted), ["a", "b"]);
    assert_eq!(registry.mounted(), ["c", "d"]);
}

#[tokio::test]
async fn concurrent_opens_cannot_both_take_the_last_slot() {
    let registry = Registry::new();
    registry.mount("a");
    let first = registry.admit("b", 2);
    let second = registry.admit("c", 2);
    let (first, second) = tokio::join!(first, second);
    assert!(first.opened.is_ok() && second.opened.is_ok());
    assert_eq!(registry.mounts.mounted_projects().len(), 2);
}

async fn next(
    frames: &mut mpsc::UnboundedReceiver<CanvasCallFrame>,
    method: &str,
) -> CanvasCallFrame {
    let frame = tokio::time::timeout(Duration::from_secs(2), frames.recv())
        .await
        .expect("a frame in time")
        .expect("the connection is open");
    assert_eq!(frame.method, method);
    frame
}

fn answer(registry: &Registry, frame: &CanvasCallFrame, result: &str) {
    assert_eq!(
        registry.mounts.reply(
            &frame.project_id,
            frame.call_id,
            frame.mount_seq,
            Ok(result.to_string())
        ),
        super::ReplyMatch::Resolved
    );
}

#[tokio::test]
async fn the_renderer_running_an_evicted_canvas_is_told_it_was_unloaded() {
    let registry = Registry::new();
    std::fs::write(registry.doc("a"), b"saved").unwrap();
    let seq_a = registry.mounts.mount("a", registry.doc("a"), AUTOSAVE);
    registry
        .mounts
        .document_loaded("a", seq_a, Some(1))
        .unwrap();
    let (notices_tx, mut notices) = mpsc::unbounded_channel();
    let holder = CanvasHolder::new("a", test_renderer(), Arc::new(|_| true))
        .with_lease_notice(Arc::new(move |frame| notices_tx.send(frame).is_ok()));
    assert!(registry.mounts.attach("a", seq_a, holder));
    registry.mount("b");

    let admitted = registry.admit("c", 2).await;
    assert_eq!(evicted(&admitted), ["a"]);
    let notice = notices.try_recv().expect("the evicted renderer is told");
    assert_eq!(
        serde_json::to_value(&notice).unwrap(),
        serde_json::json!({
            "type": "canvas_lease_lost",
            "projectId": "a",
            "mountSeq": seq_a,
            "reason": "evicted"
        })
    );
}

#[tokio::test]
async fn a_lower_cap_from_one_renderer_does_not_unload_canvases_opened_under_a_higher_one() {
    let registry = Registry::new();
    registry.admit("a", 2).await.opened.unwrap();
    registry.admit("b", 2).await.opened.unwrap();
    let admitted = registry.admit("c", 1).await;
    assert!(admitted.opened.is_ok());
    assert_eq!(
        evicted(&admitted),
        ["a"],
        "the host keeps the highest cap its mounts were opened with"
    );
    assert_eq!(registry.mounted(), ["b", "c"]);
}
