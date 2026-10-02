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

/// Host-authored durable agent-switch marker payload (CAP-2). camelCase on
/// the wire and in the JSONL record; `seq`/`recordedAt` live on the record
/// envelope, not here. Field names deliberately avoid secret-looking
/// substrings (`token`, `secret`, …) — `normalize_durable_payload`
/// redacts those.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSwitchRecord {
    pub session_id: String,
    pub from_config_id: String,
    pub to_config_id: String,
    /// The NEW session id the conversation continues in (CAP-7 reopen
    /// resolution reads this; may be empty on a corrupt record — degrades,
    /// never fails the fold).
    pub new_session_id: String,
    pub summary_text: String,
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
    pub fn replay_tail(&self, session_id: &str, limit: usize) -> Result<Vec<PersistedEventRecord>> {
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
            payload.switches.retain(|switch| switch.seq >= oldest_kept_seq);
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
            // Safety: if the app crashed between an append and the next
            // flush, the counts may slightly undercount — but they are
            // display-only and last_seq being stale-low is safe because the
            // monotonic guard (record.seq <= current.last_seq) still passes
            // for higher-seq records arriving from the agent.
            //
            // Repair torn tails (incomplete final writes) so later appends
            // land after a valid line. This reads only the last 4 KiB of
            // each file — O(1) per session, not O(total_records).
            repair_jsonl_torn_tail(&dir.join(MESSAGES_FILE));
            repair_jsonl_torn_tail(&dir.join(TOOL_CALLS_FILE));

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
                    .filter(|record| !is_tool_event(&record.type_))
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
            WriterCommand::AppendAgentSwitch(switch, reply) => {
                let seq = metadata.lock().last_seq + 1;
                let session_id = metadata.lock().session_id.clone();
                let result = append_record(
                    &inner.root,
                    &metadata,
                    PersistedEventRecord {
                        schema_version: SESSION_SCHEMA_VERSION,
                        session_id: session_id.clone(),
                        seq,
                        type_: "agent_switch".to_string(),
                        recorded_at: now_millis(),
                        payload: serde_json::to_value(&switch).unwrap_or_else(|_| {
                            serde_json::json!({ "sessionId": session_id })
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
    } else if record.type_ != "agent_switch" {
        // CAP-2: a switch marker is a transcript boundary, not a message —
        // `message_count` stays unchanged so the fold's message slice and the
        // renderer's message window never count separators.
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

/// Lightweight corruption check: read the first line of a JSONL file and
/// verify it deserializes as a `PersistedEventRecord` with the expected
/// schema version and session id. Returns `true` for empty files or valid
/// first records, `false` only when the first line is non-empty and
/// unparseable or mismatches. This catches fully-corrupt files without
/// loading all records.
fn jsonl_first_record_is_valid(path: &Path, expected_session_id: &str) -> bool {
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return true, // missing file is handled by `ensure_log_exists`
    };
    use std::io::BufRead;
    let reader = std::io::BufReader::new(file);
    match reader.lines().next() {
        Some(Ok(line)) if !line.trim().is_empty() => {
            match serde_json::from_str::<PersistedEventRecord>(&line) {
                Ok(record) => {
                    record.schema_version == SESSION_SCHEMA_VERSION
                        && record.session_id == expected_session_id
                }
                Err(_) => false,
            }
        }
        _ => true, // empty file or no lines — not corrupt
    }
}

/// Repair a torn final tail (incomplete write at the end of a JSONL file)
/// by reading only the last 4 KiB, finding the last newline, and truncating
/// any unparseable trailing bytes. This is O(1) per file — it never reads
/// the full transcript — and prevents later appends from landing after a
/// torn line (which would make `replay_after` return `CorruptSession`).
fn repair_jsonl_torn_tail(path: &Path) {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = match fs::OpenOptions::new().read(true).write(true).open(path) {
        Ok(f) => f,
        Err(_) => return, // missing file is handled by `ensure_log_exists`
    };
    let file_size = match file.metadata() {
        Ok(m) => m.len(),
        Err(_) => return,
    };
    if file_size == 0 {
        return;
    }
    // Read the last 4 KiB (or entire file if smaller).
    let block = std::cmp::min(file_size, 4096) as usize;
    let start = file_size - block as u64;
    if file.seek(SeekFrom::Start(start)).is_err() {
        return;
    }
    let mut buf = vec![0u8; block];
    if file.read_exact(&mut buf).is_err() {
        return;
    }
    // Data after the last newline is the (possibly torn) tail.
    let last_nl = buf.iter().rposition(|&b| b == b'\n');
    let (valid_end, tail): (u64, &[u8]) = match last_nl {
        Some(pos) if pos + 1 < buf.len() => (start + pos as u64 + 1, &buf[pos + 1..]),
        Some(_) => return,     // file ends with newline — no tail
        None => (0, &buf[..]), // no newline — entire block is tail
    };
    if tail.is_empty() || tail.iter().all(|b| b.is_ascii_whitespace()) {
        return;
    }
    // If the tail deserializes as a valid record, it is just missing a
    // trailing newline — not torn, leave it for the next append to terminate.
    if serde_json::from_slice::<PersistedEventRecord>(tail).is_ok() {
        return;
    }
    // Torn tail — backup and truncate.
    let _ = atomic_file::backup_corrupt(path, tail);
    let _ = file.set_len(valid_end);
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

/// Result of [`load_jsonl_tail`]: the parsed tail records plus whether the
/// window reached the file head. `reached_head` is true when no earlier
/// records exist — i.e. the loaded slice is the whole file — which the
/// caller needs to decide if a `message_chunk` at the window edge starts a
/// fresh fold run or continues an unloaded one.
struct TailSlice {
    records: Vec<PersistedEventRecord>,
    reached_head: bool,
}

/// Read only the last `max_lines` newline-terminated records from a JSONL
/// file. Seeks backward from the file end in bounded blocks (4 KiB) until
/// `max_lines` complete records are located, then reads and deserializes
/// only the resulting byte range. This avoids reading the entire file for
/// long transcripts. Returns records in file order (seq order for a
/// well-formed session).
///
/// Only the final unterminated line (no trailing newline, possibly
/// mid-write) is tolerated. Any malformed or session/schema-mismatched
/// newline-terminated line propagates as `CorruptSession` — matching
/// `load_jsonl`'s fail-closed behavior so a corrupt file never yields a
/// partial tail payload.
fn load_jsonl_tail(path: &Path, session_id: &str, max_lines: usize) -> Result<TailSlice> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = fs::File::open(path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            return SessionPersistenceError::SessionNotFound;
        }
        SessionPersistenceError::Io(error)
    })?;

    let file_len = file.metadata()?.len();
    if file_len == 0 {
        return Ok(TailSlice {
            records: Vec::new(),
            reached_head: true,
        });
    }

    // Seek backward in 4 KiB blocks, counting newlines until we have
    // `max_lines` complete records or reach the file start.
    const BLOCK: usize = 4 * 1024;
    let mut newline_count = 0usize;
    let mut tail_start = file_len as usize;
    let mut buf = Vec::with_capacity(BLOCK);

    while tail_start > 0 && newline_count < max_lines {
        let read_start = tail_start.saturating_sub(BLOCK);
        let read_len = tail_start - read_start;
        file.seek(SeekFrom::Start(read_start as u64))?;
        buf.clear();
        buf.resize(read_len, 0);
        file.read_exact(&mut buf)?;

        // Count newlines in this block (backward).
        for &byte in buf.iter().rev() {
            if byte == b'\n' {
                newline_count += 1;
                if newline_count >= max_lines {
                    break;
                }
            }
        }
        tail_start = read_start;
    }

    // `tail_start` is now the offset of the block containing the max_lines-th
    // newline from the end. Read from the byte AFTER that newline to the file
    // end. If we ran out of newlines (file has fewer than max_lines), read
    // from offset 0.
    let read_offset = if newline_count >= max_lines {
        // Find the (newline_count - max_lines + 1)-th newline from the end of
        // the accumulated data. Since we scanned backward, the first newline
        // we hit is the last in the file, etc. We need the position of the
        // max_lines-th newline from the end, then start reading after it.
        // Re-scan the accumulated range to find the exact offset.
        let full_start = tail_start;
        let full_len = file_len as usize - full_start;
        file.seek(SeekFrom::Start(full_start as u64))?;
        let mut full_buf = vec![0u8; full_len];
        file.read_exact(&mut full_buf)?;
        // Count newlines from the end to find the max_lines-th.
        let mut nl_from_end = 0usize;
        let mut content_start = 0usize;
        for (i, &byte) in full_buf.iter().enumerate().rev() {
            if byte == b'\n' {
                nl_from_end += 1;
                if nl_from_end == max_lines {
                    content_start = full_start + i + 1;
                    break;
                }
            }
        }
        content_start
    } else {
        0
    };

    // Read the tail byte range and deserialize line by line.
    let tail_len = file_len as usize - read_offset;
    if tail_len == 0 {
        return Ok(TailSlice {
            records: Vec::new(),
            reached_head: true,
        });
    }
    // `read_offset == 0` means the backward scan consumed the whole file:
    // the returned slice IS the complete record log.
    let reached_head = read_offset == 0;
    file.seek(SeekFrom::Start(read_offset as u64))?;
    let mut tail_bytes = vec![0u8; tail_len];
    file.read_exact(&mut tail_bytes)?;

    let mut records = Vec::new();
    let mut offset = 0usize;
    while offset < tail_bytes.len() {
        let remainder = &tail_bytes[offset..];
        let newline = remainder.iter().position(|byte| *byte == b'\n');
        let (line, next_offset, terminated) = match newline {
            Some(position) => (&remainder[..position], offset + position + 1, true),
            None => (remainder, tail_bytes.len(), false),
        };
        if line.is_empty() {
            offset = next_offset;
            continue;
        }
        let is_final_unterminated = !terminated && next_offset == tail_bytes.len();
        match serde_json::from_slice::<PersistedEventRecord>(line) {
            Ok(record)
                if record.schema_version == SESSION_SCHEMA_VERSION
                    && record.session_id == session_id =>
            {
                records.push(record)
            }
            Ok(_) => return Err(SessionPersistenceError::CorruptSession),
            Err(_) if is_final_unterminated => {
                // A torn final line (no trailing newline, possibly mid-write)
                // is tolerated — skip it so a concurrent writer can't crash
                // the tail read. Matches `load_jsonl`'s repair_torn_tail.
                break;
            }
            Err(_) => return Err(SessionPersistenceError::CorruptSession),
        }
        offset = next_offset;
    }
    Ok(TailSlice {
        records,
        reached_head,
    })
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
    // CAP-2: `agent_switch` is excluded because the ONLY durable write for a
    // switch is the host-authored `WriterCommand::AppendAgentSwitch` record
    // (the `record_local_title` precedent). The synthetic live fan-out event
    // is excluded here so `WsRelaySink::emit` → `assign_and_append` →
    // `enqueue_event` cannot append a SECOND durable record for the same
    // switch (the fold would render two separators). The durable record
    // itself flows through the writer command, never through this gate.
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
            | "agent_switch"
    )
}

fn is_tool_event(type_: &str) -> bool {
    matches!(type_, "tool_call" | "tool_call_update")
}

/// True when the record participates in the transcript fold
/// (`session_payload::fold_session_records`): boundaries (`user_prompt`,
/// `tool_call`, `prompt_complete`, `agent_switch` — CAP-2: a switch splits
/// any open chunk run so the new agent's first chunk opens a fresh bubble)
/// plus `message_chunk`s that carry content. Null-content chunks and every
/// other durable event (plan/usage/mode/session-info updates,
/// `tool_call_update`, …) are transparent — they neither open nor close a
/// coalesced run, so they may sit at a tail window edge without changing
/// bubble identity.
fn is_fold_relevant(record: &PersistedEventRecord) -> bool {
    match record.type_.as_str() {
        "user_prompt" | "tool_call" | "prompt_complete" | "agent_switch" => true,
        "message_chunk" => record
            .payload
            .get("content")
            .is_some_and(|content| !content.is_null()),
        _ => false,
    }
}

/// The fold bucket a `message_chunk` joins — mirrors `fold_session_records`.
fn chunk_fold_role(record: &PersistedEventRecord) -> &'static str {
    if record.payload.get("role").and_then(Value::as_str) == Some("thought") {
        "thought"
    } else {
        "agent"
    }
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
        // spec-agent-switch-separator-redesign: a legacy framed handoff
        // `user_prompt` (`summary + --- + draft`) must title the session with
        // the draft, not the wire header — same strip the materialize fold
        // applies. `Dropped` (summary-only) → fall through to Untitled.
        .and_then(|text| {
            match crate::acp::session_payload::strip_handoff_display_text(text) {
                Some(crate::acp::session_payload::HandoffText::Draft(draft)) => Some(draft),
                Some(crate::acp::session_payload::HandoffText::Dropped) => None,
                None => Some(text.to_string()),
            }
        })
        .unwrap_or_else(|| "Untitled Chat".to_string());
    normalize_title(&text)
}

#[must_use]
pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests;
