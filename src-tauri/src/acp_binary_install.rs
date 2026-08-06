//! Download and extract ACP registry release archives into app-local storage.
//!
//! Story 9 (CAP-6): the download/extract/permission helpers now live in
//! `acp/archive.rs` (shared with the new `AcpInstallService`); this module is
//! the legacy desktop-only `#[tauri::command]` kept for back-compat. The
//! host-owned verified install path lives in `acp/install.rs` and is exposed
//! across all three transports (Tauri `acp_install_agent`, HTTP
//! `POST /acp/install`, WS `install_acp_agent`).
//!
//! `is_safe_agent_id` is consolidated onto `acp_registry_snapshot::is_safe_agent_id`
//! (the pub version) — no duplicate here.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::acp::archive::{normalize_cmd_path, stage_archive};
use crate::acp_registry_snapshot::is_safe_agent_id;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallAcpRegistryBinaryRequest {
    pub agent_id: String,
    pub archive_url: String,
    pub cmd: String,
    pub args: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallAcpRegistryBinaryOutcome {
    pub command: String,
    pub args: Vec<String>,
}

fn is_allowed_archive_url(url: &str) -> bool {
    url.len() <= 2048 && url.starts_with("https://")
}

fn install_root(app: &AppHandle, agent_id: &str) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    Ok(base.join("acp-registry-binaries").join(agent_id))
}

/// Download + extract into a private staging directory; only swap it into the
/// real install root once everything succeeds, so a failure never destroys a
/// previously-working install.
pub async fn install_registry_binary(
    app: &AppHandle,
    req: InstallAcpRegistryBinaryRequest,
) -> Result<InstallAcpRegistryBinaryOutcome, String> {
    if !is_safe_agent_id(&req.agent_id) {
        return Err("invalid agent id".to_string());
    }
    if !is_allowed_archive_url(&req.archive_url) {
        return Err("archive URL must be https".to_string());
    }
    let cmd_trim = req.cmd.trim();
    if cmd_trim.is_empty() {
        return Err("cmd is required".to_string());
    }

    let root = install_root(app, &req.agent_id)?;
    if let Some(parent) = root.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create install parent: {e}"))?;
    }

    let tmp_dir = std::env::temp_dir().join(format!("termul-acp-dl-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
    let staging = tmp_dir.join("stage");
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;

    if let Err(e) = stage_archive(&req.archive_url, cmd_trim, &tmp_dir, &staging).await {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        return Err(e);
    }

    // Atomic-ish swap: move the old install aside, promote staging, drop backup.
    let backup = root.with_extension("old");
    let _ = std::fs::remove_dir_all(&backup);
    if root.exists() {
        std::fs::rename(&root, &backup).map_err(|e| format!("backup old install: {e}"))?;
    }
    if let Err(e) = std::fs::rename(&staging, &root) {
        // Restore the previous install on swap failure.
        if backup.exists() {
            let _ = std::fs::rename(&backup, &root);
        }
        let _ = std::fs::remove_dir_all(&tmp_dir);
        return Err(format!("promote install: {e}"));
    }
    let _ = std::fs::remove_dir_all(&backup);
    let _ = std::fs::remove_dir_all(&tmp_dir);

    // Recompute the program path under the final root (plain, non-canonical).
    let program = root.join(normalize_cmd_path(cmd_trim));

    let args = req.args.unwrap_or_default();
    Ok(InstallAcpRegistryBinaryOutcome {
        command: program.to_string_lossy().to_string(),
        args,
    })
}

#[tauri::command]
pub async fn acp_install_registry_binary(
    app: AppHandle,
    request: InstallAcpRegistryBinaryRequest,
) -> Result<InstallAcpRegistryBinaryOutcome, String> {
    install_registry_binary(&app, request).await
}
