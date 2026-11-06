//! Desktop entry points for session submit and completion RPCs.

use crate::pty::session_protocol::frame::SessionRpcResult;
use crate::pty::session_protocol::gate::CompletionRequest;
use crate::pty::session_protocol::rpc;
use crate::pty::PtyManager;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn command_editor_restore_prompt(
    terminal_id: String,
    pty_manager: State<'_, Arc<PtyManager>>,
) -> Result<SessionRpcResult, String> {
    Ok(rpc::restore_prompt(&pty_manager, &terminal_id, true).await)
}

#[tauri::command]
pub async fn command_editor_submit(
    terminal_id: String,
    draft: String,
    pty_manager: State<'_, Arc<PtyManager>>,
) -> Result<SessionRpcResult, String> {
    Ok(rpc::submit(&pty_manager, &terminal_id, &draft, true).await)
}

#[tauri::command]
pub async fn command_editor_request_completion<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    terminal_id: String,
    mut request: CompletionRequest,
    pty_manager: State<'_, Arc<PtyManager>>,
) -> Result<rpc::CompletionReply, String> {
    let local_id = request.request_id.clone();
    request.request_id = rpc::owned_request_id(window.label(), &local_id);
    let reply = rpc::request_completion(&pty_manager, &terminal_id, &request, true).await;
    Ok(rpc::local_completion_reply(reply, local_id))
}

#[tauri::command]
pub async fn command_editor_cancel_completion<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    terminal_id: String,
    request_id: String,
    pty_manager: State<'_, Arc<PtyManager>>,
) -> Result<SessionRpcResult, String> {
    let owned_id = rpc::owned_request_id(window.label(), &request_id);
    Ok(rpc::cancel_completion(&pty_manager, &terminal_id, &owned_id).await)
}
