//! The AD-31 unmount sequence every unmount runs (project close, app quit,
//! and later eviction and lease loss):
//!
//! 1. quiesce: agent calls get `CANVAS_CLOSING`; calls in flight drain;
//! 2. save: an immediate `host.snapshot` written regardless of the debounce;
//! 3. verify: `host.markSaved` reports the editor clean at the saved version;
//! 4. unmount: the mount leaves the registry and calls still waiting on its
//!    connection resolve `CANVAS_CLOSED`.
//!
//! A failed save or verify reopens the mount and returns `SAVE_FAILED`: the
//! caller asks the user, and only an explicit [`CloseMode::Discard`] drops
//! unsaved work.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::{wire, CanvasPersistence, Lifecycle, Mount, Persisted, Phase};
use crate::canvas::{CanvasError, CODE_CANVAS_CLOSING, CODE_SAVE_FAILED};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CloseMode {
    /// Save and verify before unmounting; refuse to unmount on failure.
    Save,
    /// The user chose to drop unsaved changes.
    Discard,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloseOutcome {
    /// False when the project had no mount.
    pub unmounted: bool,
    /// The version on disk when the mount closed; `None` for a document
    /// never written or a discard.
    pub saved_version: Option<String>,
    /// Unsaved changes were dropped on the user's say-so.
    pub discarded: bool,
}

impl CloseOutcome {
    const NOT_MOUNTED: Self = Self {
        unmounted: false,
        saved_version: None,
        discarded: false,
    };
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarkedReply {
    dirty: bool,
    content_version: u64,
}

fn save_failed(message: impl Into<String>) -> CanvasError {
    CanvasError::new(CODE_SAVE_FAILED, message)
}

impl CanvasPersistence {
    /// Run the AD-31 sequence on `project_id`'s mount. Idempotent: a project
    /// with no mount answers `unmounted: false`.
    ///
    /// # Errors
    /// `CANVAS_CLOSING` while another close of the project runs;
    /// `SAVE_FAILED` (the mount stays open) when the save or its verify
    /// failed under [`CloseMode::Save`].
    pub async fn close(
        &self,
        project_id: &str,
        mode: CloseMode,
    ) -> Result<CloseOutcome, CanvasError> {
        let Some(mount) = self.mounts.lock().get(project_id).cloned() else {
            return Ok(CloseOutcome::NOT_MOUNTED);
        };
        {
            let mut state = mount.state.lock();
            match state.lifecycle {
                Lifecycle::Closed => return Ok(CloseOutcome::NOT_MOUNTED),
                Lifecycle::Closing => {
                    return Err(CanvasError::new(
                        CODE_CANVAS_CLOSING,
                        "this canvas is already closing",
                    ))
                }
                Lifecycle::Open => state.lifecycle = Lifecycle::Closing,
            }
        }
        let _ = mount
            .in_flight
            .subscribe()
            .wait_for(|count| *count == 0)
            .await;
        let phase = mount.state.lock().phase.clone();

        let (saved, discarded) = match (mode, phase) {
            (CloseMode::Discard, Phase::Ready(persisted)) => (None, persisted.unsaved()),
            (_, Phase::Loading) => (None, false),
            (CloseMode::Save, Phase::Ready(persisted)) => {
                match self.flush(project_id, &mount, &persisted).await {
                    Ok(saved) => (saved, false),
                    Err(error) => {
                        Self::reopen(&mount);
                        return Err(error);
                    }
                }
            }
        };

        let removed = {
            let mut mounts = self.mounts.lock();
            let current = mounts
                .get(project_id)
                .is_some_and(|live| Arc::ptr_eq(live, &mount));
            if current {
                mounts.remove(project_id);
            }
            current
        };
        Self::retire(&mount);
        Ok(CloseOutcome {
            unmounted: removed,
            saved_version: saved.map(|version| version.to_string()),
            discarded,
        })
    }

    /// Close every mount, saving each; the failures are returned, not asked
    /// about (app exit has no one left to ask).
    pub async fn close_all(&self) -> Vec<(String, Result<CloseOutcome, CanvasError>)> {
        let projects = self.mounted_projects();
        let closes = projects.iter().map(|project| async move {
            (project.clone(), self.close(project, CloseMode::Save).await)
        });
        futures::future::join_all(closes).await
    }

    fn reopen(mount: &Mount) {
        let mut state = mount.state.lock();
        if state.lifecycle == Lifecycle::Closing {
            state.lifecycle = Lifecycle::Open;
        }
    }

    /// Save and verify; the saved version, `None` for a new document nobody
    /// edited.
    async fn flush(
        &self,
        project_id: &str,
        mount: &Mount,
        persisted: &Persisted,
    ) -> Result<Option<u64>, CanvasError> {
        let mount_seq = mount.mount_seq;
        if !persisted.unsaved() {
            let Some(saved) = persisted.saved_version else {
                return Ok(None);
            };
            // The host's dirty state can trail the editor by one notification
            // in flight; the editor itself says whether it is still at the
            // saved version. An editor that cannot answer has nothing the
            // host knows of to lose.
            match self.mark_saved(project_id, mount_seq, saved).await {
                Ok(marked) if !marked.dirty && marked.content_version == saved => {
                    return Ok(Some(saved))
                }
                Ok(_) => {}
                Err(_) => return Ok(Some(saved)),
            }
        }

        let snapshot = self
            .host_call(project_id, mount_seq, "host.snapshot", "{}")
            .await
            .map_err(|error| {
                save_failed(format!(
                    "could not snapshot the canvas ({}): {}",
                    error.code.as_str(),
                    error.message
                ))
            })?;
        let written = wire::write_snapshot(self, project_id, mount_seq, &snapshot).await?;
        if let Some(error) = written.view.save_error {
            return Err(save_failed(error));
        }
        let saved = written
            .view
            .saved_version
            .as_deref()
            .and_then(|text| text.parse::<u64>().ok())
            .ok_or_else(|| save_failed("the canvas has no saved version after the write"))?;

        let marked = self
            .mark_saved(project_id, mount_seq, saved)
            .await
            .map_err(|error| {
                save_failed(format!("could not verify the save: {}", error.message))
            })?;
        if marked.dirty || marked.content_version != saved {
            return Err(save_failed(
                "the canvas changed while it was being saved; save again",
            ));
        }
        Ok(Some(saved))
    }

    async fn mark_saved(
        &self,
        project_id: &str,
        mount_seq: u64,
        version: u64,
    ) -> Result<MarkedReply, crate::acp::host_mcp::canvas::CanvasError> {
        let reply = self
            .host_call(
                project_id,
                mount_seq,
                "host.markSaved",
                &format!(r#"{{"contentVersion":{version}}}"#),
            )
            .await?;
        serde_json::from_str(&reply).map_err(|error| {
            crate::acp::host_mcp::canvas::CanvasError::new(
                crate::acp::host_mcp::canvas::CanvasErrorCode::EngineError,
                format!("invalid host.markSaved reply: {error}"),
            )
        })
    }
}
