use crate::commands::IpcResult;
use serde::{Deserialize, Serialize};
use std::process::Stdio;
use std::sync::OnceLock;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteServerStatus {
    pub is_running: bool,
    pub port: u16,
    pub pid: Option<u32>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteLogEvent {
    pub line: String,
}

static SERVER_PROCESS: OnceLock<Mutex<Option<Child>>> = OnceLock::new();
static SERVER_PORT: OnceLock<Mutex<u16>> = OnceLock::new();

fn server_process() -> &'static Mutex<Option<Child>> {
    SERVER_PROCESS.get_or_init(|| Mutex::new(None))
}

fn server_port() -> &'static Mutex<u16> {
    SERVER_PORT.get_or_init(|| Mutex::new(8080))
}

pub async fn check_code_server_installed() -> bool {
    Command::new("code-server")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

pub async fn start_remote_server(port: u16, password: Option<String>, app_handle: AppHandle) -> Result<IpcResult<RemoteServerStatus>, String> {
    let mut process_guard = server_process().lock().await;
    
    if process_guard.is_some() {
        return Ok(IpcResult::error("Remote server already running", "ALREADY_RUNNING"));
    }

    if !check_code_server_installed().await {
        return Ok(IpcResult::error("code-server is not installed. Please run 'npm install -g code-server' first.", "NOT_INSTALLED"));
    }

    let mut cmd = Command::new("code-server");
    
    if let Some(pwd) = &password {
        if !pwd.trim().is_empty() {
            cmd.env("PASSWORD", pwd);
            cmd.args(["--auth", "password"]);
        } else {
            cmd.args(["--auth", "none"]);
        }
    } else {
        cmd.args(["--auth", "none"]);
    }

    cmd.args([
        "--port", &port.to_string(),
        "--bind-addr", "127.0.0.1",
        "--disable-telemetry",
    ]);

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn code-server: {}", e))?;
    let pid = child.id();

    let stdout = child.stdout.take().expect("Failed to capture stdout");
    let stderr = child.stderr.take().expect("Failed to capture stderr");

    // Monitor logs
    let app = app_handle.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app.emit("remote-server-log", RemoteLogEvent { line });
        }
    });

    let app2 = app_handle.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app2.emit("remote-server-log", RemoteLogEvent { line });
        }
    });

    *process_guard = Some(child);
    *server_port().lock().await = port;

    Ok(IpcResult::success(RemoteServerStatus {
        is_running: true,
        port,
        pid,
        version: None,
    }))
}

pub async fn stop_remote_server() -> Result<IpcResult<()>, String> {
    let mut process_guard = server_process().lock().await;
    if let Some(mut child) = process_guard.take() {
        let _ = child.kill().await;
        Ok(IpcResult::success(()))
    } else {
        Ok(IpcResult::error("Server not running", "NOT_RUNNING"))
    }
}

pub async fn get_remote_server_status() -> Result<IpcResult<RemoteServerStatus>, String> {
    let process_guard = server_process().lock().await;
    let port = *server_port().lock().await;
    
    Ok(IpcResult::success(RemoteServerStatus {
        is_running: process_guard.is_some(),
        port,
        pid: process_guard.as_ref().and_then(|c| c.id()),
        version: None,
    }))
}
