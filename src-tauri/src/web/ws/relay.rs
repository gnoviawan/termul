//! `/ws` upgrade handler + per-connection relay loop (read/write tasks,
//! keepalive watchdog, lifecycle signals) and the per-frame text dispatch.

use super::*;

// ---------------------------------------------------------------------------
// WS upgrade handler + relay loop (AC1 + AC9 + AC10)
// ---------------------------------------------------------------------------

/// Outbound frame on a connection's write loop (event or reply).
pub(super) enum Outbound {
    /// A sequenced event (server→client push).
    Event(SequencedEvent),
    /// A reply to a client request.
    Reply(WsReply),
    /// Terminal close handshake (CAP-11: after a binary-frame protocol error).
    /// The channel is FIFO, so everything enqueued ahead of it (the
    /// `unsupported` error reply) is flushed first; the write loop then sends
    /// `Message::Close` and breaks, guaranteeing reply-before-close ordering.
    Close(axum::extract::ws::CloseFrame),
}

/// The `auth_required` event type name (relay-level, not from `events.rs`).
pub const AUTH_REQUIRED_TYPE: &str = "auth_required";

/// Batched WS frame type: `{"type":"events","events":[{sid,seq,type,payload}]}`
/// — the write loop packs a drained burst into one frame; the client unwraps
/// inner events through the same `handleEvent` path (per-event seq intact).
pub const WS_BATCH_TYPE: &str = "events";

/// Max events per batched frame — a burst drains in ≤this-sized slices so a
/// sustained flood still yields progressively (no unbounded flush latency).
pub(super) const WS_BATCH_MAX_EVENTS: usize = 64;

/// Build the `auth_required` event (sid=null, seq=0, payload={}).
pub(super) fn auth_required_event() -> SequencedEvent {
    SequencedEvent::new(None, 0, AUTH_REQUIRED_TYPE, json!({}))
}

/// Axum WS upgrade handler for `/ws` (AC1).
///
/// The upgrade itself always proceeds; the token gate lives in the
/// first-frame `authenticate` handling (`handle_request`), so a wrong token
/// gets a structured `unauthorized` reply instead of a failed handshake. The
/// default bind stays localhost per `web/config.rs`.
pub async fn ws_upgrade(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    // The first frame is auth_required; the gate (when active) is enforced on
    // the `authenticate` request, not at upgrade time.
    ws.on_upgrade(move |socket| async move {
        run_relay(socket, state).await;
    })
}

/// Keepalive Ping interval for the `/ws` relay.
///
/// Browser WebSockets never send their own pings (the WS API hides
/// ping/pong control frames from JavaScript), so without a server-emitted
/// Ping the socket goes silent during long agent turns — especially the
/// "thinking"/reasoning phase, which can produce no `session/update` chunks
/// for tens of seconds. Idle NAT/proxy hops and backgrounded mobile browser
/// tabs then RST the TCP connection (surfacing in the log as
/// "Connection reset without closing handshake" and in the chat UI as a
/// mid-response disconnect). 20s is well under common idle timeouts
/// (60–300s) yet light enough not to spam a recovering link.
pub(super) const PING_INTERVAL: Duration = Duration::from_secs(20);

/// How long without ANY client→server frame (a Pong answering our keepalive
/// Ping, a request, or a client Ping) before the server declares the
/// connection half-open and tears it down. ~3.5× the ping interval to absorb
/// jitter on slow/mobile links while still bounding a dead socket so the
/// relay reaps subscriptions + denies outstanding permissions and the
/// browser's reconnect+cursor-resubscribe path can engage.
pub(super) const PONG_TIMEOUT: Duration = Duration::from_secs(75);

/// Signal-gated keepalive ceiling (CAP-3): while a web client has sent a
/// `type:"background"` control frame and not yet sent `foreground` (or any
/// normal frame), the watchdog tolerates up to 5 minutes of inactivity so a
/// backgrounded mobile tab (whose `setInterval` the OS throttles/pauses)
/// survives an app-switch round-trip. `PONG_TIMEOUT` is NOT raised — the
/// 5-min ceiling applies only while `backgrounded=true`. 5 min balances
/// mobile battery against reconnect latency (codeg tolerates 1h; buzz 30s).
pub(super) const BACKGROUND_TIMEOUT: Duration = Duration::from_secs(300);

/// Reusable Ping payload (opaque; browsers must echo it back in the Pong, but
/// the relay does not correlate — any inbound frame resets the watchdog).
/// Must stay under 125 bytes per RFC 6455 control-frame limits.
pub(super) const PING_PAYLOAD: &[u8] = b"keepalive";

/// Pure keepalive-watchdog decision: returns true when no inbound frame
/// (text request, Pong, or client Ping) has arrived for longer than `ceiling`
/// — `PONG_TIMEOUT` for an active/foreground connection, or `BACKGROUND_TIMEOUT`
/// while a `background` signal is in effect (CAP-3). Extracted from the write
/// task so the threshold semantics (strict `>`) are unit-testable without
/// spinning up a real socket. The write task calls this with
/// `last_activity.load()` + `now_ms()` + the active ceiling on each tick.
pub(super) fn watchdog_is_stale(last_activity_ms: u64, now_ms_value: u64, ceiling_ms: u64) -> bool {
    now_ms_value.saturating_sub(last_activity_ms) > ceiling_ms
}

/// CAP-3: consume an id-less `background`/`foreground` lifecycle control frame.
/// Returns `true` when the frame was a lifecycle signal and the caller should
/// skip dispatch (no reply, no `WsRequest` parse). The `backgrounded` flag is
/// toggled ONLY when `authed` (an unauthenticated peer cannot manipulate the
/// watchdog ceiling); an unauthenticated signal is still consumed (ignored,
/// no dispatch, no error). Returns `false` for any other frame — the caller
/// then resets the flag ("any normal frame resets the normal timeout") and
/// dispatches as a normal ACP request.
pub(super) fn handle_lifecycle_signal(text: &str, authed: bool, backgrounded: &AtomicBool) -> bool {
    if let Some(type_) = peer_frame_type(text) {
        match type_.as_str() {
            "background" => {
                if authed {
                    backgrounded.store(true, Ordering::Relaxed);
                } else {
                    debug!("[ws] ignoring background signal from unauthenticated connection");
                }
                true
            }
            "foreground" => {
                if authed {
                    backgrounded.store(false, Ordering::Relaxed);
                }
                true
            }
            _ => false,
        }
    } else {
        false
    }
}

/// Run the per-connection relay loop: a write task draining the outbound
/// channel + a read task routing requests. Returns when either half closes.
pub(super) async fn run_relay(socket: WebSocket, state: AppState) {
    let (mut sink, mut stream) = socket.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Outbound>();
    let relay = Arc::clone(&state.relay);
    // Story 1.8: the ACP manager — the server is the ACP client-of-record; the
    // 10 ACP command handlers (`send_prompt`, `create_session`, …) forward to it.
    let acp = Arc::clone(&state.acp);
    // Epic-4 bridge: the in-memory project registry — source for `GET /projects`
    // (router) + `switch_project` cwd resolution (this handler).
    let registry = Arc::clone(&state.registry);
    let registry_persistence = state.registry_persistence.clone();
    let projects_file = state.projects_file.clone();
    let history_mode = state.history_mode;
    // CAP-6 / Story 8: the host-owned ACP catalog service for the
    // `list_acp_catalog` + `set_catalog_opt_in` WS requests.
    let acp_catalog = state.acp_catalog.clone();
    // CAP-6 / Story 9: the host-owned verified-atomic ACP install service for
    // the `install_acp_agent` WS request.
    let acp_install = state.acp_install.clone();
    // Issue #613: the server-side generic key-value store behind the
    // `store_read` / `store_write` / `store_delete` WS requests.
    let store = state.store.clone();
    // CAP-1 interim (Story 1): the web auth gate threaded into the pre-auth
    // `authenticate` validation. `None` = ungated (legacy behavior).
    let web_auth = state.web_auth.clone();
    // Client ids registered via `subscribe` — unregistered on disconnect.
    let subscribed_clients = Arc::new(tokio::sync::Mutex::new(Vec::<(String, ClientId)>::new()));
    let cleanup = ConnectionCleanup::new(Arc::clone(&relay), Arc::clone(&subscribed_clients));
    // Per-connection tracking for `switch_project` (Ask-First resolution): the
    // last agent + session this connection used. `switch_project` reuses the
    // agent rather than auto-spawning; a cold tab (no agent yet) → `NO_AGENT`.
    // The old web-focused session is closed server-side after the new one is
    // ready. Set by `spawn_agent` / `create_session` / `load_session` /
    // `resume_session` (the handlers that carry an agentId / create a session).
    let mut current_agent: Option<crate::acp::AgentId> = None;
    let current_session = Arc::new(parking_lot::Mutex::new(None::<crate::acp::SessionId>));
    // Project identity is connection-local. The registry's active id may have
    // been changed by another browser/desktop and cannot prove this socket's
    // tracked session is already rooted at that project.
    let current_project = Arc::new(parking_lot::Mutex::new(None::<String>));
    let switch_queue = Arc::new(tokio::sync::Mutex::new(ProjectSwitchQueue::default()));

    // AC9: emit auth_required on the connection before anything else.
    if out_tx.send(Outbound::Event(auth_required_event())).is_err() {
        return; // receiver dropped before we started — peer already gone.
    }

    // Keepalive watchdog: shared "last seen alive" epoch-ms. The read task
    // stamps it on every inbound frame (text request, Pong, or client Ping);
    // the write task consults it on each keepalive tick to detect a
    // half-open/dead peer. Browser WebSockets auto-pong protocol-level Pings
    // (the WS API never exposes ping/pong to JS), so a server-emitted Ping is
    // the only way to refresh NAT/proxy/browser idle timers during silent
    // reasoning phases and to surface a dead client promptly.
    let last_activity = Arc::new(AtomicU64::new(now_ms()));
    // CAP-3: per-connection background flag. `true` while a web client has
    // signaled `type:"background"` (tab suspending); the watchdog then uses
    // BACKGROUND_TIMEOUT (5min) instead of PONG_TIMEOUT (75s). Reset to
    // false by `foreground` or any normal client frame.
    let backgrounded = Arc::new(AtomicBool::new(false));
    let write_last_activity = Arc::clone(&last_activity);
    let write_backgrounded = Arc::clone(&backgrounded);

    let write_tx = out_tx.clone();
    let mut write_task = tokio::spawn(async move {
        let mut ping = tokio::time::interval(PING_INTERVAL);
        // Steady, not bursty: if a slow client stalled the write loop, don't
        // ping-storm it on recovery — delay missed ticks to the next period.
        ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // Discard the immediate first tick so the first keepalive lands one
        // full interval after connect (a fresh connection needs no keepalive
        // yet and the auth_required frame has just been queued).
        ping.tick().await;
        loop {
            tokio::select! {
                frame = out_rx.recv() => {
                    let Some(frame) = frame else { break };
                    // Burst coalescing: when the first dequeued frame is an
                    // event, greedily pull whatever else the channel already
                    // holds and ship the run as ONE `events` frame. Under an
                    // 8-agent stream this collapses ~160 per-event WS frames
                    // per second (each its own webview dispatch + JSON.parse)
                    // into one frame per drain — zero added latency since we
                    // never wait for events that haven't arrived.
                    let text = match frame {
                        Outbound::Event(first) => {
                            let mut batch = vec![first];
                            let mut lookahead: Option<Outbound> = None;
                            while batch.len() < WS_BATCH_MAX_EVENTS {
                                match out_rx.try_recv() {
                                    Ok(Outbound::Event(evt)) => batch.push(evt),
                                    Ok(other) => {
                                        lookahead = Some(other);
                                        break;
                                    }
                                    Err(_) => break,
                                }
                            }
                            let text = if batch.len() == 1 {
                                serde_json::to_string(&batch[0]).unwrap_or_else(|e| {
                                    warn!("[ws] failed to serialize event {}: {e}", batch[0].type_);
                                    String::new()
                                })
                            } else {
                                serde_json::to_string(&json!({
                                    "type": WS_BATCH_TYPE,
                                    "events": batch,
                                }))
                                .unwrap_or_else(|e| {
                                    warn!("[ws] failed to serialize event batch: {e}");
                                    String::new()
                                })
                            };
                            if !text.is_empty() && sink.send(Message::Text(text.into())).await.is_err() {
                                break; // peer gone — stop writing.
                            }
                            // The non-event frame that ended the drain goes
                            // next, preserving strict FIFO across frame kinds.
                            match lookahead {
                                Some(Outbound::Reply(rep)) => {
                                    let text = serde_json::to_string(&rep).unwrap_or_else(|e| {
                                        warn!("[ws] failed to serialize reply for {}: {e}", rep.id);
                                        String::new()
                                    });
                                    if !text.is_empty()
                                        && sink.send(Message::Text(text.into())).await.is_err()
                                    {
                                        break;
                                    }
                                    continue;
                                }
                                Some(Outbound::Close(close)) => {
                                    let _ = sink.send(Message::Close(Some(close))).await;
                                    break;
                                }
                                Some(Outbound::Event(_)) => unreachable!(),
                                None => continue,
                            }
                        }
                        Outbound::Reply(rep) => serde_json::to_string(&rep).unwrap_or_else(|e| {
                            warn!("[ws] failed to serialize reply for {}: {e}", rep.id);
                            String::new()
                        }),
                        // CAP-11: the write task owns the close handshake —
                        // flush `Message::Close` AFTER everything queued ahead
                        // of it, then break so the outer select aborts the
                        // read task (not the other way around, which would
                        // race the queued frames away).
                        Outbound::Close(close) => {
                            let _ = sink.send(Message::Close(Some(close))).await;
                            break;
                        }
                    };
                    if text.is_empty() {
                        continue;
                    }
                    if sink.send(Message::Text(text.into())).await.is_err() {
                        break; // peer gone — stop writing.
                    }
                }
                _ = ping.tick() => {
                    // Send a keepalive Ping. The browser auto-pongs at the
                    // protocol layer; that Pong (or any client→server frame)
                    // refreshes `last_activity`.
                    if sink.send(Message::Ping(PING_PAYLOAD.to_vec().into())).await.is_err() {
                        break; // peer gone — stop writing.
                    }
                    // Dead-peer detection: if nothing has arrived from the
                    // client for PONG_TIMEOUT (no Pong, no request, no close),
                    // the connection is half-open. Tear it down so the read
                    // loop ends and the client's reconnect logic engages
                    // instead of the server silently holding a dead socket
                    // (which would otherwise leak subscriptions + pending
                    // permissions and stall the chat UI mid-response).
                    let last = write_last_activity.load(Ordering::Relaxed);
                    let now = now_ms();
                    let stale = now.saturating_sub(last);
                    // CAP-3: a backgrounded client (sent `type:"background"`)
                    // gets the 5-min ceiling; any other state gets 75s.
                    let ceiling = if write_backgrounded.load(Ordering::Relaxed) {
                        BACKGROUND_TIMEOUT
                    } else {
                        PONG_TIMEOUT
                    };
                    if watchdog_is_stale(last, now, ceiling.as_millis() as u64) {
                        warn!(
                            "[ws] keepalive: no client activity for {stale} ms \
                             (>{ceiling:?}); closing connection"
                        );
                        break;
                    }
                }
            }
        }
    });

    let read_last_activity = Arc::clone(&last_activity);
    let read_backgrounded = Arc::clone(&backgrounded);
    let read_subscribed_clients = Arc::clone(&subscribed_clients);
    let read_relay = Arc::clone(&relay);
    let mut read_task = tokio::spawn(async move {
        let mut authed = false;
        // CAP-11: set once a binary frame poisons the connection. The error
        // reply + Close(1003) are already queued; further text requests must
        // NOT dispatch (they would execute before the close lands) — the read
        // loop just waits for the write task to finish the handshake.
        let mut protocol_error = false;
        while let Some(frame) = stream.next().await {
            let msg = match frame {
                Ok(m) => m,
                Err(e) => {
                    warn!("[ws] read error: {e}");
                    break;
                }
            };
            // Any frame from the client (text request, a Pong answering our
            // keepalive Ping, or a client Ping) proves the connection is live
            // — stamp it so the write task's watchdog doesn't close a healthy
            // peer during a burst of agent output.
            read_last_activity.store(now_ms(), Ordering::Relaxed);
            match msg {
                Message::Text(t) => {
                    if protocol_error {
                        continue;
                    }
                    // CAP-3: consume id-less `background`/`foreground`
                    // lifecycle control frames before the strict `WsRequest`
                    // parse (which requires `id`). These are fire-and-forget
                    // (no reply) and toggle the keepalive ceiling; an
                    // unauthenticated connection's signal is ignored (no flag
                    // set, no dispatch, no error).
                    if handle_lifecycle_signal(&t, authed, &read_backgrounded) {
                        continue;
                    }
                    // Any other text frame resets the background flag (CAP-3:
                    // "resets on foreground or any normal frame") and dispatches
                    // as a normal ACP request.
                    read_backgrounded.store(false, Ordering::Relaxed);
                    if !dispatch_connection_text(
                        &t,
                        &mut authed,
                        web_auth.as_deref(),
                        &acp,
                        &read_relay,
                        &registry,
                        registry_persistence.as_ref(),
                        projects_file.as_deref(),
                        &write_tx,
                        &read_subscribed_clients,
                        &mut current_agent,
                        &current_session,
                        &current_project,
                        &switch_queue,
                        history_mode,
                        acp_catalog.as_ref(),
                        acp_install.as_ref(),
                        store.as_ref(),
                    )
                    .await
                    {
                        break; // write half closed.
                    }
                }
                Message::Binary(_) => {
                    // Protocol error (CAP-11): the structured `unsupported`
                    // error reply MUST reach the client before the Close(1003)
                    // handshake. Do NOT break here — finishing this read task
                    // would let the outer `tokio::select!` abort the write task
                    // mid-queue, racing the queued reply + close away. Instead
                    // the write task owns the handshake: `Outbound::Close`
                    // flushes after the reply (FIFO), the write loop breaks,
                    // and the outer select then aborts this read task. The
                    // latch suppresses duplicate replies on repeated binary
                    // frames.
                    if protocol_error {
                        continue;
                    }
                    protocol_error = true;
                    let _ = write_tx.send(Outbound::Reply(WsReply::err(
                        "binary-frame",
                        WsErrorCode::Unsupported,
                        "binary frames are not supported by this protocol",
                    )));
                    let _ = write_tx.send(Outbound::Close(axum::extract::ws::CloseFrame {
                        code: 1003,
                        reason: "binary frames are not supported".into(),
                    }));
                }
                Message::Close(_) | Message::Ping(_) | Message::Pong(_) => {
                    // Axum auto-answers pings; Close ends the loop.
                    if matches!(msg, Message::Close(_)) {
                        break;
                    }
                }
            }
        }
    });

    // Drop the original sender so the write loop ends when the read task
    // (which owns the only remaining sender clone) finishes.
    drop(out_tx);
    // Patch L: the `tokio::select!` completes the WINNING branch's JoinHandle
    // (it is polled to completion inside select). Re-awaiting the winner
    // panics in tokio ≥ 1.52 ("JoinHandle polled after completion"). So we
    // only await the LOSING (aborted) task — the winner is already joined.
    tokio::select! {
        _ = &mut write_task => {
            read_task.abort();
            // Read is the loser — await its abort to avoid orphaning.
            let _ = read_task.await;
        }
        _ = &mut read_task => {
            write_task.abort();
            // Write is the loser — await its abort to avoid orphaning.
            let _ = write_task.await;
        }
    }
    cleanup.run().await;
}

pub(super) struct ConnectionCleanup {
    relay: Arc<WsRelaySink>,
    subscribed_clients: Arc<tokio::sync::Mutex<Vec<(String, ClientId)>>>,
    state: Arc<std::sync::atomic::AtomicU8>,
}

impl ConnectionCleanup {
    pub(super) fn new(
        relay: Arc<WsRelaySink>,
        subscribed_clients: Arc<tokio::sync::Mutex<Vec<(String, ClientId)>>>,
    ) -> Self {
        Self {
            relay,
            subscribed_clients,
            state: Arc::new(std::sync::atomic::AtomicU8::new(0)),
        }
    }

    pub(super) async fn run(&self) {
        if self
            .state
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let relay = Arc::clone(&self.relay);
        let subscribed_clients = Arc::clone(&self.subscribed_clients);
        let state = Arc::clone(&self.state);
        let cleanup = tokio::spawn(async move {
            cleanup_connection_subscriptions(&relay, &subscribed_clients).await;
            state.store(2, Ordering::Release);
        });
        let _ = cleanup.await;
    }
}

impl Drop for ConnectionCleanup {
    fn drop(&mut self) {
        if self
            .state
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let relay = Arc::clone(&self.relay);
        let subscribed_clients = Arc::clone(&self.subscribed_clients);
        let state = Arc::clone(&self.state);
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                cleanup_connection_subscriptions(&relay, &subscribed_clients).await;
                state.store(2, Ordering::Release);
            });
        } else {
            warn!(
                target: "termul::web::ws",
                "connection cleanup dropped outside a Tokio runtime"
            );
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn dispatch_connection_text(
    text: &str,
    authed: &mut bool,
    web_auth: Option<&WebAuth>,
    acp: &Arc<AcpManager>,
    relay: &Arc<WsRelaySink>,
    registry: &Arc<ProjectRegistry>,
    registry_persistence: Option<&Arc<parking_lot::Mutex<FileProjectRegistry>>>,
    projects_file: Option<&PathBuf>,
    write_tx: &mpsc::UnboundedSender<Outbound>,
    subscribed_clients: &Arc<tokio::sync::Mutex<Vec<(String, ClientId)>>>,
    current_agent: &mut Option<AgentId>,
    current_session: &Arc<parking_lot::Mutex<Option<SessionId>>>,
    current_project: &Arc<parking_lot::Mutex<Option<String>>>,
    switch_queue: &Arc<tokio::sync::Mutex<ProjectSwitchQueue>>,
    history_mode: HistoryMode,
    acp_catalog: Option<&Arc<crate::acp::AcpCatalogService>>,
    acp_install: Option<&Arc<crate::acp::install::AcpInstallService>>,
    store: Option<&Arc<WebStore>>,
) -> bool {
    if let Some((id, payload)) = authenticated_send_prompt(text, *authed) {
        return match accept_send_prompt(id, &payload, acp, relay).await {
            Ok(accepted) => {
                let prompt_acp = Arc::clone(acp);
                let prompt_tx = write_tx.clone();
                tokio::spawn(async move {
                    let reply = complete_send_prompt(accepted, &prompt_acp).await;
                    let _ = prompt_tx.send(Outbound::Reply(reply));
                });
                true
            }
            Err(reply) => write_tx.send(Outbound::Reply(reply)).is_ok(),
        };
    }

    let mut subscriptions = subscribed_clients.lock().await;
    let reply = handle_request(
        text,
        authed,
        web_auth,
        acp,
        relay,
        registry,
        registry_persistence,
        projects_file,
        write_tx,
        &mut subscriptions,
        current_agent,
        current_session,
        current_project,
        switch_queue,
        history_mode,
        acp_catalog,
        acp_install,
        store,
    )
    .await;
    write_tx.send(Outbound::Reply(reply)).is_ok()
}
