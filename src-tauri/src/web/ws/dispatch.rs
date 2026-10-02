//! Request dispatch: `handle_request` auth gate + post-auth routing match,
//! prompt fast-path, and connection subscription cleanup.

use super::*;

pub(super) fn authenticated_send_prompt(text: &str, authed: bool) -> Option<(String, Value)> {
    if !authed {
        return None;
    }
    let request: WsRequest = serde_json::from_str(text).ok()?;
    (request.type_ == "send_prompt").then_some((request.id, request.payload))
}

pub(super) async fn cleanup_connection_subscriptions(
    relay: &Arc<WsRelaySink>,
    subscribed_clients: &Arc<tokio::sync::Mutex<Vec<(String, ClientId)>>>,
) {
    let subscriptions = std::mem::take(&mut *subscribed_clients.lock().await);
    let disconnected_sessions: std::collections::HashSet<String> = subscriptions
        .iter()
        .map(|(session_id, _)| session_id.clone())
        .collect();
    for (session_id, client_id) in subscriptions {
        relay.unsubscribe(&session_id, client_id);
    }
    info!(
        target: "termul::web::ws",
        session_count = disconnected_sessions.len(),
        "connection subscriptions cleaned up"
    );

    if let Some(rendezvous) = relay.rendezvous() {
        for session_id in disconnected_sessions
            .iter()
            .filter(|session_id| relay.session_subscriber_count(session_id) == 0)
        {
            let relay_for_count = Arc::clone(relay);
            rendezvous.schedule_disconnect_grace(session_id.clone(), move |candidate| {
                relay_for_count.session_subscriber_count(candidate)
            });
        }
    }
    if let Some(rendezvous) = relay.question_rendezvous() {
        let relay_for_count = Arc::clone(relay);
        rendezvous
            .deny_all_for_client(move |session_id| {
                relay_for_count.session_subscriber_count(session_id)
            })
            .await;
    }
}

/// Route a single text request frame to a reply (AC9 + AC10 + Story 1.6 subscribe
/// + Story 1.7 `respond_permission` + Story 1.8 ACP command forwarding).
///
/// Pre-auth: only `authenticate` is allowed; everything else → `unauthorized`.
/// Post-auth: `authenticate` is a no-op success; `subscribe` wires the sink;
/// `respond_permission` routes through the Story 1.7 rendezvous; the 10 ACP
/// command types (`send_prompt`, `create_session`, …) forward to
/// `AcpManager` (Story 1.8); OS-cap requests → `unsupported`; unknown types →
/// `not_implemented`.
#[allow(clippy::too_many_arguments)]
pub(super) async fn handle_request(
    text: &str,
    authed: &mut bool,
    web_auth: Option<&WebAuth>,
    acp: &Arc<AcpManager>,
    relay: &Arc<WsRelaySink>,
    registry: &Arc<ProjectRegistry>,
    registry_persistence: Option<&Arc<parking_lot::Mutex<FileProjectRegistry>>>,
    projects_file: Option<&PathBuf>,
    out_tx: &mpsc::UnboundedSender<Outbound>,
    subscribed_clients: &mut Vec<(String, ClientId)>,
    current_agent: &mut Option<AgentId>,
    current_session: &Arc<parking_lot::Mutex<Option<SessionId>>>,
    current_project: &Arc<parking_lot::Mutex<Option<String>>>,
    switch_queue: &Arc<tokio::sync::Mutex<ProjectSwitchQueue>>,
    history_mode: HistoryMode,
    acp_catalog: Option<&Arc<crate::acp::AcpCatalogService>>,
    acp_install: Option<&Arc<crate::acp::install::AcpInstallService>>,
    store: Option<&Arc<WebStore>>,
) -> WsReply {
    let req: WsRequest = match serde_json::from_str(text) {
        Ok(r) => r,
        Err(e) => {
            return WsReply::err(
                "malformed",
                WsErrorCode::Unsupported,
                format!("malformed request frame: {e}"),
            );
        }
    };
    let id = req.id.clone();

    // Pre-auth gate (AC9): only authenticate is allowed.
    if !*authed {
        if req.type_ == "authenticate" {
            // CAP-1 interim (Story 1): when the server runs gated, validate
            // the presented token in constant time BEFORE marking authed. A
            // wrong/absent token is refused `unauthorized`; `authed` stays
            // false and the connection stays open so the client may retry.
            // Ungated servers (`web_auth: None`) keep the legacy
            // accept-any-token behavior (frozen contract: ungated loopback is
            // byte-identical to the pre-gate server).
            if let Some(gate) = web_auth {
                let presented = req.payload["token"].as_str().unwrap_or("");
                if !gate.accepts(presented) {
                    // Durable boundary event (AGENTS.md logging policy): a
                    // refused authenticate must be visible in the service
                    // log. NEVER log the presented token — only that the
                    // gate refused, plus enough context to correlate.
                    warn!(
                        target: "termul::web::ws",
                        request_id = %req.id,
                        token_presented = !presented.is_empty(),
                        "web auth gate refused /ws authenticate (invalid or missing token)"
                    );
                    return WsReply::err(
                        id,
                        WsErrorCode::Unauthorized,
                        "invalid or missing auth token",
                    );
                }
            }
            *authed = true;
            let reconnect_grace = relay
                .rendezvous()
                .map_or(DEFAULT_PERMISSION_RECONNECT_GRACE, |rendezvous| {
                    rendezvous.disconnect_grace()
                });
            return WsReply::ok(
                id,
                Some(json!({
                    "historyMode": history_mode,
                    "runtimePolicy": RuntimePolicy::resolved(reconnect_grace),
                })),
            );
        }
        return WsReply::err(
            id,
            WsErrorCode::Unauthorized,
            "pre-auth: send an `authenticate` request first",
        );
    }

    // Post-auth routing.
    match req.type_.as_str() {
        "authenticate" => {
            // Idempotent re-auth — accept and succeed.
            WsReply::ok(id, Some(json!({})))
        }
        // Application-level heartbeat: a client-emitted `ping` request keeps
        // the keepalive watchdog (`last_activity`) fresh through proxies that
        // strip WS-level Ping/Pong control frames (Cloudflare tunnels, etc.).
        // The read loop stamps `last_activity` on every inbound text frame
        // before routing, so this handler only needs to round-trip a reply so
        // the client's request promise resolves (no timeout).
        "ping" => WsReply::ok(id, Some(json!({}))),
        "subscribe" => handle_subscribe(id, &req.payload, relay, out_tx, subscribed_clients).await,
        "list_persisted_sessions" => {
            handle_list_persisted_sessions(id, relay, history_mode).await
        }
        // CAP-11: host-owned session delete (desktop parity with the
        // `acp_history_delete` Tauri command) — removes the persisted record
        // and fans `chat_history_changed` so every client refetches the index.
        "delete_session" => handle_delete_session(id, &req.payload, relay, history_mode).await,
        "open_persisted_session" => {
            handle_open_persisted_session(
                id,
                &req.payload,
                relay,
                out_tx,
                subscribed_clients,
                history_mode,
            )
            .await
        }
        "get_session_payload" => {
            handle_get_session_payload(id, &req.payload, relay, history_mode).await
        }
        "get_session_payload_tail" => {
            handle_get_session_payload_tail(id, &req.payload, relay, history_mode).await
        }
        "recover_session_snapshot" => {
            handle_recover_session_snapshot(
                id,
                &req.payload,
                relay,
                out_tx,
                subscribed_clients,
                history_mode,
            )
            .await
        }
        // R2: lightweight server-authoritative replay cursor (no snapshot).
        // Unlike `recover_session_snapshot` (which re-registers a
        // subscription), this only returns `{ sessionId, watermark }` so a
        // refreshed transport seeds `lastSeq` before its first subscribe.
        "get_session_cursor" => {
            handle_get_session_cursor(id, &req.payload, relay, history_mode).await
        }
        // Story 1.7: `respond_permission` — route the browser's permission
        // decision through the server-side rendezvous (first-response-wins,
        // TOCTOU re-validation, at-most-one) to `AcpManager::respond_permission`,
        // which resolves the agent's `Responder` on the driver thread.
        "respond_permission" => handle_respond_permission(id, &req.payload, relay, subscribed_clients).await,
        // Issue #411: `answer_question` — route the browser's structured-question
        // answer through the server-side question rendezvous (first-response-wins,
        // TOCTOU re-validation) to `AcpManager::answer_question`, which resolves
        // the agent's `Responder` on the driver thread.
        "answer_question" => handle_answer_question(id, &req.payload, relay, subscribed_clients).await,
        // Story 1.8: ACP command forwarding → `AcpManager`. The streaming events
        // (`message_chunk`, `tool_call`, `prompt_complete`, `session_created`,
        // `config_options_update`, …) flow back automatically through the
        // existing `fan_out` → `WsRelaySink::emit` → WS frame → store pipeline.
        "create_session" => {
            handle_create_session(
                id,
                &req.payload,
                acp,
                registry,
                current_agent,
                current_session,
                current_project,
            )
            .await
        }
        "load_session" => {
            handle_load_session(
                id,
                &req.payload,
                acp,
                current_agent,
                current_session,
                current_project,
            )
            .await
        }
        "resume_session" => {
            handle_resume_session(
                id,
                &req.payload,
                acp,
                current_agent,
                current_session,
                current_project,
            )
            .await
        }
        "close_session" => {
            handle_close_session(id, &req.payload, acp, current_session, current_project).await
        }
        "dispose_ephemeral_session" => {
            handle_dispose_ephemeral_session(
                id,
                &req.payload,
                acp,
                relay,
                subscribed_clients,
                current_session,
                current_project,
            )
            .await
        }
        "list_sessions" => handle_list_sessions(id, &req.payload, acp).await,
        // Story 8: promote a backend-ephemeral warm-pool session to durable
        // (register persistence metadata + clear the ephemeral mark).
        "promote_session" => handle_promote_session(id, &req.payload, acp).await,
        "register_discovered_session" => {
            handle_register_discovered_session(id, &req.payload, acp, relay).await
        }
        "switch_project" => {
            handle_switch_project(
                id,
                &req.payload,
                acp,
                relay,
                registry,
                out_tx,
                current_agent,
                current_session,
                current_project,
                switch_queue,
            )
            .await
        }
        // Explicit host-default change (Epic 7 — cross-client continuity).
        // Distinct from `switch_project` (per-connection): updates the host's
        // `default_project_id`, persists to `FileProjectRegistry` (VPS, with
        // rollback), and broadcasts `projects_changed` to ALL clients. Any
        // authenticated client can set the default for now (Epic 2 wires auth).
        "set_default_project" => {
            handle_set_default_project(
                id,
                &req.payload,
                relay,
                registry,
                registry_persistence,
                projects_file,
            )
            .await
        }
        // Option B: project-list mutations. The standalone server is a
        // first-class project-list authority; these persist to
        // `FileProjectRegistry` (VPS, with rollback) + broadcast
        // `projects_changed`. Mirrors the `POST /projects`,
        // `PUT /projects/{id}`, `DELETE /projects/{id}` HTTP routes
        // (transport parity). Any authenticated client for now (Epic 2).
        "add_project" => {
            handle_add_project(
                id,
                &req.payload,
                relay,
                registry,
                registry_persistence,
                projects_file,
            )
            .await
        }
        "update_project" => {
            handle_update_project(
                id,
                &req.payload,
                relay,
                registry,
                registry_persistence,
                projects_file,
            )
            .await
        }
        "remove_project" => {
            handle_remove_project(
                id,
                &req.payload,
                relay,
                registry,
                registry_persistence,
                projects_file,
            )
            .await
        }
        "spawn_agent" => handle_spawn_agent(id, &req.payload, acp, current_agent).await,
        // CAP-6 / Story 8: host-owned ACP catalog resolution. The catalog
        // carries the host's OS/arch/runtime availability + per-agent
        // resolved `SupportedAcpAgentStatus`. The web client never probes
        // `@tauri-apps/plugin-os` or PATH locally — the host is the single
        // source of truth.
        "list_acp_catalog" => {
            handle_list_acp_catalog(id, &req.payload, acp_catalog, acp_install).await
        }
        "set_catalog_opt_in" => {
            handle_set_catalog_opt_in(id, &req.payload, acp_catalog).await
        }
        // CAP-6 / Story 9: host-owned verified-atomic ACP install. The web
        // client installs a catalog agent through `install_acp_agent`; the
        // host resolves the agent by id from the catalog, downloads the HTTPS
        // archive, verifies sha256, extracts safely, atomically activates,
        // serializes per-agent, records the manifest, and returns
        // `{ command, args }`. The request is `{ agentId }` only; the host
        // never accepts browser-supplied URLs/commands/paths/args. Errors
        // carry SCREAMING_SNAKE_CASE codes byte-identical to the Tauri +
        // HTTP transports (via `WsReply::err_with_code`).
        "install_acp_agent" => {
            handle_install_acp_agent(id, &req.payload, acp_install).await
        }
        // Issue #613: server-side generic key-value store. The web client
        // routes its `persistenceApi` through these (replacing the per-browser
        // localStorage stub) so settings / layout / command history / SSH
        // profiles survive browser switches + server restarts.
        "store_read" => handle_store_read(id, &req.payload, store).await,
        "store_write" => handle_store_write(id, &req.payload, store).await,
        "store_delete" => handle_store_delete(id, &req.payload, store).await,
        "kill_agent" => {
            handle_kill_agent(
                id,
                &req.payload,
                acp,
                current_agent,
                current_session,
                current_project,
            )
            .await
        }
        "list_agents" => handle_list_agents(id, acp),
        // CAP: ACP agent `authenticate` method (agent-advertised auth, e.g.
        // `pi_terminal_login`). Distinct from the WS connection `authenticate`
        // token gate — this runs the method on the host where the agent lives.
        "authenticate_agent" => handle_authenticate_agent(id, &req.payload, acp).await,
        // Paste-back half of the headless browser-auth flow
        // (spec-acp-terminal-auth): the client delivers the failed loopback
        // redirect URL; the host validates loopback-only then replays it.
        "acp_deliver_auth_redirect" => {
            handle_deliver_auth_redirect(id, &req.payload, acp).await
        }
        "send_prompt" => handle_send_prompt(id, &req.payload, acp, relay).await,
        // CAP-2: host-authored durable agent-switch marker (desktop parity
        // with the `acp_record_agent_switch` Tauri command). Persists the
        // `agent_switch` record through `SessionPersistence`, then fans the
        // synthetic live event — ONE durable record per switch.
        "record_agent_switch" => {
            handle_record_agent_switch(id, &req.payload, acp, relay, history_mode).await
        }
        "cancel_prompt" => handle_cancel_prompt(id, &req.payload, acp).await,
        "set_mode" => handle_set_mode(id, &req.payload, acp).await,
        "set_model" => handle_set_model(id, &req.payload, acp).await,
        "set_config_option" => handle_set_config_option(id, &req.payload, acp).await,
        // OS caps (AC8): server-fulfilled; reject browser requests.
        t if is_os_fulfilled_cap(t) => WsReply::err(
            id,
            WsErrorCode::Unsupported,
            format!(
                "`{t}` is an OS-fulfilled cap; the server handles it locally (not relayed to the browser)"
            ),
        ),
        // Unknown request types: `not_implemented`. The message names the
        // offending type and nothing else — no stale epic references.
        _ => WsReply::err(
            id,
            WsErrorCode::NotImplemented,
            format!("`{}` is not implemented by this server", req.type_),
        ),
    }
}
