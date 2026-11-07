//! The mount lease (spine AD-30): one lease per project's document per host,
//! held by the renderer that opened it, a desktop window or a browser tab.
//!
//! The newest opener takes the lease. When another renderer holds it, the
//! holder's mount runs the AD-31 close first (quiesce, save, verify,
//! unmount), the holder is told it lost the lease, and only then does the
//! opener get a mount. If that save fails, the opener is refused
//! `CANVAS_OPEN_ELSEWHERE` and the holder keeps its mount.
//!
//! The lease names a renderer, not a connection: a reload or a socket
//! reconnect is a new `/ws` connection from the same `clientInstanceId`, so
//! the holder can take its mount up again within the grace
//! ([`super::gateway`]) or re-open it with a new `mountSeq`.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use super::{Admitted, CanvasPersistence, CloseMode, CloseOutcome, Mount, PersistenceView};
use crate::acp::host_mcp::canvas::LeaseLostReason;
use crate::canvas::{CanvasError, CODE_CANVAS_OPEN_ELSEWHERE, CODE_PATH_VALIDATION_FAILED};

/// `canvas.lease_grace_ms` when the renderer sends none.
pub const DEFAULT_LEASE_GRACE_MS: u64 = 5000;
const MAX_LEASE_GRACE_MS: u64 = 60_000;

/// How long a holder whose connection ended keeps its lease, clamped.
pub fn lease_grace(requested_ms: Option<u64>) -> Duration {
    Duration::from_millis(
        requested_ms
            .unwrap_or(DEFAULT_LEASE_GRACE_MS)
            .min(MAX_LEASE_GRACE_MS),
    )
}

/// A renderer that can hold a lease, named by the `clientInstanceId` it
/// presents on `/ws` `authenticate`. Unlike a connection id it survives a
/// reload of that window or tab.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RendererId(String);

impl RendererId {
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    /// A `clientInstanceId` from a request, held to the rule `/ws`
    /// `authenticate` applies to it (it reaches log lines).
    ///
    /// # Errors
    /// `INVALID_PAYLOAD` for an empty, oversized or control-character id.
    pub fn parse(id: String) -> Result<Self, CanvasError> {
        if id.is_empty()
            || id.len() > crate::web::ws::MAX_CLIENT_ID_LEN
            || id.chars().any(char::is_control)
        {
            return Err(CanvasError::new(
                super::CODE_INVALID_PAYLOAD,
                "clientInstanceId must be a non-empty id without control characters",
            ));
        }
        Ok(Self(id))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The first 8 characters, like `ClientIdentity::log_label`.
    pub fn log_label(&self) -> String {
        self.0.chars().take(8).collect()
    }
}

/// What a renderer's open asks for.
#[derive(Debug, Clone)]
pub struct MountRequest {
    pub renderer: RendererId,
    pub doc_path: PathBuf,
    pub autosave: Duration,
    /// `canvas.autosave_max_ms` ([`super::autosave_max_wait`]).
    pub autosave_max: Duration,
    pub lease_grace: Duration,
    /// `canvas.crash_timeouts` ([`super::crash_timeouts`]).
    pub crash_timeouts: u32,
}

#[cfg(test)]
impl MountRequest {
    pub(crate) fn for_test(doc_path: PathBuf, autosave: Duration) -> Self {
        Self {
            renderer: super::test_renderer(),
            doc_path,
            autosave,
            autosave_max: super::autosave_max_wait(None),
            lease_grace: lease_grace(None),
            crash_timeouts: super::DEFAULT_CRASH_TIMEOUTS,
        }
    }
}

/// How the lease moved when a renderer opened the canvas.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LeaseChange {
    /// Nobody held it.
    Granted,
    /// The holder opened again (a reload, or a remount after a failure).
    /// Its previous mount was dropped without a save: the page that ran it
    /// is gone, so its last autosave stands.
    Remounted { previous: u64 },
    /// Another renderer held it. Its mount was saved and unmounted first.
    TakenOver {
        previous: u64,
        saved_version: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Opened {
    pub mount_seq: u64,
    pub lease: LeaseChange,
}

/// What a mount dropped at the end of its grace left behind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpiredLease {
    pub saved_version: Option<String>,
    /// The host knew of an edit newer than the file on disk.
    pub unsaved: bool,
}

impl ExpiredLease {
    pub(super) fn of(view: &PersistenceView) -> Self {
        Self {
            saved_version: view.saved_version.clone(),
            unsaved: view.dirty || view.content_version != view.saved_version,
        }
    }
}

fn refused_takeover(error: &CanvasError) -> CanvasError {
    CanvasError::new(
        CODE_CANVAS_OPEN_ELSEWHERE,
        format!(
            "This canvas is open in another window, and it could not be saved there ({}: {}). \
             It stays open in that window.",
            error.code, error.message
        ),
    )
}

impl CanvasPersistence {
    /// A fresh `Loading` mount of the project's document for `request`'s
    /// renderer, which then holds the lease. Room is made under the mount
    /// `cap` first ([`super::evict`]); when another renderer holds the lease, that
    /// mount is closed through AD-31 and its renderer is told.
    ///
    /// `opened` is `PATH_VALIDATION_FAILED` for a document that is not a
    /// `.figcraft` file (nothing is evicted for it), `EVICTION_BLOCKED` when a
    /// victim could not be saved, or `CANVAS_OPEN_ELSEWHERE` when the
    /// holder's save failed or it was already closing; the holder keeps the
    /// lease.
    pub async fn open(&self, project_id: &str, request: MountRequest, cap: usize) -> Admitted {
        if !super::is_canvas_document(&request.doc_path) {
            return Admitted {
                evicted: Vec::new(),
                opened: Err(CanvasError::new(
                    CODE_PATH_VALIDATION_FAILED,
                    "a canvas opens only .figcraft documents",
                )),
            };
        }
        let _admitting = self.admission.lock().await;
        let mut evicted = Vec::new();
        let host_cap = self.host_cap(cap);
        let opened = match self.make_room(project_id, host_cap, &mut evicted).await {
            Ok(()) => self.lease(project_id, &request, cap).await,
            Err(error) => Err(error),
        };
        Admitted { evicted, opened }
    }

    async fn lease(
        &self,
        project_id: &str,
        request: &MountRequest,
        cap: usize,
    ) -> Result<Opened, CanvasError> {
        loop {
            let current = self.mounts.lock().get(project_id).cloned();
            let (lease, expected) = match &current {
                None => (LeaseChange::Granted, None),
                // The same renderer id with its page gone (reloaded) remounts
                // without a save. A page still attached is another live tab
                // that copied the id (a duplicated tab copies sessionStorage):
                // it is taken over like any other holder.
                Some(mount)
                    if mount.holder == request.renderer
                        && mount.state.lock().link.connection().is_none() =>
                {
                    (
                        LeaseChange::Remounted {
                            previous: mount.mount_seq,
                        },
                        Some(mount),
                    )
                }
                Some(mount) => match self.take_over(project_id, mount).await {
                    Ok(lease) => (lease, None),
                    // The same renderer's page went away during the save: it
                    // was a reload that got here first, remounted next pass.
                    Err(_)
                        if mount.holder == request.renderer
                            && mount.state.lock().link.connection().is_none() =>
                    {
                        continue
                    }
                    Err(error) => return Err(error),
                },
            };
            let mount_seq = self.next_mount_seq();
            let mount = Mount::new(mount_seq, self.tick(), request.clone(), cap, None);
            if self.install(project_id, expected, mount) {
                return Ok(Opened { mount_seq, lease });
            }
        }
    }

    /// Close `mount` through AD-31 with a save, then tell the renderer running
    /// it why it lost the canvas. A takeover and an eviction both unmount
    /// another renderer's canvas this way.
    pub(super) async fn save_and_unmount(
        &self,
        project_id: &str,
        mount: &Arc<Mount>,
        reason: LeaseLostReason,
    ) -> Result<CloseOutcome, CanvasError> {
        let connected = mount
            .state
            .lock()
            .link
            .connection()
            .map(|connection| connection.holder().clone());
        let closed = self
            .close_mount(project_id, mount.mount_seq, CloseMode::Save)
            .await?;
        if let Some(renderer) = connected.filter(|_| closed.unmounted) {
            renderer.tell_lease_lost(project_id, mount.mount_seq, reason);
        }
        Ok(closed)
    }

    async fn take_over(
        &self,
        project_id: &str,
        holder: &Arc<Mount>,
    ) -> Result<LeaseChange, CanvasError> {
        let closed = self
            .save_and_unmount(project_id, holder, LeaseLostReason::TakenOver)
            .await
            .map_err(|error| refused_takeover(&error))?;
        Ok(LeaseChange::TakenOver {
            previous: holder.mount_seq,
            saved_version: closed.saved_version,
        })
    }

    /// Put `mount` in the project's slot if the slot still holds `expected`,
    /// and retire what it replaced. False when another open, close or remount
    /// changed the slot first. Every mount enters the registry here.
    pub(super) fn install(
        &self,
        project_id: &str,
        expected: Option<&Arc<Mount>>,
        mount: Arc<Mount>,
    ) -> bool {
        let previous = {
            let mut mounts = self.mounts.lock();
            let unchanged = match (mounts.get(project_id), expected) {
                (None, None) => true,
                (Some(live), Some(expected)) => Arc::ptr_eq(live, expected),
                _ => false,
            };
            if !unchanged {
                return false;
            }
            mounts.insert(project_id.to_string(), mount)
        };
        if let Some(previous) = previous {
            Self::retire(&previous);
        }
        true
    }
}
