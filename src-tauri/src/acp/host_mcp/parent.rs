//! Parent side of the host-injected plan tool: an in-process TCP listener that
//! the self-spawned child connects to on each `plan` call.
//!
//! One shared listener serves all sessions (started lazily by `AcpManager` on
//! first `new_session_with_context`). Each session is registered with a random
//! token + a host-generated PROVISIONAL session_id (the real ACP session_id
//! isn't known until `session/new` returns). After the response, `AcpManager`
//! calls `bind_session(token, real_session_id)` so the parent can emit
//! `plan_update` for the real id. The child presents the token + provisional id
//! per call; the parent verifies the token, ignores stale unbound entries, and
//! emits.
//!
//! Runs on a dedicated OS thread with a current-thread tokio runtime (mirrors
//! the per-agent driver-thread model in `AcpManager`) — works on both the
//! desktop binary and the standalone `termul-server` (no `AppHandle`).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use parking_lot::Mutex;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use uuid::Uuid;

use crate::acp::config::{AgentId, SessionId};
use crate::acp::host_mcp::{
    emit_plan_update, map_todos_to_plan_entries, FrameKind, FrameReply, FrameRequest, PlanStore,
};
use crate::acp::session_persistence::SessionPersistence;
use crate::web::EventSink;

/// Per-session auth + routing context, keyed by the random token.
#[derive(Clone)]
struct SessionAuth {
    /// Host-generated provisional id (passed to the child via env, echoed in
    /// the frame for defense-in-depth — does NOT match the real ACP id).
    provisional_sid: String,
    agent_id: String,
    /// The real ACP session_id, bound after `session/new` returns. `None`
    /// until `bind_session` is called; a call arriving before binding is
    /// rejected (the agent can't call tools before `session/new` completes,
    /// so this is purely defensive).
    real_session_id: Option<String>,
}

/// The shared host plan server. Owns the listener thread + the per-session
/// token map + a `PlanStore` cache + a clone of the AcpManager sinks (for
/// emitting `plan_update`).
pub struct HostPlanServer {
    /// Set once the dedicated thread has bound the listener.
    port: std::sync::OnceLock<u16>,
    /// Cloned at construction; never changes (AcpManager's sinks are
    /// `Vec<Arc<dyn EventSink>>` fixed at creation).
    sinks: Vec<Arc<dyn EventSink>>,
    /// token -> SessionAuth. One entry per registered session.
    sessions: Mutex<HashMap<String, SessionAuth>>,
    /// Runtime agent id -> sessions with an accepted prompt currently in flight.
    /// Some agents reuse an older session's MCP child for later sessions; this
    /// authoritative turn registry lets `process_request` repair that stale
    /// token binding when exactly one session for the agent is active.
    active_turns: Mutex<HashMap<String, HashSet<String>>>,
    /// Sessions that have already set a title. Per-session (not per-turn): the
    /// first `set_session_title` call persists + broadcasts; subsequent calls
    /// for the same session return a success no-op so the agent stops
    /// retrying. Cleared on `unregister_session`. In-memory only — a resumed
    /// session in a new process can set the title once again.
    title_set_for_session: Mutex<HashSet<String>>,
    /// Per-session plan cache (emit-and-cache). v1 doesn't persist; this is
    /// the seam a future persistence layer reads from on resume. Updated in
    /// `process_request` (set on emit) + `unregister_*` (drop on close).
    plan_store: PlanStore,
    /// Durable store used by the title tool. Absent in live-only tests/modes.
    persistence: Option<Arc<SessionPersistence>>,
}

impl HostPlanServer {
    /// Start the in-process TCP listener on `127.0.0.1:<ephemeral>` and spawn
    /// the dedicated accept-loop thread. Blocks until the port is known (so
    /// `register_session` callers see a valid port immediately).
    ///
    /// The sinks are the AcpManager's event sinks (`TauriEventSink` on desktop,
    /// `WsRelaySink` on standalone). `fan_out` over zero sinks is a no-op, so a
    /// unit-test `HostPlanServer` with `vec![]` is legal (just emits nothing).
    #[must_use]
    pub fn start(
        sinks: Vec<Arc<dyn EventSink>>,
        persistence: Option<Arc<SessionPersistence>>,
    ) -> Arc<Self> {
        let server = Arc::new(Self {
            port: std::sync::OnceLock::new(),
            sinks,
            sessions: Mutex::new(HashMap::new()),
            active_turns: Mutex::new(HashMap::new()),
            title_set_for_session: Mutex::new(HashSet::new()),
            plan_store: PlanStore::new(),
            persistence,
        });
        let server_for_thread = Arc::clone(&server);
        let (port_tx, port_rx) = std::sync::mpsc::channel::<u16>();

        // Detached dedicated thread: own current-thread tokio runtime so the
        // listener is driven independently of the AcpManager's per-agent
        // driver threads + the desktop's Tauri runtime.
        let _handle: std::thread::JoinHandle<()> = std::thread::Builder::new()
            .name("termul-host-mcp".to_string())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(rt) => rt,
                    Err(e) => {
                        log::error!("[host-mcp] failed to start runtime: {e}");
                        let _ = port_tx.send(0);
                        return;
                    }
                };
                runtime.block_on(async move {
                    let listener = match TcpListener::bind("127.0.0.1:0").await {
                        Ok(l) => l,
                        Err(e) => {
                            log::error!("[host-mcp] bind failed: {e}");
                            let _ = port_tx.send(0);
                            return;
                        }
                    };
                    let port = listener.local_addr().map(|addr| addr.port()).unwrap_or(0);
                    let _ = server_for_thread.port.set(port);
                    let _ = port_tx.send(port);
                    log::info!("[host-mcp] listening on 127.0.0.1:{port}");

                    loop {
                        match listener.accept().await {
                            Ok((stream, peer)) => {
                                let server = Arc::clone(&server_for_thread);
                                tokio::spawn(async move {
                                    if let Err(e) = server.handle_conn(stream).await {
                                        log::warn!(
                                            "[host-mcp] conn from {peer} ended with error: {e}"
                                        );
                                    }
                                });
                            }
                            Err(e) => {
                                // A transient accept failure (e.g. EMFILE) must
                                // not hot-loop. Brief backoff, then retry.
                                log::warn!("[host-mcp] accept failed: {e}");
                                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                            }
                        }
                    }
                });
            })
            .expect("spawn termul-host-mcp thread");

        // Block until the dedicated thread has bound + published the port.
        // (If the thread failed to bind, `port` is 0 — `register_session`
        // will surface a 0 port and the child will fail to connect + log.)
        let _ = port_rx.recv();
        server
    }

    /// Register a session at injection time (before `session/new` is sent).
    /// Returns `(port, token, provisional_session_id)` to inject into the
    /// `McpServer::Stdio` env: `TERMUL_PLAN_PORT`, `TERMUL_PLAN_TOKEN`,
    /// `TERMUL_PLAN_SESSION_ID`.
    ///
    /// The real ACP session_id isn't known yet — call `bind_session` after the
    /// `session/new` response arrives to bind it to the token.
    #[must_use]
    pub fn register_session(&self, agent_id: &str) -> (u16, String, String) {
        let token = Uuid::new_v4().to_string();
        let provisional_sid = Uuid::new_v4().to_string();
        {
            let mut sessions = self.sessions.lock();
            sessions.insert(
                token.clone(),
                SessionAuth {
                    provisional_sid: provisional_sid.clone(),
                    agent_id: agent_id.to_string(),
                    real_session_id: None,
                },
            );
        }
        let port = self.port();
        log::debug!(
            "[host-mcp] registered agent {agent_id} on port {port} (provisional sid {provisional_sid})"
        );
        (port, token, provisional_sid)
    }

    /// Bind the real ACP session_id (returned by `session/new`) to a token.
    /// Called by `AcpManager::new_session_with_context` after the agent
    /// responds. No-op (logged) if the token is unknown (e.g. the session was
    /// for an ephemeral background gen that wasn't registered).
    pub fn bind_session(&self, token: &str, real_session_id: &str) {
        let mut sessions = self.sessions.lock();
        match sessions.get_mut(token) {
            Some(auth) => {
                auth.real_session_id = Some(real_session_id.to_string());
                log::debug!(
                    "[host-mcp] bound token → session {} (agent {})",
                    crate::logging::redact_session_id(real_session_id),
                    auth.agent_id
                );
            }
            None => {
                log::warn!(
                    "[host-mcp] bind_session: unknown token (session {} not registered)",
                    crate::logging::redact_session_id(real_session_id)
                );
            }
        }
    }

    /// Mark an accepted prompt turn as active before the agent can call tools.
    pub fn begin_turn(&self, agent_id: &str, real_session_id: &str) {
        self.active_turns
            .lock()
            .entry(agent_id.to_string())
            .or_default()
            .insert(real_session_id.to_string());
        log::debug!(
            "[host-mcp] registered active plan route for session {} (agent {})",
            crate::logging::redact_session_id(real_session_id),
            agent_id
        );
    }

    /// Remove a completed, rejected-to-start, cancelled, or failed prompt turn.
    pub fn end_turn(&self, agent_id: &str, real_session_id: &str) {
        let mut active_turns = self.active_turns.lock();
        if let Some(sessions) = active_turns.get_mut(agent_id) {
            sessions.remove(real_session_id);
            if sessions.is_empty() {
                active_turns.remove(agent_id);
            }
        }
        log::debug!(
            "[host-mcp] removed active plan route for session {} (agent {})",
            crate::logging::redact_session_id(real_session_id),
            agent_id
        );
    }

    /// Drop a session's auth entry (on close/dispose). Scans by the bound real
    /// session_id. Best-effort — the renderer's `_onPlanUpdate` already guards
    /// closed sessions, so a stale in-flight call is harmless, but evicting
    /// avoids token reuse + bounds the map size.
    pub fn unregister_session(&self, real_session_id: &str) {
        let mut sessions = self.sessions.lock();
        sessions.retain(|_, auth| auth.real_session_id.as_deref() != Some(real_session_id));
        drop(sessions);
        let mut active_turns = self.active_turns.lock();
        active_turns.retain(|_, sessions| {
            sessions.remove(real_session_id);
            !sessions.is_empty()
        });
        drop(active_turns);
        self.title_set_for_session.lock().remove(real_session_id);
        self.plan_store.drop_session(real_session_id);
    }

    /// Drop a registration by token (used when `session/new` fails AFTER
    /// `register_session` but before `bind_session` — the real session_id
    /// isn't known, so `unregister_session` can't be keyed by it).
    pub fn unregister_by_token(&self, token: &str) {
        let real_sid = {
            let mut sessions = self.sessions.lock();
            sessions.remove(token).and_then(|auth| auth.real_session_id)
        };
        if let Some(sid) = real_sid {
            self.plan_store.drop_session(&sid);
        }
    }

    #[must_use]
    pub fn port(&self) -> u16 {
        *self.port.get().unwrap_or(&0)
    }

    /// Handle one child connection: read a single newline-delimited JSON frame
    /// (capped + timeout-bounded so a wedged/idle peer can't grow `line`
    /// unbounded or hold the task open), authenticate, emit the plan_update,
    /// reply. One frame per connection (simplest + robust; localhost TCP
    /// connect is sub-ms).
    async fn handle_conn(self: Arc<Self>, stream: tokio::net::TcpStream) -> std::io::Result<()> {
        let (reader, mut writer) = stream.into_split();
        // Cap the request at 1 MiB so a misbehaving peer can't grow `line`
        // unbounded. The largest plausible plan (hundreds of todos) is well
        // under this.
        const MAX_FRAME: u64 = 1024 * 1024;
        const READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
        let mut reader = BufReader::new(reader.take(MAX_FRAME));

        let mut line = String::new();
        // Bound the read so an idle peer that connects but never sends is
        // dropped instead of holding the task forever.
        let n = match tokio::time::timeout(READ_TIMEOUT, reader.read_line(&mut line)).await {
            Ok(Ok(n)) => n,
            Ok(Err(_)) | Err(_) => return Ok(()),
        };
        if n == 0 {
            return Ok(());
        }

        let reply: FrameReply = match serde_json::from_str::<FrameRequest>(&line) {
            Ok(req) => self.process_request(req).await,
            Err(e) => {
                log::warn!("[host-mcp] malformed frame: {e}");
                FrameReply::err("malformed request")
            }
        };

        // Reply (newline-delimited JSON).
        let mut buf = match serde_json::to_vec(&reply) {
            Ok(v) => v,
            Err(e) => {
                log::error!("[host-mcp] failed to serialize reply: {e}");
                return Ok(());
            }
        };
        buf.push(b'\n');
        writer.write_all(&buf).await?;
        Ok(())
    }

    /// Authenticate + dispatch a validated frame. Returns the reply (ok/err).
    async fn process_request(&self, req: FrameRequest) -> FrameReply {
        // Look up the token. Unknown token = reject (don't disclose which
        // sessions exist — constant-time isn't necessary for localhost-only,
        // but we never echo the token back).
        let auth = {
            let sessions = self.sessions.lock();
            match sessions.get(&req.token) {
                Some(a) => a.clone(),
                None => {
                    log::warn!("[host-mcp] auth rejected (unknown token)");
                    return FrameReply::err("auth rejected");
                }
            }
        };

        // Defense-in-depth: the provisional session_id in the frame must
        // match the one the token was minted with.
        if auth.provisional_sid != req.session_id {
            log::warn!(
                "[host-mcp] auth rejected (provisional sid mismatch): token has {}, frame has {}",
                crate::logging::redact_session_id(&auth.provisional_sid),
                crate::logging::redact_session_id(&req.session_id)
            );
            return FrameReply::err("auth rejected");
        }

        // The real session_id must be bound (post `session/new`). If not, the
        // agent called the tool before the session was created — shouldn't
        // happen, but reject defensively.
        let bound_session_id = match &auth.real_session_id {
            Some(sid) => sid.clone(),
            None => {
                log::warn!(
                    "[host-mcp] dropped call: session not yet bound (provisional {})",
                    auth.provisional_sid
                );
                return FrameReply::err("session not ready");
            }
        };

        // Agents may retain and call an MCP child created for an older session.
        // Prefer the token's bound session when it is active. Otherwise, repair
        // the route only when this runtime agent has exactly one active turn;
        // multiple active sessions are ambiguous and must never cross-route.
        let real_session_id = {
            let active_turns = self.active_turns.lock();
            match active_turns.get(&auth.agent_id) {
                Some(sessions) if sessions.contains(&bound_session_id) => bound_session_id.clone(),
                Some(sessions) if sessions.len() == 1 => {
                    let active_session_id = sessions.iter().next().expect("len checked").clone();
                    log::info!(
                        "[host-mcp] rerouted stale binding for agent {} from session {} to active session {}",
                        auth.agent_id,
                        crate::logging::redact_session_id(&bound_session_id),
                        crate::logging::redact_session_id(&active_session_id)
                    );
                    active_session_id
                }
                Some(sessions) if sessions.len() > 1 => {
                    log::warn!(
                        "[host-mcp] rejected ambiguous stale binding for agent {} (bound session {}, {} active turns)",
                        auth.agent_id,
                        crate::logging::redact_session_id(&bound_session_id),
                        sessions.len()
                    );
                    return FrameReply::err("ambiguous active session");
                }
                _ => {
                    log::warn!(
                        "[host-mcp] rejected tool call for agent {} with no active turn (bound session {})",
                        auth.agent_id,
                        crate::logging::redact_session_id(&bound_session_id)
                    );
                    return FrameReply::err("no active turn");
                }
            }
        };

        match req.kind {
            FrameKind::Plan => {
                if req.title.is_some() {
                    return FrameReply::err("plan frame must not include title");
                }
                let entries = map_todos_to_plan_entries(&req.todos);
                let agent_id = AgentId(auth.agent_id.clone());
                let session_id = SessionId(real_session_id.clone());
                let count = entries.len();
                self.plan_store.set(&real_session_id, entries.clone());
                emit_plan_update(&self.sinks, &agent_id, &session_id, entries);
                log::info!(
                    "[host-mcp] emitted plan_update for session {} ({} entries)",
                    crate::logging::redact_session_id(&session_id.0),
                    count
                );
                FrameReply::ok()
            }
            FrameKind::SetTitle => {
                if !req.todos.is_empty() {
                    return FrameReply::err("title frame must not include todos");
                }
                let Some(title) = req.title else {
                    return FrameReply::err("title is required");
                };
                // Per-session: the first title call wins; subsequent calls for
                // the same session are a success no-op (the agent is told it
                // succeeded so it stops retrying — no churn to the sidebar
                // title, no duplicate persistence records).
                if self.title_set_for_session.lock().contains(&real_session_id) {
                    log::debug!(
                        "[host-mcp] title call no-op: session {} already has a title",
                        crate::logging::redact_session_id(&real_session_id)
                    );
                    return FrameReply::ok();
                }
                let Some(persistence) = self.persistence.as_ref() else {
                    log::warn!("[host-mcp] title call rejected: persistence unavailable");
                    return FrameReply::err("title persistence unavailable");
                };
                match crate::acp::manager::record_local_title(
                    persistence,
                    &self.sinks,
                    AgentId(auth.agent_id),
                    real_session_id.clone(),
                    title,
                )
                .await
                {
                    Ok(()) => {
                        self.title_set_for_session
                            .lock()
                            .insert(real_session_id.clone());
                        FrameReply::ok()
                    }
                    Err(error) => {
                        log::warn!("[host-mcp] title update rejected: {error}");
                        FrameReply::err(error)
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
