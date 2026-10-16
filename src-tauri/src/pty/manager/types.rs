use super::*;

// Constants matching Electron implementation
pub(super) const GLOBAL_TERMINAL_LIMIT: usize = 30;
/// How long an exited PTY stays tracked, so a client that reattaches soon
/// after the process ends still replays its output. A live PTY is never
/// removed by time. Atomic so tests can shrink it.
pub(super) const EXITED_TERMINAL_TTL_MS: u64 = 600_000; // 10 minutes
/// How often the sweeper looks for exited PTYs past their TTL.
pub(super) const EXITED_SWEEP_INTERVAL_MS: u64 = 30_000; // 30 seconds

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
    /// The cursor did not belong to this terminal's log (another epoch, or
    /// ahead of the head): the replay starts from the retained log's first
    /// chunk and the client must discard what it has rendered.
    pub reset: bool,
    /// Epoch of this spawn's output log; the client's next cursor is
    /// `(logEpoch, latestSeq)`.
    pub log_epoch: String,
    pub snapshot: TerminalStateSnapshot,
}

/// A preserved terminal as seen by a cross-reload reattach (`list_preserved`):
/// the live terminal metadata plus a freshly issued claim credential. The
/// claim is re-issued through the same registry call spawn uses, so the
/// record is atomically replaced — any prior credential stops verifying
/// (revoke-and-reissue semantics; the only expected holder of the old
/// credential, the reloaded page, is gone by construction).
/// #851: terminals with a LIVE attachment on another connection now
/// carry a SHARED claim (`issue_shared` appends a digest without
/// invalidating the existing holder) plus ownership info, so a second
/// device can attach read/write to the same PTY instead of silently
/// spawning its own shell.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreservedTerminal {
    #[serde(flatten)]
    pub info: TerminalInfo,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claim: Option<String>,
    #[serde(rename = "hasLiveAttachment")]
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
    pub reset: bool,
    pub latest_seq: u64,
    pub log_epoch: String,
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

/// Resize hook for an adopted (non-PTY) terminal: `(cols, rows)`.
pub type ExternalResizer = Arc<dyn Fn(u16, u16) -> Result<(), String> + Send + Sync>;

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
    /// The client-minted `commandId` that asked for this spawn (AD-5). Stamped
    /// on the instance so a resend whose ledger entry is gone still finds the
    /// live PTY ([`PtyManager::find_by_command_id`]). Absent = today's
    /// behavior.
    #[serde(default)]
    pub command_id: Option<String>,
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
            command_id: None,
        }
    }
}
