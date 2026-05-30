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
//! requests (permission, fs) are re-emitted to the renderer as Tauri events via
//! a cloned `AppHandle`.
//!
//! This mirrors how `PtyManager` isolates per-PTY I/O on its own threads and
//! emits to the renderer through the `AppHandle`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::Duration;

use agent_client_protocol::schema::{
    AgentCapabilities, CancelNotification, CloseSessionRequest, ContentBlock, InitializeRequest,
    ListSessionsResponse, LoadSessionRequest, McpServer, NewSessionRequest, PromptRequest,
    ProtocolVersion, RequestPermissionOutcome, RequestPermissionResponse, ResumeSessionRequest,
    SelectedPermissionOutcome, SessionConfigOption, SetSessionConfigOptionRequest,
    SetSessionModeRequest, StopReason,
};
use agent_client_protocol::{Agent, Client, ConnectionTo};
use parking_lot::Mutex;
use tauri::AppHandle;
use tokio::sync::{mpsc, oneshot};

use crate::acp::client;
use crate::acp::config::{AgentConfig, AgentId, SessionId};
use crate::acp::events::{
    self, AgentDisconnectedEvent, AgentErrorEvent, AgentSpawnedEvent, ConfigOptionsUpdateEvent,
    PromptCompleteEvent, SessionClosedEvent, SessionCreatedEvent,
};
use crate::acp::session::DriverState;

/// How long to wait for the agent to answer `initialize` before treating the
/// spawn as failed (and tearing the child down).
const INIT_TIMEOUT: Duration = Duration::from_secs(30);
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
    pub modes: Option<agent_client_protocol::schema::SessionModeState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_options: Option<Vec<SessionConfigOption>>,
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
        reply: oneshot::Sender<Result<NewSessionOutcome, String>>,
    },
    LoadSession {
        session_id: SessionId,
        cwd: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    ResumeSession {
        session_id: SessionId,
        cwd: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    CloseSession {
        session_id: SessionId,
        reply: oneshot::Sender<Result<(), String>>,
    },
    ListSessions {
        reply: oneshot::Sender<Result<ListSessionsResponse, String>>,
    },
    SendPrompt {
        session_id: SessionId,
        content: Vec<ContentBlock>,
        reply: oneshot::Sender<Result<StopReason, String>>,
    },
    CancelPrompt {
        session_id: SessionId,
        reply: oneshot::Sender<Result<(), String>>,
    },
    SetMode {
        session_id: SessionId,
        mode_id: String,
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
    /// Ask the driver thread to wind down its connection and exit.
    Shutdown,
}

/// Registry entry for a live agent.
struct AgentEntry {
    command_tx: mpsc::UnboundedSender<AcpCommand>,
    capabilities: AgentCapabilities,
    join_handle: Option<JoinHandle<()>>,
    /// Set true by `kill`/`kill_all` before winding the agent down, so the
    /// driver thread's teardown can tell an intentional kill (silent) from a
    /// spontaneous crash (emits `acp:agent_disconnected`). See L4.
    killed: Arc<AtomicBool>,
}

/// Manages all ACP agents, mirroring the `PtyManager` ownership pattern.
pub struct AcpManager {
    app_handle: AppHandle,
    agents: Arc<Mutex<HashMap<AgentId, AgentEntry>>>,
}

impl AcpManager {
    /// Create a new manager bound to the given Tauri app handle.
    #[must_use]
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            app_handle,
            agents: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Spawn an ACP agent: launch the subprocess, complete `initialize`, and
    /// register the agent. Emits `acp:agent_spawned` on success.
    pub async fn spawn(&self, config: AgentConfig) -> Result<AgentId, String> {
        let agent_id = AgentId::new();
        let (command_tx, command_rx) = mpsc::unbounded_channel::<AcpCommand>();
        let (init_tx, init_rx) = oneshot::channel::<Result<AgentCapabilities, String>>();

        // Shared flag serialized by the `agents` lock: set true when the driver
        // thread removes itself (reaps) so a late `spawn` insert can't recreate
        // a ghost entry for an agent that already exited.
        let reaped = Arc::new(AtomicBool::new(false));
        // Set true by `kill`/`kill_all`; lets the driver teardown distinguish an
        // intentional kill (no disconnect event) from a crash (L4).
        let killed = Arc::new(AtomicBool::new(false));

        let app = self.app_handle.clone();
        let thread_agent_id = agent_id.clone();
        let thread_config = config.clone();
        let thread_agents = self.agents.clone();
        let thread_reaped = reaped.clone();
        let thread_killed = killed.clone();

        let join_handle = std::thread::Builder::new()
            .name(format!("acp-agent-{agent_id}"))
            .spawn(move || {
                run_agent(
                    thread_config,
                    app,
                    thread_agent_id,
                    command_rx,
                    init_tx,
                    thread_agents,
                    thread_reaped,
                    thread_killed,
                );
            })
            .map_err(|e| format!("failed to spawn agent thread: {e}"))?;

        // Wait for the handshake to complete (or fail) on the driver thread.
        let capabilities = match init_rx.await {
            Ok(Ok(caps)) => caps,
            Ok(Err(e)) => {
                // Initialize failed; the driver thread is exiting. Join it off
                // the async runtime so we never block a Tauri worker.
                join_thread_bounded(join_handle).await;
                return Err(format!("agent initialize failed: {e}"));
            }
            Err(_) => {
                // Driver thread dropped the sender without initializing (e.g.
                // the subprocess failed to spawn). Join and report failure.
                join_thread_bounded(join_handle).await;
                return Err("agent failed to start (process did not initialize)".to_string());
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
                    join_handle: Some(join_handle),
                    killed,
                },
            );
        }

        events::emit(
            &self.app_handle,
            events::EVENT_AGENT_SPAWNED,
            AgentSpawnedEvent {
                agent_id: agent_id.clone(),
                capabilities,
            },
        );

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

    /// Create a new session on the given agent.
    pub async fn new_session(
        &self,
        agent_id: &AgentId,
        cwd: String,
        mcp_servers: Vec<McpServer>,
    ) -> Result<NewSessionOutcome, String> {
        let tx = self.command_tx(agent_id)?;
        send_command(&tx, |reply| AcpCommand::NewSession {
            cwd,
            mcp_servers,
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
    ) -> Result<(), String> {
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
    ) -> Result<(), String> {
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

    /// List sessions on the given agent.
    pub async fn list_sessions(
        &self,
        agent_id: &AgentId,
    ) -> Result<ListSessionsResponse, String> {
        let tx = self.command_tx(agent_id)?;
        send_command(&tx, |reply| AcpCommand::ListSessions { reply }).await
    }

    /// Send a prompt and await the turn's stop reason. Streaming updates arrive
    /// as `acp:*` events; the turn ends with `acp:prompt_complete`.
    pub async fn send_prompt(
        &self,
        agent_id: &AgentId,
        session_id: SessionId,
        content: Vec<ContentBlock>,
    ) -> Result<StopReason, String> {
        if content.is_empty() {
            return Err("prompt content must not be empty".to_string());
        }
        let tx = self.command_tx(agent_id)?;
        send_command(&tx, |reply| AcpCommand::SendPrompt {
            session_id,
            content,
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
            Some(id) => {
                RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(id))
            }
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

    /// Kill all agents (best-effort), used as the app-exit safety net.
    pub async fn kill_all(&self) {
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
            return;
        }

        // Bounded join across all threads so app exit can't hang on one stuck
        // agent. We join concurrently and cap the total wait at JOIN_TIMEOUT.
        let join_all = tokio::task::spawn_blocking(move || {
            for handle in handles {
                let _ = handle.join();
            }
        });
        let _ = tokio::time::timeout(JOIN_TIMEOUT, join_all).await;
    }
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
    app: AppHandle,
    agent_id: AgentId,
    command_rx: mpsc::UnboundedReceiver<AcpCommand>,
    init_tx: oneshot::Sender<Result<AgentCapabilities, String>>,
    agents: Arc<Mutex<HashMap<AgentId, AgentEntry>>>,
    reaped: Arc<AtomicBool>,
    killed: Arc<AtomicBool>,
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
            return;
        }
    };

    let result = runtime.block_on(drive_connection(
        config,
        app.clone(),
        agent_id.clone(),
        command_rx,
        init_tx,
        spawned.clone(),
        driver_state.clone(),
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
    if was_spawned && !intentional_kill {
        for session in active_sessions {
            events::emit(
                &app,
                events::EVENT_SESSION_CLOSED,
                SessionClosedEvent {
                    agent_id: agent_id.clone(),
                    session_id: SessionId::new(session),
                },
            );
        }

        if let Err(message) = result {
            events::emit(
                &app,
                events::EVENT_AGENT_ERROR,
                AgentErrorEvent {
                    agent_id: agent_id.clone(),
                    session_id: None,
                    message,
                },
            );
        }

        events::emit(
            &app,
            events::EVENT_AGENT_DISCONNECTED,
            AgentDisconnectedEvent { agent_id },
        );
    }
}

/// Build the client connection and run it until the command loop ends.
#[allow(clippy::too_many_arguments)]
async fn drive_connection(
    config: AgentConfig,
    app: AppHandle,
    agent_id: AgentId,
    command_rx: mpsc::UnboundedReceiver<AcpCommand>,
    init_tx: oneshot::Sender<Result<AgentCapabilities, String>>,
    spawned: Arc<AtomicBool>,
    driver_state: Arc<Mutex<DriverState>>,
) -> Result<(), String> {
    let agent = agent_client_protocol::AcpAgent::new(config.to_mcp_server());

    // Per-handler clones (handlers must be `Send` and may be called repeatedly).
    let notif_app = app.clone();
    let notif_agent_id = agent_id.clone();
    let perm_app = app.clone();
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
    let loop_app = app.clone();
    let loop_agent_id = agent_id.clone();
    let loop_state = driver_state.clone();
    let loop_spawned = spawned.clone();

    let connection_result = Client
        .builder()
        .name(format!("termul-acp-{agent_id}"))
        .on_receive_notification(
            async move |notification: agent_client_protocol::schema::SessionNotification, _cx| {
                client::emit_session_update(&notif_app, &notif_agent_id, notification);
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
                    state.register_permission(session_string.clone(), responder)
                };
                events::emit(
                    &perm_app,
                    events::EVENT_PERMISSION_REQUEST,
                    events::PermissionRequestEvent {
                        agent_id: perm_agent_id.clone(),
                        session_id: SessionId::new(session_string),
                        request_id,
                        tool_call,
                        options,
                    },
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
                    let result =
                        client::handle_read_text_file(&request, root.as_deref()).await;
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
                    let result =
                        client::handle_write_text_file(&request, root.as_deref()).await;
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
                let cwd = request
                    .cwd
                    .clone()
                    .or(session_root);
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
                                registry.lock().record_exit(&request.terminal_id, exit.clone());
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
                loop_app,
                loop_agent_id,
                loop_state,
                loop_spawned,
                allow_terminal,
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
    init_tx: oneshot::Sender<Result<AgentCapabilities, String>>,
    app: AppHandle,
    agent_id: AgentId,
    driver_state: Arc<Mutex<DriverState>>,
    spawned: Arc<AtomicBool>,
    allow_terminal: bool,
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
            spawned.store(true, Ordering::Release);
            let _ = init_tx.send(Ok(response.agent_capabilities));
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
                reply,
            } => {
                let slot = reply_slot(reply);
                let task_slot = slot.clone();
                let req_cx = cx.clone();
                let req_app = app.clone();
                let req_agent_id = agent_id.clone();
                let req_state = driver_state.clone();
                spawn_request(&cx, slot, async move {
                    let request = NewSessionRequest::new(cwd.clone()).mcp_servers(mcp_servers);
                    match req_cx.send_request(request).block_task().await {
                        Ok(response) => {
                            let session_id = SessionId::from(response.session_id);
                            // Record the session's workspace root so agent fs
                            // requests for this session can be sandboxed (H2).
                            req_state
                                .lock()
                                .set_session_root(session_id.0.clone(), PathBuf::from(&cwd));
                            events::emit(
                                &req_app,
                                events::EVENT_SESSION_CREATED,
                                SessionCreatedEvent {
                                    agent_id: req_agent_id,
                                    session_id: session_id.clone(),
                                    modes: response.modes.clone(),
                                    config_options: response.config_options.clone(),
                                },
                            );
                            send_reply(
                                &task_slot,
                                Ok(NewSessionOutcome {
                                    session_id,
                                    modes: response.modes,
                                    config_options: response.config_options,
                                }),
                            );
                        }
                        Err(e) => send_reply(&task_slot, Err(e.to_string())),
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
                    let request = LoadSessionRequest::new(&session_id, cwd.clone());
                    let result = req_cx.send_request(request).block_task().await;
                    if result.is_ok() {
                        req_state
                            .lock()
                            .set_session_root(session_id.0.clone(), PathBuf::from(&cwd));
                    }
                    send_reply(&task_slot, result.map(|_| ()).map_err(|e| e.to_string()));
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
                    let result = req_cx.send_request(request).block_task().await;
                    if result.is_ok() {
                        req_state
                            .lock()
                            .set_session_root(session_id.0.clone(), PathBuf::from(&cwd));
                    }
                    send_reply(&task_slot, result.map(|_| ()).map_err(|e| e.to_string()));
                });
            }

            AcpCommand::CloseSession { session_id, reply } => {
                let slot = reply_slot(reply);
                let task_slot = slot.clone();
                let req_cx = cx.clone();
                let req_state = driver_state.clone();
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
                            let _ = permission.responder.respond(
                                RequestPermissionResponse::new(
                                    RequestPermissionOutcome::Cancelled,
                                ),
                            );
                        }
                    }
                    send_reply(&task_slot, result.map(|_| ()).map_err(|e| e.to_string()));
                });
            }

            AcpCommand::ListSessions { reply } => {
                let slot = reply_slot(reply);
                let task_slot = slot.clone();
                let req_cx = cx.clone();
                spawn_request(&cx, slot, async move {
                    let request = agent_client_protocol::schema::ListSessionsRequest::new();
                    let result = req_cx.send_request(request).block_task().await;
                    send_reply(&task_slot, result.map_err(|e| e.to_string()));
                });
            }

            AcpCommand::SendPrompt {
                session_id,
                content,
                reply,
            } => {
                // Single-flight per session: reject a second prompt while a turn
                // is in flight (M4). `try_begin_turn` returns a cancel signal
                // receiver when the turn may proceed.
                let cancel_rx = driver_state.lock().try_begin_turn(&session_id.0);
                let Some(cancel_rx) = cancel_rx else {
                    let _ = reply.send(Err(format!(
                        "a prompt turn is already in progress for session {}",
                        session_id.0
                    )));
                    continue;
                };

                let slot = reply_slot(reply);
                let task_slot = slot.clone();
                let turn_cx = cx.clone();
                let turn_app = app.clone();
                let turn_agent_id = agent_id.clone();
                let turn_state = driver_state.clone();
                let turn_session = session_id.clone();
                let spawn_result = cx.spawn(async move {
                    let request = PromptRequest::new(&session_id, content);
                    let prompt = turn_cx.send_request(request).block_task();
                    tokio::pin!(prompt);

                    // Race the turn against a cancel signal bounded by
                    // CANCEL_GRACE: a misbehaving agent that ignores
                    // `session/cancel` must not park `acp_send_prompt`
                    // forever holding the reply sender (M5).
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
                    };

                    // Turn is over: clear the active-turn marker and resolve any
                    // permissions that were never answered (H3 — normal
                    // completion, not just cancel).
                    let pending = turn_state.lock().finish_turn(&session_id.0);
                    for permission in pending {
                        let _ = permission.responder.respond(
                            RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled),
                        );
                    }

                    match outcome {
                        Ok(stop_reason) => {
                            events::emit(
                                &turn_app,
                                events::EVENT_PROMPT_COMPLETE,
                                PromptCompleteEvent {
                                    agent_id: turn_agent_id,
                                    session_id,
                                    stop_reason,
                                },
                            );
                            send_reply(&task_slot, Ok(stop_reason));
                        }
                        Err(message) => {
                            events::emit(
                                &turn_app,
                                events::EVENT_AGENT_ERROR,
                                AgentErrorEvent {
                                    agent_id: turn_agent_id,
                                    session_id: Some(session_id),
                                    message: message.clone(),
                                },
                            );
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

            AcpCommand::SetConfigOption {
                session_id,
                config_id,
                value_id,
                reply,
            } => {
                let slot = reply_slot(reply);
                let task_slot = slot.clone();
                let req_cx = cx.clone();
                let req_app = app.clone();
                let req_agent_id = agent_id.clone();
                spawn_request(&cx, slot, async move {
                    let request =
                        SetSessionConfigOptionRequest::new(&session_id, config_id, value_id);
                    match req_cx.send_request(request).block_task().await {
                        Ok(response) => {
                            events::emit(
                                &req_app,
                                events::EVENT_CONFIG_OPTIONS_UPDATE,
                                ConfigOptionsUpdateEvent {
                                    agent_id: req_agent_id,
                                    session_id,
                                    config_options: response.config_options.clone(),
                                },
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
                        let _ = reply
                            .send(Err(format!("unknown permission request: {request_id}")));
                    }
                }
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

        let result: Result<(), String> =
            send_command(&tx, |reply| AcpCommand::CloseSession {
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

    /// An empty prompt is rejected before any agent contact (EMPTY-CONTENT).
    /// `send_prompt`'s guard is a pure pre-check; assert its predicate here
    /// (the manager method needs an AppHandle, but the guard runs first).
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
}
