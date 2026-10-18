//! Canvas persistence (spine AD-23, AD-31): the host owns the debounce, the
//! saved version and the write of every mounted `.figcraft` document.
//!
//! One [`Mount`] per project, created by `static_server::open_canvas` and
//! dropped by `close_canvas`. Its [`Phase`] is the load floor: a mount is
//! `Loading` until the editor acknowledges `host.openDocument` (or starts a
//! new document), and only a `Ready` mount records dirty state or accepts a
//! write. The engine's dirty flag is the single dirty source; this module
//! mirrors it and decides when a save is due.
//!
//! Flow: the renderer forwards `event.dirtyChanged` to [`CanvasPersistence::
//! dirty_changed`], which answers after `autosave` of quiet with whether a
//! save is due (a later notification supersedes an earlier one, so a burst
//! of edits yields one save). A due save runs `host.snapshot` in the editor
//! and hands the bytes to [`CanvasPersistence::write_snapshot`], which writes
//! them atomically and advances `saved_version` only after the write
//! succeeded; the renderer then sends `host.markSaved` with that version.
//!
//! This is also the one mount registry (AD-19): each mount records the
//! renderer connection that holds it ([`gateway`]), so the agent gateway
//! routes through it instead of keeping its own, and every unmount runs the
//! AD-31 sequence ([`close`]).
//!
//! Tauri-free so the desktop commands and termul-server's routes share it.
//! Nothing here logs: the transports log at their boundary, never bytes.

mod close;
mod gateway;
mod wire;

#[cfg(test)]
mod close_tests;
#[cfg(test)]
mod gateway_tests;
#[cfg(test)]
mod parity_tests;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use parking_lot::Mutex;
use serde::Serialize;
use tokio::sync::watch;

use super::CanvasError;

pub use close::{CloseMode, CloseOutcome};
pub use gateway::ReplyMatch;
pub use wire::{
    dirty_changed, document_loaded, parse_version, read_document, write_snapshot, DocumentBytes,
    CODE_CANVAS_NOT_READY, CODE_INVALID_PAYLOAD, CODE_READ_FAILED,
};

/// `canvas.autosave_ms` when the renderer sends none.
pub const DEFAULT_AUTOSAVE_MS: u64 = 1500;
const MIN_AUTOSAVE_MS: u64 = 100;
const MAX_AUTOSAVE_MS: u64 = 60_000;

/// The debounce for a requested `canvas.autosave_ms`, clamped to a sane range.
pub fn autosave_delay(requested_ms: Option<u64>) -> Duration {
    Duration::from_millis(
        requested_ms
            .unwrap_or(DEFAULT_AUTOSAVE_MS)
            .clamp(MIN_AUTOSAVE_MS, MAX_AUTOSAVE_MS),
    )
}

/// Saved state of a loaded document. `content_version` is `None` until the
/// editor reports one (a new document that was never opened from disk).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Persisted {
    content_version: Option<u64>,
    saved_version: Option<u64>,
    dirty: bool,
    save_error: Option<String>,
}

impl Persisted {
    fn save_due(&self) -> bool {
        self.dirty && self.content_version.is_some() && self.content_version != self.saved_version
    }

    /// The host knows of an edit that is not on disk.
    fn unsaved(&self) -> bool {
        self.dirty || (self.content_version.is_some() && self.content_version != self.saved_version)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Phase {
    Loading,
    Ready(Persisted),
}

/// Where a mount is in its life. `Closing` is the AD-31 quiesce: agent calls
/// are refused `CANVAS_CLOSING` while the host saves; a failed save returns
/// the mount to `Open`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Lifecycle {
    Open,
    Closing,
    Closed,
}

struct MountState {
    phase: Phase,
    lifecycle: Lifecycle,
    /// The renderer connection the editor runs in, once it reported the
    /// mount; `None` until then and after it disconnected.
    connection: Option<gateway::Connection>,
}

/// One mounted document. `generation` is the debounce: every dirty
/// notification bumps it, and a waiter whose generation moved on was
/// superseded. `in_flight` counts agent calls the quiesce waits out.
struct Mount {
    mount_seq: u64,
    doc_path: PathBuf,
    autosave: Duration,
    state: Mutex<MountState>,
    generation: watch::Sender<u64>,
    write_lock: tokio::sync::Mutex<()>,
    in_flight: watch::Sender<usize>,
}

impl Mount {
    fn view(&self) -> PersistenceView {
        let state = self.state.lock();
        PersistenceView::of(self.mount_seq, &state.phase)
    }

    fn bump_generation(&self) -> watch::Receiver<u64> {
        self.generation.send_modify(|generation| *generation += 1);
        self.generation.subscribe()
    }
}

/// The projection the renderer's canvas store holds. Versions are u64 on the
/// engine side and travel as decimal text so no JavaScript number rounds them.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PersistenceView {
    pub mount_seq: u64,
    pub ready: bool,
    pub dirty: bool,
    pub content_version: Option<String>,
    pub saved_version: Option<String>,
    pub save_error: Option<String>,
}

impl PersistenceView {
    fn of(mount_seq: u64, phase: &Phase) -> Self {
        let persisted = match phase {
            Phase::Loading => None,
            Phase::Ready(persisted) => Some(persisted),
        };
        Self {
            mount_seq,
            ready: persisted.is_some(),
            dirty: persisted.is_some_and(|p| p.dirty),
            content_version: persisted.and_then(|p| p.content_version.map(|v| v.to_string())),
            saved_version: persisted.and_then(|p| p.saved_version.map(|v| v.to_string())),
            save_error: persisted.and_then(|p| p.save_error.clone()),
        }
    }
}

/// What a dirty notification resolved to once its debounce settled.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DirtyOutcome {
    /// A later notification (or an unmount) took over this one's timer.
    Superseded,
    /// Nothing to save: clean, already saved, or not loaded yet.
    Idle { view: PersistenceView },
    /// The renderer should snapshot the editor and write it now.
    SaveDue { view: PersistenceView },
}

/// Result of a snapshot write. `mark_saved` is the version the editor must
/// be told it is saved at; `None` when nothing was written.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WriteOutcome {
    pub view: PersistenceView,
    pub mark_saved: Option<String>,
}

/// Writes `bytes` to `path` so a reader sees the old file or the new one,
/// never a torn one. Injected so tests can fail a write.
pub type WriteFn = fn(&Path, &[u8]) -> std::io::Result<()>;

fn write_document(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    crate::web::fs_api::write_unchecked(path, bytes)
}

fn closed() -> CanvasError {
    CanvasError::new(super::CODE_CANVAS_CLOSED, "the canvas is not mounted")
}

pub struct CanvasPersistence {
    mounts: Mutex<HashMap<String, Arc<Mount>>>,
    next_mount_seq: AtomicU64,
    write: WriteFn,
    calls: gateway::Calls,
    /// How long the host's own editor calls (the close sequence's snapshot
    /// and verify) wait for an answer.
    host_call_timeout: Duration,
}

impl Default for CanvasPersistence {
    fn default() -> Self {
        Self::with_writer(write_document)
    }
}

impl CanvasPersistence {
    pub fn with_writer(write: WriteFn) -> Self {
        Self {
            mounts: Mutex::new(HashMap::new()),
            next_mount_seq: AtomicU64::new(0),
            write,
            calls: gateway::Calls::default(),
            host_call_timeout: crate::acp::host_mcp::canvas::DEFAULT_CALL_TIMEOUT,
        }
    }

    #[must_use]
    pub fn with_host_call_timeout(mut self, timeout: Duration) -> Self {
        self.host_call_timeout = timeout;
        self
    }

    /// A fresh `Loading` mount for the project, replacing any previous one.
    /// The returned `mountSeq` is never reused within the process.
    pub fn mount(&self, project_id: &str, doc_path: PathBuf, autosave: Duration) -> u64 {
        let mount_seq = self.next_mount_seq.fetch_add(1, Ordering::Relaxed) + 1;
        self.insert_mount(project_id, mount_seq, doc_path, autosave);
        mount_seq
    }

    fn insert_mount(
        &self,
        project_id: &str,
        mount_seq: u64,
        doc_path: PathBuf,
        autosave: Duration,
    ) {
        let (generation, _) = watch::channel(0);
        let (in_flight, _) = watch::channel(0);
        let mount = Arc::new(Mount {
            mount_seq,
            doc_path,
            autosave,
            state: Mutex::new(MountState {
                phase: Phase::Loading,
                lifecycle: Lifecycle::Open,
                connection: None,
            }),
            generation,
            write_lock: tokio::sync::Mutex::new(()),
            in_flight,
        });
        let previous = self.mounts.lock().insert(project_id.to_string(), mount);
        if let Some(previous) = previous {
            Self::retire(&previous);
        }
    }

    /// Drop the project's mount without saving; waiting debounces resolve
    /// `Superseded` and calls in flight `CANVAS_CLOSED`. Idempotent. Every
    /// user-facing unmount goes through [`Self::close`] instead.
    pub fn unmount(&self, project_id: &str) {
        let removed = self.mounts.lock().remove(project_id);
        if let Some(mount) = removed {
            Self::retire(&mount);
        }
    }

    /// Closed for good: debounces are superseded and dropping the connection
    /// resolves every call still waiting on it.
    fn retire(mount: &Mount) {
        let connection = {
            let mut state = mount.state.lock();
            state.lifecycle = Lifecycle::Closed;
            state.connection.take()
        };
        drop(connection);
        mount.bump_generation();
    }

    /// Every project with a mount.
    pub fn mounted_projects(&self) -> Vec<String> {
        self.mounts.lock().keys().cloned().collect()
    }

    /// The live mount for `(project_id, mount_seq)`; a stale `mount_seq` is
    /// `CANVAS_CLOSED` like a missing mount.
    fn mount_for(&self, project_id: &str, mount_seq: u64) -> Result<Arc<Mount>, CanvasError> {
        self.mounts
            .lock()
            .get(project_id)
            .filter(|mount| mount.mount_seq == mount_seq)
            .cloned()
            .ok_or_else(closed)
    }

    pub fn view(&self, project_id: &str, mount_seq: u64) -> Result<PersistenceView, CanvasError> {
        Ok(self.mount_for(project_id, mount_seq)?.view())
    }

    pub fn doc_path(&self, project_id: &str, mount_seq: u64) -> Result<PathBuf, CanvasError> {
        Ok(self.mount_for(project_id, mount_seq)?.doc_path.clone())
    }

    /// The editor holds the document: `content_version` is the
    /// `host.openDocument` ack, which is also the saved version, or `None`
    /// for a new document that has no file yet. Re-running it resets the
    /// mount to that state.
    pub fn document_loaded(
        &self,
        project_id: &str,
        mount_seq: u64,
        content_version: Option<u64>,
    ) -> Result<PersistenceView, CanvasError> {
        let mount = self.mount_for(project_id, mount_seq)?;
        {
            let mut state = mount.state.lock();
            state.phase = Phase::Ready(Persisted {
                content_version,
                saved_version: content_version,
                dirty: false,
                save_error: None,
            });
        }
        mount.bump_generation();
        Ok(mount.view())
    }

    /// Record the engine's `{dirty, contentVersion}` and, when a save is due,
    /// wait out the debounce. Ignored while `Loading` (AD-31: dirty cannot be
    /// set before the document is loaded).
    pub async fn dirty_changed(
        &self,
        project_id: &str,
        mount_seq: u64,
        dirty: bool,
        content_version: u64,
    ) -> Result<DirtyOutcome, CanvasError> {
        let mount = self.mount_for(project_id, mount_seq)?;
        let loaded = match &mut mount.state.lock().phase {
            Phase::Ready(persisted) => {
                persisted.dirty = dirty;
                persisted.content_version = Some(content_version);
                true
            }
            Phase::Loading => false,
        };
        if !loaded {
            return Ok(DirtyOutcome::Idle { view: mount.view() });
        }
        let mut generation = mount.bump_generation();
        let mine = *generation.borrow_and_update();
        if !Self::due(&mount) {
            return Ok(DirtyOutcome::Idle { view: mount.view() });
        }
        let settled = tokio::time::sleep(mount.autosave);
        tokio::pin!(settled);
        loop {
            tokio::select! {
                () = &mut settled => break,
                changed = generation.changed() => {
                    if changed.is_err() || *generation.borrow_and_update() != mine {
                        return Ok(DirtyOutcome::Superseded);
                    }
                }
            }
        }
        if mount.state.lock().lifecycle == Lifecycle::Closed {
            return Ok(DirtyOutcome::Superseded);
        }
        let view = mount.view();
        Ok(if Self::due(&mount) {
            DirtyOutcome::SaveDue { view }
        } else {
            DirtyOutcome::Idle { view }
        })
    }

    fn due(mount: &Mount) -> bool {
        match &mount.state.lock().phase {
            Phase::Ready(persisted) => persisted.save_due(),
            Phase::Loading => false,
        }
    }

    /// Write a `host.snapshot` taken at `content_version`. Writes are
    /// serialized per mount, a snapshot older than the saved version is
    /// dropped, and `saved_version` advances only after the write returned
    /// `Ok`. A failed write keeps the previous saved version and reports
    /// `save_error` in the view.
    pub async fn write_snapshot(
        &self,
        project_id: &str,
        mount_seq: u64,
        content_version: u64,
        bytes: Vec<u8>,
    ) -> Result<WriteOutcome, CanvasError> {
        let mount = self.mount_for(project_id, mount_seq)?;
        let _serialized = mount.write_lock.lock().await;
        if !is_canvas_document(&mount.doc_path) {
            return Err(CanvasError::new(
                super::CODE_PATH_VALIDATION_FAILED,
                "only .figcraft documents are written by the canvas",
            ));
        }
        {
            let state = mount.state.lock();
            match &state.phase {
                Phase::Loading => {
                    return Err(CanvasError::new(
                        CODE_CANVAS_NOT_READY,
                        "the canvas document has not loaded yet",
                    ))
                }
                Phase::Ready(persisted)
                    if persisted
                        .saved_version
                        .is_some_and(|saved| content_version < saved) =>
                {
                    return Ok(WriteOutcome {
                        view: PersistenceView::of(mount.mount_seq, &state.phase),
                        mark_saved: None,
                    });
                }
                Phase::Ready(_) => {}
            }
        }
        let write = self.write;
        let path = mount.doc_path.clone();
        let written = tokio::task::spawn_blocking(move || write(&path, &bytes))
            .await
            .unwrap_or_else(|join| Err(std::io::Error::other(join.to_string())));
        let mut state = mount.state.lock();
        let Phase::Ready(persisted) = &mut state.phase else {
            return Err(closed());
        };
        let mark_saved = match written {
            Ok(()) => {
                persisted.saved_version = Some(
                    persisted
                        .saved_version
                        .map_or(content_version, |saved| saved.max(content_version)),
                );
                persisted.save_error = None;
                Some(content_version.to_string())
            }
            Err(error) => {
                persisted.save_error =
                    Some(format!("could not write the canvas document: {error}"));
                None
            }
        };
        Ok(WriteOutcome {
            view: PersistenceView::of(mount.mount_seq, &state.phase),
            mark_saved,
        })
    }
}

fn is_canvas_document(path: &Path) -> bool {
    path.extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("figcraft"))
}

/// The process-wide registry both transports and the agent gateway share,
/// like `bundle_tokens`.
pub fn canvas_mounts() -> &'static Arc<CanvasPersistence> {
    static MOUNTS: OnceLock<Arc<CanvasPersistence>> = OnceLock::new();
    MOUNTS.get_or_init(Arc::default)
}

#[cfg(test)]
impl CanvasPersistence {
    /// Gateway tests name their own mountSeq: make the project's mount that
    /// one (a fresh `Loading` mount) unless it already is.
    pub(crate) fn ensure_test_mount(&self, project_id: &str, mount_seq: u64) {
        let current = self
            .mounts
            .lock()
            .get(project_id)
            .map(|mount| mount.mount_seq);
        if current != Some(mount_seq) {
            self.insert_mount(
                project_id,
                mount_seq,
                PathBuf::from(format!("{project_id}.figcraft")),
                Duration::from_millis(DEFAULT_AUTOSAVE_MS),
            );
        }
    }
}
