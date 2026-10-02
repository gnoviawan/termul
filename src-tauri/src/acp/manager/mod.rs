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
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use std::thread::JoinHandle;
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    AgentCapabilities, AuthMethod, AuthenticateRequest, CancelNotification, CloseSessionRequest,
    ContentBlock, EnvVariable, InitializeRequest, ListSessionsResponse, LoadSessionRequest,
    LoadSessionResponse, McpServer, McpServerStdio, Meta, NewSessionRequest, PromptRequest,
    RequestPermissionOutcome, RequestPermissionResponse, ResumeSessionRequest,
    ResumeSessionResponse, SelectedPermissionOutcome, SessionConfigOption,
    SetSessionConfigOptionRequest, SetSessionConfigOptionResponse, SetSessionModeRequest,
    StopReason,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{Agent, Client, ConnectionTo, LineDirection, UntypedMessage};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot, watch};

use crate::acp::client;
use crate::acp::config::{AgentConfig, AgentId, SessionId};
use crate::acp::events::{
    self, AgentCrashedEvent, AgentDisconnectedEvent, AgentErrorEvent, AgentSpawnedEvent,
    AgentSwitchEvent, AuthMethodInfo, ConfigOptionsUpdateEvent, PromptCompleteEvent,
    SessionClosedEvent, SessionCreatedEvent, SessionInfoUpdateEvent, SessionModelState,
};
use crate::acp::session::{DriverState, ReopenReservation, ReplayWindowGuard};
use crate::acp::session_persistence::{
    is_protected_title_source, normalize_title, AgentSwitchRecord, PersistedSessionStatus,
    SessionPersistence, SessionPersistenceError, SessionRegistration, TitleSource,
};
use crate::web::EventSink;

mod command_loop;
mod driver;
mod gates;
mod history;
mod reopen;
mod timeouts;
mod wire;

use command_loop::*;
use driver::*;
use gates::*;
use wire::*;

pub(crate) use history::*;
pub use reopen::*;
pub use timeouts::*;

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
    /// When set on an ephemeral session, the host still injects the plan-MCP
    /// server (normally skipped for ephemeral one-shots) so the session can be
    /// promoted to a durable chat later via `promote_session` without losing
    /// the plan tool. Meaningless for non-ephemeral sessions (always injected).
    pub promotable: bool,
    /// Worktree path the agent runs in (CAP-3). When set, the durable record
    /// carries it so relaunch reattaches without a second `git worktree add`
    /// and the chat indicator (CAP-6) survives reload. State isolation still
    /// keys on `cwd` (the worktree path) — this field is for the indicator +
    /// deleted-worktree fallback only.
    pub worktree_path: Option<String>,
    /// Worktree branch (`chat/{id}`) — paired with `worktree_path`.
    pub worktree_branch: Option<String>,
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
        worktree_path: Option<String>,
        worktree_branch: Option<String>,
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
        /// Resolves after the driver has claimed the session turn and
        /// registered its completion task. Callers can then process a
        /// following cancellation without racing prompt startup.
        accepted: oneshot::Sender<Result<(), String>>,
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
    /// Promote a backend-ephemeral session to durable: register the
    /// persistence metadata captured at `session/new` and clear the ephemeral
    /// mark. Idempotent for already-durable sessions; unknown sessions error.
    PromoteSession {
        session_id: SessionId,
        reply: oneshot::Sender<Result<(), String>>,
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
        reply: oneshot::Sender<Result<Option<Vec<SessionConfigOption>>, String>>,
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

pub(crate) struct StartedPrompt {
    completion: oneshot::Receiver<Result<StopReason, String>>,
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

/// Authoritative spawn result returned by [`AcpManager::spawn`] and mirrored
/// verbatim by both the Tauri `acp_spawn_agent` command and the WS
/// `spawn_agent` handler (CAP-4: metadata delivery cannot depend on a session
/// subscription that does not yet exist). Carries everything the renderer needs
/// to populate the store synchronously: the negotiated capabilities, advertised
/// auth methods, host-auth readiness, and stable namespace. The
/// `acp:agent_spawned` event is still emitted for observers but is no longer the
/// source of truth — the spawn response is. Serialized camelCase on the wire so
/// desktop (Tauri `Result`) and web (`WsReply` payload) share one contract.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOutcome {
    pub agent_id: AgentId,
    pub capabilities: AgentCapabilities,
    /// Every authentication method the agent advertised at `initialize`. Always
    /// serialized (as `[]` when empty) so the renderer sees a stable field.
    pub auth_methods: Vec<AuthMethodInfo>,
    /// True only when the host validated and prepared authentication for its
    /// managed Claude ACP installation before starting the agent.
    pub host_auth_ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stable_namespace: Option<String>,
}

/// Identity-rich summary of a live agent (CAP-11). Returned by the WS
/// `list_agents` handler + the desktop `acp_list_agent_details` command so
/// clients can render/agent-route without a second lookup. `configId` and
/// `namespace` are omitted when absent (`skip_serializing_if`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSummary {
    pub id: AgentId,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    pub capabilities: AgentCapabilities,
}

/// Registry entry for a live agent.
struct AgentEntry {
    command_tx: mpsc::UnboundedSender<AcpCommand>,
    capabilities: AgentCapabilities,
    stable_namespace: Option<String>,
    /// Human-readable agent name + stable config identity captured from the
    /// spawn-time [`AgentConfig`] (surfaced by [`AcpManager::list_agent_summaries`]).
    name: String,
    config_id: Option<String>,
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
    /// Host-injected `termul` MCP server (exposes the `plan` tool; one shared TCP listener across
    /// all sessions, started EAGERLY in the constructor so the first
    /// `new_session_with_context` doesn't block a Tokio worker thread on the
    /// bind + port-publish handshake). Injects a self-spawned stdio child
    /// into every non-ephemeral session's `mcp_servers`; the child forwards
    /// `plan` calls back here, and `host_mcp::emit_plan_update` emits a
    /// synthetic `acp:plan_update` so the existing renderer `PlanPanel`
    /// renders it. See `host_mcp::mod` + the spec
    /// `spec-acp-host-todo-plan-tool.md`.
    host_plan_server: Arc<crate::acp::host_mcp::parent::HostPlanServer>,
    /// Host-wide Claude auth and managed-install identity. Only the verified
    /// host-installed Claude entrypoint can receive its keychain credential.
    claude_agent: Arc<crate::acp::claude_agent::ClaudeAgentService>,
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
        Self::with_claude_agent(
            sinks,
            Arc::new(crate::acp::claude_agent::ClaudeAgentService::without_host_state()),
        )
    }

    /// Create a manager that uses the host-wide Claude auth store and managed
    /// install root. Used by desktop and standalone server; browser sessions
    /// share this manager and can use the credentials but cannot manage them.
    #[must_use]
    pub fn with_claude_agent(
        sinks: Vec<Arc<dyn EventSink>>,
        claude_agent: Arc<crate::acp::claude_agent::ClaudeAgentService>,
    ) -> Self {
        let host_plan_server =
            crate::acp::host_mcp::parent::HostPlanServer::start(sinks.clone(), None);
        Self {
            sinks,
            agents: Arc::new(Mutex::new(HashMap::new())),
            persistence: None,
            host_plan_server,
            claude_agent,
        }
    }

    /// Create the standalone manager sharing one durable store with the relay.
    #[must_use]
    pub fn with_persistence(
        sinks: Vec<Arc<dyn EventSink>>,
        persistence: Arc<SessionPersistence>,
    ) -> Self {
        Self::with_persistence_and_claude_agent(
            sinks,
            persistence,
            Arc::new(crate::acp::claude_agent::ClaudeAgentService::without_host_state()),
        )
    }

    /// Create the standalone manager with durable event storage and the shared
    /// host Claude auth/install state.
    #[must_use]
    pub fn with_persistence_and_claude_agent(
        sinks: Vec<Arc<dyn EventSink>>,
        persistence: Arc<SessionPersistence>,
        claude_agent: Arc<crate::acp::claude_agent::ClaudeAgentService>,
    ) -> Self {
        let host_plan_server = crate::acp::host_mcp::parent::HostPlanServer::start(
            sinks.clone(),
            Some(Arc::clone(&persistence)),
        );
        Self {
            sinks,
            agents: Arc::new(Mutex::new(HashMap::new())),
            persistence: Some(persistence),
            host_plan_server,
            claude_agent,
        }
    }

    #[must_use]
    pub fn persistence(&self) -> Option<Arc<SessionPersistence>> {
        self.persistence.clone()
    }
    /// Host-authored durable agent-switch marker (CAP-2): persist through
    /// `SessionPersistence`, flush, then fan the synthetic live event out
    /// through this manager's sinks (Tauri renderer + WS relay on desktop;
    /// relay-only on the standalone server). See the module-level
    /// [`record_agent_switch`] for the persistence/fan-out contract.
    pub async fn record_agent_switch(
        &self,
        session_id: String,
        record: AgentSwitchRecord,
    ) -> Result<(), String> {
        let persistence = self
            .persistence
            .as_ref()
            .ok_or_else(|| "session persistence unavailable".to_string())?;
        // The runtime agent id on the event is the OLD session's agent (the
        // marker lands on the old transcript before teardown).
        let agent_id = persistence
            .metadata(&session_id)
            .ok()
            .and_then(|metadata| metadata.runtime_agent_id)
            .map(AgentId)
            .unwrap_or_default();
        record_agent_switch(persistence, &self.sinks, agent_id, session_id, record).await
    }

    /// Spawn an ACP agent: launch the subprocess, complete `initialize`, and
    /// register the agent. Emits `acp:agent_spawned` on success. Returns a
    /// [`SpawnOutcome`] carrying the authoritative capabilities, auth methods,
    /// host-auth readiness, and stable namespace so the renderer can populate the store
    /// synchronously from the response (CAP-4: the spawn response — not the
    /// async event — is the source of truth).
    pub async fn spawn(&self, mut config: AgentConfig) -> Result<SpawnOutcome, String> {
        crate::acp::factory_key::normalize_launch_args(&mut config);
        crate::acp::factory_key::inject(&mut config)?;
        let host_auth_ready = self
            .claude_agent
            .prepare_managed_config(&mut config)
            .await?;
        self.spawn_with_sinks(config, host_auth_ready, self.sinks.clone())
            .await
    }

    /// Candidate validation bypasses the persisted-key overlay.
    pub(crate) async fn spawn_factory_candidate(
        &self,
        mut config: AgentConfig,
    ) -> Result<SpawnOutcome, String> {
        crate::acp::factory_key::normalize_launch_args(&mut config);
        self.spawn_with_sinks(config, false, vec![]).await
    }

    /// Same as [`spawn`](Self::spawn) but lets the caller supply the sink list
    /// the background driver threads into. The public [`spawn`](Self::spawn)
    /// forwards `self.sinks` unchanged.
    async fn spawn_with_sinks(
        &self,
        config: AgentConfig,
        host_auth_ready: bool,
        sinks: Vec<Arc<dyn EventSink>>,
    ) -> Result<SpawnOutcome, String> {
        let spawn_sinks = sinks.clone();
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

        let thread_agent_id = agent_id.clone();
        let thread_config = config.clone();
        let thread_agents = self.agents.clone();
        let thread_reaped = reaped.clone();
        let thread_killed = killed.clone();
        let thread_start_error = start_error.clone();
        let thread_persistence = self.persistence.clone();
        let thread_host_plan_server = self.host_plan_server.clone();
        let stable_namespace = stable_agent_namespace(&config);
        let join_handle = std::thread::Builder::new()
            .name(format!("acp-agent-{agent_id}"))
            .spawn(move || {
                run_agent(
                    thread_config,
                    sinks,
                    thread_host_plan_server,
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
                if crate::acp::factory_key::is_factory_droid(&config) {
                    // The renderer gets the generic message (agents may echo
                    // env values); the host log keeps the specific detail.
                    log::warn!("[acp] Factory Droid initialize failed: {e}");
                    return Err("Factory Droid initialize failed".to_string());
                }
                log::warn!("[acp] spawn failed: agent initialize failed: {e}");
                return Err(format!("agent initialize failed: {e}"));
            }
            Err(_) => {
                // Driver thread dropped the sender without initializing (e.g.
                // the subprocess failed to spawn). Join and report failure,
                // preferring the concrete connection error the driver recorded
                // (e.g. "program not found") over the generic fallback.
                join_thread_bounded(join_handle).await;
                let reason = start_error.lock().take();
                let message = match reason {
                    Some(detail) => format!("agent failed to start: {detail}"),
                    None => "agent failed to start (process did not initialize)".to_string(),
                };
                if crate::acp::factory_key::is_factory_droid(&config) {
                    // Same redaction convention as the initialize path: generic
                    // toward the renderer, specific detail in the host log.
                    log::warn!("[acp] Factory Droid start failed: {message}");
                    return Err("Factory Droid start failed".to_string());
                }
                log::warn!("[acp] spawn failed: {message}");
                return Err(message);
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
                let reason = "agent exited before it could be registered";
                log::warn!("[acp] spawn failed: {reason}");
                return Err(reason.to_string());
            }
            agents.insert(
                agent_id.clone(),
                AgentEntry {
                    command_tx,
                    capabilities: capabilities.clone(),
                    stable_namespace: stable_namespace.clone(),
                    name: config.name.clone(),
                    config_id: config.config_id.clone(),
                    join_handle: Some(join_handle),
                    killed,
                },
            );
        }

        let event = AgentSpawnedEvent {
            agent_id: agent_id.clone(),
            capabilities: capabilities.clone(),
            auth_methods: auth_methods.clone(),
            host_auth_ready,
        };
        // `agent_spawned` is agent-level (no session yet) → sid = None. The event
        // stays for observers; the spawn response is now the authoritative source
        // of capabilities + authMethods + stableNamespace.
        events::fan_out(&spawn_sinks, None, events::EVENT_AGENT_SPAWNED, &event);

        // Log success at the host boundary with the agent id and auth-method ids
        // (never credentials). One line per spawn so a missing method list or an
        // unexpected auth-required agent is observable in the runtime log.
        let auth_method_ids: Vec<&str> = auth_methods.iter().map(|m| m.id.as_str()).collect();
        log::info!(
            "[acp] agent {agent_id} spawned (host_auth_ready={host_auth_ready}, auth_methods={:?})",
            auth_method_ids
        );

        Ok(SpawnOutcome {
            agent_id,
            capabilities,
            auth_methods,
            host_auth_ready,
            stable_namespace,
        })
    }

    /// Return the ids of all currently registered agents.
    #[must_use]
    pub fn list_agents(&self) -> Vec<AgentId> {
        self.agents.lock().keys().cloned().collect()
    }

    /// Return identity-rich summaries of all currently registered agents
    /// (CAP-11): `{ id, name, configId?, namespace?, capabilities }`. The WS
    /// `list_agents` handler serves these; the desktop `acp_list_agents`
    /// command keeps returning bare ids and `acp_list_agent_details` serves
    /// the summaries.
    #[must_use]
    pub fn list_agent_summaries(&self) -> Vec<AgentSummary> {
        self.agents
            .lock()
            .iter()
            .map(|(id, entry)| AgentSummary {
                id: id.clone(),
                name: entry.name.clone(),
                config_id: entry.config_id.clone(),
                namespace: entry.stable_namespace.clone(),
                capabilities: entry.capabilities.clone(),
            })
            .collect()
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

        // Host-injected `plan` MCP tool: prepend a self-spawned stdio
        // child to every non-ephemeral session's mcp_servers so the agent
        // discovers + calls it as a first-class tool (see `host_mcp::mod` +
        // spec `spec-acp-host-todo-plan-tool.md`). The real ACP session_id
        // isn't known until the response, so register with a provisional id
        // now + bind after `session/new` returns. If session creation fails,
        // evict the token so it doesn't leak (CodeRabbit #6).
        // Story 8: a promotable ephemeral session (warm pool) still gets the
        // plan tool — it becomes a durable chat on promotion, and plan-MCP
        // injection is `session/new`-time only.
        let (combined_mcp_servers, plan_token): (Vec<McpServer>, Option<String>) =
            if !context.ephemeral || context.promotable {
                let (port, token, provisional_sid) =
                    self.host_plan_server.register_session(&agent_id.0);
                let internal =
                    build_internal_plan_stdio(&agent_id.0, port, &token, &provisional_sid);
                // Prepend so the internal server is first in the agent's tool list.
                let mut combined = internal;
                combined.extend(mcp_servers);
                (combined, Some(token))
            } else {
                (mcp_servers, None)
            };

        let outcome = async {
            // Inject OAuth Bearer tokens into HTTP/SSE MCP server configs so
            // authenticated servers (e.g., Mobbin) work in agent sessions.
            let combined_mcp_servers = inject_oauth_tokens(combined_mcp_servers);

            gate_mcp_servers(&caps, &combined_mcp_servers)?;
            let tx = self.command_tx(agent_id)?;
            send_command(&tx, |reply| AcpCommand::NewSession {
                cwd,
                mcp_servers: combined_mcp_servers,
                stable_agent_namespace,
                runtime_agent_id: agent_id.0.clone(),
                project_id: context.project_id,
                ephemeral: context.ephemeral,
                worktree_path: context.worktree_path,
                worktree_branch: context.worktree_branch,
                reply,
            })
            .await
        }
        .await;

        match outcome {
            Ok(outcome) => {
                // Bind the real session_id to the plan token so the parent can
                // emit plan_update for the right session when the agent calls
                // plan.
                if let Some(token) = plan_token {
                    self.host_plan_server
                        .bind_session(&token, &outcome.session_id.0);
                }
                Ok(outcome)
            }
            Err(e) => {
                // Evict the registered token on failure so it doesn't leak +
                // the provisional id can't be reused by a later session.
                if let Some(token) = plan_token {
                    self.host_plan_server.unregister_by_token(&token);
                }
                Err(e)
            }
        }
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

    /// Promote a backend-ephemeral session to durable (story 8 — warm pool):
    /// the driver registers the persistence metadata captured at
    /// `session/new` and clears the ephemeral mark, so the first real prompt
    /// persists. Idempotent for already-durable sessions; errors for sessions
    /// the driver never created.
    pub async fn promote_session(
        &self,
        agent_id: &AgentId,
        session_id: SessionId,
    ) -> Result<(), String> {
        let tx = self.command_tx(agent_id)?;
        send_command(&tx, |reply| AcpCommand::PromoteSession {
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
    ///
    /// Title generation is NOT triggered here: the host-injected
    /// `set_session_title` MCP tool (host_mcp) sets the title in-process during
    /// the agent's own turn. If the agent never calls the tool, the title falls
    /// back to `DerivedFirstMessage` (AD-6).
    pub async fn send_prompt(
        self: &Arc<Self>,
        agent_id: &AgentId,
        session_id: SessionId,
        content: Vec<ContentBlock>,
        turn_id: Option<String>,
    ) -> Result<StopReason, String> {
        let started = self
            .start_prompt(agent_id, session_id, content, turn_id)
            .await?;
        self.wait_prompt(started).await
    }

    /// Register a prompt turn with the driver without awaiting the long agent
    /// completion. Success means the driver's single-flight marker and prompt
    /// task are installed, so a subsequently queued cancellation cannot no-op
    /// before the turn starts.
    pub(crate) async fn start_prompt(
        self: &Arc<Self>,
        agent_id: &AgentId,
        session_id: SessionId,
        content: Vec<ContentBlock>,
        turn_id: Option<String>,
    ) -> Result<StartedPrompt, String> {
        if content.is_empty() {
            return Err("prompt content must not be empty".to_string());
        }
        let tx = self.command_tx(agent_id)?;
        let (accepted_tx, accepted_rx) = oneshot::channel();
        let (completion_tx, completion_rx) = oneshot::channel();
        tx.send(AcpCommand::SendPrompt {
            session_id: session_id.clone(),
            content,
            turn_id,
            accepted: accepted_tx,
            reply: completion_tx,
        })
        .map_err(|_| "agent thread is no longer running".to_string())?;
        accepted_rx
            .await
            .map_err(|_| "agent thread dropped the prompt acceptance".to_string())??;
        Ok(StartedPrompt {
            completion: completion_rx,
        })
    }

    pub(crate) async fn wait_prompt(
        self: &Arc<Self>,
        started: StartedPrompt,
    ) -> Result<StopReason, String> {
        let StartedPrompt { completion } = started;
        let stop_reason = completion
            .await
            .map_err(|_| "agent thread dropped the prompt reply".to_string())??;
        Ok(stop_reason)
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

    /// Set an option, returning its snapshot if the agent supplied one.
    pub async fn set_config_option(
        &self,
        agent_id: &AgentId,
        session_id: SessionId,
        config_id: String,
        value_id: String,
    ) -> Result<Option<Vec<SessionConfigOption>>, String> {
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

    /// Replay a user-pasted loopback OAuth redirect against the agent's own
    /// callback listener (the paste-back half of the headless browser-auth
    /// flow, spec-acp-terminal-auth).
    ///
    /// The agent's listener binds the port embedded in the pasted URL, so the
    /// replay needs no port knowledge: `browser_shim::deliver_auth_redirect`
    pub async fn deliver_auth_redirect(
        &self,
        agent_id: &AgentId,
        url: String,
    ) -> Result<u16, String> {
        if !self.agents.lock().contains_key(agent_id) {
            return Err(format!("unknown agent: {agent_id}"));
        }
        crate::acp::browser_shim::deliver_auth_redirect(&url).await
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
                match command {
                    AcpCommand::OwnsSession { session_id, reply } => {
                        let _ = reply.send(Ok(sessions.contains(&session_id.0)));
                    }
                    // Story 10 (cross-client continuity): handle the prompt-flow
                    // commands so `handle_send_prompt` reaches persistence
                    // without a real agent binary. `IsEphemeralSession` → false
                    // (so `persist_user_prompt` runs + the user prompt is the
                    // durable transcript); `SendPrompt` → `EndTurn` (so the turn
                    // completes + the watermark advances). No streaming events
                    // are emitted — the persisted `user_prompt` IS the transcript
                    // the cross-client restore test reads back via
                    // `handle_get_session_payload`.
                    AcpCommand::IsEphemeralSession { reply, .. } => {
                        let _ = reply.send(Ok(false));
                    }
                    // Story 8: the fake driver's promote is a no-op Ok — nothing
                    // is ephemeral in this harness, and idempotent Ok is the
                    // contract for an already-durable session.
                    AcpCommand::PromoteSession { reply, .. } => {
                        let _ = reply.send(Ok(()));
                    }
                    AcpCommand::SendPrompt {
                        accepted, reply, ..
                    } => {
                        let _ = accepted.send(Ok(()));
                        let _ = reply.send(Ok(StopReason::EndTurn));
                    }
                    // Unhandled commands are silently dropped (same behavior
                    // as the prior `if let`). A reply-bearing variant dropped
                    // here will cause the caller to hang — future tests that
                    // add new commands should add a dedicated match arm.
                    _ => {}
                }
            }
        });
        self.agents.lock().insert(
            agent_id,
            AgentEntry {
                command_tx,
                capabilities: AgentCapabilities::default(),
                stable_namespace: None,
                name: "test-agent".to_string(),
                config_id: None,
                join_handle: None,
                killed: Arc::new(AtomicBool::new(false)),
            },
        );
    }

    /// CAP-11 (VG2): install a test agent whose capabilities pass
    /// `gate_resume_session` (`sessionCapabilities.resume` advertised) and
    /// whose command loop answers `AcpCommand::ResumeSession` with an empty ok
    /// outcome, so `handle_resume_session`'s success path is reachable from
    /// the WS layer. `OwnsSession` behaves like
    /// `install_test_agent_with_sessions`.
    #[cfg(test)]
    pub(crate) fn install_test_agent_with_resume(
        &self,
        agent_id: AgentId,
        sessions: std::collections::HashSet<String>,
    ) {
        let (command_tx, mut command_rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            while let Some(command) = command_rx.recv().await {
                match command {
                    AcpCommand::OwnsSession { session_id, reply } => {
                        let _ = reply.send(Ok(sessions.contains(&session_id.0)));
                    }
                    AcpCommand::ResumeSession { reply, .. } => {
                        let _ = reply.send(Ok(SessionReopenOutcome {
                            modes: None,
                            models: None,
                            config_options: None,
                        }));
                    }
                    _ => {}
                }
            }
        });
        let mut capabilities = AgentCapabilities::default();
        capabilities.session_capabilities.resume =
            Some(agent_client_protocol::schema::v1::SessionResumeCapabilities::default());
        self.agents.lock().insert(
            agent_id,
            AgentEntry {
                command_tx,
                capabilities,
                stable_namespace: None,
                name: "test-agent".to_string(),
                config_id: None,
                join_handle: None,
                killed: Arc::new(AtomicBool::new(false)),
            },
        );
    }

    #[cfg(test)]
    pub(crate) fn install_test_agent_with_prompt_gate(
        &self,
        agent_id: AgentId,
        sessions: std::collections::HashSet<String>,
    ) -> (oneshot::Sender<()>, oneshot::Receiver<()>) {
        let (release_tx, release_rx) = oneshot::channel();
        let (entered_tx, entered_rx) = oneshot::channel();
        let (command_tx, mut command_rx) = mpsc::unbounded_channel();
        let sinks = self.sinks.clone();
        let gated_agent_id = agent_id.clone();
        tokio::spawn(async move {
            let mut released = false;
            let mut entered_tx = Some(entered_tx);
            let mut release_rx = Some(release_rx);
            let pending_cancels = Arc::new(parking_lot::Mutex::new(std::collections::HashMap::<
                String,
                oneshot::Sender<()>,
            >::new()));
            while let Some(command) = command_rx.recv().await {
                match command {
                    AcpCommand::OwnsSession { session_id, reply } => {
                        let _ = reply.send(Ok(sessions.contains(&session_id.0)));
                    }
                    AcpCommand::IsEphemeralSession { reply, .. } => {
                        let _ = reply.send(Ok(false));
                    }
                    AcpCommand::SendPrompt {
                        session_id,
                        turn_id,
                        accepted,
                        reply,
                        ..
                    } => {
                        if !released {
                            if let Some(entered_tx) = entered_tx.take() {
                                let _ = entered_tx.send(());
                            }
                            let mut release_rx = release_rx.take().expect("first prompt gate");
                            let (cancel_tx, mut cancel_rx) = oneshot::channel();
                            pending_cancels
                                .lock()
                                .insert(session_id.0.clone(), cancel_tx);
                            let prompt_sinks = sinks.clone();
                            let prompt_agent_id = gated_agent_id.clone();
                            let prompt_cancels = Arc::clone(&pending_cancels);
                            let prompt_session_id = session_id.0.clone();
                            tokio::spawn(async move {
                                let stop_reason = tokio::select! {
                                    _ = &mut release_rx => StopReason::EndTurn,
                                    _ = &mut cancel_rx => StopReason::Cancelled,
                                };
                                prompt_cancels.lock().remove(&prompt_session_id);
                                let event = PromptCompleteEvent {
                                    agent_id: prompt_agent_id,
                                    session_id: session_id.clone(),
                                    stop_reason,
                                    turn_id,
                                };
                                events::fan_out(
                                    &prompt_sinks,
                                    Some(&session_id.0),
                                    events::EVENT_PROMPT_COMPLETE,
                                    &event,
                                );
                                let _ = reply.send(Ok(stop_reason));
                            });
                            released = true;
                        } else {
                            let _ = reply.send(Ok(StopReason::EndTurn));
                        }
                        let _ = accepted.send(Ok(()));
                    }
                    AcpCommand::CancelPrompt { session_id, reply } => {
                        if let Some(cancel) = pending_cancels.lock().remove(&session_id.0) {
                            let _ = cancel.send(());
                        }
                        let _ = reply.send(Ok(()));
                    }
                    _ => {}
                }
            }
        });
        self.agents.lock().insert(
            agent_id,
            AgentEntry {
                command_tx,
                capabilities: AgentCapabilities::default(),
                stable_namespace: None,
                name: "test-agent".to_string(),
                config_id: None,
                join_handle: None,
                killed: Arc::new(AtomicBool::new(false)),
            },
        );
        (release_tx, entered_rx)
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

#[cfg(test)]
mod tests;
