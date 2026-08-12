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
                    "[host-mcp] bound token → session {real_session_id} (agent {})",
                    auth.agent_id
                );
            }
            None => {
                log::warn!(
                    "[host-mcp] bind_session: unknown token (session {real_session_id} not registered)"
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
            "[host-mcp] registered active plan route for session {real_session_id} (agent {agent_id})"
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
            "[host-mcp] removed active plan route for session {real_session_id} (agent {agent_id})"
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
                auth.provisional_sid,
                req.session_id
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
                        bound_session_id,
                        active_session_id
                    );
                    active_session_id
                }
                Some(sessions) if sessions.len() > 1 => {
                    log::warn!(
                        "[host-mcp] rejected ambiguous stale binding for agent {} (bound session {}, {} active turns)",
                        auth.agent_id,
                        bound_session_id,
                        sessions.len()
                    );
                    return FrameReply::err("ambiguous active session");
                }
                _ => {
                    log::warn!(
                        "[host-mcp] rejected tool call for agent {} with no active turn (bound session {})",
                        auth.agent_id,
                        bound_session_id
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
                    session_id,
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
                if self
                    .title_set_for_session
                    .lock()
                    .contains(&real_session_id)
                {
                    log::debug!(
                        "[host-mcp] title call no-op: session {real_session_id} already has a title"
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
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpStream;
    use tokio::runtime::Runtime;

    #[derive(Default)]
    struct CapturingSink {
        events: StdMutex<Vec<(String, serde_json::Value)>>,
    }

    impl EventSink for CapturingSink {
        fn emit(&self, event: &crate::web::sink::AcpEvent) {
            if event.type_ == crate::acp::events::EVENT_PLAN_UPDATE
                || event.type_ == crate::acp::events::EVENT_SESSION_INFO_UPDATE
            {
                self.events
                    .lock()
                    .unwrap()
                    .push((event.type_.to_string(), event.payload.clone()));
            }
        }
    }

    async fn connect_and_send(port: u16, frame: &serde_json::Value) -> serde_json::Value {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let mut buf = serde_json::to_vec(frame).unwrap();
        buf.push(b'\n');
        stream.write_all(&buf).await.unwrap();
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        serde_json::from_str(&line).unwrap_or(serde_json::Value::Null)
    }

    #[test]
    fn register_returns_valid_port_token_provisional() {
        let server = HostPlanServer::start(vec![], None);
        let (port, token, provisional) = server.register_session("agent-1");
        assert!(port > 0, "port must be bound by the dedicated thread");
        assert!(!token.is_empty());
        assert!(!provisional.is_empty());
        assert_ne!(token, provisional, "token and provisional sid must differ");
    }

    #[test]
    fn unbound_call_is_rejected_before_bind() {
        // Before `bind_session` is called, the real session_id is unknown — a
        // call arriving in that window is rejected (the agent can't legally
        // call tools before `session/new` returns, but we defend anyway).
        let server = HostPlanServer::start(vec![Arc::new(CapturingSink::default())], None);
        let (port, token, provisional) = server.register_session("agent-1");
        let runtime = Runtime::new().unwrap();
        runtime.block_on(async move {
            let frame = serde_json::json!({
                "token": token,
                "session_id": provisional,
                "kind": "plan",
                "todos": [{"content": "x"}],
            });
            let reply = connect_and_send(port, &frame).await;
            assert_eq!(reply["ok"], false);
            assert_eq!(reply["error"], "session not ready");
        });
    }

    #[test]
    fn token_provisional_mismatch_is_rejected() {
        // A valid token paired with the wrong provisional session_id is
        // rejected (defense-in-depth against a leaked token + guessed sid).
        let server = HostPlanServer::start(vec![Arc::new(CapturingSink::default())], None);
        let (port, token, _provisional) = server.register_session("agent-1");
        let runtime = Runtime::new().unwrap();
        runtime.block_on(async move {
            let frame = serde_json::json!({
                "token": token,
                "session_id": "wrong-provisional",
                "kind": "plan",
                "todos": [{"content": "x"}],
            });
            let reply = connect_and_send(port, &frame).await;
            assert_eq!(reply["ok"], false);
            assert_eq!(reply["error"], "auth rejected");
        });
    }

    #[test]
    fn bound_session_emits_plan_update() {
        let sink = Arc::new(CapturingSink::default());
        let server = HostPlanServer::start(vec![sink.clone()], None);
        let (port, token, provisional) = server.register_session("agent-1");
        server.bind_session(&token, "sess-real");
        server.begin_turn("agent-1", "sess-real");

        let runtime = Runtime::new().unwrap();
        runtime.block_on(async move {
            let frame = serde_json::json!({
                "token": token,
                "session_id": provisional,
                "kind": "plan",
                "todos": [
                    {"content": "one"},
                    {"content": "two", "status": "in_progress", "priority": "high"},
                ],
            });
            let reply = connect_and_send(port, &frame).await;
            assert_eq!(reply["ok"], true);
        });
        let captured = sink.events.lock().unwrap();
        assert_eq!(captured.len(), 1, "exactly one plan_update must be emitted");
        assert_eq!(captured[0].1["sessionId"], "sess-real");
    }

    #[test]
    fn bound_session_without_an_active_turn_is_rejected() {
        let sink = Arc::new(CapturingSink::default());
        let server = HostPlanServer::start(vec![sink.clone()], None);
        let (port, token, provisional) = server.register_session("agent-1");
        server.bind_session(&token, "sess-real");

        let runtime = Runtime::new().unwrap();
        runtime.block_on(async move {
            let frame = serde_json::json!({
                "token": token,
                "session_id": provisional,
                "todos": [{"content": "late work"}],
            });
            let reply = connect_and_send(port, &frame).await;
            assert_eq!(reply["ok"], false);
            assert_eq!(reply["error"], "no active turn");
        });

        assert!(sink.events.lock().unwrap().is_empty());
    }

    #[test]
    fn stale_binding_routes_to_the_agents_only_active_turn() {
        let sink = Arc::new(CapturingSink::default());
        let server = HostPlanServer::start(vec![sink.clone()], None);
        let (port, token, provisional) = server.register_session("agent-1");
        server.bind_session(&token, "sess-old");
        server.begin_turn("agent-1", "sess-current");

        let runtime = Runtime::new().unwrap();
        runtime.block_on(async move {
            let frame = serde_json::json!({
                "token": token,
                "session_id": provisional,
                "todos": [{"content": "current work"}],
            });
            let reply = connect_and_send(port, &frame).await;
            assert_eq!(reply["ok"], true);
        });

        let captured = sink.events.lock().unwrap();
        assert_eq!(captured.len(), 1);
        assert_eq!(captured[0].1["sessionId"], "sess-current");
        assert!(server.plan_store.get("sess-old").is_none());
        assert_eq!(server.plan_store.get("sess-current").unwrap().len(), 1);
    }

    #[test]
    fn bound_active_session_wins_when_agent_has_multiple_active_turns() {
        let sink = Arc::new(CapturingSink::default());
        let server = HostPlanServer::start(vec![sink.clone()], None);
        let (port, token, provisional) = server.register_session("agent-1");
        server.bind_session(&token, "sess-bound");
        server.begin_turn("agent-1", "sess-bound");
        server.begin_turn("agent-1", "sess-other");

        let runtime = Runtime::new().unwrap();
        runtime.block_on(async move {
            let frame = serde_json::json!({
                "token": token,
                "session_id": provisional,
                "todos": [{"content": "bound work"}],
            });
            let reply = connect_and_send(port, &frame).await;
            assert_eq!(reply["ok"], true);
        });

        let captured = sink.events.lock().unwrap();
        assert_eq!(captured[0].1["sessionId"], "sess-bound");
    }

    #[test]
    fn ambiguous_stale_binding_is_rejected_instead_of_cross_routed() {
        let sink = Arc::new(CapturingSink::default());
        let server = HostPlanServer::start(vec![sink.clone()], None);
        let (port, token, provisional) = server.register_session("agent-1");
        server.bind_session(&token, "sess-old");
        server.begin_turn("agent-1", "sess-a");
        server.begin_turn("agent-1", "sess-b");

        let runtime = Runtime::new().unwrap();
        runtime.block_on(async move {
            let frame = serde_json::json!({
                "token": token,
                "session_id": provisional,
                "todos": [{"content": "ambiguous work"}],
            });
            let reply = connect_and_send(port, &frame).await;
            assert_eq!(reply["ok"], false);
            assert_eq!(reply["error"], "ambiguous active session");
        });

        assert!(sink.events.lock().unwrap().is_empty());
    }

    #[test]
    fn end_turn_removes_routing_candidate() {
        let server = HostPlanServer::start(vec![], None);
        server.begin_turn("agent-1", "sess-current");
        server.end_turn("agent-1", "sess-current");
        assert!(server.active_turns.lock().get("agent-1").is_none());
    }

    #[test]
    fn bad_token_alone_is_rejected() {
        // Unknown token — rejected even with a plausible provisional sid.
        let server = HostPlanServer::start(vec![Arc::new(CapturingSink::default())], None);
        let (port, _token, _provisional) = server.register_session("agent-1");
        let runtime = Runtime::new().unwrap();
        runtime.block_on(async move {
            let frame = serde_json::json!({
                "token": "bogus-token",
                "session_id": "bogus-sid",
                "kind": "plan",
                "todos": [{"content": "x"}],
            });
            let reply = connect_and_send(port, &frame).await;
            assert_eq!(reply["ok"], false);
            assert_eq!(reply["error"], "auth rejected");
        });
    }

    #[test]
    fn bound_title_call_persists_and_broadcasts() {
        let root =
            std::env::temp_dir().join(format!("termul-host-mcp-title-{}", uuid::Uuid::new_v4()));
        let cwd = root.join("cwd");
        std::fs::create_dir_all(&cwd).unwrap();
        let runtime = Runtime::new().unwrap();
        runtime.block_on(async move {
            let persistence = Arc::new(SessionPersistence::open(root.join("store")).await.unwrap());
            persistence
                .register_session(crate::acp::SessionRegistration {
                    session_id: "sess-real".into(),
                    stable_agent_namespace: Some("config:test".into()),
                    runtime_agent_id: Some("agent-1".into()),
                    project_id: None,
                    cwd,
                    ..Default::default()
                })
                .await
                .unwrap();
            let sink = Arc::new(CapturingSink::default());
            let server = HostPlanServer::start(vec![sink.clone()], Some(Arc::clone(&persistence)));
            let (port, token, provisional) = server.register_session("agent-1");
            server.bind_session(&token, "sess-real");
            server.begin_turn("agent-1", "sess-real");
            let frame = serde_json::json!({
                "token": token,
                "session_id": provisional,
                "kind": "set_title",
                "title": "**Fix login bug**\nignored",
            });
            let reply = connect_and_send(port, &frame).await;
            assert_eq!(reply["ok"], true);
            let metadata = persistence.metadata("sess-real").unwrap();
            assert_eq!(metadata.title.as_deref(), Some("Fix login bug"));
            assert_eq!(
                metadata.title_source,
                Some(crate::acp::session_persistence::TitleSource::BackgroundGenerated)
            );
            let records = persistence.replay_after("sess-real", 0).unwrap();
            assert!(records
                .iter()
                .any(|record| record.type_ == "local_title_generated"));
            assert_eq!(sink.events.lock().unwrap().len(), 1);
            persistence.shutdown().await.unwrap();
            let _ = std::fs::remove_dir_all(root);
        });
    }

    #[test]
    fn second_title_call_same_session_is_success_noop() {
        // Per-session enforcement: after the first call sets the title, a
        // second call for the same session must return `ok` (so the agent
        // stops retrying) without writing a second persistence record or
        // emitting a second session_info_update.
        let root = std::env::temp_dir()
            .join(format!("termul-host-mcp-title-noop-{}", uuid::Uuid::new_v4()));
        let cwd = root.join("cwd");
        std::fs::create_dir_all(&cwd).unwrap();
        let runtime = Runtime::new().unwrap();
        runtime.block_on(async move {
            let persistence =
                Arc::new(SessionPersistence::open(root.join("store")).await.unwrap());
            persistence
                .register_session(crate::acp::SessionRegistration {
                    session_id: "sess-real".into(),
                    stable_agent_namespace: Some("config:test".into()),
                    runtime_agent_id: Some("agent-1".into()),
                    project_id: None,
                    cwd,
                    ..Default::default()
                })
                .await
                .unwrap();
            let sink = Arc::new(CapturingSink::default());
            let server =
                HostPlanServer::start(vec![sink.clone()], Some(Arc::clone(&persistence)));
            let (port, token, provisional) = server.register_session("agent-1");
            server.bind_session(&token, "sess-real");
            server.begin_turn("agent-1", "sess-real");

            let first = serde_json::json!({
                "token": token,
                "session_id": provisional,
                "kind": "set_title",
                "title": "First title",
            });
            let reply = connect_and_send(port, &first).await;
            assert_eq!(reply["ok"], true);
            let events_after_first = sink.events.lock().unwrap().len();

            let second = serde_json::json!({
                "token": token,
                "session_id": provisional,
                "kind": "set_title",
                "title": "Should be ignored",
            });
            let reply = connect_and_send(port, &second).await;
            assert_eq!(reply["ok"], true, "repeat title call must succeed (no-op)");

            // No second event + title unchanged + no second record.
            assert_eq!(
                sink.events.lock().unwrap().len(),
                events_after_first,
                "no second session_info_update"
            );
            let metadata = persistence.metadata("sess-real").unwrap();
            assert_eq!(metadata.title.as_deref(), Some("First title"));
            let title_records = persistence
                .replay_after("sess-real", 0)
                .unwrap()
                .iter()
                .filter(|r| r.type_ == "local_title_generated")
                .count();
            assert_eq!(title_records, 1, "no duplicate title persistence record");
            persistence.shutdown().await.unwrap();
            let _ = std::fs::remove_dir_all(root);
        });
    }

    #[test]
    fn title_per_session_flag_survives_a_new_turn() {
        // Per-session (not per-turn): `end_turn` + `begin_turn` for a 2nd turn
        // must NOT reset the title flag — the agent can't set the title again
        // on a later turn.
        let root = std::env::temp_dir()
            .join(format!("termul-host-mcp-title-turn-{}", uuid::Uuid::new_v4()));
        let cwd = root.join("cwd");
        std::fs::create_dir_all(&cwd).unwrap();
        let runtime = Runtime::new().unwrap();
        runtime.block_on(async move {
            let persistence =
                Arc::new(SessionPersistence::open(root.join("store")).await.unwrap());
            persistence
                .register_session(crate::acp::SessionRegistration {
                    session_id: "sess-real".into(),
                    stable_agent_namespace: Some("config:test".into()),
                    runtime_agent_id: Some("agent-1".into()),
                    project_id: None,
                    cwd,
                    ..Default::default()
                })
                .await
                .unwrap();
            let sink = Arc::new(CapturingSink::default());
            let server =
                HostPlanServer::start(vec![sink.clone()], Some(Arc::clone(&persistence)));
            let (port, token, provisional) = server.register_session("agent-1");
            server.bind_session(&token, "sess-real");
            server.begin_turn("agent-1", "sess-real");

            let first = serde_json::json!({
                "token": token,
                "session_id": provisional,
                "kind": "set_title",
                "title": "Turn 1 title",
            });
            assert_eq!(connect_and_send(port, &first).await["ok"], true);

            // End the turn + start a fresh turn (mirrors a 2nd user prompt).
            server.end_turn("agent-1", "sess-real");
            server.begin_turn("agent-1", "sess-real");

            let second = serde_json::json!({
                "token": token,
                "session_id": provisional,
                "kind": "set_title",
                "title": "Turn 2 title",
            });
            let reply = connect_and_send(port, &second).await;
            assert_eq!(reply["ok"], true, "2nd-turn title call must succeed (no-op)");
            let metadata = persistence.metadata("sess-real").unwrap();
            assert_eq!(
                metadata.title.as_deref(),
                Some("Turn 1 title"),
                "title must NOT change on a later turn"
            );
            persistence.shutdown().await.unwrap();
            let _ = std::fs::remove_dir_all(root);
        });
    }
}
