//! Agentation annotation service — MCP-native annotation backend.
//!
//! Reimplements agentation's HTTP + MCP protocol surface in Rust using
//! `rmcp` (MCP SDK) + `axum` (HTTP/SSE) + `rusqlite` (persistence).
//! Single Tauri binary, no Node sidecar, no `better-sqlite3`.
//!
//! Architecture (issue #451, Epic 1, Path C):
//! - `types` — wire-protocol types (Annotation, Session, AFSEvent, etc.)
//! - `store` — `SqliteStore` implementing `AnnotationStore` trait + `EventBus`
//! - `http_server` — axum HTTP/SSE server (14 routes) on dynamic port
//! - `mcp_server` — rmcp MCP server (9 tools) over stdio
//!
//! The HTTP server serves the injected toolbar's direct HTTP calls.
//! The MCP server serves agent-facing tool calls over stdio.

#[allow(dead_code)]
pub mod http_server;
#[allow(dead_code)]
pub mod mcp_server;
#[allow(dead_code)]
pub mod store;
#[allow(dead_code)]
pub mod types;

use std::sync::Arc;

use store::SqliteStore;
use tokio_util::sync::CancellationToken;
use types::AnnotationStore;
use crate::browser_tab_manager;

#[derive(Clone)]
#[allow(dead_code)]
pub struct AgentationService {
    pub store: Arc<SqliteStore>,
    pub http_addr: std::net::SocketAddr,
    pub shutdown: CancellationToken,
}

impl AgentationService {
    /// Start the agentation backend: open SQLite + spawn HTTP server.
    /// Returns the service handle. The MCP server runs separately on stdio.
    pub async fn start(db_path: &std::path::Path) -> Result<Self, String> {
        let store = Arc::new(SqliteStore::open(db_path)?);
        let (http_addr, shutdown) = http_server::start_server(store.clone()).await?;

        log::info!(
            "[Agentation] Service started — HTTP on {http_addr}, SQLite at {}",
            db_path.display()
        );

        Ok(Self { store, http_addr, shutdown })
    }

    /// The port the injected toolbar should connect to.
    pub fn http_port(&self) -> u16 {
        self.http_addr.port()
    }

    /// Graceful shutdown.
    #[allow(dead_code)]
    pub fn shutdown(&self) {
        self.shutdown.cancel();
    }
}

/// Determine the SQLite database path.
/// Uses `app_data_dir/annotations.db` (Tauri's per-app data directory).
pub fn db_path(app_data_dir: &std::path::Path) -> std::path::PathBuf {
    app_data_dir.join("annotations.db")
}

/// Run the MCP server on stdio (called from a subcommand entry point).
#[allow(dead_code)]
pub async fn run_mcp_stdio(app_data_dir: &std::path::Path) -> Result<(), String> {
    let path = db_path(app_data_dir);
    let store = Arc::new(SqliteStore::open(&path)?);
    mcp_server::serve_stdio(store).await
}

// ---------------------------------------------------------------------------
// Tauri commands (renderer facade calls these via invoke)
// ---------------------------------------------------------------------------

use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;

#[tauri::command]
pub async fn agentation_create_session(
    app: AppHandle,
    url: String,
    project_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let svc = get_service(&app)?;
    log::info!("[Agentation] create_session: url={}", url);
    let session = svc.store.create_session(&url, project_id.as_deref());
    serde_json::to_value(&session).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agentation_list_sessions(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let svc = get_service(&app)?;
    let sessions = svc.store.list_sessions();
    sessions.iter().map(|s| serde_json::to_value(s).map_err(|e| e.to_string())).collect()
}

#[tauri::command]
pub async fn agentation_get_session(
    app: AppHandle,
    session_id: String,
) -> Result<serde_json::Value, String> {
    let svc = get_service(&app)?;
    svc.store
        .get_session_with_annotations(&session_id)
        .and_then(|s| serde_json::to_value(&s).ok())
        .ok_or_else(|| {
            log::warn!("[Agentation] get_session: session not found: {session_id}");
            format!("Session not found: {session_id}")
        })
}

#[tauri::command]
pub async fn agentation_get_pending(
    app: AppHandle,
    session_id: String,
) -> Result<serde_json::Value, String> {
    let svc = get_service(&app)?;
    let annotations = svc.store.get_pending_annotations(&session_id);
    serde_json::to_value(serde_json::json!({
        "count": annotations.len(),
        "annotations": annotations,
    })).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agentation_get_all_pending(app: AppHandle) -> Result<serde_json::Value, String> {
    let svc = get_service(&app)?;
    let sessions = svc.store.list_sessions();
    let mut all = Vec::new();
    for s in &sessions {
        all.extend(svc.store.get_pending_annotations(&s.id));
    }
    serde_json::to_value(serde_json::json!({
        "count": all.len(),
        "annotations": all,
    })).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agentation_acknowledge(
    app: AppHandle,
    annotation_id: String,
) -> Result<serde_json::Value, String> {
    let svc = get_service(&app)?;
    svc.store
        .update_annotation_status(&annotation_id, types::AnnotationStatus::Acknowledged, Some("agent"))
        .and_then(|a| serde_json::to_value(&a).ok())
        .ok_or_else(|| {
            log::warn!("[Agentation] acknowledge: annotation not found: {annotation_id}");
            format!("Annotation not found: {annotation_id}")
        })
}

#[tauri::command]
pub async fn agentation_resolve(
    app: AppHandle,
    annotation_id: String,
    summary: Option<String>,
) -> Result<serde_json::Value, String> {
    let svc = get_service(&app)?;
    svc.store
        .update_annotation_status(&annotation_id, types::AnnotationStatus::Resolved, Some("agent"))
        .and_then(|a| serde_json::to_value(&a).ok())
        .ok_or_else(|| {
            log::warn!("[Agentation] resolve: annotation not found: {annotation_id}");
            format!("Annotation not found: {annotation_id}")
        })?;
    if let Some(s) = &summary {
        svc.store.add_thread_message(&annotation_id, types::ThreadRole::Agent, &format!("Resolved: {s}"));
    }
    serde_json::to_value(serde_json::json!({"resolved": true, "annotationId": annotation_id, "summary": summary}))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agentation_dismiss(
    app: AppHandle,
    annotation_id: String,
    reason: String,
) -> Result<serde_json::Value, String> {
    let svc = get_service(&app)?;
    svc.store
        .update_annotation_status(&annotation_id, types::AnnotationStatus::Dismissed, Some("agent"))
        .and_then(|a| serde_json::to_value(&a).ok())
        .ok_or_else(|| {
            log::warn!("[Agentation] dismiss: annotation not found: {annotation_id}");
            format!("Annotation not found: {annotation_id}")
        })?;
    svc.store.add_thread_message(&annotation_id, types::ThreadRole::Agent, &format!("Dismissed: {reason}"));
    serde_json::to_value(serde_json::json!({"dismissed": true, "annotationId": annotation_id, "reason": reason}))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agentation_reply(
    app: AppHandle,
    annotation_id: String,
    message: String,
) -> Result<serde_json::Value, String> {
    let svc = get_service(&app)?;
    svc.store
        .add_thread_message(&annotation_id, types::ThreadRole::Agent, &message)
        .and_then(|a| serde_json::to_value(&a).ok())
        .ok_or_else(|| {
            log::warn!("[Agentation] reply: annotation not found: {annotation_id}");
            format!("Annotation not found: {annotation_id}")
        })
}

#[tauri::command]
pub async fn agentation_set_enabled(
    app: AppHandle,
    enabled: bool,
) -> Result<(), String> {
    log::info!("[Agentation] set_enabled called: enabled={}", enabled);
    // Persist to settings.json so the preference survives restarts.
    if let Ok(store) = app.store("settings.json") {
        store.set("agentation/enabled", enabled);
        let _ = store.save();
    } else {
        log::warn!("[Agentation] settings store unavailable — preference will not persist");
    }
    if let Some(bt) = app.try_state::<Arc<browser_tab_manager::BrowserTabManager>>() {
        bt.set_agentation_enabled(enabled);
        log::info!("[Agentation] set_agentation_enabled applied to BrowserTabManager");
    } else {
        log::warn!("[Agentation] BrowserTabManager not found in managed state");
    }
    Ok(())
}

#[tauri::command]
pub async fn agentation_is_enabled(app: AppHandle) -> Result<bool, String> {
    // Read from persisted store first (source of truth), fall back to runtime state.
    if let Ok(store) = app.store("settings.json") {
        if let Some(val) = store.get("agentation/enabled") {
            return Ok(val.as_bool().unwrap_or(true));
        }
    }
    // No persisted value — use runtime default.
    if let Some(bt) = app.try_state::<Arc<browser_tab_manager::BrowserTabManager>>() {
        return Ok(bt.is_agentation_enabled());
    }
    Ok(false)
}
fn get_service(app: &AppHandle) -> Result<AgentationService, String> {
    app.try_state::<AgentationService>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| {
            log::warn!("[Agentation] service not started — command rejected");
            "Agentation service not started".to_string()
        })
}
