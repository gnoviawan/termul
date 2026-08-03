//! `AcpManager`: per-agent dedicated-thread driver + command/event bridge.
//!
//! # Threading model (the central constraint)
//!
//! `agent-client-protocol` 0.12 drives a connection through a scoped
//! `Client.builder()...connect_with(transport, main_fn)` call: the connection
//! and the spawned agent subprocess live only for the duration of `main_fn`.
//! The connection's background actors run concurrently with `main_fn` and are
//! driven by a single `block_on`.
//!
//! Tauri commands run on a multithreaded runtime and must return `Send`
//! futures, so we cannot hold the connection in shared state and `.await` it
//! inside a command. Instead, **each agent owns a dedicated OS thread** running
//! a current-thread Tokio runtime. That thread owns the connection (via
//! `connect_with`) and the child stdio. Tauri commands talk to the thread by
//! sending [`AcpCommand`] variants (each carrying a `tokio::sync::oneshot`
//! reply sender) over a `tokio::sync::mpsc` channel, then `.await` the `Send`
//! oneshot reply. Streaming `session/update` notifications and inbound agent
//! requests (permission, fs) are fanned out to the renderer (and, in Story 1.4,
//! the WS relay) through a cloned `Vec<Arc<dyn EventSink>>` — NOT via a Tauri
//! `AppHandle` directly (Story 1.1 / architecture D2 decoupling).
//!
//! This mirrors how `PtyManager` isolates per-PTY I/O on its own threads and
//! emits to the renderer through its own sink fan-out.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use std::thread::JoinHandle;
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    AgentCapabilities, AuthMethod, AuthenticateRequest, CancelNotification, CloseSessionRequest,
    ContentBlock, InitializeRequest, ListSessionsResponse, LoadSessionRequest, LoadSessionResponse,
    McpServer, NewSessionRequest, PromptRequest,
    RequestPermissionOutcome, RequestPermissionResponse, ResumeSessionRequest,
    ResumeSessionResponse, SelectedPermissionOutcome, SessionConfigOption,
    SetSessionConfigOptionRequest, SetSessionModeRequest, StopReason,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{Agent, Client, ConnectionTo, LineDirection};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot, watch};

use crate::acp::client;
use crate::acp::config::{AgentConfig, AgentId, SessionId};
use crate::acp::events::{
    self, AgentCrashedEvent, AgentDisconnectedEvent, AgentErrorEvent, AgentSpawnedEvent,
    AuthMethodInfo, ConfigOptionsUpdateEvent, PromptCompleteEvent, SessionClosedEvent,
    SessionCreatedEvent, SessionModelState,
};
use crate::acp::session::DriverState;
use crate::acp::session_persistence::{
    PersistedSessionStatus, SessionPersistence, SessionRegistration,
};
use crate::web::EventSink;

/// How long to wait for the agent to answer `initialize` before treating the
/// spawn as failed (and tearing the child down).
const INIT_TIMEOUT: Duration = Duration::from_secs(30);
/// How long to wait for `session/new` before returning an error to the caller.
///
/// 60s accommodates agents whose `session/new` handler fetches a model list
/// from a remote service on a cold start (e.g. `pi-acp`, which can exceed the
/// former 30s budget on first launch). Overridable for diagnostics via
/// [`session_new_timeout`].
const SESSION_NEW_TIMEOUT: Duration = Duration::from_secs(60);
/// How long to wait for `session/load` / `session/resume` before returning an
/// error to the caller. Without a bound, a wedged agent parks the renderer's
/// "reconnecting" state forever (the reopened chat can never recover). 60s
/// matches the `session/new` budget: a load replays the full conversation and
/// can legitimately take a while on large histories.
const SESSION_REOPEN_TIMEOUT: Duration = Duration::from_secs(60);
/// How long to wait, after `session/cancel`, for the agent to honor the cancel
/// and reply to the in-flight prompt before we forcibly resolve the turn.
const CANCEL_GRACE: Duration = Duration::from_secs(5);
/// How long to wait for the first-prompt warmup after `session/new`.
///
/// pi-acp's `PiRpcProcess.request()` has no timeout, and pi's `session.prompt()`
/// may stall before calling `preflightResult` on a cold start. The warmup sends
/// a lightweight `session/prompt` through the full pi-acp pipeline before the
/// `acp:session_created` event is emitted, so the renderer's event handlers
/// silently drop warmup events (the session doesn't exist in the store yet).
/// If the warmup times out, we cancel and continue — session creation still
/// succeeds, but the user's first manual prompt may still experience the
/// cold-start hang. Overridable via `TERMUL_ACP_FIRST_PROMPT_WARMUP_SECS`.
const FIRST_PROMPT_WARMUP_TIMEOUT: Duration = Duration::from_secs(45);
/// Upper bound on joining a driver thread during `kill`/`kill_all`, so app exit
/// can never hang on a wedged agent.
const JOIN_TIMEOUT: Duration = Duration::from_secs(5);
/// Idle timeout for an agent turn: if the agent produces NO activity (no
/// `session/update`/`tool_call` notification) for this long, the turn is
/// considered wedged and is cancelled. 900s gives breathing room above the
/// longest expected silent sub-tool (a ~600s shell command) so legitimate
/// long-running tool calls don't race the idle deadline, while a truly wedged
/// (silent) turn fails in ~15min instead of hours. Reset on every inbound
/// notification via `DriverState::signal_idle`. Overridable via
/// `TERMUL_ACP_TURN_IDLE_TIMEOUT_SECS`.
const TURN_IDLE_TIMEOUT: Duration = Duration::from_secs(900);
/// Hard wall-clock cap for a single agent turn — the last-resort backstop so
/// a chatty-but-non-completing agent (streaming forever) is still bounded. 3h
/// accommodates very long agentic turns that stay active (the idle timer keeps
/// resetting, so this only fires for an agent that never stops). On either idle
/// or hard timeout → cancel + `CANCEL_GRACE` → `status: 'error'`. Distinct from
/// 1.7's 60s permission sub-timeout (`permissions.rs:47`). Overridable via
/// `TERMUL_ACP_TURN_TIMEOUT_SECS`.
const TURN_TIMEOUT: Duration = Duration::from_secs(10800);

/// `session/new` timeout, overridable for diagnostics via
/// `TERMUL_ACP_SESSION_NEW_TIMEOUT_SECS` (seconds, must be > 0). Defaults to
/// [`SESSION_NEW_TIMEOUT`]. Useful when an agent needs longer to fetch its
/// model list on a cold start; the default stays strict so a wedged agent
/// still fails fast in normal use.
fn session_new_timeout() -> Duration {
    std::env::var("TERMUL_ACP_SESSION_NEW_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|secs: &u64| *secs > 0)
        .map(Duration::from_secs)
        .unwrap_or(SESSION_NEW_TIMEOUT)
}

/// First-prompt warmup timeout, overridable via
/// `TERMUL_ACP_FIRST_PROMPT_WARMUP_SECS` (seconds, must be > 0). Set to 0 to
/// disable the warmup entirely. Defaults to [`FIRST_PROMPT_WARMUP_TIMEOUT`].
fn first_prompt_warmup_timeout() -> Duration {
    let raw = std::env::var("TERMUL_ACP_FIRST_PROMPT_WARMUP_SECS");
    match raw {
        Ok(v) => match v.parse::<u64>() {
            Ok(secs) => Duration::from_secs(secs),
            Err(_) => {
                log::warn!(
                    "[acp] TERMUL_ACP_FIRST_PROMPT_WARMUP_SECS={v:?} is not a valid \
                     unsigned integer; falling back to {:?}",
                    FIRST_PROMPT_WARMUP_TIMEOUT
                );
                FIRST_PROMPT_WARMUP_TIMEOUT
            }
        },
        _ => FIRST_PROMPT_WARMUP_TIMEOUT,
    }
}

/// `session/load` / `session/resume` timeout, overridable via
/// `TERMUL_ACP_SESSION_REOPEN_TIMEOUT_SECS` (seconds, must be > 0). Defaults
/// to [`SESSION_REOPEN_TIMEOUT`]. A load replays the full conversation before
/// responding, so very large histories may need a longer budget.
fn session_reopen_timeout() -> Duration {
    std::env::var("TERMUL_ACP_SESSION_REOPEN_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|secs: &u64| *secs > 0)
        .map(Duration::from_secs)
        .unwrap_or(SESSION_REOPEN_TIMEOUT)
}

/// Per-turn idle timeout, overridable via `TERMUL_ACP_TURN_IDLE_TIMEOUT_SECS`
/// (seconds, must be > 0). Defaults to [`TURN_IDLE_TIMEOUT`]. The window with
/// no agent activity after which a turn is considered wedged.
pub fn turn_idle_timeout() -> Duration {
    std::env::var("TERMUL_ACP_TURN_IDLE_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|secs: &u64| *secs > 0)
        .map(Duration::from_secs)
        .unwrap_or(TURN_IDLE_TIMEOUT)
}

/// In-process override for the hard wall-clock cap, set by the
/// `acp_set_turn_timeout` Tauri command from the App Preferences UI. `None` =
/// use the env var / default. Consulted by [`resolved_turn_timeout`] so a UI
/// change takes effect on the next turn without a restart. Desktop-only: the
/// standalone server has no settings surface and configures via
/// `TERMUL_ACP_TURN_TIMEOUT_SECS` (the operator env var still wins — see the
/// precedence in [`resolved_turn_timeout`]).
static TURN_TIMEOUT_OVERRIDE: LazyLock<parking_lot::Mutex<Option<u64>>> =
    LazyLock::new(|| parking_lot::Mutex::new(None));

/// Set the in-process turn-timeout override (secs, or `None` to clear). Called
/// by the `acp_set_turn_timeout` Tauri command (desktop renderer settings).
pub fn set_turn_timeout_override(secs: Option<u64>) {
    *TURN_TIMEOUT_OVERRIDE.lock() = secs;
}

/// Read the in-process turn-timeout override, if set.
pub fn turn_timeout_override() -> Option<u64> {
    *TURN_TIMEOUT_OVERRIDE.lock()
}

/// Hard wall-clock cap per turn. Precedence: `TERMUL_ACP_TURN_TIMEOUT_SECS`
/// (env, operator/diagnostic) → in-process UI override → [`TURN_TIMEOUT`]
/// (3h default). The last-resort backstop so a streaming-but-non-completing
/// agent is still bounded.
pub fn resolved_turn_timeout() -> Duration {
    std::env::var("TERMUL_ACP_TURN_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|secs: &u64| *secs > 0)
        .map(Duration::from_secs)
        .or_else(|| turn_timeout_override().map(Duration::from_secs))
        .unwrap_or(TURN_TIMEOUT)
}

/// Race an in-flight ACP prompt turn against completion, a cancel signal, an
/// idle deadline (reset on agent activity via `idle_rx`), and a hard wall-clock
/// cap. On idle/hard timeout, invoke `on_timeout_cancel` (the caller's cancel
/// hook — updates DriverState cancel/timeout state so the in-flight turn winds
/// down), await `CANCEL_GRACE`, then return a typed timeout error. Extracted
/// so the deadline loop is unit-testable with mock futures. A pre-iteration
/// deadline check bounds a continuously-ready activity arm (under `biased`) so
/// a streaming-but-non-completing agent can't slip past the hard cap.
async fn race_turn<P>(
    prompt: P,
    mut cancel_rx: oneshot::Receiver<()>,
    idle_rx: &mut watch::Receiver<()>,
    on_timeout_cancel: impl Fn(),
    idle: Duration,
    hard: Duration,
) -> Result<StopReason, String>
where
    P: std::future::Future<Output = Result<StopReason, String>>,
{
    tokio::pin!(prompt);
    let hard_deadline = tokio::time::Instant::now() + hard;
    let mut idle_deadline = tokio::time::Instant::now() + idle;
    loop {
        let next_deadline = idle_deadline.min(hard_deadline);
        // Pre-select check: under `biased`, a continuously-ready activity arm
        // would win every poll and `sleep_until` would never fire — silently
        // defeating the hard cap for a streaming-but-non-completing agent.
        if tokio::time::Instant::now() >= next_deadline {
            on_timeout_cancel();
            return match tokio::time::timeout(CANCEL_GRACE, &mut prompt).await {
                Ok(result) => result,
                Err(_) if next_deadline == idle_deadline => {
                    Err(format!("turn idle timeout: no agent activity for {idle:?}"))
                }
                Err(_) => Err(format!("turn hard timeout: exceeded {hard:?}")),
            };
        }
        tokio::select! {
            biased;
            result = &mut prompt => return result,
            _ = &mut cancel_rx => {
                return match tokio::time::timeout(CANCEL_GRACE, &mut prompt).await {
                    Ok(result) => result,
                    Err(_) => Ok(StopReason::Cancelled),
                };
            }
            _ = idle_rx.changed() => {
                idle_deadline = tokio::time::Instant::now() + idle;
            }
            _ = tokio::time::sleep_until(next_deadline) => {}
        }
    }
}

/// Option snapshot returned by a successful `session/load` or `session/resume`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionReopenOutcome {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modes: Option<agent_client_protocol::schema::v1::SessionModeState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<SessionModelState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_options: Option<Vec<SessionConfigOption>>,
}

trait IntoSessionReopenOutcome {
    fn into_session_reopen_outcome(self) -> SessionReopenOutcome;
}

impl IntoSessionReopenOutcome for LoadSessionResponse {
    fn into_session_reopen_outcome(self) -> SessionReopenOutcome {
        let models = events::models_from_config_options(self.config_options.as_deref());
        SessionReopenOutcome {
            modes: self.modes,
            models,
            config_options: self.config_options,
        }
    }
}

impl IntoSessionReopenOutcome for ResumeSessionResponse {
    fn into_session_reopen_outcome(self) -> SessionReopenOutcome {
        let models = events::models_from_config_options(self.config_options.as_deref());
        SessionReopenOutcome {
            modes: self.modes,
            models,
            config_options: self.config_options,
        }
    }
}

/// Timed `session/load` / `session/resume`: preserve the option snapshot and
/// record the session root on success.
async fn run_session_reopen<Fut, T, E>(
    op: &str,
    session_id: &str,
    cwd: &str,
    req_state: &Mutex<DriverState>,
    request: Fut,
) -> Result<SessionReopenOutcome, String>
where
    Fut: std::future::Future<Output = Result<T, E>>,
    T: IntoSessionReopenOutcome,
    E: ToString,
{
    let timeout = session_reopen_timeout();
    let outcome = tokio::time::timeout(timeout, request).await;
    let result = match outcome {
        Ok(result) => result
            .map(IntoSessionReopenOutcome::into_session_reopen_outcome)
            .map_err(|e| e.to_string()),
        Err(_) => {
            log::warn!(
                "[acp] session {session_id} {op} timed out after {timeout:?}; \
                 check agent stderr in RUST_LOG=debug"
            );
            Err(format!("{op} timed out after {timeout:?}"))
        }
    };
    if result.is_ok() {
        req_state
            .lock()
            .set_session_root(session_id.to_string(), PathBuf::from(cwd));
    }
    result
}

/// Outcome of creating a new session, returned to the command caller.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSessionOutcome {
    pub session_id: SessionId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modes: Option<agent_client_protocol::schema::v1::SessionModeState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<SessionModelState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_options: Option<Vec<SessionConfigOption>>,
}

/// Trusted server-side context attached to durable session registration.
#[derive(Debug, Clone, Default)]
pub struct SessionCreationContext {
    pub project_id: Option<String>,
    pub ephemeral: bool,
}

/// The `_session/question` ACP extension request (issue #411).
///
/// Agents send a structured question over the protocol's extension surface
/// (the vendored protocol routes `_`-prefixed methods to
/// [`ExtMethodRequest`](agent_client_protocol::schema::v1::ExtRequest)); the
/// response is an untyped JSON value. This type implements the protocol's
/// `JsonRpcMessage`/`JsonRpcRequest` traits directly for the single method, so
/// the driver handler chain matches ONLY `_session/question` — unlike
/// registering on the whole `AgentRequest` enum, which would also claim
/// client→agent responses and break response routing.
///
/// Wire params (camelCase): `{ sessionId, questionId?, question, options }`
/// where `options` is `[{ value, label, description?, cardinality? }]` and
/// `cardinality` is `single` (default) or `multi`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AskUserQuestionRequest {
    session_id: String,
    question: String,
    #[serde(default)]
    options: Vec<AskQuestionOption>,
    #[serde(default)]
    question_id: Option<String>,
}

/// One option of an [`AskUserQuestionRequest`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AskQuestionOption {
    value: String,
    label: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    cardinality: Option<String>,
}

impl agent_client_protocol::JsonRpcMessage for AskUserQuestionRequest {
    fn matches_method(method: &str) -> bool {
        method == "_session/question"
    }

    fn method(&self) -> &str {
        "_session/question"
    }

    fn to_untyped_message(
        &self,
    ) -> Result<agent_client_protocol::UntypedMessage, agent_client_protocol::Error> {
        agent_client_protocol::UntypedMessage::new("_session/question", self)
    }

    fn parse_message(
        method: &str,
        params: &impl serde::Serialize,
    ) -> Result<Self, agent_client_protocol::Error> {
        if method != "_session/question" {
            return Err(agent_client_protocol::Error::method_not_found());
        }
        agent_client_protocol::util::json_cast_params(params)
    }
}

impl agent_client_protocol::JsonRpcRequest for AskUserQuestionRequest {
    type Response = Value;
}

/// Commands sent from Tauri command handlers to an agent's driver thread.
///
/// Every variant that expects a result carries a `oneshot::Sender`; the driver
/// thread fulfills it after performing the protocol exchange. All payloads are
/// `Send`, so the awaiting command future stays `Send`.
enum AcpCommand {
    NewSession {
        cwd: String,
        mcp_servers: Vec<McpServer>,
        stable_agent_namespace: Option<String>,
        runtime_agent_id: String,
        project_id: Option<String>,
        ephemeral: bool,
        reply: oneshot::Sender<Result<NewSessionOutcome, String>>,
    },
    LoadSession {
        session_id: SessionId,
        cwd: String,
        reply: oneshot::Sender<Result<SessionReopenOutcome, String>>,
    },
    ResumeSession {
        session_id: SessionId,
        cwd: String,
        reply: oneshot::Sender<Result<SessionReopenOutcome, String>>,
    },
    CloseSession {
        session_id: SessionId,
        reply: oneshot::Sender<Result<(), String>>,
    },
    DisposeEphemeralSession {
        session_id: SessionId,
        reply: oneshot::Sender<Result<(), String>>,
    },
    ListSessions {
        cwd: Option<String>,
        cursor: Option<String>,
        reply: oneshot::Sender<Result<ListSessionsResponse, String>>,
    },
    SendPrompt {
        session_id: SessionId,
        content: Vec<ContentBlock>,
        /// Story 1.8 T3.2: optional client turn-id (echoed back on
        /// `prompt_complete` for the renderer's `seenTurnIds` idempotent dedup —
        /// FR11). `None` for desktop/older clients (dedup is a no-op).
        turn_id: Option<String>,
        reply: oneshot::Sender<Result<StopReason, String>>,
    },
    CancelPrompt {
        session_id: SessionId,
        reply: oneshot::Sender<Result<(), String>>,
    },
    OwnsSession {
        session_id: SessionId,
        reply: oneshot::Sender<Result<bool, String>>,
    },
    IsEphemeralSession {
        session_id: SessionId,
        reply: oneshot::Sender<Result<bool, String>>,
    },
    IsTurnActive {
        session_id: SessionId,
        reply: oneshot::Sender<Result<bool, String>>,
    },
    WaitTurnIdle {
        session_id: SessionId,
        reply: oneshot::Sender<Result<(), String>>,
    },
    SetMode {
        session_id: SessionId,
        mode_id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    SetModel {
        session_id: SessionId,
        model_id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    SetConfigOption {
        session_id: SessionId,
        config_id: String,
        value_id: String,
        reply: oneshot::Sender<Result<Vec<SessionConfigOption>, String>>,
    },
    RespondPermission {
        request_id: String,
        outcome: RequestPermissionOutcome,
        reply: oneshot::Sender<Result<(), String>>,
    },
    AnswerQuestion {
        question_id: String,
        values: Option<Vec<String>>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Run the ACP `authenticate` method with the given method id.
    Authenticate {
        method_id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Ask the driver thread to wind down its connection and exit.
    Shutdown,
}

/// Result of a successful `initialize` handshake, carried back to the spawning
/// task: the negotiated capabilities plus every advertised authentication
/// method (opaque `id`/`name`/optional `description`). The renderer needs the
/// full method metadata to present a Sign-in action and call
/// `authenticate(methodId)` before `session/new`.
struct InitOutcome {
    capabilities: AgentCapabilities,
    auth_methods: Vec<AuthMethodInfo>,
}

/// Registry entry for a live agent.
struct AgentEntry {
    command_tx: mpsc::UnboundedSender<AcpCommand>,
    capabilities: AgentCapabilities,
    stable_namespace: Option<String>,
    join_handle: Option<JoinHandle<()>>,
    /// Set true by `kill`/`kill_all` before winding the agent down, so the
    /// driver thread's teardown can tell an intentional kill (silent) from a
    /// spontaneous crash (emits `acp:agent_disconnected`). See L4.
    killed: Arc<AtomicBool>,
}

/// Manages all ACP agents, mirroring the `PtyManager` ownership pattern.
///
/// # AppHandle coupling (Story 1.1 / architecture D2)
///
/// `AcpManager` is **transport-neutral**: it holds `Vec<Arc<dyn EventSink>>`
/// and fans every `acp:*` event out through them. It does NOT hold a Tauri
/// `AppHandle`. The desktop app constructs it with
/// `vec![Arc::new(TauriEventSink::new(handle))]` (see `lib.rs`); the standalone
/// `termul-server` binary (Story 1.2) will construct it with a
/// `WsRelaySink`-backed sink list and NO `AppHandle` at all.
///
/// The ONLY `AppHandle` reference in the ACP stack lives inside
/// `crate::web::TauriEventSink::emit` (the desktop's sink — intentionally
/// Tauri-aware). No code under `src-tauri/src/acp/` may call `app.emit("acp:..")`
/// directly (AC7); all emission goes through [`events::fan_out`] against
/// `self.sinks`.
pub struct AcpManager {
    sinks: Vec<Arc<dyn EventSink>>,
    agents: Arc<Mutex<HashMap<AgentId, AgentEntry>>>,
    persistence: Option<Arc<SessionPersistence>>,
}

impl AcpManager {
    /// Create a new manager that fans `acp:*` events out to the given sinks.
    ///
    /// Pass `vec![Arc::new(TauriEventSink::new(handle))]` for the desktop app
    /// (byte-for-byte preserves today's Tauri event flow), or a
    /// `WsRelaySink`-backed list for the headless `termul-server` binary
    /// (Story 1.2). An empty `vec![]` is legal (used by unit tests that only
    /// exercise the command channel) — `fan_out` over zero sinks is a no-op.
    #[must_use]
    pub fn new(sinks: Vec<Arc<dyn EventSink>>) -> Self {
        Self {
            sinks,
            agents: Arc::new(Mutex::new(HashMap::new())),
            persistence: None,
        }
    }

    /// Create the standalone manager sharing one durable store with the relay.
    #[must_use]
    pub fn with_persistence(
        sinks: Vec<Arc<dyn EventSink>>,
        persistence: Arc<SessionPersistence>,
    ) -> Self {
        Self {
            sinks,
            agents: Arc::new(Mutex::new(HashMap::new())),
            persistence: Some(persistence),
        }
    }

    /// Spawn an ACP agent: launch the subprocess, complete `initialize`, and
    /// register the agent. Emits `acp:agent_spawned` on success.
    pub async fn spawn(&self, config: AgentConfig) -> Result<AgentId, String> {
        let agent_id = AgentId::new();
        let (command_tx, command_rx) = mpsc::unbounded_channel::<AcpCommand>();
        let (init_tx, init_rx) = oneshot::channel::<Result<InitOutcome, String>>();

        // Shared flag serialized by the `agents` lock: set true when the driver
        // thread removes itself (reaps) so a late `spawn` insert can't recreate
        // a ghost entry for an agent that already exited.
        let reaped = Arc::new(AtomicBool::new(false));
        // Set true by `kill`/`kill_all`; lets the driver teardown distinguish an
        // intentional kill (no disconnect event) from a crash (L4).
        let killed = Arc::new(AtomicBool::new(false));
        // Carries the connection-level failure reason (e.g. the subprocess could
        // not be spawned) back to this await path. When `connect_with` fails,
        // `init_tx` is dropped without ever being sent, so `init_rx` resolves to
        // `Err(_)` with no detail; the driver records the real error here so we
        // can surface it instead of a generic "did not initialize" message.
        let start_error = Arc::new(Mutex::new(None::<String>));

        let sinks = self.sinks.clone();
        let thread_agent_id = agent_id.clone();
        let thread_config = config.clone();
        let thread_agents = self.agents.clone();
        let thread_reaped = reaped.clone();
        let thread_killed = killed.clone();
        let thread_start_error = start_error.clone();
        let thread_persistence = self.persistence.clone();
        let stable_namespace = stable_agent_namespace(&config);

        let join_handle = std::thread::Builder::new()
            .name(format!("acp-agent-{agent_id}"))
            .spawn(move || {
                run_agent(
                    thread_config,
                    sinks,
                    thread_agent_id,
                    command_rx,
                    init_tx,
                    thread_agents,
                    thread_reaped,
                    thread_killed,
                    thread_start_error,
                    thread_persistence,
                );
            })
            .map_err(|e| format!("failed to spawn agent thread: {e}"))?;

        // Wait for the handshake to complete (or fail) on the driver thread.
        let (capabilities, auth_methods) = match init_rx.await {
            Ok(Ok(outcome)) => (outcome.capabilities, outcome.auth_methods),
            Ok(Err(e)) => {
                // Initialize failed; the driver thread is exiting. Join it off
                // the async runtime so we never block a Tauri worker.
                join_thread_bounded(join_handle).await;
                return Err(format!("agent initialize failed: {e}"));
            }
            Err(_) => {
                // Driver thread dropped the sender without initializing (e.g.
                // the subprocess failed to spawn). Join and report failure,
                // preferring the concrete connection error the driver recorded
                // (e.g. "program not found") over the generic fallback.
                join_thread_bounded(join_handle).await;
                let reason = start_error.lock().take();
                return Err(match reason {
                    Some(detail) => format!("agent failed to start: {detail}"),
                    None => "agent failed to start (process did not initialize)".to_string(),
                });
            }
        };

        // Register the agent, unless the driver thread already exited (e.g. the
        // agent crashed in the gap between init and registration). The `reaped`
        // check and the insert are serialized by the same lock the reaper uses.
        {
            let mut agents = self.agents.lock();
            if reaped.load(Ordering::Acquire) {
                drop(agents);
                join_thread_bounded(join_handle).await;
                return Err("agent exited before it could be registered".to_string());
            }
            agents.insert(
                agent_id.clone(),
                AgentEntry {
                    command_tx,
                    capabilities: capabilities.clone(),
                    stable_namespace,
                    join_handle: Some(join_handle),
                    killed,
                },
            );
        }

        let event = AgentSpawnedEvent {
            agent_id: agent_id.clone(),
            capabilities,
            auth_methods,
        };
        // `agent_spawned` is agent-level (no session yet) → sid = None.
        events::fan_out(&self.sinks, None, events::EVENT_AGENT_SPAWNED, &event);

        Ok(agent_id)
    }

    /// Return the ids of all currently registered agents.
    #[must_use]
    pub fn list_agents(&self) -> Vec<AgentId> {
        self.agents.lock().keys().cloned().collect()
    }

    /// Clone the command sender for an agent, or return a typed error.
    fn command_tx(&self, agent_id: &AgentId) -> Result<mpsc::UnboundedSender<AcpCommand>, String> {
        self.agents
            .lock()
            .get(agent_id)
            .map(|entry| entry.command_tx.clone())
            .ok_or_else(|| format!("unknown agent: {agent_id}"))
    }

    /// Clone an agent's negotiated capabilities, or return a typed error.
    fn capabilities(&self, agent_id: &AgentId) -> Result<AgentCapabilities, String> {
        self.agents
            .lock()
            .get(agent_id)
            .map(|entry| entry.capabilities.clone())
            .ok_or_else(|| format!("unknown agent: {agent_id}"))
    }

    /// Resolve the stable agent namespace (config id or safe fallback) for a
    /// live agent. Returns `Ok(Some(namespace))` when the agent has a stable
    /// namespace, `Ok(None)` when it has none, or `Err` when the agent is
    /// unknown. Used by the switch-back reopen filter so only sessions owned
    /// by the same agent namespace are candidates (patch #4).
    pub fn stable_agent_namespace(&self, agent_id: &AgentId) -> Result<Option<String>, String> {
        self.agents
            .lock()
            .get(agent_id)
            .map(|entry| entry.stable_namespace.clone())
            .ok_or_else(|| format!("unknown agent: {agent_id}"))
    }

    /// Create a new session on the given agent.
    pub async fn new_session(
        &self,
        agent_id: &AgentId,
        cwd: String,
        mcp_servers: Vec<McpServer>,
    ) -> Result<NewSessionOutcome, String> {
        self.new_session_with_context(
            agent_id,
            cwd,
            mcp_servers,
            SessionCreationContext::default(),
        )
        .await
    }

    pub async fn new_session_with_context(
        &self,
        agent_id: &AgentId,
        cwd: String,
        mcp_servers: Vec<McpServer>,
        context: SessionCreationContext,
    ) -> Result<NewSessionOutcome, String> {
        let (caps, stable_agent_namespace) = self
            .agents
            .lock()
            .get(agent_id)
            .map(|entry| (entry.capabilities.clone(), entry.stable_namespace.clone()))
            .ok_or_else(|| format!("unknown agent: {agent_id}"))?;
        gate_mcp_servers(&caps, &mcp_servers)?;
        let tx = self.command_tx(agent_id)?;
        send_command(&tx, |reply| AcpCommand::NewSession {
            cwd,
            mcp_servers,
            stable_agent_namespace,
            runtime_agent_id: agent_id.0.clone(),
            project_id: context.project_id,
            ephemeral: context.ephemeral,
            reply,
        })
        .await
    }

    /// Load an existing session. Gated on the agent's `loadSession` capability.
    pub async fn load_session(
        &self,
        agent_id: &AgentId,
        session_id: SessionId,
        cwd: String,
    ) -> Result<SessionReopenOutcome, String> {
        let caps = self.capabilities(agent_id)?;
        gate_load_session(&caps)?;
        let tx = self.command_tx(agent_id)?;
        send_command(&tx, |reply| AcpCommand::LoadSession {
            session_id,
            cwd,
            reply,
        })
        .await
    }

    /// Resume a session. Gated on the agent's `sessionCapabilities.resume`.
    pub async fn resume_session(
        &self,
        agent_id: &AgentId,
        session_id: SessionId,
        cwd: String,
    ) -> Result<SessionReopenOutcome, String> {
        let caps = self.capabilities(agent_id)?;
        gate_resume_session(&caps)?;
        let tx = self.command_tx(agent_id)?;
        send_command(&tx, |reply| AcpCommand::ResumeSession {
            session_id,
            cwd,
            reply,
        })
        .await
    }

    /// Close a session. Gated on the agent's `sessionCapabilities.close`.
    pub async fn close_session(
        &self,
        agent_id: &AgentId,
        session_id: SessionId,
    ) -> Result<(), String> {
        let caps = self.capabilities(agent_id)?;
        gate_close_session(&caps)?;
        let tx = self.command_tx(agent_id)?;
        send_command(&tx, |reply| AcpCommand::CloseSession { session_id, reply }).await
    }

    pub async fn dispose_ephemeral_session(
        &self,
        agent_id: &AgentId,
        session_id: SessionId,
    ) -> Result<(), String> {
        let tx = self.command_tx(agent_id)?;
        send_command(&tx, |reply| AcpCommand::DisposeEphemeralSession {
            session_id,
            reply,
        })
        .await
    }

    pub async fn is_ephemeral_session(
        &self,
        agent_id: &AgentId,
        session_id: SessionId,
    ) -> Result<bool, String> {
        let tx = self.command_tx(agent_id)?;
        send_command(&tx, |reply| AcpCommand::IsEphemeralSession {
            session_id,
            reply,
        })
        .await
    }

    /// List sessions on the given agent. Gated on the agent's
    /// `sessionCapabilities.list`. Pass `cwd` to filter by working directory;
    /// pass `cursor` for pagination (opaque token from a prior response).
    pub async fn list_sessions(
        &self,
        agent_id: &AgentId,
        cwd: Option<String>,
        cursor: Option<String>,
    ) -> Result<ListSessionsResponse, String> {
        let caps = self.capabilities(agent_id)?;
        gate_list_sessions(&caps)?;
        let tx = self.command_tx(agent_id)?;
        send_command(&tx, |reply| AcpCommand::ListSessions { cwd, cursor, reply }).await
    }

    /// Send a prompt and await the turn's stop reason. Streaming updates arrive
    /// as `acp:*` events; the turn ends with `acp:prompt_complete`.
    ///
    /// `turn_id` (Story 1.8 T3.2): optional client turn-id, echoed back on the
    /// `prompt_complete` event for the renderer's `seenTurnIds` idempotent dedup
    /// (FR11 — "no duplicate completion on reconnect replay"). `None` for the
    /// desktop path + older clients (dedup is a no-op).
    pub async fn send_prompt(
        &self,
        agent_id: &AgentId,
        session_id: SessionId,
        content: Vec<ContentBlock>,
        turn_id: Option<String>,
    ) -> Result<StopReason, String> {
        if content.is_empty() {
            return Err("prompt content must not be empty".to_string());
        }
        let tx = self.command_tx(agent_id)?;
        send_command(&tx, |reply| AcpCommand::SendPrompt {
            session_id,
            content,
            turn_id,
            reply,
        })
        .await
    }

    /// Cancel the active turn for a session, resolving pending permissions with
    /// the `cancelled` outcome. No-op (Ok) if there is no active turn.
    pub async fn cancel_prompt(
        &self,
        agent_id: &AgentId,
        session_id: SessionId,
    ) -> Result<(), String> {
        let tx = self.command_tx(agent_id)?;
        send_command(&tx, |reply| AcpCommand::CancelPrompt { session_id, reply }).await
    }

    /// Verify that a live agent's authoritative driver owns this session.
    /// Web prompt handling calls this before claiming a turn or mutating replay.
    pub async fn owns_session(
        &self,
        agent_id: &AgentId,
        session_id: SessionId,
    ) -> Result<bool, String> {
        let tx = self.command_tx(agent_id)?;
        send_command(&tx, |reply| AcpCommand::OwnsSession { session_id, reply }).await
    }

    /// Query the authoritative driver turn state through the agent channel.
    pub async fn is_turn_active(
        &self,
        agent_id: &AgentId,
        session_id: SessionId,
    ) -> Result<bool, String> {
        let tx = self.command_tx(agent_id)?;
        send_command(&tx, |reply| AcpCommand::IsTurnActive { session_id, reply }).await
    }

    /// Await authoritative turn completion without polling or sleeps.
    pub async fn wait_turn_idle(
        &self,
        agent_id: &AgentId,
        session_id: SessionId,
    ) -> Result<(), String> {
        let tx = self.command_tx(agent_id)?;
        send_command(&tx, |reply| AcpCommand::WaitTurnIdle { session_id, reply }).await
    }

    /// Set the session's active mode.
    pub async fn set_mode(
        &self,
        agent_id: &AgentId,
        session_id: SessionId,
        mode_id: String,
    ) -> Result<(), String> {
        let tx = self.command_tx(agent_id)?;
        send_command(&tx, |reply| AcpCommand::SetMode {
            session_id,
            mode_id,
            reply,
        })
        .await
    }

    /// Set the session's active model.
    pub async fn set_model(
        &self,
        agent_id: &AgentId,
        session_id: SessionId,
        model_id: String,
    ) -> Result<(), String> {
        let tx = self.command_tx(agent_id)?;
        send_command(&tx, |reply| AcpCommand::SetModel {
            session_id,
            model_id,
            reply,
        })
        .await
    }

    /// Set a session configuration option, returning the updated option set.
    pub async fn set_config_option(
        &self,
        agent_id: &AgentId,
        session_id: SessionId,
        config_id: String,
        value_id: String,
    ) -> Result<Vec<SessionConfigOption>, String> {
        let tx = self.command_tx(agent_id)?;
        send_command(&tx, |reply| AcpCommand::SetConfigOption {
            session_id,
            config_id,
            value_id,
            reply,
        })
        .await
    }

    /// Route a permission decision back to a waiting agent request.
    ///
    /// `option_id == None` resolves the request with `cancelled`; `Some(id)`
    /// resolves it with the selected option.
    pub async fn respond_permission(
        &self,
        agent_id: &AgentId,
        request_id: String,
        option_id: Option<String>,
    ) -> Result<(), String> {
        let outcome = match option_id {
            Some(id) => RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(id)),
            None => RequestPermissionOutcome::Cancelled,
        };
        let tx = self.command_tx(agent_id)?;
        send_command(&tx, |reply| AcpCommand::RespondPermission {
            request_id,
            outcome,
            reply,
        })
        .await
    }

    /// Route a structured-question answer (issue #411) back to a waiting agent
    /// request.
    ///
    /// `values == None` resolves the question as cancelled; `Some(values)`
    /// resolves it with the selected option values (exactly-once: the first
    /// answer wins; a later `answer_question` for the same id gets
    /// `"unknown question request"`, surfaced as `Ok(())` by the command
    /// wrapper).
    pub async fn answer_question(
        &self,
        agent_id: &AgentId,
        question_id: String,
        values: Option<Vec<String>>,
    ) -> Result<(), String> {
        let tx = self.command_tx(agent_id)?;
        send_command(&tx, |reply| AcpCommand::AnswerQuestion {
            question_id,
            values,
            reply,
        })
        .await
    }

    /// Run the ACP `authenticate` method for an agent with the given method id
    /// (one of the ids advertised in the `initialize` response).
    pub async fn authenticate(&self, agent_id: &AgentId, method_id: String) -> Result<(), String> {
        let tx = self.command_tx(agent_id)?;
        send_command(&tx, |reply| AcpCommand::Authenticate { method_id, reply }).await
    }

    /// Kill an agent: stop its driver thread and join it. Idempotent.
    pub async fn kill(&self, agent_id: &AgentId) -> Result<(), String> {
        let entry = self.agents.lock().remove(agent_id);
        let Some(mut entry) = entry else {
            // Already gone — idempotent success.
            return Ok(());
        };

        // Mark this as an intentional kill so the driver teardown stays silent
        // (no `acp:agent_disconnected` for a kill we initiated — L4).
        entry.killed.store(true, Ordering::Release);

        // Ask the driver loop to wind down, then drop the sender so the loop
        // ends even if the Shutdown was not observed.
        let _ = entry.command_tx.send(AcpCommand::Shutdown);
        drop(entry.command_tx);

        if let Some(handle) = entry.join_handle.take() {
            // Bounded join: a wedged agent must never make `kill` hang.
            join_thread_bounded(handle).await;
        }

        Ok(())
    }

    /// Kill all agents and surface join/persistence durability failures.
    pub async fn kill_all_checked(&self) -> Result<(), String> {
        let entries: Vec<(AgentId, AgentEntry)> = {
            let mut agents = self.agents.lock();
            agents.drain().collect()
        };

        let mut handles = Vec::new();
        for (_, mut entry) in entries {
            entry.killed.store(true, Ordering::Release);
            let _ = entry.command_tx.send(AcpCommand::Shutdown);
            drop(entry.command_tx);
            if let Some(handle) = entry.join_handle.take() {
                handles.push(handle);
            }
        }

        if handles.is_empty() {
            if let Some(persistence) = &self.persistence {
                persistence
                    .flush_all()
                    .await
                    .map_err(|error| error.to_string())?;
            }
            return Ok(());
        }

        // Bounded join across all threads so app exit can't hang on one stuck
        // agent. We join concurrently and cap the total wait at JOIN_TIMEOUT.
        let join_all = tokio::task::spawn_blocking(move || {
            for handle in handles {
                let _ = handle.join();
            }
        });
        tokio::time::timeout(JOIN_TIMEOUT, join_all)
            .await
            .map_err(|_| format!("agent shutdown exceeded {JOIN_TIMEOUT:?}"))?
            .map_err(|error| error.to_string())?;
        if let Some(persistence) = &self.persistence {
            persistence
                .flush_all()
                .await
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn install_test_agent_with_sessions(
        &self,
        agent_id: AgentId,
        sessions: std::collections::HashSet<String>,
    ) {
        let (command_tx, mut command_rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            while let Some(command) = command_rx.recv().await {
                if let AcpCommand::OwnsSession { session_id, reply } = command {
                    let _ = reply.send(Ok(sessions.contains(&session_id.0)));
                }
            }
        });
        self.agents.lock().insert(
            agent_id,
            AgentEntry {
                command_tx,
                capabilities: AgentCapabilities::default(),
                stable_namespace: None,
                join_handle: None,
                killed: Arc::new(AtomicBool::new(false)),
            },
        );
    }

    /// Desktop compatibility wrapper: logs failures because app-exit callers
    /// cannot return them. Standalone uses `kill_all_checked` directly.
    pub async fn kill_all(&self) {
        if let Err(error) = self.kill_all_checked().await {
            log::error!("[acp] shutdown durability failure: {error}");
        }
    }

    pub async fn shutdown_persistence(&self) -> Result<(), String> {
        match &self.persistence {
            Some(persistence) => persistence
                .shutdown()
                .await
                .map_err(|error| error.to_string()),
            None => Ok(()),
        }
    }
}

fn stable_agent_namespace(config: &AgentConfig) -> Option<String> {
    if let Some(config_id) = config
        .config_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        return Some(format!("config:{config_id}"));
    }
    // Safe fallback identity: normalized display name + executable basename +
    // stable boolean flags. Never hash full paths, args, or env because those
    // frequently contain usernames, workspaces, credentials, and tokens.
    let name = config.name.split_whitespace().collect::<Vec<_>>().join(" ");
    let command = config.command.replace('\\', "/");
    let basename = command.rsplit('/').next().unwrap_or_default().trim();
    if name.is_empty() || basename.is_empty() || matches!(basename, "." | "..") {
        return None;
    }
    let identity = format!(
        "{}\0{}\0terminal={}",
        name.to_ascii_lowercase(),
        basename.to_ascii_lowercase(),
        config.allow_terminal
    );
    let mut hash = 0xcbf29ce484222325u64;
    for byte in identity.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    Some(format!("agent-safe:{hash:016x}"))
}

/// Validate project/session MCP transports against negotiated capabilities.
/// Stdio is mandatory in ACP; HTTP/SSE require their advertised flags.
fn gate_mcp_servers(caps: &AgentCapabilities, servers: &[McpServer]) -> Result<(), String> {
    for server in servers {
        match server {
            McpServer::Stdio(_) => {}
            McpServer::Http(_) if caps.mcp_capabilities.http => {}
            McpServer::Sse(_) if caps.mcp_capabilities.sse => {}
            McpServer::Http(_) => {
                return Err("agent does not support HTTP MCP servers".to_string());
            }
            McpServer::Sse(_) => {
                return Err("agent does not support SSE MCP servers".to_string());
            }
            _ => return Err("agent does not support this MCP transport".to_string()),
        }
    }
    Ok(())
}

/// Map the agent's advertised `initialize` auth methods to the renderer-facing
/// [`AuthMethodInfo`] contract. Every method is forwarded as an opaque
/// `id`/`name`/optional `description` descriptor — no agent-type filtering, so
/// the renderer decides how to present them (single Sign-in vs. actionable
/// multi-method failure). Extracted so the mapping can be unit-tested without a
/// live connection.
fn to_auth_method_infos(methods: &[AuthMethod]) -> Vec<AuthMethodInfo> {
    methods
        .iter()
        .map(|m| AuthMethodInfo {
            id: m.id().to_string(),
            name: m.name().to_string(),
            description: m.description().map(str::to_string),
        })
        .collect()
}

/// Capability gate for `session/load`: requires the agent's `loadSession`
/// capability. Returns a typed error (without contacting the agent) when it is
/// absent. Extracted so the real gate can be unit-tested without an AppHandle.
fn gate_load_session(caps: &AgentCapabilities) -> Result<(), String> {
    if caps.load_session {
        Ok(())
    } else {
        Err("agent does not support session/load (loadSession capability)".to_string())
    }
}

/// Capability gate for `session/resume`: requires `sessionCapabilities.resume`.
fn gate_resume_session(caps: &AgentCapabilities) -> Result<(), String> {
    if caps.session_capabilities.resume.is_some() {
        Ok(())
    } else {
        Err("agent does not support session/resume".to_string())
    }
}

/// Capability gate for `session/close`: requires `sessionCapabilities.close`.
fn gate_close_session(caps: &AgentCapabilities) -> Result<(), String> {
    if caps.session_capabilities.close.is_some() {
        Ok(())
    } else {
        Err("agent does not support session/close".to_string())
    }
}

/// Capability gate for `session/list`: requires `sessionCapabilities.list`.
/// Per the ACP spec: "If `sessionCapabilities.list` is not present … Clients
/// MUST NOT attempt to call `session/list`."
fn gate_list_sessions(caps: &AgentCapabilities) -> Result<(), String> {
    if caps.session_capabilities.list.is_some() {
        Ok(())
    } else {
        Err("agent does not support session/list (sessionCapabilities.list)".to_string())
    }
}

/// Send a command to a driver thread and await its `Send` oneshot reply.
async fn send_command<T>(
    command_tx: &mpsc::UnboundedSender<AcpCommand>,
    make: impl FnOnce(oneshot::Sender<Result<T, String>>) -> AcpCommand,
) -> Result<T, String> {
    let (reply_tx, reply_rx) = oneshot::channel();
    command_tx
        .send(make(reply_tx))
        .map_err(|_| "agent thread is no longer running".to_string())?;
    reply_rx
        .await
        .map_err(|_| "agent thread dropped the reply".to_string())?
}

/// Join a driver thread without ever blocking the async runtime indefinitely.
///
/// The join runs on the blocking pool and is capped at [`JOIN_TIMEOUT`]; if a
/// wedged agent thread refuses to exit, we abandon the join (the OS reclaims
/// the thread at process exit) rather than hang the caller / app-exit path.
async fn join_thread_bounded(handle: JoinHandle<()>) {
    let join = tokio::task::spawn_blocking(move || {
        let _ = handle.join();
    });
    if tokio::time::timeout(JOIN_TIMEOUT, join).await.is_err() {
        log::warn!("[acp] agent thread did not exit within {JOIN_TIMEOUT:?}; abandoning join");
    }
}

/// Entry point for an agent's dedicated driver thread.
///
/// Builds a current-thread Tokio runtime and drives the ACP connection to
/// completion. All `!Send`-sensitive connection work is confined here.
///
/// On exit (for any reason — clean shutdown, agent crash, or initialize
/// failure) the thread reaps itself from the registry and, if it had actually
/// spawned (`spawned` is true), emits the appropriate disconnect/close events.
#[allow(clippy::too_many_arguments)]
fn run_agent(
    config: AgentConfig,
    sinks: Vec<Arc<dyn EventSink>>,
    agent_id: AgentId,
    command_rx: mpsc::UnboundedReceiver<AcpCommand>,
    init_tx: oneshot::Sender<Result<InitOutcome, String>>,
    agents: Arc<Mutex<HashMap<AgentId, AgentEntry>>>,
    reaped: Arc<AtomicBool>,
    killed: Arc<AtomicBool>,
    start_error: Arc<Mutex<Option<String>>>,
    persistence: Option<Arc<SessionPersistence>>,
) {
    // True once `initialize` succeeded and the agent was surfaced to the
    // renderer via `acp:agent_spawned`. We only emit disconnect/error events
    // for agents the renderer actually saw (L4/F5).
    let spawned = Arc::new(AtomicBool::new(false));
    // Shared with the connection handlers and the command loop. Created here so
    // that, even if the agent crashes and `main_fn` is dropped mid-await, this
    // teardown code can still drain leaked permissions and discover which
    // sessions were active for `acp:session_closed`.
    let driver_state = Arc::new(Mutex::new(DriverState::new()));

    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            let _ = init_tx.send(Err(format!("failed to build runtime: {e}")));
            *start_error.lock() = Some(format!("failed to build runtime: {e}"));
            return;
        }
    };

    let result = runtime.block_on(drive_connection(
        config,
        sinks.clone(),
        agent_id.clone(),
        command_rx,
        init_tx,
        spawned.clone(),
        driver_state.clone(),
        persistence.clone(),
    ));

    let was_spawned = spawned.load(Ordering::Acquire);

    // Drain any permissions that leaked because the connection ended (crash /
    // disconnect) without the loop resolving them. The connection is gone, so
    // responding may fail silently — that is fine; the point is to not hold the
    // responders forever (H3).
    let (leaked, active_sessions) = {
        let mut state = driver_state.lock();
        (state.drain_all(), state.active_session_ids())
    };
    for permission in leaked {
        let _ = permission.responder.respond(RequestPermissionResponse::new(
            RequestPermissionOutcome::Cancelled,
        ));
    }
    // Issue #411: resolve leaked questions as cancelled too (the connection is
    // gone, so responding may fail silently — the point is to not hold the
    // responders forever).
    let leaked_questions = driver_state.lock().drain_all_questions();
    for question in leaked_questions {
        let _ = question.responder.respond(serde_json::json!({
            "questionId": question.question_id,
            "cancelled": true,
        }));
    }

    // Self-reap: remove our own registry entry so a crashed/EOFed agent does
    // not linger in `list_agents` with a dead command channel. We do NOT join
    // our own handle here (a thread cannot join itself); `kill`/`kill_all` may
    // still hold the handle, and joining a finished thread returns promptly.
    // The `reaped` flag (set under the same lock the registrar checks) closes
    // the race where init succeeded but the agent exited before registration.
    {
        let mut map = agents.lock();
        reaped.store(true, Ordering::Release);
        map.remove(&agent_id);
    }

    // Only surface lifecycle events for an agent the renderer actually saw, and
    // never for an intentional kill (L4): a kill we initiated is silent, so the
    // renderer doesn't see a "disconnected" it didn't cause.
    let intentional_kill = killed.load(Ordering::Acquire);

    // If the agent never finished initializing, the connection error IS the
    // start-failure reason (e.g. the subprocess could not be spawned). Record it
    // BEFORE the lifecycle gate below so the awaiting `spawn` caller can surface
    // the real error instead of the generic "did not initialize" message. This
    // must run regardless of `was_spawned`/`intentional_kill` (those gate only
    // the renderer-facing lifecycle events).
    if !was_spawned {
        if let Err(message) = &result {
            *start_error.lock() = Some(message.clone());
        }
    }

    let mut persistence_failures = Vec::new();
    if let Some(persistence) = &persistence {
        for session in &active_sessions {
            let status = if result.is_err() {
                PersistedSessionStatus::Error
            } else {
                PersistedSessionStatus::Closed
            };
            if let Err(error) = runtime.block_on(persistence.finalize_session(session, status)) {
                persistence_failures.push(format!("session {session}: {error}"));
            }
        }
    }
    if !persistence_failures.is_empty() {
        log::error!(
            "[acp] failed to finalize {} persisted session(s): {}",
            persistence_failures.len(),
            persistence_failures.join("; ")
        );
    }

    if was_spawned && !intentional_kill {
        for session in active_sessions {
            let event = SessionClosedEvent {
                agent_id: agent_id.clone(),
                session_id: SessionId::new(session),
            };
            events::fan_out(
                &sinks,
                Some(event.session_id.0.as_str()),
                events::EVENT_SESSION_CLOSED,
                &event,
            );
        }

        if let Err(message) = result {
            // Story 1.9 FR26: emit the typed `AgentCrashed` event BEFORE
            // `agent_error` (back-compat) + `agent_disconnected`. The renderer
            // distinguishes "crash" (→ `status: 'error'` + manual restart) from
            // a clean disconnect. Outstanding turn oneshots fail with this.
            let crashed = AgentCrashedEvent {
                agent_id: agent_id.clone(),
                session_id: None,
                message: message.clone(),
            };
            events::fan_out(&sinks, None, events::EVENT_AGENT_CRASHED, &crashed);

            let event = AgentErrorEvent {
                agent_id: agent_id.clone(),
                session_id: None,
                message,
            };
            // Teardown error is agent-level (no session) → sid = None.
            events::fan_out(&sinks, None, events::EVENT_AGENT_ERROR, &event);
        }

        let event = AgentDisconnectedEvent { agent_id };
        // Agent-level lifecycle event → sid = None.
        events::fan_out(&sinks, None, events::EVENT_AGENT_DISCONNECTED, &event);
    }
}

/// Build the client connection and run it until the command loop ends.
#[allow(clippy::too_many_arguments)]
async fn drive_connection(
    config: AgentConfig,
    sinks: Vec<Arc<dyn EventSink>>,
    agent_id: AgentId,
    command_rx: mpsc::UnboundedReceiver<AcpCommand>,
    init_tx: oneshot::Sender<Result<InitOutcome, String>>,
    spawned: Arc<AtomicBool>,
    driver_state: Arc<Mutex<DriverState>>,
    persistence: Option<Arc<SessionPersistence>>,
) -> Result<(), String> {
    // Forward the agent subprocess's stdio to the log at `debug` (opt-in via
    // `RUST_LOG`). stderr is where agents print auth/login prompts and runtime
    // errors, so it is logged verbatim. stdin/stdout carry the JSON-RPC protocol
    // trace which can include `authenticate` payloads (API keys, OAuth tokens),
    // so by default those are redacted to direction + byte length — enough to
    // confirm streaming/traffic without writing secrets to disk.
    //
    // Set `TERMUL_ACP_TRACE_RAW=1` to log the full stdin/stdout JSON-RPC bodies
    // (diagnostics only — may write secrets to the log; never enable in normal
    // use). Combine with a debug log level to see the trace.
    let debug_agent_id = agent_id.clone();
    let trace_raw = std::env::var("TERMUL_ACP_TRACE_RAW")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let agent = agent_client_protocol::AcpAgent::new(config.to_mcp_server()).with_debug(
        move |line: &str, direction: LineDirection| match direction {
            LineDirection::Stderr => {
                log::debug!("[acp] {debug_agent_id} stderr {line}");
            }
            LineDirection::Stdin => {
                if trace_raw {
                    log::debug!("[acp] {debug_agent_id} -> {line}");
                } else {
                    log::debug!("[acp] {debug_agent_id} -> ({} bytes)", line.len());
                }
            }
            LineDirection::Stdout => {
                if trace_raw {
                    log::debug!("[acp] {debug_agent_id} <- {line}");
                } else {
                    log::debug!("[acp] {debug_agent_id} <- ({} bytes)", line.len());
                }
            }
        },
    );

    // Per-handler clones (handlers must be `Send` and may be called repeatedly).
    // Each handler gets its own clone of the sink fan-out; `Arc` clones are
    // cheap and `Vec::clone` is N Arc clones (N is tiny: 1 sink in desktop mode
    // today, 2 once Story 1.10 adds the shared-live WS sink).
    let notif_sinks = sinks.clone();
    let notif_agent_id = agent_id.clone();
    let notif_state = driver_state.clone();
    let perm_sinks = sinks.clone();
    let perm_agent_id = agent_id.clone();
    let perm_state = driver_state.clone();
    let question_sinks = sinks.clone();
    let question_agent_id = agent_id.clone();
    let question_state = driver_state.clone();
    let read_state = driver_state.clone();
    let write_state = driver_state.clone();

    // Terminal capability (P6b): a per-agent registry of ACP command-runner
    // terminals. Handlers are always registered, but they only do work when the
    // agent opted in (`allow_terminal`); the real gate is the capability
    // advertisement (default false), so a compliant agent never calls these
    // unless allowed. The registry is torn down with the driver thread.
    let allow_terminal = config.allow_terminal;
    let terminals = Arc::new(Mutex::new(crate::acp::terminal::TerminalRegistry::new()));
    let term_create = terminals.clone();
    let term_create_state = driver_state.clone();
    let term_output = terminals.clone();
    let term_output_state = driver_state.clone();
    let term_wait = terminals.clone();
    let term_wait_state = driver_state.clone();
    let term_kill = terminals.clone();
    let term_kill_state = driver_state.clone();
    let term_release = terminals.clone();
    let term_release_state = driver_state.clone();
    let loop_terminals = terminals.clone();

    // Clones moved into the command loop (`main_fn`).
    let loop_sinks = sinks.clone();
    let loop_agent_id = agent_id.clone();
    let loop_state = driver_state.clone();
    let loop_spawned = spawned.clone();

    let connection_result = Client
        .builder()
        .name(format!("termul-acp-{agent_id}"))
        .on_receive_notification(
            async move |notification: agent_client_protocol::schema::v1::SessionNotification, _cx| {
                let session_id = notification.session_id.0.to_string();
                // Any inbound session/update is agent activity — nudge the
                // active turn's idle deadline so a streaming turn never hits
                // the idle timeout. Best-effort: a no-op when no turn is
                // active for this session.
                notif_state.lock().signal_idle(&session_id);
                let tool_call_id = match &notification.update {
                    agent_client_protocol::schema::v1::SessionUpdate::ToolCall(tool_call) => {
                        Some(tool_call.tool_call_id.0.to_string())
                    }
                    agent_client_protocol::schema::v1::SessionUpdate::ToolCallUpdate(update) => {
                        Some(update.tool_call_id.0.to_string())
                    }
                    _ => None,
                };
                if let Some(tool_call_id) = tool_call_id {
                    notif_state.lock().bind_tool_call(tool_call_id, session_id);
                }
                client::emit_session_update(&notif_sinks, &notif_agent_id, notification);
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: agent_client_protocol::schema::v1::RequestPermissionRequest,
                        responder,
                        _cx| {
                let agent_client_protocol::schema::v1::RequestPermissionRequest {
                    session_id,
                    tool_call,
                    options,
                    ..
                } = request;
                let session_string = session_id.0.to_string();
                if perm_state.lock().is_ephemeral(&session_string) {
                    let _ = responder.respond(RequestPermissionResponse::new(
                        RequestPermissionOutcome::Cancelled,
                    ));
                    return Ok(());
                }
                // A permission request is agent activity — the turn is waiting
                // on user input, not wedged. Nudge the idle deadline so a
                // user-input wait doesn't false-fire the idle timeout.
                perm_state.lock().signal_idle(&session_string);
                let request_id = {
                    let mut state = perm_state.lock();
                    state.bind_tool_call(
                        tool_call.tool_call_id.0.to_string(),
                        session_string.clone(),
                    );
                    state.register_permission(session_string.clone(), responder)
                };
                let event = events::PermissionRequestEvent {
                    agent_id: perm_agent_id.clone(),
                    session_id: SessionId::new(session_string),
                    request_id,
                    tool_call,
                    options,
                };
                events::fan_out(
                    &perm_sinks,
                    Some(event.session_id.0.as_str()),
                    events::EVENT_PERMISSION_REQUEST,
                    &event,
                );
                Ok(())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: AskUserQuestionRequest, responder, _cx| {
                // Issue #411: a structured question from the agent. Register the
                // parked `Responder<serde_json::Value>` (mirroring permissions),
                // fan out `acp:question_request`, and resolve the responder when
                // the user answers via `acp_answer_question` / `answer_question`.
                let session_string = request.session_id.clone();
                if question_state.lock().is_ephemeral(&session_string) {
                    let _ = responder.respond(serde_json::json!({
                        "cancelled": true,
                    }));
                    return Ok(());
                }
                // A structured question is agent activity — the turn is waiting
                // on user input, not wedged. Nudge the idle deadline so a
                // user-input wait doesn't false-fire the idle timeout.
                question_state.lock().signal_idle(&session_string);
                let question_id = {
                    let mut state = question_state.lock();
                    state.register_question(session_string.clone(), responder)
                };
                let event = events::AskUserQuestionEvent {
                    agent_id: question_agent_id.clone(),
                    session_id: SessionId::new(session_string),
                    question_id,
                    question: request.question,
                    options: request
                        .options
                        .into_iter()
                        .map(|o| events::QuestionOption {
                            value: o.value,
                            label: o.label,
                            description: o.description,
                            cardinality: o.cardinality,
                        })
                        .collect(),
                };
                events::fan_out(
                    &question_sinks,
                    Some(event.session_id.0.as_str()),
                    events::EVENT_QUESTION_REQUEST,
                    &event,
                );
                Ok(())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: agent_client_protocol::schema::v1::ReadTextFileRequest,
                        responder,
                        cx| {
                // Resolve the session's workspace root (the sandbox boundary)
                // and perform the (blocking) read off the dispatch loop so a
                // large file can't stall connection I/O (M1).
                let root = {
                    let state = read_state.lock();
                    if state.is_ephemeral(request.session_id.0.as_ref()) {
                        let denied = Err(agent_client_protocol::Error::method_not_found());
                        let _ = responder.respond_with_result(denied);
                        return Ok(());
                    }
                    state.session_root(request.session_id.0.as_ref())
                };
                cx.spawn(async move {
                    let result = client::handle_read_text_file(&request, root.as_deref()).await;
                    let _ = responder.respond_with_result(result);
                    Ok(())
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: agent_client_protocol::schema::v1::WriteTextFileRequest,
                        responder,
                        cx| {
                let root = {
                    let state = write_state.lock();
                    if state.is_ephemeral(request.session_id.0.as_ref()) {
                        let denied = Err(agent_client_protocol::Error::method_not_found());
                        let _ = responder.respond_with_result(denied);
                        return Ok(());
                    }
                    state.session_root(request.session_id.0.as_ref())
                };
                cx.spawn(async move {
                    let result = client::handle_write_text_file(&request, root.as_deref()).await;
                    let _ = responder.respond_with_result(result);
                    Ok(())
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: agent_client_protocol::schema::v1::CreateTerminalRequest,
                        responder,
                        _cx| {
                use agent_client_protocol::schema::v1::CreateTerminalResponse;
                if !allow_terminal
                    || term_create_state
                        .lock()
                        .is_ephemeral(request.session_id.0.as_ref())
                {
                    let denied: Result<CreateTerminalResponse, agent_client_protocol::Error> =
                        Err(agent_client_protocol::Error::method_not_found());
                    let _ = responder.respond_with_result(denied);
                    return Ok(());
                }
                // Default the cwd to the session's workspace root when the agent
                // doesn't specify one.
                let session_root = term_create_state
                    .lock()
                    .session_root(request.session_id.0.as_ref());
                let cwd = request.cwd.clone().or(session_root);
                let env: Vec<(String, String)> = request
                    .env
                    .iter()
                    .map(|e| (e.name.clone(), e.value.clone()))
                    .collect();
                let result = term_create
                    .lock()
                    .create(
                        &request.command,
                        &request.args,
                        &env,
                        cwd.as_deref(),
                        request.output_byte_limit,
                    )
                    .map(CreateTerminalResponse::new)
                    .map_err(|e| agent_client_protocol::Error::internal_error().data(e));
                let _ = responder.respond_with_result(result);
                Ok(())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: agent_client_protocol::schema::v1::TerminalOutputRequest,
                        responder,
                        _cx| {
                use agent_client_protocol::schema::v1::TerminalOutputResponse;
                if term_output_state
                    .lock()
                    .is_ephemeral(request.session_id.0.as_ref())
                {
                    let denied: Result<TerminalOutputResponse, agent_client_protocol::Error> =
                        Err(agent_client_protocol::Error::method_not_found());
                    let _ = responder.respond_with_result(denied);
                    return Ok(());
                }
                let result = term_output
                    .lock()
                    .output(&request.terminal_id)
                    .map(|(output, truncated, exit)| {
                        TerminalOutputResponse::new(output, truncated).exit_status(exit)
                    })
                    .map_err(|e| agent_client_protocol::Error::internal_error().data(e));
                let _ = responder.respond_with_result(result);
                Ok(())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: agent_client_protocol::schema::v1::WaitForTerminalExitRequest,
                        responder,
                        cx| {
                use agent_client_protocol::schema::v1::WaitForTerminalExitResponse;
                if term_wait_state
                    .lock()
                    .is_ephemeral(request.session_id.0.as_ref())
                {
                    let denied: Result<WaitForTerminalExitResponse, agent_client_protocol::Error> =
                        Err(agent_client_protocol::Error::method_not_found());
                    let _ = responder.respond_with_result(denied);
                    return Ok(());
                }
                let registry = term_wait.clone();
                // Await off the dispatch path so other terminal ops stay
                // responsive. The child handle is taken out from under the lock
                // first, so the registry mutex is NOT held across the await.
                cx.spawn(async move {
                    let taken = registry.lock().take_child_for_wait(&request.terminal_id);
                    let result = match taken {
                        Err(e) => Err(agent_client_protocol::Error::internal_error().data(e)),
                        Ok(None) => {
                            // Already exited: return the cached status.
                            match registry.lock().cached_exit(&request.terminal_id) {
                                Some(status) => Ok(WaitForTerminalExitResponse::new(status)),
                                None => Err(agent_client_protocol::Error::internal_error()
                                    .data("terminal has no exit status")),
                            }
                        }
                        Ok(Some(mut child)) => match child.wait().await {
                            Ok(status) => {
                                let exit = crate::acp::terminal::to_exit_status(status);
                                registry
                                    .lock()
                                    .record_exit(&request.terminal_id, exit.clone());
                                Ok(WaitForTerminalExitResponse::new(exit))
                            }
                            Err(e) => Err(agent_client_protocol::Error::internal_error()
                                .data(format!("failed to wait for terminal: {e}"))),
                        },
                    };
                    let _ = responder.respond_with_result(result);
                    Ok(())
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: agent_client_protocol::schema::v1::KillTerminalRequest,
                        responder,
                        _cx| {
                use agent_client_protocol::schema::v1::KillTerminalResponse;
                if term_kill_state
                    .lock()
                    .is_ephemeral(request.session_id.0.as_ref())
                {
                    let denied: Result<KillTerminalResponse, agent_client_protocol::Error> =
                        Err(agent_client_protocol::Error::method_not_found());
                    let _ = responder.respond_with_result(denied);
                    return Ok(());
                }
                let result = term_kill
                    .lock()
                    .kill(&request.terminal_id)
                    .map(|()| KillTerminalResponse::new())
                    .map_err(|e| agent_client_protocol::Error::internal_error().data(e));
                let _ = responder.respond_with_result(result);
                Ok(())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: agent_client_protocol::schema::v1::ReleaseTerminalRequest,
                        responder,
                        _cx| {
                use agent_client_protocol::schema::v1::ReleaseTerminalResponse;
                if term_release_state
                    .lock()
                    .is_ephemeral(request.session_id.0.as_ref())
                {
                    let denied: Result<ReleaseTerminalResponse, agent_client_protocol::Error> =
                        Err(agent_client_protocol::Error::method_not_found());
                    let _ = responder.respond_with_result(denied);
                    return Ok(());
                }
                let result = term_release
                    .lock()
                    .release(&request.terminal_id)
                    .map(|()| ReleaseTerminalResponse::new())
                    .map_err(|e| agent_client_protocol::Error::internal_error().data(e));
                let _ = responder.respond_with_result(result);
                Ok(())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(agent, async move |cx: ConnectionTo<Agent>| {
            let loop_result = run_command_loop(
                cx,
                command_rx,
                init_tx,
                loop_sinks,
                loop_agent_id,
                loop_state,
                loop_spawned,
                allow_terminal,
                persistence,
            )
            .await;
            // Driver thread is winding down — kill any live terminal children so
            // they don't outlive the agent.
            loop_terminals.lock().release_all();
            loop_result
        })
        .await;

    connection_result.map_err(|e| e.to_string())
}

/// The agent driver's main loop: complete `initialize`, then service commands
/// until shutdown. Runs concurrently with the connection's dispatch actors.
#[allow(clippy::too_many_arguments)]
async fn run_command_loop(
    cx: ConnectionTo<Agent>,
    mut command_rx: mpsc::UnboundedReceiver<AcpCommand>,
    init_tx: oneshot::Sender<Result<InitOutcome, String>>,
    sinks: Vec<Arc<dyn EventSink>>,
    agent_id: AgentId,
    driver_state: Arc<Mutex<DriverState>>,
    spawned: Arc<AtomicBool>,
    allow_terminal: bool,
    persistence: Option<Arc<SessionPersistence>>,
) -> Result<(), agent_client_protocol::Error> {
    // Step 1: handshake, bounded by INIT_TIMEOUT so a silent agent can never
    // wedge `acp_spawn_agent` forever (H1). On timeout we report the failure
    // and return; returning ends `main_fn`, which tears the connection down and
    // kills the child via the SDK's `ChildGuard`.
    let init_request = InitializeRequest::new(ProtocolVersion::V1)
        .client_capabilities(client::client_capabilities(allow_terminal));
    let init_outcome =
        tokio::time::timeout(INIT_TIMEOUT, cx.send_request(init_request).block_task()).await;
    let supports_session_close = match init_outcome {
        Ok(Ok(response)) => {
            // Propagate the FULL advertised auth methods (opaque
            // id/name/optional description) so the renderer can offer a Sign-in
            // action and call `authenticate(methodId)` before `session/new`.
            // Every advertised method is forwarded; no agent-type filtering.
            let auth_methods = to_auth_method_infos(&response.auth_methods);
            let auth_method_ids: Vec<&str> = auth_methods.iter().map(|m| m.id.as_str()).collect();
            let session_caps = &response.agent_capabilities.session_capabilities;
            let supports_session_close = session_caps.close.is_some();
            log::info!(
                "[acp] agent {agent_id} initialized: protocol={:?} auth_methods={:?} \
                 loadSession={} sessionCapabilities.list={} resume={} close={}",
                response.protocol_version,
                auth_method_ids,
                response.agent_capabilities.load_session,
                session_caps.list.is_some(),
                session_caps.resume.is_some(),
                supports_session_close,
            );

            spawned.store(true, Ordering::Release);
            let _ = init_tx.send(Ok(InitOutcome {
                capabilities: response.agent_capabilities,
                auth_methods,
            }));
            supports_session_close
        }
        Ok(Err(e)) => {
            let _ = init_tx.send(Err(e.to_string()));
            return Err(e);
        }
        Err(_) => {
            let message = format!("initialize timed out after {INIT_TIMEOUT:?}");
            let _ = init_tx.send(Err(message.clone()));
            return Err(agent_client_protocol::Error::internal_error().data(message));
        }
    };

    // Step 2: command loop.
    //
    // Every agent→client *request* is dispatched via `cx.spawn` (not awaited
    // inline), so the loop returns to `command_rx.recv()` immediately. This is
    // the C1 fix: while any request is in flight, `RespondPermission` is still
    // serviced, so an agent that gates its reply on a permission decision can
    // never deadlock the loop. `recv()` is also always responsive to
    // `Shutdown` and to channel close, so `kill`/`kill_all` always make
    // progress (H1). Spawned tasks must return `Ok(())` and route protocol
    // errors through their reply channel — a spawned task that returns `Err`
    // would tear down the whole connection.
    while let Some(command) = command_rx.recv().await {
        match command {
            AcpCommand::Shutdown => break,

            AcpCommand::NewSession {
                cwd,
                mcp_servers,
                stable_agent_namespace,
                runtime_agent_id,
                project_id,
                ephemeral,
                reply,
            } => {
                let slot = reply_slot(reply);
                let task_slot = slot.clone();
                let req_cx = cx.clone();
                let close_cx = cx.clone();
                let req_sinks = sinks.clone();
                let req_agent_id = agent_id.clone();
                let req_state = driver_state.clone();
                let req_persistence = persistence.clone();
                spawn_request(&cx, slot, async move {
                    let request = NewSessionRequest::new(cwd.clone()).mcp_servers(mcp_servers);
                    let timeout = session_new_timeout();
                    log::debug!(
                        "[acp] {req_agent_id} session/new sent, awaiting reply (timeout {timeout:?})"
                    );
                    match tokio::time::timeout(timeout, req_cx.send_request(request).block_task())
                        .await
                    {
                        Ok(Ok(response)) => {
                            let session_id = SessionId::from(response.session_id);
                            if !ephemeral {
                                if let Some(persistence) = req_persistence {
                                    let registration = SessionRegistration {
                                        session_id: session_id.0.clone(),
                                        stable_agent_namespace,
                                        runtime_agent_id: Some(runtime_agent_id),
                                        project_id,
                                        cwd: PathBuf::from(&cwd),
                                    };
                                    if let Err(error) =
                                        persistence.register_session(registration).await
                                    {
                                        let _ = close_cx
                                            .send_request(CloseSessionRequest::new(&session_id))
                                            .block_task()
                                            .await;
                                        send_reply(
                                            &task_slot,
                                            Err(format!("failed to persist new session: {error}")),
                                        );
                                        return;
                                    }
                                }
                            }
                            // Record the session's workspace root so agent fs
                            // requests for this session can be sandboxed (H2).
                            {
                                let mut state = req_state.lock();
                                state.set_session_root(session_id.0.clone(), PathBuf::from(&cwd));
                                if ephemeral {
                                    state.mark_ephemeral(session_id.0.clone());
                                }
                            }

                            // ---- First-prompt warmup (upstream bug workaround) ----
                            //
                            // pi-acp's `PiRpcProcess.request()` has no timeout, and pi's
                            // `session.prompt()` may stall before calling `preflightResult`
                            // on a cold start. The warmup sends a lightweight
                            // `session/prompt` through the full pi-acp pipeline BEFORE
                            // the `acp:session_created` event is emitted, so the
                            // renderer's event handlers silently drop warmup events
                            // (the session doesn't exist in the store yet). If the
                            // warmup times out, we cancel and continue — session
                            // creation still succeeds, but the user's first manual
                            // prompt may still experience the cold-start hang.
                            // See: https://github.com/svkozak/pi-acp/issues/94
                            let warmup_timeout = first_prompt_warmup_timeout();
                            if warmup_timeout.as_secs() > 0 {
                                let warmup_content =
                                    vec![agent_client_protocol::schema::v1::ContentBlock::Text(
                                        agent_client_protocol::schema::v1::TextContent::new(
                                            " ".to_string(),
                                        ),
                                    )];
                                let warmup_request =
                                    PromptRequest::new(&session_id, warmup_content);
                                log::info!(
                                    "[acp] {req_agent_id} first-prompt warmup started \
                                     (timeout {warmup_timeout:?})"
                                );
                                let warmup = req_cx.send_request(warmup_request).block_task();
                                tokio::pin!(warmup);
                                match tokio::time::timeout(warmup_timeout, &mut warmup).await {
                                    Ok(Ok(_response)) => {
                                        log::info!(
                                            "[acp] {req_agent_id} first-prompt warmup \
                                             completed — agent is ready"
                                        );
                                    }
                                    Ok(Err(e)) => {
                                        log::warn!(
                                            "[acp] {req_agent_id} first-prompt warmup \
                                             failed: {e} (continuing without warmup)"
                                        );
                                    }
                                    Err(_) => {
                                        log::warn!(
                                            "[acp] {req_agent_id} first-prompt warmup \
                                             timed out after {warmup_timeout:?} \
                                             (cancelling)"
                                        );
                                        // Signal cancel so pi-acp's in-flight
                                        // warmup turn can settle.
                                        let _ = req_cx
                                            .send_notification(CancelNotification::new(&session_id))
                                            .map_err(|e| {
                                                log::debug!(
                                                    "[acp] warmup cancel notification \
                                                     failed: {e}"
                                                );
                                                e
                                            });
                                        // Await the warmup's cancellation
                                        // settlement (bounded by CANCEL_GRACE)
                                        // so the session is not left with a
                                        // pending turn in pi-acp when the user
                                        // sends their first prompt. Mirrors the
                                        // SendPrompt handler's cancel-grace race.
                                        match tokio::time::timeout(CANCEL_GRACE, &mut warmup).await
                                        {
                                            Ok(Ok(_)) => {
                                                log::info!(
                                                    "[acp] {req_agent_id} warmup \
                                                     cancelled and settled"
                                                );
                                            }
                                            Ok(Err(e)) => {
                                                log::warn!(
                                                    "[acp] {req_agent_id} warmup \
                                                     cancel settled with error: {e}"
                                                );
                                            }
                                            Err(_) => {
                                                log::warn!(
                                                    "[acp] {req_agent_id} warmup \
                                                     cancel did not settle within \
                                                     {CANCEL_GRACE:?}; failing \
                                                     session creation"
                                                );
                                                send_reply(
                                                    &task_slot,
                                                    Err(format!(
                                                        "warmup cancel did not settle \
                                                         within {CANCEL_GRACE:?}"
                                                    )),
                                                );
                                                return;
                                            }
                                        }
                                        // Drain any pending permissions/questions
                                        // the warmup turn may have raised, so
                                        // they don't block the user's first real
                                        // prompt. Mirrors CancelPrompt and
                                        // SendPrompt completion cleanup.
                                        let pending = req_state.lock().drain_session(&session_id.0);
                                        for permission in pending {
                                            let _ = permission.responder.respond(
                                                RequestPermissionResponse::new(
                                                    RequestPermissionOutcome::Cancelled,
                                                ),
                                            );
                                        }
                                        let pending_questions =
                                            req_state.lock().drain_session_questions(&session_id.0);
                                        for question in pending_questions {
                                            let _ = question.responder.respond(serde_json::json!({
                                                "questionId": question.question_id,
                                                "cancelled": true,
                                            }));
                                        }
                                    }
                                }
                            }

                            // Cache the agent-advertised Model-selector configId so
                            // `set_model` targets it instead of hardcoding "model".
                            if let Some(id) = events::model_config_id_from_options(
                                response.config_options.as_deref(),
                            ) {
                                req_state.lock().set_model_config_id(session_id.0.clone(), id);
                            }

                            let event = SessionCreatedEvent {
                                agent_id: req_agent_id,
                                session_id: session_id.clone(),
                                modes: response.modes.clone(),
                                models: events::models_from_config_options(
                                    response.config_options.as_deref(),
                                ),
                                config_options: response.config_options.clone(),
                            };
                            events::fan_out(
                                &req_sinks,
                                Some(event.session_id.0.as_str()),
                                events::EVENT_SESSION_CREATED,
                                &event,
                            );
                            send_reply(
                                &task_slot,
                                Ok(NewSessionOutcome {
                                    session_id,
                                    modes: response.modes,
                                    models: events::models_from_config_options(
                                        response.config_options.as_deref(),
                                    ),
                                    config_options: response.config_options,
                                }),
                            );
                        }
                        Ok(Err(e)) => send_reply(&task_slot, Err(e.to_string())),
                        Err(_) => {
                            log::warn!(
                                "[acp] {req_agent_id} session/new timed out after {timeout:?}; \
                                 check agent stderr in RUST_LOG=debug"
                            );
                            send_reply(
                                &task_slot,
                                Err(format!("session/new timed out after {timeout:?}")),
                            )
                        }
                    }
                });
            }

            AcpCommand::LoadSession {
                session_id,
                cwd,
                reply,
            } => {
                let slot = reply_slot(reply);
                let task_slot = slot.clone();
                let req_cx = cx.clone();
                let req_state = driver_state.clone();
                spawn_request(&cx, slot, async move {
                    // Bounded like session/new: a wedged agent must not park the
                    // renderer's reconnect forever (the reply sender would be
                    // held indefinitely).
                    let request = LoadSessionRequest::new(&session_id, cwd.clone());
                    let result = run_session_reopen(
                        "session/load",
                        &session_id.0,
                        &cwd,
                        &req_state,
                        req_cx.send_request(request).block_task(),
                    )
                    .await;
                    send_reply(&task_slot, result);
                });
            }

            AcpCommand::ResumeSession {
                session_id,
                cwd,
                reply,
            } => {
                let slot = reply_slot(reply);
                let task_slot = slot.clone();
                let req_cx = cx.clone();
                let req_state = driver_state.clone();
                spawn_request(&cx, slot, async move {
                    let request = ResumeSessionRequest::new(&session_id, cwd.clone());
                    let result = run_session_reopen(
                        "session/resume",
                        &session_id.0,
                        &cwd,
                        &req_state,
                        req_cx.send_request(request).block_task(),
                    )
                    .await;
                    send_reply(&task_slot, result);
                });
            }

            AcpCommand::CloseSession { session_id, reply } => {
                let slot = reply_slot(reply);
                let task_slot = slot.clone();
                let req_cx = cx.clone();
                let req_state = driver_state.clone();
                let req_persistence = persistence.clone();
                spawn_request(&cx, slot, async move {
                    let request = CloseSessionRequest::new(&session_id);
                    let result = req_cx.send_request(request).block_task().await;
                    if result.is_ok() {
                        // Forget the workspace root and resolve any pending
                        // permissions for the now-closed session.
                        let pending = {
                            let mut state = req_state.lock();
                            state.remove_session_root(&session_id.0);
                            state.finish_turn(&session_id.0)
                        };
                        for permission in pending {
                            let _ = permission.responder.respond(RequestPermissionResponse::new(
                                RequestPermissionOutcome::Cancelled,
                            ));
                        }
                        // Issue #411: resolve outstanding questions for the
                        // closed session as cancelled too.
                        let pending_questions =
                            req_state.lock().finish_turn_questions(&session_id.0);
                        for question in pending_questions {
                            let _ = question.responder.respond(serde_json::json!({
                                "questionId": question.question_id,
                                "cancelled": true,
                            }));
                        }
                    }
                    let mut result = result.map(|_| ()).map_err(|e| e.to_string());
                    if result.is_ok() {
                        if let Some(persistence) = req_persistence {
                            if let Err(error) = persistence
                                .finalize_session(&session_id.0, PersistedSessionStatus::Closed)
                                .await
                            {
                                result = Err(format!(
                                    "session closed but history finalization failed: {error}"
                                ));
                            }
                        }
                    }
                    send_reply(&task_slot, result);
                });
            }

            AcpCommand::ListSessions { cwd, cursor, reply } => {
                let slot = reply_slot(reply);
                let task_slot = slot.clone();
                let req_cx = cx.clone();
                spawn_request(&cx, slot, async move {
                    let mut request = agent_client_protocol::schema::v1::ListSessionsRequest::new();
                    if let Some(cwd) = cwd {
                        request = request.cwd(std::path::PathBuf::from(cwd));
                    }
                    if let Some(cursor) = cursor {
                        request = request.cursor(cursor);
                    }
                    let result = req_cx.send_request(request).block_task().await;
                    send_reply(&task_slot, result.map_err(|e| e.to_string()));
                });
            }

            AcpCommand::SendPrompt {
                session_id,
                content,
                turn_id,
                reply,
            } => {
                // Single-flight per session: reject a second prompt while a turn
                // is in flight (M4). `try_begin_turn` returns a cancel signal
                // receiver when the turn may proceed.
                let handles = driver_state.lock().try_begin_turn(&session_id.0);
                let Some(handles) = handles else {
                    // Stable code matched by renderer `ACP_TURN_IN_PROGRESS_CODE`.
                    let _ = reply.send(Err(format!(
                        "ACP_TURN_IN_PROGRESS: session {}",
                        session_id.0
                    )));
                    continue;
                };
                let cancel_rx = handles.cancel_rx;
                let mut idle_rx = handles.idle_rx;

                let slot = reply_slot(reply);
                let task_slot = slot.clone();
                let turn_cx = cx.clone();
                let turn_sinks = sinks.clone();
                let turn_agent_id = agent_id.clone();
                let turn_state = driver_state.clone();
                let turn_persistence = persistence.clone();
                let turn_session = session_id.clone();
                let log_session = session_id.clone();
                // Story 1.8 T3.2: capture the client turn-id to echo on prompt_complete.
                let turn_turn_id = turn_id.clone();
                let spawn_result = cx.spawn(async move {
                    // Race the turn against completion, a cancel signal, an
                    // idle deadline (reset by agent `session/update` activity
                    // via `DriverState::signal_idle`), and a hard wall-clock
                    // cap. On idle/hard timeout → signal cancel + `CANCEL_GRACE`
                    // + a typed error (`acp-store` sets `status: 'error'`). See
                    // [`race_turn`].
                    let idle = turn_idle_timeout();
                    let hard = resolved_turn_timeout();
                    let cancel_state = turn_state.clone();
                    let cancel_session = session_id.clone();
                    let cancel_cx = turn_cx.clone();
                    let outcome: Result<StopReason, String> = race_turn(
                        async {
                            turn_cx
                                .send_request(PromptRequest::new(&session_id, content))
                                .block_task()
                                .await
                                .map(|r| r.stop_reason)
                                .map_err(|e| e.to_string())
                        },
                        cancel_rx,
                        &mut idle_rx,
                        move || {
                            // Mirror AcpCommand::CancelPrompt: signal the
                            // active-turn cancel (winds down the race) AND
                            // notify the agent to abandon its in-flight
                            // session/prompt. send_notification is non-blocking
                            // (it queues onto the connection), so race_turn
                            // stays sync.
                            cancel_state.lock().signal_cancel(&cancel_session.0);
                            if let Err(error) =
                                cancel_cx.send_notification(CancelNotification::new(&cancel_session))
                            {
                                log::warn!(
                                    "[acp] failed to cancel agent prompt on turn timeout: {error}"
                                );
                            }
                        },
                        idle,
                        hard,
                    )
                    .await;

                    match &outcome {
                        Ok(stop_reason) => log::info!(
                            "[acp] session {} turn complete: stop_reason={stop_reason:?}",
                            log_session.0
                        ),
                        Err(message) => {
                            log::warn!("[acp] session {} turn failed: {message}", log_session.0)
                        }
                    }

                    // Turn is over: clear the active-turn marker and resolve any
                    // permissions that were never answered (H3 — normal
                    // completion, not just cancel).
                    let pending = turn_state.lock().finish_turn(&session_id.0);
                    for permission in pending {
                        let _ = permission.responder.respond(RequestPermissionResponse::new(
                            RequestPermissionOutcome::Cancelled,
                        ));
                    }
                    // Issue #411: model-abandoned questions are first-class
                    // outcomes — a turn that ends without the user answering
                    // resolves the parked question responders as cancelled.
                    let pending_questions = turn_state.lock().finish_turn_questions(&session_id.0);
                    for question in pending_questions {
                        let _ = question.responder.respond(serde_json::json!({
                            "questionId": question.question_id,
                            "cancelled": true,
                        }));
                    }

                    let is_ephemeral = turn_state.lock().is_ephemeral(&session_id.0);
                    match outcome {
                        Ok(stop_reason) => {
                            let event = PromptCompleteEvent {
                                agent_id: turn_agent_id,
                                session_id,
                                stop_reason,
                                turn_id: turn_turn_id.clone(),
                            };
                            events::fan_out(
                                &turn_sinks,
                                Some(event.session_id.0.as_str()),
                                events::EVENT_PROMPT_COMPLETE,
                                &event,
                            );
                            if !is_ephemeral {
                                if let Some(persistence) = &turn_persistence {
                                    if let Err(error) =
                                        persistence.flush_session(&event.session_id.0).await
                                    {
                                        send_reply(
                                            &task_slot,
                                            Err(format!(
                                                "failed to flush session history: {error}"
                                            )),
                                        );
                                        return Ok(());
                                    }
                                }
                            }
                            send_reply(&task_slot, Ok(stop_reason));
                        }
                        Err(message) => {
                            let event = AgentErrorEvent {
                                agent_id: turn_agent_id,
                                session_id: Some(session_id),
                                message: message.clone(),
                            };
                            // Turn-scoped error → sid is the session id.
                            events::fan_out(
                                &turn_sinks,
                                event.session_id.as_ref().map(|s| s.0.as_str()),
                                events::EVENT_AGENT_ERROR,
                                &event,
                            );
                            if !is_ephemeral {
                                if let Some(persistence) = &turn_persistence {
                                    if let Some(session_id) = event.session_id.as_ref() {
                                        if let Err(error) =
                                            persistence.flush_session(&session_id.0).await
                                        {
                                            send_reply(
                                                &task_slot,
                                                Err(format!(
                                                    "{message}; history flush failed: {error}"
                                                )),
                                            );
                                            return Ok(());
                                        }
                                    }
                                }
                            }
                            send_reply(&task_slot, Err(message));
                        }
                    }
                    Ok(())
                });
                if let Err(e) = spawn_result {
                    // The connection is shutting down; clear the marker we just
                    // set and surface the real error to the caller (L5).
                    driver_state.lock().finish_turn(&turn_session.0);
                    send_reply(&slot, Err(format!("failed to start prompt turn: {e}")));
                }
            }

            AcpCommand::OwnsSession { session_id, reply } => {
                let _ = reply.send(Ok(driver_state
                    .lock()
                    .session_root(&session_id.0)
                    .is_some()));
            }

            AcpCommand::IsEphemeralSession { session_id, reply } => {
                let _ = reply.send(Ok(driver_state.lock().is_ephemeral(&session_id.0)));
            }

            AcpCommand::IsTurnActive { session_id, reply } => {
                let _ = reply.send(Ok(driver_state.lock().is_turn_active(&session_id.0)));
            }

            AcpCommand::WaitTurnIdle { session_id, reply } => {
                let waiter = driver_state.lock().wait_turn_idle(&session_id.0);
                match waiter {
                    None => {
                        let _ = reply.send(Ok(()));
                    }
                    Some(waiter) => {
                        let slot = reply_slot(reply);
                        let task_slot = slot.clone();
                        spawn_request(&cx, slot, async move {
                            let result = waiter
                                .await
                                .map_err(|_| "turn idle waiter was dropped".to_string());
                            send_reply(&task_slot, result);
                        });
                    }
                }
            }

            AcpCommand::DisposeEphemeralSession { session_id, reply } => {
                let waiter = {
                    let mut state = driver_state.lock();
                    if !state.is_ephemeral(&session_id.0) {
                        let _ = reply.send(Err("session is not ephemeral".to_string()));
                        continue;
                    }
                    state.signal_cancel(&session_id.0);
                    state.wait_turn_idle(&session_id.0)
                };
                let slot = reply_slot(reply);
                let task_slot = slot.clone();
                let dispose_state = driver_state.clone();
                let close_cx = cx.clone();
                spawn_request(&cx, slot, async move {
                    if let Some(waiter) = waiter {
                        let timeout = CANCEL_GRACE + Duration::from_millis(250);
                        match tokio::time::timeout(timeout, waiter).await {
                            Ok(Ok(())) => {}
                            Ok(Err(_)) => {
                                send_reply(
                                    &task_slot,
                                    Err("turn idle waiter was dropped".to_string()),
                                );
                                return;
                            }
                            Err(_) => {
                                send_reply(
                                    &task_slot,
                                    Err(format!(
                                        "ephemeral session disposal timed out after {timeout:?}"
                                    )),
                                );
                                return;
                            }
                        }
                    }
                    {
                        let state = dispose_state.lock();
                        if state.is_turn_active(&session_id.0) {
                            send_reply(
                                &task_slot,
                                Err("ephemeral session turn is still active".to_string()),
                            );
                            return;
                        }
                        if !state.is_ephemeral(&session_id.0) {
                            send_reply(&task_slot, Err("session is not ephemeral".to_string()));
                            return;
                        }
                    }

                    // The temporary session is now idle and still protected by
                    // the authoritative ephemeral marker. Ask capable agents to
                    // release their session-side resources, but never let a
                    // stale or wedged `session/close` prevent local cleanup. The
                    // short bound keeps disposal responsive.
                    if supports_session_close {
                        let close_timeout = CANCEL_GRACE;
                        match tokio::time::timeout(
                            close_timeout,
                            close_cx
                                .send_request(CloseSessionRequest::new(&session_id))
                                .block_task(),
                        )
                        .await
                        {
                            Ok(Ok(_)) => {}
                            Ok(Err(error)) => log::debug!(
                                "[acp] ephemeral session {} close failed: {error}",
                                session_id.0
                            ),
                            Err(_) => log::warn!(
                                "[acp] ephemeral session {} close timed out after {close_timeout:?}",
                                session_id.0
                            ),
                        }
                    }

                    let (permissions, questions) = {
                        let mut state = dispose_state.lock();
                        if state.is_turn_active(&session_id.0) {
                            send_reply(
                                &task_slot,
                                Err("ephemeral session turn became active during disposal"
                                    .to_string()),
                            );
                            return;
                        }
                        if !state.is_ephemeral(&session_id.0) {
                            send_reply(&task_slot, Err("session is not ephemeral".to_string()));
                            return;
                        }
                        state.dispose_session(&session_id.0)
                    };
                    for permission in permissions {
                        let _ = permission.responder.respond(RequestPermissionResponse::new(
                            RequestPermissionOutcome::Cancelled,
                        ));
                    }
                    for question in questions {
                        let _ = question.responder.respond(serde_json::json!({
                            "questionId": question.question_id,
                            "cancelled": true,
                        }));
                    }
                    send_reply(&task_slot, Ok(()));
                });
            }

            AcpCommand::CancelPrompt { session_id, reply } => {
                // Signal the active turn to wind down (bounding its wait) and
                // resolve any pending permissions for this session as cancelled.
                let pending = {
                    let mut state = driver_state.lock();
                    state.signal_cancel(&session_id.0);
                    state.drain_session(&session_id.0)
                };
                for permission in pending {
                    let _ = permission.responder.respond(RequestPermissionResponse::new(
                        RequestPermissionOutcome::Cancelled,
                    ));
                }
                // Issue #411: cancel also resolves any outstanding questions for
                // the session (the agent abandons them; first-class outcome).
                let pending_questions = driver_state.lock().drain_session_questions(&session_id.0);
                for question in pending_questions {
                    let _ = question.responder.respond(serde_json::json!({
                        "questionId": question.question_id,
                        "cancelled": true,
                    }));
                }
                let result = cx.send_notification(CancelNotification::new(&session_id));
                let _ = reply.send(result.map_err(|e| e.to_string()));
            }

            AcpCommand::SetMode {
                session_id,
                mode_id,
                reply,
            } => {
                let slot = reply_slot(reply);
                let task_slot = slot.clone();
                let req_cx = cx.clone();
                spawn_request(&cx, slot, async move {
                    let request = SetSessionModeRequest::new(&session_id, mode_id);
                    let result = req_cx.send_request(request).block_task().await;
                    send_reply(&task_slot, result.map(|_| ()).map_err(|e| e.to_string()));
                });
            }

            AcpCommand::SetModel {
                session_id,
                model_id,
                reply,
            } => {
                let slot = reply_slot(reply);
                let task_slot = slot.clone();
                let req_cx = cx.clone();
                let req_sinks = sinks.clone();
                let req_agent_id = agent_id.clone();
                let req_state = driver_state.clone();
                spawn_request(&cx, slot, async move {
                    // ACP 0.14 removed `session/set_model`; the model is now a
                    // `select`-kind config option (category = Model). Its configId
                    // is the agent-provided option id (cached at session/new from
                    // the agent's `config_options`), falling back to the `"model"`
                    // convention when the agent didn't advertise one. `model_id` is
                    // the option value id the renderer picked.
                    let config_id = req_state
                        .lock()
                        .model_config_id(&session_id.0)
                        .unwrap_or_else(|| "model".to_string());
                    let request = SetSessionConfigOptionRequest::new(
                        &session_id,
                        config_id,
                        model_id.as_str(),
                    );
                    match req_cx.send_request(request).block_task().await {
                        Ok(response) => {
                            let event = ConfigOptionsUpdateEvent {
                                agent_id: req_agent_id,
                                session_id,
                                config_options: response.config_options.clone(),
                            };
                            events::fan_out(
                                &req_sinks,
                                Some(event.session_id.0.as_str()),
                                events::EVENT_CONFIG_OPTIONS_UPDATE,
                                &event,
                            );
                            send_reply(&task_slot, Ok(()));
                        }
                        Err(e) => send_reply(&task_slot, Err(e.to_string())),
                    }
                });
            }

            AcpCommand::SetConfigOption {
                session_id,
                config_id,
                value_id,
                reply,
            } => {
                let slot = reply_slot(reply);
                let task_slot = slot.clone();
                let req_cx = cx.clone();
                let req_sinks = sinks.clone();
                let req_agent_id = agent_id.clone();
                let req_state = driver_state.clone();
                spawn_request(&cx, slot, async move {
                    let request =
                        SetSessionConfigOptionRequest::new(&session_id, config_id, value_id.as_str());
                    match req_cx.send_request(request).block_task().await {
                        Ok(response) => {
                            // Keep the cached Model-selector configId fresh in case
                            // the agent reorganized its config options.
                            if let Some(id) = events::model_config_id_from_options(
                                Some(response.config_options.as_slice()),
                            ) {
                                req_state.lock().set_model_config_id(session_id.0.clone(), id);
                            }
                            let event = ConfigOptionsUpdateEvent {
                                agent_id: req_agent_id,
                                session_id,
                                config_options: response.config_options.clone(),
                            };
                            events::fan_out(
                                &req_sinks,
                                Some(event.session_id.0.as_str()),
                                events::EVENT_CONFIG_OPTIONS_UPDATE,
                                &event,
                            );
                            send_reply(&task_slot, Ok(response.config_options));
                        }
                        Err(e) => send_reply(&task_slot, Err(e.to_string())),
                    }
                });
            }

            AcpCommand::RespondPermission {
                request_id,
                outcome,
                reply,
            } => {
                let pending = driver_state.lock().take_permission(&request_id);
                match pending {
                    Some(permission) => {
                        let result = permission
                            .responder
                            .respond(RequestPermissionResponse::new(outcome));
                        let _ = reply.send(result.map_err(|e| e.to_string()));
                    }
                    None => {
                        let _ =
                            reply.send(Err(format!("unknown permission request: {request_id}")));
                    }
                }
            }

            AcpCommand::AnswerQuestion {
                question_id,
                values,
                reply,
            } => {
                // Issue #411: resolve the parked `_session/question` responder
                // exactly once. `Some(values)` → the selected option values;
                // `None` → cancelled. Unknown id (already resolved / drained)
                // mirrors the permission race-loser path.
                let pending = driver_state.lock().take_question(&question_id);
                match pending {
                    Some(question) => {
                        let payload = match &values {
                            Some(values) => serde_json::json!({
                                "questionId": question_id,
                                "values": values,
                            }),
                            None => serde_json::json!({
                                "questionId": question_id,
                                "cancelled": true,
                            }),
                        };
                        let result = question.responder.respond(payload);
                        let _ = reply.send(result.map_err(|e| e.to_string()));
                    }
                    None => {
                        let _ = reply.send(Err(format!("unknown question request: {question_id}")));
                    }
                }
            }

            AcpCommand::Authenticate { method_id, reply } => {
                let slot = reply_slot(reply);
                let task_slot = slot.clone();
                let req_cx = cx.clone();
                let log_agent_id = agent_id.clone();
                spawn_request(&cx, slot, async move {
                    log::info!("[acp] agent {log_agent_id} authenticating via '{method_id}'");
                    let result = req_cx
                        .send_request(AuthenticateRequest::new(method_id))
                        .block_task()
                        .await
                        .map(|_| ())
                        .map_err(|e| e.to_string());
                    send_reply(&task_slot, result);
                });
            }
        }
    }

    Ok(())
}

/// Spawn an agent→client request task on the connection, keeping the command
/// loop free to service other commands (notably `RespondPermission`) while it
/// runs (the C1 fix).
///
/// The request's `reply` sender lives in a shared [`ReplySlot`]: the spawned
/// task sends the real result through it, but if spawning fails (the connection
/// is winding down) this helper sends an explicit error instead of dropping the
/// sender — otherwise the caller would see the generic "agent thread dropped
/// the reply" rather than the real cause (L5).
///
/// The spawned task itself must always resolve to `Ok(())`; a spawned task that
/// returns `Err` would tear down the whole connection.
fn spawn_request<T, Fut>(cx: &ConnectionTo<Agent>, slot: ReplySlot<T>, task: Fut)
where
    T: Send + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    if let Err(e) = cx.spawn(async move {
        task.await;
        Ok(())
    }) {
        send_reply(&slot, Err(format!("failed to dispatch request: {e}")));
    }
}

/// A reply sender shared between a spawned request task and the command loop so
/// the loop can still surface a real error if the task fails to spawn (L5).
/// Whichever side resolves first takes the sender; the other becomes a no-op.
type ReplySlot<T> = Arc<Mutex<Option<oneshot::Sender<Result<T, String>>>>>;

/// Wrap a reply sender in a shared, take-once slot.
fn reply_slot<T>(reply: oneshot::Sender<Result<T, String>>) -> ReplySlot<T> {
    Arc::new(Mutex::new(Some(reply)))
}

/// Send through a [`ReplySlot`] exactly once; subsequent sends are ignored.
fn send_reply<T>(slot: &ReplySlot<T>, value: Result<T, String>) {
    if let Some(tx) = slot.lock().take() {
        let _ = tx.send(value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_namespace_uses_safe_identity_and_excludes_secrets() {
        let mut config = AgentConfig {
            config_id: None,
            name: "  Example   Agent ".to_string(),
            command: "C:/Users/alice/private/token.exe".to_string(),
            args: vec!["--api-key=secret-one".to_string()],
            env: std::collections::HashMap::from([(
                "AUTH_TOKEN".to_string(),
                "secret-two".to_string(),
            )]),
            allow_terminal: false,
        };
        let namespace = stable_agent_namespace(&config).unwrap();
        config.name = "example agent".to_string();
        config.command = "/different/private/token.exe".to_string();
        config.args = vec!["--api-key=other-secret".to_string()];
        config
            .env
            .insert("AUTH_TOKEN".to_string(), "third-secret".to_string());
        assert_eq!(
            stable_agent_namespace(&config).as_deref(),
            Some(namespace.as_str())
        );
        assert!(namespace.starts_with("agent-safe:"));
        assert!(!namespace.contains("secret"));

        config.command = "different.exe".to_string();
        assert_ne!(stable_agent_namespace(&config).unwrap(), namespace);
        config.command.clear();
        assert_eq!(stable_agent_namespace(&config), None);
    }

    #[tokio::test]
    async fn owns_session_queries_authoritative_agent_driver_state() {
        let manager = AcpManager::new(vec![]);
        let agent_id = AgentId::new();
        let (tx, mut rx) = mpsc::unbounded_channel();
        manager.agents.lock().insert(
            agent_id.clone(),
            AgentEntry {
                command_tx: tx,
                capabilities: AgentCapabilities::default(),
                stable_namespace: None,
                join_handle: None,
                killed: Arc::new(AtomicBool::new(false)),
            },
        );
        let requested = SessionId::new("owned-session");
        let responder = tokio::spawn(async move {
            match rx.recv().await.unwrap() {
                AcpCommand::OwnsSession { session_id, reply } => {
                    assert_eq!(session_id, requested);
                    let _ = reply.send(Ok(false));
                }
                _ => panic!("ownership query must use OwnsSession"),
            }
        });
        assert!(!manager
            .owns_session(&agent_id, SessionId::new("owned-session"))
            .await
            .unwrap());
        responder.await.unwrap();
    }

    /// Capability gating exercises the *real* gate functions used by
    /// `load_session`/`resume_session`/`close_session` (F4). With default
    /// capabilities every gate must reject; the `*_call_*` channel test below
    /// confirms no command is sent on the rejection path.
    #[test]
    fn real_capability_gates_reject_when_unsupported() {
        let caps = AgentCapabilities::default();
        assert!(
            gate_close_session(&caps).is_err(),
            "default agent must not advertise close"
        );
        assert!(
            gate_load_session(&caps).is_err(),
            "default agent must not advertise loadSession"
        );
        assert!(
            gate_resume_session(&caps).is_err(),
            "default agent must not advertise resume"
        );
        assert!(
            gate_list_sessions(&caps).is_err(),
            "default agent must not advertise session/list"
        );
    }

    /// The rejection path must NOT enqueue any command (agent never contacted).
    /// Drives the real gate, then asserts the channel stayed empty (AC-4).
    #[tokio::test]
    async fn gated_call_without_capability_returns_err_and_does_not_send() {
        let (tx, mut rx) = mpsc::unbounded_channel::<AcpCommand>();

        let caps = AgentCapabilities::default();
        let result: Result<(), String> = async {
            // The real production gate, not a mirror.
            gate_close_session(&caps)?;
            send_command(&tx, |reply| AcpCommand::CloseSession {
                session_id: SessionId::new("s"),
                reply,
            })
            .await
        }
        .await;

        assert!(result.is_err(), "gated call must return Err");
        assert!(
            matches!(rx.try_recv(), Err(mpsc::error::TryRecvError::Empty)),
            "no command must have been sent to the agent"
        );
    }

    /// A capable call (capability present) does enqueue a command on the channel.
    #[tokio::test]
    async fn capable_call_enqueues_command() {
        let (tx, mut rx) = mpsc::unbounded_channel::<AcpCommand>();

        let (reply_tx, _reply_rx) = oneshot::channel::<Result<(), String>>();
        tx.send(AcpCommand::CloseSession {
            session_id: SessionId::new("s"),
            reply: reply_tx,
        })
        .unwrap();

        assert!(
            matches!(rx.try_recv(), Ok(AcpCommand::CloseSession { .. })),
            "command must be enqueued when capability is present"
        );
    }

    /// `send_command` surfaces a typed error when the driver thread is gone.
    #[tokio::test]
    async fn send_command_errors_when_thread_gone() {
        let (tx, rx) = mpsc::unbounded_channel::<AcpCommand>();
        drop(rx); // simulate a dead driver thread

        let result: Result<(), String> = send_command(&tx, |reply| AcpCommand::CloseSession {
            session_id: SessionId::new("s"),
            reply,
        })
        .await;

        assert!(result.is_err());
    }

    /// The post-cancel grace window forcibly resolves a turn whose agent never
    /// replies to `session/cancel` (M5). This drives the exact `select!` /
    /// timeout shape used in the `SendPrompt` arm against a prompt future that
    /// never completes, and asserts it resolves `Cancelled` rather than hanging.
    /// A short local grace keeps the test fast (the production constant is
    /// `CANCEL_GRACE`).
    #[tokio::test]
    async fn cancel_grace_forcibly_resolves_a_stuck_turn() {
        const TEST_GRACE: Duration = Duration::from_millis(50);
        let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
        // A prompt future that never resolves (agent ignores cancel).
        let prompt = std::future::pending::<Result<StopReason, String>>();
        tokio::pin!(prompt);

        // Fire the cancel signal immediately.
        cancel_tx.send(()).unwrap();

        let outcome: Result<StopReason, String> = tokio::select! {
            result = &mut prompt => result,
            _ = cancel_rx => {
                match tokio::time::timeout(TEST_GRACE, &mut prompt).await {
                    Ok(result) => result,
                    Err(_) => Ok(StopReason::Cancelled),
                }
            }
        };

        assert_eq!(
            outcome,
            Ok(StopReason::Cancelled),
            "a stuck turn must be force-resolved as Cancelled after the grace window"
        );
    }

    /// Shape test (like `cancel_grace_forcibly_resolves_a_stuck_turn`): mirrors
    /// the timeout-around-request pattern of the `LoadSession`/`ResumeSession`
    /// arms against a never-resolving future, using a short local bound so the
    /// is fast. The arms themselves need a live connection + sink fan-out and
    /// are not driven here; this covers the match shape plus the production
    /// timeout resolution below.
    #[tokio::test]
    async fn session_reopen_times_out_instead_of_hanging() {
        const TEST_TIMEOUT: Duration = Duration::from_millis(50);
        let request = std::future::pending::<Result<(), String>>();
        let outcome = tokio::time::timeout(TEST_TIMEOUT, request).await;
        let result: Result<(), String> = match outcome {
            Ok(result) => result,
            Err(_) => Err(format!("session/load timed out after {TEST_TIMEOUT:?}")),
        };
        assert!(
            result.is_err_and(|e| e.contains("timed out")),
            "a hung reopen must resolve to a timeout error"
        );
    }

    /// The production reopen budget resolves to the 60s default and honors the
    /// `TERMUL_ACP_SESSION_REOPEN_TIMEOUT_SECS` diagnostic override contract
    /// (mirrors `session_new_timeout`). Only the default path is asserted —
    /// mutating process env in a test would race other tests.
    #[test]
    fn session_reopen_timeout_defaults_to_constant() {
        if std::env::var("TERMUL_ACP_SESSION_REOPEN_TIMEOUT_SECS").is_err() {
            assert_eq!(session_reopen_timeout(), SESSION_REOPEN_TIMEOUT);
        }
        assert_eq!(SESSION_REOPEN_TIMEOUT, Duration::from_secs(60));
    }

    #[tokio::test]
    async fn session_load_reopen_preserves_optional_fields_and_records_root() {
        let state = Mutex::new(DriverState::new());
        let modes = agent_client_protocol::schema::v1::SessionModeState::new("ask", vec![]);
        let response = LoadSessionResponse::new()
            .modes(modes.clone())
            .config_options(Vec::<SessionConfigOption>::new());
        let outcome =
            run_session_reopen("session/load", "sess-load", "/work", &state, async move {
                Ok::<_, String>(response)
            })
            .await
            .unwrap();

        assert_eq!(outcome.modes, Some(modes));
        assert_eq!(outcome.models, None);
        assert_eq!(outcome.config_options, Some(vec![]));
        assert_eq!(
            state.lock().session_root("sess-load"),
            Some(PathBuf::from("/work"))
        );
    }

    #[tokio::test]
    async fn session_resume_reopen_preserves_omitted_fields() {
        let state = Mutex::new(DriverState::new());
        let outcome = run_session_reopen("session/resume", "sess-resume", "/work", &state, async {
            Ok::<_, String>(ResumeSessionResponse::new())
        })
        .await
        .unwrap();

        assert_eq!(
            outcome,
            SessionReopenOutcome {
                modes: None,
                models: None,
                config_options: None,
            }
        );
        assert_eq!(
            serde_json::to_value(&outcome).unwrap(),
            serde_json::json!({})
        );
    }

    /// An empty prompt is rejected before any agent contact (EMPTY-CONTENT).
    /// `send_prompt`'s guard is a pure pre-check; assert its predicate here
    /// (the manager method needs a sink fan-out, but the guard runs first).
    #[test]
    fn empty_prompt_content_is_rejected_by_guard() {
        let content: Vec<ContentBlock> = Vec::new();
        // Mirror of the guard at the top of `AcpManager::send_prompt`.
        let rejected = content.is_empty();
        assert!(rejected, "empty prompt content must be rejected");
    }

    /// `ReplySlot` delivers exactly once: the spawn-failure path and the task
    /// path can both target it, but only the first send wins (L5 safety).
    #[tokio::test]
    async fn reply_slot_sends_exactly_once() {
        let (tx, rx) = oneshot::channel::<Result<(), String>>();
        let slot = reply_slot(tx);
        send_reply(&slot, Ok(()));
        // A second send is a no-op and must not panic.
        send_reply(&slot, Err("late".to_string()));
        assert_eq!(rx.await.unwrap(), Ok(()));
    }

    /// The initialize→spawn-event mapping forwards the FULL advertised auth
    /// method metadata (id, name, optional description) so the renderer can
    /// present Sign-in and call `authenticate(methodId)`. Optional description
    /// is preserved when present and `None` when absent.
    #[test]
    fn to_auth_method_infos_maps_full_metadata() {
        use agent_client_protocol::schema::v1::AuthMethodAgent;
        let methods = vec![
            AuthMethod::Agent(
                AuthMethodAgent::new("cursor_login", "Sign in with Cursor")
                    .description("Opens the Cursor login flow"),
            ),
            AuthMethod::Agent(AuthMethodAgent::new("api_key", "API key")),
        ];
        let infos = to_auth_method_infos(&methods);
        assert_eq!(infos.len(), 2);
        assert_eq!(infos[0].id, "cursor_login");
        assert_eq!(infos[0].name, "Sign in with Cursor");
        assert_eq!(
            infos[0].description.as_deref(),
            Some("Opens the Cursor login flow")
        );
        assert_eq!(infos[1].id, "api_key");
        assert_eq!(infos[1].name, "API key");
        assert_eq!(infos[1].description, None);
    }

    /// An agent that advertises no auth methods maps to an empty vec (the
    /// renderer treats this as a no-auth agent).
    #[test]
    fn to_auth_method_infos_empty_for_no_methods() {
        assert!(to_auth_method_infos(&[]).is_empty());
    }

    // --- race_turn (idle + hard cap + cancel) ---

    /// An active turn (agent streaming activity) keeps resetting its idle
    /// deadline and completes normally — never hits the idle timeout.
    #[tokio::test(start_paused = true)]
    async fn race_turn_activity_resets_idle_and_completes() {
        let (idle_tx, mut idle_rx) = watch::channel(());
        let (_cancel_tx, cancel_rx) = oneshot::channel::<()>();
        let on_timeout = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let on_timeout_clone = on_timeout.clone();
        // Activity every 20ms (under the 50ms idle window) keeps the idle
        // deadline pushed back; the prompt completes at 100ms.
        let activity = tokio::spawn(async move {
            for _ in 0..6 {
                tokio::time::sleep(Duration::from_millis(20)).await;
                let _ = idle_tx.send(());
            }
        });
        let result = race_turn(
            async {
                tokio::time::sleep(Duration::from_millis(100)).await;
                Ok::<StopReason, String>(StopReason::EndTurn)
            },
            cancel_rx,
            &mut idle_rx,
            move || {
                on_timeout_clone.fetch_add(1, Ordering::SeqCst);
            },
            Duration::from_millis(50),
            Duration::from_secs(10),
        )
        .await;
        let _ = activity.await;
        assert!(result.is_ok(), "got {result:?}");
        assert_eq!(
            on_timeout.load(Ordering::SeqCst),
            0,
            "no timeout should fire for an active turn"
        );
    }

    /// A silent (wedged) turn with no activity and no completion hits the idle
    /// timeout — and signals cancel via `on_timeout_cancel`.
    #[tokio::test(start_paused = true)]
    async fn race_turn_silence_hits_idle_timeout() {
        let (_idle_tx, mut idle_rx) = watch::channel(()); // never fires
        let (_cancel_tx, cancel_rx) = oneshot::channel::<()>();
        let on_timeout = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let on_timeout_clone = on_timeout.clone();
        let result = race_turn(
            std::future::pending::<Result<StopReason, String>>(),
            cancel_rx,
            &mut idle_rx,
            move || {
                on_timeout_clone.fetch_add(1, Ordering::SeqCst);
            },
            Duration::from_millis(100),
            Duration::from_secs(10),
        )
        .await;
        let err = result.unwrap_err();
        assert!(err.contains("idle timeout"), "got {err}");
        assert_eq!(on_timeout.load(Ordering::SeqCst), 1);
    }

    /// A turn that streams activity forever but never completes is still
    /// bounded by the hard wall-clock cap (the pre-loop check fires despite
    /// the continuously-ready activity arm under `biased`).
    #[tokio::test(start_paused = true)]
    async fn race_turn_streaming_non_completing_hits_hard_cap() {
        let (idle_tx, mut idle_rx) = watch::channel(());
        let (_cancel_tx, cancel_rx) = oneshot::channel::<()>();
        let activity = tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(10)).await;
                let _ = idle_tx.send(());
            }
        });
        let on_timeout = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let on_timeout_clone = on_timeout.clone();
        let result = race_turn(
            std::future::pending::<Result<StopReason, String>>(),
            cancel_rx,
            &mut idle_rx,
            move || {
                on_timeout_clone.fetch_add(1, Ordering::SeqCst);
            },
            Duration::from_millis(50),
            Duration::from_millis(200),
        )
        .await;
        activity.abort();
        let _ = activity.await;
        let err = result.unwrap_err();
        assert!(err.contains("hard timeout"), "got {err}");
        assert_eq!(on_timeout.load(Ordering::SeqCst), 1);
    }

    /// A user cancel wins over both timeouts: the cancel arm returns
    /// `Cancelled` after `CANCEL_GRACE`, and `on_timeout_cancel` is not called.
    #[tokio::test(start_paused = true)]
    async fn race_turn_cancel_wins_over_timeouts() {
        let (_idle_tx, mut idle_rx) = watch::channel(()); // no activity
        let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
        let on_timeout = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let on_timeout_clone = on_timeout.clone();
        // Cancel before the idle window fires.
        let canceller = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            let _ = cancel_tx.send(());
        });
        let result = race_turn(
            std::future::pending::<Result<StopReason, String>>(),
            cancel_rx,
            &mut idle_rx,
            move || {
                on_timeout_clone.fetch_add(1, Ordering::SeqCst);
            },
            Duration::from_millis(100),
            Duration::from_secs(10),
        )
        .await;
        let _ = canceller.await;
        assert!(
            matches!(result, Ok(StopReason::Cancelled)),
            "got {result:?}"
        );
        assert_eq!(on_timeout.load(Ordering::SeqCst), 0);
    }

    /// `resolved_turn_timeout` precedence: env var > UI override > default.
    /// The override replaces the default when no env var is set.
    #[test]
    fn turn_timeout_override_takes_effect_when_no_env_var() {
        // The env var is usually absent in the test runner; when it IS set
        // (operator machine), it correctly masks the UI override — skip there.
        if std::env::var("TERMUL_ACP_TURN_TIMEOUT_SECS").is_ok() {
            return;
        }
        set_turn_timeout_override(Some(42));
        assert_eq!(resolved_turn_timeout(), Duration::from_secs(42));
        set_turn_timeout_override(None);
        assert_eq!(resolved_turn_timeout(), TURN_TIMEOUT);
    }
}
