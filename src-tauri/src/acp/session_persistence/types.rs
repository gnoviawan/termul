use super::*;

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
    /// Issue #844c: the fold role of the currently-OPEN chunk run
    /// ("agent"/"thought"), or None when no run is open. Tracked
    /// incrementally by `append_record` under the SAME rules the payload
    /// materializer folds by, so `message_count` == the materialized
    /// messages length for live sessions.
    /// Additive: old metadata deserializes with `None` and converges via the
    /// lazy heal (recount on first append — `fold_state_needs_heal`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fold_open_role: Option<String>,
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
    /// Durable appends no longer return this. A full writer queue blocks the
    /// producer until `WRITER_CAPACITY` has room (see `session_persistence`).
    /// The variant stays so the historical "session writer queue is full"
    /// wording remains matchable.
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

pub(super) type Result<T> = std::result::Result<T, SessionPersistenceError>;
