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
use serde_json::json;
use tauri::State;

use crate::acp::config::{require_config_id, AgentConfig, AgentId, SessionId};
use crate::acp::manager::{
    AcpManager, NewSessionOutcome, SessionCreationContext, SessionReopenOutcome, SpawnOutcome,
};
use crate::acp::session_persistence::{SessionIndexEntry, SessionRegistration};
use crate::web::WsRelaySink;

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
    // OQ1: reject an AgentConfig without a non-empty `configId` so the spawn
    // path derives a stable `config:{config_id}` namespace (no fallback hash).
    // Shared with the WS `spawn_agent` handler via `require_config_id`.
    require_config_id(&config)?;
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
/// project so the host-owned durable record is project-scoped. `worktreePath` +
/// `worktreeBranch` (CAP-3) are persisted for the chat indicator + the
/// deleted-worktree fallback; state isolation still keys on `cwd`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn acp_new_session(
    manager: State<'_, Arc<AcpManager>>,
    agent_id: AgentId,
    cwd: String,
    mcp_servers: Option<Vec<McpServer>>,
    ephemeral: Option<bool>,
    project_id: Option<String>,
    worktree_path: Option<String>,
    worktree_branch: Option<String>,
) -> Result<NewSessionOutcome, String> {
    manager
        .new_session_with_context(
            &agent_id,
            cwd,
            mcp_servers.unwrap_or_default(),
            SessionCreationContext {
                project_id: project_id.filter(|id| !id.trim().is_empty()),
                ephemeral: ephemeral.unwrap_or(false),
                worktree_path: worktree_path.filter(|p| !p.trim().is_empty()),
                worktree_branch: worktree_branch.filter(|b| !b.trim().is_empty()),
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

/// Promote agent-owned discovered session metadata into host persistence.
#[tauri::command]
pub async fn acp_register_discovered_session(
    manager: State<'_, Arc<AcpManager>>,
    session_id: String,
    agent_id: AgentId,
    cwd: String,
    title: Option<String>,
    updated_at: Option<u64>,
    project_id: Option<String>,
) -> Result<SessionIndexEntry, String> {
    if session_id.trim().is_empty() || cwd.trim().is_empty() {
        return Err("session id and cwd are required".to_string());
    }
    let persistence = manager
        .persistence()
        .ok_or_else(|| "session persistence unavailable".to_string())?;
    let metadata = persistence
        .register_discovered_session(
            SessionRegistration {
                session_id,
                stable_agent_namespace: manager.stable_agent_namespace(&agent_id)?,
                runtime_agent_id: Some(agent_id.0),
                project_id,
                cwd: cwd.into(),
                ..Default::default()
            },
            title,
            updated_at,
        )
        .await
        .map_err(|error| error.to_string())?;
    log::info!(
        "[acp-history] discovered session promoted session_id={} storage_key={}",
        metadata.session_id,
        metadata.storage_key
    );
    Ok(SessionIndexEntry::from(&metadata))
}

/// Send a prompt turn. Accepts either structured ACP content blocks or, for
/// convenience, a plain text string (wrapped into a single text block).
///
/// Desktop durability parity (CAP-2): before dispatching through
/// `AcpManager::send_prompt`, a non-ephemeral session's accepted prompt is
/// persisted through the `WsRelaySink` durability boundary — the same
/// ordering the WS `send_prompt` handler uses (`web/ws.rs`). A transport
/// failure after acceptance can therefore never erase the user message, and a
/// restored chat materializes the user bubble + derives first-message title
/// provenance. Ephemeral utility sessions are skipped (no durable history).
/// The payload shape (`{agentId, sessionId, turnId, content}`) matches the
/// web path byte-for-byte; `turnId` is `null` on the desktop path (the
/// renderer's dedup is Tauri-event-based, not wire-level).
#[tauri::command]
pub async fn acp_send_prompt(
    manager: State<'_, Arc<AcpManager>>,
    relay: State<'_, Arc<WsRelaySink>>,
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
    // Ownership is authoritative driver state, not client input. Reject a
    // cross-agent session id before persisting any durable prompt record
    // (mirrors the WS `send_prompt` handler ordering).
    match manager.owns_session(&agent_id, session_id.clone()).await {
        Ok(true) => {}
        Ok(false) => return Err("session does not belong to the supplied live agent".to_string()),
        Err(error) => return Err(error),
    }
    // Skip backend-ephemeral sessions — they have no durable history and must
    // not produce a sidebar row. Matches the WS handler's ephemeral gate.
    let ephemeral = match manager
        .is_ephemeral_session(&agent_id, session_id.clone())
        .await
    {
        Ok(value) => value,
        Err(error) => {
            log::warn!(
                "[acp] failed to resolve ephemeral state for session {} (agent {}): {error}",
                session_id.0,
                agent_id.0
            );
            return Err(error);
        }
    };
    if !ephemeral {
        if let Err(error) =
            persist_accepted_prompt(relay.inner(), &agent_id, &session_id, &blocks).await
        {
            // Persistence failure rejects dispatch so a transport failure
            // cannot erase an accepted user message. Log session context only
            // — never the prompt content.
            log::warn!(
                "[acp] failed to persist accepted prompt for session {} (agent {}): {error}",
                session_id.0,
                agent_id.0
            );
            return Err(format!("failed to persist accepted prompt: {error}"));
        }
    }
    // Desktop path: no client turn-id (the renderer's dedup is Tauri-event-
    // based; the WS `turnId` field is Story 1.8's web concern). Pass `None`.
    manager
        .send_prompt(&agent_id, session_id, blocks, None)
        .await
}

/// Persist an accepted desktop prompt through the `WsRelaySink` durability
/// boundary before ACP dispatch. Mirrors the WS `send_prompt` handler
/// (`web/ws.rs`) payload shape (`{agentId, sessionId, turnId, content}`) so
/// the durable `user_prompt` record and the restored user bubble are
/// byte-identical across transports. `turnId` is `null` on the desktop path.
/// Returns `Ok(())` when persisted (or when the relay has no durability
/// attached — live-only mode), or `Err` when the flush failed; the caller
/// must NOT dispatch on `Err`.
pub(crate) async fn persist_accepted_prompt(
    relay: &Arc<WsRelaySink>,
    agent_id: &AgentId,
    session_id: &SessionId,
    blocks: &[ContentBlock],
) -> Result<(), String> {
    let payload = json!({
        "agentId": agent_id.clone(),
        "sessionId": session_id.clone(),
        "turnId": null,
        "content": blocks,
    });
    relay
        .persist_user_prompt(session_id.0.as_str(), payload)
        .await
        .map(|_| ())
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
    install_store: State<'_, crate::commands::HostAcpInstallStore>,
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
        Ok(mut catalog) => {
            // Overlay host-installed state so installed agents report `ready`
            // with their resolved command/args. The host is the single source
            // of truth for "is this agent installed" — desktop and web both
            // see installed agents as ready (the web has no renderer
            // persistence, so without this it could not reuse a host install).
            if let Some(install) = install_store.store() {
                let installed = install.installed_agents();
                crate::acp::overlay_installed(&mut catalog, &installed);
            }
            log::info!("[acp-catalog] list success agents={}", catalog.agents.len());
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

/// `acp_install_agent(agentId)` — host-owned verified-atomic ACP install
/// (CAP-6 / Story 9). Resolves the agent by id from the catalog, downloads the
/// catalog-resolved HTTPS archive, verifies `sha256` (from the catalog's
/// `binary.{os-arch}.sha256` field), extracts safely, atomically activates,
/// serializes per-agent, records an installed-agents manifest, and returns
/// `{ command: absolute_path, args }`. The request is `{ agentId }` only; the
/// host resolves everything from the trusted catalog — never accepts
/// browser-supplied URLs, commands, executable paths, or args.
/// Mirrors `POST /acp/install` + WS `install_acp_agent` byte-for-byte.
///
/// The `request` arg is accepted as a raw `serde_json::Value` and manually
/// deserialized with `deny_unknown_fields` so an extra-field rejection
/// surfaces as `IpcResult::error(..., VALIDATION_ERROR)` — NOT a Tauri serde
/// rejection (which the renderer would map to `INVOKE_ERROR`, breaking the
/// transport parity with HTTP/WS where `deny_unknown_fields` →
/// `VALIDATION_ERROR`). Mirrors `install_api.rs::install` + the WS
/// `handle_install_acp_agent`.
#[tauri::command]
pub async fn acp_install_agent(
    request: serde_json::Value,
    store: State<'_, crate::commands::HostAcpInstallStore>,
) -> Result<crate::commands::IpcResult<crate::acp::install::InstallOutcome>, String> {
    let request: crate::acp::install::InstallRequest = match serde_json::from_value(request) {
        Ok(req) => req,
        Err(error) => {
            log::warn!(
                "[acp-install] {} install_agent validation failed: {error}",
                crate::logging::session_id()
            );
            return Ok(crate::commands::IpcResult::error(
                format!("payload validation failed: {error}"),
                crate::acp::install::code::VALIDATION_ERROR,
            ));
        }
    };
    let agent_id_log = request.agent_id.clone();
    log::info!(
        "[acp-install] {} install_agent start agent={}",
        crate::logging::session_id(),
        agent_id_log
    );
    let Some(service) = store.store().map(std::sync::Arc::clone) else {
        log::warn!(
            "[acp-install] {} install_agent unavailable (no host store)",
            crate::logging::session_id()
        );
        return Ok(crate::commands::IpcResult::error(
            "acp install store is unavailable",
            crate::acp::install::code::ACP_INSTALL_UNAVAILABLE,
        ));
    };
    match service.install_by_id(&request.agent_id).await {
        Ok(outcome) => {
            log::info!(
                "[acp-install] {} install_agent success agent={}",
                crate::logging::session_id(),
                agent_id_log
            );
            Ok(crate::commands::IpcResult::success(outcome))
        }
        Err(error) => {
            let code = error.code();
            log::error!(
                "[acp-install] {} install_agent failure agent={} code={} msg={}",
                crate::logging::session_id(),
                agent_id_log,
                code,
                error.message
            );
            Ok(crate::commands::IpcResult::error(error.message, code))
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
/// Start the MCP OAuth flow for a server URL. Discovers the OAuth endpoints,
/// registers a client (PKCE), opens the authorization URL in the system
/// browser, and waits for the callback redirect on a local HTTP server.
/// Returns the stored token on success. Desktop-only: the standalone server
/// has no UI to drive the browser flow.
#[tauri::command]
pub async fn acp_mcp_oauth_start(app: tauri::AppHandle, server_url: String) -> Result<(), String> {
    use std::net::TcpListener;
    use tauri_plugin_opener::OpenerExt;
    use rmcp::transport::auth::{AuthorizationManager, AuthorizationSession, OAuthState};

    // Bind a local TCP listener on an OS-assigned port for the OAuth callback.
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("failed to bind callback listener: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("failed to get callback port: {e}"))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}{}", crate::acp::mcp_oauth::OAUTH_REDIRECT_PATH);

    // Set the listener to non-blocking so we can poll it with a timeout.
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("failed to set non-blocking: {e}"))?;

    // 1. Create AuthorizationManager + discover metadata + register client
    let mut manager = AuthorizationManager::new(&server_url)
        .await
        .map_err(|e| format!("OAuth discovery failed: {e}"))?;
    let metadata = manager
        .discover_metadata()
        .await
        .map_err(|e| format!("OAuth discovery failed: {e}"))?;
    manager.set_metadata(metadata);

    // 2. Create the authorization session (handles dynamic registration + PKCE).
    //    The session holds the PKCE verifier in its InMemoryStateStore — we MUST
    //    keep it alive until the callback arrives, then use it for the token exchange.
    let session = AuthorizationSession::new(
        manager,
        &[],
        &redirect_uri,
        Some("Termul"),
        None,
    )
    .await
    .map_err(|e| format!("OAuth registration failed: {e}"))?;

    let auth_url = session.get_authorization_url().to_string();

    log::info!("[mcp-oauth] opening browser for server (url redacted), redirect_uri={redirect_uri}");

    // 3. Open the authorization URL in the user's system browser.
    app.opener()
        .open_url(&auth_url, None::<&str>)
        .map_err(|e| format!("failed to open browser: {e}"))?;

    // 4. Wait for the callback on the local TCP listener.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(crate::acp::mcp_oauth::OAUTH_FLOW_TIMEOUT_SECS);
    let callback_url = loop {
        if std::time::Instant::now() > deadline {
            return Err("OAuth flow timed out — user did not complete authorization in time".to_string());
        }
        match listener.accept() {
            Ok((mut stream, _addr)) => {
                use std::io::{BufRead, BufReader, Write};
                let reader = BufReader::new(&mut stream);
                let mut lines = reader.lines();
                if let Some(Ok(first_line)) = lines.next() {
                    // Parse the request target. Stray browser requests
                    // (preconnect, favicon, malformed) must not break the
                    // loop — only the callback path with a `code` param
                    // completes the flow. Respond to non-callback requests
                    // with a 404 and continue waiting.
                    let target = first_line.split(' ').nth(1).unwrap_or("/").to_string();
                    let path = target.split('?').next().unwrap_or("/");
                    let is_callback = path == crate::acp::mcp_oauth::OAUTH_REDIRECT_PATH
                        && target.contains("code=");
                    if !is_callback {
                        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                        let _ = stream.flush();
                        continue;
                    }
                    let full_url = format!("http://127.0.0.1:{port}{target}");
                    let body = "<!DOCTYPE html><html><body><h2>Authorization complete</h2><p>You can close this tab and return to Termul.</p><script>window.close();</script></body></html>";
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(), body
                    );
                    let _ = stream.write_all(response.as_bytes());
                    let _ = stream.flush();
                    break full_url;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            Err(e) => {
                return Err(format!("callback listener error: {e}"));
            }
        }
    };
    // 5. Exchange the authorization code for tokens using the SAME session
    //    (which holds the PKCE verifier). After handle_callback succeeds, the
    //    OAuthState transitions to Authorized(manager) — the token is stored
    //    in the manager's InMemoryCredentialStore. We read it from there.
    let mut oauth_state = OAuthState::Session(session);

    let callback = rmcp::transport::auth::AuthorizationCallback::from_redirect_url(&callback_url)
        .map_err(|e| format!("callback parse failed: {e}"))?;

    oauth_state
        .handle_callback(&callback.code, &callback.csrf_token)
        .await
        .map_err(|e| format!("token exchange failed: {e}"))?;

    // After handle_callback, oauth_state is now Authorized(manager).
    // Call get_access_token on the MANAGER (not on OAuthState, which returns
    // "Already authorized" for the Authorized variant).
    let (access_token, client_id, refresh_token, expires_at) = match &oauth_state {
        OAuthState::Authorized(manager) | OAuthState::Unauthorized(manager) => {
            use oauth2::TokenResponse;
            let token = manager.get_access_token().await
                .map_err(|e| {
                    log::warn!("[mcp-oauth] failed to retrieve access token (url redacted): {e}");
                    format!("failed to get access token: {e}")
                })?;
            let creds = manager.get_credentials().await
                .map_err(|e| {
                    log::warn!("[mcp-oauth] failed to retrieve credentials (url redacted): {e}");
                    format!("failed to get credentials: {e}")
                })?;
            let refresh = creds.1.as_ref().and_then(|tr| tr.refresh_token().map(|t| t.secret().to_string()));
            let exp = creds.1.as_ref().and_then(|tr| tr.expires_in()).map(|d| {
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|n| n.as_secs() + d.as_secs()).unwrap_or(0)
            });
            (token, creds.0, refresh, exp)
        }
        _ => return Err("unexpected OAuth state after callback".to_string()),
    };

    // 6. Store the token in the file store.
    let stored = crate::acp::mcp_oauth::StoredToken {
        access_token,
        refresh_token,
        expires_at,
        client_id,
        issuer: server_url.clone(),
        server_url: server_url.clone(),
    };
    crate::acp::mcp_oauth::store_token(&server_url, &stored)
        .map_err(|e| format!("failed to store token: {e}"))?;

    log::info!(
        "[mcp-oauth] OAuth flow completed for server (url redacted), has refresh token: {}",
        stored.refresh_token.is_some()
    );

    Ok(())
}

/// Check whether a stored OAuth token exists for a server URL. Returns `true`
/// when a token is found (the renderer shows "Connected" / "Disconnect"
/// instead of "Connect"). Does NOT check token validity — the next probe
/// handles refresh/expiry transparently.
#[tauri::command]
pub fn acp_mcp_oauth_has_token(server_url: String) -> Result<bool, String> {
    Ok(crate::acp::mcp_oauth::load_stored_token(&server_url)
        .map(|t| t.is_some())
        .unwrap_or(false))
}

/// Delete the stored OAuth token for a server URL (the "Disconnect" action).
/// After this, the next probe will return `AuthRequired` again and the user
/// can re-connect.
#[tauri::command]
pub fn acp_mcp_oauth_disconnect(server_url: String) -> Result<(), String> {
    crate::acp::mcp_oauth::delete_stored_token(&server_url)
        .map_err(|e| e.to_string())
}

/// Set the in-process ACP turn (hard-cap) timeout override, in seconds, or
/// `None` to clear it (fall back to the env var / unlimited default). Pushed from
/// the App Preferences UI so the turn timeout is editable without a restart or
/// env var. Desktop-only: the standalone `termul-server` has no settings
/// surface and configures via `TERMUL_ACP_TURN_TIMEOUT_SECS`. The env var
/// remains top-precedence (operator/diagnostic override).
#[tauri::command]
pub fn acp_set_turn_timeout(secs: Option<u64>) -> Result<(), String> {
    crate::acp::manager::set_turn_timeout_override(secs);
    Ok(())
}

/// Set the in-process ACP turn *idle* timeout override, in seconds, or `None`
/// to clear it (fall back to the env var / unlimited default). Pushed from the
/// App Preferences UI. Desktop-only parity with `acp_set_turn_timeout`: the
/// standalone `termul-server` configures via `TERMUL_ACP_TURN_IDLE_TIMEOUT_SECS`.
/// The env var remains top-precedence (operator/diagnostic override).
#[tauri::command]
pub fn acp_set_turn_idle_timeout(secs: Option<u64>) -> Result<(), String> {
    if matches!(secs, Some(0)) {
        return Err("turn idle timeout must be > 0 seconds".to_string());
    }
    crate::acp::manager::set_turn_idle_timeout_override(secs);
    log::info!("[acp] turn idle timeout override: {secs:?}");
    Ok(())
}

/// Set the in-process `session/new` timeout override, in seconds, or `None`
/// to clear it (fall back to the env var / 60s default). Pushed from the App
/// Preferences UI; same desktop-only + env-precedence contract as
/// `acp_set_turn_timeout` (`TERMUL_ACP_SESSION_NEW_TIMEOUT_SECS` wins).
#[tauri::command]
pub fn acp_set_session_new_timeout(secs: Option<u64>) -> Result<(), String> {
    if matches!(secs, Some(0)) {
        return Err("session/new timeout must be > 0 seconds".to_string());
    }
    crate::acp::manager::set_session_new_timeout_override(secs);
    log::info!("[acp] session/new timeout override: {secs:?}");
    Ok(())
}

/// Set the in-process `session/load` / `session/resume` timeout override, in
/// seconds, or `None` to clear it (fall back to the env var / 60s default).
/// Pushed from the App Preferences UI; same desktop-only + env-precedence
/// contract as `acp_set_turn_timeout`
/// (`TERMUL_ACP_SESSION_REOPEN_TIMEOUT_SECS` wins).
#[tauri::command]
pub fn acp_set_session_reopen_timeout(secs: Option<u64>) -> Result<(), String> {
    if matches!(secs, Some(0)) {
        return Err("session reopen timeout must be > 0 seconds".to_string());
    }
    crate::acp::manager::set_session_reopen_timeout_override(secs);
    log::info!("[acp] session reopen timeout override: {secs:?}");
    Ok(())
}

/// Set the in-process first-prompt warmup timeout override, in seconds, or
/// `None` to clear it (fall back to the env var / 45s default). `0` disables
/// the warmup entirely. Pushed from the App Preferences UI; same desktop-only
/// + env-precedence contract as `acp_set_turn_timeout`
/// (`TERMUL_ACP_FIRST_PROMPT_WARMUP_SECS` wins).
#[tauri::command]
pub fn acp_set_first_prompt_warmup_timeout(secs: Option<u64>) -> Result<(), String> {
    crate::acp::manager::set_first_prompt_warmup_timeout_override(secs);
    log::info!("[acp] first-prompt warmup timeout override: {secs:?}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::session_persistence::{SessionPersistence, SessionRegistration};
    use crate::web::WsRelaySink;
    use agent_client_protocol::schema::v1::{ContentBlock, TextContent};
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// Zero is meaningless for the three strictly-positive timeouts and must
    /// be rejected at the IPC boundary (the resolvers also filter it
    /// defensively). Rejection happens BEFORE the override is stored, so
    /// these assertions never mutate the shared override statics (warmup's
    /// zero/DISABLE acceptance is covered at the resolver level in the
    /// manager tests, since the warmup command forwards without validation).
    #[test]
    fn zero_overrides_are_rejected_for_strictly_positive_timeouts() {
        assert!(acp_set_turn_idle_timeout(Some(0)).is_err());
        assert!(acp_set_session_new_timeout(Some(0)).is_err());
        assert!(acp_set_session_reopen_timeout(Some(0)).is_err());
    }

    /// Regression: the desktop `acp_send_prompt` command persists an accepted
    /// non-ephemeral prompt through `WsRelaySink` before dispatch (matching the
    /// WS `send_prompt` handler ordering). This exercises the extracted
    /// `persist_accepted_prompt` helper directly: it must write one durable
    /// `user_prompt` record whose payload shape (`{agentId, sessionId, turnId,
    /// content}`) matches the web path byte-for-byte, with `turnId: null` on
    /// the desktop path. The command body calls this helper BEFORE
    /// `AcpManager::send_prompt` and only when `is_ephemeral_session` returns
    /// `false`; those ordering + ephemeral-skip invariants are enforced by the
    /// command body structure (a full `acp_send_prompt` unit test would need a
    /// real `AcpManager` + Tauri `State`, which is not constructible here).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn persist_accepted_prompt_writes_durable_user_prompt_with_desktop_payload() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("termul-acp-prompt-persist-{stamp}"));
        std::fs::create_dir_all(&root).unwrap();
        let cwd = root.join("cwd");
        std::fs::create_dir_all(&cwd).unwrap();
        let persistence = SessionPersistence::open(root.join("sessions"))
            .await
            .unwrap();
        persistence
            .register_session(SessionRegistration {
                session_id: "sess-desktop".to_string(),
                stable_agent_namespace: None,
                runtime_agent_id: None,
                project_id: None,
                cwd,
                ..Default::default()
            })
            .await
            .unwrap();
        let relay = Arc::new(WsRelaySink::with_persistence(8, persistence.clone()));
        let blocks = vec![ContentBlock::Text(TextContent::new("hello world"))];
        persist_accepted_prompt(
            &relay,
            &AgentId("agent-1".to_string()),
            &SessionId("sess-desktop".to_string()),
            &blocks,
        )
        .await
        .unwrap();

        // The durable frontier advanced: one user_prompt record at seq 1.
        assert_eq!(persistence.last_seq("sess-desktop").unwrap(), 1);
        let metadata = persistence.metadata("sess-desktop").unwrap();
        assert_eq!(metadata.message_count, 1);
        // First-message title provenance is established from the user_prompt.
        assert!(metadata.title.is_some(), "title derived from user_prompt");

        // The durable record carries the desktop payload shape (matches the
        // WS `send_prompt` handler): agentId, sessionId, turnId=null, content.
        let records = persistence
            .replay_after_async("sess-desktop".to_string(), 0)
            .await
            .unwrap();
        assert_eq!(records.len(), 1);
        let record = &records[0];
        assert_eq!(record.type_, "user_prompt");
        assert_eq!(record.seq, 1);
        assert_eq!(record.payload["agentId"], "agent-1");
        assert_eq!(record.payload["sessionId"], "sess-desktop");
        assert!(
            record.payload["turnId"].is_null(),
            "desktop path: turnId must be null"
        );
        let content = record.payload["content"].as_array().unwrap();
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["text"], "hello world");

        persistence.shutdown().await.unwrap();
        let _ = std::fs::remove_dir_all(root);
    }
}
