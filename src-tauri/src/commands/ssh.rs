use super::IpcResult;
use crate::pty::PtyManager;
use serde::Deserialize;
use std::sync::Arc;
use tauri::State;

// ============================================================================
// SSH Commands: thin IPC wrappers over `ssh::service`, which the standalone
// server's `/ws` requests call too.
// ============================================================================

use crate::ssh::keys::KeyFileInfo;
use crate::ssh::profile_manager::SSHProfile;
use crate::ssh::service::{
    self, SFTPFileRequest, SFTPPathRequest, SFTPRenameRequest, SFTPTransferRequest,
    SSHLiveSession, SSHSessionOpenRequest, SSHSessionOpenResponse, SshResult,
};
use crate::ssh::sftp::SFTPEntry;
use crate::ssh::SSHManager;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SSHPortForwardRequest {
    /// Session whose connection carries the forward.
    pub connection_id: String,
    pub id: String,
    pub forward_type: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    pub label: Option<String>,
}

type Reply<T> = Result<IpcResult<T>, String>;

fn ipc<T>(result: SshResult<T>) -> Reply<T> {
    Ok(match result {
        Ok(value) => IpcResult::success(value),
        Err(failure) => IpcResult::error(failure.message, failure.code),
    })
}

// ---------------------------------------------------------------------------
// Profiles and keys
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn ssh_list_profiles(ssh_manager: State<'_, Arc<SSHManager>>) -> Reply<Vec<SSHProfile>> {
    ipc(service::list_profiles(&ssh_manager))
}

#[tauri::command]
pub async fn ssh_save_profile(
    profile: SSHProfile,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Reply<()> {
    ipc(service::save_profile(&ssh_manager, profile))
}

#[tauri::command]
pub async fn ssh_delete_profile(
    profile_id: String,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Reply<()> {
    ipc(service::delete_profile(&ssh_manager, &profile_id))
}

#[tauri::command]
pub async fn ssh_duplicate_profile(
    profile_id: String,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Reply<SSHProfile> {
    ipc(service::duplicate_profile(&ssh_manager, &profile_id))
}

#[tauri::command]
pub async fn ssh_import_config(ssh_manager: State<'_, Arc<SSHManager>>) -> Reply<Vec<SSHProfile>> {
    ipc(service::import_config(&ssh_manager))
}

#[tauri::command]
pub async fn ssh_inspect_key(path: String) -> Reply<KeyFileInfo> {
    ipc(Ok(service::inspect_key(&path)))
}

#[tauri::command]
pub async fn ssh_list_keys() -> Reply<Vec<KeyFileInfo>> {
    ipc(Ok(service::list_keys()))
}

// ---------------------------------------------------------------------------
// Interactive sessions
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn ssh_session_open(
    request: SSHSessionOpenRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
    pty_manager: State<'_, Arc<PtyManager>>,
) -> Reply<SSHSessionOpenResponse> {
    ipc(service::open_session(&ssh_manager, &pty_manager, request).await)
}

#[tauri::command]
pub async fn ssh_session_respond_host_key(
    session_id: String,
    trust: bool,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Reply<bool> {
    ipc(Ok(service::respond_host_key(&ssh_manager, &session_id, trust)))
}

#[tauri::command]
pub async fn ssh_session_cancel(
    session_id: String,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Reply<bool> {
    ipc(Ok(service::cancel_session(&ssh_manager, &session_id)))
}

#[tauri::command]
pub async fn ssh_session_close(
    session_id: String,
    ssh_manager: State<'_, Arc<SSHManager>>,
    pty_manager: State<'_, Arc<PtyManager>>,
) -> Reply<()> {
    ipc(service::close_session(&ssh_manager, &pty_manager, &session_id).await)
}

#[tauri::command]
pub async fn ssh_session_list(
    ssh_manager: State<'_, Arc<SSHManager>>,
    pty_manager: State<'_, Arc<PtyManager>>,
) -> Reply<Vec<SSHLiveSession>> {
    ipc(Ok(service::list_sessions(&ssh_manager, &pty_manager)))
}

// ---------------------------------------------------------------------------
// Port forwarding (over a session's connection)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn ssh_port_forward_start(
    request: SSHPortForwardRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<crate::ssh::port_forward::ActivePortForward>, String> {
    let Some(connection) = ssh_manager.sessions.connection(&request.connection_id) else {
        return Ok(IpcResult::error(
            "Session not connected",
            "SSH_CONNECTION_NOT_FOUND",
        ));
    };
    let pf_request = crate::ssh::port_forward::PortForwardRequest {
        id: request.id,
        forward_type: request.forward_type,
        local_port: request.local_port,
        remote_host: request.remote_host,
        remote_port: request.remote_port,
        label: request.label,
    };
    match ssh_manager
        .sessions
        .port_forwards
        .start_local_forward(&request.connection_id, pf_request, connection)
        .await
    {
        Ok(forward) => Ok(IpcResult::success(forward)),
        Err(e) => Ok(IpcResult::error(e, "SSH_PORT_FORWARD_ERROR")),
    }
}

#[tauri::command]
pub async fn ssh_port_forward_stop(
    connection_id: String,
    forward_id: String,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<()>, String> {
    match ssh_manager
        .sessions
        .port_forwards
        .stop_forward(&connection_id, &forward_id)
    {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "SSH_PORT_FORWARD_ERROR")),
    }
}

// ---------------------------------------------------------------------------
// SFTP (over a session's connection)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn sftp_list_dir(
    request: SFTPPathRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Reply<Vec<SFTPEntry>> {
    ipc(service::sftp_list_dir(&ssh_manager, request).await)
}

#[tauri::command]
pub async fn sftp_realpath(
    request: SFTPPathRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Reply<String> {
    ipc(service::sftp_realpath(&ssh_manager, request).await)
}

#[tauri::command]
pub async fn sftp_download(
    request: SFTPTransferRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Reply<()> {
    ipc(service::sftp_download(&ssh_manager, request).await)
}

#[tauri::command]
pub async fn sftp_upload(
    request: SFTPTransferRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Reply<()> {
    ipc(service::sftp_upload(&ssh_manager, request).await)
}

#[tauri::command]
pub async fn sftp_delete(
    request: SFTPPathRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Reply<()> {
    ipc(service::sftp_delete(&ssh_manager, request).await)
}

#[tauri::command]
pub async fn sftp_mkdir(
    request: SFTPPathRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Reply<()> {
    ipc(service::sftp_mkdir(&ssh_manager, request).await)
}

#[tauri::command]
pub async fn sftp_rename(
    request: SFTPRenameRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Reply<()> {
    ipc(service::sftp_rename(&ssh_manager, request).await)
}

#[tauri::command]
pub async fn sftp_read_file(
    request: SFTPFileRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Reply<String> {
    ipc(service::sftp_read_file(&ssh_manager, request).await)
}

#[tauri::command]
pub async fn sftp_write_file(
    request: SFTPFileRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Reply<()> {
    ipc(service::sftp_write_file(&ssh_manager, request).await)
}

#[tauri::command]
pub async fn sftp_create_file(
    request: SFTPPathRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Reply<()> {
    ipc(service::sftp_create_file(&ssh_manager, request).await)
}
