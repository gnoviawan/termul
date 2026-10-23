//! The SSH operations both transports run: the desktop's Tauri commands
//! (`commands/ssh.rs`) and the standalone server's `/ws` requests
//! (`web/ws/ssh.rs`). Each operation returns its value or an [`SshFailure`]
//! carrying the stable code the renderer branches on; the transports only
//! wrap the result.
//!
//! Secrets (passwords, passphrases) pass through `open_session` and
//! `save_profile`; nothing here logs or returns them.

use super::config_parser;
use super::connection::SshConnection;
use super::keys::{self, KeyFileInfo};
use super::profile_manager::SSHProfile;
use super::session::{OpenedSession, SessionInfo, SessionTarget};
use super::sftp::{self as sftp_ops, SFTPEntry};
use super::SSHManager;
use crate::pty::PtyManager;
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::sync::Arc;

/// A refused or failed operation: user-facing text plus a stable code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshFailure {
    pub message: String,
    pub code: &'static str,
}

impl SshFailure {
    pub fn new(message: impl Into<String>, code: &'static str) -> Self {
        Self {
            message: message.into(),
            code,
        }
    }
}

pub type SshResult<T> = Result<T, SshFailure>;

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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SSHSessionOpenRequest {
    /// Chosen by the renderer so progress events can be matched before the
    /// open returns.
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SSHLiveSession {
    #[serde(flatten)]
    pub session: SessionInfo,
    /// Fresh attach credential for the session's terminal.
    pub claim: Option<String>,
}

fn profile_error(e: String) -> SshFailure {
    SshFailure::new(e, "SSH_PROFILE_ERROR")
}

// ---------------------------------------------------------------------------
// Profiles and keys
// ---------------------------------------------------------------------------

pub fn list_profiles(ssh: &SSHManager) -> SshResult<Vec<SSHProfile>> {
    ssh.profiles.list().map_err(profile_error)
}

pub fn save_profile(ssh: &SSHManager, profile: SSHProfile) -> SshResult<()> {
    // A new secret, or a different host/user/auth, makes the in-memory copy
    // kept for live sessions stale (a later tab would try the old one first).
    let profile_id = profile.id.clone();
    let secret_changed = profile.password.is_some() || profile.passphrase.is_some();
    let target_changed = match ssh.profiles.get(&profile_id) {
        Ok(Some(previous)) => {
            previous.host != profile.host
                || previous.port != profile.port
                || previous.username != profile.username
                || previous.auth_method != profile.auth_method
                || previous.private_key_path != profile.private_key_path
        }
        _ => false,
    };
    ssh.profiles.save(profile).map_err(profile_error)?;
    if secret_changed || target_changed {
        ssh.sessions.forget_secret(&profile_id);
    }
    Ok(())
}

pub fn delete_profile(ssh: &SSHManager, profile_id: &str) -> SshResult<()> {
    ssh.profiles.delete(profile_id).map_err(profile_error)?;
    ssh.sessions.forget_secret(profile_id);
    Ok(())
}

pub fn duplicate_profile(ssh: &SSHManager, profile_id: &str) -> SshResult<SSHProfile> {
    ssh.profiles.duplicate(profile_id).map_err(profile_error)
}

pub fn import_config(ssh: &SSHManager) -> SshResult<Vec<SSHProfile>> {
    let parsed = config_parser::parse_ssh_config();
    ssh.profiles
        .import_from_config(parsed)
        .map_err(|e| SshFailure::new(e, "SSH_IMPORT_ERROR"))
}

pub fn inspect_key(path: &str) -> KeyFileInfo {
    keys::inspect(path)
}

pub fn list_keys() -> Vec<KeyFileInfo> {
    keys::discover()
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

pub async fn open_session(
    ssh: &SSHManager,
    pty: &PtyManager,
    request: SSHSessionOpenRequest,
) -> SshResult<SSHSessionOpenResponse> {
    let profile = match ssh.profiles.get_with_credentials(&request.profile_id) {
        Ok(Some(p)) => p,
        Ok(None) => return Err(SshFailure::new("Profile not found", "SSH_PROFILE_NOT_FOUND")),
        Err(e) => return Err(profile_error(e)),
    };

    // Prompt answer, then the secret a live session to this host used, then
    // the keychain.
    let prompted = request.secret.clone();
    let secret = prompted
        .clone()
        .or_else(|| ssh.sessions.cached_secret(&profile.id))
        .or_else(|| stored_secret(&profile));
    let target = SessionTarget {
        profile_id: profile.id.clone(),
        host: profile.host.clone(),
        port: profile.port,
        username: profile.username.clone(),
        auth_method: profile.auth_method.clone(),
        key_path: profile.private_key_path.clone(),
    };

    let opened = ssh
        .sessions
        .open(
            pty,
            &request.session_id,
            target,
            secret,
            request.cols.max(1),
            request.rows.max(1),
        )
        .await
        .map_err(|e| SshFailure::new(e.detail, e.kind.code()))?;

    let mut secret_saved = false;
    if request.save_secret {
        if let Some(secret) = prompted.as_deref() {
            match ssh.profiles.store_secret(&profile.id, secret) {
                Ok(()) => secret_saved = true,
                Err(e) => log::warn!("[SSH] Could not save secret to keychain: {}", e),
            }
        }
    }
    if let Err(e) = ssh.profiles.update_last_connected(&profile.id) {
        log::warn!("[SSH] Could not record last connection: {}", e);
    }

    Ok(SSHSessionOpenResponse {
        opened,
        secret_saved,
    })
}

pub fn respond_host_key(ssh: &SSHManager, session_id: &str, trust: bool) -> bool {
    ssh.sessions.respond_host_key(session_id, trust)
}

pub fn cancel_session(ssh: &SSHManager, session_id: &str) -> bool {
    ssh.sessions.cancel(session_id)
}

/// Close a session: kills its terminal (which closes the channel and the
/// connection), or cancels the connect when it is still in progress.
pub async fn close_session(ssh: &SSHManager, pty: &PtyManager, session_id: &str) -> SshResult<()> {
    match ssh.sessions.terminal_id(session_id) {
        Some(terminal_id) => pty
            .force_kill(&terminal_id)
            .await
            .map_err(|e| SshFailure::new(e, "SSH_SESSION_CLOSE_ERROR")),
        None => {
            // Still connecting, or connected but its shell not yet adopted.
            if !ssh.sessions.cancel(session_id) {
                ssh.sessions.close_unadopted(session_id).await;
            }
            Ok(())
        }
    }
}

/// Live sessions with fresh attach claims, for a renderer that reloaded.
pub fn list_sessions(ssh: &SSHManager, pty: &PtyManager) -> Vec<SSHLiveSession> {
    ssh.sessions
        .list()
        .into_iter()
        .map(|session| {
            let claim = session
                .terminal_id
                .as_deref()
                .and_then(|id| pty.reissue_unbound_claim(id));
            SSHLiveSession { session, claim }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// SFTP (over a session's connection)
// ---------------------------------------------------------------------------

fn session_connection(ssh: &SSHManager, session_id: &str) -> SshResult<Arc<SshConnection>> {
    ssh.sessions
        .connection(session_id)
        .ok_or_else(|| SshFailure::new("The session is not connected", "SSH_CONNECTION_NOT_FOUND"))
}

/// Run `op` on the session's file browser channel; its error gets `code`.
async fn with_sftp<T, F, Fut>(ssh: &SSHManager, session_id: &str, code: &'static str, op: F) -> SshResult<T>
where
    F: FnOnce(Arc<SftpSession>) -> Fut,
    Fut: Future<Output = Result<T, String>>,
{
    let connection = session_connection(ssh, session_id)?;
    let sftp = connection
        .sftp()
        .await
        .map_err(|e| SshFailure::new(e, "SFTP_UNAVAILABLE"))?;
    op(sftp).await.map_err(|e| SshFailure::new(e, code))
}

pub async fn sftp_list_dir(ssh: &SSHManager, r: SFTPPathRequest) -> SshResult<Vec<SFTPEntry>> {
    with_sftp(ssh, &r.connection_id, "SFTP_ERROR", |sftp| async move {
        sftp_ops::list_dir(&sftp, &r.remote_path).await
    })
    .await
}

pub async fn sftp_realpath(ssh: &SSHManager, r: SFTPPathRequest) -> SshResult<String> {
    with_sftp(ssh, &r.connection_id, "SFTP_ERROR", |sftp| async move {
        sftp_ops::realpath(&sftp, &r.remote_path).await
    })
    .await
}

pub async fn sftp_download(ssh: &SSHManager, r: SFTPTransferRequest) -> SshResult<()> {
    let emit = ssh.emit.clone();
    let session_id = r.connection_id.clone();
    with_sftp(ssh, &session_id, "SFTP_DOWNLOAD_ERROR", |sftp| async move {
        sftp_ops::download_file(&sftp, &r.remote_path, &r.local_path, &emit, &r.connection_id).await
    })
    .await
}

pub async fn sftp_upload(ssh: &SSHManager, r: SFTPTransferRequest) -> SshResult<()> {
    let emit = ssh.emit.clone();
    let session_id = r.connection_id.clone();
    with_sftp(ssh, &session_id, "SFTP_UPLOAD_ERROR", |sftp| async move {
        sftp_ops::upload_file(&sftp, &r.local_path, &r.remote_path, &emit, &r.connection_id).await
    })
    .await
}

pub async fn sftp_delete(ssh: &SSHManager, r: SFTPPathRequest) -> SshResult<()> {
    with_sftp(ssh, &r.connection_id, "SFTP_DELETE_ERROR", |sftp| async move {
        sftp_ops::delete_path(&sftp, &r.remote_path).await
    })
    .await
}

pub async fn sftp_mkdir(ssh: &SSHManager, r: SFTPPathRequest) -> SshResult<()> {
    with_sftp(ssh, &r.connection_id, "SFTP_MKDIR_ERROR", |sftp| async move {
        sftp_ops::mkdir(&sftp, &r.remote_path).await
    })
    .await
}

pub async fn sftp_rename(ssh: &SSHManager, r: SFTPRenameRequest) -> SshResult<()> {
    with_sftp(ssh, &r.connection_id, "SFTP_RENAME_ERROR", |sftp| async move {
        sftp_ops::rename(&sftp, &r.old_path, &r.new_path).await
    })
    .await
}

pub async fn sftp_read_file(ssh: &SSHManager, r: SFTPFileRequest) -> SshResult<String> {
    with_sftp(ssh, &r.connection_id, "SFTP_READ_ERROR", |sftp| async move {
        sftp_ops::read_file_to_string(&sftp, &r.remote_path).await
    })
    .await
}

pub async fn sftp_write_file(ssh: &SSHManager, r: SFTPFileRequest) -> SshResult<()> {
    let content = r.content.unwrap_or_default();
    with_sftp(ssh, &r.connection_id, "SFTP_WRITE_ERROR", |sftp| async move {
        sftp_ops::write_file_from_string(&sftp, &r.remote_path, &content).await
    })
    .await
}

pub async fn sftp_create_file(ssh: &SSHManager, r: SFTPPathRequest) -> SshResult<()> {
    with_sftp(ssh, &r.connection_id, "SFTP_CREATE_ERROR", |sftp| async move {
        sftp_ops::create_file(&sftp, &r.remote_path).await
    })
    .await
}
