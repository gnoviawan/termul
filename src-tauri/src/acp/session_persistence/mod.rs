//! Standalone-server owned, versioned JSON/JSONL ACP session persistence.
//!
//! This module is transport-neutral and intentionally does not import `web::*`.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
#[cfg(test)]
use std::sync::{Condvar, Mutex as StdMutex};
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

use crate::acp::atomic_file;
use crate::path_validation::strip_verbatim_prefix;
pub const SESSION_SCHEMA_VERSION: u32 = 1;
const INDEX_FILE: &str = "sessions.json";
const METADATA_FILE: &str = "metadata.json";
const MESSAGES_FILE: &str = "messages.jsonl";
const TOOL_CALLS_FILE: &str = "tool-calls.jsonl";
const WRITER_CAPACITY: usize = 1024;
/// Hard ceiling on how far `replay_tail` deepens the read window while
/// hunting for a fold boundary. A single coalesced run longer than this is
/// pathological; the caller falls back to a full replay beyond it.
const TAIL_DEEPEN_MAX_LINES: usize = 16_384;

mod jsonl;
mod normalize;
mod types;
mod writer;

use jsonl::*;
use writer::*;

pub use normalize::*;
pub use types::*;

#[derive(Clone)]
struct SessionRuntime {
    tx: mpsc::Sender<WriterCommand>,
    unhealthy: Arc<Mutex<Option<String>>>,
}

struct Inner {
    root: PathBuf,
    /// Active writer tasks only. Finalized sessions are removed from this map.
    sessions: Mutex<HashMap<String, SessionRuntime>>,
    /// Canonical in-memory metadata for both active and finalized sessions.
    catalog: Mutex<HashMap<String, Arc<Mutex<SessionMetadata>>>>,
    registration_lock: tokio::sync::Mutex<()>,
    index_lock: tokio::sync::Mutex<()>,
}

pub struct SessionPersistence {
    inner: Arc<Inner>,
    #[cfg(test)]
    replay_hook: Mutex<Option<Arc<ReplayTestHook>>>,
    #[cfg(test)]
    salvage_hook: Mutex<Option<Arc<ReplayTestHook>>>,
}

#[cfg(test)]
pub(crate) struct ReplayTestHook {
    entered: StdMutex<Option<std::sync::mpsc::Sender<()>>>,
    released: StdMutex<bool>,
    release: Condvar,
}

#[cfg(test)]
impl ReplayTestHook {
    pub(crate) fn new(entered: std::sync::mpsc::Sender<()>) -> Arc<Self> {
        Arc::new(Self {
            entered: StdMutex::new(Some(entered)),
            released: StdMutex::new(false),
            release: Condvar::new(),
        })
    }

    fn wait(&self) {
        if let Some(entered) = self.entered.lock().expect("replay hook poisoned").take() {
            let _ = entered.send(());
        }
        let mut released = self.released.lock().expect("replay hook poisoned");
        while !*released {
            released = self.release.wait(released).expect("replay hook poisoned");
        }
    }

    pub(crate) fn release(&self) {
        *self.released.lock().expect("replay hook poisoned") = true;
        self.release.notify_all();
    }
}

enum WriterCommand {
    Append(PersistedEventRecord),
    AppendLocalTitle(String, oneshot::Sender<Result<u64>>),
    /// Append a host-authored `agent_switch` durable record (CAP-2 marker).
    /// The payload mirrors the wire event: `{sessionId, fromConfigId,
    /// toConfigId, newSessionId, summaryText}` — `seq`/`recordedAt` come from
    /// the record envelope the writer builds. Switches are NOT messages
    /// (`message_count` stays unchanged).
    AppendAgentSwitch(AgentSwitchRecord, oneshot::Sender<Result<u64>>),
    Flush(oneshot::Sender<Result<()>>),
    Finalize(PersistedSessionStatus, oneshot::Sender<Result<()>>),
    Shutdown(oneshot::Sender<Result<()>>),
}

impl SessionPersistence {
    pub async fn open(root: PathBuf) -> Result<Arc<Self>> {
        if root.exists() && !root.is_dir() {
            return Err(SessionPersistenceError::Io(io::Error::other(format!(
                "sessions root '{}' is not a directory",
                root.display()
            ))));
        }
        fs::create_dir_all(&root)?;
        let service = Arc::new(Self {
            inner: Arc::new(Inner {
                root,
                sessions: Mutex::new(HashMap::new()),
                catalog: Mutex::new(HashMap::new()),
                registration_lock: tokio::sync::Mutex::new(()),
                index_lock: tokio::sync::Mutex::new(()),
            }),
            #[cfg(test)]
            replay_hook: Mutex::new(None),
            #[cfg(test)]
            salvage_hook: Mutex::new(None),
        });
        service.recover().await?;
        Ok(service)
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.inner.root
    }

    pub async fn register_session(
        &self,
        registration: SessionRegistration,
    ) -> Result<SessionMetadata> {
        // Idempotent catalog check BEFORE path validation: a duplicate
        // registration must return the existing entry even when its cwd is
        // unavailable (deleted between calls). Canonicalizing first would
        // surface an `Io` error for a path the session was never going to use.
        let _guard = self.inner.registration_lock.lock().await;
        if self
            .inner
            .catalog
            .lock()
            .contains_key(&registration.session_id)
        {
            return self.metadata(&registration.session_id);
        }
        let canonical = registration
            .cwd
            .canonicalize()
            .map_err(SessionPersistenceError::Io)?;
        if !canonical.is_dir() {
            return Err(SessionPersistenceError::Io(io::Error::other(
                "session cwd is not a directory",
            )));
        }
        // `canonicalize()` prepends the `\\?\` verbatim prefix on Windows.
        // Strip it so the persisted `cwd` stays tool-friendly (matches every
        // other canonicalize call site via `strip_verbatim_prefix`). Without
        // this, `session/resume` passes `\\?\E:\…` to the agent, whose cwd→dir
        // sanitizer keeps the `?` → an illegal Windows folder name → `mkdir`
        // fails with ENOENT and the resume is skipped (read-only transcript).
        let cwd = strip_verbatim_prefix(&canonical.to_string_lossy()).into_owned();
        let storage_key = Uuid::new_v4().to_string();
        let now = now_millis();
        let metadata = SessionMetadata {
            schema_version: SESSION_SCHEMA_VERSION,
            storage_key,
            session_id: registration.session_id.clone(),
            stable_agent_namespace: registration.stable_agent_namespace,
            runtime_agent_id: registration.runtime_agent_id,
            project_id: registration.project_id,
            cwd: cwd.clone(),
            title: None,
            title_source: None,
            created_at: now,
            last_activity_at: now,
            status: PersistedSessionStatus::Active,
            message_count: 0,
            tool_count: 0,
            last_seq: 0,
            discovered: false,
            worktree_path: registration.worktree_path,
            worktree_branch: registration.worktree_branch,
        };
        self.persist_metadata(&metadata)?;
        self.install_runtime(metadata.clone())?;
        if let Err(error) = self.persist_index().await {
            self.inner.sessions.lock().remove(&registration.session_id);
            self.inner.catalog.lock().remove(&registration.session_id);
            let _ = fs::remove_dir_all(self.session_dir(&metadata.storage_key)?);
            return Err(error);
        }
        log::info!(
            "[acp-history] session registered storage_key={} session_id={}",
            metadata.storage_key,
            crate::logging::redact_session_id(&metadata.session_id)
        );
        Ok(metadata)
    }

    /// Register metadata for an agent-owned session discovered via
    /// `session/list`. No transcript events are created; the agent remains the
    /// transcript authority. Idempotent by session id.
    pub async fn register_discovered_session(
        &self,
        registration: SessionRegistration,
        title: Option<String>,
        updated_at: Option<u64>,
    ) -> Result<SessionMetadata> {
        let session_id = registration.session_id.trim();
        let cwd = strip_verbatim_prefix(&registration.cwd.to_string_lossy()).into_owned();
        if session_id.is_empty() || cwd.trim().is_empty() {
            return Err(SessionPersistenceError::Io(io::Error::other(
                "discovered session id and cwd are required",
            )));
        }
        let _guard = self.inner.registration_lock.lock().await;
        let now = updated_at
            .filter(|timestamp| *timestamp > 0 && *timestamp <= now_millis() + 300_000)
            .unwrap_or_else(now_millis);
        let normalized_title = title
            .map(|value| normalize_title(&value))
            .filter(|value| value != "Untitled Chat");
        let existing = { self.inner.catalog.lock().get(session_id).cloned() };
        if let Some(existing) = existing {
            let snapshot = {
                let mut metadata = existing.lock();
                if metadata.stable_agent_namespace != registration.stable_agent_namespace
                    || metadata.cwd != cwd
                {
                    return Err(SessionPersistenceError::Io(io::Error::other(
                        "discovered session id conflicts with an existing session scope",
                    )));
                }
                metadata.runtime_agent_id = registration.runtime_agent_id;
                metadata.project_id = registration.project_id;
                metadata.status = PersistedSessionStatus::Active;
                metadata.last_activity_at = metadata.last_activity_at.max(now);
                metadata.discovered = true;
                if !is_protected_title_source(metadata.title_source.as_ref())
                    && normalized_title.is_some()
                {
                    metadata.title = normalized_title;
                    metadata.title_source = Some(TitleSource::AgentSupplied);
                }
                metadata.clone()
            };
            self.persist_metadata(&snapshot)?;
            self.persist_index().await?;
            return Ok(snapshot);
        }
        let storage_key = Uuid::new_v4().to_string();
        let title_source = normalized_title
            .as_ref()
            .map(|_| TitleSource::AgentSupplied);
        let metadata = SessionMetadata {
            schema_version: SESSION_SCHEMA_VERSION,
            storage_key,
            session_id: session_id.to_string(),
            stable_agent_namespace: registration.stable_agent_namespace,
            project_id: registration.project_id,
            runtime_agent_id: registration.runtime_agent_id,
            cwd: cwd.clone(),
            title: normalized_title,
            title_source,
            created_at: now,
            last_activity_at: now,
            status: PersistedSessionStatus::Active,
            message_count: 0,
            tool_count: 0,
            last_seq: 0,
            discovered: true,
            worktree_path: registration.worktree_path,
            worktree_branch: registration.worktree_branch,
        };
        if let Err(error) = self.persist_metadata(&metadata) {
            let _ = fs::remove_dir_all(self.session_dir(&metadata.storage_key)?);
            return Err(error);
        }
        self.install_catalog_entry(metadata.clone());
        if let Err(error) = self.persist_index().await {
            self.inner.catalog.lock().remove(session_id);
            let _ = fs::remove_dir_all(self.session_dir(&metadata.storage_key)?);
            return Err(error);
        }
        log::info!(
            "[acp-history] discovered session registered storage_key={} session_id={}",
            metadata.storage_key,
            crate::logging::redact_session_id(&metadata.session_id)
        );
        Ok(metadata)
    }

    /// Register a session imported from a legacy renderer-authored store.
    /// Unlike [`Self::register_session`], provenance is preserved (`created_at`
    /// and `title` come from the caller) and the legacy `cwd` is accepted
    /// verbatim — archival sessions may point at directories that no longer
    /// exist, and no liveness guarantee is implied. Idempotent by session id.
    pub async fn register_imported_session(
        &self,
        registration: SessionRegistration,
        created_at: u64,
        title: Option<String>,
    ) -> Result<SessionMetadata> {
        if registration.cwd.as_os_str().is_empty() {
            return Err(SessionPersistenceError::Io(io::Error::other(
                "imported session cwd is empty",
            )));
        }
        let _guard = self.inner.registration_lock.lock().await;
        if self
            .inner
            .catalog
            .lock()
            .contains_key(&registration.session_id)
        {
            return self.metadata(&registration.session_id);
        }
        let storage_key = Uuid::new_v4().to_string();
        let metadata = SessionMetadata {
            schema_version: SESSION_SCHEMA_VERSION,
            storage_key,
            session_id: registration.session_id.clone(),
            stable_agent_namespace: registration.stable_agent_namespace,
            runtime_agent_id: registration.runtime_agent_id,
            project_id: registration.project_id,
            cwd: strip_verbatim_prefix(&registration.cwd.to_string_lossy()).into_owned(),
            title,
            title_source: None,
            created_at,
            last_activity_at: created_at,
            status: PersistedSessionStatus::Active,
            message_count: 0,
            tool_count: 0,
            last_seq: 0,
            discovered: false,
            worktree_path: registration.worktree_path,
            worktree_branch: registration.worktree_branch,
        };
        self.persist_metadata(&metadata)?;
        self.install_runtime(metadata.clone())?;
        if let Err(error) = self.persist_index().await {
            self.inner.sessions.lock().remove(&registration.session_id);
            self.inner.catalog.lock().remove(&registration.session_id);
            let _ = fs::remove_dir_all(self.session_dir(&metadata.storage_key)?);
            return Err(error);
        }
        log::info!(
            "[acp-history] imported session registered storage_key={} session_id={}",
            metadata.storage_key,
            crate::logging::redact_session_id(&metadata.session_id)
        );
        Ok(metadata)
    }

    /// Reinstall the durable writer for a previously-finalized (catalog-retained)
    /// session so `enqueue_event` and `last_seq`-derived title-gen succeed on
    /// reopen. Idempotent: returns `Ok` if a writer is already installed.
    ///
    /// `register_session` is catalog-idempotent (short-circuits at the catalog
    /// check BEFORE `install_runtime`), so it cannot reinstall a writer for a
    /// finalized session — this dedicated reopen path is required. `finalize_session`
    /// keeps its terminal contract: it removes the writer but retains the catalog
    /// entry (read-only listing + `last_seq` still resolve).
    ///
    /// Steps: (a) no-op when a writer is already present; (b) fetch metadata from
    /// the catalog (`SessionNotFound` if the catalog entry is also gone — e.g. a
    /// deleted session); (c) reactivate the metadata (`Active` + fresh
    /// `last_activity_at`) and reinstall via `install_runtime` (which inserts into
    /// both the catalog and the writer map); (d) `persist_index` so the reactivated
    /// status surfaces in the listing.
    ///
    /// On-disk `metadata.json` is deliberately NOT rewritten: the catalog is the
    /// in-memory authority while the process lives, and `recover()` rebuilds from
    /// disk on restart — where a reopened session correctly reads as `Closed`
    /// because the agent subprocess cannot survive a restart. Persisting `Active`
    /// to disk here would lie about liveness after a crash.
    pub async fn reopen_writer(&self, session_id: &str) -> Result<()> {
        let _guard = self.inner.registration_lock.lock().await;
        // (a) Idempotent: a writer is already installed for this session.
        if self.inner.sessions.lock().contains_key(session_id) {
            return Ok(());
        }
        // (b) Fetch the catalog metadata. A finalized session keeps its catalog
        // entry, so this succeeds; a deleted session surfaces SessionNotFound.
        let mut metadata = self.metadata(session_id)?;
        // (c) Flip status back to Active — the session is being reopened so a
        // live writer must accept new durable events. `install_runtime` inserts
        // the reactivated metadata into both the catalog and the writer map.
        metadata.status = PersistedSessionStatus::Active;
        metadata.last_activity_at = now_millis();
        self.install_runtime(metadata)?;
        // (d) Refresh the index so the listing reflects the reactivated status.
        self.persist_index().await
    }

    pub fn enqueue_event(&self, mut record: PersistedEventRecord) -> Result<()> {
        if !is_durable_event(&record.type_) {
            return Ok(());
        }
        record.payload = normalize_durable_payload(&record.type_, &record.payload);
        let runtime = self
            .inner
            .sessions
            .lock()
            .get(&record.session_id)
            .cloned()
            .ok_or(SessionPersistenceError::SessionNotFound)?;
        match runtime.tx.try_send(WriterCommand::Append(record)) {
            Ok(()) => Ok(()),
            Err(mpsc::error::TrySendError::Full(_)) => {
                *runtime.unhealthy.lock() = Some("writer queue full".to_string());
                Err(SessionPersistenceError::QueueFull)
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                *runtime.unhealthy.lock() = Some("writer stopped".to_string());
                Err(SessionPersistenceError::WriterStopped)
            }
        }
    }

    /// Append a normalized local-title event with a writer-assigned sequence.
    /// The writer is the sole sequence authority, so a mid-turn title tool call
    /// cannot race queued message chunks and reuse their sequence number.
    pub async fn append_local_title(&self, session_id: &str, title: String) -> Result<u64> {
        let runtime = self.runtime(session_id)?;
        if let Some(message) = runtime.unhealthy.lock().clone() {
            return Err(SessionPersistenceError::PersistenceUnhealthy(message));
        }
        let (tx, rx) = oneshot::channel();
        runtime
            .tx
            .send(WriterCommand::AppendLocalTitle(title, tx))
            .await
            .map_err(|_| SessionPersistenceError::WriterStopped)?;
        rx.await
            .map_err(|_| SessionPersistenceError::WriterStopped)?
    }

    /// Append a host-authored `agent_switch` durable marker record with a
    /// writer-assigned sequence (CAP-2). Mirrors [`append_local_title`]: the
    /// writer is the sole sequence authority, so a switch recorded between
    /// queued message chunks cannot collide with their sequence numbers. The
    /// record is NOT a message — `message_count` stays unchanged.
    pub async fn append_agent_switch(
        &self,
        session_id: &str,
        record: AgentSwitchRecord,
    ) -> Result<u64> {
        let runtime = self.runtime(session_id)?;
        if let Some(message) = runtime.unhealthy.lock().clone() {
            return Err(SessionPersistenceError::PersistenceUnhealthy(message));
        }
        let (tx, rx) = oneshot::channel();
        runtime
            .tx
            .send(WriterCommand::AppendAgentSwitch(record, tx))
            .await
            .map_err(|_| SessionPersistenceError::WriterStopped)?;
        rx.await
            .map_err(|_| SessionPersistenceError::WriterStopped)?
    }

    pub async fn flush_session(&self, session_id: &str) -> Result<()> {
        let runtime = match self.runtime(session_id) {
            Ok(runtime) => runtime,
            Err(SessionPersistenceError::SessionNotFound)
                if self.inner.catalog.lock().contains_key(session_id) =>
            {
                // Finalization already synced and removed the writer. A replay
                // barrier for a finalized session is therefore already met.
                return self.persist_index().await;
            }
            Err(error) => return Err(error),
        };
        if let Some(message) = runtime.unhealthy.lock().clone() {
            return Err(SessionPersistenceError::PersistenceUnhealthy(message));
        }
        if runtime.tx.is_closed() {
            return Ok(());
        }
        let (tx, rx) = oneshot::channel();
        runtime
            .tx
            .send(WriterCommand::Flush(tx))
            .await
            .map_err(|_| SessionPersistenceError::WriterStopped)?;
        rx.await
            .map_err(|_| SessionPersistenceError::WriterStopped)??;
        self.persist_index().await
    }

    pub async fn finalize_session(
        &self,
        session_id: &str,
        status: PersistedSessionStatus,
    ) -> Result<()> {
        let runtime = self.runtime(session_id)?;
        let (tx, rx) = oneshot::channel();
        let result = match runtime.tx.send(WriterCommand::Finalize(status, tx)).await {
            Ok(()) => rx
                .await
                .map_err(|_| SessionPersistenceError::WriterStopped)?,
            Err(_) => Err(SessionPersistenceError::WriterStopped),
        };
        // Finalize is terminal even when the durability boundary fails: never
        // retain a stopped writer. Catalog metadata remains available for
        // read-only listing/replay and `unhealthy` preserves observability.
        self.inner.sessions.lock().remove(session_id);
        result?;
        self.persist_index().await
    }

    pub async fn flush_all(&self) -> Result<()> {
        let session_ids: Vec<String> = self.inner.sessions.lock().keys().cloned().collect();
        for session_id in session_ids {
            self.flush_session(&session_id).await?;
        }
        Ok(())
    }

    pub async fn shutdown(&self) -> Result<()> {
        let runtimes: Vec<(String, SessionRuntime)> = self
            .inner
            .sessions
            .lock()
            .iter()
            .map(|(id, runtime)| (id.clone(), runtime.clone()))
            .collect();
        for (_, runtime) in &runtimes {
            if runtime.tx.is_closed() {
                continue;
            }
            let (tx, rx) = oneshot::channel();
            runtime
                .tx
                .send(WriterCommand::Shutdown(tx))
                .await
                .map_err(|_| SessionPersistenceError::WriterStopped)?;
            rx.await
                .map_err(|_| SessionPersistenceError::WriterStopped)??;
        }
        self.persist_index().await?;
        self.inner.sessions.lock().clear();
        Ok(())
    }

    pub fn list_sessions(&self) -> Vec<SessionIndexEntry> {
        let mut entries: Vec<_> = self
            .inner
            .catalog
            .lock()
            .values()
            .map(|metadata| SessionIndexEntry::from(&*metadata.lock()))
            .collect();
        entries.sort_by_key(|entry| std::cmp::Reverse(entry.last_activity_at));
        entries
    }

    pub fn metadata(&self, session_id: &str) -> Result<SessionMetadata> {
        self.inner
            .catalog
            .lock()
            .get(session_id)
            .map(|metadata| metadata.lock().clone())
            .ok_or(SessionPersistenceError::SessionNotFound)
    }

    pub fn last_seq(&self, session_id: &str) -> Result<u64> {
        Ok(self.metadata(session_id)?.last_seq)
    }

    /// Permanently remove a persisted session: drain the writer runtime when
    /// one is still live, delete the on-disk session directory, drop the
    /// catalog entry, and refresh the index. Unknown ids surface as
    /// [`SessionPersistenceError::SessionNotFound`].
    pub async fn delete_session(&self, session_id: &str) -> Result<()> {
        let metadata = self.metadata(session_id)?;
        // Drain the writer (if any) so a queued append cannot race the
        // directory removal below. The durability result of the drain is
        // irrelevant: the stored bytes are about to be deleted.
        if let Ok(runtime) = self.runtime(session_id) {
            if !runtime.tx.is_closed() {
                let (tx, rx) = oneshot::channel();
                if runtime.tx.send(WriterCommand::Shutdown(tx)).await.is_ok() {
                    let _ = rx.await;
                }
            }
        }
        self.inner.sessions.lock().remove(session_id);
        let dir = self.session_dir(&metadata.storage_key)?;
        // Hold the catalog lock across the directory removal: a concurrent
        // read-path salvage serializes on the same lock, so it cannot be
        // mid-rewrite when the dir disappears — a late `atomic_file::replace`
        // would otherwise `create_dir_all` the deleted dir back into an
        // orphan husk.
        {
            let mut catalog = self.inner.catalog.lock();
            fs::remove_dir_all(&dir)?;
            catalog.remove(session_id);
        }
        self.persist_index().await?;
        log::info!(
            "[acp-history] host store delete success storage_key={}",
            metadata.storage_key
        );
        Ok(())
    }

    /// Most-recent session for a `(project_id, cwd)` pair with some agent
    /// identity, optionally narrowed to a stable agent namespace. Mirrors the
    /// legacy `ChatHistoryStore::find_most_recent_for_project` used by the
    /// project switch-back reopen.
    #[must_use]
    pub fn find_most_recent_for_project(
        &self,
        project_id: &str,
        cwd: &str,
        stable_agent_namespace: Option<&str>,
    ) -> Option<SessionIndexEntry> {
        self.list_sessions()
            .into_iter()
            .filter(|entry| {
                entry.project_id.as_deref() == Some(project_id)
                    && entry.cwd == cwd
                    && (entry.stable_agent_namespace.is_some() || entry.runtime_agent_id.is_some())
                    && stable_agent_namespace.is_none_or(|namespace| {
                        entry.stable_agent_namespace.as_deref() == Some(namespace)
                    })
            })
            .max_by(|left, right| {
                left.last_activity_at
                    .cmp(&right.last_activity_at)
                    .then(left.created_at.cmp(&right.created_at))
                    .then(left.session_id.cmp(&right.session_id))
            })
    }

    /// Shared seq-intruder salvage for the durable reads: on
    /// `CorruptSession`, run one bounded salvage pass and retry the load
    /// once — a healed file (`Ok(true)`) succeeds on retry, and `Ok(false)`
    /// (nothing salvageable, or a concurrent salvage already healed it) is
    /// resolved by the same retry. Salvage errors propagate as-is so a
    /// racing `delete_session` surfaces `SessionNotFound` rather than a
    /// corrupt-history mislabel.
    fn read_with_salvage<T>(
        &self,
        session_id: &str,
        op: &'static str,
        load: impl Fn(&Self) -> Result<T>,
    ) -> Result<T> {
        match load(self) {
            Err(SessionPersistenceError::CorruptSession) => {
                match self.salvage_seq_intruders(session_id) {
                    Ok(healed) => {
                        if !healed {
                            log::warn!(
                                "[acp-history] {op} found no salvageable seq intruders session_id={}",
                                crate::logging::redact_session_id(session_id)
                            );
                        }
                        load(self)
                    }
                    Err(error) => {
                        log::warn!(
                            "[acp-history] {op} seq-intruder salvage failed session_id={} error={error}",
                            crate::logging::redact_session_id(session_id)
                        );
                        Err(error)
                    }
                }
            }
            result => result,
        }
    }

    /// Durable read with bounded seq-intruder salvage: when the load fails
    /// closed because a stale post-crash `last_seq` let an append reuse an
    /// existing seq (a parseable in-session record behind the running file
    /// max), quarantine the intruder bytes to a `.corrupt-*.bak` sidecar and
    /// retry the load once against the rewritten files. Unparseable or
    /// foreign-session lines are never salvageable — `CorruptSession`
    /// propagates.
    pub fn replay_after(&self, session_id: &str, cursor: u64) -> Result<Vec<PersistedEventRecord>> {
        self.read_with_salvage(session_id, "replay_after", |persistence| {
            persistence.replay_after_inner(session_id, cursor)
        })
    }

    fn replay_after_inner(&self, session_id: &str, cursor: u64) -> Result<Vec<PersistedEventRecord>> {
        let metadata = self.metadata(session_id)?;
        if cursor > metadata.last_seq {
            return Err(SessionPersistenceError::StaleCursor {
                cursor,
                last_seq: metadata.last_seq,
            });
        }
        let dir = self.session_dir(&metadata.storage_key)?;
        let mut records = load_jsonl(&dir.join(MESSAGES_FILE), session_id, false)?;
        records.extend(load_jsonl(&dir.join(TOOL_CALLS_FILE), session_id, false)?);
        validate_and_sort(&mut records)?;
        Ok(records
            .into_iter()
            .filter(|record| record.seq > cursor)
            .collect())
    }

    /// Load replay records on Tokio's blocking pool so JSONL disk scans never
    /// stall the async WS runtime.
    pub async fn replay_after_async(
        self: &Arc<Self>,
        session_id: String,
        cursor: u64,
    ) -> Result<Vec<PersistedEventRecord>> {
        let persistence = Arc::clone(self);
        tokio::task::spawn_blocking(move || {
            let records = persistence.replay_after(&session_id, cursor);
            #[cfg(test)]
            if let Some(hook) = persistence.replay_hook.lock().clone() {
                hook.wait();
            }
            records
        })
        .await
        .map_err(|error| SessionPersistenceError::PersistenceUnhealthy(error.to_string()))?
    }

    #[cfg(test)]
    pub(crate) fn set_replay_test_hook(&self, hook: Arc<ReplayTestHook>) {
        *self.replay_hook.lock() = Some(hook);
    }

    /// Tail-first replay: reads only the last `limit` message records from
    /// `messages.jsonl` (via [`load_jsonl_tail`]) plus ALL tool-call records
    /// from `tool-calls.jsonl` (bounded by the persist-time limit of 500),
    /// filters tool calls to those whose `seq` ≥ the oldest tail message seq,
    /// and merges + sorts. Returns a seq-sorted `Vec<PersistedEventRecord>`
    /// covering only the tail — the caller folds these into messages.
    ///
    /// Fold-boundary safety: a window whose first fold-relevant record is a
    /// `message_chunk` continuing a run opened BEFORE the window would mint a
    /// wrong `snapshot:<role>:<seq>` bubble id with truncated content — an id
    /// the full materialize never contains, so the renderer's
    /// `loadOlderMessages` anchor misses and scroll-back stalls. To prevent
    /// that, the window is deepened (doubling `max_lines`) until the fold
    /// state at the window edge is provably clean — the first fold-relevant
    /// record starts a fresh bubble — or the file head is reached. Meta
    /// records (plan/usage/mode/session-info updates, `tool_call_update`)
    /// are transparent to the fold and never satisfy the check on their own.
    /// A single run spanning more than `TAIL_DEEPEN_MAX_LINES` records is
    /// pathological; beyond the cap we fall back to a full replay.
    ///
    /// Like [`replay_after`], a `CorruptSession` result triggers one
    /// bounded seq-intruder salvage pass and a single retry — a dup-seq
    /// record inside the scanned tail window is healed instead of failing
    /// the session forever. (A dup-seq record *before* the tail window is
    /// invisible to the tail read itself; it heals on the `replay_after`
    /// fallback or the next scroll-back read.)
    pub fn replay_tail(&self, session_id: &str, limit: usize) -> Result<Vec<PersistedEventRecord>> {
        self.read_with_salvage(session_id, "replay_tail", |persistence| {
            persistence.replay_tail_inner(session_id, limit)
        })
    }

    fn replay_tail_inner(&self, session_id: &str, limit: usize) -> Result<Vec<PersistedEventRecord>> {
        let metadata = self.metadata(session_id)?;
        let dir = self.session_dir(&metadata.storage_key)?;
        let messages_path = dir.join(MESSAGES_FILE);
        let tool_calls_path = dir.join(TOOL_CALLS_FILE);
        // Read the last `limit * 4` message lines first — only the tail of
        // the file is deserialized, not the full transcript. The window
        // doubles whenever the fold-boundary check needs more context.
        let mut max_lines = limit.saturating_mul(4).max(limit + 4);
        // Tool calls are bounded at persist time (PERSISTED_TOOL_CALLS_LIMIT
        // = 500), so reading all of them once is cheap. They are needed
        // beyond the window because a `tool_call` just outside it is the
        // boundary that may end an open chunk run.
        let tool_calls = load_jsonl(&tool_calls_path, session_id, false)?;
        loop {
            let tail = load_jsonl_tail(&messages_path, session_id, max_lines)?;
            // Merge the message tail with every tool-call record so boundary
            // detection sees `tool_call` splits that precede the window.
            let mut universe = tail.records;
            universe.extend(tool_calls.iter().cloned());
            validate_and_sort(&mut universe)?;
            // Determine the oldest message-record seq in the tail so tool
            // calls older than the tail are dropped from the RESULT (they
            // belong to scrolled-away messages the renderer no longer shows)
            // — they still participate in boundary detection via `universe`.
            let oldest_tail_seq = universe
                .iter()
                .filter(|r| !is_tool_event(&r.type_))
                .map(|r| r.seq)
                .min()
                .unwrap_or(0);
            // Keep tool calls within the tail range; keep all message
            // records (the tail scan already bounded them). Tool calls with
            // no seq (a corrupt edge) are always retained — the renderer
            // tolerates them.
            let mut records = universe.clone();
            records.retain(|r| !is_tool_event(&r.type_) || r.seq >= oldest_tail_seq);
            // Find the first fold-relevant record the fold will process.
            // Only a `message_chunk` can open mid-run; any other type starts
            // deterministically regardless of preceding state.
            let first = records.iter().find(|r| is_fold_relevant(r));
            let crosses_edge = match first {
                Some(first) if first.type_ == "message_chunk" && !tail.reached_head => {
                    // The window opens on a chunk: safe only when the
                    // immediately preceding fold-relevant record ends the
                    // prior run — a boundary (`user_prompt`, `tool_call`,
                    // `prompt_complete`) or a chunk of a different role.
                    // Meta records before it are transparent and carry no
                    // boundary information. `None` means no loaded
                    // fold-relevant record precedes it while the file may
                    // still hold more — the window must grow.
                    match universe
                        .iter()
                        .rev()
                        .find(|r| is_fold_relevant(r) && r.seq < first.seq)
                    {
                        None => true,
                        Some(prev) => {
                            prev.type_ == "message_chunk"
                                && chunk_fold_role(prev) == chunk_fold_role(first)
                        }
                    }
                }
                _ => false,
            };
            if !crosses_edge {
                log::info!(
                    "[acp-history] replay_tail session_id={} limit={} tail_records={} oldest_seq={}",
                    crate::logging::redact_session_id(session_id),
                    limit,
                    records.len(),
                    oldest_tail_seq
                );
                return Ok(records);
            }
            if max_lines >= TAIL_DEEPEN_MAX_LINES {
                log::info!(
                    "[acp-history] replay_tail session_id={} limit={} max_lines={} \
                     fallback=full (chunk run exceeds tail deepen ceiling)",
                    crate::logging::redact_session_id(session_id),
                    limit,
                    max_lines
                );
                return self.replay_after(session_id, 0);
            }
            max_lines = (max_lines.saturating_mul(2)).min(TAIL_DEEPEN_MAX_LINES);
            log::debug!(
                "[acp-history] replay_tail session_id={} limit={} deepened max_lines={} \
                 (window edge continues an earlier run)",
                crate::logging::redact_session_id(session_id),
                limit,
                max_lines
            );
        }
    }

    /// Async wrapper for [`replay_tail`] on Tokio's blocking pool so the JSONL
    /// tail scan never stalls the async WS runtime.
    pub async fn replay_tail_async(
        self: &Arc<Self>,
        session_id: String,
        limit: usize,
    ) -> Result<Vec<PersistedEventRecord>> {
        let persistence = Arc::clone(self);
        tokio::task::spawn_blocking(move || {
            let records = persistence.replay_tail(&session_id, limit);
            #[cfg(test)]
            if let Some(hook) = persistence.replay_hook.lock().clone() {
                hook.wait();
            }
            records
        })
        .await
        .map_err(|error| SessionPersistenceError::PersistenceUnhealthy(error.to_string()))?
    }

    /// Bounded salvage for the durable read path: when a session's JSONL
    /// logs fail closed on seq-intruder records — parseable, in-session
    /// records with `seq == 0` or `seq <=` the running file max, the
    /// signature of a post-crash append issued from a stale `last_seq` —
    /// quarantine the intruder bytes to `.corrupt-*.bak` sidecars and
    /// rewrite the logs without them so the session resumes instead of
    /// failing forever. Returns `Ok(true)` when at least one file was
    /// rewritten; `Ok(false)` when nothing needed healing or any line was
    /// unsalvageable (unparseable, or a foreign session/schema record —
    /// those stay `CorruptSession` and are never dropped here). After a
    /// heal the catalog metadata is recounted and persisted so index,
    /// writers, and reads agree.
    fn salvage_seq_intruders(&self, session_id: &str) -> Result<bool> {
        // Serialize the whole heal against every writer-facing mutation.
        // The catalog map lock blocks `install_runtime`'s entry-Arc swap
        // (reopen_writer) and `delete_session`'s directory removal; the
        // entry lock blocks `append_record`, which the writer task runs
        // under the same Arc<Mutex<SessionMetadata>>. Lock order is
        // catalog → entry, matching `persist_index`'s catalog.lock() →
        // metadata.lock() — no path locks entry before catalog, so this
        // cannot deadlock.
        let catalog = self.inner.catalog.lock();
        let entry = catalog
            .get(session_id)
            .cloned()
            .ok_or(SessionPersistenceError::SessionNotFound)?;
        let mut current = entry.lock();
        #[cfg(test)]
        if let Some(hook) = self.salvage_hook.lock().clone() {
            hook.wait();
        }
        let dir = self.session_dir(&current.storage_key)?;
        let Some(counts) = salvage_session_dir(&dir, session_id)? else {
            return Ok(false);
        };
        // The recount is exact: no append could have landed mid-heal —
        // `append_record` was blocked on this entry lock for the whole
        // scan/backup/rewrite. `last_seq` still keeps a max() guard: a seq
        // gap is harmless, a reused seq is the corruption being healed.
        current.message_count = counts.message_count;
        current.tool_count = counts.tool_count;
        current.last_seq = current.last_seq.max(counts.last_seq);
        self.persist_metadata(&current)?;
        log::warn!(
            "[acp-history] salvaged seq-intruder records session_id={} \
             intruder_lines={} message_count={} tool_count={} last_seq={}",
            crate::logging::redact_session_id(session_id),
            counts.intruder_lines,
            counts.message_count,
            counts.tool_count,
            counts.last_seq
        );
        Ok(true)
    }

    /// Test seam: lets a test enqueue a writer command while the salvage
    /// holds the catalog+entry locks, deterministically proving the heal is
    /// serialized against live appends.
    #[cfg(test)]
    pub(crate) fn set_salvage_test_hook(&self, hook: Arc<ReplayTestHook>) {
        *self.salvage_hook.lock() = Some(hook);
    }

    /// Materialize the renderer-shaped `SessionPayload` for a session from its
    /// durable records (standalone `get_session_payload` source).
    ///
    /// Same barrier pattern as `subscribe_snapshot`: flush the writer queue
    /// first so every already-assigned seq is on disk before reading an active
    /// session (finalized sessions short-circuit the flush). Unknown session
    /// ids surface as [`SessionPersistenceError::SessionNotFound`]; any storage
    /// failure propagates as an error — never a fabricated empty payload.
    pub async fn session_payload_async(
        self: &Arc<Self>,
        session_id: &str,
    ) -> Result<crate::acp::session_payload::MaterializedSessionPayload> {
        self.flush_session(session_id).await?;
        let metadata = self.metadata(session_id)?;
        let records = self.replay_after_async(session_id.to_string(), 0).await?;
        Ok(crate::acp::session_payload::materialize_session_payload(
            &metadata, &records,
        ))
    }

    /// Tail-first variant of [`session_payload_async`]: reads only the last
    /// `limit` message records from `messages.jsonl` (via [`replay_tail`]),
    /// folds ONLY those records into messages, then slices the last `limit`
    /// messages. This avoids deserializing + folding the entire transcript
    /// for a long chat — only the tail records hit disk + serde. Falls back to
    /// the full [`session_payload_async`] when the tail fold produces fewer
    /// than `limit` messages (session is small enough that the full read is
    /// trivial, or the heuristic under-read missed records). The metadata's
    /// `messageCount` reflects the tail slice so the renderer knows how many
    /// messages it received.
    pub async fn session_payload_tail_async(
        self: &Arc<Self>,
        session_id: &str,
        limit: usize,
    ) -> Result<crate::acp::session_payload::MaterializedSessionPayload> {
        self.flush_session(session_id).await?;
        let metadata = self.metadata(session_id)?;
        let records = self
            .replay_tail_async(session_id.to_string(), limit)
            .await?;
        let mut payload =
            crate::acp::session_payload::materialize_session_payload(&metadata, &records);
        // If the tail fold produced fewer than `limit` messages AND the
        // session has more on disk (metadata.message_count > tail len), the
        // heuristic under-read (the 4× line ratio wasn't enough). Fall back
        // to the full materialize so the tail is always correct.
        if payload.messages.len() < limit && metadata.message_count > payload.messages.len() as u64
        {
            log::info!(
                "[acp-history] session_payload_tail session_id={} limit={} \
                 tail_messages={} on_disk={} fallback=full",
                crate::logging::redact_session_id(session_id),
                limit,
                payload.messages.len(),
                metadata.message_count
            );
            let full = self.session_payload_async(session_id).await?;
            let mut full = full;
            if full.messages.len() > limit {
                full.messages = full.messages.split_off(full.messages.len() - limit);
                full.metadata.message_count = full.messages.len() as u64;
                // CAP-2: retain switches that fall inside the kept tail slice
                // (mirrors the toolCalls retain rule) — a switch older than
                // the window belongs to scrolled-away history. The oldest
                // KEPT seq is read AFTER the split (the slice's head).
                let oldest_kept_seq = full.messages.first().map_or(0, |message| message.seq);
                full.switches.retain(|switch| switch.seq >= oldest_kept_seq);
            }
            return Ok(full);
        }
        if payload.messages.len() > limit {
            payload.messages = payload.messages.split_off(payload.messages.len() - limit);
            payload.metadata.message_count = payload.messages.len() as u64;
            let oldest_kept_seq = payload.messages.first().map_or(0, |message| message.seq);
            payload
                .switches
                .retain(|switch| switch.seq >= oldest_kept_seq);
        }
        Ok(payload)
    }

    /// Completed client turn ids reconstructed from durable prompt-complete
    /// records. This survives restart without treating arbitrary browser input
    /// as authoritative transcript state.
    pub fn completed_turn_ids(&self, session_id: &str) -> Result<HashSet<String>> {
        Ok(self
            .replay_after(session_id, 0)?
            .into_iter()
            .filter(|record| record.type_ == "prompt_complete")
            .filter_map(|record| {
                record
                    .payload
                    .get("turnId")
                    .and_then(Value::as_str)
                    .filter(|turn_id| !turn_id.is_empty())
                    .map(str::to_string)
            })
            .collect())
    }

    async fn recover(&self) -> Result<()> {
        let index_path = self.inner.root.join(INDEX_FILE);
        let existing_index = match fs::read(&index_path) {
            Ok(bytes) => match decode_index(&bytes) {
                Ok(index) => Some(index),
                Err(SessionPersistenceError::UnsupportedVersion { found }) => {
                    return Err(SessionPersistenceError::UnsupportedVersion { found })
                }
                Err(_) => {
                    let _ = atomic_file::backup_corrupt(&index_path, &bytes);
                    None
                }
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };

        let mut recovered = HashMap::new();
        let mut logical_ids = HashSet::new();
        for entry in fs::read_dir(&self.inner.root)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let storage_key = entry.file_name().to_string_lossy().into_owned();
            if Uuid::parse_str(&storage_key).is_err() {
                continue;
            }
            let dir = entry.path();
            let metadata_path = dir.join(METADATA_FILE);
            let bytes = match fs::read(&metadata_path) {
                Ok(bytes) => bytes,
                Err(_) => continue,
            };
            let mut metadata: SessionMetadata = match decode_versioned(&bytes) {
                Ok(metadata) => metadata,
                Err(SessionPersistenceError::UnsupportedVersion { found }) => {
                    return Err(SessionPersistenceError::UnsupportedVersion { found })
                }
                Err(_) => {
                    let _ = atomic_file::backup_corrupt(&metadata_path, &bytes);
                    continue;
                }
            };
            if metadata.storage_key != storage_key
                || !logical_ids.insert(metadata.session_id.clone())
            {
                continue;
            }
            ensure_log_exists(&dir.join(MESSAGES_FILE))?;
            ensure_log_exists(&dir.join(TOOL_CALLS_FILE))?;

            let mut dirty = false;

            // Trust the persisted metadata's message_count, tool_count, and
            // last_seq instead of reloading every JSONL record on startup.
            // These fields are updated in-memory on every `append_record` and
            // flushed to disk on Flush/Finalize/Shutdown (sync_session_files
            // → persist_metadata_at_root). With 1000+ sessions, the full
            // JSONL reload was the dominant startup cost (75-84s); the
            // metadata file is a small JSON read (~O(1) per session).
            //
            // Stale counts undercounting after a crash are display-only.
            // `last_seq` is different: the seq allocator derives the next
            // seq from durable `last_seq + 1` (WsRelaySink::assign_and_append
            // and the writer-assigned paths), so a stale-LOW durable
            // `last_seq` makes the first post-restart append REUSE an
            // existing seq → duplicate seq → `validate_and_sort` fails
            // closed on every read. The tail reconcile below heals
            // stale-low `last_seq` before any append can reuse a seq.
            //
            // Repair torn tails (incomplete final writes) so later appends
            // land after a valid line. This reads only the last 4 KiB of
            // each file — O(1) per session, not O(total_records).
            repair_jsonl_torn_tail(&dir.join(MESSAGES_FILE));
            repair_jsonl_torn_tail(&dir.join(TOOL_CALLS_FILE));

            // Reconcile `last_seq` against each log's durable tail — the
            // same tail-read class as the torn-tail repair (the probe
            // deepens only until it covers a complete line). A crash
            // between an append and the next metadata flush leaves
            // `metadata.json` behind the JSONL frontier; bumping `last_seq`
            // to the tail max keeps the next writer-assigned seq unique.
            // A tail seq BELOW `last_seq` is a harmless seq gap — warn
            // only, never rewrite.
            let mut tail_max: Option<u64> = None;
            for name in [MESSAGES_FILE, TOOL_CALLS_FILE] {
                if let Some(seq) = jsonl_tail_seq(&dir.join(name), &metadata.session_id) {
                    tail_max = Some(tail_max.map_or(seq, |current| current.max(seq)));
                }
            }
            match tail_max {
                Some(tail_max) if tail_max > metadata.last_seq => {
                    log::warn!(
                        "[acp-history] recover() healing stale last_seq session_id={} last_seq={} tail_seq={tail_max}",
                        crate::logging::redact_session_id(&metadata.session_id),
                        metadata.last_seq
                    );
                    metadata.last_seq = tail_max;
                    dirty = true;
                }
                Some(tail_max) if tail_max < metadata.last_seq => {
                    log::warn!(
                        "[acp-history] recover() durable tail seq behind metadata last_seq session_id={} last_seq={} tail_seq={tail_max}",
                        crate::logging::redact_session_id(&metadata.session_id),
                        metadata.last_seq
                    );
                }
                _ => {}
            }

            // Lightweight corruption check: verify the first JSONL record
            // in BOTH logs deserializes with the right schema version and
            // session id. This catches fully-corrupt files (e.g. "bad\n")
            // without loading all records. If either check fails, fall back
            // to the full scan which may quarantine the session.
            let messages_valid =
                jsonl_first_record_is_valid(&dir.join(MESSAGES_FILE), &metadata.session_id);
            let tool_calls_valid =
                jsonl_first_record_is_valid(&dir.join(TOOL_CALLS_FILE), &metadata.session_id);
            if metadata.message_count + metadata.tool_count > 0
                && (!messages_valid || !tool_calls_valid)
            {
                log::warn!(
                    "[acp-history] recover() JSONL corruption detected, falling back to full scan session_id={}",
                    crate::logging::redact_session_id(&metadata.session_id)
                );
                let mut records = match load_jsonl(
                    &dir.join(MESSAGES_FILE),
                    &metadata.session_id,
                    true,
                ) {
                    Ok(records) => records,
                    Err(e) => {
                        log::warn!(
                            "[acp-history] recover() fallback load_jsonl failed for messages session_id={} error={e}",
                            crate::logging::redact_session_id(&metadata.session_id)
                        );
                        continue;
                    }
                };
                match load_jsonl(&dir.join(TOOL_CALLS_FILE), &metadata.session_id, true) {
                    Ok(tool_records) => records.extend(tool_records),
                    Err(e) => {
                        log::warn!(
                            "[acp-history] recover() fallback load_jsonl failed for tool-calls session_id={} error={e}",
                            crate::logging::redact_session_id(&metadata.session_id)
                        );
                        continue;
                    }
                }
                if validate_and_sort(&mut records).is_err() {
                    log::warn!(
                        "[acp-history] recover() fallback validate_and_sort failed, quarantining session_id={}",
                        crate::logging::redact_session_id(&metadata.session_id)
                    );
                    continue;
                }
                metadata.message_count = records
                    .iter()
                    .filter(|record| !is_tool_event(&record.type_) && record.type_ != "agent_switch")
                    .count() as u64;
                metadata.tool_count = records
                    .iter()
                    .filter(|record| is_tool_event(&record.type_))
                    .count() as u64;
                metadata.last_seq = records.last().map_or(0, |record| record.seq);
                dirty = true;
            }

            // Repair a verbatim (`\\?\`) cwd persisted by an older build that
            // did not strip the prefix after `canonicalize()`. The prefix
            // breaks agent-side cwd→dir sanitization (`?` is illegal in
            let stripped = strip_verbatim_prefix(&metadata.cwd).into_owned();
            if stripped != metadata.cwd {
                log::info!(
                    "[acp-history] recover() healed verbatim cwd prefix for session_id={}",
                    crate::logging::redact_session_id(&metadata.session_id)
                );
                metadata.cwd = stripped;
                dirty = true;
            }
            // Agent subprocesses cannot survive a host restart. A session that
            // was still `Active` at shutdown has no live agent or writer to
            // restore, so mark it `Closed` before persisting: resume hooks
            // must not chase a dead process (reopen still works via
            // `openHistorySession` → agent respawn). `Error` stays `Error`.
            if metadata.status == PersistedSessionStatus::Active {
                metadata.status = PersistedSessionStatus::Closed;
                dirty = true;
            }
            if dirty {
                if let Err(e) = self.persist_metadata(&metadata) {
                    log::error!(
                        "[acp-history] recover() persist_metadata failed session_id={} error={e}",
                        crate::logging::redact_session_id(&metadata.session_id)
                    );
                    return Err(e);
                }
            }
            recovered.insert(metadata.session_id.clone(), metadata);
        }

        for metadata in recovered.values() {
            // Read-only catalog entries: no writer runtime survives a restart.
            self.install_catalog_entry(metadata.clone());
        }
        // The index is a cache. Always rebuild it from canonical per-session
        // metadata + logs so stale titles/status/counts/namespaces cannot survive.
        let _ = existing_index;
        self.persist_index().await?;
        Ok(())
    }

    fn install_runtime(&self, metadata: SessionMetadata) -> Result<()> {
        let session_id = metadata.session_id.clone();
        let metadata = Arc::new(Mutex::new(metadata));
        let unhealthy = Arc::new(Mutex::new(None));
        let (tx, rx) = mpsc::channel(WRITER_CAPACITY);
        let inner = Arc::clone(&self.inner);
        let task_metadata = Arc::clone(&metadata);
        let task_unhealthy = Arc::clone(&unhealthy);
        tokio::spawn(async move {
            writer_loop(inner, task_metadata, task_unhealthy, rx).await;
        });
        self.inner
            .catalog
            .lock()
            .insert(session_id.clone(), Arc::clone(&metadata));
        self.inner
            .sessions
            .lock()
            .insert(session_id, SessionRuntime { tx, unhealthy });
        Ok(())
    }

    fn install_catalog_entry(&self, metadata: SessionMetadata) {
        self.inner
            .catalog
            .lock()
            .insert(metadata.session_id.clone(), Arc::new(Mutex::new(metadata)));
    }

    fn runtime(&self, session_id: &str) -> Result<SessionRuntime> {
        self.inner
            .sessions
            .lock()
            .get(session_id)
            .cloned()
            .ok_or(SessionPersistenceError::SessionNotFound)
    }

    fn persist_metadata(&self, metadata: &SessionMetadata) -> Result<()> {
        let path = self.session_dir(&metadata.storage_key)?.join(METADATA_FILE);
        let bytes = serde_json::to_vec_pretty(metadata)?;
        atomic_file::replace(&path, &bytes)?;
        ensure_log_exists(&path.with_file_name(MESSAGES_FILE))?;
        ensure_log_exists(&path.with_file_name(TOOL_CALLS_FILE))?;
        Ok(())
    }

    async fn persist_index(&self) -> Result<()> {
        let _guard = self.inner.index_lock.lock().await;
        let mut sessions: Vec<_> = self
            .inner
            .catalog
            .lock()
            .values()
            .map(|metadata| SessionIndexEntry::from(&*metadata.lock()))
            .collect();
        sessions.sort_by_key(|entry| std::cmp::Reverse(entry.last_activity_at));
        let index = SessionIndexFile {
            schema_version: SESSION_SCHEMA_VERSION,
            sessions,
        };
        atomic_file::replace(
            &self.inner.root.join(INDEX_FILE),
            &serde_json::to_vec_pretty(&index)?,
        )?;
        Ok(())
    }

    fn session_dir(&self, storage_key: &str) -> Result<PathBuf> {
        if Uuid::parse_str(storage_key).is_err() {
            return Err(SessionPersistenceError::InvalidStorageKey);
        }
        Ok(self.inner.root.join(storage_key))
    }
}

#[cfg(test)]
mod tests;
