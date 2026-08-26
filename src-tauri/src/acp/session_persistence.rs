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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PersistedSessionStatus {
    Active,
    Closed,
    Error,
}

/// Provenance of a session's title, used to enforce title precedence
/// (AD-1): `LocalAlias > BackgroundGenerated > AgentSupplied >
/// DerivedFirstMessage > Untitled`. Once `title_source ==
/// BackgroundGenerated`, subsequent `session_info_update` events do NOT
/// overwrite the title. `LocalAlias` is reserved for a future local-rename
/// feature; it is the highest precedence so a user-chosen name always wins.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TitleSource {
    BackgroundGenerated,
    AgentSupplied,
    DerivedFirstMessage,
    LocalAlias,
}

/// Returns `true` when `source` is one of the precedence tiers the host must
/// protect from a later `session_info_update` overwrite (AD-1/AD-5). Used by
/// both `append_record` (durable defense) and the manager's notification
/// closure (fan-out defense).
#[must_use]
pub fn is_protected_title_source(source: Option<&TitleSource>) -> bool {
    matches!(
        source,
        Some(TitleSource::BackgroundGenerated) | Some(TitleSource::LocalAlias)
    )
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PersistedEventRecord {
    pub schema_version: u32,
    pub session_id: String,
    pub seq: u64,
    #[serde(rename = "type")]
    pub type_: String,
    pub recorded_at: u64,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetadata {
    pub schema_version: u32,
    pub storage_key: String,
    pub session_id: String,
    pub stable_agent_namespace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub cwd: String,
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_source: Option<TitleSource>,
    pub created_at: u64,
    pub last_activity_at: u64,
    pub status: PersistedSessionStatus,
    pub message_count: u64,
    pub tool_count: u64,
    pub last_seq: u64,
    /// Agent-owned metadata mirror created from ACP `session/list`.
    #[serde(default)]
    pub discovered: bool,
    /// Worktree path the agent runs in (CAP-3). Additive: old entries
    /// deserialize with `None`. State isolation still keys on `cwd`; this
    /// field powers the CAP-6 indicator + the deleted-worktree fallback.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionIndexEntry {
    pub storage_key: String,
    pub session_id: String,
    pub stable_agent_namespace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub cwd: String,
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_source: Option<TitleSource>,
    pub created_at: u64,
    pub last_activity_at: u64,
    pub status: PersistedSessionStatus,
    pub message_count: u64,
    pub tool_count: u64,
    pub last_seq: u64,
    #[serde(default)]
    pub discovered: bool,
    pub resume_eligible: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_branch: Option<String>,
}

impl From<&SessionMetadata> for SessionIndexEntry {
    fn from(metadata: &SessionMetadata) -> Self {
        Self {
            storage_key: metadata.storage_key.clone(),
            session_id: metadata.session_id.clone(),
            stable_agent_namespace: metadata.stable_agent_namespace.clone(),
            runtime_agent_id: metadata.runtime_agent_id.clone(),
            project_id: metadata.project_id.clone(),
            cwd: metadata.cwd.clone(),
            title: metadata.title.clone(),
            title_source: metadata.title_source.clone(),
            created_at: metadata.created_at,
            last_activity_at: metadata.last_activity_at,
            status: metadata.status.clone(),
            message_count: metadata.message_count,
            tool_count: metadata.tool_count,
            last_seq: metadata.last_seq,
            discovered: metadata.discovered,
            resume_eligible: metadata.stable_agent_namespace.is_some(),
            worktree_path: metadata.worktree_path.clone(),
            worktree_branch: metadata.worktree_branch.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionIndexFile {
    pub schema_version: u32,
    pub sessions: Vec<SessionIndexEntry>,
}

#[derive(Debug, Clone, Default)]
pub struct SessionRegistration {
    pub session_id: String,
    pub stable_agent_namespace: Option<String>,
    pub runtime_agent_id: Option<String>,
    pub project_id: Option<String>,
    pub cwd: PathBuf,
    pub worktree_path: Option<String>,
    pub worktree_branch: Option<String>,
}

#[derive(Debug)]
pub enum SessionPersistenceError {
    Io(io::Error),
    Json(serde_json::Error),
    UnsupportedVersion { found: u64 },
    SessionNotFound,
    CorruptSession,
    InvalidStorageKey,
    QueueFull,
    WriterStopped,
    PersistenceUnhealthy(String),
    StaleCursor { cursor: u64, last_seq: u64 },
}

impl std::fmt::Display for SessionPersistenceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "session persistence io error: {error}"),
            Self::Json(error) => write!(f, "session persistence json error: {error}"),
            Self::UnsupportedVersion { found } => {
                write!(f, "unsupported session schema version {found}")
            }
            Self::SessionNotFound => write!(f, "persisted session not found"),
            Self::CorruptSession => write!(f, "persisted session is corrupt"),
            Self::InvalidStorageKey => write!(f, "invalid session storage key"),
            Self::QueueFull => write!(f, "session writer queue is full"),
            Self::WriterStopped => write!(f, "session writer stopped"),
            Self::PersistenceUnhealthy(message) => {
                write!(f, "session persistence unhealthy: {message}")
            }
            Self::StaleCursor { cursor, last_seq } => write!(
                f,
                "cursor {cursor} is ahead of durable last sequence {last_seq}"
            ),
        }
    }
}

impl std::error::Error for SessionPersistenceError {}
impl From<io::Error> for SessionPersistenceError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}
impl From<serde_json::Error> for SessionPersistenceError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

type Result<T> = std::result::Result<T, SessionPersistenceError>;

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
        // `canonical.is_dir()` already verified above; the stripped string
        // refers to the same directory, so no second check is needed.
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
        fs::remove_dir_all(&dir)?;
        self.inner.catalog.lock().remove(session_id);
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

    pub fn replay_after(&self, session_id: &str, cursor: u64) -> Result<Vec<PersistedEventRecord>> {
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

    /// Tail-first variant of [`session_payload_async`]: materialize the full
    /// payload (same flush + replay), then keep only the last `limit` messages.
    /// Used by the lazy-load chat history path so the renderer can install the
    /// recent transcript immediately and fetch the full payload on scroll-up.
    /// The metadata's `messageCount` reflects the tail slice (not the full
    /// session), so the renderer knows how many messages it received.
    pub async fn session_payload_tail_async(
        self: &Arc<Self>,
        session_id: &str,
        limit: usize,
    ) -> Result<crate::acp::session_payload::MaterializedSessionPayload> {
        let mut payload = self.session_payload_async(session_id).await?;
        if payload.messages.len() > limit {
            payload.messages = payload.messages.split_off(payload.messages.len() - limit);
            payload.metadata.message_count = payload.messages.len() as u64;
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
            let mut records = match load_jsonl(&dir.join(MESSAGES_FILE), &metadata.session_id, true)
            {
                Ok(records) => records,
                Err(_) => continue,
            };
            match load_jsonl(&dir.join(TOOL_CALLS_FILE), &metadata.session_id, true) {
                Ok(tool_records) => records.extend(tool_records),
                Err(_) => continue,
            }
            if validate_and_sort(&mut records).is_err() {
                continue;
            }
            metadata.message_count = records
                .iter()
                .filter(|record| !is_tool_event(&record.type_))
                .count() as u64;
            metadata.tool_count = records
                .iter()
                .filter(|record| is_tool_event(&record.type_))
                .count() as u64;
            metadata.last_seq = records.last().map_or(0, |record| record.seq);
            // Repair a verbatim (`\\?\`) cwd persisted by an older build that
            // did not strip the prefix after `canonicalize()`. The prefix
            // breaks agent-side cwd→dir sanitization (`?` is illegal in
            // Windows folder names), so `session/resume` fails with ENOENT.
            // Stripping here + re-persisting below heals the entire index on
            // the next startup without a dedicated migration.
            let stripped = strip_verbatim_prefix(&metadata.cwd).into_owned();
            if stripped != metadata.cwd {
                metadata.cwd = stripped;
            }
            // Agent subprocesses cannot survive a host restart. A session that
            // was still `Active` at shutdown has no live agent or writer to
            // restore, so mark it `Closed` before persisting: resume hooks
            // must not chase a dead process (reopen still works via
            // `openHistorySession` → agent respawn). `Error` stays `Error`.
            if metadata.status == PersistedSessionStatus::Active {
                metadata.status = PersistedSessionStatus::Closed;
            }
            self.persist_metadata(&metadata)?;
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

async fn writer_loop(
    inner: Arc<Inner>,
    metadata: Arc<Mutex<SessionMetadata>>,
    unhealthy: Arc<Mutex<Option<String>>>,
    mut rx: mpsc::Receiver<WriterCommand>,
) {
    while let Some(command) = rx.recv().await {
        let result = match command {
            WriterCommand::Append(record) => append_record(&inner.root, &metadata, record),
            WriterCommand::AppendLocalTitle(title, reply) => {
                let seq = metadata.lock().last_seq + 1;
                let session_id = metadata.lock().session_id.clone();
                let result = append_record(
                    &inner.root,
                    &metadata,
                    PersistedEventRecord {
                        schema_version: SESSION_SCHEMA_VERSION,
                        session_id: session_id.clone(),
                        seq,
                        type_: "local_title_generated".to_string(),
                        recorded_at: now_millis(),
                        payload: serde_json::json!({
                            "sessionId": session_id,
                            "title": title,
                        }),
                    },
                );
                let reply_result = result.as_ref().map(|()| seq).map_err(|error| {
                    SessionPersistenceError::PersistenceUnhealthy(error.to_string())
                });
                let _ = reply.send(reply_result);
                result
            }
            WriterCommand::Flush(reply) => {
                let result = sync_session_files(&inner.root, &metadata);
                let _ = reply.send(result.clone_for_reply());
                result
            }
            WriterCommand::Finalize(status, reply) => {
                let snapshot = {
                    let mut current = metadata.lock();
                    current.status = status;
                    current.clone()
                };
                let result = persist_metadata_at_root(&inner.root, &snapshot)
                    .and_then(|()| sync_session_files(&inner.root, &metadata));
                let _ = reply.send(result.clone_for_reply());
                if let Err(error) = result {
                    *unhealthy.lock() = Some(error.to_string());
                }
                return;
            }
            WriterCommand::Shutdown(reply) => {
                let snapshot = metadata.lock().clone();
                let result = persist_metadata_at_root(&inner.root, &snapshot)
                    .and_then(|()| sync_session_files(&inner.root, &metadata));
                let _ = reply.send(result.clone_for_reply());
                if let Err(error) = result {
                    *unhealthy.lock() = Some(error.to_string());
                }
                break;
            }
        };
        if let Err(error) = result {
            *unhealthy.lock() = Some(error.to_string());
        }
    }
}

trait CloneForReply<T> {
    fn clone_for_reply(&self) -> Result<T>;
}
impl CloneForReply<()> for Result<()> {
    fn clone_for_reply(&self) -> Result<()> {
        match self {
            Ok(()) => Ok(()),
            Err(error) => Err(SessionPersistenceError::PersistenceUnhealthy(
                error.to_string(),
            )),
        }
    }
}

fn append_record(
    root: &Path,
    metadata: &Arc<Mutex<SessionMetadata>>,
    record: PersistedEventRecord,
) -> Result<()> {
    let mut current = metadata.lock();
    if record.session_id != current.session_id
        || record.schema_version != SESSION_SCHEMA_VERSION
        || record.seq <= current.last_seq
    {
        return Err(SessionPersistenceError::CorruptSession);
    }
    let dir = root.join(&current.storage_key);
    let path = dir.join(if is_tool_event(&record.type_) {
        TOOL_CALLS_FILE
    } else {
        MESSAGES_FILE
    });
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    let bytes = serde_json::to_vec(&record)?;
    file.write_all(&bytes)?;
    file.write_all(b"\n")?;
    file.flush()?;
    current.last_seq = record.seq;
    current.last_activity_at = record.recorded_at;
    if is_tool_event(&record.type_) {
        current.tool_count += 1;
    } else {
        current.message_count += 1;
    }
    if record.type_ == "user_prompt" && current.title.is_none() {
        current.title = Some(derive_title(&record.payload));
        current.title_source = Some(TitleSource::DerivedFirstMessage);
    }
    if record.type_ == "local_title_generated" {
        // AD-1: BackgroundGenerated wins over AgentSupplied and
        // DerivedFirstMessage. The host's background title-gen flow is the
        // sole emitter of this durable event (the manager enqueues it after a
        // successful background turn). A non-empty title here always wins
        // because the manager skips persistence when normalize_title returns
        // the "Untitled Chat" fallback floor (AD-6).
        let bg_title = record
            .payload
            .get("title")
            .and_then(Value::as_str)
            .map(normalize_title);
        if let Some(title) = bg_title {
            current.title = Some(title);
            current.title_source = Some(TitleSource::BackgroundGenerated);
        }
    }
    if record.type_ == "session_info_update" {
        // AD-1: once BackgroundGenerated/LocalAlias owns the title, a later
        // agent-supplied session_info_update must NOT overwrite it. Also set
        // the provenance to AgentSupplied on the non-protected path so a
        // subsequent background title (which DOES overwrite AgentSupplied)
        // still wins over the agent's pick.
        let agent_title = record
            .payload
            .get("title")
            .and_then(Value::as_str)
            .map(normalize_title);
        if !is_protected_title_source(current.title_source.as_ref()) {
            current.title = agent_title;
            current.title_source = Some(TitleSource::AgentSupplied);
        }
    }
    Ok(())
}

fn sync_session_files(root: &Path, metadata: &Arc<Mutex<SessionMetadata>>) -> Result<()> {
    let current = metadata.lock().clone();
    let dir = root.join(&current.storage_key);
    for name in [MESSAGES_FILE, TOOL_CALLS_FILE] {
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join(name))?
            .sync_all()?;
    }
    persist_metadata_at_root(root, &current)
}

fn persist_metadata_at_root(root: &Path, metadata: &SessionMetadata) -> Result<()> {
    let path = root.join(&metadata.storage_key).join(METADATA_FILE);
    atomic_file::replace(&path, &serde_json::to_vec_pretty(metadata)?)?;
    Ok(())
}

fn ensure_log_exists(path: &Path) -> Result<()> {
    if !path.exists() {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)?;
        file.sync_all()?;
    }
    Ok(())
}

fn decode_index(bytes: &[u8]) -> Result<SessionIndexFile> {
    decode_versioned(bytes)
}

fn decode_versioned<T>(bytes: &[u8]) -> Result<T>
where
    T: for<'de> Deserialize<'de>,
{
    let value: Value = serde_json::from_slice(bytes)?;
    let version = value
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .ok_or(SessionPersistenceError::CorruptSession)?;
    if version == u64::from(SESSION_SCHEMA_VERSION) {
        Ok(serde_json::from_value(value)?)
    } else {
        Err(SessionPersistenceError::UnsupportedVersion { found: version })
    }
}

fn load_jsonl(
    path: &Path,
    session_id: &str,
    repair_torn_tail: bool,
) -> Result<Vec<PersistedEventRecord>> {
    let bytes = fs::read(path)?;
    let mut records = Vec::new();
    let mut offset = 0usize;
    while offset < bytes.len() {
        let remainder = &bytes[offset..];
        let newline = remainder.iter().position(|byte| *byte == b'\n');
        let (line, next_offset, terminated) = match newline {
            Some(position) => (&remainder[..position], offset + position + 1, true),
            None => (remainder, bytes.len(), false),
        };
        if line.is_empty() {
            offset = next_offset;
            continue;
        }
        match serde_json::from_slice::<PersistedEventRecord>(line) {
            Ok(record)
                if record.schema_version == SESSION_SCHEMA_VERSION
                    && record.session_id == session_id =>
            {
                records.push(record)
            }
            Ok(_) => return Err(SessionPersistenceError::CorruptSession),
            Err(_) if repair_torn_tail && !terminated && next_offset == bytes.len() => {
                let _ = atomic_file::backup_corrupt(path, &bytes);
                atomic_file::replace(path, &bytes[..offset])?;
                break;
            }
            Err(_) => return Err(SessionPersistenceError::CorruptSession),
        }
        offset = next_offset;
    }
    Ok(records)
}

fn validate_and_sort(records: &mut [PersistedEventRecord]) -> Result<()> {
    records.sort_by_key(|record| record.seq);
    let mut previous = 0;
    for record in records {
        if record.seq == 0 || record.seq <= previous {
            return Err(SessionPersistenceError::CorruptSession);
        }
        previous = record.seq;
    }
    Ok(())
}

#[must_use]
pub fn is_durable_event(type_: &str) -> bool {
    !matches!(
        type_,
        "permission_request"
            | "auth_required"
            | "agent_spawned"
            | "agent_disconnected"
            | "agent_crashed"
            | "projects_changed"
            | "project_switch_completed"
            | "project_switch_failed"
    )
}

fn is_tool_event(type_: &str) -> bool {
    matches!(type_, "tool_call" | "tool_call_update")
}

fn normalize_durable_payload(type_: &str, payload: &Value) -> Value {
    if matches!(type_, "tool_call" | "tool_call_update") {
        // Strict DTO: tool-authored free-form content, arguments, output, and
        // unknown fields are never durable. Only structural routing/status
        // fields required to reconstruct the timeline are admitted.
        let mut event = serde_json::Map::new();
        for field in ["agentId", "sessionId"] {
            if let Some(value) = payload.get(field) {
                event.insert(field.to_string(), value.clone());
            }
        }
        let key = if type_ == "tool_call" {
            "toolCall"
        } else {
            "update"
        };
        if let Some(tool) = payload.get(key).and_then(Value::as_object) {
            let mut reduced = serde_json::Map::new();
            for field in ["toolCallId", "kind", "status"] {
                if let Some(value) = tool.get(field) {
                    reduced.insert(field.to_string(), value.clone());
                }
            }
            event.insert(key.to_string(), Value::Object(reduced));
        }
        Value::Object(event)
    } else {
        sanitize_value(None, payload)
    }
}

fn sanitize_value(key: Option<&str>, value: &Value) -> Value {
    if key.is_some_and(is_secret_key) {
        return Value::String("[REDACTED]".to_string());
    }
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(key, _)| !is_secret_key(key))
                .map(|(key, value)| (key.clone(), sanitize_value(Some(key), value)))
                .collect(),
        ),
        Value::Array(values) => Value::Array(
            values
                .iter()
                .map(|value| sanitize_value(None, value))
                .collect(),
        ),
        _ => value.clone(),
    }
}

fn is_secret_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    normalized == "env"
        || normalized == "headers"
        || normalized == "authorization"
        || normalized == "auth"
        || normalized == "rawinput"
        || normalized == "rawoutput"
        || normalized.contains("secret")
        || normalized.contains("token")
        || normalized.contains("password")
        || normalized.contains("apikey")
        || normalized.contains("credential")
        || normalized.contains("cookie")
}

pub(crate) fn normalize_title(text: &str) -> String {
    fn strip_wrappers(mut value: &str) -> &str {
        loop {
            let next = value
                .trim()
                .trim_matches(['"', '\'', '`'])
                .trim_matches('_')
                .trim_matches('*')
                .trim();
            if next == value {
                return next;
            }
            value = next;
        }
    }

    let mut lines = text
        .split(['\n', '\r'])
        .map(str::trim)
        .filter(|line| !line.is_empty());
    let mut sanitized = strip_wrappers(lines.next().unwrap_or_default());
    let lowercase = sanitized.to_ascii_lowercase();
    const PREAMBLES: &[&str] = &[
        "sure! here's the title:",
        "sure, here's the title:",
        "here's the title:",
        "the title is:",
        "title:",
    ];
    if let Some(prefix) = PREAMBLES
        .iter()
        .find(|prefix| lowercase.starts_with(**prefix))
    {
        sanitized = strip_wrappers(&sanitized[prefix.len()..]);
        if sanitized.is_empty() {
            sanitized = strip_wrappers(lines.next().unwrap_or_default());
        }
    } else if lowercase == "what should we do?" {
        sanitized = strip_wrappers(lines.next().unwrap_or_default());
    }

    if sanitized.is_empty() {
        return "Untitled Chat".to_string();
    }
    let bounded: String = sanitized.chars().take(48).collect();
    if sanitized.chars().count() > 48 {
        format!("{bounded}…")
    } else {
        bounded
    }
}

fn derive_title(payload: &Value) -> String {
    let text = payload
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find_map(|block| {
            (block.get("type").and_then(Value::as_str) == Some("text"))
                .then(|| block.get("text").and_then(Value::as_str))
                .flatten()
        })
        .unwrap_or("Untitled Chat");
    normalize_title(text)
}

#[must_use]
pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "termul-sessions-{label}-{}-{}",
            std::process::id(),
            now_millis()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    async fn registered(root: &Path) -> (Arc<SessionPersistence>, SessionMetadata) {
        let cwd = root.join("cwd");
        fs::create_dir_all(&cwd).unwrap();
        let persistence = SessionPersistence::open(root.join("store")).await.unwrap();
        let metadata = persistence
            .register_session(SessionRegistration {
                session_id: "session-1".to_string(),
                stable_agent_namespace: Some("config:one".to_string()),
                runtime_agent_id: Some("runtime-1".to_string()),
                project_id: Some("project-1".to_string()),
                cwd,
                ..Default::default()
            })
            .await
            .unwrap();
        (persistence, metadata)
    }

    fn record(seq: u64, type_: &str) -> PersistedEventRecord {
        PersistedEventRecord {
            schema_version: SESSION_SCHEMA_VERSION,
            session_id: "session-1".to_string(),
            seq,
            type_: type_.to_string(),
            recorded_at: now_millis(),
            payload: json!({"sessionId":"session-1","content":[{"type":"text","text":"hello"}]}),
        }
    }

    #[test]
    fn normalize_title_uses_first_line_sanitizes_and_bounds_to_48() {
        assert_eq!(
            normalize_title("  **`Fix login bug`**  \nignored explanation"),
            "Fix login bug"
        );
        assert_eq!(
            normalize_title("Sure! Here's the title:\nFix login bug"),
            "Fix login bug"
        );
        assert_eq!(normalize_title("Title: Fix login bug"), "Fix login bug");
        let long = "a".repeat(60);
        let normalized = normalize_title(&long);
        assert_eq!(normalized.chars().count(), 49);
        assert!(normalized.ends_with('…'));
        assert_eq!(normalize_title(" \nsecond line"), "second line");
        assert_eq!(normalize_title(" \n \r"), "Untitled Chat");
    }

    #[tokio::test]
    async fn register_discovered_session_is_metadata_only_agent_supplied_and_idempotent() {
        let root = temp_dir("discovered");
        let cwd = root.join("cwd");
        fs::create_dir_all(&cwd).unwrap();
        let persistence = SessionPersistence::open(root.join("store")).await.unwrap();
        let registration = SessionRegistration {
            session_id: "discovered-1".into(),
            stable_agent_namespace: Some("config:test".into()),
            runtime_agent_id: Some("agent-1".into()),
            project_id: Some("project-1".into()),
            cwd,
            ..Default::default()
        };
        let first = persistence
            .register_discovered_session(registration.clone(), Some("Agent title".into()), Some(42))
            .await
            .unwrap();
        assert_eq!(first.status, PersistedSessionStatus::Active);
        persistence.shutdown().await.unwrap();
        let persistence = SessionPersistence::open(root.join("store")).await.unwrap();
        let second = persistence
            .register_discovered_session(registration.clone(), Some("Replacement".into()), Some(99))
            .await
            .unwrap();
        assert_eq!(first.storage_key, second.storage_key);
        assert_eq!(second.title.as_deref(), Some("Replacement"));
        assert_eq!(second.title_source, Some(TitleSource::AgentSupplied));
        assert_eq!(second.status, PersistedSessionStatus::Active);
        assert_eq!(second.runtime_agent_id.as_deref(), Some("agent-1"));
        assert_eq!(second.message_count, 0);
        assert_eq!(second.tool_count, 0);
        assert_eq!(second.last_seq, 0);
        assert!(persistence
            .replay_after("discovered-1", 0)
            .unwrap()
            .is_empty());
        let mut conflicting = registration;
        conflicting.stable_agent_namespace = Some("config:other".into());
        let conflict = persistence
            .register_discovered_session(conflicting, Some("Wrong owner".into()), Some(100))
            .await
            .unwrap_err();
        assert!(conflict
            .to_string()
            .contains("conflicts with an existing session scope"));
        assert_eq!(
            persistence
                .metadata("discovered-1")
                .unwrap()
                .title
                .as_deref(),
            Some("Replacement")
        );
        persistence.shutdown().await.unwrap();
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn first_run_registers_and_round_trips_interleaved_replay() {
        let root = temp_dir("roundtrip");
        let (persistence, metadata) = registered(&root).await;
        for (seq, type_) in [
            (1, "user_prompt"),
            (2, "message_chunk"),
            (3, "tool_call"),
            (4, "message_chunk"),
            (5, "tool_call_update"),
            (6, "prompt_complete"),
        ] {
            persistence.enqueue_event(record(seq, type_)).unwrap();
        }
        persistence.flush_session("session-1").await.unwrap();
        assert_eq!(
            persistence
                .replay_after("session-1", 2)
                .unwrap()
                .iter()
                .map(|r| r.seq)
                .collect::<Vec<_>>(),
            vec![3, 4, 5, 6]
        );
        persistence.shutdown().await.unwrap();

        let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
        assert_eq!(reopened.last_seq("session-1").unwrap(), 6);
        assert_eq!(
            reopened.metadata("session-1").unwrap().storage_key,
            metadata.storage_key
        );
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn register_session_strips_verbatim_cwd_prefix_on_windows() {
        // `canonicalize()` prepends `\\?\` on Windows. The persisted `cwd`
        // must be stripped so `session/resume` passes a tool-friendly path
        // to the agent (whose cwd→dir sanitizer keeps `?` → illegal folder
        // name → `mkdir` ENOENT → resume skipped). This test creates a real
        // temp dir, canonicalizes it (so the verbatim prefix is present in
        // the `PathBuf`), and asserts the persisted `cwd` has no prefix.
        let root = temp_dir("verbatim-strip");
        let cwd = root.join("cwd");
        fs::create_dir_all(&cwd).unwrap();
        // `canonicalize()` yields `\\?\C:\…\cwd` on Windows.
        let canonical_cwd = cwd.canonicalize().unwrap();
        assert!(
            canonical_cwd.to_string_lossy().starts_with(r"\\?\"),
            "sanity: canonicalize should produce a verbatim prefix on Windows"
        );
        let persistence = SessionPersistence::open(root.join("store")).await.unwrap();
        let metadata = persistence
            .register_session(SessionRegistration {
                session_id: "session-verbatim".to_string(),
                stable_agent_namespace: Some("config:test".to_string()),
                runtime_agent_id: Some("runtime-1".to_string()),
                project_id: Some("project-1".to_string()),
                cwd: canonical_cwd,
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(
            !metadata.cwd.starts_with(r"\\?\"),
            "persisted cwd must not carry the verbatim prefix, got: {}",
            metadata.cwd
        );
        // `recover()` must heal a verbatim cwd persisted by an older build.
        // Manually corrupt the metadata on disk, then reopen.
        {
            let dir = persistence
                .session_dir(&metadata.storage_key)
                .unwrap();
            let metadata_path = dir.join(METADATA_FILE);
            let mut corrupt = metadata.clone();
            corrupt.cwd = format!(r"\\?\{}", corrupt.cwd);
            let bytes = serde_json::to_vec_pretty(&corrupt).unwrap();
            std::fs::write(&metadata_path, &bytes).unwrap();
        }
        persistence.shutdown().await.unwrap();
        let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
        let healed = reopened.metadata("session-verbatim").unwrap();
        assert!(
            !healed.cwd.starts_with(r"\\?\"),
            "recover() must strip a verbatim prefix from a legacy persisted cwd, got: {}",
            healed.cwd
        );
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn concurrent_queue_serializes_unique_sequences() {
        let root = temp_dir("serialize");
        let (persistence, _) = registered(&root).await;
        let sequence = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let mut producers = Vec::new();
        for _ in 0..8 {
            let persistence = Arc::clone(&persistence);
            let sequence = Arc::clone(&sequence);
            producers.push(tokio::spawn(async move {
                for _ in 0..25 {
                    let seq = sequence.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                    persistence
                        .enqueue_event(record(seq, "message_chunk"))
                        .unwrap();
                }
            }));
        }
        for producer in producers {
            producer.await.unwrap();
        }
        persistence.flush_session("session-1").await.unwrap();
        let replay = persistence.replay_after("session-1", 0).unwrap();
        assert_eq!(replay.len(), 200);
        assert_eq!(
            replay.iter().map(|record| record.seq).collect::<Vec<_>>(),
            (1..=200).collect::<Vec<_>>()
        );
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn different_sessions_progress_independently_and_finalize_drains_prior_writes() {
        let root = temp_dir("independent");
        let (persistence, _) = registered(&root).await;
        let cwd2 = root.join("cwd2");
        fs::create_dir_all(&cwd2).unwrap();
        persistence
            .register_session(SessionRegistration {
                session_id: "session-2".into(),
                stable_agent_namespace: None,
                runtime_agent_id: None,
                project_id: None,
                cwd: cwd2,
                ..Default::default()
            })
            .await
            .unwrap();
        for seq in 1..=50 {
            persistence
                .enqueue_event(record(seq, "message_chunk"))
                .unwrap();
            let mut other = record(seq, "message_chunk");
            other.session_id = "session-2".into();
            persistence.enqueue_event(other).unwrap();
        }
        persistence
            .finalize_session("session-1", PersistedSessionStatus::Closed)
            .await
            .unwrap();
        assert!(
            !persistence.inner.sessions.lock().contains_key("session-1"),
            "finalization must remove the dead writer runtime"
        );
        assert_eq!(
            persistence.metadata("session-1").unwrap().status,
            PersistedSessionStatus::Closed,
            "finalized metadata remains available for listing/replay"
        );
        persistence.flush_session("session-2").await.unwrap();
        assert_eq!(persistence.replay_after("session-1", 0).unwrap().len(), 50);
        assert_eq!(persistence.replay_after("session-2", 0).unwrap().len(), 50);
        assert_eq!(
            persistence.metadata("session-1").unwrap().status,
            PersistedSessionStatus::Closed
        );
        assert!(matches!(
            persistence.enqueue_event(record(51, "message_chunk")),
            Err(SessionPersistenceError::SessionNotFound)
        ));
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn failed_finalize_removes_writer_and_retains_read_only_catalog() {
        let root = temp_dir("finalize-failure");
        let (persistence, metadata) = registered(&root).await;
        persistence
            .enqueue_event(record(1, "message_chunk"))
            .unwrap();
        let session_dir = root.join("store").join(&metadata.storage_key);
        fs::remove_file(session_dir.join(METADATA_FILE)).unwrap();
        fs::create_dir(session_dir.join(METADATA_FILE)).unwrap();

        assert!(persistence
            .finalize_session("session-1", PersistedSessionStatus::Closed)
            .await
            .is_err());
        assert!(!persistence.inner.sessions.lock().contains_key("session-1"));
        assert_eq!(
            persistence.metadata("session-1").unwrap().status,
            PersistedSessionStatus::Closed
        );
        assert!(matches!(
            persistence.enqueue_event(record(2, "message_chunk")),
            Err(SessionPersistenceError::SessionNotFound)
        ));
        let replay = persistence.replay_after("session-1", 0).unwrap();
        assert_eq!(replay.len(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn durable_payload_redacts_secret_fields_and_bounds_titles() {
        let root = temp_dir("redaction");
        let (persistence, metadata) = registered(&root).await;
        let mut event = record(1, "tool_call");
        event.payload = json!({
            "agentId":"a", "sessionId":"session-1",
            "toolCall": {"toolCallId":"t", "title":"ordinary-text-token-123",
                "kind":"execute", "status":"pending",
                "rawInput":{"apiKey":"secret"}, "headers":{"Authorization":"bearer"},
                "content":[{"type":"content","content":{"type":"text","text":"ordinary-text-token-123"}}]}
        });
        persistence.enqueue_event(event).unwrap();
        let mut title = record(2, "session_info_update");
        title.payload = json!({"sessionId":"session-1", "title": format!("  {}  ", "x".repeat(100)), "token":"secret"});
        persistence.enqueue_event(title).unwrap();
        persistence.flush_session("session-1").await.unwrap();
        let records = persistence.replay_after("session-1", 0).unwrap();
        let serialized = serde_json::to_string(&records).unwrap();
        assert!(!serialized.contains("secret"));
        assert!(!serialized.contains("rawInput"));
        assert!(!serialized.contains("Authorization"));
        assert!(!serialized.contains("ordinary-text-token-123"));
        assert!(serialized.contains("toolCallId"));
        assert!(serialized.contains("execute"));
        assert_eq!(
            persistence
                .metadata("session-1")
                .unwrap()
                .title
                .unwrap()
                .chars()
                .count(),
            49
        );
        let tool_log = fs::read_to_string(
            root.join("store")
                .join(metadata.storage_key)
                .join(TOOL_CALLS_FILE),
        )
        .unwrap();
        assert!(!tool_log.contains("apiKey"));
        assert!(!tool_log.contains("ordinary-text-token-123"));
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn completed_turn_ids_recover_after_restart() {
        let root = temp_dir("completed-turns");
        let (persistence, _) = registered(&root).await;
        let mut complete = record(1, "prompt_complete");
        complete.payload =
            json!({"sessionId":"session-1", "turnId":"turn-1", "stopReason":"end_turn"});
        persistence.enqueue_event(complete).unwrap();
        persistence.shutdown().await.unwrap();
        let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
        assert!(reopened
            .completed_turn_ids("session-1")
            .unwrap()
            .contains("turn-1"));
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn future_index_version_is_rejected_without_rewrite() {
        let root = temp_dir("future");
        let store = root.join("store");
        fs::create_dir_all(&store).unwrap();
        let path = store.join(INDEX_FILE);
        let bytes = br#"{"schemaVersion":99,"sessions":[]}"#;
        fs::write(&path, bytes).unwrap();
        assert!(matches!(
            SessionPersistence::open(store).await,
            Err(SessionPersistenceError::UnsupportedVersion { found: 99 })
        ));
        assert_eq!(fs::read(path).unwrap(), bytes);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn overflowing_index_and_metadata_versions_are_rejected_without_rewrite() {
        let root = temp_dir("version-overflow");
        let store = root.join("store");
        fs::create_dir_all(&store).unwrap();
        let index = store.join(INDEX_FILE);
        let overflow = u64::from(u32::MAX) + 1;
        let index_bytes = format!(r#"{{"schemaVersion":{overflow},"sessions":[]}}"#);
        fs::write(&index, index_bytes.as_bytes()).unwrap();
        assert!(matches!(
            SessionPersistence::open(store.clone()).await,
            Err(SessionPersistenceError::UnsupportedVersion { found }) if found == overflow
        ));
        assert_eq!(fs::read(&index).unwrap(), index_bytes.as_bytes());

        fs::remove_file(&index).unwrap();
        let key = Uuid::new_v4().to_string();
        let dir = store.join(&key);
        fs::create_dir_all(&dir).unwrap();
        let metadata = dir.join(METADATA_FILE);
        let metadata_bytes = format!(r#"{{"schemaVersion":{overflow},"storageKey":"{key}"}}"#);
        fs::write(&metadata, metadata_bytes.as_bytes()).unwrap();
        assert!(matches!(
            SessionPersistence::open(store).await,
            Err(SessionPersistenceError::UnsupportedVersion { found }) if found == overflow
        ));
        assert_eq!(fs::read(metadata).unwrap(), metadata_bytes.as_bytes());
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn corrupt_index_is_backed_up_and_rebuilt() {
        let root = temp_dir("corrupt-index");
        let (persistence, _) = registered(&root).await;
        persistence.shutdown().await.unwrap();
        let index = root.join("store").join(INDEX_FILE);
        fs::write(&index, b"bad json").unwrap();
        let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
        assert_eq!(reopened.list_sessions().len(), 1);
        let backups = fs::read_dir(root.join("store"))
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().contains("corrupt-"))
            .count();
        assert_eq!(backups, 1);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn torn_final_tail_repairs_but_middle_corruption_quarantines() {
        let root = temp_dir("tails");
        let (persistence, metadata) = registered(&root).await;
        persistence
            .enqueue_event(record(1, "message_chunk"))
            .unwrap();
        persistence.flush_session("session-1").await.unwrap();
        persistence.shutdown().await.unwrap();
        let log = root
            .join("store")
            .join(&metadata.storage_key)
            .join(MESSAGES_FILE);
        fs::OpenOptions::new()
            .append(true)
            .open(&log)
            .unwrap()
            .write_all(b"{torn")
            .unwrap();
        let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
        assert_eq!(reopened.last_seq("session-1").unwrap(), 1);
        reopened.shutdown().await.unwrap();
        fs::write(&log, b"bad\n{}\n").unwrap();
        let quarantined = SessionPersistence::open(root.join("store")).await.unwrap();
        assert!(quarantined.list_sessions().is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn corrupt_metadata_isolated_from_other_session() {
        let root = temp_dir("metadata-isolation");
        let (persistence, first) = registered(&root).await;
        let cwd2 = root.join("cwd2");
        fs::create_dir_all(&cwd2).unwrap();
        let second = persistence
            .register_session(SessionRegistration {
                session_id: "session-2".into(),
                stable_agent_namespace: None,
                runtime_agent_id: None,
                project_id: None,
                cwd: cwd2,
                ..Default::default()
            })
            .await
            .unwrap();
        persistence.shutdown().await.unwrap();
        fs::write(
            root.join("store")
                .join(first.storage_key)
                .join(METADATA_FILE),
            b"bad",
        )
        .unwrap();
        let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
        assert_eq!(reopened.list_sessions().len(), 1);
        assert_eq!(reopened.list_sessions()[0].storage_key, second.storage_key);
        assert!(!reopened.list_sessions()[0].resume_eligible);
        let _ = fs::remove_dir_all(root);
    }

    fn payload_record(seq: u64, type_: &str, payload: Value) -> PersistedEventRecord {
        PersistedEventRecord {
            schema_version: SESSION_SCHEMA_VERSION,
            session_id: "session-1".to_string(),
            seq,
            type_: type_.to_string(),
            recorded_at: 1_000 + seq,
            payload,
        }
    }

    fn enqueue_turn(
        persistence: &SessionPersistence,
        seq: u64,
        turn_id: &str,
        prompt: &str,
        reply: &str,
    ) {
        persistence
            .enqueue_event(payload_record(
                seq,
                "user_prompt",
                json!({
                    "agentId": "runtime-1",
                    "sessionId": "session-1",
                    "turnId": turn_id,
                    "content": [{"type": "text", "text": prompt}],
                }),
            ))
            .unwrap();
        persistence
            .enqueue_event(payload_record(
                seq + 1,
                "message_chunk",
                json!({
                    "agentId": "runtime-1",
                    "sessionId": "session-1",
                    "role": "agent",
                    "content": {"type": "text", "text": reply},
                }),
            ))
            .unwrap();
        persistence
            .enqueue_event(payload_record(
                seq + 2,
                "prompt_complete",
                json!({"sessionId": "session-1", "turnId": turn_id, "stopReason": "end_turn"}),
            ))
            .unwrap();
    }

    #[tokio::test]
    async fn session_payload_round_trips_materialized_transcript() {
        let root = temp_dir("payload-roundtrip");
        let (persistence, _) = registered(&root).await;
        enqueue_turn(&persistence, 1, "turn-1", "hello", "world");
        // tool_call between text runs splits the agent bubble.
        persistence
            .enqueue_event(payload_record(
                4,
                "tool_call",
                json!({
                    "agentId": "runtime-1",
                    "sessionId": "session-1",
                    "toolCall": {"toolCallId": "t-1", "kind": "execute", "status": "completed"},
                }),
            ))
            .unwrap();
        persistence
            .enqueue_event(payload_record(
                5,
                "message_chunk",
                json!({
                    "agentId": "runtime-1",
                    "sessionId": "session-1",
                    "role": "agent",
                    "content": {"type": "text", "text": "after tool"},
                }),
            ))
            .unwrap();
        persistence
            .enqueue_event(payload_record(
                6,
                "prompt_complete",
                json!({"sessionId": "session-1", "turnId": "turn-1", "stopReason": "end_turn"}),
            ))
            .unwrap();

        let payload = persistence
            .session_payload_async("session-1")
            .await
            .unwrap();
        assert_eq!(payload.metadata.id, "session-1");
        assert_eq!(payload.metadata.agent_config_id.as_deref(), Some("one"));
        assert_eq!(payload.metadata.agent_id, "runtime-1");
        assert_eq!(payload.metadata.project_id, "project-1");
        assert_eq!(payload.metadata.status, PersistedSessionStatus::Active);
        assert_eq!(payload.metadata.message_count, 3);
        assert_eq!(payload.metadata.last_seq, 6);
        assert_eq!(
            payload
                .messages
                .iter()
                .map(|message| (message.id.as_str(), message.seq))
                .collect::<Vec<_>>(),
            vec![
                ("turn:turn-1", 1),
                ("snapshot:agent:2", 2),
                ("snapshot:agent:5", 5),
            ]
        );
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn session_payload_async_unknown_session_is_not_found() {
        let root = temp_dir("payload-not-found");
        let (persistence, _) = registered(&root).await;
        let error = persistence
            .session_payload_async("missing")
            .await
            .unwrap_err();
        assert!(matches!(error, SessionPersistenceError::SessionNotFound));
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn restart_downgrades_active_to_closed_without_writer() {
        let root = temp_dir("restart-downgrade");
        let (persistence, _) = registered(&root).await;
        enqueue_turn(&persistence, 1, "turn-1", "hello", "world");
        assert_eq!(
            persistence.metadata("session-1").unwrap().status,
            PersistedSessionStatus::Active
        );
        persistence.shutdown().await.unwrap();

        let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
        let metadata = reopened.metadata("session-1").unwrap();
        assert_eq!(
            metadata.status,
            PersistedSessionStatus::Closed,
            "restarted host must not claim the dead agent's session is active"
        );
        assert!(
            !reopened.inner.sessions.lock().contains_key("session-1"),
            "no writer runtime may be reinstalled after restart"
        );
        assert!(matches!(
            reopened.enqueue_event(record(4, "message_chunk")),
            Err(SessionPersistenceError::SessionNotFound)
        ));
        // The payload stays fetchable read-only after the downgrade.
        let payload = reopened.session_payload_async("session-1").await.unwrap();
        assert_eq!(payload.metadata.status, PersistedSessionStatus::Closed);
        assert_eq!(payload.messages.len(), 2);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn session_payload_survives_reopen_identically() {
        let root = temp_dir("payload-reopen");
        let (persistence, _) = registered(&root).await;
        enqueue_turn(&persistence, 1, "turn-1", "hello", "world");
        let before = serde_json::to_value(
            persistence
                .session_payload_async("session-1")
                .await
                .unwrap(),
        )
        .unwrap();
        persistence.shutdown().await.unwrap();

        let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
        let after =
            serde_json::to_value(reopened.session_payload_async("session-1").await.unwrap())
                .unwrap();
        // `status` is expected to differ (Active → Closed across restart); the
        // transcript itself must survive byte-identically.
        assert_eq!(before["messages"], after["messages"]);
        assert_eq!(before["metadata"]["id"], after["metadata"]["id"]);
        assert_eq!(before["metadata"]["lastSeq"], after["metadata"]["lastSeq"]);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn session_payload_readable_after_finalize_removes_writer() {
        let root = temp_dir("payload-finalized");
        let (persistence, _) = registered(&root).await;
        enqueue_turn(&persistence, 1, "turn-1", "hello", "world");
        persistence
            .finalize_session("session-1", PersistedSessionStatus::Closed)
            .await
            .unwrap();
        // Finalization removed the writer; the flush barrier short-circuits and
        // the payload is served read-only from the durable log.
        let payload = persistence
            .session_payload_async("session-1")
            .await
            .unwrap();
        assert_eq!(payload.metadata.status, PersistedSessionStatus::Closed);
        assert_eq!(payload.messages.len(), 2);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn session_payload_corrupt_log_fails_closed() {
        let root = temp_dir("payload-corrupt");
        let (persistence, _) = registered(&root).await;
        enqueue_turn(&persistence, 1, "turn-1", "hello", "world");
        persistence
            .finalize_session("session-1", PersistedSessionStatus::Closed)
            .await
            .unwrap();
        // Simulate storage degradation: append an invalid record to the
        // transcript log. The read must surface an error — never fabricate an
        // empty payload that would wipe the client's transcript.
        let storage_key = persistence.metadata("session-1").unwrap().storage_key;
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(persistence.root().join(&storage_key).join(MESSAGES_FILE))
            .unwrap();
        file.write_all(b"{not valid json}\n").unwrap();
        file.flush().unwrap();
        drop(file);
        let error = persistence
            .session_payload_async("session-1")
            .await
            .unwrap_err();
        assert!(
            matches!(error, SessionPersistenceError::CorruptSession),
            "a malformed durable record must surface as CorruptSession, got: {error}"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn restart_preserves_error_status_without_downgrade() {
        let root = temp_dir("restart-error");
        let (persistence, _) = registered(&root).await;
        enqueue_turn(&persistence, 1, "turn-1", "hello", "world");
        persistence
            .finalize_session("session-1", PersistedSessionStatus::Error)
            .await
            .unwrap();
        persistence.shutdown().await.unwrap();

        let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
        assert_eq!(
            reopened.metadata("session-1").unwrap().status,
            PersistedSessionStatus::Error,
            "only Active sessions downgrade on restart; Error must survive as-is"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn open_rejects_a_file_root() {
        // Degraded-mode source: callers must be able to detect an unusable
        // sessions root at startup (the desktop then boots live-only).
        let root = temp_dir("open-file-root");
        let file_path = root.join("not-a-dir");
        fs::write(&file_path, b"x").unwrap();
        let error = match SessionPersistence::open(file_path).await {
            Ok(_) => panic!("a non-directory root must not open"),
            Err(error) => error,
        };
        assert!(
            matches!(error, SessionPersistenceError::Io(_)),
            "a non-directory root must surface as an IO error, got: {error}"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn delete_session_removes_live_writer_directory_and_index_entry() {
        let root = temp_dir("delete-live");
        let (persistence, _) = registered(&root).await;
        enqueue_turn(&persistence, 1, "turn-1", "hello", "world");
        let storage_key = persistence.metadata("session-1").unwrap().storage_key;
        persistence.delete_session("session-1").await.unwrap();
        assert!(matches!(
            persistence.metadata("session-1"),
            Err(SessionPersistenceError::SessionNotFound)
        ));
        assert!(persistence.list_sessions().is_empty());
        assert!(!persistence.root().join(&storage_key).exists());
        // The writer runtime is gone with the session.
        assert!(matches!(
            persistence.enqueue_event(record(4, "message_chunk")),
            Err(SessionPersistenceError::SessionNotFound)
        ));
        persistence.shutdown().await.unwrap();
        // Nothing must resurrect on reopen.
        let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
        assert!(reopened.list_sessions().is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn delete_session_works_for_finalized_and_unknown_ids() {
        let root = temp_dir("delete-finalized");
        let (persistence, _) = registered(&root).await;
        enqueue_turn(&persistence, 1, "turn-1", "hello", "world");
        persistence
            .finalize_session("session-1", PersistedSessionStatus::Closed)
            .await
            .unwrap();
        persistence.delete_session("session-1").await.unwrap();
        assert!(matches!(
            persistence.delete_session("session-1").await,
            Err(SessionPersistenceError::SessionNotFound)
        ));
        assert!(matches!(
            persistence.delete_session("missing").await,
            Err(SessionPersistenceError::SessionNotFound)
        ));
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn find_most_recent_for_project_filters_and_orders() {
        let root = temp_dir("find-project");
        let cwd = root.join("cwd");
        fs::create_dir_all(&cwd).unwrap();
        let persistence = SessionPersistence::open(root.join("store")).await.unwrap();
        for (session_id, project, namespace) in [
            ("a", Some("project-1"), Some("config:one")),
            ("b", Some("project-1"), Some("config:two")),
            ("c", Some("project-2"), Some("config:one")),
            // No stable namespace but a runtime agent id — still an identity.
            ("d", Some("project-1"), None),
        ] {
            persistence
                .register_session(SessionRegistration {
                    session_id: session_id.to_string(),
                    stable_agent_namespace: namespace.map(str::to_string),
                    runtime_agent_id: Some(format!("runtime-{session_id}")),
                    project_id: project.map(str::to_string),
                    cwd: cwd.clone(),
                    ..Default::default()
                })
                .await
                .unwrap();
        }
        // Deterministic activity ordering via explicit recorded_at.
        let bump = |session_id: &str, recorded_at: u64| PersistedEventRecord {
            schema_version: SESSION_SCHEMA_VERSION,
            session_id: session_id.to_string(),
            seq: 1,
            type_: "message_chunk".to_string(),
            recorded_at,
            payload: json!({"sessionId": session_id, "role": "agent", "content": [{"type": "text", "text": "hi"}]}),
        };
        persistence.enqueue_event(bump("a", 1_000)).unwrap();
        persistence.enqueue_event(bump("b", 3_000)).unwrap();
        persistence.enqueue_event(bump("d", 5_000)).unwrap();
        for session_id in ["a", "b", "d"] {
            persistence.flush_session(session_id).await.unwrap();
        }

        let cwd_str = persistence.metadata("a").unwrap().cwd;
        let hit = persistence
            .find_most_recent_for_project("project-1", &cwd_str, None)
            .unwrap();
        assert_eq!(hit.session_id, "d", "most recent activity wins");
        let narrowed = persistence
            .find_most_recent_for_project("project-1", &cwd_str, Some("config:one"))
            .unwrap();
        assert_eq!(narrowed.session_id, "a");
        assert!(persistence
            .find_most_recent_for_project("project-1", &cwd_str, Some("config:missing"))
            .is_none());
        assert!(persistence
            .find_most_recent_for_project("project-9", &cwd_str, None)
            .is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn unclean_exit_still_downgrades_active_on_restart() {
        let root = temp_dir("restart-crash");
        let (persistence, _) = registered(&root).await;
        enqueue_turn(&persistence, 1, "turn-1", "hello", "world");
        // Durable on disk, but NO finalize/shutdown: simulates a kill/crash, so
        // the on-disk status stays `Active` behind a dead host process.
        persistence.flush_session("session-1").await.unwrap();
        drop(persistence);

        let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
        assert_eq!(
            reopened.metadata("session-1").unwrap().status,
            PersistedSessionStatus::Closed,
            "an unclean shutdown must not leave a dead session claiming Active"
        );
        let payload = reopened.session_payload_async("session-1").await.unwrap();
        assert_eq!(payload.messages.len(), 2);
        let _ = fs::remove_dir_all(root);
    }

    // --- TitleSource precedence (AD-1/AD-5) ---

    /// Helper: enqueue a `local_title_generated` event for the default session.
    fn enqueue_local_title(persistence: &SessionPersistence, seq: u64, title: &str) {
        persistence
            .enqueue_event(payload_record(
                seq,
                "local_title_generated",
                json!({"sessionId":"session-1","title":title}),
            ))
            .unwrap();
    }

    /// Helper: enqueue a `session_info_update` event for the default session.
    fn enqueue_session_info_update(persistence: &SessionPersistence, seq: u64, title: &str) {
        persistence
            .enqueue_event(payload_record(
                seq,
                "session_info_update",
                json!({"sessionId":"session-1","title":title}),
            ))
            .unwrap();
    }

    /// `user_prompt` sets `title_source = DerivedFirstMessage` (AD-5) so the
    /// host can detect "first turn, no background title yet" and trigger
    /// background title generation.
    #[tokio::test]
    async fn user_prompt_sets_derived_first_message_title_source() {
        let root = temp_dir("title-derived");
        let (persistence, _) = registered(&root).await;
        persistence
            .enqueue_event(payload_record(
                1,
                "user_prompt",
                json!({
                    "agentId":"runtime-1","sessionId":"session-1","turnId":"turn-1",
                    "content":[{"type":"text","text":"how do I center a div?"}],
                }),
            ))
            .unwrap();
        persistence.flush_session("session-1").await.unwrap();
        let metadata = persistence.metadata("session-1").unwrap();
        assert_eq!(metadata.title.as_deref(), Some("how do I center a div?"));
        assert_eq!(
            metadata.title_source,
            Some(TitleSource::DerivedFirstMessage),
            "user_prompt must stamp DerivedFirstMessage provenance"
        );
        let _ = fs::remove_dir_all(root);
    }

    /// `local_title_generated` sets `title_source = BackgroundGenerated` and
    /// overwrites the DerivedFirstMessage title (AD-1 precedence).
    #[tokio::test]
    async fn local_title_generated_sets_background_generated() {
        let root = temp_dir("title-bg");
        let (persistence, _) = registered(&root).await;
        // First user prompt stamps DerivedFirstMessage.
        persistence
            .enqueue_event(payload_record(
                1,
                "user_prompt",
                json!({
                    "agentId":"runtime-1","sessionId":"session-1","turnId":"turn-1",
                    "content":[{"type":"text","text":"how do I center a div?"}],
                }),
            ))
            .unwrap();
        // Background title gen succeeds and durably overwrites.
        enqueue_local_title(&persistence, 2, "Centering a div with CSS");
        persistence.flush_session("session-1").await.unwrap();
        let metadata = persistence.metadata("session-1").unwrap();
        assert_eq!(metadata.title.as_deref(), Some("Centering a div with CSS"));
        assert_eq!(
            metadata.title_source,
            Some(TitleSource::BackgroundGenerated),
            "local_title_generated must stamp BackgroundGenerated provenance"
        );
        let _ = fs::remove_dir_all(root);
    }

    /// After `title_source == BackgroundGenerated`, a later
    /// `session_info_update` from the agent must NOT overwrite the title
    /// (AD-1: background wins over agent-supplied).
    #[tokio::test]
    async fn session_info_update_does_not_overwrite_background_generated() {
        let root = temp_dir("title-protect-bg");
        let (persistence, _) = registered(&root).await;
        persistence
            .enqueue_event(payload_record(
                1,
                "user_prompt",
                json!({
                    "agentId":"runtime-1","sessionId":"session-1","turnId":"turn-1",
                    "content":[{"type":"text","text":"how do I center a div?"}],
                }),
            ))
            .unwrap();
        enqueue_local_title(&persistence, 2, "Background title");
        // Agent emits its own title AFTER background gen.
        enqueue_session_info_update(&persistence, 3, "Agent's pick");
        persistence.flush_session("session-1").await.unwrap();
        let metadata = persistence.metadata("session-1").unwrap();
        assert_eq!(
            metadata.title.as_deref(),
            Some("Background title"),
            "BackgroundGenerated title must survive a later session_info_update"
        );
        assert_eq!(
            metadata.title_source,
            Some(TitleSource::BackgroundGenerated),
            "title_source must stay BackgroundGenerated after a suppressed overwrite"
        );
        let _ = fs::remove_dir_all(root);
    }

    /// Without protection, `session_info_update` stamps `AgentSupplied` (so a
    /// subsequent background title can still win).
    #[tokio::test]
    async fn session_info_update_stamps_agent_supplied_when_unprotected() {
        let root = temp_dir("title-agent");
        let (persistence, _) = registered(&root).await;
        // Native agent title with no prior background title.
        enqueue_session_info_update(&persistence, 1, "Agent title");
        persistence.flush_session("session-1").await.unwrap();
        let metadata = persistence.metadata("session-1").unwrap();
        assert_eq!(metadata.title.as_deref(), Some("Agent title"));
        assert_eq!(
            metadata.title_source,
            Some(TitleSource::AgentSupplied),
            "unprotected session_info_update must stamp AgentSupplied provenance"
        );
        let _ = fs::remove_dir_all(root);
    }

    /// Replay after restart reproduces the BackgroundGenerated title and a later
    /// replayed `session_info_update` still does not overwrite it (AD-1 durable
    /// defense survives restart).
    #[tokio::test]
    async fn replay_preserves_background_title_and_suppresses_later_session_info() {
        let root = temp_dir("title-replay");
        let store = root.join("store");
        {
            let (persistence, _) = registered(&root).await;
            persistence
                .enqueue_event(payload_record(
                    1,
                    "user_prompt",
                    json!({
                        "agentId":"runtime-1","sessionId":"session-1","turnId":"turn-1",
                        "content":[{"type":"text","text":"orig prompt"}],
                    }),
                ))
                .unwrap();
            enqueue_local_title(&persistence, 2, "Replayed background title");
            // A later agent session_info_update arrives before shutdown.
            enqueue_session_info_update(&persistence, 3, "Late agent title");
            persistence.shutdown().await.unwrap();
        }
        let reopened = SessionPersistence::open(store).await.unwrap();
        let metadata = reopened.metadata("session-1").unwrap();
        assert_eq!(
            metadata.title.as_deref(),
            Some("Replayed background title"),
            "replay must surface the background-generated title, not the suppressed agent title"
        );
        assert_eq!(
            metadata.title_source,
            Some(TitleSource::BackgroundGenerated),
            "title_source must survive restart"
        );
        let _ = fs::remove_dir_all(root);
    }

    /// `local_title_generated` is a durable event: replay returns it so a
    /// reconnecting client can reconstruct the title history.
    #[tokio::test]
    async fn local_title_generated_is_durable_and_replayable() {
        let root = temp_dir("title-durable");
        let (persistence, _) = registered(&root).await;
        persistence
            .enqueue_event(payload_record(
                1,
                "user_prompt",
                json!({
                    "agentId":"runtime-1","sessionId":"session-1","turnId":"turn-1",
                    "content":[{"type":"text","text":"hello"}],
                }),
            ))
            .unwrap();
        enqueue_local_title(&persistence, 2, "Hello chat");
        persistence.flush_session("session-1").await.unwrap();
        let records = persistence.replay_after("session-1", 0).unwrap();
        assert!(records.iter().any(|record| {
            record.type_ == "local_title_generated"
                && record.payload.get("title").and_then(Value::as_str) == Some("Hello chat")
        }));
        let _ = fs::remove_dir_all(root);
    }

    /// `reopen_writer` reinstalls a writer for a finalized (catalog-retained)
    /// session so `enqueue_event` succeeds again and the catalog status flips
    /// back to `Active`. Mirrors the `LoadSession`/`ResumeSession` reopen path.
    #[tokio::test]
    async fn reopen_writer_reinstalls_writer_for_finalized_session() {
        let root = temp_dir("reopen-finalized");
        let (persistence, _) = registered(&root).await;
        // Enqueue one event then finalize — finalize removes the writer but
        // keeps the catalog entry (read-only listing + last_seq still resolve).
        persistence.enqueue_event(record(1, "user_prompt")).unwrap();
        persistence
            .finalize_session("session-1", PersistedSessionStatus::Closed)
            .await
            .unwrap();
        assert!(!persistence.inner.sessions.lock().contains_key("session-1"));
        assert_eq!(
            persistence.metadata("session-1").unwrap().status,
            PersistedSessionStatus::Closed
        );
        // enqueue_event fails with SessionNotFound — the writer is gone.
        assert!(matches!(
            persistence.enqueue_event(record(2, "message_chunk")),
            Err(SessionPersistenceError::SessionNotFound)
        ));

        // reopen_writer reinstalls the writer and flips status to Active.
        persistence.reopen_writer("session-1").await.unwrap();
        assert!(persistence.inner.sessions.lock().contains_key("session-1"));
        assert_eq!(
            persistence.metadata("session-1").unwrap().status,
            PersistedSessionStatus::Active
        );
        // enqueue_event now succeeds; the new seq advances past the prior
        // last_seq (1) so the durable frontier is monotonic.
        persistence
            .enqueue_event(record(2, "message_chunk"))
            .unwrap();
        persistence.flush_session("session-1").await.unwrap();
        assert_eq!(persistence.last_seq("session-1").unwrap(), 2);
        let _ = fs::remove_dir_all(root);
    }

    /// `reopen_writer` is idempotent: calling it twice for an already-open
    /// session installs a single writer (no duplicate runtime entries).
    #[tokio::test]
    async fn reopen_writer_is_idempotent() {
        let root = temp_dir("reopen-idempotent");
        let (persistence, _) = registered(&root).await;
        // First call: writer already present (register_session installed it),
        // so reopen_writer short-circuits at the idempotent guard.
        persistence.reopen_writer("session-1").await.unwrap();
        assert!(persistence.inner.sessions.lock().contains_key("session-1"));
        // Second call: still idempotent — single writer, no error.
        persistence.reopen_writer("session-1").await.unwrap();
        assert!(persistence.inner.sessions.lock().contains_key("session-1"));

        // Finalize then reopen twice — still idempotent after a real reopen.
        persistence
            .finalize_session("session-1", PersistedSessionStatus::Closed)
            .await
            .unwrap();
        assert!(!persistence.inner.sessions.lock().contains_key("session-1"));
        persistence.reopen_writer("session-1").await.unwrap();
        let first_tx = persistence
            .inner
            .sessions
            .lock()
            .get("session-1")
            .map(|runtime| runtime.tx.clone());
        persistence.reopen_writer("session-1").await.unwrap();
        let second_tx = persistence
            .inner
            .sessions
            .lock()
            .get("session-1")
            .map(|runtime| runtime.tx.clone());
        assert!(
            first_tx.is_some() && second_tx.is_some(),
            "writer must remain installed after idempotent reopen"
        );
        // Same channel handle — reopen short-circuited, did not spawn a second writer.
        assert!(
            first_tx
                .as_ref()
                .map(|tx| tx.same_channel(second_tx.as_ref().unwrap()))
                .unwrap_or(false),
            "idempotent reopen must not replace the existing writer channel"
        );
        let _ = fs::remove_dir_all(root);
    }

    /// `reopen_writer` surfaces `SessionNotFound` for a session that is absent
    /// from the catalog (e.g. deleted or never registered) — it must NOT
    /// fabricate a writer for an unknown id.
    #[tokio::test]
    async fn reopen_writer_session_not_found_for_unknown_session() {
        let root = temp_dir("reopen-unknown");
        let (persistence, _) = registered(&root).await;
        assert!(matches!(
            persistence.reopen_writer("never-registered").await,
            Err(SessionPersistenceError::SessionNotFound)
        ));
        let _ = fs::remove_dir_all(root);
    }
}
