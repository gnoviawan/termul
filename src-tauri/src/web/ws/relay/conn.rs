//! Per-connection state and the read loop's per-frame dispatch (AD-19).
//!
//! [`ConnState`] is owned by the read loop: the authed flag, identity and
//! capabilities change only there, so the loop evaluates the pre-auth gate and
//! the capability check itself and hands the request to the executor already
//! validated. Request tasks share only the [`Subscriptions`] (short,
//! never-awaited locks) and the cloneable [`HandlerEnv`].

use crate::web::presence::PresenceGuard;

use super::super::*;
use super::executor::{entity_key, KeyedExecutor, MAX_INFLIGHT_REQUESTS};
use super::outbound::OutboundSender;

/// The `(session, client)` registrations a connection made through `subscribe`
/// / `open_persisted_session` / `recover_session_snapshot`, released on
/// disconnect. Shared between request tasks and the cleanup; every method
/// takes the lock briefly and never across an await.
#[derive(Default)]
pub(crate) struct Subscriptions {
    entries: parking_lot::Mutex<Vec<(String, ClientId)>>,
}

impl Subscriptions {
    /// This connection's current registrations for `session_id`.
    pub(crate) fn clients_for(&self, session_id: &str) -> Vec<ClientId> {
        self.entries
            .lock()
            .iter()
            .filter(|(sid, _)| sid == session_id)
            .map(|(_, client_id)| *client_id)
            .collect()
    }

    /// Record `client_id` for `session_id` and drop the `prior` registrations
    /// of that session; returns the dropped ids, which the caller unsubscribes.
    pub(crate) fn replace(
        &self,
        session_id: &str,
        prior: &[ClientId],
        client_id: ClientId,
    ) -> Vec<ClientId> {
        let mut entries = self.entries.lock();
        let mut dropped = Vec::new();
        entries.retain(|(sid, cid)| {
            let stale = sid == session_id && prior.contains(cid);
            if stale {
                dropped.push(*cid);
            }
            !stale
        });
        entries.push((session_id.to_string(), client_id));
        dropped
    }

    /// Forget every registration of `session_id`; returns the ids to
    /// unsubscribe.
    pub(crate) fn remove_session(&self, session_id: &str) -> Vec<ClientId> {
        let mut entries = self.entries.lock();
        let mut removed = Vec::new();
        entries.retain(|(sid, cid)| {
            let hit = sid == session_id;
            if hit {
                removed.push(*cid);
            }
            !hit
        });
        removed
    }

    /// Take every registration (connection teardown).
    pub(crate) fn take_all(&self) -> Vec<(String, ClientId)> {
        std::mem::take(&mut *self.entries.lock())
    }

    #[cfg(test)]
    pub(crate) fn is_empty(&self) -> bool {
        self.entries.lock().is_empty()
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.entries.lock().len()
    }
}

/// Everything the read loop knows about its connection.
pub(in crate::web::ws) struct ConnState {
    /// Set once by a successful `authenticate`.
    pub(in crate::web::ws) authed: bool,
    /// The validated `authenticate` identity (AD-4).
    pub(in crate::web::ws) identity: Option<ClientIdentity>,
    /// Capabilities resolved at `authenticate`, plus the connection's id.
    pub(in crate::web::ws) access: ConnectionAccess,
    /// Registered subscriptions, shared with request tasks and the cleanup.
    pub(in crate::web::ws) subscriptions: Arc<Subscriptions>,
    /// Device presence, held for the connection's life: dropped with the read
    /// loop, so presence goes away exactly when the connection does.
    presence: Option<PresenceGuard>,
}

impl ConnState {
    pub(in crate::web::ws) fn new(access: ConnectionAccess, subscriptions: Arc<Subscriptions>) -> Self {
        Self {
            authed: false,
            identity: None,
            access,
            subscriptions,
            presence: None,
        }
    }

    /// A connection that already passed `authenticate` (tests that skip the
    /// handshake).
    #[cfg(test)]
    pub(in crate::web::ws) fn authenticated(access: ConnectionAccess) -> Self {
        let mut conn = Self::new(access, Arc::new(Subscriptions::default()));
        conn.authed = true;
        conn
    }
}

/// What a request handler needs from the host, cloned into each request task.
#[derive(Clone)]
pub(in crate::web::ws) struct HandlerEnv {
    pub(in crate::web::ws) acp: Arc<AcpManager>,
    pub(in crate::web::ws) relay: Arc<WsRelaySink>,
    pub(in crate::web::ws) registry: Arc<ProjectRegistry>,
    pub(in crate::web::ws) registry_persistence: Option<Arc<parking_lot::Mutex<FileProjectRegistry>>>,
    pub(in crate::web::ws) projects_file: Option<Arc<PathBuf>>,
    pub(in crate::web::ws) history_mode: HistoryMode,
    pub(in crate::web::ws) acp_catalog: Option<Arc<crate::acp::AcpCatalogService>>,
    pub(in crate::web::ws) acp_install: Option<Arc<crate::acp::install::AcpInstallService>>,
    pub(in crate::web::ws) store: Option<Arc<WebStore>>,
    pub(in crate::web::ws) web_auth: Option<Arc<WebAuth>>,
    /// This connection's outbound queue.
    pub(in crate::web::ws) out_tx: OutboundSender,
    pub(in crate::web::ws) subscriptions: Arc<Subscriptions>,
    /// Attributes ticket answers (first-wins) to this connection.
    pub(in crate::web::ws) connection_id: ClientId,
}

impl HandlerEnv {
    pub(in crate::web::ws) fn new(
        state: &AppState,
        out_tx: OutboundSender,
        conn: &ConnState,
    ) -> Self {
        Self {
            acp: Arc::clone(&state.acp),
            relay: Arc::clone(&state.relay),
            registry: Arc::clone(&state.registry),
            registry_persistence: state.registry_persistence.clone(),
            projects_file: state.projects_file.clone(),
            history_mode: state.history_mode,
            acp_catalog: state.acp_catalog.clone(),
            acp_install: state.acp_install.clone(),
            store: state.store.clone(),
            web_auth: state.web_auth.clone(),
            out_tx,
            subscriptions: Arc::clone(&conn.subscriptions),
            connection_id: conn.access.connection_id(),
        }
    }
}

/// Route one text frame. Pre-auth, only `authenticate` is served (inline: it
/// awaits nothing slow). Post-auth the frame is validated here — the
/// required-capability check runs before any handler — and handed to the
/// executor; this function never awaits a handler. Returns `false` once the
/// connection is closing.
pub(in crate::web::ws) async fn dispatch_connection_text(
    text: &str,
    conn: &mut ConnState,
    env: &HandlerEnv,
    exec: &KeyedExecutor,
) -> bool {
    let request: WsRequest = match serde_json::from_str(text) {
        Ok(request) => request,
        Err(error) => {
            return env
                .out_tx
                .reply(WsReply::err(
                    "malformed",
                    WsErrorCode::Unsupported,
                    format!("malformed request frame: {error}"),
                ))
                .await;
        }
    };
    if !conn.authed {
        let reply = pre_auth_reply(&request, conn, env);
        return env.out_tx.reply(reply).await;
    }
    // A view-only connection is refused every mutation before any handler
    // runs.
    if let Some(reply) = forbidden_reply(
        &request.id,
        &request.type_,
        &request.payload,
        &conn.access,
        conn.identity.as_ref(),
    ) {
        return env.out_tx.reply(reply).await;
    }
    let key = entity_key(&request);
    let id = request.id.clone();
    let job_env = env.clone();
    let submitted = exec.submit(key, async move {
        run_request(request, job_env).await;
    });
    if submitted.is_err() {
        warn!(
            target: "termul::web::ws",
            request_id = %id,
            "/ws request refused: too many requests in flight on this connection"
        );
        return env
            .out_tx
            // Not `rate_limited`: the client reads that code as "a prompt turn
            // is already in progress" and silently queues the prompt.
            .reply(WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!(
                    "too many requests in flight on this connection (limit {MAX_INFLIGHT_REQUESTS})"
                ),
            ))
            .await;
    }
    true
}

/// Execute one validated request and deliver its reply (reliably: queued, or
/// the connection closes). `send_prompt` keeps its fast path: the turn is
/// accepted in order with the session's other requests, but its (long)
/// completion runs on its own task, so `cancel_prompt` queued behind the
/// acceptance is not held for the whole turn.
async fn run_request(request: WsRequest, env: HandlerEnv) {
    if request.type_ == "send_prompt" {
        // `turnId` is the prompt's commandId; `TurnWatermark` is its ledger.
        let payload = match prompt_payload_with_turn_id(&request) {
            Ok(payload) => payload,
            Err(reply) => {
                env.out_tx.reply(reply).await;
                return;
            }
        };
        match accept_send_prompt(request.id, &payload, &env.acp, &env.relay).await {
            Ok(accepted) => {
                let acp = Arc::clone(&env.acp);
                let out_tx = env.out_tx;
                tokio::spawn(async move {
                    let reply = complete_send_prompt(accepted, &acp).await;
                    out_tx.reply(reply).await;
                });
            }
            Err(reply) => {
                env.out_tx.reply(reply).await;
            }
        }
        return;
    }
    // The single admission site: a `commandId` is recorded before the
    // handler runs (after the capability check the read loop already made).
    let reply = execute_request(request, &env).await;
    env.out_tx.reply(reply).await;
}

/// The pre-auth gate (AC9): only `authenticate` is allowed; everything else is
/// `unauthorized`.
fn pre_auth_reply(request: &WsRequest, conn: &mut ConnState, env: &HandlerEnv) -> WsReply {
    let id = request.id.clone();
    if request.type_ != "authenticate" {
        return WsReply::err(
            id,
            WsErrorCode::Unauthorized,
            "pre-auth: send an `authenticate` request first",
        );
    }
    // Handshake checks run FIRST — on gated and ungated hosts alike — so a
    // stale tab learns it must reload even when its token is also wrong. A
    // refusal leaves the connection pre-auth.
    let validated = match validate_authenticate_handshake(&request.payload) {
        Ok(validated) => validated,
        Err(refusal) => {
            warn!(
                target: "termul::web::ws",
                request_id = %request.id,
                check = refusal.check,
                code = refusal.code.as_str(),
                "/ws authenticate refused (handshake check failed)"
            );
            return WsReply::err(id, refusal.code, refusal.message);
        }
    };
    // CAP-1 interim (Story 1): when the server runs gated, validate the
    // presented token in constant time BEFORE marking authed. A wrong/absent
    // token is refused `unauthorized`; the connection stays pre-auth and open so
    // the client may retry. Ungated servers (`web_auth: None`) accept any token
    // once the handshake checks pass.
    if let Some(gate) = env.web_auth.as_deref() {
        let presented = request.payload["token"].as_str().unwrap_or("");
        if !gate.accepts(presented) {
            // Durable boundary event (AGENTS.md logging policy). NEVER log the
            // presented token — only that the gate refused.
            warn!(
                target: "termul::web::ws",
                request_id = %request.id,
                token_presented = !presented.is_empty(),
                "web auth gate refused /ws authenticate (invalid or missing token)"
            );
            return WsReply::err(id, WsErrorCode::Unauthorized, "invalid or missing auth token");
        }
    }
    info!(
        target: "termul::web::ws",
        request_id = %request.id,
        device_id = %ClientIdentity::log_label(&validated.device_id),
        client_instance_id = %ClientIdentity::log_label(&validated.client_instance_id),
        "/ws connection authenticated"
    );
    // Capabilities are resolved ONCE, here (carrier + deployment flags + peer),
    // and the device joins presence.
    conn.access.grant();
    conn.presence = Some(env.relay.presence().register(&validated, conn.access.carrier()));
    conn.identity = Some(validated);
    conn.authed = true;
    WsReply::ok(
        id,
        Some(json!({
            "historyMode": env.history_mode,
            "runtimePolicy": RuntimePolicy::resolved(),
            "protocolVersion": WS_PROTOCOL_VERSION,
        })),
    )
}
