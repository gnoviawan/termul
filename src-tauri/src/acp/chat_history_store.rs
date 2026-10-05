//! Desktop-owned, file-backed renderer chat-history storage.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::acp::atomic_file;

pub const CHAT_HISTORY_SCHEMA_VERSION: u32 = 1;
const INDEX_FILE: &str = "index.json";
const PAYLOADS_DIR: &str = "payloads";
const LEGACY_IMPORT_FILE: &str = "legacy-import.json";
// Hex encoding doubles the bytes and `.json` adds five. Stay below the common
// 255-byte component limit.
const MAX_SESSION_ID_BYTES: usize = 120;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChatHistoryStatus {
    Initializing,
    Active,
    Error,
    Closed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryIndexEntry {
    pub id: String,
    pub agent_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_config_id: Option<String>,
    pub title: String,
    pub cwd: String,
    pub project_id: String,
    pub created_at: u64,
    pub last_activity_at: u64,
    pub message_count: u64,
    pub status: ChatHistoryStatus,
    #[serde(default)]
    pub discovered: bool,
    /// Worktree path the agent runs in (CAP-3). Additive: old entries
    /// deserialize with `None` (the renderer-authored metadata payload omits
    /// it for pre-feature sessions). Used by the CAP-4 relaunch lookup +
    /// CAP-6 indicator.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct IndexFile {
    schema_version: u32,
    sessions: Vec<ChatHistoryIndexEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PayloadFile {
    schema_version: u32,
    payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyImportFile {
    schema_version: u32,
    complete: bool,
}

#[derive(Debug)]
pub enum ChatHistoryStoreError {
    Io(io::Error),
    Json(serde_json::Error),
    UnsupportedVersion { found: u64 },
    InvalidSessionId,
    InvalidPayload(String),
    SessionNotFound,
}

impl std::fmt::Display for ChatHistoryStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "chat history io error: {error}"),
            Self::Json(error) => write!(f, "chat history json error: {error}"),
            Self::UnsupportedVersion { found } => {
                write!(f, "unsupported chat history schema version {found}")
            }
            Self::InvalidSessionId => write!(f, "invalid chat history session id"),
            Self::InvalidPayload(message) => write!(f, "invalid chat history payload: {message}"),
            Self::SessionNotFound => write!(f, "chat history session not found"),
        }
    }
}
impl std::error::Error for ChatHistoryStoreError {}
impl From<io::Error> for ChatHistoryStoreError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}
impl From<serde_json::Error> for ChatHistoryStoreError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}
type Result<T> = std::result::Result<T, ChatHistoryStoreError>;

#[derive(Debug, Clone)]
struct StoreState {
    sessions: Vec<ChatHistoryIndexEntry>,
    legacy_import_complete: bool,
}

pub struct ChatHistoryStore {
    root: PathBuf,
    state: Mutex<StoreState>,
}

impl ChatHistoryStore {
    #[cfg(test)]
    pub fn new() -> Arc<Self> {
        Self::open(temp_dir("fixture")).unwrap()
    }

    pub fn open(root: PathBuf) -> Result<Arc<Self>> {
        if root.exists() && !root.is_dir() {
            return Err(io::Error::other(format!(
                "chat history root '{}' is not a directory",
                root.display()
            ))
            .into());
        }
        fs::create_dir_all(root.join(PAYLOADS_DIR))?;
        let legacy_import_complete = load_legacy_import_state(&root.join(LEGACY_IMPORT_FILE))?;
        let index_path = root.join(INDEX_FILE);
        let mut sessions = match load_index(&index_path)? {
            Some(index) => index.sessions,
            None => {
                let mut recovered = recover_payload_index(&root)?;
                sort_sessions(&mut recovered);
                persist_index(&root, &recovered)?;
                recovered
            }
        };
        sort_sessions(&mut sessions);
        Ok(Arc::new(Self {
            root,
            state: Mutex::new(StoreState {
                sessions,
                legacy_import_complete,
            }),
        }))
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn list(&self) -> (Vec<ChatHistoryIndexEntry>, bool) {
        let state = self.state.lock();
        (state.sessions.clone(), state.legacy_import_complete)
    }

    pub fn get(&self, session_id: &str) -> Result<Value> {
        validate_session_id(session_id)?;
        let _state = self.state.lock();
        let path = self.payload_path(session_id)?;
        let bytes = fs::read(&path).map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                ChatHistoryStoreError::SessionNotFound
            } else {
                error.into()
            }
        })?;
        let file = decode_payload_file(&bytes)?;
        validate_payload(&file.payload, Some(session_id))?;
        Ok(file.payload)
    }

    /// Tail-first variant of [`get`]: reads the full payload (same I/O), then
    /// keeps only the last `limit` messages + the tool calls whose `seq` falls
    /// within the tail message range. Returns the same `Value` shape so the
    /// renderer can consume it identically to a full payload. The metadata's
    /// `messageCount` reflects the tail slice.
    pub fn get_tail(&self, session_id: &str, limit: usize) -> Result<Value> {
        let payload = self.get(session_id)?;
        let mut messages = payload
            .get("messages")
            .and_then(|m| m.as_array())
            .cloned()
            .unwrap_or_default();
        if messages.len() <= limit {
            return Ok(payload);
        }
        let tail = messages.split_off(messages.len() - limit);
        let tail_len = tail.len();
        let oldest_tail_seq = tail
            .iter()
            .filter_map(|m| m.get("seq").and_then(|s| s.as_u64()))
            .min()
            .unwrap_or(0);
        let mut result = payload;
        result["messages"] = serde_json::Value::Array(tail);
        if let Some(metadata) = result.get_mut("metadata").and_then(|m| m.as_object_mut()) {
            metadata.insert(
                "messageCount".to_string(),
                serde_json::Value::Number(serde_json::Number::from(tail_len)),
            );
        }
        if let Some(tool_calls) = result.get_mut("toolCalls").and_then(|t| t.as_array_mut()) {
            tool_calls.retain(|tc| {
                tc.get("seq")
                    .and_then(|s| s.as_u64())
                    .is_some_and(|seq| seq >= oldest_tail_seq)
            });
        }
        Ok(result)
    }

    /// Server-authoritative replay cursor (R2): the highest persisted event
    /// `seq` for a session, so a refreshed transport can seed `lastSeq` from
    /// the backend before subscribing (instead of a dead per-instance cursor).
    /// Returns `0` for an unknown session or a payload without `seq`-bearing
    /// messages — never an error, so callers (the WS `get_session_cursor`
    /// handler) treat absence as a live-only subscribe.
    pub fn last_seq(&self, session_id: &str) -> Result<u64> {
        match self.get(session_id) {
            Ok(payload) => Ok(max_message_seq(&payload)),
            Err(ChatHistoryStoreError::SessionNotFound) => Ok(0),
            Err(error) => Err(error),
        }
    }

    #[must_use]
    pub fn find_most_recent_for_project(
        &self,
        project_id: &str,
        cwd: &str,
        agent_namespace: Option<&str>,
    ) -> Option<ChatHistoryIndexEntry> {
        self.state
            .lock()
            .sessions
            .iter()
            .filter(|entry| {
                entry.project_id == project_id
                    && entry.cwd == cwd
                    && (!entry.agent_id.is_empty() || entry.agent_config_id.is_some())
                    && agent_namespace.is_none_or(|namespace| {
                        entry
                            .agent_config_id
                            .as_ref()
                            .is_some_and(|id| namespace == format!("config:{id}"))
                    })
            })
            .max_by(|left, right| {
                left.last_activity_at
                    .cmp(&right.last_activity_at)
                    .then(left.created_at.cmp(&right.created_at))
                    .then(left.id.cmp(&right.id))
            })
            .cloned()
    }

    pub fn save(&self, session_id: &str, payload: Value) -> Result<()> {
        validate_session_id(session_id)?;
        let (mut entry, message_count) = validate_payload(&payload, Some(session_id))?;
        entry.message_count = message_count;
        let path = self.payload_path(session_id)?;
        let file = PayloadFile {
            schema_version: CHAT_HISTORY_SCHEMA_VERSION,
            payload,
        };
        let mut state = self.state.lock();
        let previous_payload = fs::read(&path).ok();
        atomic_file::replace(&path, &serde_json::to_vec_pretty(&file)?)?;
        let mut sessions = state.sessions.clone();
        sessions.retain(|existing| existing.id != session_id);
        sessions.push(entry);
        sort_sessions(&mut sessions);
        if let Err(error) = persist_index(&self.root, &sessions) {
            match previous_payload {
                Some(bytes) => atomic_file::replace(&path, &bytes)?,
                None => {
                    let _ = fs::remove_file(&path);
                    sync_dir(&self.root.join(PAYLOADS_DIR))?;
                }
            }
            return Err(error);
        }
        state.sessions = sessions;
        Ok(())
    }

    pub fn delete(&self, session_id: &str) -> Result<()> {
        validate_session_id(session_id)?;
        let path = self.payload_path(session_id)?;
        let mut state = self.state.lock();
        let previous_payload = fs::read(&path).ok();
        match fs::remove_file(&path) {
            Ok(()) => sync_dir(&self.root.join(PAYLOADS_DIR))?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let mut sessions = state.sessions.clone();
        sessions.retain(|entry| entry.id != session_id);
        if let Err(error) = persist_index(&self.root, &sessions) {
            if let Some(bytes) = previous_payload {
                atomic_file::replace(&path, &bytes)?;
            }
            return Err(error);
        }
        state.sessions = sessions;
        Ok(())
    }

    pub fn mark_legacy_import_complete(&self) -> Result<()> {
        let marker = LegacyImportFile {
            schema_version: CHAT_HISTORY_SCHEMA_VERSION,
            complete: true,
        };
        atomic_file::replace(
            &self.root.join(LEGACY_IMPORT_FILE),
            &serde_json::to_vec_pretty(&marker)?,
        )?;
        self.state.lock().legacy_import_complete = true;
        Ok(())
    }

    pub fn flush(&self) -> Result<()> {
        let state = self.state.lock();
        persist_index(&self.root, &state.sessions)?;
        sync_if_present(&self.root.join(INDEX_FILE))?;
        sync_if_present(&self.root.join(LEGACY_IMPORT_FILE))?;
        for entry in &state.sessions {
            sync_if_present(&self.payload_path(&entry.id)?)?;
        }
        sync_dir(&self.root.join(PAYLOADS_DIR))?;
        Ok(())
    }

    fn payload_path(&self, session_id: &str) -> Result<PathBuf> {
        validate_session_id(session_id)?;
        Ok(self
            .root
            .join(PAYLOADS_DIR)
            .join(canonical_payload_name(session_id)))
    }
}

fn validate_session_id(session_id: &str) -> Result<()> {
    if session_id.is_empty() || session_id.len() > MAX_SESSION_ID_BYTES {
        return Err(ChatHistoryStoreError::InvalidSessionId);
    }
    Ok(())
}

fn validate_payload(
    payload: &Value,
    expected_id: Option<&str>,
) -> Result<(ChatHistoryIndexEntry, u64)> {
    let metadata_value = payload
        .get("metadata")
        .ok_or_else(|| ChatHistoryStoreError::InvalidPayload("missing metadata".to_string()))?;
    let metadata: ChatHistoryIndexEntry = serde_json::from_value(metadata_value.clone())
        .map_err(|error| ChatHistoryStoreError::InvalidPayload(error.to_string()))?;
    validate_session_id(&metadata.id)?;
    if expected_id.is_some_and(|expected| expected != metadata.id) {
        return Err(ChatHistoryStoreError::InvalidPayload(
            "metadata id does not match session id".to_string(),
        ));
    }
    let messages = payload
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            ChatHistoryStoreError::InvalidPayload("messages is not an array".to_string())
        })?;
    Ok((metadata, messages.len() as u64))
}

/// Highest `seq` among a payload's messages (R2 replay cursor). The renderer
/// stamps every durable message with a monotonic `seq` (`rebaseSeqCounter`),
/// so the max is the durable watermark a refreshed transport should resume from.
/// Returns `0` for a payload lacking `messages` or `seq`-bearing entries.
fn max_message_seq(payload: &Value) -> u64 {
    payload
        .get("messages")
        .and_then(|messages| messages.as_array())
        .into_iter()
        .flatten()
        .filter_map(|message| message.get("seq").and_then(|seq| seq.as_u64()))
        .max()
        .unwrap_or(0)
}

fn load_index(path: &Path) -> Result<Option<IndexFile>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    match decode_versioned(&bytes) {
        Ok(index) => Ok(Some(index)),
        Err(ChatHistoryStoreError::UnsupportedVersion { found }) => {
            Err(ChatHistoryStoreError::UnsupportedVersion { found })
        }
        Err(_) => {
            quarantine(path, &bytes)?;
            Ok(None)
        }
    }
}

fn recover_payload_index(root: &Path) -> Result<Vec<ChatHistoryIndexEntry>> {
    let payloads_dir = root.join(PAYLOADS_DIR);
    let mut sessions = Vec::new();
    for dir_entry in fs::read_dir(&payloads_dir)? {
        let dir_entry = dir_entry?;
        if !dir_entry.file_type()?.is_file() {
            continue;
        }
        let path = dir_entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(_) => continue,
        };
        let result = decode_payload_file(&bytes).and_then(|file| {
            let (mut metadata, count) = validate_payload(&file.payload, None)?;
            metadata.message_count = count;
            if path.file_name().and_then(|name| name.to_str())
                != Some(canonical_payload_name(&metadata.id).as_str())
            {
                return Err(ChatHistoryStoreError::InvalidPayload(
                    "noncanonical payload filename".to_string(),
                ));
            }
            Ok(metadata)
        });
        match result {
            Ok(metadata)
                if !sessions
                    .iter()
                    .any(|existing: &ChatHistoryIndexEntry| existing.id == metadata.id) =>
            {
                sessions.push(metadata)
            }
            Ok(_)
            | Err(ChatHistoryStoreError::Json(_))
            | Err(ChatHistoryStoreError::InvalidPayload(_))
            | Err(ChatHistoryStoreError::UnsupportedVersion { .. }) => {
                quarantine(&path, &bytes)?;
            }
            Err(error) => return Err(error),
        }
    }
    Ok(sessions)
}

fn quarantine(path: &Path, bytes: &[u8]) -> Result<()> {
    atomic_file::backup_corrupt(path, bytes)?;
    fs::remove_file(path)?;
    if let Some(parent) = path.parent() {
        sync_dir(parent)?;
    }
    Ok(())
}

fn persist_index(root: &Path, sessions: &[ChatHistoryIndexEntry]) -> Result<()> {
    let index = IndexFile {
        schema_version: CHAT_HISTORY_SCHEMA_VERSION,
        sessions: sessions.to_vec(),
    };
    atomic_file::replace(&root.join(INDEX_FILE), &serde_json::to_vec_pretty(&index)?)?;
    Ok(())
}

fn load_legacy_import_state(path: &Path) -> Result<bool> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    let marker: LegacyImportFile = decode_versioned(&bytes)?;
    Ok(marker.complete)
}

fn decode_payload_file(bytes: &[u8]) -> Result<PayloadFile> {
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
        .ok_or_else(|| {
            ChatHistoryStoreError::InvalidPayload("missing schemaVersion".to_string())
        })?;
    if version != u64::from(CHAT_HISTORY_SCHEMA_VERSION) {
        return Err(ChatHistoryStoreError::UnsupportedVersion { found: version });
    }
    Ok(serde_json::from_value(value)?)
}

fn sort_sessions(sessions: &mut [ChatHistoryIndexEntry]) {
    sessions.sort_by(|left, right| {
        right
            .last_activity_at
            .cmp(&left.last_activity_at)
            .then(right.created_at.cmp(&left.created_at))
            .then(left.id.cmp(&right.id))
    });
}
fn canonical_payload_name(session_id: &str) -> String {
    format!("{}.json", hex_encode(session_id.as_bytes()))
}
fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(char::from(HEX[(byte >> 4) as usize]));
        encoded.push(char::from(HEX[(byte & 0x0f) as usize]));
    }
    encoded
}
fn sync_if_present(path: &Path) -> Result<()> {
    match fs::OpenOptions::new().read(true).open(path) {
        Ok(file) => match file.sync_all() {
            Ok(()) => Ok(()),
            Err(error) => classify_sync_error(error),
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

/// Classify a `sync_all()` failure into a `Result`. On non-unix (Windows),
/// `FlushFileBuffers` on a read-only handle can return `ERROR_ACCESS_DENIED`
/// when a concurrent writer holds the file — a known Win32 quirk, not a real
/// I/O failure — so it is mapped to `Ok` so the unload-path flush doesn't
/// lose chat history. On unix, `PermissionDenied` is a real error and
/// propagates.
fn classify_sync_error(error: io::Error) -> Result<()> {
    #[cfg(not(unix))]
    {
        if error.kind() == io::ErrorKind::PermissionDenied {
            return Ok(());
        }
    }
    Err(error.into())
}
fn sync_dir(path: &Path) -> Result<()> {
    #[cfg(unix)]
    fs::File::open(path)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(test)]
fn temp_dir(label: &str) -> PathBuf {
    use std::time::{SystemTime, UNIX_EPOCH};
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "termul-chat-history-{label}-{}-{suffix}",
        std::process::id()
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

#[cfg(test)]
mod tests;
