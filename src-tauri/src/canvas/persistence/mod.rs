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
//! AD-31 sequence ([`close`]). A mount is the project's lease (AD-30): it
//! belongs to the renderer that opened it, and another renderer gets it only
//! through [`CanvasPersistence::open`]'s takeover ([`lease`]).
//!
//! At most `canvas.max_mounted` mounts live at once (AD-26): each mount
//! records when it was last active (an agent call or the user viewing it), and
//! [`CanvasPersistence::open`] evicts the least recently active one through
//! [`CanvasPersistence::close`] before it makes room for another.
//!
//! A mount also remembers what Termul last read from or wrote to its file,
//! so a change on disk is told apart from Termul's own write and never
//! overwritten unseen ([`disk`], AD-27), and it counts timed-out calls to
//! notice a dead editor and remount it ([`crash`]).
//!
//! Tauri-free so the desktop commands and termul-server's routes share it.
//! The transports log at their boundary, never bytes; a remount is logged
//! where it happens, since a timeout-driven one has no transport call.

mod close;
mod crash;
mod disk;
mod evict;
mod gateway;
mod lease;
mod wire;

#[cfg(test)]
mod close_tests;
#[cfg(test)]
mod crash_tests;
#[cfg(test)]
mod disk_tests;
#[cfg(test)]
mod evict_tests;
#[cfg(test)]
mod gateway_tests;
#[cfg(test)]
mod lease_tests;
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
use crate::web::fs_api::{CheckedWrite, Expected};

pub use close::{CloseMode, CloseOutcome};
pub use crash::{crash_timeouts, LostChanges, Remount, DEFAULT_CRASH_TIMEOUTS, REMOUNTED_METHOD};
pub use disk::{ConflictChoice, ConflictView, DiskOutcome, ResolveOutcome, CODE_DOCUMENT_DELETED};
pub use evict::{mount_cap, Admitted, Eviction, CODE_EVICTION_BLOCKED, DEFAULT_MAX_MOUNTED};
pub use gateway::{CallFailed, LateAnswer, LostLease, ReplyMatch, SliceMatch};
pub use lease::{
    lease_grace, ExpiredLease, LeaseChange, MountRequest, Opened, RendererId,
    DEFAULT_LEASE_GRACE_MS,
};
pub use wire::{
    dirty_changed, disk_changed, document_loaded, parse_version, read_document, resolve_conflict,
    write_snapshot, DocumentBytes, CODE_CANVAS_NOT_READY, CODE_INVALID_PAYLOAD, CODE_READ_FAILED,
};

/// `canvas.autosave_ms` when the renderer sends none.
pub const DEFAULT_AUTOSAVE_MS: u64 = 1500;
const MIN_AUTOSAVE_MS: u64 = 100;
const MAX_AUTOSAVE_MS: u64 = 60_000;

/// `canvas.autosave_max_ms` when the renderer sends none.
pub const DEFAULT_AUTOSAVE_MAX_MS: u64 = 10_000;
const MAX_AUTOSAVE_MAX_MS: u64 = 600_000;

/// The debounce for a requested `canvas.autosave_ms`, clamped to a sane range.
pub fn autosave_delay(requested_ms: Option<u64>) -> Duration {
    Duration::from_millis(
        requested_ms
            .unwrap_or(DEFAULT_AUTOSAVE_MS)
            .clamp(MIN_AUTOSAVE_MS, MAX_AUTOSAVE_MS),
    )
}

/// The longest a dirty document waits for a save for a requested
/// `canvas.autosave_max_ms`, clamped to a sane range: a steady stream of
/// edits (an agent driving the canvas) supersedes the debounce forever
/// otherwise.
pub fn autosave_max_wait(requested_ms: Option<u64>) -> Duration {
    Duration::from_millis(
        requested_ms
            .unwrap_or(DEFAULT_AUTOSAVE_MAX_MS)
            .clamp(MIN_AUTOSAVE_MS, MAX_AUTOSAVE_MAX_MS),
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
    /// The file changed on disk while the editor held unsaved work (AD-27).
    /// Autosave is suppressed until the user resolves it.
    conflict: Option<disk::Conflict>,
    /// The file handed to the editor to load (a reload, or the user taking
    /// the disk's version). Until the editor loaded it the editor still holds
    /// the old content, so nothing is written; the file becomes the one the
    /// next write replaces once it has.
    reloading: Option<Expected>,
    /// Wall-clock ms of the first edit not on disk; shown when a crash
    /// loses it.
    unsaved_since: Option<u64>,
}

impl Persisted {
    fn save_due(&self) -> bool {
        self.dirty
            && self.conflict.is_none()
            && self.content_version.is_some()
            && self.content_version != self.saved_version
    }

    /// The host knows of an edit that is not on disk.
    fn unsaved(&self) -> bool {
        self.dirty || (self.content_version.is_some() && self.content_version != self.saved_version)
    }

    fn track_unsaved_since(&mut self) {
        if !self.unsaved() {
            self.unsaved_since = None;
        } else if self.unsaved_since.is_none() {
            self.unsaved_since = Some(crash::now_ms());
        }
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

/// How the lease holder reaches its mount.
enum Link {
    /// The holder has not reported the connection its editor runs in yet,
    /// or reported that it no longer runs it.
    Unattached,
    Attached(gateway::Connection),
    /// The holder's connection ended at `since`. The holder keeps the lease
    /// for the mount's grace so a reconnect or reload can take it up again.
    /// On the tokio clock, like the grace timer that reads it. Agent calls
    /// that arrive meanwhile wait on `ended`, which is never sent on:
    /// replacing this state drops it and wakes them.
    Lost {
        since: tokio::time::Instant,
        ended: watch::Sender<()>,
    },
}

impl Link {
    fn lost() -> Self {
        Self::Lost {
            since: tokio::time::Instant::now(),
            ended: watch::channel(()).0,
        }
    }

    fn connection(&self) -> Option<&gateway::Connection> {
        match self {
            Self::Attached(connection) => Some(connection),
            Self::Unattached | Self::Lost { .. } => None,
        }
    }
}

/// What decides eviction order: when the mount was last active (a position
/// on the registry's clock, so ties cannot happen) and whether a user is
/// looking at it right now. A viewed mount outranks every unviewed one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Activity {
    tick: u64,
    visible: bool,
}

impl Activity {
    /// Smaller is evicted first.
    fn rank(self) -> (bool, u64) {
        (self.visible, self.tick)
    }
}

struct MountState {
    phase: Phase,
    lifecycle: Lifecycle,
    activity: Activity,
    link: Link,
    /// The file as Termul last read or wrote it; `None` before the first
    /// read. A write is checked against it, and a watcher event whose file
    /// still matches it is Termul's own write.
    disk: Option<Expected>,
    /// Consecutive stalls (calls that timed out) on this ready mount.
    timeouts: u32,
    /// When the last counted timeout fired.
    stall_counted_at: Option<tokio::time::Instant>,
    /// When the oldest edit no save was handed out for was reported; a save
    /// is due `autosave_max` after it however often edits supersede the
    /// debounce.
    unsaved_wait_since: Option<tokio::time::Instant>,
}

/// One mounted document, leased to `holder`. `generation` is the debounce:
/// every dirty notification bumps it, and a waiter whose generation moved on
/// was superseded. `in_flight` counts agent calls the quiesce waits out.
struct Mount {
    mount_seq: u64,
    holder: RendererId,
    doc_path: PathBuf,
    autosave: Duration,
    autosave_max: Duration,
    lease_grace: Duration,
    /// `canvas.crash_timeouts`: consecutive timeouts that mark it crashed.
    crash_timeouts: u32,
    /// The `canvas.max_mounted` it was opened under; the host keeps the
    /// highest of these ([`evict`]).
    max_mounted: usize,
    /// The crash this mount replaced, so a late report of it answers the
    /// same remount instead of starting another.
    remounted_from: Option<Remount>,
    state: Mutex<MountState>,
    generation: watch::Sender<u64>,
    write_lock: tokio::sync::Mutex<()>,
    in_flight: watch::Sender<usize>,
}

impl Mount {
    /// A fresh `Loading` mount; `remounted_from` when it replaces a crashed
    /// one.
    fn new(
        mount_seq: u64,
        tick: u64,
        request: MountRequest,
        max_mounted: usize,
        remounted_from: Option<Remount>,
    ) -> Arc<Self> {
        let (generation, _) = watch::channel(0);
        let (in_flight, _) = watch::channel(0);
        Arc::new(Self {
            mount_seq,
            holder: request.renderer,
            doc_path: request.doc_path,
            autosave: request.autosave,
            autosave_max: request.autosave_max,
            lease_grace: request.lease_grace,
            crash_timeouts: request.crash_timeouts,
            max_mounted,
            remounted_from,
            state: Mutex::new(MountState {
                phase: Phase::Loading,
                lifecycle: Lifecycle::Open,
                activity: Activity {
                    tick,
                    visible: false,
                },
                link: Link::Unattached,
                disk: None,
                timeouts: 0,
                stall_counted_at: None,
                unsaved_wait_since: None,
            }),
            generation,
            write_lock: tokio::sync::Mutex::new(()),
            in_flight,
        })
    }

    /// What a fresh mount of the same document for the same holder asks for.
    fn request(&self) -> MountRequest {
        MountRequest {
            renderer: self.holder.clone(),
            doc_path: self.doc_path.clone(),
            autosave: self.autosave,
            autosave_max: self.autosave_max,
            lease_grace: self.lease_grace,
            crash_timeouts: self.crash_timeouts,
        }
    }

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
    pub conflict: Option<ConflictView>,
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
            conflict: persisted.and_then(|p| p.conflict.as_ref().map(disk::Conflict::view)),
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
/// never a torn one, and only while the file is still `expected` (`None`:
/// unchecked). Injected so tests can fail a write.
pub type WriteFn = fn(&Path, &[u8], Option<&Expected>) -> std::io::Result<CheckedWrite>;

fn write_document(
    path: &Path,
    bytes: &[u8],
    expected: Option<&Expected>,
) -> std::io::Result<CheckedWrite> {
    match expected {
        Some(expected) => crate::web::fs_api::write_checked(path, bytes, expected, false),
        None => crate::web::fs_api::write_unchecked(path, bytes).map(|()| CheckedWrite::Written),
    }
}

fn closed() -> CanvasError {
    CanvasError::new(super::CODE_CANVAS_CLOSED, "the canvas is not mounted")
}

pub struct CanvasPersistence {
    mounts: Mutex<HashMap<String, Arc<Mount>>>,
    next_mount_seq: AtomicU64,
    /// Orders [`Activity`] across mounts.
    clock: AtomicU64,
    /// Serializes [`Self::open`], so two opens cannot both see room.
    admission: tokio::sync::Mutex<()>,
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
            clock: AtomicU64::new(0),
            admission: tokio::sync::Mutex::new(()),
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

    /// A `mountSeq` never used before within the process.
    fn next_mount_seq(&self) -> u64 {
        self.next_mount_seq.fetch_add(1, Ordering::Relaxed) + 1
    }

    fn tick(&self) -> u64 {
        self.clock.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// The user started or stopped looking at the project's canvas. Reporting
    /// either way counts as activity.
    ///
    /// # Errors
    /// `CANVAS_CLOSED` for a missing or stale mount (an evicted canvas
    /// answers this to a renderer that still shows it).
    pub fn set_visible(
        &self,
        project_id: &str,
        mount_seq: u64,
        visible: bool,
    ) -> Result<(), CanvasError> {
        let mount = self.mount_for(project_id, mount_seq)?;
        let tick = self.tick();
        let mut state = mount.state.lock();
        if state.lifecycle == Lifecycle::Closed {
            return Err(closed());
        }
        state.activity = Activity { tick, visible };
        Ok(())
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
        let link = {
            let mut state = mount.state.lock();
            state.lifecycle = Lifecycle::Closed;
            std::mem::replace(&mut state.link, Link::Unattached)
        };
        drop(link);
        mount.bump_generation();
    }

    /// Run `release` only while the project has no mount, under the registry
    /// lock, so an open cannot install a mount between the check and the
    /// release.
    pub fn when_unmounted(&self, project_id: &str, release: impl FnOnce()) {
        let mounts = self.mounts.lock();
        if !mounts.contains_key(project_id) {
            release();
        }
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
            if let Phase::Ready(Persisted {
                reloading: Some(handed),
                ..
            }) = &state.phase
            {
                state.disk = Some(handed.clone());
            }
            state.phase = Phase::Ready(Persisted {
                content_version,
                saved_version: content_version,
                ..Persisted::default()
            });
            state.timeouts = 0;
            state.stall_counted_at = None;
            state.unsaved_wait_since = None;
        }
        mount.bump_generation();
        Ok(mount.view())
    }

    /// Record the engine's `{dirty, contentVersion}` and, when a save is due,
    /// wait out the debounce, but never past `autosave_max` from the oldest
    /// edit no save was handed out for. Ignored while `Loading` (AD-31: dirty
    /// cannot be set before the document is loaded).
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
                persisted.track_unsaved_since();
                true
            }
            Phase::Loading => false,
        };
        if !loaded {
            return Ok(DirtyOutcome::Idle { view: mount.view() });
        }
        let mut generation = mount.bump_generation();
        let mine = *generation.borrow_and_update();
        let settles_at = {
            let mut state = mount.state.lock();
            let due = matches!(&state.phase, Phase::Ready(persisted) if persisted.save_due());
            if !due {
                state.unsaved_wait_since = None;
                drop(state);
                return Ok(DirtyOutcome::Idle { view: mount.view() });
            }
            let now = tokio::time::Instant::now();
            let waiting_since = *state.unsaved_wait_since.get_or_insert(now);
            (now + mount.autosave).min(waiting_since + mount.autosave_max)
        };
        let settled = tokio::time::sleep_until(settles_at);
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
        let due = {
            let mut state = mount.state.lock();
            state.unsaved_wait_since = None;
            matches!(&state.phase, Phase::Ready(persisted) if persisted.save_due())
        };
        let view = mount.view();
        Ok(if due {
            DirtyOutcome::SaveDue { view }
        } else {
            DirtyOutcome::Idle { view }
        })
    }

    /// Write a `host.snapshot` taken at `content_version`. Writes are
    /// serialized per mount, a snapshot older than the saved version is
    /// dropped, and `saved_version` advances only after the write returned
    /// `Ok`. A failed write keeps the previous saved version and reports
    /// `save_error` in the view.
    ///
    /// The write only replaces the file Termul last read or wrote (AD-27):
    /// a file that changed on disk since is not overwritten, and the view
    /// comes back with the conflict instead. Nothing is written while a
    /// conflict is open.
    pub async fn write_snapshot(
        &self,
        project_id: &str,
        mount_seq: u64,
        content_version: u64,
        bytes: Vec<u8>,
    ) -> Result<WriteOutcome, CanvasError> {
        let mount = self.mount_for(project_id, mount_seq)?;
        let _serialized = mount.write_lock.lock().await;
        let expected = {
            let state = mount.state.lock();
            match &state.phase {
                Phase::Loading => {
                    return Err(CanvasError::new(
                        CODE_CANVAS_NOT_READY,
                        "the canvas document has not loaded yet",
                    ))
                }
                Phase::Ready(persisted) if persisted.reloading.is_some() => {
                    return Err(CanvasError::new(
                        CODE_CANVAS_NOT_READY,
                        "the canvas is loading the document from disk; save again once it has",
                    ))
                }
                Phase::Ready(persisted)
                    if persisted.conflict.is_some()
                        || persisted
                            .saved_version
                            .is_some_and(|saved| content_version < saved) =>
                {
                    return Ok(WriteOutcome {
                        view: PersistenceView::of(mount.mount_seq, &state.phase),
                        mark_saved: None,
                    });
                }
                Phase::Ready(_) => state.disk.clone(),
            }
        };
        let write = self.write;
        let path = mount.doc_path.clone();
        let written_hash = crate::web::fs_api::sha256_hex(&bytes);
        let written = tokio::task::spawn_blocking(move || {
            let written = write(&path, &bytes, expected.as_ref())?;
            Ok(match written {
                CheckedWrite::Written => None,
                CheckedWrite::Stale => Some(disk::fingerprint(&path)?),
            })
        })
        .await
        .unwrap_or_else(|join| Err(std::io::Error::other(join.to_string())));
        let mut state = mount.state.lock();
        let MountState { phase, disk, .. } = &mut *state;
        let Phase::Ready(persisted) = phase else {
            return Err(closed());
        };
        let mark_saved = match written {
            Ok(None) => {
                *disk = Some(Expected::Sha256(written_hash));
                persisted.saved_version = Some(
                    persisted
                        .saved_version
                        .map_or(content_version, |saved| saved.max(content_version)),
                );
                persisted.save_error = None;
                persisted.track_unsaved_since();
                Some(content_version.to_string())
            }
            Ok(Some(on_disk)) => {
                persisted.conflict = Some(disk::Conflict::new(on_disk, persisted.content_version));
                None
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

/// The renderer that holds every mount tests create without naming one.
#[cfg(test)]
pub(crate) const TEST_RENDERER: &str = "test-renderer";

#[cfg(test)]
pub(crate) fn test_renderer() -> RendererId {
    RendererId::new(TEST_RENDERER)
}

#[cfg(test)]
impl CanvasPersistence {
    /// A fresh `Loading` mount for the project, held by [`TEST_RENDERER`],
    /// replacing any previous one without a save.
    pub(crate) fn mount(&self, project_id: &str, doc_path: PathBuf, autosave: Duration) -> u64 {
        self.mount_configured(project_id, doc_path, autosave, DEFAULT_CRASH_TIMEOUTS)
    }

    /// [`Self::mount`] with `canvas.crash_timeouts`.
    pub(crate) fn mount_configured(
        &self,
        project_id: &str,
        doc_path: PathBuf,
        autosave: Duration,
        crash_timeouts: u32,
    ) -> u64 {
        let mount_seq = self.next_mount_seq();
        self.replace_mount(
            project_id,
            mount_seq,
            MountRequest {
                crash_timeouts,
                ..MountRequest::for_test(doc_path, autosave)
            },
        );
        mount_seq
    }

    /// Gateway tests name their own mountSeq: make the project's mount that
    /// one (a fresh `Loading` mount held by [`TEST_RENDERER`]) unless it
    /// already is.
    pub(crate) fn ensure_test_mount(&self, project_id: &str, mount_seq: u64) {
        let current = self
            .mounts
            .lock()
            .get(project_id)
            .map(|mount| mount.mount_seq);
        if current != Some(mount_seq) {
            self.replace_mount(
                project_id,
                mount_seq,
                MountRequest::for_test(
                    PathBuf::from(format!("{project_id}.figcraft")),
                    Duration::from_millis(DEFAULT_AUTOSAVE_MS),
                ),
            );
        }
    }

    fn replace_mount(&self, project_id: &str, mount_seq: u64, request: MountRequest) {
        let previous = self.mounts.lock().insert(
            project_id.to_string(),
            Mount::new(mount_seq, self.tick(), request, DEFAULT_MAX_MOUNTED, None),
        );
        if let Some(previous) = previous {
            Self::retire(&previous);
        }
    }
}
