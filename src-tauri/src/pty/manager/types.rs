use super::*;

// Constants matching Electron implementation
pub(super) const GLOBAL_TERMINAL_LIMIT: usize = 30;
pub(super) const ORPHAN_TIMEOUT_MS: u64 = 300_000; // 5 minutes
pub(super) const ORPHAN_CHECK_INTERVAL_MS: u64 = 30_000; // 30 seconds
/// #851b: conservative default web-listed reap window (5 minutes). A
/// web-spawned terminal that no client has listed for this long — and that
/// has neither a live web attachment nor a renderer ref — is swept by the
/// orphan reaper. Matches the ordinary orphan timeout so web and desktop
/// terminals share one retention budget.
pub(super) const WEB_LISTED_REAP_AFTER_MS: u64 = 300_000;

// ADR-002.3: Flusher thread constants
pub const FLUSH_INTERVAL: Duration = Duration::from_millis(4);
pub const READ_BUF: usize = 16 * 1024; // 16KB read buffer
pub const MAX_PENDING: usize = 4 * 1024 * 1024; // 4MB overflow cap
pub const OVERFLOW_NOTICE: &[u8] =
    b"\x1bc\x1b[2m[termul: dropped output due to backpressure]\x1b[0m\r\n";

/// Public info emitted to renderer on spawn (also forwarded to ws clients)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: String,
    pub shell: String,
    pub cwd: String,
    pub pid: u32,
    pub cols: u16,
    pub rows: u16,
}

/// Spawn response carrying the terminal info PLUS the issued claim credential.
///
/// Serializes FLATTENED — `{id, shell, cwd, pid, cols, rows, claim}` — so both
/// transports (desktop `terminal_spawn` IpcResult data and the web `spawn`
/// reply data) expose the same top-level camelCase shape. This is the only
/// issuance path for the credential.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnedTerminal {
    #[serde(flatten)]
    pub info: TerminalInfo,
    pub claim: String,
}

/// Shared attach response — byte-identical camelCase shape on both transports
/// (desktop `terminal_attach` IpcResult data; web `attach` reply data).
///
/// Carries the live terminal metadata plus the replay cursor (`latestSeq`) and
/// `gap` flag. It NEVER carries a claim key: attach is credential-consuming,
/// never credential-issuing.
///
/// `snapshot` carries the terminal's last-known lifecycle/metadata state
/// (cwd, git branch/status, exit code, exited). The web transport sends the
/// same snapshot on the `replay` frame; the renderer uses it to seed store
/// state on attach/reattach — closing the gap where a client that connects
/// after the single change-only `git_branch_changed` emit would otherwise
/// never learn the branch (rendered as "detached" for a branch that isn't).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAttachResult {
    pub id: String,
    pub shell: String,
    pub cwd: String,
    pub pid: u32,
    pub cols: u16,
    pub rows: u16,
    pub latest_seq: u64,
    pub gap: bool,
    pub snapshot: TerminalStateSnapshot,
}

/// A preserved terminal as seen by a cross-reload reattach (`list_preserved`):
/// the live terminal metadata plus a freshly issued claim credential. The
/// claim is re-issued through the same registry call spawn uses, so the
/// record is atomically replaced — any prior credential stops verifying
/// (revoke-and-reissue semantics; the only expected holder of the old
/// credential, the reloaded page, is gone by construction).
/// #851: terminals with a LIVE web attachment on another connection now
/// carry a SHARED claim (`issue_shared` appends a digest without
/// invalidating the existing holder) plus ownership info, so a second
/// device can attach read/write to the same PTY instead of silently
/// spawning its own shell. `live_attachment` marks those entries; the WS
/// layer exposes it as `hasLiveAttachment` for renderer labeling.
#[derive(Debug, Clone)]
pub struct PreservedTerminal {
    pub info: TerminalInfo,
    pub claim: String,
    /// Whether another web connection currently holds a live output
    /// forwarder for this terminal (#851 ownership info).
    pub live_attachment: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputChunk {
    pub seq: u64,
    pub data: Vec<u8>,
}

#[derive(Debug)]
pub struct TerminalReplay {
    pub chunks: Vec<TerminalOutputChunk>,
    pub gap: bool,
    pub latest_seq: u64,
    pub receiver: tokio::sync::broadcast::Receiver<TerminalOutputChunk>,
}

/// Broadcast channel capacity (number of buffered output batches per terminal).
/// Each batch is up to READ_BUF (16KB) bytes. 1024 slots ≈ 16MB max buffered output.
/// Slow receivers will receive `RecvError::Lagged` — acceptable; they miss bytes
/// rather than back-pressuring the PTY.
pub(super) const TERM_BROADCAST_CAPACITY: usize = 1024;

/// Maximum scrollback bytes retained per terminal for remote-client replay.
/// 256 KiB ≈ several screenfuls of history; bounded so memory stays predictable
/// even for very chatty terminals. Oldest bytes are evicted first.
pub const SCROLLBACK_CAP: usize = 256 * 1024;

/// Options for spawning a new terminal
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOptions {
    pub shell: Option<String>,
    pub cwd: Option<String>,
    pub env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub project_id: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    // ADR-004.2: terminal-native agent launch.
    // When `program` is Some, the PTY runs that executable directly with `args`
    // as discrete argv entries, bypassing shell resolution and shell quoting of
    // the prompt. When `program` is None, spawn behavior is unchanged.
    #[serde(default)]
    pub program: Option<String>,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    #[serde(default)]
    pub kind: Option<String>,
}

impl Default for SpawnOptions {
    fn default() -> Self {
        Self {
            shell: None,
            cwd: None,
            env: None,
            project_id: None,
            cols: Some(80),
            rows: Some(24),
            program: None,
            args: None,
            kind: None,
        }
    }
}
