//! A live, authenticated SSH connection.
//!
//! One connection per session tab carries the interactive shell plus the
//! SFTP subsystem and port forwards, opened on demand as extra channels —
//! no second login and no second host-key check.

use super::connect::{ClientHandler, Connected, ConnectionState};
use russh::client::Handle;
use russh_sftp::client::SftpSession;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

/// Bound on opening the SFTP subsystem and on each SFTP request.
const SFTP_TIMEOUT_SECS: u64 = 30;
/// Bound on a polite SFTP close before disconnecting.
const SFTP_CLOSE_TIMEOUT: Duration = Duration::from_secs(2);

pub struct SshConnection {
    handle: Handle<ClientHandler>,
    state: Arc<ConnectionState>,
    sftp: Mutex<Option<Arc<SftpSession>>>,
}

impl SshConnection {
    pub fn new(connected: Connected) -> Arc<Self> {
        Arc::new(Self {
            handle: connected.handle,
            state: connected.state,
            sftp: Mutex::new(None),
        })
    }

    pub fn handle(&self) -> &Handle<ClientHandler> {
        &self.handle
    }

    pub fn is_closed(&self) -> bool {
        self.handle.is_closed()
    }

    /// Why the connection ended, when it did.
    pub fn disconnect_reason(&self) -> Option<String> {
        self.state.disconnect_reason()
    }

    /// The SFTP subsystem on this connection, opened on first use.
    pub async fn sftp(&self) -> Result<Arc<SftpSession>, String> {
        let mut slot = self.sftp.lock().await;
        if let Some(sftp) = slot.as_ref() {
            return Ok(sftp.clone());
        }
        if self.is_closed() {
            return Err("The connection is closed".to_string());
        }
        let opened = tokio::time::timeout(Duration::from_secs(SFTP_TIMEOUT_SECS), async {
            let channel = self
                .handle
                .channel_open_session()
                .await
                .map_err(|e| format!("Could not open a channel: {}", e))?;
            channel
                .request_subsystem(true, "sftp")
                .await
                .map_err(|e| format!("The server refused SFTP: {}", e))?;
            let sftp = SftpSession::new(channel.into_stream())
                .await
                .map_err(|e| format!("SFTP did not start: {}", e))?;
            sftp.set_timeout(SFTP_TIMEOUT_SECS);
            Ok::<_, String>(sftp)
        })
        .await
        .map_err(|_| "SFTP did not start in time".to_string())??;
        let sftp = Arc::new(opened);
        *slot = Some(sftp.clone());
        log::info!("[SSH] SFTP subsystem opened");
        Ok(sftp)
    }

    /// Close the whole connection (shell, SFTP, forwards). Idempotent.
    pub async fn close(&self) {
        // An SFTP start in progress holds the slot for up to its timeout;
        // never wait for it — the disconnect below ends it anyway.
        if let Ok(mut slot) = self.sftp.try_lock() {
            if let Some(sftp) = slot.take() {
                let _ = tokio::time::timeout(SFTP_CLOSE_TIMEOUT, sftp.close()).await;
            }
        }
        if !self.is_closed() {
            let _ = self
                .handle
                .disconnect(russh::Disconnect::ByApplication, "Session closed", "en")
                .await;
        }
    }
}
