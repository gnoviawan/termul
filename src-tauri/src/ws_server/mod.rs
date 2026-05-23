pub(crate) mod commands;
pub(crate) mod handler;
pub(crate) mod html;
pub(crate) mod server;
pub(crate) mod utils;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::time::{Instant, SystemTime};
use tauri::AppHandle;
use tokio::sync::{Mutex, broadcast, watch};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveProjectInfo {
    pub name: String,
    pub path: String,
    pub default_shell: Option<String>,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    pub color: String,
    pub path: Option<String>,
    pub is_active: Option<bool>,
}

#[derive(Clone)]
pub(crate) struct AppState {
    pub index_html: String,
    pub app_handle: AppHandle,
    pub server: Arc<WsServer>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum WsInbound {
    Auth {
        token: String,
        #[serde(rename = "projectId", default)]
        project_id: Option<String>,
        #[serde(rename = "sessionId", default)]
        session_id: Option<String>,
    },
    Request {
        id: String,
        method: String,
        #[serde(default)]
        params: Option<serde_json::Value>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum WsOutbound {
    Response {
        id: String,
        success: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<String>,
    },
    Event {
        event: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        payload: Option<serde_json::Value>,
    },
    Pong(Vec<u8>),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WsServerStatus {
    pub is_running: bool,
    pub port: u16,
    pub client_count: usize,
    pub session_id: String,
    pub active_project_id: Option<String>,
    pub token_ttl_secs: u64,
    pub http_url: String,
    pub ws_url: String,
    pub use_https: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionAudit {
    pub timestamp: String,
    pub remote_addr: String,
    pub event: String,
    pub authenticated: bool,
    pub client_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WsClientInfo {
    pub client_id: String,
    pub ip_address: String,
    pub remote_addr: String,
    pub authenticated: bool,
    pub connected_at: String,
    pub last_activity_at: String,
}

pub(crate) struct WsClient {
    pub client_id: String,
    pub authenticated: bool,
    pub tx: tokio::sync::mpsc::UnboundedSender<WsOutbound>,
    pub disconnect_tx: watch::Sender<bool>,
    pub ip_address: String,
    pub remote_addr: String,
    pub connected_at: Instant,
    pub connected_at_system: SystemTime,
    pub last_activity_at_system: SystemTime,
}

pub struct WsServer {
    pub(crate) config: Mutex<Option<(u16, String, bool)>>,
    pub(crate) status: Mutex<WsServerStatus>,
    pub(crate) clients: Mutex<HashMap<String, WsClient>>,
    pub(crate) event_tx: broadcast::Sender<WsOutbound>,
    pub(crate) running: AtomicBool,
    pub(crate) self_weak: std::sync::Mutex<Option<std::sync::Weak<WsServer>>>,
    pub(crate) audit_log: Mutex<Vec<ConnectionAudit>>,
    pub(crate) current_token: Mutex<String>,
    pub(crate) session_id: Mutex<String>,
    pub(crate) token_created_at: AtomicU64,
    pub(crate) token_ttl_secs: AtomicU64,
    pub(crate) auth_attempts: Mutex<HashMap<String, (u32, Instant)>>,
    pub(crate) active_project: Mutex<Option<ActiveProjectInfo>>,
    pub(crate) active_project_id: Mutex<Option<String>>,
    pub(crate) projects: Mutex<Vec<ProjectInfo>>,
}

pub(crate) const DEFAULT_TOKEN_TTL_SECS: u64 = 900;
