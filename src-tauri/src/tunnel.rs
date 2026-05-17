use crate::commands::IpcResult;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

lazy_static::lazy_static! {
    static ref URL_REGEX: Regex = Regex::new(r"https://[a-zA-Z0-9.-]+\.trycloudflare\.com(?:/[^\s]*)?").unwrap();
    static ref URL_REGEX_FALLBACK: Regex = Regex::new(r#"(https://[^\s"']+\.trycloudflare\.com(?:/[^\s"']*)?)"#).unwrap();
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

static TUNNELS: OnceLock<Mutex<HashMap<String, Child>>> = OnceLock::new();
static SESSIONS: OnceLock<Mutex<HashMap<String, TunnelSession>>> = OnceLock::new();

fn tunnels() -> &'static Mutex<HashMap<String, Child>> {
    TUNNELS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn sessions() -> &'static Mutex<HashMap<String, TunnelSession>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cloudflared_command() -> Command {
    Command::new("cloudflared")
}

async fn is_cloudflared_available() -> bool {
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

async fn set_session_status(
    tunnel_id: &str,
    status: &str,
    public_url: Option<String>,
    last_error: Option<String>,
) {
    if let Some(session) = sessions().lock().await.get_mut(tunnel_id) {
        session.status = status.to_string();
        session.public_url = public_url;
        session.last_error = last_error;
    }
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
    if lower.contains("unauthorized") || lower.contains("invalid token") || lower.contains("token") {
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

pub async fn tunnel_start(
    config: TunnelConfig,
    app_handle: AppHandle,
) -> Result<IpcResult<TunnelSession>, String> {
    if !is_cloudflared_available().await {
        return Ok(IpcResult::error(
            "cloudflared is not installed or not available on PATH",
            "CLOUDFLARED_NOT_FOUND",
        ));
    }

    if tunnels().lock().await.contains_key(&config.id) {
        return Ok(IpcResult::error(
            "Tunnel already running for this id",
            "TUNNEL_ALREADY_RUNNING",
        ));
    }

    let mut cmd = cloudflared_command();
    let initial_public_url = config.hostname.as_ref().map(|hostname| {
        if hostname.starts_with("http://") || hostname.starts_with("https://") {
            hostname.clone()
        } else {
            format!("https://{}", hostname)
        }
    });
    
    if let Some(token) = &config.cloudflare_token {
        // Mode Named Tunnel (Pakai Token)
        // URL publik biasanya muncul dari hostname tunnel / log cloudflared
        cmd.args(["tunnel", "--no-autoupdate", "run", "--token", token]);
    } else {
        // Mode Quick Tunnel (Random URL)
        cmd.args(["tunnel", "--url", &format!("http://127.0.0.1:{}", config.local_port)]);
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

    sessions()
        .lock()
        .await
        .insert(config.id.clone(), session.clone());

    let stdout = child.stdout.take().expect("Failed to capture stdout");
    let stderr = child.stderr.take().expect("Failed to capture stderr");

    tunnels().lock().await.insert(config.id.clone(), child);

    let tunnel_id = config.id.clone();
    let app = app_handle.clone();

    // Process STDOUT
    let app_stdout = app.clone();
    let id_stdout = tunnel_id.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let line_trimmed = line.trim().to_string();
            if line_trimmed.is_empty() { continue; }

            let _ = app_stdout.emit(
                "tunnel-log",
                TunnelLogEvent {
                    tunnel_id: id_stdout.clone(),
                    line: line_trimmed.clone(),
                },
            );
            if let Some(url) = extract_url(&line_trimmed) {
                set_session_status(&id_stdout, "running", Some(url.clone()), None).await;
                emit_status(&app_stdout, &id_stdout, "running", Some(url), None);
            } else if line_trimmed.contains("Registered tunnel connection") || line_trimmed.contains("Connection established") {
                let public_url = sessions().lock().await.get(&id_stdout).and_then(|session| session.public_url.clone());
                set_session_status(&id_stdout, "running", public_url.clone(), None).await;
                emit_status(&app_stdout, &id_stdout, "running", public_url, None);
            }
        }
    });

    // Process STDERR
    let app_stderr = app.clone();
    let id_stderr = tunnel_id.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let line_trimmed = line.trim().to_string();
            if line_trimmed.is_empty() { continue; }

            let _ = app_stderr.emit(
                "tunnel-log",
                TunnelLogEvent {
                    tunnel_id: id_stderr.clone(),
                    line: line_trimmed.clone(),
                },
            );

            if let Some(url) = extract_url(&line_trimmed) {
                set_session_status(&id_stderr, "running", Some(url.clone()), None).await;
                emit_status(&app_stderr, &id_stderr, "running", Some(url), None);
            } else if line_trimmed.contains("Registered tunnel connection") || line_trimmed.contains("Connection established") {
                let public_url = sessions().lock().await.get(&id_stderr).and_then(|session| session.public_url.clone());
                set_session_status(&id_stderr, "running", public_url.clone(), None).await;
                emit_status(&app_stderr, &id_stderr, "running", public_url, None);
            }

            if let Some((message, code)) = classify_cloudflared_error(&line_trimmed) {
                set_session_status(
                    &id_stderr,
                    "error",
                    None,
                    Some(format!("{} ({})", message, code)),
                )
                .await;
                emit_status(&app_stderr, &id_stderr, "error", None, Some(message));
            }
        }

        // Cleanup when child process ends
        let mut tunnels_guard = tunnels().lock().await;
        if let Some(mut child) = tunnels_guard.remove(&id_stderr) {
            let _ = child.kill().await;
        }

        let mut sessions_guard = sessions().lock().await;
        if let Some(session) = sessions_guard.get_mut(&id_stderr) {
            if session.status != "stopped" && session.status != "error" {
                session.status = "stopped".to_string();
                emit_status(&app_stderr, &id_stderr, "stopped", None, None);
            }
        }
    });

    Ok(IpcResult::success(session))
}

fn extract_url(line: &str) -> Option<String> {
    if let Some(m) = URL_REGEX.find(line) {
        return Some(m.as_str().trim_matches(',').trim_matches('"').trim_matches('\'').to_string());
    }
    
    // Fallback if the standard regex fails
    URL_REGEX_FALLBACK
        .captures(line)
        .and_then(|cap| cap.get(1))
        .map(|m| m.as_str().trim_matches(',').trim_matches('"').trim_matches('\'').to_string())
}

pub async fn tunnel_stop(
    tunnel_id: String,
    app_handle: AppHandle,
) -> Result<IpcResult<()>, String> {
    if let Some(mut child) = tunnels().lock().await.remove(&tunnel_id) {
        let _ = child.kill().await;
        if let Some(session) = sessions().lock().await.get_mut(&tunnel_id) {
            session.status = "stopped".to_string();
        }
        let _ = app_handle.emit(
            "tunnel-status-changed",
            TunnelStatusEvent {
                tunnel_id,
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

pub async fn tunnel_get_status(
    tunnel_id: String,
) -> Result<IpcResult<Option<TunnelSession>>, String> {
    Ok(IpcResult::success(
        sessions().lock().await.get(&tunnel_id).cloned(),
    ))
}

pub async fn tunnel_list() -> Result<IpcResult<Vec<TunnelSession>>, String> {
    Ok(IpcResult::success(
        sessions()
            .lock()
            .await
            .values()
            .cloned()
            .collect(),
    ))
}

pub async fn kill_all_tunnels() {
    let mut tunnels_guard = tunnels().lock().await;
    for (_, mut child) in tunnels_guard.drain() {
        let _ = child.kill().await;
    }
}

