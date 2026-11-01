//! Changes to the document file made outside Termul (spine AD-27). Termul's
//! file watcher reports that the file changed; this module decides what that
//! means against the file as Termul last read or wrote it (`MountState::disk`):
//!
//! - the file still matches: Termul's own atomic write, or no change;
//! - it changed and the editor holds nothing unsaved: reload it silently;
//! - it changed (or was deleted) and the editor holds unsaved work: a
//!   conflict, autosave stops, and the user picks keep mine, take disk, or
//!   save a copy.
//!
//! The editor never reads disk: a reload hands it the bytes read here.

use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};

use super::{closed, CanvasPersistence, MountState, PersistenceView, Phase};
use crate::canvas::CanvasError;
use crate::web::fs_api::{sha256_hex, Expected};

/// `takeDisk` or `saveCopy` on a document that was deleted: there is no disk
/// version to take, only "keep mine" recreates it.
pub const CODE_DOCUMENT_DELETED: &str = "DOCUMENT_DELETED";
/// The conflict copy could not be written.
pub const CODE_COPY_FAILED: &str = "COPY_FAILED";

/// The file on disk when a conflict was found, and the editor's content
/// version then.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Conflict {
    on_disk: Expected,
    version: Option<u64>,
}

impl Conflict {
    pub(super) fn new(on_disk: Expected, version: Option<u64>) -> Self {
        Self { on_disk, version }
    }

    pub(super) fn view(&self) -> ConflictView {
        ConflictView {
            disk_hash: match &self.on_disk {
                Expected::Absent => None,
                Expected::Sha256(hash) => Some(hash.clone()),
            },
            version: self.version.map(|version| version.to_string()),
        }
    }
}

/// `canvas-store.conflict`: `diskHash` is `null` when the file was deleted.
#[derive(Debug, Clone, Serialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConflictView {
    pub disk_hash: Option<String>,
    pub version: Option<String>,
}

/// What a reported file change meant.
#[derive(Debug, Clone, Serialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DiskOutcome {
    /// The file is as Termul last read or wrote it.
    Unchanged { view: PersistenceView },
    /// The editor was clean at `view.contentVersion`: load `bytes` (base64)
    /// with `host.openDocument`. An editor that has moved past that version
    /// since holds edits the reload would drop: the renderer then reports
    /// [`CanvasPersistence::reload_failed`] instead. Nothing is written until
    /// the editor loaded it (`document_loaded`).
    Reload {
        view: PersistenceView,
        bytes: String,
    },
    /// The editor holds unsaved work; `view.conflict` says what is on disk.
    Conflict { view: PersistenceView },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ConflictChoice {
    /// Overwrite the disk with a fresh snapshot of the editor.
    KeepMine,
    /// Reload the editor from disk.
    TakeDisk,
    /// Write the editor's snapshot next to the document, then reload disk.
    SaveCopy,
}

pub(super) enum Resolution {
    KeepMine,
    TakeDisk,
    SaveCopy(Vec<u8>),
}

/// After a resolution: `reload` is the disk's bytes (base64) for
/// `host.openDocument`; `copyPath` is the conflict copy written.
#[derive(Debug, Clone, Serialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ResolveOutcome {
    pub view: PersistenceView,
    pub reload: Option<String>,
    pub copy_path: Option<String>,
}

fn read_file(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn fingerprint_of(bytes: Option<&[u8]>) -> Expected {
    bytes.map_or(Expected::Absent, |bytes| {
        Expected::Sha256(sha256_hex(bytes))
    })
}

/// The file at `path` as an `expected` precondition.
pub(super) fn fingerprint(path: &Path) -> std::io::Result<Expected> {
    Ok(fingerprint_of(read_file(path)?.as_deref()))
}

async fn read_blocking(path: PathBuf) -> Result<Option<Vec<u8>>, CanvasError> {
    tokio::task::spawn_blocking(move || read_file(&path))
        .await
        .unwrap_or_else(|join| Err(std::io::Error::other(join.to_string())))
        .map_err(|error| {
            CanvasError::new(
                super::CODE_READ_FAILED,
                format!("could not read the canvas document: {error}"),
            )
        })
}

/// `<stem>.conflict-<timestamp>.figcraft` beside the document; a numeric
/// suffix keeps two copies in the same second apart.
fn conflict_copy_path(doc_path: &Path, attempt: u32) -> PathBuf {
    let stem = doc_path
        .file_stem()
        .map_or_else(|| "design".into(), |stem| stem.to_string_lossy());
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let suffix = if attempt == 0 {
        String::new()
    } else {
        format!("-{attempt}")
    };
    doc_path.with_file_name(format!("{stem}.conflict-{stamp}{suffix}.figcraft"))
}

fn write_copy(doc_path: &Path, bytes: &[u8]) -> std::io::Result<PathBuf> {
    use std::io::Write;
    let mut attempt = 0;
    loop {
        let path = conflict_copy_path(doc_path, attempt);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                file.write_all(bytes)?;
                file.sync_all()?;
                return Ok(path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && attempt < 100 => {
                attempt += 1;
            }
            Err(error) => return Err(error),
        }
    }
}

impl CanvasPersistence {
    /// The renderer read the document to open it: that is the file the
    /// editor holds, whatever an earlier reload handed it.
    pub(super) fn set_disk_baseline(
        &self,
        project_id: &str,
        mount_seq: u64,
        bytes: Option<&[u8]>,
    ) -> Result<(), CanvasError> {
        let mount = self.mount_for(project_id, mount_seq)?;
        let mut state = mount.state.lock();
        state.disk = Some(fingerprint_of(bytes));
        if let Phase::Ready(persisted) = &mut state.phase {
            persisted.reloading = None;
        }
        Ok(())
    }

    /// Termul's watcher saw the document's file change. Serialized with the
    /// mount's writes, so Termul's own write has landed and been recorded
    /// before the file is compared.
    pub async fn disk_changed(
        &self,
        project_id: &str,
        mount_seq: u64,
    ) -> Result<DiskOutcome, CanvasError> {
        let mount = self.mount_for(project_id, mount_seq)?;
        let _serialized = mount.write_lock.lock().await;
        let current = read_blocking(mount.doc_path.clone()).await?;
        let on_disk = fingerprint_of(current.as_deref());
        let mut state = mount.state.lock();
        let MountState { phase, disk, .. } = &mut *state;
        let outcome = match phase {
            Phase::Ready(persisted)
                if persisted
                    .reloading
                    .as_ref()
                    .or(disk.as_ref())
                    .is_some_and(|known| *known != on_disk) =>
            {
                if let Some(conflict) = &mut persisted.conflict {
                    conflict.on_disk = on_disk;
                    None
                } else if persisted.unsaved() || current.is_none() {
                    persisted.reloading = None;
                    persisted.conflict = Some(Conflict::new(on_disk, persisted.content_version));
                    None
                } else {
                    persisted.reloading = Some(on_disk);
                    current
                }
            }
            _ => {
                return Ok(DiskOutcome::Unchanged {
                    view: PersistenceView::of(mount.mount_seq, &state.phase),
                })
            }
        };
        let view = PersistenceView::of(mount.mount_seq, &state.phase);
        Ok(match outcome {
            Some(bytes) => DiskOutcome::Reload {
                view,
                bytes: BASE64.encode(bytes),
            },
            None => DiskOutcome::Conflict { view },
        })
    }

    /// The user's answer to a conflict. `KeepMine` adopts the file as it is
    /// now as the one the next write replaces (the renderer then saves);
    /// `TakeDisk` hands back the disk's bytes to load; `SaveCopy` first
    /// writes the editor's snapshot beside the document. A deleted document
    /// can only be kept.
    pub(super) async fn resolve(
        &self,
        project_id: &str,
        mount_seq: u64,
        resolution: Resolution,
    ) -> Result<ResolveOutcome, CanvasError> {
        let mount = self.mount_for(project_id, mount_seq)?;
        let _serialized = mount.write_lock.lock().await;
        let current = read_blocking(mount.doc_path.clone()).await?;
        if current.is_none() && !matches!(resolution, Resolution::KeepMine) {
            return Err(CanvasError::new(
                CODE_DOCUMENT_DELETED,
                "the canvas document was deleted; only keeping the editor's version can recreate it",
            ));
        }
        let reload = !matches!(resolution, Resolution::KeepMine);
        let copy_path = match resolution {
            Resolution::SaveCopy(bytes) => {
                let doc_path = mount.doc_path.clone();
                let written = tokio::task::spawn_blocking(move || write_copy(&doc_path, &bytes))
                    .await
                    .unwrap_or_else(|join| Err(std::io::Error::other(join.to_string())))
                    .map_err(|error| {
                        CanvasError::new(
                            CODE_COPY_FAILED,
                            format!("could not write the conflict copy: {error}"),
                        )
                    })?;
                Some(written.to_string_lossy().into_owned())
            }
            Resolution::KeepMine | Resolution::TakeDisk => None,
        };
        let mut state = mount.state.lock();
        let MountState { phase, disk, .. } = &mut *state;
        let Phase::Ready(persisted) = phase else {
            return Err(closed());
        };
        persisted.conflict = None;
        if reload {
            persisted.reloading = Some(fingerprint_of(current.as_deref()));
        } else {
            *disk = Some(fingerprint_of(current.as_deref()));
        }
        Ok(ResolveOutcome {
            view: PersistenceView::of(mount.mount_seq, &state.phase),
            reload: current.filter(|_| reload).map(|bytes| BASE64.encode(bytes)),
            copy_path,
        })
    }

    /// The renderer could not load the file `disk_changed` handed it (the
    /// editor refused the bytes, or moved past the version judged clean). The
    /// editor still holds its old content, so the change on disk is a
    /// conflict for the user to resolve.
    pub fn reload_failed(
        &self,
        project_id: &str,
        mount_seq: u64,
    ) -> Result<DiskOutcome, CanvasError> {
        let mount = self.mount_for(project_id, mount_seq)?;
        let mut state = mount.state.lock();
        let conflicted = match &mut state.phase {
            Phase::Ready(persisted) => match persisted.reloading.take() {
                Some(handed) => {
                    persisted.conflict = Some(Conflict::new(handed, persisted.content_version));
                    true
                }
                None => false,
            },
            Phase::Loading => false,
        };
        let view = PersistenceView::of(mount.mount_seq, &state.phase);
        Ok(if conflicted {
            DiskOutcome::Conflict { view }
        } else {
            DiskOutcome::Unchanged { view }
        })
    }
}
