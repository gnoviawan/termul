use super::IpcResult;
use crate::pty::PtyManager;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, State};

// ============================================================================
// SSH Commands
// ============================================================================

use crate::ssh::config_parser;
use crate::ssh::connection::SshConnection;
use crate::ssh::keys::{self, KeyFileInfo};
use crate::ssh::profile_manager::SSHProfile;
use crate::ssh::session::{OpenedSession, SessionInfo, SessionTarget};
use crate::ssh::sftp as sftp_ops;
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

/// SFTP requests address a live session (`connectionId` = session id).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SFTPPathRequest {
    pub connection_id: String,
    pub remote_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SFTPTransferRequest {
    pub connection_id: String,
    pub remote_path: String,
    pub local_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SFTPRenameRequest {
    pub connection_id: String,
    pub old_path: String,
    pub new_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SFTPFileRequest {
    pub connection_id: String,
    pub remote_path: String,
    pub content: Option<String>,
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn ssh_list_profiles(
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<Vec<SSHProfile>>, String> {
    match ssh_manager.profiles.list() {
        Ok(profiles) => Ok(IpcResult::success(profiles)),
        Err(e) => Ok(IpcResult::error(e, "SSH_PROFILE_ERROR")),
    }
}

#[tauri::command]
pub async fn ssh_save_profile(
    profile: SSHProfile,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<()>, String> {
    // A new secret makes the in-memory copy kept for live sessions stale.
    let profile_id = profile.id.clone();
    let secret_changed = profile.password.is_some() || profile.passphrase.is_some();
    match ssh_manager.profiles.save(profile) {
        Ok(()) => {
            if secret_changed {
                ssh_manager.sessions.forget_secret(&profile_id);
            }
            Ok(IpcResult::success(()))
        }
        Err(e) => Ok(IpcResult::error(e, "SSH_PROFILE_ERROR")),
    }
}

#[tauri::command]
pub async fn ssh_delete_profile(
    profile_id: String,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<()>, String> {
    match ssh_manager.profiles.delete(&profile_id) {
        Ok(()) => {
            ssh_manager.sessions.forget_secret(&profile_id);
            Ok(IpcResult::success(()))
        }
        Err(e) => Ok(IpcResult::error(e, "SSH_PROFILE_ERROR")),
    }
}

#[tauri::command]
pub async fn ssh_duplicate_profile(
    profile_id: String,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<SSHProfile>, String> {
    match ssh_manager.profiles.duplicate(&profile_id) {
        Ok(profile) => Ok(IpcResult::success(profile)),
        Err(e) => Ok(IpcResult::error(e, "SSH_PROFILE_ERROR")),
    }
}

#[tauri::command]
pub async fn ssh_import_config(
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<Vec<SSHProfile>>, String> {
    let parsed = config_parser::parse_ssh_config();
    match ssh_manager.profiles.import_from_config(parsed) {
        Ok(imported) => Ok(IpcResult::success(imported)),
        Err(e) => Ok(IpcResult::error(e, "SSH_IMPORT_ERROR")),
    }
}

#[tauri::command]
pub async fn ssh_inspect_key(path: String) -> Result<IpcResult<KeyFileInfo>, String> {
    Ok(IpcResult::success(keys::inspect(&path)))
}

#[tauri::command]
pub async fn ssh_list_keys() -> Result<IpcResult<Vec<KeyFileInfo>>, String> {
    Ok(IpcResult::success(keys::discover()))
}

// ---------------------------------------------------------------------------
// Interactive sessions
// ---------------------------------------------------------------------------

/// The keychain secret matching the profile's auth method.
fn stored_secret(profile: &SSHProfile) -> Option<String> {
    match profile.auth_method.as_str() {
        "password" => profile.password.clone(),
        "key" => profile.passphrase.clone(),
        _ => None,
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SSHSessionOpenRequest {
    /// Chosen by the renderer so progress events can be matched before the
    /// command returns.
    pub session_id: String,
    pub profile_id: String,
    pub cols: u16,
    pub rows: u16,
    /// Password or key passphrase typed at a prompt.
    pub secret: Option<String>,
    /// Save `secret` to the OS keychain once it worked.
    #[serde(default)]
    pub save_secret: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SSHSessionOpenResponse {
    #[serde(flatten)]
    pub opened: OpenedSession,
    /// The prompt secret was saved to the keychain.
    pub secret_saved: bool,
}

#[tauri::command]
pub async fn ssh_session_open(
    request: SSHSessionOpenRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
    pty_manager: State<'_, Arc<PtyManager>>,
) -> Result<IpcResult<SSHSessionOpenResponse>, String> {
    let profile = match ssh_manager
        .profiles
        .get_with_credentials(&request.profile_id)
    {
        Ok(Some(p)) => p,
        Ok(None) => {
            return Ok(IpcResult::error(
                "Profile not found",
                "SSH_PROFILE_NOT_FOUND",
            ))
        }
        Err(e) => return Ok(IpcResult::error(e, "SSH_PROFILE_ERROR")),
    };

    // Prompt answer, then the secret a live session to this host used, then
    // the keychain.
    let prompted = request.secret.clone();
    let secret = prompted
        .clone()
        .or_else(|| ssh_manager.sessions.cached_secret(&profile.id))
        .or_else(|| stored_secret(&profile));
    let target = SessionTarget {
        profile_id: profile.id.clone(),
        host: profile.host.clone(),
        port: profile.port,
        username: profile.username.clone(),
        auth_method: profile.auth_method.clone(),
        key_path: profile.private_key_path.clone(),
    };

    let opened = match ssh_manager
        .sessions
        .open(
            &pty_manager,
            &request.session_id,
            target,
            secret,
            request.cols.max(1),
            request.rows.max(1),
        )
        .await
    {
        Ok(opened) => opened,
        Err(e) => return Ok(IpcResult::error(e.detail, e.kind.code())),
    };

    let mut secret_saved = false;
    if request.save_secret {
        if let Some(secret) = prompted.as_deref() {
            match ssh_manager.profiles.store_secret(&profile.id, secret) {
                Ok(()) => secret_saved = true,
                Err(e) => log::warn!("[SSH] Could not save secret to keychain: {}", e),
            }
        }
    }
    if let Err(e) = ssh_manager.profiles.update_last_connected(&profile.id) {
        log::warn!("[SSH] Could not record last connection: {}", e);
    }

    Ok(IpcResult::success(SSHSessionOpenResponse {
        opened,
        secret_saved,
    }))
}

#[tauri::command]
pub async fn ssh_session_respond_host_key(
    session_id: String,
    trust: bool,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<bool>, String> {
    Ok(IpcResult::success(
        ssh_manager.sessions.respond_host_key(&session_id, trust),
    ))
}

#[tauri::command]
pub async fn ssh_session_cancel(
    session_id: String,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<bool>, String> {
    Ok(IpcResult::success(ssh_manager.sessions.cancel(&session_id)))
}

/// Close a session: kills its terminal (which closes the channel and the
/// connection), or cancels the connect when it is still in progress.
#[tauri::command]
pub async fn ssh_session_close(
    session_id: String,
    ssh_manager: State<'_, Arc<SSHManager>>,
    pty_manager: State<'_, Arc<PtyManager>>,
) -> Result<IpcResult<()>, String> {
    match ssh_manager.sessions.terminal_id(&session_id) {
        Some(terminal_id) => match pty_manager.force_kill(&terminal_id).await {
            Ok(()) => Ok(IpcResult::success(())),
            Err(e) => Ok(IpcResult::error(e, "SSH_SESSION_CLOSE_ERROR")),
        },
        None => {
            ssh_manager.sessions.cancel(&session_id);
            Ok(IpcResult::success(()))
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SSHLiveSession {
    #[serde(flatten)]
    pub session: SessionInfo,
    /// Fresh attach credential for the session's terminal.
    pub claim: Option<String>,
}

/// Live sessions with fresh attach claims, for a renderer that reloaded.
#[tauri::command]
pub async fn ssh_session_list(
    ssh_manager: State<'_, Arc<SSHManager>>,
    pty_manager: State<'_, Arc<PtyManager>>,
) -> Result<IpcResult<Vec<SSHLiveSession>>, String> {
    let sessions = ssh_manager
        .sessions
        .list()
        .into_iter()
        .map(|session| {
            let claim = session
                .terminal_id
                .as_deref()
                .and_then(|id| pty_manager.reissue_unbound_claim(id));
            SSHLiveSession { session, claim }
        })
        .collect();
    Ok(IpcResult::success(sessions))
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

/// The live session's connection, or the IPC error to return.
fn session_connection<T>(
    ssh_manager: &SSHManager,
    session_id: &str,
) -> Result<Arc<SshConnection>, IpcResult<T>> {
    ssh_manager
        .sessions
        .connection(session_id)
        .ok_or_else(|| IpcResult::error("The session is not connected", "SSH_CONNECTION_NOT_FOUND"))
}

/// Run an SFTP operation on a session's file browser channel.
macro_rules! with_sftp {
    ($manager:expr, $session:expr, $code:expr, |$sftp:ident| $body:expr) => {{
        let connection = match session_connection(&$manager, $session) {
            Ok(connection) => connection,
            Err(error) => return Ok(error),
        };
        let $sftp = match connection.sftp().await {
            Ok(sftp) => sftp,
            Err(e) => return Ok(IpcResult::error(e, "SFTP_UNAVAILABLE")),
        };
        match $body.await {
            Ok(value) => Ok(IpcResult::success(value)),
            Err(e) => Ok(IpcResult::error(e, $code)),
        }
    }};
}

#[tauri::command]
pub async fn sftp_list_dir(
    request: SFTPPathRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<Vec<sftp_ops::SFTPEntry>>, String> {
    with_sftp!(ssh_manager, &request.connection_id, "SFTP_ERROR", |sftp| {
        sftp_ops::list_dir(&sftp, &request.remote_path)
    })
}

#[tauri::command]
pub async fn sftp_realpath(
    request: SFTPPathRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<String>, String> {
    with_sftp!(ssh_manager, &request.connection_id, "SFTP_ERROR", |sftp| {
        sftp_ops::realpath(&sftp, &request.remote_path)
    })
}

#[tauri::command]
pub async fn sftp_download(
    request: SFTPTransferRequest,
    app_handle: AppHandle,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<()>, String> {
    with_sftp!(
        ssh_manager,
        &request.connection_id,
        "SFTP_DOWNLOAD_ERROR",
        |sftp| {
            sftp_ops::download_file(
                &sftp,
                &request.remote_path,
                &request.local_path,
                &app_handle,
                &request.connection_id,
            )
        }
    )
}

#[tauri::command]
pub async fn sftp_upload(
    request: SFTPTransferRequest,
    app_handle: AppHandle,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<()>, String> {
    with_sftp!(
        ssh_manager,
        &request.connection_id,
        "SFTP_UPLOAD_ERROR",
        |sftp| {
            sftp_ops::upload_file(
                &sftp,
                &request.local_path,
                &request.remote_path,
                &app_handle,
                &request.connection_id,
            )
        }
    )
}

#[tauri::command]
pub async fn sftp_delete(
    request: SFTPPathRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<()>, String> {
    with_sftp!(
        ssh_manager,
        &request.connection_id,
        "SFTP_DELETE_ERROR",
        |sftp| { sftp_ops::delete_path(&sftp, &request.remote_path) }
    )
}

#[tauri::command]
pub async fn sftp_mkdir(
    request: SFTPPathRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<()>, String> {
    with_sftp!(
        ssh_manager,
        &request.connection_id,
        "SFTP_MKDIR_ERROR",
        |sftp| { sftp_ops::mkdir(&sftp, &request.remote_path) }
    )
}

#[tauri::command]
pub async fn sftp_rename(
    request: SFTPRenameRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<()>, String> {
    with_sftp!(
        ssh_manager,
        &request.connection_id,
        "SFTP_RENAME_ERROR",
        |sftp| { sftp_ops::rename(&sftp, &request.old_path, &request.new_path) }
    )
}

#[tauri::command]
pub async fn sftp_read_file(
    request: SFTPFileRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<String>, String> {
    with_sftp!(
        ssh_manager,
        &request.connection_id,
        "SFTP_READ_ERROR",
        |sftp| { sftp_ops::read_file_to_string(&sftp, &request.remote_path) }
    )
}

#[tauri::command]
pub async fn sftp_write_file(
    request: SFTPFileRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<()>, String> {
    let content = request.content.clone().unwrap_or_default();
    with_sftp!(
        ssh_manager,
        &request.connection_id,
        "SFTP_WRITE_ERROR",
        |sftp| { sftp_ops::write_file_from_string(&sftp, &request.remote_path, &content) }
    )
}

#[tauri::command]
pub async fn sftp_create_file(
    request: SFTPPathRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<()>, String> {
    with_sftp!(
        ssh_manager,
        &request.connection_id,
        "SFTP_CREATE_ERROR",
        |sftp| { sftp_ops::create_file(&sftp, &request.remote_path) }
    )
}
