use super::IpcResult;
use serde::Deserialize;
use std::sync::Arc;
use tauri::{AppHandle, State};

// ============================================================================
// SSH Commands
// ============================================================================

use crate::ssh::config_parser;
use crate::ssh::profile_manager::SSHProfile;
use crate::ssh::sftp as sftp_ops;
use crate::ssh::SSHManager;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SSHConnectRequest {
    pub profile_id: String,
    pub password: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SSHPortForwardRequest {
    pub connection_id: String,
    pub id: String,
    pub forward_type: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    pub label: Option<String>,
}

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
    match ssh_manager.profiles.save(profile) {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "SSH_PROFILE_ERROR")),
    }
}

#[tauri::command]
pub async fn ssh_delete_profile(
    profile_id: String,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<()>, String> {
    match ssh_manager.profiles.delete(&profile_id) {
        Ok(()) => Ok(IpcResult::success(())),
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
pub async fn ssh_connect(
    request: SSHConnectRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<crate::ssh::connection::SSHConnectionInfo>, String> {
    // Load profile with credentials from OS keychain
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

    // Use request password, or fall back to keychain-stored credential
    let password = request
        .password
        .or_else(|| match profile.auth_method.as_str() {
            "password" => profile.password.clone(),
            "key" => profile.passphrase.clone(),
            _ => None,
        });

    match ssh_manager
        .connections
        .connect(&profile, password.as_deref())
        .await
    {
        Ok(info) => {
            // Update last_connected
            let _ = ssh_manager
                .profiles
                .update_last_connected(&request.profile_id);
            Ok(IpcResult::success(info))
        }
        Err(e) => Ok(IpcResult::error(e, "SSH_CONNECT_ERROR")),
    }
}

#[tauri::command]
pub async fn ssh_disconnect(
    connection_id: String,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<()>, String> {
    match ssh_manager.disconnect(&connection_id).await {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "SSH_DISCONNECT_ERROR")),
    }
}

#[tauri::command]
pub async fn ssh_get_connections(
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<Vec<crate::ssh::connection::SSHConnectionInfo>>, String> {
    Ok(IpcResult::success(
        ssh_manager.connections.list_connections().await,
    ))
}

#[tauri::command]
pub async fn ssh_port_forward_start(
    request: SSHPortForwardRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<crate::ssh::port_forward::ActivePortForward>, String> {
    if ssh_manager
        .connections
        .get_connection(&request.connection_id)
        .await
        .is_none()
    {
        return Ok(IpcResult::error(
            "Connection not found",
            "SSH_CONNECTION_NOT_FOUND",
        ));
    }

    let session = match ssh_manager
        .connections
        .clone_session(&request.connection_id)
        .await
    {
        Ok(session) => session,
        Err(e) => return Ok(IpcResult::error(e, "SSH_CONNECTION_NOT_FOUND")),
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
        .port_forwards
        .start_local_forward(&request.connection_id, pf_request, session)
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
        .port_forwards
        .stop_forward(&connection_id, &forward_id)
    {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "SSH_PORT_FORWARD_ERROR")),
    }
}

#[tauri::command]
pub async fn sftp_list_dir(
    request: SFTPPathRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<Vec<crate::ssh::sftp::SFTPEntry>>, String> {
    let remote_path = request.remote_path.clone();
    match ssh_manager
        .connections
        .with_session(&request.connection_id, |session| {
            let sftp = sftp_ops::create_sftp(session)?;
            sftp_ops::list_dir(&sftp, &remote_path)
        })
        .await
    {
        Ok(entries) => Ok(IpcResult::success(entries)),
        Err(e) => Ok(IpcResult::error(e, "SFTP_ERROR")),
    }
}

#[tauri::command]
pub async fn sftp_download(
    request: SFTPTransferRequest,
    app_handle: AppHandle,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<()>, String> {
    let remote_path = request.remote_path.clone();
    let local_path = request.local_path.clone();
    let conn_id = request.connection_id.clone();
    let app = app_handle.clone();

    // Clone session to avoid holding the per-connection mutex during long I/O
    let session = match ssh_manager
        .connections
        .clone_session(&request.connection_id)
        .await
    {
        Ok(s) => s,
        Err(e) => return Ok(IpcResult::error(e, "SFTP_DOWNLOAD_ERROR")),
    };

    match tokio::task::spawn_blocking(move || {
        let sftp = sftp_ops::create_sftp(&session)?;
        sftp_ops::download_file(&sftp, &remote_path, &local_path, &app, &conn_id)
    })
    .await
    {
        Ok(Ok(())) => Ok(IpcResult::success(())),
        Ok(Err(e)) => Ok(IpcResult::error(e, "SFTP_DOWNLOAD_ERROR")),
        Err(e) => Ok(IpcResult::error(
            format!("Task failed: {}", e),
            "SFTP_DOWNLOAD_ERROR",
        )),
    }
}

#[tauri::command]
pub async fn sftp_upload(
    request: SFTPTransferRequest,
    app_handle: AppHandle,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<()>, String> {
    let remote_path = request.remote_path.clone();
    let local_path = request.local_path.clone();
    let conn_id = request.connection_id.clone();
    let app = app_handle.clone();

    // Clone session to avoid holding the per-connection mutex during long I/O
    let session = match ssh_manager
        .connections
        .clone_session(&request.connection_id)
        .await
    {
        Ok(s) => s,
        Err(e) => return Ok(IpcResult::error(e, "SFTP_UPLOAD_ERROR")),
    };

    match tokio::task::spawn_blocking(move || {
        let sftp = sftp_ops::create_sftp(&session)?;
        sftp_ops::upload_file(&sftp, &local_path, &remote_path, &app, &conn_id)
    })
    .await
    {
        Ok(Ok(())) => Ok(IpcResult::success(())),
        Ok(Err(e)) => Ok(IpcResult::error(e, "SFTP_UPLOAD_ERROR")),
        Err(e) => Ok(IpcResult::error(
            format!("Task failed: {}", e),
            "SFTP_UPLOAD_ERROR",
        )),
    }
}

#[tauri::command]
pub async fn sftp_delete(
    request: SFTPPathRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<()>, String> {
    let remote_path = request.remote_path.clone();
    match ssh_manager
        .connections
        .with_session(&request.connection_id, |session| {
            let sftp = sftp_ops::create_sftp(session)?;
            sftp_ops::delete_path(&sftp, &remote_path)
        })
        .await
    {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "SFTP_DELETE_ERROR")),
    }
}

#[tauri::command]
pub async fn sftp_mkdir(
    request: SFTPPathRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<()>, String> {
    let remote_path = request.remote_path.clone();
    match ssh_manager
        .connections
        .with_session(&request.connection_id, |session| {
            let sftp = sftp_ops::create_sftp(session)?;
            sftp_ops::mkdir(&sftp, &remote_path)
        })
        .await
    {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "SFTP_MKDIR_ERROR")),
    }
}

#[tauri::command]
pub async fn sftp_rename(
    request: SFTPRenameRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<()>, String> {
    let old_path = request.old_path.clone();
    let new_path = request.new_path.clone();
    match ssh_manager
        .connections
        .with_session(&request.connection_id, |session| {
            let sftp = sftp_ops::create_sftp(session)?;
            sftp_ops::rename(&sftp, &old_path, &new_path)
        })
        .await
    {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "SFTP_RENAME_ERROR")),
    }
}

#[tauri::command]
pub async fn ssh_create_askpass(password: String) -> Result<IpcResult<String>, String> {
    let temp_dir = std::env::temp_dir();
    let id = uuid::Uuid::new_v4()
        .to_string()
        .split('-')
        .next()
        .unwrap_or("tmp")
        .to_string();
    let password_path = temp_dir.join(format!("termul-askpass-{}.dat", id));

    // Write the raw password to a separate data file to avoid shell metacharacter injection.
    if let Err(e) = std::fs::write(&password_path, password.as_bytes()) {
        return Ok(IpcResult::error(
            format!("Failed to create askpass data: {}", e),
            "SSH_ASKPASS_ERROR",
        ));
    }

    // Restrict file permissions: owner-only on Unix, hidden attribute on Windows
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&password_path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(windows)]
    {
        // Mark the data file as hidden to reduce casual exposure
        use std::process::Command;
        let _ = Command::new("attrib")
            .args(["+H", &password_path.to_string_lossy()])
            .output();
    }

    // Create platform-specific askpass script
    #[cfg(windows)]
    let script_path = {
        let path = temp_dir.join(format!("termul-askpass-{}.bat", id));
        // The batch script outputs the password file contents and cleans up both files on exit.
        let content = format!(
            "@echo off\r\ntype \"{}\"\r\ndel /q \"{}\" >nul 2>&1\r\n(goto) 2>nul & del /q \"%~f0\" >nul 2>&1\r\n",
            password_path.to_string_lossy(),
            password_path.to_string_lossy(),
        );
        if let Err(e) = std::fs::write(&path, &content) {
            let _ = std::fs::remove_file(&password_path);
            return Ok(IpcResult::error(
                format!("Failed to create askpass: {}", e),
                "SSH_ASKPASS_ERROR",
            ));
        }
        path
    };

    #[cfg(unix)]
    let script_path = {
        use std::os::unix::fs::PermissionsExt;
        let path = temp_dir.join(format!("termul-askpass-{}.sh", id));
        // The shell script outputs the password file and cleans up both files.
        let content = format!(
            "#!/bin/sh\ncat \"{}\"\nrm -f \"{}\" \"$0\"\n",
            password_path.to_string_lossy(),
            password_path.to_string_lossy(),
        );
        if let Err(e) = std::fs::write(&path, &content) {
            let _ = std::fs::remove_file(&password_path);
            return Ok(IpcResult::error(
                format!("Failed to create askpass: {}", e),
                "SSH_ASKPASS_ERROR",
            ));
        }
        // Make the script executable
        if let Err(e) = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)) {
            let _ = std::fs::remove_file(&password_path);
            let _ = std::fs::remove_file(&path);
            return Ok(IpcResult::error(
                format!("Failed to set askpass permissions: {}", e),
                "SSH_ASKPASS_ERROR",
            ));
        }
        path
    };

    // Spawn a background cleanup task that removes both files after a timeout,
    // ensuring secrets don't persist on disk if the helper is never invoked.
    let cleanup_script = script_path.clone();
    let cleanup_password = password_path.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        let _ = std::fs::remove_file(&cleanup_password);
        let _ = std::fs::remove_file(&cleanup_script);
    });

    // Path includes the OS temp dir (often the username); keep it out of the
    // user-attachable info log (issue #244 AC#6). Full path stays at debug.
    log::info!("[SSH] Created askpass helper");
    log::debug!("[SSH] Askpass helper path: {:?}", script_path);
    Ok(IpcResult::success(
        script_path.to_string_lossy().to_string(),
    ))
}

#[tauri::command]
pub async fn sftp_read_file(
    request: SFTPFileRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<String>, String> {
    let remote_path = request.remote_path.clone();
    match ssh_manager
        .connections
        .with_session(&request.connection_id, |session| {
            let sftp = sftp_ops::create_sftp(session)?;
            sftp_ops::read_file_to_string(&sftp, &remote_path)
        })
        .await
    {
        Ok(content) => Ok(IpcResult::success(content)),
        Err(e) => Ok(IpcResult::error(e, "SFTP_READ_ERROR")),
    }
}

#[tauri::command]
pub async fn sftp_write_file(
    request: SFTPFileRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<()>, String> {
    let remote_path = request.remote_path.clone();
    let content = request.content.clone().unwrap_or_default();
    match ssh_manager
        .connections
        .with_session(&request.connection_id, |session| {
            let sftp = sftp_ops::create_sftp(session)?;
            sftp_ops::write_file_from_string(&sftp, &remote_path, &content)
        })
        .await
    {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "SFTP_WRITE_ERROR")),
    }
}

#[tauri::command]
pub async fn sftp_create_file(
    request: SFTPPathRequest,
    ssh_manager: State<'_, Arc<SSHManager>>,
) -> Result<IpcResult<()>, String> {
    let remote_path = request.remote_path.clone();
    match ssh_manager
        .connections
        .with_session(&request.connection_id, |session| {
            let sftp = sftp_ops::create_sftp(session)?;
            sftp_ops::create_file(&sftp, &remote_path)
        })
        .await
    {
        Ok(()) => Ok(IpcResult::success(())),
        Err(e) => Ok(IpcResult::error(e, "SFTP_CREATE_ERROR")),
    }
}
