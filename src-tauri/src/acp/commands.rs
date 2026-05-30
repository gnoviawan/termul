//! Thin `#[tauri::command]` wrappers over `AcpManager`.
//!
//! Each command takes `State<'_, Arc<AcpManager>>`, forwards to the manager
//! (which talks to the per-agent driver thread over channels), and awaits the
//! `Send` oneshot reply. No command awaits a `!Send` connection future
//! directly — that work is confined to the driver threads.

use std::sync::Arc;

use agent_client_protocol::schema::{
    ContentBlock, ListSessionsResponse, McpServer, SessionConfigOption, StopReason, TextContent,
};
use tauri::State;

use crate::acp::config::{AgentConfig, AgentId, SessionId};
use crate::acp::manager::{AcpManager, NewSessionOutcome};

/// Spawn an ACP agent subprocess and complete the `initialize` handshake.
#[tauri::command]
pub async fn acp_spawn_agent(
    manager: State<'_, Arc<AcpManager>>,
    config: AgentConfig,
) -> Result<AgentId, String> {
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
#[tauri::command]
pub async fn acp_new_session(
    manager: State<'_, Arc<AcpManager>>,
    agent_id: AgentId,
    cwd: String,
    mcp_servers: Option<Vec<McpServer>>,
) -> Result<NewSessionOutcome, String> {
    manager
        .new_session(&agent_id, cwd, mcp_servers.unwrap_or_default())
        .await
}

/// Load an existing session (requires the agent's `loadSession` capability).
#[tauri::command]
pub async fn acp_load_session(
    manager: State<'_, Arc<AcpManager>>,
    agent_id: AgentId,
    session_id: SessionId,
    cwd: String,
) -> Result<(), String> {
    manager.load_session(&agent_id, session_id, cwd).await
}

/// Resume a session (requires the agent's `sessionCapabilities.resume`).
#[tauri::command]
pub async fn acp_resume_session(
    manager: State<'_, Arc<AcpManager>>,
    agent_id: AgentId,
    session_id: SessionId,
    cwd: String,
) -> Result<(), String> {
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

/// List sessions on an agent.
#[tauri::command]
pub async fn acp_list_sessions(
    manager: State<'_, Arc<AcpManager>>,
    agent_id: AgentId,
) -> Result<ListSessionsResponse, String> {
    manager.list_sessions(&agent_id).await
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
    manager.send_prompt(&agent_id, session_id, blocks).await
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

/// Respond to a pending permission request. `optionId == None` cancels it.
#[tauri::command]
pub async fn acp_respond_permission(
    manager: State<'_, Arc<AcpManager>>,
    agent_id: AgentId,
    request_id: String,
    option_id: Option<String>,
) -> Result<(), String> {
    manager
        .respond_permission(&agent_id, request_id, option_id)
        .await
}
