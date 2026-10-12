//! Dedicated interactive terminal websocket.
//!
//! This endpoint intentionally stays separate from the ACP relay. A fresh
//! connection is never implicitly authed: it must send
//! `authenticate{protocolVersion, deviceId, clientInstanceId, token?}` before
//! any other request, gated or not. The version/identity checks run first
//! (`PROTOCOL_VERSION_MISMATCH` / `INVALID_CLIENT_IDENTITY`); then, when the
//! server runs with the web auth gate (`AppState.web_auth = Some` — public
//! bind or explicit token, see `web::auth::resolve`), the token must match.
//! Every pre-auth op is refused with the single generic `UNAUTHORIZED` and
//! spawns no PTY; an ungated server accepts any token once the handshake
//! checks pass. Beyond the connection gate, all operations are
//! project-scoped: a connection may only interact with terminals whose
//! `project_id` it has been authorized for via spawn or explicit attach.

use parking_lot::RwLock;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::pty::manager::{PtyManager, SpawnOptions};
use crate::web::capabilities::{
    terminal_request_is_view, Capabilities, CapabilityPolicy, Carrier,
};
use crate::web::presence::PresenceGuard;
use crate::web::ws::{validate_authenticate_handshake, AppState, ClientIdentity};

const MAX_RECONNECT_FRAMES: usize = 64;
/// #851: sequential per-connection id source for the size-owner marker.
static NEXT_CONNECTION_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    id: String,
    #[serde(rename = "type")]
    type_: String,
    #[serde(default)]
    payload: Value,
}

/// The peer address (`ConnectInfo`) feeds the connection's capabilities,
/// resolved at `authenticate`; the router MUST be served with
/// `into_make_service_with_connect_info::<SocketAddr>()`.
pub async fn terminal_ws_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| run(socket, state, peer))
}

async fn run(socket: WebSocket, state: AppState, peer: SocketAddr) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::channel::<Message>(MAX_RECONNECT_FRAMES);

    let write_task = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            if sink.send(message).await.is_err() {
                break;
            }
        }
    });

    // Per-connection authorization: terminal IDs this socket may operate on.
    // Shared with the event-forwarding task so it can see updates.
    let authorized: Arc<RwLock<HashSet<String>>> = Arc::new(RwLock::new(HashSet::new()));
    // #851: per-connection client id (opaque, sequential) — identifies the
    // connection for the "single size owner" (last writer wins) marker and
    // logs. Never exposed to the peer.
    let client_id = format!("termconn-{}", NEXT_CONNECTION_ID.fetch_add(1, Ordering::Relaxed));
    // Per-terminal output forwarding tasks.
    let attachments: HashMap<String, Attachment> = HashMap::new();

    if state.web_auth.is_some() {
        info!("[terminal-ws] client connected (web auth gate ON — token + handshake required)");
    } else {
        info!("[terminal-ws] client connected (ungated — handshake required)");
    }

    let event_tx = tx.clone();
    let event_state = state.clone();
    let event_authorized = authorized.clone();
    let mut event_rx = event_state.terminal_events.subscribe();
    let event_task = tokio::spawn(async move {
        loop {
            match event_rx.recv().await {
                Ok(event) => {
                    let terminal_id = event.terminal_id().to_string();
                    // Only forward events for terminals this connection is
                    // authorized to see.
                    if !event_authorized.read().contains(&terminal_id) {
                        continue;
                    }
                    let payload = serde_json::to_value(&event).unwrap_or_else(|_| json!({}));
                    if send_json(&event_tx, json!({ "type": "event", "payload": payload }))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    warn!("[terminal-ws] lifecycle event receiver lagged by {skipped}");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    let mut ctx = ConnectionContext {
        authorized: authorized.clone(),
        attachments,
        // Every connection starts un-authed, gated or not; only a valid
        // `authenticate` handshake flips it.
        authed: false,
        identity: None,
        // Capabilities are resolved ONCE, at `authenticate`.
        capabilities: Capabilities::none(Carrier::TerminalWs),
        capability_policy: CapabilityPolicy::for_connection(Carrier::TerminalWs, peer, &state),
        presence: None,
        // #851: opaque per-connection id for the size-owner marker.
        client_id,
    };

    while let Some(frame) = stream.next().await {
        let Ok(message) = frame else { break };
        let Message::Text(text) = message else {
            continue;
        };
        let request = match serde_json::from_str::<Request>(&text) {
            Ok(request) => request,
            Err(error) => {
                let _ = send_error(&tx, "malformed", "VALIDATION_ERROR", error.to_string()).await;
                continue;
            }
        };
        let id = request.id.clone();
        let op_type = request.type_.clone();
        info!("[terminal-ws] request start type={op_type} id={id}");
        match handle(request, &state, &tx, &mut ctx).await {
            Ok(data) => {
                info!("[terminal-ws] request success type={op_type} id={id}");
                let _ = send_json(&tx, json!({ "id": id, "success": true, "data": data })).await;
            }
            Err((code, message)) => {
                warn!("[terminal-ws] request failed type={op_type} id={id} code={code}");
                let _ = send_error(&tx, &id, code, message).await;
            }
        }
    }

    // Cleanup: abort all output forwarding tasks. PTYs are preserved.
    event_task.abort();
    ctx.release_all(&state);
    info!(
        "[terminal-ws] client disconnected; {} PTY(s) preserved",
        ctx.authorized.read().len()
    );
    drop(tx);
    let _ = write_task.await;
}

/// A live output-forwarding attachment: the forwarder task plus the one-shot
/// release of its `web_attachments` count. Every path that ends an attachment
/// (forwarder exit, re-attach replacement, detach/rotate/revoke, connection
/// cleanup) goes through [`AttachmentRelease::release`], so the count is
/// decremented exactly once per attach — never twice for a forwarder that
/// self-released before cleanup ran, and never for another viewer's attach.
struct Attachment {
    task: tokio::task::JoinHandle<()>,
    release: AttachmentRelease,
}

impl Attachment {
    /// Abort the forwarder and release its attachment count (idempotent).
    fn end(self, pty: &PtyManager, terminal_id: &str) {
        self.task.abort();
        self.release.release(pty, terminal_id);
    }
}

/// Exactly-once release flag shared between an [`Attachment`] and its
/// forwarder task.
#[derive(Clone, Default)]
struct AttachmentRelease(Arc<AtomicBool>);

impl AttachmentRelease {
    fn release(&self, pty: &PtyManager, terminal_id: &str) {
        if !self.0.swap(true, Ordering::AcqRel) {
            if let Some(instance) = pty.get(terminal_id) {
                instance.remove_web_attachment();
            }
        }
    }
}

/// Owns a freshly taken `web_attachments` count between `add_web_attachment`
/// and the moment the forwarder's [`Attachment`] is registered. Dropping it
/// while still armed (early error return, failed replay send, or the
/// connection task being cancelled mid-`await`) releases the count through the
/// shared exactly-once [`AttachmentRelease`].
struct PendingAttachCount {
    release: AttachmentRelease,
    pty: Arc<PtyManager>,
    terminal_id: String,
    armed: bool,
}

impl Drop for PendingAttachCount {
    fn drop(&mut self) {
        if self.armed {
            self.release.release(&self.pty, &self.terminal_id);
        }
    }
}

struct ConnectionContext {
    /// Terminal IDs this connection is authorized to operate on.
    authorized: Arc<RwLock<HashSet<String>>>,
    /// Per-terminal output forwarding attachments (terminal_id -> attachment).
    attachments: HashMap<String, Attachment>,
    /// Whether this connection has completed a valid `authenticate`
    /// handshake. Every connection starts un-authed, gated or not; only a
    /// valid `authenticate` flips it.
    authed: bool,
    /// Identity validated by the `authenticate` handshake (AD-4), kept
    /// exactly as received.
    identity: Option<ClientIdentity>,
    /// What this connection may do; none until `authenticate` succeeds.
    capabilities: Capabilities,
    /// Carrier + deployment flags + peer, resolved into `capabilities` once.
    capability_policy: CapabilityPolicy,
    /// Device presence registration, held for the connection's lifetime.
    presence: Option<PresenceGuard>,
    /// #851: opaque per-connection id (see `NEXT_CONNECTION_ID`) used for
    /// the single-size-owner marker on write/resize.
    client_id: String,
}

/// Pure connection-gate decision for an incoming request (unit-testable
/// without a live socket). `authenticate` is ALWAYS routed (it is the way
/// in); every other request requires an authed connection — pre-auth ops are
/// refused with the single generic `UNAUTHORIZED` before any handler runs
/// (so a pre-auth `spawn` never creates a PTY).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConnectionGate {
    /// Route to the `authenticate` handling (token validation / no-op).
    Authenticate,
    /// Proceed to the normal request arms.
    Allow,
    /// Refuse pre-auth: `("UNAUTHORIZED", "Unauthorized")`.
    Refuse,
}

fn connection_gate(authed: bool, request_type: &str) -> ConnectionGate {
    if request_type == "authenticate" {
        ConnectionGate::Authenticate
    } else if authed {
        ConnectionGate::Allow
    } else {
        ConnectionGate::Refuse
    }
}

impl ConnectionContext {
    fn authorize(&mut self, terminal_id: &str) {
        self.authorized.write().insert(terminal_id.to_string());
    }

    fn is_authorized(&self, terminal_id: &str) -> bool {
        self.authorized.read().contains(terminal_id)
    }

    fn detach(&mut self, terminal_id: &str, state: &AppState) {
        // The aborted forwarder never reaches its own release path — end()
        // releases the live-attachment accounting (rotate/revoke tear-down;
        // the claim is already invalid, but accounting must stay balanced
        // for `list_preserved` skip decisions).
        if let Some(attachment) = self.attachments.remove(terminal_id) {
            attachment.end(&state.pty, terminal_id);
        }
        self.authorized.write().remove(terminal_id);
    }

    /// Connection teardown: end every attachment, releasing each exactly once
    /// so a later `list_preserved` can reissue claims for this connection's
    /// terminals (CodeRabbit: preserve live attachments when reissuing claims).
    fn release_all(&mut self, state: &AppState) {
        for (terminal_id, attachment) in self.attachments.drain() {
            attachment.end(&state.pty, &terminal_id);
        }
    }
}

async fn handle(
    request: Request,
    state: &AppState,
    tx: &mpsc::Sender<Message>,
    ctx: &mut ConnectionContext,
) -> Result<Value, (&'static str, String)> {
    let gate = connection_gate(ctx.authed, request.type_.as_str());
    // Required-capability check before any handler arm: a view-only
    // connection may attach/read but never mutate (spawn, write, resize,
    // kill, claims, renderer refs, protection, orphan detection).
    if gate == ConnectionGate::Allow
        && !ctx.capabilities.write
        && !terminal_request_is_view(request.type_.as_str())
    {
        warn!(
            "[terminal-ws] request refused type={} id={} (view-only connection)",
            request.type_, request.id
        );
        return Err((FORBIDDEN_CODE, forbidden_message(&request.type_)));
    }
    match gate {
        ConnectionGate::Refuse => Err(("UNAUTHORIZED", "Unauthorized".to_string())),
        ConnectionGate::Authenticate => {
            // Already authed: idempotent success, no re-validation.
            if ctx.authed {
                return Ok(json!({}));
            }
            // Handshake checks run FIRST (gated and ungated alike) so a stale
            // tab learns it must reload even when its token is also wrong.
            let identity = validate_authenticate_handshake(&request.payload).map_err(|refusal| {
                warn!(
                    "[terminal-ws] authenticate rejected id={} check={} code={}",
                    request.id,
                    refusal.check,
                    refusal.terminal_code()
                );
                (refusal.terminal_code(), refusal.message)
            })?;
            // Gated: validate the presented token (constant-time). A wrong
            // or absent token refuses with the single generic UNAUTHORIZED
            // and leaves the connection un-authed (retry allowed) — the same
            // collapse the terminal claim/attach paths use. Ungated servers
            // admit any token once the handshake checks pass.
            if let Some(gate) = state.web_auth.as_ref() {
                let presented = request.payload["token"].as_str().unwrap_or("");
                if !gate.accepts(presented) {
                    warn!(
                        "[terminal-ws] authenticate rejected id={} (bad token)",
                        request.id
                    );
                    return Err(("UNAUTHORIZED", "Unauthorized".to_string()));
                }
            }
            ctx.authed = true;
            ctx.capabilities = ctx.capability_policy.resolve();
            ctx.presence = Some(
                state
                    .relay
                    .presence()
                    .register(&identity, Carrier::TerminalWs),
            );
            let identity = ctx.identity.insert(identity);
            info!(
                "[terminal-ws] connection authenticated device_id={} client_instance_id={}",
                ClientIdentity::log_label(&identity.device_id),
                ClientIdentity::log_label(&identity.client_instance_id)
            );
            Ok(json!({}))
        }
        ConnectionGate::Allow => match request.type_.as_str() {
            "spawn" => {
                let options: SpawnOptions = serde_json::from_value(request.payload)
                    .map_err(|e| ("VALIDATION_ERROR", e.to_string()))?;
                // Require project_id so the terminal is scoped — do not default
                // to a literal that any client can target.
                if options
                    .project_id
                    .as_deref()
                    .filter(|s| !s.is_empty())
                    .is_none()
                {
                    return Err((
                        "VALIDATION_ERROR",
                        "spawn requires a non-empty projectId".to_string(),
                    ));
                }
                info!(
                    "[terminal-ws] spawn requested project_id={}",
                    options.project_id.as_deref().unwrap_or("?")
                );
                // CAP-3: spawn is the only issuance path. The reply carries the
                // flattened info + claim (same camelCase shape as desktop).
                let spawned = state
                    .pty
                    .spawn(options, None)
                    .await
                    .map_err(|e| ("SPAWN_FAILED", e))?;
                ctx.authorize(&spawned.info.id);
                // #851b: a web spawn IS a web listing — stamp it so the
                // web-listed reaper window starts rolling for this terminal.
                if let Some(instance) = state.pty.get(&spawned.info.id) {
                    instance.mark_web_listed();
                }
                info!(
                    "[terminal-ws] spawn success terminal_id={}",
                    spawned.info.id
                );
                serde_json::to_value(spawned).map_err(|e| ("SPAWN_FAILED", e.to_string()))
            }
            "write" => {
                let terminal_id = string_field(&request.payload, "terminalId")?;
                if !ctx.is_authorized(terminal_id) {
                    return Err((
                        "UNAUTHORIZED",
                        format!("Not authorized for terminal {terminal_id}"),
                    ));
                }
                let data = string_field(&request.payload, "data")?;
                // #851 "single size owner": the device that last typed is
                // the size owner — record it before the write.
                if let Some(instance) = state.pty.get(terminal_id) {
                    instance.note_web_size_owner(&ctx.client_id);
                }
                state
                    .pty
                    .write(terminal_id, data)
                    .await
                    .map(|_| Value::Null)
                    .map_err(|e| ("WRITE_FAILED", e))
            }
            "resize" => {
                let terminal_id = string_field(&request.payload, "terminalId")?;
                if !ctx.is_authorized(terminal_id) {
                    return Err(unauthorized_error(terminal_id));
                }
                let cols = u16_field(&request.payload, "cols")?;
                let rows = u16_field(&request.payload, "rows")?;
                // #851 "single size owner": last-writer-wins on resize;
                // a changed owner is logged (reconciled conflict) by
                // `note_web_size_owner`.
                if let Some(instance) = state.pty.get(terminal_id) {
                    instance.note_web_size_owner(&ctx.client_id);
                }
                state
                    .pty
                    .resize(terminal_id, cols, rows)
                    .await
                    .map(|_| Value::Null)
                    .map_err(|e| ("RESIZE_FAILED", e))
            }
            "kill" => {
                let terminal_id = string_field(&request.payload, "terminalId")?;
                // CWE-862: authorization FIRST — a connection may only kill a
                // terminal it spawned or verifiably attached to. The check runs
                // BEFORE any existence check or force_kill and collapses to the
                // single generic UNAUTHORIZED, so a client holding only the shared
                // web token can neither terminate another connection's PTY nor
                // distinguish "terminal exists but not yours" from "unknown id".
                if !ctx.is_authorized(terminal_id) {
                    return Err(unauthorized_error(terminal_id));
                }
                // Idempotent kill for an AUTHORIZED terminal whose PTY is already
                // gone (reaped/exited on its own): treat as success so closing a
                // tab over a dead PTY doesn't leave an uncloseable tab. A repeat
                // kill after a successful kill is NOT idempotent — the first kill
                // detached the terminal, so the retry takes the generic
                // UNAUTHORIZED branch above like any other unauthorized id.
                if state.pty.get(terminal_id).is_none() {
                    ctx.detach(terminal_id, state);
                    return Ok(Value::Null);
                }
                // Force-kill: bypass the desktop is_hidden deferral so web close
                // actually terminates the process. Desktop behavior is unchanged.
                state
                    .pty
                    .force_kill(terminal_id)
                    .await
                    .map(|_| {
                        ctx.detach(terminal_id, state);
                        Value::Null
                    })
                    .map_err(|e| ("KILL_FAILED", e))
            }
            "attach" => {
                let terminal_id = string_field(&request.payload, "terminalId")?.to_string();
                // CAP-3: verification is the gate and runs BEFORE any replay; every
                // failure mode collapses to the single generic UNAUTHORIZED error
                // (the leaking TERMINAL_NOT_FOUND branch is gone — existence stays
                // hidden). A missing or empty claim is NOT a shape error: it flows
                // through verification like any bad credential (contract: "missing/
                // invalid claim" collapses into the one generic error).
                let claim = request.payload["claim"].as_str().unwrap_or("");
                let last_seq = request.payload["lastSeq"].as_u64().unwrap_or(0);

                // Capture the generation BEFORE verifying (TOCTOU-safe ordering,
                // same as the desktop command): captured-first means a rotate/
                // revoke landing mid-handshake either fails verification or leaves
                // the attachment task holding a stale generation it terminates on.
                let generation = state.pty.claim_generation(&terminal_id);
                if state.pty.verify_claim(&terminal_id, claim).is_err() {
                    return Err(unauthorized_error(&terminal_id));
                }
                let Some(instance) = state.pty.get(&terminal_id) else {
                    // Verified a heartbeat ago but gone now — same generic error.
                    return Err(unauthorized_error(&terminal_id));
                };
                // The credential is the gate now (same-connection prior
                // authorization no longer is): verified attach authorizes the
                // connection for write/resize/events on this terminal.
                ctx.authorize(&terminal_id);
                // CodeRabbit (story 5 reattach): track live attachments so
                // `list_preserved` never reissues a claim under a live forwarder
                // — a second connection's reload must not invalidate the first
                // one's credential. The forwarder task below releases on exit.
                // #851b: an attach IS a web listing — stamp it so the
                // web-listed reaper window restarts for this terminal.
                // A re-attach on this connection replaces its previous
                // attachment. Count the new one BEFORE ending the old one so
                // the count never touches zero mid-swap (a zero would let
                // another connection's `list_preserved` reissue the claim and
                // invalidate the generation this new forwarder holds).
                instance.add_web_attachment();
                // The count taken above is owned by this guard until the
                // forwarder's `Attachment` is registered: an early return, a
                // failed reply send, or this connection task being cancelled
                // at the replay `.await` below drops it and releases the
                // count — it can never leak a live attachment.
                let release = AttachmentRelease::default();
                let mut pending = PendingAttachCount {
                    release: release.clone(),
                    pty: state.pty.clone(),
                    terminal_id: terminal_id.clone(),
                    armed: true,
                };
                if let Some(previous) = ctx.attachments.remove(&terminal_id) {
                    previous.end(&state.pty, &terminal_id);
                }
                instance.mark_web_listed();
                // Sequenced replay: only unseen chunks, with gap detection.
                let replay = instance.subscribe_from(last_seq);
                let attach_result = state.pty.build_attach_result(&instance, &replay);
                let snapshot = state.terminal_events.snapshot(&terminal_id);

                // Send replay frame: chunks + gap flag + latest seq + state snapshot.
                let chunk_payloads: Vec<Value> = replay
                    .chunks
                    .iter()
                    .map(|chunk| {
                        json!({
                            "seq": chunk.seq,
                            "data": chunk.data.iter().map(|b| *b as u64).collect::<Vec<u64>>()
                        })
                    })
                    .collect();
                // NOTE: the previous attachment is ended BEFORE this send, on
                // purpose. Ending it after would leave the old forwarder
                // streaming into the same socket while the new one is
                // subscribed, delivering the chunks between the replay
                // snapshot and the swap twice. A failed send here means this
                // connection's outbound channel is closed (socket gone), so
                // keeping the old attachment alive would protect nothing.
                send_json(
                    tx,
                    json!({
                        "type": "replay",
                        "terminalId": terminal_id,
                        "chunks": chunk_payloads,
                        "gap": replay.gap,
                        "latestSeq": replay.latest_seq,
                        "snapshot": serde_json::to_value(&snapshot).unwrap_or(json!({}))
                    }),
                )
                .await
                .map_err(|e| ("NETWORK_ERROR", e))?;

                let output_tx = tx.clone();
                let attached_id = terminal_id.clone();
                let pty = state.pty.clone();
                let task_release = release.clone();
                let task = tokio::spawn(async move {
                    let mut receiver = replay.receiver;
                    let mut current_seq = replay.latest_seq;
                    loop {
                        // CAP-3 teardown (amendment R1): when this credential is
                        // rotated/revoked — by ANY connection — or the terminal is
                        // killed/reaped, the derived stream ends. The generation
                        // check is what makes rotate/revoke sever the holders on
                        // other connections, not just the rotating one.
                        if crate::commands::forwarder_should_terminate(
                            generation,
                            pty.claim_generation(&attached_id),
                        ) {
                            info!(
                            "[terminal-ws] attachment terminating (claim invalidated) terminal_id={attached_id}"
                        );
                            break;
                        }
                        match receiver.recv().await {
                            Ok(chunk) => {
                                current_seq = chunk.seq;
                                let data: Vec<u64> = chunk.data.iter().map(|b| *b as u64).collect();
                                if send_json(
                                    &output_tx,
                                    json!({
                                        "type": "data",
                                        "terminalId": attached_id,
                                        "seq": current_seq,
                                        "data": data
                                    }),
                                )
                                .await
                                .is_err()
                                {
                                    break;
                                }
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                                // Recoverable: send a gap marker and continue.
                                warn!(
                                "[terminal-ws] output receiver lagged by {skipped} for {attached_id}"
                            );
                                let _ = send_json(
                                    &output_tx,
                                    json!({
                                        "type": "gap",
                                        "terminalId": attached_id,
                                        "lastSeq": current_seq
                                    }),
                                )
                                .await;
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                        }
                    }
                    // Release this connection's live-attachment accounting so a
                    // later `list_preserved` may reissue the claim (CodeRabbit:
                    // preserve live attachments when reissuing claims).
                    task_release.release(&pty, &attached_id);
                });
                ctx.attachments
                    .insert(terminal_id.clone(), Attachment { task, release });
                // Registered: the attachment (and the forwarder's own release)
                // owns the count from here.
                pending.armed = false;
                // Shared attach result — byte-identical camelCase shape to the
                // desktop `terminal_attach` response (no claim key, ever).
                serde_json::to_value(attach_result).map_err(|e| ("NETWORK_ERROR", e.to_string()))
            }
            "rotate_claim" => {
                // CAP-3: possession of the current credential yields a fresh one
                // and atomically invalidates the old. Any failure — including a
                // missing/empty claim — is the same generic UNAUTHORIZED as attach
                // (missing claims flow through verification, never a shape error).
                let terminal_id = string_field(&request.payload, "terminalId")?.to_string();
                let claim = request.payload["claim"].as_str().unwrap_or("");
                let rotated = state
                    .pty
                    .rotate_claim(&terminal_id, claim)
                    .map_err(|_| unauthorized_error(&terminal_id))?;
                // Teardown (amendment R1): the invalidated holder loses the output
                // stream (attachment task detached) AND write/resize access
                // (removed from the authorized set). Holders on OTHER connections
                // are severed by the claim-generation check inside their
                // attachment tasks. The PTY keeps running.
                ctx.detach(&terminal_id, state);
                info!("[terminal-ws] claim rotated terminal_id={terminal_id}");
                serde_json::to_value(crate::pty::RotatedClaim { claim: rotated })
                    .map_err(|e| ("NETWORK_ERROR", e.to_string()))
            }
            "revoke_claim" => {
                // CAP-3: revocation invalidates the credential; the PTY survives
                // until explicit kill/release/expiry/shutdown. Any failure —
                // including a missing/empty claim — is the same generic
                // UNAUTHORIZED as attach.
                let terminal_id = string_field(&request.payload, "terminalId")?.to_string();
                let claim = request.payload["claim"].as_str().unwrap_or("");
                state
                    .pty
                    .revoke_claim(&terminal_id, claim)
                    .map_err(|_| unauthorized_error(&terminal_id))?;
                // Teardown (amendment R1): same severing as rotate — the revoked
                // holder is a credential-less client and receives no further
                // metadata or output; other connections are severed by the
                // generation check in their attachment tasks. The PTY keeps
                // running.
                ctx.detach(&terminal_id, state);
                info!("[terminal-ws] claim revoked terminal_id={terminal_id}");
                Ok(Value::Null)
            }
            "detach" => {
                let terminal_id = string_field(&request.payload, "terminalId")?;
                ctx.detach(terminal_id, state);
                Ok(Value::Null)
            }
            "get_cwd" => {
                let terminal_id = string_field(&request.payload, "terminalId")?;
                if !ctx.is_authorized(terminal_id) {
                    return Err((
                        "UNAUTHORIZED",
                        format!("Not authorized for terminal {terminal_id}"),
                    ));
                }
                Ok(json!(state.cwd_tracker.get_cwd(terminal_id)))
            }
            "get_git_branch" => {
                let terminal_id = string_field(&request.payload, "terminalId")?;
                if !ctx.is_authorized(terminal_id) {
                    return Err((
                        "UNAUTHORIZED",
                        format!("Not authorized for terminal {terminal_id}"),
                    ));
                }
                Ok(json!(state.git_tracker.get_branch(terminal_id)))
            }
            "get_git_status" => {
                let terminal_id = string_field(&request.payload, "terminalId")?;
                if !ctx.is_authorized(terminal_id) {
                    return Err((
                        "UNAUTHORIZED",
                        format!("Not authorized for terminal {terminal_id}"),
                    ));
                }
                Ok(json!(state.git_tracker.get_status(terminal_id)))
            }
            "get_exit_code" => {
                let terminal_id = string_field(&request.payload, "terminalId")?;
                if !ctx.is_authorized(terminal_id) {
                    return Err((
                        "UNAUTHORIZED",
                        format!("Not authorized for terminal {terminal_id}"),
                    ));
                }
                Ok(json!(state.exit_code_tracker.get_exit_code(terminal_id)))
            }
            "add_renderer_ref" => {
                let terminal_id = string_field(&request.payload, "terminalId")?;
                if !ctx.is_authorized(terminal_id) {
                    return Err((
                        "UNAUTHORIZED",
                        format!("Not authorized for terminal {terminal_id}"),
                    ));
                }
                state
                    .pty
                    .add_renderer_ref(terminal_id, string_field(&request.payload, "rendererId")?)
                    .map(|_| Value::Null)
                    .map_err(|e| ("TERMINAL_NOT_FOUND", e))
            }
            "remove_renderer_ref" => {
                let terminal_id = string_field(&request.payload, "terminalId")?;
                if !ctx.is_authorized(terminal_id) {
                    return Err((
                        "UNAUTHORIZED",
                        format!("Not authorized for terminal {terminal_id}"),
                    ));
                }
                state
                    .pty
                    .remove_renderer_ref(terminal_id, string_field(&request.payload, "rendererId")?)
                    .map(|_| Value::Null)
                    .map_err(|e| ("TERMINAL_NOT_FOUND", e))
            }
            "set_protected" => {
                let terminal_id = string_field(&request.payload, "terminalId")?;
                if !ctx.is_authorized(terminal_id) {
                    return Err((
                        "UNAUTHORIZED",
                        format!("Not authorized for terminal {terminal_id}"),
                    ));
                }
                let protected = request.payload["protected"].as_bool().unwrap_or(true);
                state.pty.set_protected(terminal_id, protected);
                Ok(Value::Null)
            }
            "update_orphan_detection" => {
                // Global lifecycle setting. Accepted on any AUTHED connection —
                // including one with zero attached terminals — because the web
                // auth token (the connection gate) is the trust boundary for the
                // deployment posture this op exists in: the settings loader
                // pushes it at boot, before the first terminal attaches (QA
                // round 2: the push was previously refused until ≥1 authorized
                // terminal existed, so orphan-detection settings never applied).
                // Pre-auth connections are already refused with the single
                // generic UNAUTHORIZED by `connection_gate` before this arm.
                let enabled = request.payload["enabled"].as_bool().unwrap_or(true);
                let timeout = request.payload["timeout"].as_u64();
                state
                    .pty
                    .update_orphan_detection_settings(enabled, timeout)
                    .await;
                info!(
                    "[terminal-ws] orphan detection updated enabled={enabled} timeout_ms={:?}",
                    timeout
                );
                Ok(Value::Null)
            }
            "list_preserved" => {
                // Cross-reload reattach (QA round 2, spec story 5): an AUTHED
                // connection asks which PTYs the host still preserves for a
                // project and gets metadata + a freshly issued claim per
                // attachable terminal. Scoping is the terminal's OWN write-once
                // `project_id` — never the per-connection authorized set — so
                // the reply is a function of the project, not of who is asking.
                // The connection gate above already refuses pre-auth
                // `list_preserved` with the single generic UNAUTHORIZED, so no
                // terminal existence leaks to un-authed clients, and an authed
                // client querying an unknown project gets the same empty reply
                // shape as a project with nothing preserved.
                let project_id = string_field(&request.payload, "projectId")?;
                let preserved = state.pty.list_preserved(project_id);
                info!(
                    "[terminal-ws] list_preserved project_id={} count={}",
                    project_id,
                    preserved.len()
                );
                let entries: Vec<Value> = preserved
                    .into_iter()
                    .map(|entry| {
                        // #851b: a listing IS a web listing — stamp every
                        // returned terminal so the web-listed reaper window
                        // restarts while ANY client still sees it.
                        if let Some(instance) = state.pty.get(&entry.info.id) {
                            instance.mark_web_listed();
                        }
                        // #851a: every entry now carries ownership info —
                        // `hasLiveAttachment` tells the renderer another
                        // device already holds a live attachment, and the
                        // shared claim lets THIS connection attach to the
                        // SAME PTY (previously a live attachment meant an
                        // empty claim + a silent duplicate spawn per device).
                        // An empty claim (shared issuance refused — revoked
                        // record) is still omitted entirely so the renderer's
                        // "claim present" check cannot treat an empty string
                        // as an attachable credential; the caller falls back
                        // to spawn for it.
                        if entry.claim.is_empty() {
                            json!({
                                "id": entry.info.id,
                                "shell": entry.info.shell,
                                "cwd": entry.info.cwd,
                                "pid": entry.info.pid,
                                "cols": entry.info.cols,
                                "rows": entry.info.rows,
                                "hasLiveAttachment": entry.live_attachment,
                            })
                        } else {
                            json!({
                                "id": entry.info.id,
                                "shell": entry.info.shell,
                                "cwd": entry.info.cwd,
                                "pid": entry.info.pid,
                                "cols": entry.info.cols,
                                "rows": entry.info.rows,
                                "claim": entry.claim,
                                "hasLiveAttachment": entry.live_attachment,
                            })
                        }
                    })
                    .collect();
                Ok(json!({ "projectId": project_id, "terminals": entries }))
            }
            _ => Err(("NOT_IMPLEMENTED", "unknown terminal request".to_string())),
        },
    }
}

/// `/terminal/ws` wire form of the stable `forbidden` code (this surface's
/// codes are SCREAMING_SNAKE_CASE, like `UNAUTHORIZED`).
const FORBIDDEN_CODE: &str = "FORBIDDEN";

fn forbidden_message(request_type: &str) -> String {
    format!("`{request_type}` requires write capability; this connection is view-only")
}

fn string_field<'a>(value: &'a Value, key: &str) -> Result<&'a str, (&'static str, String)> {
    value[key]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ("VALIDATION_ERROR", format!("missing {key}")))
}

/// The single generic authorization failure shared by attach, rotate_claim,
/// revoke_claim, kill and resize. CAP-3 forbids any of these surfaces from
/// distinguishing unknown terminal from wrong/revoked credential from binding
/// mismatch - one code, one message shape. Message matches the desktop
/// `terminal_attach` / rotate / revoke error string byte-for-byte (transport
/// parity) and never echoes the terminal id. Kept free-standing so the
/// contract is testable.
fn unauthorized_error(_terminal_id: &str) -> (&'static str, String) {
    ("UNAUTHORIZED", "Unauthorized".to_string())
}

fn u16_field(value: &Value, key: &str) -> Result<u16, (&'static str, String)> {
    value[key]
        .as_u64()
        .and_then(|value| u16::try_from(value).ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| ("VALIDATION_ERROR", format!("invalid {key}")))
}

async fn send_json(tx: &mpsc::Sender<Message>, value: Value) -> Result<(), String> {
    tx.send(Message::Text(value.to_string().into()))
        .await
        .map_err(|_| "terminal websocket closed".to_string())
}

async fn send_error(
    tx: &mpsc::Sender<Message>,
    id: &str,
    code: &str,
    error: String,
) -> Result<(), String> {
    send_json(
        tx,
        json!({ "id": id, "success": false, "error": error, "code": code }),
    )
    .await
}

#[cfg(test)]
mod tests;
