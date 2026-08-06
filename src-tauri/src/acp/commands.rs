//! Thin `#[tauri::command]` wrappers over `AcpManager`.
//!
//! Each command takes `State<'_, Arc<AcpManager>>`, forwards to the manager
//! (which talks to the per-agent driver thread over channels), and awaits the
//! `Send` oneshot reply. No command awaits a `!Send` connection future
//! directly — that work is confined to the driver threads.

use std::sync::Arc;

use agent_client_protocol::schema::v1::{
    ContentBlock, ListSessionsResponse, McpServer, SessionConfigOption, StopReason, TextContent,
};
use tauri::State;

use crate::acp::config::{AgentConfig, AgentId, SessionId};
use crate::acp::manager::{
    AcpManager, NewSessionOutcome, SessionCreationContext, SessionReopenOutcome, SpawnOutcome,
};

/// Spawn an ACP agent subprocess and complete the `initialize` handshake.
/// Returns the authoritative [`SpawnOutcome`] (capabilities + auth methods +
/// stable namespace) so the renderer populates the store synchronously from
/// the response (CAP-4: the spawn response — not the async event — is the
/// source of truth). Mirrors the WS `spawn_agent` handler payload.
#[tauri::command]
pub async fn acp_spawn_agent(
    manager: State<'_, Arc<AcpManager>>,
    config: AgentConfig,
) -> Result<SpawnOutcome, String> {
    manager.spawn(config).await
}

/// Kill an agent and join its driver thread. Idempotent.
#[tauri::command]
pub async fn acp_kill_agent(
    manager: State<'_, Arc<AcpManager>>,
    agent_id: AgentId,
) -> Result<(), String> {
    manager.kill(&agent_id).await
}

/// List the ids of all live agents.
#[tauri::command]
pub async fn acp_list_agents(manager: State<'_, Arc<AcpManager>>) -> Result<Vec<AgentId>, String> {
    Ok(manager.list_agents())
}

/// Create a new session. `mcpServers` is passed through to `session/new` as-is.
/// `projectId` (CAP-2 attribution) is optional; the renderer passes the owning
/// project so the host-owned durable record is project-scoped.
#[tauri::command]
pub async fn acp_new_session(
    manager: State<'_, Arc<AcpManager>>,
    agent_id: AgentId,
    cwd: String,
    mcp_servers: Option<Vec<McpServer>>,
    ephemeral: Option<bool>,
    project_id: Option<String>,
) -> Result<NewSessionOutcome, String> {
    manager
        .new_session_with_context(
            &agent_id,
            cwd,
            mcp_servers.unwrap_or_default(),
            SessionCreationContext {
                project_id: project_id.filter(|id| !id.trim().is_empty()),
                ephemeral: ephemeral.unwrap_or(false),
            },
        )
        .await
}

/// Load an existing session (requires the agent's `loadSession` capability).
#[tauri::command]
pub async fn acp_load_session(
    manager: State<'_, Arc<AcpManager>>,
    agent_id: AgentId,
    session_id: SessionId,
    cwd: String,
) -> Result<SessionReopenOutcome, String> {
    manager.load_session(&agent_id, session_id, cwd).await
}

/// Resume a session (requires the agent's `sessionCapabilities.resume`).
#[tauri::command]
pub async fn acp_resume_session(
    manager: State<'_, Arc<AcpManager>>,
    agent_id: AgentId,
    session_id: SessionId,
    cwd: String,
) -> Result<SessionReopenOutcome, String> {
    manager.resume_session(&agent_id, session_id, cwd).await
}

/// Close a session (requires the agent's `sessionCapabilities.close`).
#[tauri::command]
pub async fn acp_close_session(
    manager: State<'_, Arc<AcpManager>>,
    agent_id: AgentId,
    session_id: SessionId,
) -> Result<(), String> {
    manager.close_session(&agent_id, session_id).await
}

#[tauri::command]
pub async fn acp_dispose_ephemeral_session(
    manager: State<'_, Arc<AcpManager>>,
    agent_id: AgentId,
    session_id: SessionId,
) -> Result<(), String> {
    manager
        .dispose_ephemeral_session(&agent_id, session_id)
        .await
}

/// List sessions on an agent (requires `sessionCapabilities.list`).
/// Pass `cwd` to filter by working directory; `cursor` for pagination.
#[tauri::command]
pub async fn acp_list_sessions(
    manager: State<'_, Arc<AcpManager>>,
    agent_id: AgentId,
    cwd: Option<String>,
    cursor: Option<String>,
) -> Result<ListSessionsResponse, String> {
    manager.list_sessions(&agent_id, cwd, cursor).await
}

/// Send a prompt turn. Accepts either structured ACP content blocks or, for
/// convenience, a plain text string (wrapped into a single text block).
#[tauri::command]
pub async fn acp_send_prompt(
    manager: State<'_, Arc<AcpManager>>,
    agent_id: AgentId,
    session_id: SessionId,
    content: Option<Vec<ContentBlock>>,
    text: Option<String>,
) -> Result<StopReason, String> {
    let blocks = match (content, text) {
        (Some(blocks), _) if !blocks.is_empty() => blocks,
        // Empty `content` falls back to `text` when provided.
        (_, Some(text)) => vec![ContentBlock::Text(TextContent::new(text))],
        (Some(_), None) => return Err("prompt content must not be empty".to_string()),
        (None, None) => return Err("send_prompt requires either content or text".to_string()),
    };
    // Desktop path: no client turn-id (the renderer's dedup is Tauri-event-
    // based; the WS `turnId` field is Story 1.8's web concern). Pass `None`.
    manager
        .send_prompt(&agent_id, session_id, blocks, None)
        .await
}

/// Cancel the active turn for a session.
#[tauri::command]
pub async fn acp_cancel_prompt(
    manager: State<'_, Arc<AcpManager>>,
    agent_id: AgentId,
    session_id: SessionId,
) -> Result<(), String> {
    manager.cancel_prompt(&agent_id, session_id).await
}

/// Set a session configuration option, returning the updated option set.
#[tauri::command]
pub async fn acp_set_config_option(
    manager: State<'_, Arc<AcpManager>>,
    agent_id: AgentId,
    session_id: SessionId,
    config_id: String,
    value_id: String,
) -> Result<Vec<SessionConfigOption>, String> {
    manager
        .set_config_option(&agent_id, session_id, config_id, value_id)
        .await
}

/// Set the active session mode.
#[tauri::command]
pub async fn acp_set_mode(
    manager: State<'_, Arc<AcpManager>>,
    agent_id: AgentId,
    session_id: SessionId,
    mode_id: String,
) -> Result<(), String> {
    manager.set_mode(&agent_id, session_id, mode_id).await
}

/// Set the active session model.
#[tauri::command]
pub async fn acp_set_model(
    manager: State<'_, Arc<AcpManager>>,
    agent_id: AgentId,
    session_id: SessionId,
    model_id: String,
) -> Result<(), String> {
    manager.set_model(&agent_id, session_id, model_id).await
}

/// Run the ACP `authenticate` method for an agent. `methodId` must be one of
/// the ids advertised in the agent's `initialize` response.
#[tauri::command]
pub async fn acp_authenticate(
    manager: State<'_, Arc<AcpManager>>,
    agent_id: AgentId,
    method_id: String,
) -> Result<(), String> {
    manager.authenticate(&agent_id, method_id).await
}

/// Respond to a pending permission request. `optionId == None` cancels it.
///
/// Two paths can resolve the same permission: the desktop renderer (this
/// command, direct `AcpManager::respond_permission`) and a phone over WS (the
/// `respond_permission` handler → `PermissionRendezvous::try_respond` →
/// `AcpManager::respond_permission`). Both converge on the agent driver's
/// single-use `take_permission` gate, so whichever responds first wins.
///
/// When this command loses the race (the phone resolved first, or the user
/// clicked twice), `take_permission` returns `None` and the driver replies
/// `Err("unknown permission request: …")`. That is a benign "already resolved"
/// outcome, not a real error — surface it as `Ok(())` so the renderer doesn't
/// show a confusing error for the loser of a race the user intended to win.
#[tauri::command]
pub async fn acp_respond_permission(
    manager: State<'_, Arc<AcpManager>>,
    agent_id: AgentId,
    request_id: String,
    option_id: Option<String>,
) -> Result<(), String> {
    match manager
        .respond_permission(&agent_id, request_id, option_id)
        .await
    {
        Ok(()) => Ok(()),
        // Loser of a first-response-wins race: the permission was already
        // resolved by the other path. Treat as success (idempotent resolve).
        Err(e) if e.starts_with("unknown permission request") => Ok(()),
        Err(e) => Err(e),
    }
}

/// Route a structured-question answer (issue #411) to a waiting agent request.
///
/// Mirrors [`acp_respond_permission`]: `values == None` cancels the question;
/// `Some(values)` submits the selected option values. When this command loses
/// the race (the phone resolved first, or the user clicked twice),
/// `take_question` returns `None` and the driver replies
/// `Err("unknown question request: …")`. That is a benign "already resolved"
/// outcome — surface it as `Ok(())` so the renderer doesn't show a confusing
/// error for the loser of a race the user intended to win.
#[tauri::command]
pub async fn acp_answer_question(
    manager: State<'_, Arc<AcpManager>>,
    agent_id: AgentId,
    question_id: String,
    values: Option<Vec<String>>,
) -> Result<(), String> {
    match manager
        .answer_question(&agent_id, question_id, values)
        .await
    {
        Ok(()) => Ok(()),
        // Loser of a first-response-wins race: the question was already
        // resolved by the other path. Treat as success (idempotent resolve).
        Err(e) if e.starts_with("unknown question request") => Ok(()),
        Err(e) => Err(e),
    }
}

/// Probe whether registry package-manager launchers (`npx` / `uvx`) are on PATH.
#[tauri::command]
pub fn acp_probe_runtime() -> crate::acp::config::AcpRuntimeProbe {
    crate::acp::config::probe_registry_runtime()
}

/// `acp_list_catalog(refresh?: bool)` — resolve the host-owned ACP catalog
/// (CAP-6 / Story 8). Returns the host's OS/arch/runtime availability + the
/// per-agent resolved `SupportedAcpAgentStatus` (ready / install-required /
/// needs-runtime / manual-install / unavailable). The catalog is
/// credential-free, path-free, read-only host introspection — never carries
/// `AgentConfig.env` (API keys) or resolved absolute executable paths.
/// Mirrors `GET /acp/catalog` + WS `list_acp_catalog` byte-for-byte.
#[tauri::command]
pub async fn acp_list_catalog(
    refresh: Option<bool>,
    store: State<'_, crate::commands::HostAcpCatalogStore>,
) -> Result<crate::commands::IpcResult<crate::acp::AcpCatalog>, String> {
    let refresh = refresh.unwrap_or(false);
    log::info!("[acp-catalog] list start refresh={refresh}");
    let Some(service) = store.store().map(std::sync::Arc::clone) else {
        log::warn!("[acp-catalog] list unavailable (no host store)");
        return Ok(crate::commands::IpcResult::error(
            "acp catalog store is unavailable",
            "ACP_CATALOG_UNAVAILABLE",
        ));
    };
    match service.list_catalog(refresh).await {
        Ok(catalog) => {
            log::info!(
                "[acp-catalog] list success agents={}",
                catalog.agents.len()
            );
            Ok(crate::commands::IpcResult::success(catalog))
        }
        Err(error) => {
            log::error!("[acp-catalog] list failure error={error}");
            Ok(crate::commands::IpcResult::error(
                error.to_string(),
                "CATALOG_LOAD_FAILED",
            ))
        }
    }
}

/// `acp_set_catalog_opt_in(enabled: bool)` — persist the host opt-in flag that
/// gates the CDN registry augmentation (CAP-6 / Story 8). When enabled, the
/// next `list_catalog` includes CDN entries tagged `source: 'registry'` (if
/// the fetch succeeds); when disabled, only bundled entries are served.
/// Mirrors `POST /acp/catalog/opt-in` + WS `set_catalog_opt_in` byte-for-byte.
#[tauri::command]
pub async fn acp_set_catalog_opt_in(
    enabled: bool,
    store: State<'_, crate::commands::HostAcpCatalogStore>,
) -> Result<crate::commands::IpcResult<()>, String> {
    log::info!("[acp-catalog] set_opt_in start enabled={enabled}");
    let Some(service) = store.store().map(std::sync::Arc::clone) else {
        log::warn!("[acp-catalog] set_opt_in unavailable (no host store)");
        return Ok(crate::commands::IpcResult::error(
            "acp catalog store is unavailable",
            "ACP_CATALOG_UNAVAILABLE",
        ));
    };
    match service.set_opt_in(enabled) {
        Ok(()) => {
            log::info!("[acp-catalog] set_opt_in success enabled={enabled}");
            Ok(crate::commands::IpcResult::success(()))
        }
        Err(error) => {
            log::error!("[acp-catalog] set_opt_in failure error={error}");
            Ok(crate::commands::IpcResult::error(
                error.to_string(),
                "ACP_CATALOG_OPT_IN_FAILED",
            ))
        }
    }
}

/// On-demand MCP client probe. Takes a renderer-supplied `McpServerConfig`
/// (stateless — no registry-store coupling), opens a fresh rmcp client
/// connection, calls `initialize` + `tools/list`, then closes, and returns
/// the connected/disconnected status + tool list. Never logs env/header
/// values, tokens, or credentials. Mirrors the stateless shape of
/// `acp_probe_runtime`.
#[tauri::command]
pub async fn acp_probe_mcp_server(
    server: crate::acp::mcp_probe::McpServerConfig,
) -> Result<crate::acp::mcp_probe::ProbeResult, String> {
    Ok(crate::acp::mcp_probe::probe(server).await)
}

/// Set the in-process ACP turn (hard-cap) timeout override, in seconds, or
/// `None` to clear it (fall back to the env var / 3h default). Pushed from the
/// App Preferences UI so the turn timeout is editable without a restart or
/// env var. Desktop-only: the standalone `termul-server` has no settings
/// surface and configures via `TERMUL_ACP_TURN_TIMEOUT_SECS`. The env var
/// remains top-precedence (operator/diagnostic override).
#[tauri::command]
pub fn acp_set_turn_timeout(secs: Option<u64>) -> Result<(), String> {
    crate::acp::manager::set_turn_timeout_override(secs);
    Ok(())
}
