//! Agent WS handlers: spawn/kill/list, ACP catalog + opt-in, verified
//! install, agent `authenticate`, and auth-redirect delivery.

use super::*;

// --- Story 1.8 ACP command handlers -----------------------------------------
//
// Each handler parses a camelCase payload (mirroring the renderer's
// `acp-transport.ts` request shapes), calls the corresponding `AcpManager`
// method, and maps `Result<T, String>` → `WsReply`. The streaming events
// emitted by `AcpManager` (via `fan_out` → `WsRelaySink`) flow back to the
// browser automatically — these handlers only own the request/reply half.

/// `spawn_agent` → `AcpManager::spawn(config)`. Mirrors Tauri `acp_spawn_agent`
/// invoke args `{ config }`. Reply payload = the [`SpawnOutcome`] (camelCase:
/// `agentId`/`capabilities`/`authMethods`/`stableNamespace?`) — the
/// authoritative spawn metadata so the renderer populates the store
/// synchronously from the response (CAP-4: the spawn response — not the async
/// `agent_spawned` event — is the source of truth on both desktop and web).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SpawnAgentPayload {
    config: AgentConfig,
}

pub(super) async fn handle_spawn_agent(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
    current_agent: &mut Option<crate::acp::AgentId>,
) -> WsReply {
    let mut parsed: SpawnAgentPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed spawn_agent payload (want config): {e}"),
            )
        }
    };
    // Mirror desktop `validateAgentConfig`: trim + require non-empty name/command.
    parsed.config.name = parsed.config.name.trim().to_string();
    parsed.config.command = parsed.config.command.trim().to_string();
    if parsed.config.name.is_empty() {
        return WsReply::err(
            id,
            WsErrorCode::Unsupported,
            "spawn_agent requires a non-empty `config.name`",
        );
    }
    if parsed.config.command.is_empty() {
        return WsReply::err(
            id,
            WsErrorCode::Unsupported,
            "spawn_agent requires a non-empty `config.command`",
        );
    }
    // OQ1: require a non-empty `config.configId` (mirrors `acp_spawn_agent`)
    // so the spawn path derives a stable `config:{config_id}` namespace on web
    // too. Shared guard lives in `acp::config::require_config_id`.
    if let Err(msg) = crate::acp::config::require_config_id(&parsed.config) {
        return WsReply::err(id, WsErrorCode::Unsupported, msg);
    }
    match acp.spawn(parsed.config).await {
        Ok(outcome) => {
            // Track the spawned agent so a later `switch_project` can reuse it
            // (Ask-First resolution: do NOT auto-spawn on switch).
            *current_agent = Some(outcome.agent_id.clone());
            ok_with_payload(id, &outcome)
        }
        Err(e) => acp_err_to_reply(id, e),
    }
}

/// `kill_agent` → `AcpManager::kill(agent_id)`. Mirrors Tauri `acp_kill_agent`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct KillAgentPayload {
    agent_id: crate::acp::AgentId,
}

pub(super) async fn handle_kill_agent(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
    current_agent: &mut Option<AgentId>,
    current_session: &Arc<parking_lot::Mutex<Option<SessionId>>>,
    current_project: &Arc<parking_lot::Mutex<Option<String>>>,
) -> WsReply {
    let parsed: KillAgentPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed kill_agent payload (want agentId): {e}"),
            )
        }
    };
    match acp.kill(&parsed.agent_id).await {
        Ok(()) => {
            // If the killed agent is this connection's tracked agent, drop the
            // tracking so a later `switch_project` does not reuse the dead id
            // (which would map `new_session`'s "unknown agent" to `not_found").
            // The web client must spawn/create a session again first.
            if current_agent
                .as_ref()
                .is_some_and(|a| *a == parsed.agent_id)
            {
                *current_agent = None;
                *current_session.lock() = None;
                *current_project.lock() = None;
            }
            WsReply::ok(id, Some(json!({})))
        }
        Err(e) => acp_err_to_reply(id, e),
    }
}

/// `list_agents` → `AcpManager::list_agent_summaries()` (CAP-11). Reply =
/// `AgentSummary[]` — identity-rich `{ id, name, configId?, namespace?,
/// capabilities }` objects, replacing bare id strings. The only in-repo
/// consumer (`WsAcpTransport.listAgents`) maps `.id`; `listAgentDetails`
/// keeps the full summaries. Desktop parity: `acp_list_agent_details`.
pub(super) async fn handle_list_agents(id: String, acp: &Arc<AcpManager>) -> WsReply {
    // Issue #837: enrich each summary with the agent's owned-session set so a
    // reloading web client can resolve "which live agent owns this session"
    // from this reply alone and reuse that process instead of spawning a
    // duplicate.
    let summaries = acp.list_agent_summaries_with_ownership().await;
    // Boundary log: count only — agent configs/credentials are never logged.
    tracing::info!("[ws] list_agents success agents={}", summaries.len());
    ok_with_payload(id, &summaries)
}

// --- CAP-6 / Story 8: ACP catalog WS handlers ------------------------------

/// `list_acp_catalog` WS request payload. `refresh` is optional (defaults to
/// false — serve the cached catalog if fresh within the TTL).
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub(super) struct ListAcpCatalogPayload {
    refresh: Option<bool>,
}

pub(super) async fn handle_list_acp_catalog(
    id: String,
    payload: &Value,
    acp_catalog: Option<&Arc<crate::acp::AcpCatalogService>>,
    acp_install: Option<&Arc<crate::acp::install::AcpInstallService>>,
) -> WsReply {
    // Distinct SCREAMING_SNAKE_CASE codes matching the HTTP route
    // (`catalog_api::list`) byte-for-byte (the protocol-level `WsErrorCode`
    // enum is snake_case and collapses these to `Unsupported`, masking the
    // real failure for the renderer). `err_with_code` carries the raw string.
    let parsed: ListAcpCatalogPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err_with_code(
                id,
                "VALIDATION_ERROR",
                format!("malformed list_acp_catalog payload: {e}"),
            )
        }
    };
    let Some(service) = acp_catalog.cloned() else {
        return WsReply::err_with_code(
            id,
            "ACP_CATALOG_UNAVAILABLE",
            "acp catalog store is unavailable",
        );
    };
    match service.list_catalog(parsed.refresh.unwrap_or(false)).await {
        Ok(mut catalog) => {
            // Overlay host-installed state so installed agents report `ready`
            // with their resolved command/args — the host is the single
            // source of truth (web has no renderer persistence).
            if let Some(install) = acp_install {
                let installed = install.installed_agents();
                crate::acp::overlay_installed(&mut catalog, &installed);
            }
            ok_with_payload(id, &catalog)
        }
        Err(error) => WsReply::err_with_code(
            id,
            "CATALOG_LOAD_FAILED",
            format!("catalog load failed: {error}"),
        ),
    }
}

/// `set_catalog_opt_in` WS request payload. `deny_unknown_fields` rejects an
/// over-serialized payload loudly at the host boundary.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SetCatalogOptInPayload {
    enabled: bool,
}

pub(super) async fn handle_set_catalog_opt_in(
    id: String,
    payload: &Value,
    acp_catalog: Option<&Arc<crate::acp::AcpCatalogService>>,
) -> WsReply {
    // Distinct SCREAMING_SNAKE_CASE codes matching the HTTP route
    // (`catalog_api::set_opt_in`) byte-for-byte. A malformed payload is
    // `VALIDATION_ERROR`, a missing store is `ACP_CATALOG_UNAVAILABLE`, and a
    // persistence failure is `ACP_CATALOG_OPT_IN_FAILED` (NOT collapsed to
    // `Unsupported`, which the renderer could not distinguish from a genuine
    // catalog-load failure).
    let parsed: SetCatalogOptInPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err_with_code(
                id,
                "VALIDATION_ERROR",
                format!("malformed set_catalog_opt_in payload (want enabled): {e}"),
            )
        }
    };
    let Some(service) = acp_catalog.cloned() else {
        return WsReply::err_with_code(
            id,
            "ACP_CATALOG_UNAVAILABLE",
            "acp catalog store is unavailable",
        );
    };
    match service.set_opt_in(parsed.enabled) {
        Ok(()) => WsReply::ok(id, Some(json!({}))),
        Err(error) => WsReply::err_with_code(
            id,
            "ACP_CATALOG_OPT_IN_FAILED",
            format!("opt-in persistence failed: {error}"),
        ),
    }
}

// --- CAP-6 / Story 9: ACP install WS handler --------------------------------

/// `install_acp_agent` WS request payload. `deny_unknown_fields` rejects an
/// over-serialized payload loudly at the host boundary (the request is
/// `{ agentId }` only — never carries archive URLs, commands, executable
/// paths, or args; the host resolves everything from the trusted catalog).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct InstallAcpAgentPayload {
    agent_id: String,
}

/// `install_acp_agent` WS request handler. Mirrors the desktop
/// `#[tauri::command] acp_install_agent` + HTTP `POST /acp/install` handlers.
/// Degrade-mode (`acp_install: None`) returns `ACP_INSTALL_UNAVAILABLE`. All
/// errors carry SCREAMING_SNAKE_CASE codes byte-identical to the other
/// transports via `WsReply::err_with_code` (the protocol-level `WsErrorCode`
/// enum is snake_case, so the install codes use the raw-string constructor).
pub(super) async fn handle_install_acp_agent(
    id: String,
    payload: &Value,
    acp_install: Option<&Arc<crate::acp::install::AcpInstallService>>,
) -> WsReply {
    use crate::acp::install::code;
    let parsed: InstallAcpAgentPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err_with_code(
                id,
                code::VALIDATION_ERROR,
                format!("malformed install_acp_agent payload (want agentId): {e}"),
            )
        }
    };
    let Some(service) = acp_install.cloned() else {
        return WsReply::err_with_code(
            id,
            code::ACP_INSTALL_UNAVAILABLE,
            "acp install store is unavailable",
        );
    };
    match service.install_by_id(&parsed.agent_id).await {
        Ok(outcome) => ok_with_payload(id, &outcome),
        Err(error) => WsReply::err_with_code(id, error.code(), error.message),
    }
}

/// `authenticate_agent` → `AcpManager::authenticate(agent_id, method_id)`.
/// Runs the ACP agent-advertised `authenticate` method (e.g.
/// `pi_terminal_login`) on the host where the agent process runs. Distinct
/// from the WS connection `authenticate` token gate — this is the agent
/// method, not the relay handshake. Mirrors the desktop `acp_authenticate`
/// Tauri command (both call `AcpManager::authenticate`). The provider owns
/// the login UX (often opens its own browser); Termul never invents a
/// redirect URL or stores credentials.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AuthenticateAgentPayload {
    agent_id: crate::acp::AgentId,
    method_id: String,
    #[serde(default)]
    gateway: Option<crate::acp::manager::GatewayAuthInput>,
}

pub(super) async fn handle_authenticate_agent(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
) -> WsReply {
    let parsed: AuthenticateAgentPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err_with_code(
                id,
                "VALIDATION_ERROR",
                format!("malformed authenticate_agent payload (want agentId, methodId): {e}"),
            )
        }
    };
    debug!(
        target: "termul::web::ws",
        agent = %parsed.agent_id,
        method = %parsed.method_id,
        "authenticate_agent: invoking agent auth method"
    );
    // `AcpManager::authenticate` takes `method_id` by value, so keep a clone
    // for the failure log (the debug! above borrows before the move).
    let method_id = parsed.method_id.clone();
    let gateway = parsed.gateway.clone();
    match acp
        .authenticate(&parsed.agent_id, parsed.method_id, gateway)
        .await
    {
        Ok(()) => WsReply::ok(id, Some(json!({}))),
        Err(e) => {
            warn!(
                target: "termul::web::ws",
                agent = %parsed.agent_id,
                method = %method_id,
                error = %e,
                "authenticate_agent: agent auth failed"
            );
            WsReply::err_with_code(id, "AUTHENTICATE_FAILED", e)
        }
    }
}

/// `acp_deliver_auth_redirect` → `AcpManager::deliver_auth_redirect(agent_id, url)`.
///
/// The paste-back half of the headless browser-auth flow
/// (spec-acp-terminal-auth): the web client collects the failed `127.0.0.1`
/// redirect URL from the user's own browser and delivers it here. The manager
/// validates it is http(s) AND loopback-only (SSRF guard — a non-loopback URL
/// is rejected before any outbound request), then GETs it so the agent's own
/// callback listener completes the flow. Mirrors the desktop
/// `acp_auth_deliver_redirect` Tauri command (both call
/// `AcpManager::deliver_auth_redirect`). Success payload `{status}` is the
/// listener's HTTP status code.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DeliverAuthRedirectPayload {
    agent_id: crate::acp::AgentId,
    url: String,
}

pub(super) async fn handle_deliver_auth_redirect(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
) -> WsReply {
    let parsed: DeliverAuthRedirectPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err_with_code(
                id,
                "VALIDATION_ERROR",
                format!("malformed acp_deliver_auth_redirect payload (want agentId, url): {e}"),
            )
        }
    };
    // Never log the URL — it carries OAuth state. The manager logs host+port.
    debug!(
        target: "termul::web::ws",
        agent = %parsed.agent_id,
        "acp_deliver_auth_redirect: replaying pasted redirect"
    );
    match acp
        .deliver_auth_redirect(&parsed.agent_id, parsed.url)
        .await
    {
        Ok(status) => WsReply::ok(id, Some(json!({ "status": status }))),
        Err(e) => {
            warn!(
                target: "termul::web::ws",
                agent = %parsed.agent_id,
                error = %e,
                "acp_deliver_auth_redirect: replay failed"
            );
            WsReply::err_with_code(id, "AUTH_REDIRECT_FAILED", e)
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentSessionPayload {
    agent_id: crate::acp::AgentId,
    session_id: crate::acp::SessionId,
}

pub(super) async fn handle_delete_agent_session(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
) -> WsReply {
    let parsed: AgentSessionPayload = match serde_json::from_value(payload.clone()) {
        Ok(parsed) => parsed,
        Err(error) => {
            return WsReply::err_with_code(
                id,
                "VALIDATION_ERROR",
                format!("malformed delete_agent_session payload: {error}"),
            );
        }
    };
    match acp
        .delete_agent_session(&parsed.agent_id, parsed.session_id)
        .await
    {
        Ok(()) => WsReply::ok(id, Some(json!({}))),
        Err(error) => {
            warn!("[acp] session/delete failed: {error}");
            WsReply::err_with_code(id, "DELETE_SESSION_FAILED", error)
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogoutAgentPayload {
    agent_id: crate::acp::AgentId,
}

pub(super) async fn handle_logout_agent(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
) -> WsReply {
    let parsed: LogoutAgentPayload = match serde_json::from_value(payload.clone()) {
        Ok(parsed) => parsed,
        Err(error) => {
            return WsReply::err_with_code(
                id,
                "VALIDATION_ERROR",
                format!("malformed logout_agent payload: {error}"),
            );
        }
    };
    match acp.logout(&parsed.agent_id).await {
        Ok(()) => {
            info!("[acp] logout completed");
            WsReply::ok(id, Some(json!({})))
        }
        Err(error) => {
            warn!("[acp] logout failed: {error}");
            WsReply::err_with_code(id, "LOGOUT_FAILED", error)
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RespondElicitationPayload {
    agent_id: crate::acp::AgentId,
    request_id: String,
    action: String,
    #[serde(default)]
    content: Option<serde_json::Map<String, Value>>,
}

pub(super) async fn handle_respond_elicitation(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
) -> WsReply {
    let parsed: RespondElicitationPayload = match serde_json::from_value(payload.clone()) {
        Ok(parsed) => parsed,
        Err(error) => {
            return WsReply::err_with_code(
                id,
                "VALIDATION_ERROR",
                format!("malformed respond_elicitation payload: {error}"),
            );
        }
    };
    match acp
        .respond_elicitation(
            &parsed.agent_id,
            parsed.request_id,
            parsed.action,
            parsed.content,
        )
        .await
    {
        Ok(()) => WsReply::ok(id, Some(json!({}))),
        Err(error) if error.starts_with("unknown elicitation request") => {
            WsReply::ok(id, Some(json!({})))
        }
        Err(error) => WsReply::err_with_code(id, "ELICITATION_FAILED", error),
    }
}
