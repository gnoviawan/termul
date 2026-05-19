use crate::commands::IpcResult;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::RwLock;

lazy_static::lazy_static! {
    static ref URL_REGEX: Regex =
        Regex::new(r"https://[a-zA-Z0-9.-]+\.trycloudflare\.com(?:/[^\s]*)?").unwrap();
    static ref URL_REGEX_FALLBACK: Regex =
        Regex::new(r#"(https://[^\s"']+\.trycloudflare\.com(?:/[^\s"']*)?)"#).unwrap();
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelConfig {
    pub id: String,
    pub name: String,
    pub local_port: u16,
    #[serde(default)]
    pub hostname: Option<String>,
    #[serde(default)]
    pub cloudflare_token: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub auto_start: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelSession {
    pub id: String,
    pub config_id: String,
    pub status: String,
    #[serde(default)]
    pub public_url: Option<String>,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatusEvent {
    pub tunnel_id: String,
    pub status: String,
    #[serde(default)]
    pub public_url: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelLogEvent {
    pub tunnel_id: String,
    pub line: String,
}

static TUNNEL_MANAGER: std::sync::OnceLock<TunnelManager> = std::sync::OnceLock::new();

fn manager() -> &'static TunnelManager {
    TUNNEL_MANAGER.get_or_init(|| TunnelManager {
        tunnels: RwLock::new(HashMap::new()),
        sessions: RwLock::new(HashMap::new()),
    })
}

struct TunnelManager {
    tunnels: RwLock<HashMap<String, Child>>,
    sessions: RwLock<HashMap<String, TunnelSession>>,
}

// ==================== Public API (called from commands.rs / lib.rs) ====================

pub async fn tunnel_start(
    config: TunnelConfig,
    app_handle: AppHandle,
) -> Result<IpcResult<TunnelSession>, String> {
    manager().start(&config, &app_handle).await
}

pub async fn tunnel_stop(
    tunnel_id: String,
    app_handle: AppHandle,
) -> Result<IpcResult<()>, String> {
    manager().stop(&tunnel_id, &app_handle).await
}

pub async fn tunnel_get_status(
    tunnel_id: String,
) -> Result<IpcResult<Option<TunnelSession>>, String> {
    let session = manager().sessions.read().await.get(&tunnel_id).cloned();
    Ok(IpcResult::success(session))
}

pub async fn tunnel_list() -> Result<IpcResult<Vec<TunnelSession>>, String> {
    let sessions = manager().sessions.read().await.values().cloned().collect();
    Ok(IpcResult::success(sessions))
}

pub async fn kill_all_tunnels() {
    let tunnels = &manager().tunnels;
    let sessions = &manager().sessions;
    for (_, mut child) in tunnels.write().await.drain() {
        let _ = child.kill().await;
    }
    sessions.write().await.clear();
}

// ==================== TunnelManager implementation ====================

impl TunnelManager {
    async fn start(
        &self,
        config: &TunnelConfig,
        app_handle: &AppHandle,
    ) -> Result<IpcResult<TunnelSession>, String> {
        if !cloudflared_available().await {
            return Ok(IpcResult::error(
                "cloudflared is not installed or not available on PATH",
                "CLOUDFLARED_NOT_FOUND",
            ));
        }

        self.stop_existing(config, app_handle).await;

        let mut cmd = Command::new("cloudflared");
        let initial_public_url = config.hostname.as_ref().map(|hostname| {
            if hostname.starts_with("http://") || hostname.starts_with("https://") {
                hostname.clone()
            } else {
                format!("https://{}", hostname)
            }
        });

        if let Some(token) = &config.cloudflare_token {
            cmd.args(["tunnel", "--no-autoupdate", "run", "--token", token]);
        } else {
            cmd.args([
                "tunnel",
                "--url",
                &format!("http://127.0.0.1:{}", config.local_port),
            ]);
        }

        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|error| format!("Failed to start cloudflared: {}", error))?;
        let pid = child.id();
        let session = TunnelSession {
            id: config.id.clone(),
            config_id: config.id.clone(),
            status: "starting".to_string(),
            public_url: initial_public_url,
            pid,
            last_error: None,
        };

        self.sessions
            .write()
            .await
            .insert(config.id.clone(), session.clone());

        let stdout = child.stdout.take().expect("Failed to capture stdout");
        let stderr = child.stderr.take().expect("Failed to capture stderr");
        self.tunnels.write().await.insert(config.id.clone(), child);

        let tunnel_id = config.id.clone();
        let app = app_handle.clone();
        let tunnel_id2 = tunnel_id.clone();
        let app2 = app.clone();

        tokio::spawn(async move {
            read_cloudflared_output(stdout, tunnel_id, app, false).await;
        });
        tokio::spawn(async move {
            read_cloudflared_output(stderr, tunnel_id2, app2, true).await;
        });

        Ok(IpcResult::success(session))
    }

    async fn stop_existing(&self, config: &TunnelConfig, app_handle: &AppHandle) {
        if let Some(mut old_child) = self.tunnels.write().await.remove(&config.id) {
            let _ = old_child.kill().await;
        }
        if let Some(session) = self.sessions.write().await.get_mut(&config.id) {
            session.status = "stopped".to_string();
        }
        let _ = app_handle.emit(
            "tunnel-status-changed",
            TunnelStatusEvent {
                tunnel_id: config.id.clone(),
                status: "stopped".to_string(),
                public_url: None,
                last_error: None,
            },
        );
    }

    async fn stop(
        &self,
        tunnel_id: &str,
        app_handle: &AppHandle,
    ) -> Result<IpcResult<()>, String> {
        let mut tunnels = self.tunnels.write().await;
        if let Some(mut child) = tunnels.remove(tunnel_id) {
            let _ = child.kill().await;
            drop(tunnels);
            if let Some(session) = self.sessions.write().await.get_mut(tunnel_id) {
                session.status = "stopped".to_string();
            }
            let _ = app_handle.emit(
                "tunnel-status-changed",
                TunnelStatusEvent {
                    tunnel_id: tunnel_id.to_string(),
                    status: "stopped".to_string(),
                    public_url: None,
                    last_error: None,
                },
            );
            Ok(IpcResult::success(()))
        } else {
            Ok(IpcResult::error("Tunnel not found", "TUNNEL_NOT_FOUND"))
        }
    }
}

// ==================== cloudflared output reader (shared by stdout + stderr) ====================

async fn read_cloudflared_output<R: AsyncRead + Unpin + Send + 'static>(
    reader: R,
    tunnel_id: String,
    app_handle: AppHandle,
    is_stderr: bool,
) {
    let mut buf_reader = BufReader::new(reader).lines();
    while let Ok(Some(line)) = buf_reader.next_line().await {
        let line_trimmed = line.trim().to_string();
        if line_trimmed.is_empty() {
            continue;
        }
        emit_log(&app_handle, &tunnel_id, &line_trimmed);

        if let Some(url) = extract_url(&line_trimmed) {
            update_session(&tunnel_id, "running", Some(url.clone()), None).await;
            emit_status(&app_handle, &tunnel_id, "running", Some(url), None);
        } else if is_connection_established(&line_trimmed) {
            let public_url = get_session_public_url(&tunnel_id).await;
            update_session(&tunnel_id, "running", public_url.clone(), None).await;
            emit_status(&app_handle, &tunnel_id, "running", public_url, None);
        }

        if is_stderr {
            if let Some((message, code)) = classify_cloudflared_error(&line_trimmed) {
                update_session(
                    &tunnel_id,
                    "error",
                    None,
                    Some(format!("{} ({})", message, code)),
                )
                .await;
                emit_status(&app_handle, &tunnel_id, "error", None, Some(message));
            }
        }
    }

    if is_stderr {
        cleanup_tunnel(&app_handle, &tunnel_id).await;
    }
}

async fn update_session(
    tunnel_id: &str,
    status: &str,
    public_url: Option<String>,
    last_error: Option<String>,
) {
    let mut sessions = manager().sessions.write().await;
    if let Some(session) = sessions.get_mut(tunnel_id) {
        session.status = status.to_string();
        if public_url.is_some() {
            session.public_url = public_url;
        }
        if last_error.is_some() {
            session.last_error = last_error;
        }
    }
}

async fn get_session_public_url(tunnel_id: &str) -> Option<String> {
    manager()
        .sessions
        .read()
        .await
        .get(tunnel_id)
        .and_then(|s| s.public_url.clone())
}

async fn cleanup_tunnel(app_handle: &AppHandle, tunnel_id: &str) {
    let mut tunnels = manager().tunnels.write().await;
    if let Some(mut child) = tunnels.remove(tunnel_id) {
        let _ = child.kill().await;
    }
    drop(tunnels);

    let mut sessions = manager().sessions.write().await;
    if let Some(session) = sessions.get_mut(tunnel_id) {
        if session.status != "stopped" && session.status != "error" {
            session.status = "stopped".to_string();
            emit_status(app_handle, tunnel_id, "stopped", None, None);
        }
    }
}

// ==================== Helper functions ====================

async fn cloudflared_available() -> bool {
    if Path::new("cloudflared").exists() {
        return true;
    }
    Command::new("cloudflared")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|status| status.success() || status.code().is_some())
        .unwrap_or(false)
}

fn emit_log(app_handle: &AppHandle, tunnel_id: &str, line: &str) {
    let _ = app_handle.emit(
        "tunnel-log",
        TunnelLogEvent {
            tunnel_id: tunnel_id.to_string(),
            line: line.to_string(),
        },
    );
}

fn emit_status(
    app_handle: &AppHandle,
    tunnel_id: &str,
    status: &str,
    public_url: Option<String>,
    last_error: Option<String>,
) {
    let _ = app_handle.emit(
        "tunnel-status-changed",
        TunnelStatusEvent {
            tunnel_id: tunnel_id.to_string(),
            status: status.to_string(),
            public_url,
            last_error,
        },
    );
}

fn is_connection_established(line: &str) -> bool {
    line.contains("Registered tunnel connection") || line.contains("Connection established")
}

fn extract_url(line: &str) -> Option<String> {
    if let Some(m) = URL_REGEX.find(line) {
        return Some(
            m.as_str()
                .trim_matches(',')
                .trim_matches('"')
                .trim_matches('\'')
                .to_string(),
        );
    }
    URL_REGEX_FALLBACK
        .captures(line)
        .and_then(|cap| cap.get(1))
        .map(|m| {
            m.as_str()
                .trim_matches(',')
                .trim_matches('"')
                .trim_matches('\'')
                .to_string()
        })
}

fn classify_cloudflared_error(line: &str) -> Option<(String, String)> {
    let lower = line.to_ascii_lowercase();
    if lower.contains("no such host") || lower.contains("could not resolve") {
        return Some(("DNS resolution failed".to_string(), "DNS_FAILED".to_string()));
    }
    if lower.contains("connection refused") || lower.contains("failed to connect") {
        return Some((
            "Unable to connect to local service".to_string(),
            "LOCAL_SERVICE_UNAVAILABLE".to_string(),
        ));
    }
    if lower.contains("permission denied") || lower.contains("access denied") {
        return Some((
            "Permission denied while starting cloudflared".to_string(),
            "PERMISSION_DENIED".to_string(),
        ));
    }
    if lower.contains("unauthorized") || lower.contains("invalid token") || lower.contains("token")
    {
        return Some((
            "Cloudflare authentication failed".to_string(),
            "CLOUDFLARE_AUTH_FAILED".to_string(),
        ));
    }
    if lower.contains("tunnel not found") {
        return Some((
            "Tunnel not found in Cloudflare account".to_string(),
            "TUNNEL_NOT_FOUND".to_string(),
        ));
    }
    if lower.contains("address already in use") || lower.contains("port is already allocated") {
        return Some((
            "Local port is already in use".to_string(),
            "PORT_IN_USE".to_string(),
        ));
    }
    if lower.contains("exceeded") || lower.contains("rate limit") {
        return Some((
            "Cloudflare rate limit reached".to_string(),
            "RATE_LIMITED".to_string(),
        ));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_url_handles_plain_and_fallback_matches() {
        assert_eq!(
            extract_url("route available at https://demo.trycloudflare.com/path, ready").as_deref(),
            Some("https://demo.trycloudflare.com/path")
        );
        assert_eq!(
            extract_url("public tunnel \"https://demo.trycloudflare.com\" online").as_deref(),
            Some("https://demo.trycloudflare.com")
        );
    }

    #[test]
    fn classify_cloudflared_error_maps_common_failures() {
        assert_eq!(
            classify_cloudflared_error("lookup api.cloudflare.com: no such host"),
            Some(("DNS resolution failed".to_string(), "DNS_FAILED".to_string()))
        );
        assert_eq!(
            classify_cloudflared_error("connection refused while connecting to 127.0.0.1"),
            Some(("Unable to connect to local service".to_string(), "LOCAL_SERVICE_UNAVAILABLE".to_string()))
        );
        assert_eq!(
            classify_cloudflared_error("invalid token provided"),
            Some(("Cloudflare authentication failed".to_string(), "CLOUDFLARE_AUTH_FAILED".to_string()))
        );
        assert_eq!(
            classify_cloudflared_error("tunnel not found in account"),
            Some(("Tunnel not found in Cloudflare account".to_string(), "TUNNEL_NOT_FOUND".to_string()))
        );
        assert_eq!(
            classify_cloudflared_error("address already in use"),
            Some(("Local port is already in use".to_string(), "PORT_IN_USE".to_string()))
        );
    }

    #[test]
    fn connection_established_detection_matches_expected_messages() {
        assert!(is_connection_established("Registered tunnel connection"));
        assert!(is_connection_established("Connection established"));
        assert!(!is_connection_established("still starting up"));
    }
}
