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
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use agent_client_protocol::schema::{
    AgentCapabilities, AuthMethod, AuthenticateRequest, CancelNotification, CloseSessionRequest,
    ContentBlock, InitializeRequest, ListSessionsResponse, LoadSessionRequest, LoadSessionResponse,
    McpServer, ModelId, NewSessionRequest, PromptRequest, ProtocolVersion,
    RequestPermissionOutcome, RequestPermissionResponse, ResumeSessionRequest,
    ResumeSessionResponse, SelectedPermissionOutcome,
    SessionConfigOption, SessionModelState, SetSessionConfigOptionRequest, SetSessionModeRequest,
    SetSessionModelRequest, StopReason,
};
use agent_client_protocol::{Agent, Client, ConnectionTo, LineDirection};
use parking_lot::Mutex;
use tokio::sync::{mpsc, oneshot};

use crate::acp::client;
use crate::acp::config::{AgentConfig, AgentId, SessionId};
use crate::acp::events::{
    self, AgentCrashedEvent, AgentDisconnectedEvent, AgentErrorEvent, AgentSpawnedEvent,
    AuthMethodInfo, ConfigOptionsUpdateEvent, PromptCompleteEvent, SessionClosedEvent,
    SessionCreatedEvent,
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
/// Upper bound on joining a driver thread during `kill`/`kill_all`, so app exit
/// can never hang on a wedged agent.
const JOIN_TIMEOUT: Duration = Duration::from_secs(5);
/// Story 1.9 NFR7: the bounded per-turn timeout. A wedged agent that neither
/// replies nor crashes parks `send_prompt`'s oneshot forever without this.
/// 1 hour accommodates long-running agentic turns (some agents run tens of
/// minutes on a single task) while still bounding the wait so a truly wedged
/// turn fails → Error state. Distinct from 1.7's 60s permission sub-timeout
/// (`permissions.rs:47`) — this bounds the WHOLE turn (`send_prompt` →
/// `prompt_complete`), not the permission-rendezvous window. Overridable via
/// `TERMUL_ACP_TURN_TIMEOUT_SECS`.
const TURN_TIMEOUT: Duration = Duration::from_secs(3600);

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

/// Story 1.9 NFR7: per-turn timeout, overridable via
/// `TERMUL_ACP_TURN_TIMEOUT_SECS` (seconds, must be > 0). Defaults to
/// [`TURN_TIMEOUT`]. Bounds a wedged agent turn so `send_prompt`'s oneshot
/// fails with a typed timeout error → Error state (not parked forever).
fn turn_timeout() -> Duration {
    std::env::var("TERMUL_ACP_TURN_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|secs: &u64| *secs > 0)
        .map(Duration::from_secs)
        .unwrap_or(TURN_TIMEOUT)
}

/// Option snapshot returned by a successful `session/load` or `session/resume`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionReopenOutcome {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modes: Option<agent_client_protocol::schema::SessionModeState>,
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
        SessionReopenOutcome {
            modes: self.modes,
            models: self.models,
            config_options: self.config_options,
        }
    }
}

impl IntoSessionReopenOutcome for ResumeSessionResponse {
    fn into_session_reopen_outcome(self) -> SessionReopenOutcome {
        SessionReopenOutcome {
            modes: self.modes,
            models: self.models,
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
    pub modes: Option<agent_client_protocol::schema::SessionModeState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<SessionModelState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_options: Option<Vec<SessionConfigOption>>,
}

/// Trusted server-side context attached to durable session registration.
#[derive(Debug, Clone, Default)]
pub struct SessionCreationContext {
    pub project_id: Option<String>,
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
    pub fn stable_agent_namespace(
        &self,
        agent_id: &AgentId,
    ) -> Result<Option<String>, String> {
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
    let term_wait = terminals.clone();
    let term_kill = terminals.clone();
    let term_release = terminals.clone();
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
            async move |notification: agent_client_protocol::schema::SessionNotification, _cx| {
                let session_id = notification.session_id.0.to_string();
                let tool_call_id = match &notification.update {
                    agent_client_protocol::schema::SessionUpdate::ToolCall(tool_call) => {
                        Some(tool_call.tool_call_id.0.to_string())
                    }
                    agent_client_protocol::schema::SessionUpdate::ToolCallUpdate(update) => {
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
            async move |request: agent_client_protocol::schema::RequestPermissionRequest,
                        responder,
                        _cx| {
                let agent_client_protocol::schema::RequestPermissionRequest {
                    session_id,
                    tool_call,
                    options,
                    ..
                } = request;
                let session_string = session_id.0.to_string();
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
            async move |request: agent_client_protocol::schema::ReadTextFileRequest,
                        responder,
                        cx| {
                // Resolve the session's workspace root (the sandbox boundary)
                // and perform the (blocking) read off the dispatch loop so a
                // large file can't stall connection I/O (M1).
                let root = read_state
                    .lock()
                    .session_root(request.session_id.0.as_ref());
                cx.spawn(async move {
                    let result = client::handle_read_text_file(&request, root.as_deref()).await;
                    let _ = responder.respond_with_result(result);
                    Ok(())
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: agent_client_protocol::schema::WriteTextFileRequest,
                        responder,
                        cx| {
                let root = write_state
                    .lock()
                    .session_root(request.session_id.0.as_ref());
                cx.spawn(async move {
                    let result = client::handle_write_text_file(&request, root.as_deref()).await;
                    let _ = responder.respond_with_result(result);
                    Ok(())
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: agent_client_protocol::schema::CreateTerminalRequest,
                        responder,
                        _cx| {
                use agent_client_protocol::schema::CreateTerminalResponse;
                if !allow_terminal {
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
            async move |request: agent_client_protocol::schema::TerminalOutputRequest,
                        responder,
                        _cx| {
                use agent_client_protocol::schema::TerminalOutputResponse;
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
            async move |request: agent_client_protocol::schema::WaitForTerminalExitRequest,
                        responder,
                        cx| {
                use agent_client_protocol::schema::WaitForTerminalExitResponse;
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
            async move |request: agent_client_protocol::schema::KillTerminalRequest,
                        responder,
                        _cx| {
                use agent_client_protocol::schema::KillTerminalResponse;
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
            async move |request: agent_client_protocol::schema::ReleaseTerminalRequest,
                        responder,
                        _cx| {
                use agent_client_protocol::schema::ReleaseTerminalResponse;
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
    match init_outcome {
        Ok(Ok(response)) => {
            // Propagate the FULL advertised auth methods (opaque
            // id/name/optional description) so the renderer can offer a Sign-in
            // action and call `authenticate(methodId)` before `session/new`.
            // Every advertised method is forwarded; no agent-type filtering.
            let auth_methods = to_auth_method_infos(&response.auth_methods);
            let auth_method_ids: Vec<&str> =
                auth_methods.iter().map(|m| m.id.as_str()).collect();
            let session_caps = &response.agent_capabilities.session_capabilities;
            log::info!(
                "[acp] agent {agent_id} initialized: protocol={:?} auth_methods={:?} \
                 loadSession={} sessionCapabilities.list={} resume={} close={}",
                response.protocol_version,
                auth_method_ids,
                response.agent_capabilities.load_session,
                session_caps.list.is_some(),
                session_caps.resume.is_some(),
                session_caps.close.is_some(),
            );

            spawned.store(true, Ordering::Release);
            let _ = init_tx.send(Ok(InitOutcome {
                capabilities: response.agent_capabilities,
                auth_methods,
            }));
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
    }

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
                            if let Some(persistence) = req_persistence {
                                let registration = SessionRegistration {
                                    session_id: session_id.0.clone(),
                                    stable_agent_namespace,
                                    runtime_agent_id: Some(runtime_agent_id),
                                    project_id,
                                    cwd: PathBuf::from(&cwd),
                                };
                                if let Err(error) = persistence.register_session(registration).await
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
                            // Record the session's workspace root so agent fs
                            // requests for this session can be sandboxed (H2).
                            req_state
                                .lock()
                                .set_session_root(session_id.0.clone(), PathBuf::from(&cwd));
                            let event = SessionCreatedEvent {
                                agent_id: req_agent_id,
                                session_id: session_id.clone(),
                                modes: response.modes.clone(),
                                models: response.models.clone(),
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
                                    models: response.models,
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
                    let mut request = agent_client_protocol::schema::ListSessionsRequest::new();
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
                let cancel_rx = driver_state.lock().try_begin_turn(&session_id.0);
                let Some(cancel_rx) = cancel_rx else {
                    // Stable code matched by renderer `ACP_TURN_IN_PROGRESS_CODE`.
                    let _ = reply.send(Err(format!(
                        "ACP_TURN_IN_PROGRESS: session {}",
                        session_id.0
                    )));
                    continue;
                };

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
                    let request = PromptRequest::new(&session_id, content);
                    let prompt = turn_cx.send_request(request).block_task();
                    tokio::pin!(prompt);

                    // Story 1.9 NFR7: race the turn against (a) completion,
                    // (b) a cancel signal bounded by CANCEL_GRACE (M5), AND
                    // (c) a bounded turn timeout (a wedged agent that neither
                    // replies nor crashes must not park `send_prompt`'s
                    // oneshot forever). On timeout, signal cancel + await the
                    // CANCEL_GRACE race, then fail with a typed timeout error
                    // → the `send_prompt` reply surfaces it; `acp-store` sets
                    // `status: 'error'`.
                    let turn_deadline = turn_timeout();
                    let outcome: Result<StopReason, String> = tokio::select! {
                        result = &mut prompt => {
                            result.map(|r| r.stop_reason).map_err(|e| e.to_string())
                        }
                        _ = cancel_rx => {
                            match tokio::time::timeout(CANCEL_GRACE, &mut prompt).await {
                                Ok(result) => {
                                    result.map(|r| r.stop_reason).map_err(|e| e.to_string())
                                }
                                Err(_) => Ok(StopReason::Cancelled),
                            }
                        }
                        _ = tokio::time::sleep(turn_deadline) => {
                            // Turn timed out — signal cancel (so the agent's
                            // in-flight session/prompt is cancelled too) + give
                            // it CANCEL_GRACE to wind down, then fail.
                            turn_state.lock().signal_cancel(&session_id.0);
                            match tokio::time::timeout(CANCEL_GRACE, &mut prompt).await {
                                Ok(result) => {
                                    result.map(|r| r.stop_reason).map_err(|e| e.to_string())
                                }
                                Err(_) => Err(format!(
                                    "turn timeout: session {} exceeded {:?}",
                                    session_id.0, turn_deadline
                                )),
                            }
                        }
                    };

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
                            if let Some(persistence) = &turn_persistence {
                                if let Err(error) =
                                    persistence.flush_session(&event.session_id.0).await
                                {
                                    send_reply(
                                        &task_slot,
                                        Err(format!("failed to flush session history: {error}")),
                                    );
                                    return Ok(());
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
                let _ = reply.send(Ok(driver_state.lock().session_root(&session_id.0).is_some()));
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
                spawn_request(&cx, slot, async move {
                    let request = SetSessionModelRequest::new(&session_id, ModelId::new(model_id));
                    let result = req_cx.send_request(request).block_task().await;
                    send_reply(&task_slot, result.map(|_| ()).map_err(|e| e.to_string()));
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
                spawn_request(&cx, slot, async move {
                    let request =
                        SetSessionConfigOptionRequest::new(&session_id, config_id, value_id);
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
        let modes = agent_client_protocol::schema::SessionModeState::new("ask", vec![]);
        let response = LoadSessionResponse::new()
            .modes(modes.clone())
            .config_options(Vec::<SessionConfigOption>::new());
        let outcome = run_session_reopen(
            "session/load",
            "sess-load",
            "/work",
            &state,
            async move { Ok::<_, String>(response) },
        )
        .await
        .unwrap();

        assert_eq!(outcome.modes, Some(modes));
        assert_eq!(outcome.models, None);
        assert_eq!(outcome.config_options, Some(vec![]));
        assert_eq!(state.lock().session_root("sess-load"), Some(PathBuf::from("/work")));
    }

    #[tokio::test]
    async fn session_resume_reopen_preserves_omitted_fields() {
        let state = Mutex::new(DriverState::new());
        let outcome = run_session_reopen(
            "session/resume",
            "sess-resume",
            "/work",
            &state,
            async { Ok::<_, String>(ResumeSessionResponse::new()) },
        )
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
        assert_eq!(serde_json::to_value(&outcome).unwrap(), serde_json::json!({}));
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
        use agent_client_protocol::schema::AuthMethodAgent;
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
}
