//! Request routing: the post-auth `route_request` match and the connection
//! subscription cleanup. The pre-auth gate, capability check and executor
//! hand-off live in `relay::conn`.

use super::*;

pub(super) async fn cleanup_connection_subscriptions(
    relay: &Arc<WsRelaySink>,
    subscriptions: &Subscriptions,
) {
    let subscriptions = subscriptions.take_all();
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
    // Issue #841: questions now align with the permission disconnect grace
    // — the last subscriber leaving arms the same bounded
    // last-subscriber grace instead of instantly cancelling outstanding
    // questions (a user who comes back within the window finds them
    // still pending). Expiry (with no subscriber restored) resolves them
    // as cancelled, mirroring the permission deny-on-grace-expiry.
    if let Some(rendezvous) = relay.question_rendezvous() {
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
}

/// Route one validated post-auth request to its handler and return the reply.
/// The caller has already passed the pre-auth gate and the required-capability
/// check; `authenticate` is idempotent here.
///
/// The ACP command types (`create_session`, `cancel_prompt`, …) forward to
/// `AcpManager` (Story 1.8); `respond_permission` routes through the Story 1.7
/// rendezvous; OS-cap requests → `unsupported`; unknown types →
/// `not_implemented`. `send_prompt` is NOT routed here: its reply is deferred
/// (accept now, complete on its own task), so `relay::conn::run_request`
/// handles it.
pub(super) async fn route_request(req: WsRequest, env: &HandlerEnv) -> WsReply {
    let id = req.id.clone();
    let acp = &env.acp;
    let relay = &env.relay;
    let registry = &env.registry;
    let registry_persistence = env.registry_persistence.as_ref();
    let projects_file = env.projects_file.as_deref();
    let out_tx = &env.out_tx;
    let subscribed_clients = &*env.subscriptions;
    let history_mode = env.history_mode;
    let acp_catalog = env.acp_catalog.as_ref();
    let acp_install = env.acp_install.as_ref();
    let store = env.store.as_ref();
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
        "respond_permission" => handle_respond_permission(id, &req.payload, relay, env.connection_id).await,
        // Issue #411: `answer_question` — route the browser's structured-question
        // answer through the server-side question rendezvous (first-response-wins,
        // TOCTOU re-validation) to `AcpManager::answer_question`, which resolves
        // the agent's `Responder` on the driver thread.
        "answer_question" => handle_answer_question(id, &req.payload, relay, env.connection_id).await,
        // Story 1.8: ACP command forwarding → `AcpManager`. The streaming events
        // (`message_chunk`, `tool_call`, `prompt_complete`, `session_created`,
        // `config_options_update`, …) flow back automatically through the
        // existing `fan_out` → `WsRelaySink::emit` → WS frame → store pipeline.
        "create_session" => {
            handle_create_session(id, &req.payload, acp, registry, req.command_id.clone()).await
        }
        "load_session" => handle_load_session(id, &req.payload, acp).await,
        "resume_session" => handle_resume_session(id, &req.payload, acp).await,
        "close_session" => handle_close_session(id, &req.payload, acp).await,
        "dispose_ephemeral_session" => {
            handle_dispose_ephemeral_session(id, &req.payload, acp, relay, subscribed_clients).await
        }
        "list_sessions" => handle_list_sessions(id, &req.payload, acp).await,
        // Story 8: promote a backend-ephemeral warm-pool session to durable
        // (register persistence metadata + clear the ephemeral mark).
        "promote_session" => handle_promote_session(id, &req.payload, acp).await,
        "register_discovered_session" => {
            handle_register_discovered_session(id, &req.payload, acp, relay).await
        }
        // Per-project fs watch (`fs_changed` goes only to subscribed
        // connections): refcounted in `relay.fs_watches()`, released on
        // `unwatch_project`, connection close, or project archive/remove.
        "watch_project" => handle_watch_project(id, &req.payload, relay, registry, out_tx),
        "unwatch_project" => handle_unwatch_project(id, &req.payload, relay, out_tx),
        // Explicit host-default change (Epic 7 — cross-client continuity).
        // Updates the host's
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
        "spawn_agent" => handle_spawn_agent(id, &req.payload, acp, req.command_id.clone()).await,
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
        "kill_agent" => handle_kill_agent(id, &req.payload, acp).await,
        "list_agents" => handle_list_agents(id, acp).await,
        // CAP: ACP agent `authenticate` method (agent-advertised auth, e.g.
        // `pi_terminal_login`). Distinct from the WS connection `authenticate`
        // token gate — this runs the method on the host where the agent lives.
        "authenticate_agent" => handle_authenticate_agent(id, &req.payload, acp).await,
        "logout_agent" => handle_logout_agent(id, &req.payload, acp).await,
        "delete_agent_session" => handle_delete_agent_session(id, &req.payload, acp).await,
        "respond_elicitation" => handle_respond_elicitation(id, &req.payload, acp).await,
        // Paste-back half of the headless browser-auth flow
        // (spec-acp-terminal-auth): the client delivers the failed loopback
        // redirect URL; the host validates loopback-only then replays it.
        "acp_deliver_auth_redirect" => {
            handle_deliver_auth_redirect(id, &req.payload, acp).await
        }
        // CAP-2: host-authored durable agent-switch marker (desktop parity
        // with the `acp_record_agent_switch` Tauri command). The relay numbers
        // ONE `agent_switch` record, persists it and delivers it live under
        // the same seq — ONE durable record per switch.
        "record_agent_switch" => {
            handle_record_agent_switch(id, &req.payload, acp, relay, history_mode).await
        }
        "cancel_prompt" => handle_cancel_prompt(id, &req.payload, acp).await,
        "set_mode" => handle_set_mode(id, &req.payload, acp).await,
        "set_model" => handle_set_model(id, &req.payload, acp).await,
        "set_config_option" => handle_set_config_option(id, &req.payload, acp).await,
        // Test hook: a handler that panics (the connection must be closed).
        #[cfg(test)]
        "panic_for_test" => panic!("handler panic injected by a test"),
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
