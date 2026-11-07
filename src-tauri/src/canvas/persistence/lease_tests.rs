//! The mount lease (AD-30): the newest opener takes it once the holder has
//! saved, a takeover whose save fails is refused, a holder whose connection
//! ended keeps it for the grace, and calls reach the holder only.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use tokio::sync::mpsc;

use super::{CanvasPersistence, LeaseChange, MountRequest, RendererId};
use crate::acp::host_mcp::canvas::{
    CanvasCallFrame, CanvasErrorCode, CanvasHolder, CanvasLeaseLostFrame, CanvasRouter,
};
use crate::canvas::CODE_CANVAS_OPEN_ELSEWHERE;

const PROJECT: &str = "project-lease";
const CALL_TIMEOUT: Duration = Duration::from_secs(5);
const GRACE: Duration = Duration::from_millis(150);
const CAP: usize = super::DEFAULT_MAX_MOUNTED;

/// One connection of a renderer (a window or tab), recording what the host
/// sends it.
struct Connection {
    id: String,
    frames: mpsc::UnboundedReceiver<CanvasCallFrame>,
    notices: mpsc::UnboundedReceiver<CanvasLeaseLostFrame>,
}

fn connect(tab: &str, connection: &str) -> (CanvasHolder, Connection) {
    let (frames_tx, frames) = mpsc::unbounded_channel();
    let (notices_tx, notices) = mpsc::unbounded_channel();
    let holder = CanvasHolder::new(
        connection,
        RendererId::new(tab),
        Arc::new(move |frame| frames_tx.send(frame).is_ok()),
    )
    .with_lease_notice(Arc::new(move |frame| notices_tx.send(frame).is_ok()));
    let connection = Connection {
        id: connection.to_string(),
        frames,
        notices,
    };
    (holder, connection)
}

impl Connection {
    async fn next(&mut self, method: &str) -> CanvasCallFrame {
        let frame = tokio::time::timeout(Duration::from_secs(2), self.frames.recv())
            .await
            .expect("a frame in time")
            .expect("the connection is open");
        assert_eq!(frame.method, method);
        frame
    }

    fn answer(
        &self,
        mounts: &CanvasPersistence,
        frame: &CanvasCallFrame,
        outcome: Result<&str, CanvasErrorCode>,
    ) {
        let outcome = outcome.map(str::to_string).map_err(|code| {
            crate::acp::host_mcp::canvas::CanvasError::new(code, "refused by the test")
        });
        mounts.reply(&self.id, frame.call_id, frame.mount_seq, outcome);
    }
}

fn request(tab: &str, doc: &Path) -> MountRequest {
    MountRequest {
        renderer: RendererId::new(tab),
        doc_path: doc.to_path_buf(),
        autosave: Duration::from_secs(60),
        autosave_max: crate::canvas::persistence::autosave_max_wait(None),
        lease_grace: GRACE,
        crash_timeouts: super::DEFAULT_CRASH_TIMEOUTS,
    }
}

struct Host {
    mounts: Arc<CanvasPersistence>,
    doc: PathBuf,
    _dir: tempfile::TempDir,
}

impl Host {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let doc = dir.path().join("design.figcraft");
        std::fs::write(&doc, b"saved at 1").unwrap();
        Self {
            mounts: Arc::new(
                CanvasPersistence::default().with_host_call_timeout(Duration::from_secs(2)),
            ),
            doc,
            _dir: dir,
        }
    }

    /// `tab` opens the canvas, loads the document at version 1 and reports
    /// its editor runs in `connection`.
    async fn open_loaded(&self, tab: &str, connection: &str) -> (u64, Connection) {
        let opened = self
            .mounts
            .open(PROJECT, request(tab, &self.doc), CAP)
            .await
            .opened
            .unwrap();
        self.mounts
            .document_loaded(PROJECT, opened.mount_seq, Some(1))
            .unwrap();
        let (holder, connection) = connect(tab, connection);
        assert!(self.mounts.attach(PROJECT, opened.mount_seq, holder));
        (opened.mount_seq, connection)
    }

    /// An edit at version 2 the host knows of but has not saved.
    async fn edit(&self, mount_seq: u64) {
        let mounts = Arc::clone(&self.mounts);
        tokio::spawn(async move { mounts.dirty_changed(PROJECT, mount_seq, true, 2).await });
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    fn open_in_background(
        &self,
        tab: &str,
    ) -> tokio::task::JoinHandle<Result<super::Opened, crate::canvas::CanvasError>> {
        let mounts = Arc::clone(&self.mounts);
        let request = request(tab, &self.doc);
        tokio::spawn(async move { mounts.open(PROJECT, request, CAP).await.opened })
    }

    fn agent_call(&self) -> tokio::task::JoinHandle<crate::acp::host_mcp::canvas::CanvasOutcome> {
        let mounts = Arc::clone(&self.mounts);
        tokio::spawn(async move {
            mounts
                .call(PROJECT, "node.get", "{}".into(), CALL_TIMEOUT)
                .await
        })
    }
}

fn snapshot_of(version: u64, bytes: &[u8]) -> String {
    format!(
        r#"{{"contentVersion":{version},"bytes":"{}"}}"#,
        BASE64.encode(bytes)
    )
}

#[tokio::test]
async fn the_newest_opener_takes_the_lease_after_the_holder_saved() {
    let host = Host::new();
    let (seq_a, mut tab_a) = host.open_loaded("tab-a", "conn-a").await;
    host.edit(seq_a).await;

    let open_b = host.open_in_background("tab-b");
    let snapshot = tab_a.next("host.snapshot").await;
    tab_a.answer(&host.mounts, &snapshot, Ok(&snapshot_of(2, b"edited in a")));
    let verify = tab_a.next("host.markSaved").await;
    tab_a.answer(
        &host.mounts,
        &verify,
        Ok(r#"{"dirty":false,"contentVersion":2}"#),
    );

    let opened = open_b.await.unwrap().unwrap();
    assert_eq!(
        opened.lease,
        LeaseChange::TakenOver {
            previous: seq_a,
            saved_version: Some("2".into()),
        }
    );
    assert!(opened.mount_seq > seq_a);
    assert_eq!(
        std::fs::read(&host.doc).unwrap(),
        b"edited in a",
        "saved before the hand-over"
    );
    let notice = tab_a.notices.try_recv().expect("the old holder is told");
    assert_eq!(
        (notice.project_id.as_str(), notice.mount_seq),
        (PROJECT, seq_a)
    );

    let (stale, _) = connect("tab-a", "conn-a2");
    assert!(
        !host.mounts.attach(PROJECT, opened.mount_seq, stale),
        "the old holder cannot report the new mount"
    );
    let (holder_b, mut tab_b) = connect("tab-b", "conn-b");
    assert!(host.mounts.attach(PROJECT, opened.mount_seq, holder_b));
    let call = host.agent_call();
    let routed = tab_b.next("node.get").await;
    tab_b.answer(&host.mounts, &routed, Ok("{}"));
    assert_eq!(call.await.unwrap(), Ok("{}".to_string()));
    assert!(
        tab_a.frames.try_recv().is_err(),
        "nothing more reaches the old holder"
    );
}

#[tokio::test]
async fn a_takeover_whose_save_fails_is_refused_and_the_holder_keeps_the_lease() {
    let host = Host::new();
    let (seq_a, mut tab_a) = host.open_loaded("tab-a", "conn-a").await;
    host.edit(seq_a).await;

    let open_b = host.open_in_background("tab-b");
    let snapshot = tab_a.next("host.snapshot").await;
    tab_a.answer(&host.mounts, &snapshot, Err(CanvasErrorCode::EngineError));

    let refused = open_b.await.unwrap().unwrap_err();
    assert_eq!(refused.code, CODE_CANVAS_OPEN_ELSEWHERE);
    assert!(
        refused.message.contains("SAVE_FAILED"),
        "{}",
        refused.message
    );
    assert!(
        tab_a.notices.try_recv().is_err(),
        "the holder did not lose anything"
    );
    assert_eq!(
        host.mounts.holder_of(PROJECT),
        Some((seq_a, "conn-a".into()))
    );
    assert_eq!(std::fs::read(&host.doc).unwrap(), b"saved at 1");

    let call = host.agent_call();
    let routed = tab_a.next("node.get").await;
    tab_a.answer(&host.mounts, &routed, Ok("{}"));
    assert_eq!(
        call.await.unwrap(),
        Ok("{}".to_string()),
        "the holder still serves calls"
    );
}

#[tokio::test]
async fn a_lost_connection_keeps_the_lease_through_the_grace() {
    let host = Host::new();
    let (seq_a, _tab_a) = host.open_loaded("tab-a", "conn-a").await;

    let lost = host.mounts.release_holder("conn-a");
    assert_eq!(lost.len(), 1);
    assert_eq!((lost[0].mount_seq, lost[0].grace), (seq_a, GRACE));
    let meanwhile = host.agent_call().await.unwrap();
    assert_eq!(meanwhile.unwrap_err().code, CanvasErrorCode::CanvasClosed);

    let (intruder, _) = connect("tab-b", "conn-b");
    assert!(
        !host.mounts.attach(PROJECT, seq_a, intruder),
        "another renderer cannot claim it"
    );
    let (reconnected, mut tab_a2) = connect("tab-a", "conn-a2");
    assert!(
        host.mounts.attach(PROJECT, seq_a, reconnected),
        "the holder takes it up again"
    );

    tokio::time::sleep(GRACE + Duration::from_millis(50)).await;
    assert_eq!(
        host.mounts.expire_lease(PROJECT, seq_a),
        None,
        "a reattached mount stays"
    );
    let call = host.agent_call();
    let routed = tab_a2.next("node.get").await;
    tab_a2.answer(&host.mounts, &routed, Ok("{}"));
    assert_eq!(call.await.unwrap(), Ok("{}".to_string()));
}

#[tokio::test]
async fn the_lease_is_released_and_the_mount_dropped_when_the_grace_runs_out() {
    let host = Host::new();
    let (seq_a, _tab_a) = host.open_loaded("tab-a", "conn-a").await;
    host.edit(seq_a).await;
    host.mounts.release_holder("conn-a");

    assert_eq!(
        host.mounts.expire_lease(PROJECT, seq_a),
        None,
        "still in the grace"
    );
    tokio::time::sleep(GRACE).await;
    let expired = host.mounts.expire_lease(PROJECT, seq_a).expect("released");
    assert_eq!(expired.saved_version.as_deref(), Some("1"));
    assert!(expired.unsaved, "the unsaved edit is reported");
    assert!(host.mounts.mounted_projects().is_empty());
    assert_eq!(
        std::fs::read(&host.doc).unwrap(),
        b"saved at 1",
        "the last save stands"
    );
    let (late, _) = connect("tab-a", "conn-a2");
    assert!(
        !host.mounts.attach(PROJECT, seq_a, late),
        "too late to take it up"
    );
    let after = host.agent_call().await.unwrap();
    assert_eq!(after.unwrap_err().code, CanvasErrorCode::CanvasClosed);
}

#[tokio::test]
async fn a_reload_of_the_holder_remounts_with_a_new_mount_seq_and_keeps_the_lease() {
    let host = Host::new();
    let (seq_a, mut tab_a) = host.open_loaded("tab-a", "conn-a").await;
    host.mounts.release_holder("conn-a");

    let reopened = host
        .mounts
        .open(PROJECT, request("tab-a", &host.doc), CAP)
        .await
        .opened
        .unwrap();
    assert_eq!(reopened.lease, LeaseChange::Remounted { previous: seq_a });
    assert!(reopened.mount_seq > seq_a);
    assert!(
        tab_a.frames.try_recv().is_err(),
        "the reload is not asked to save the old page"
    );

    let (intruder, _) = connect("tab-b", "conn-b");
    assert!(!host.mounts.attach(PROJECT, reopened.mount_seq, intruder));
    let (reloaded, _tab) = connect("tab-a", "conn-a2");
    assert!(host.mounts.attach(PROJECT, reopened.mount_seq, reloaded));
    tokio::time::sleep(GRACE).await;
    assert_eq!(host.mounts.expire_lease(PROJECT, seq_a), None);
    assert_eq!(
        host.mounts.holder_of(PROJECT),
        Some((reopened.mount_seq, "conn-a2".into()))
    );
}

#[tokio::test]
async fn a_reload_that_opens_before_its_old_page_disconnects_remounts_once_it_does() {
    let host = Host::new();
    let (seq_a, mut tab_a) = host.open_loaded("tab-a", "conn-a").await;
    host.edit(seq_a).await;

    let reload = host.open_in_background("tab-a");
    tab_a.next("host.snapshot").await;
    host.mounts.release_holder("conn-a");

    let reopened = reload.await.unwrap().unwrap();
    assert_eq!(reopened.lease, LeaseChange::Remounted { previous: seq_a });
    assert!(reopened.mount_seq > seq_a);
    assert_eq!(std::fs::read(&host.doc).unwrap(), b"saved at 1");
}

#[tokio::test]
async fn a_clean_holder_in_its_grace_is_taken_over_without_a_save() {
    let host = Host::new();
    let (seq_a, _tab_a) = host.open_loaded("tab-a", "conn-a").await;
    host.mounts.release_holder("conn-a");

    let opened = host
        .mounts
        .open(PROJECT, request("tab-b", &host.doc), CAP)
        .await
        .opened
        .unwrap();
    assert_eq!(
        opened.lease,
        LeaseChange::TakenOver {
            previous: seq_a,
            saved_version: Some("1".into()),
        }
    );
}

#[tokio::test]
async fn the_router_drops_a_mount_whose_holder_did_not_come_back() {
    let host = Host::new();
    let router = CanvasRouter::with_mounts(Arc::clone(&host.mounts), CALL_TIMEOUT);
    let (seq_a, _tab_a) = host.open_loaded("tab-a", "conn-a").await;

    router.release_holder("conn-a");
    tokio::time::sleep(GRACE / 2).await;
    assert_eq!(host.mounts.mounted_projects(), vec![PROJECT.to_string()]);
    tokio::time::sleep(GRACE).await;
    assert!(
        host.mounts.mounted_projects().is_empty(),
        "released after the grace"
    );
    let (late, _) = connect("tab-a", "conn-a2");
    assert!(!host.mounts.attach(PROJECT, seq_a, late));
}

#[tokio::test]
async fn a_duplicate_tab_with_the_same_id_saves_and_tells_the_live_holder_first() {
    let host = Host::new();
    let (seq_a, mut tab_a) = host.open_loaded("tab-a", "conn-a").await;
    host.edit(seq_a).await;

    let duplicate = host.open_in_background("tab-a");
    let snapshot = tab_a.next("host.snapshot").await;
    tab_a.answer(&host.mounts, &snapshot, Ok(&snapshot_of(2, b"edited in a")));
    let verify = tab_a.next("host.markSaved").await;
    tab_a.answer(
        &host.mounts,
        &verify,
        Ok(r#"{"dirty":false,"contentVersion":2}"#),
    );

    let opened = duplicate.await.unwrap().unwrap();
    assert_eq!(
        opened.lease,
        LeaseChange::TakenOver {
            previous: seq_a,
            saved_version: Some("2".into()),
        }
    );
    assert_eq!(std::fs::read(&host.doc).unwrap(), b"edited in a");
    let notice = tab_a
        .notices
        .try_recv()
        .expect("the live page is told it lost the canvas");
    assert_eq!(notice.mount_seq, seq_a);
}
