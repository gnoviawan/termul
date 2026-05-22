use super::WsServer;
use super::WsOutbound;
use crate::commands::IpcResult;
use crate::pty::{PtyManager, SpawnOptions};
use crate::trackers::{CwdTracker, ExitCodeTracker, GitTracker};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use std::path::{Path, PathBuf};

fn check_path_boundary(target_path: &str, active_project_path: Option<&String>) -> Result<(), String> {
    let active_path = active_project_path.ok_or_else(|| "No active project available to scope file access".to_string())?;
    let canonical_active = Path::new(active_path).canonicalize()
        .map_err(|e| format!("Invalid active project path: {}", e))?;

    let mut path_to_check = PathBuf::from(target_path);
    while !path_to_check.exists() && path_to_check.parent().is_some() {
        path_to_check = path_to_check.parent().unwrap().to_path_buf();
    }

    let canonical_target = path_to_check.canonicalize()
        .map_err(|e| format!("Invalid path: {}", e))?;

    if !canonical_target.starts_with(&canonical_active) {
        return Err("Access denied: Path is outside the active project boundary".to_string());
    }

    Ok(())
}

pub(crate) async fn handle_command(
    method: &str,
    params: Option<serde_json::Value>,
    app_handle: &AppHandle,
    server: &Arc<WsServer>,
) -> Result<IpcResult<serde_json::Value>, String> {
    match method {
        "terminal_spawn" => {
            let mut options: SpawnOptions = if let Some(p) = params {
                if let Some(opt_val) = p.get("options") {
                    serde_json::from_value(opt_val.clone())
                        .map_err(|e| format!("Invalid options field: {}", e))?
                } else {
                    serde_json::from_value(p)
                        .map_err(|e| format!("Invalid params: {}", e))?
                }
            } else {
                SpawnOptions::default()
            };

            if let Some(active_proj) = &*server.active_project.lock().await {
                if options.cwd.is_none() || options.cwd.as_ref().map(|s| s.is_empty()).unwrap_or(true) {
                    options.cwd = Some(active_proj.path.clone());
                }
                if options.shell.is_none() || options.shell.as_ref().map(|s| s.is_empty()).unwrap_or(true) {
                    if let Some(shell) = &active_proj.default_shell {
                        if !shell.is_empty() {
                            options.shell = Some(shell.clone());
                        }
                    }
                }
            }

            let pty_manager = app_handle.try_state::<Arc<PtyManager>>()
                .ok_or_else(|| "PtyManager state not registered in Tauri app context".to_string())?;

            match pty_manager.spawn(options, None).await {
                Ok(info) => {
                    let _ = app_handle.emit("terminal-list-changed", serde_json::json!({
                        "reason": "spawn",
                        "terminalId": info.id,
                    }));
                    Ok(IpcResult::success(serde_json::to_value(&info).map_err(|e| e.to_string())?))
                }
                Err(e) => {
                    log::error!("[WsServer] Spawn terminal failed: {}", e);
                    Ok(IpcResult::error(e, "SPAWN_FAILED"))
                }
            }
        }
        "terminal_write" => {
            let params = params.ok_or("Missing params")?;
            let terminal_id: String = serde_json::from_value(params["terminalId"].clone())
                .map_err(|e| format!("Invalid terminalId: {}", e))?;
            let data: String = serde_json::from_value(params["data"].clone())
                .map_err(|e| format!("Invalid data: {}", e))?;

            let pty_manager = app_handle.try_state::<Arc<PtyManager>>()
                .ok_or_else(|| "PtyManager state not registered in Tauri app context".to_string())?;

            match pty_manager.write(&terminal_id, &data).await {
                Ok(()) => Ok(IpcResult::success(serde_json::json!(null))),
                Err(e) => Ok(IpcResult::error(e, "WRITE_FAILED")),
            }
        }
        "terminal_resize" => {
            let params = params.ok_or("Missing params")?;
            let terminal_id: String = serde_json::from_value(params["terminalId"].clone())
                .map_err(|e| format!("Invalid terminalId: {}", e))?;
            let cols: u16 = serde_json::from_value(params["cols"].clone())
                .map_err(|e| format!("Invalid cols: {}", e))?;
            let rows: u16 = serde_json::from_value(params["rows"].clone())
                .map_err(|e| format!("Invalid rows: {}", e))?;

            let pty_manager = app_handle.try_state::<Arc<PtyManager>>()
                .ok_or_else(|| "PtyManager state not registered in Tauri app context".to_string())?;

            match pty_manager.resize(&terminal_id, cols, rows).await {
                Ok(()) => Ok(IpcResult::success(serde_json::json!(null))),
                Err(e) => Ok(IpcResult::error(e, "RESIZE_FAILED")),
            }
        }
        "terminal_takeover" => {
            let params = params.ok_or("Missing params")?;
            let terminal_id: String = serde_json::from_value(params["terminalId"].clone())
                .map_err(|e| format!("Invalid terminalId: {}", e))?;
            let client_type: String = serde_json::from_value(params["clientType"].clone())
                .map_err(|e| format!("Invalid clientType: {}", e))?;

            let payload = serde_json::json!({
                "terminalId": terminal_id,
                "clientType": client_type,
            });

            // emit() to Tauri event bus — ConnectedTerminal.tsx receives this.
            // The bridge in lib.rs forwards it to all WebSocket clients too.
            // Do NOT also call server.emit_event() — double-emission breaks lock state.
            let _ = app_handle.emit("terminal-takeover", payload);

            Ok(IpcResult::success(serde_json::json!(null)))
        }
        "ui_lock_handover" => {
            let params = params.ok_or("Missing params")?;
            let target: String = serde_json::from_value(params["target"].clone())
                .map_err(|e| format!("Invalid target: {}", e))?;

            let payload = serde_json::json!({
                "target": target,
            });

            let _ = app_handle.emit("ui-lock-handover", payload);

            Ok(IpcResult::success(serde_json::json!(null)))
        }
        "terminal_kill" => {
            let params = params.ok_or("Missing params")?;
            let terminal_id: String = serde_json::from_value(params["terminalId"].clone())
                .map_err(|e| format!("Invalid terminalId: {}", e))?;

            let pty_manager = app_handle.try_state::<Arc<PtyManager>>()
                .ok_or_else(|| "PtyManager state not registered in Tauri app context".to_string())?;

            match pty_manager.kill(&terminal_id).await {
                Ok(()) => {
                    let _ = app_handle.emit("terminal-list-changed", serde_json::json!({
                        "reason": "kill",
                        "terminalId": terminal_id,
                    }));
                    Ok(IpcResult::success(serde_json::json!(null)))
                }
                Err(e) => Ok(IpcResult::error(e, "KILL_FAILED")),
            }
        }
        "terminal_get_cwd" => {
            let params = params.ok_or("Missing params")?;
            let terminal_id: String = serde_json::from_value(params["terminalId"].clone())
                .map_err(|e| format!("Invalid terminalId: {}", e))?;

            let cwd_tracker = app_handle.state::<Arc<CwdTracker>>();
            let cwd = cwd_tracker.get_cwd(&terminal_id);
            Ok(IpcResult::success(serde_json::to_value(&cwd).map_err(|e| e.to_string())?))
        }
        "terminal_probe" => {
            let params = params.ok_or("Missing params")?;
            let terminal_id: String = serde_json::from_value(params["terminalId"].clone())
                .map_err(|e| format!("Invalid terminalId: {}", e))?;

            let pty_manager = app_handle.try_state::<Arc<PtyManager>>()
                .ok_or_else(|| "PtyManager state not registered in Tauri app context".to_string())?;

            let probe = if let Some(instance) = pty_manager.get(&terminal_id) {
                let alive = {
                    let mut child_guard = instance.child.lock().await;
                    if let Some(child) = child_guard.as_mut() {
                        match child.try_wait() {
                            Ok(None) => true,
                            Ok(Some(_)) => false,
                            Err(_) => false,
                        }
                    } else {
                        false
                    }
                };

                serde_json::json!({
                    "exists": true,
                    "alive": alive,
                    "cwd": instance.cwd,
                    "shell": instance.shell,
                    "pid": instance.pid,
                    "cols": *instance.cols.read(),
                    "rows": *instance.rows.read()
                })
            } else {
                serde_json::json!({
                    "exists": false,
                    "alive": false
                })
            };

            Ok(IpcResult::success(probe))
        }
        "terminal_list" => {
            let pty_manager = app_handle.try_state::<Arc<PtyManager>>()
                .ok_or_else(|| "PtyManager state not registered in Tauri app context".to_string())?;

            let active_terminals = pty_manager.get_active_terminals();
            Ok(IpcResult::success(serde_json::to_value(&active_terminals).map_err(|e| e.to_string())?))
        }
        "terminal_get_git_branch" => {
            let params = params.ok_or("Missing params")?;
            let terminal_id: String = serde_json::from_value(params["terminalId"].clone())
                .map_err(|e| format!("Invalid terminalId: {}", e))?;

            let git_tracker = app_handle.state::<Arc<GitTracker>>();
            let branch = git_tracker.get_branch(&terminal_id);
            Ok(IpcResult::success(serde_json::to_value(&branch).map_err(|e| e.to_string())?))
        }
        "terminal_get_git_status" => {
            let params = params.ok_or("Missing params")?;
            let terminal_id: String = serde_json::from_value(params["terminalId"].clone())
                .map_err(|e| format!("Invalid terminalId: {}", e))?;

            let git_tracker = app_handle.state::<Arc<GitTracker>>();
            let status = git_tracker.get_status(&terminal_id);
            Ok(IpcResult::success(serde_json::to_value(&status).map_err(|e| e.to_string())?))
        }
        "terminal_get_exit_code" => {
            let params = params.ok_or("Missing params")?;
            let terminal_id: String = serde_json::from_value(params["terminalId"].clone())
                .map_err(|e| format!("Invalid terminalId: {}", e))?;

            let exit_code_tracker = app_handle.state::<Arc<ExitCodeTracker>>();
            let exit_code = exit_code_tracker.get_exit_code(&terminal_id);
            Ok(IpcResult::success(serde_json::to_value(exit_code).map_err(|e| e.to_string())?))
        }
        "terminal_clipboard_write" => {
            let params = params.ok_or("Missing params")?;
            let text: String = serde_json::from_value(params["text"].clone())
                .map_err(|e| format!("Invalid text: {}", e))?;

            use tauri_plugin_clipboard_manager::ClipboardExt;
            match app_handle.clipboard().write_text(&text) {
                Ok(()) => Ok(IpcResult::success(serde_json::json!(null))),
                Err(e) => Ok(IpcResult::error(e.to_string(), "CLIPBOARD_WRITE_FAILED")),
            }
        }
        "terminal_clipboard_read" => {
            use tauri_plugin_clipboard_manager::ClipboardExt;
            match app_handle.clipboard().read_text() {
                Ok(text) => Ok(IpcResult::success(serde_json::json!({ "text": text }))),
                Err(e) => Ok(IpcResult::error(e.to_string(), "CLIPBOARD_READ_FAILED")),
            }
        }
        "read_directory" => {
            let params = params.ok_or("Missing params")?;
            let dir_path: String = serde_json::from_value(params["dirPath"].clone())
                .map_err(|e| format!("Invalid dirPath: {}", e))?;

            let active_project_path = {
                let proj = server.active_project.lock().await;
                proj.as_ref().map(|p| p.path.clone())
            };
            check_path_boundary(&dir_path, active_project_path.as_ref())?;

            let ignored = [
                "node_modules", ".git", ".next", ".cache", ".turbo", "dist", "build", ".output",
                ".nuxt", ".svelte-kit", "__pycache__", ".pytest_cache", "venv", ".env", "coverage", ".nyc_output"
            ];

            let mut entries = Vec::new();
            let read_dir = std::fs::read_dir(&dir_path)
                .map_err(|e| format!("Failed to read directory {}: {}", dir_path, e))?;

            for entry in read_dir.flatten() {
                let path = entry.path();
                let name = match path.file_name().and_then(|n| n.to_str()) {
                    Some(name) => name.to_string(),
                    None => continue,
                };
                if ignored.contains(&name.as_str()) {
                    continue;
                }

                let metadata = match entry.metadata() {
                    Ok(metadata) => metadata,
                    Err(_) => continue,
                };
                let is_dir = metadata.is_dir();
                let extension = if is_dir {
                    None
                } else {
                    path.extension().and_then(|ext| ext.to_str()).map(|ext| ext.to_string())
                };
                let modified_at = metadata.modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis() as u64)
                    .unwrap_or(0);

                entries.push(serde_json::json!({
                    "name": name,
                    "path": path.to_string_lossy().replace('\\', "/"),
                    "type": if is_dir { "directory" } else { "file" },
                    "extension": extension,
                    "size": metadata.len(),
                    "modifiedAt": modified_at
                }));
            }

            entries.sort_by(|a, b| {
                let a_type = a.get("type").and_then(|v| v.as_str()).unwrap_or("file");
                let b_type = b.get("type").and_then(|v| v.as_str()).unwrap_or("file");
                match (a_type, b_type) {
                    ("directory", "file") => std::cmp::Ordering::Less,
                    ("file", "directory") => std::cmp::Ordering::Greater,
                    _ => {
                        let a_name = a.get("name").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
                        let b_name = b.get("name").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
                        a_name.cmp(&b_name)
                    }
                }
            });

            Ok(IpcResult::success(serde_json::json!(entries)))
        }
        "read_file" => {
            let params = params.ok_or("Missing params")?;
            let file_path: String = serde_json::from_value(params["filePath"].clone())
                .map_err(|e| format!("Invalid filePath: {}", e))?;

            let active_project_path = {
                let proj = server.active_project.lock().await;
                proj.as_ref().map(|p| p.path.clone())
            };
            check_path_boundary(&file_path, active_project_path.as_ref())?;

            let content = std::fs::read_to_string(&file_path)
                .map_err(|e| format!("Failed to read file {}: {}", file_path, e))?;
            let metadata = std::fs::metadata(&file_path)
                .map_err(|e| format!("Failed to stat file: {}", e))?;

            Ok(IpcResult::success(serde_json::json!({
                "content": content,
                "size": metadata.len(),
                "modifiedAt": metadata.modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0)
            })))
        }
        "write_file" => {
            let params = params.ok_or("Missing params")?;
            let file_path: String = serde_json::from_value(params["filePath"].clone())
                .map_err(|e| format!("Invalid filePath: {}", e))?;
            let content: String = serde_json::from_value(params["content"].clone())
                .map_err(|e| format!("Invalid content: {}", e))?;

            let active_project_path = {
                let proj = server.active_project.lock().await;
                proj.as_ref().map(|p| p.path.clone())
            };
            check_path_boundary(&file_path, active_project_path.as_ref())?;

            std::fs::write(&file_path, &content)
                .map_err(|e| format!("Failed to write file {}: {}", file_path, e))?;
            Ok(IpcResult::success(serde_json::json!(true)))
        }
        "create_directory" => {
            let params = params.ok_or("Missing params")?;
            let dir_path: String = serde_json::from_value(params["dirPath"].clone())
                .map_err(|e| format!("Invalid dirPath: {}", e))?;

            let active_project_path = {
                let proj = server.active_project.lock().await;
                proj.as_ref().map(|p| p.path.clone())
            };
            check_path_boundary(&dir_path, active_project_path.as_ref())?;

            std::fs::create_dir_all(&dir_path)
                .map_err(|e| format!("Failed to create directory {}: {}", dir_path, e))?;
            Ok(IpcResult::success(serde_json::json!(true)))
        }
        "delete_path" => {
            let params = params.ok_or("Missing params")?;
            let target_path: String = serde_json::from_value(params["path"].clone())
                .map_err(|e| format!("Invalid path: {}", e))?;
            let is_dir: bool = params.get("isDir").and_then(|v| v.as_bool()).unwrap_or(false);

            let active_project_path = {
                let proj = server.active_project.lock().await;
                proj.as_ref().map(|p| p.path.clone())
            };
            check_path_boundary(&target_path, active_project_path.as_ref())?;

            if is_dir {
                std::fs::remove_dir_all(&target_path)
                    .map_err(|e| format!("Failed to remove directory {}: {}", target_path, e))?;
            } else {
                std::fs::remove_file(&target_path)
                    .map_err(|e| format!("Failed to delete file {}: {}", target_path, e))?;
            }
            Ok(IpcResult::success(serde_json::json!(true)))
        }
        "rename_path" => {
            let params = params.ok_or("Missing params")?;
            let old_path: String = serde_json::from_value(params["oldPath"].clone())
                .map_err(|e| format!("Invalid oldPath: {}", e))?;
            let new_path: String = serde_json::from_value(params["newPath"].clone())
                .map_err(|e| format!("Invalid newPath: {}", e))?;

            let active_project_path = {
                let proj = server.active_project.lock().await;
                proj.as_ref().map(|p| p.path.clone())
            };
            check_path_boundary(&old_path, active_project_path.as_ref())?;
            check_path_boundary(&new_path, active_project_path.as_ref())?;

            std::fs::rename(&old_path, &new_path)
                .map_err(|e| format!("Failed to rename {} -> {}: {}", old_path, new_path, e))?;
            Ok(IpcResult::success(serde_json::json!(true)))
        }
        "tunnel_start" => {
            let config = params.ok_or("Missing params")?;
            let tunnel_config: crate::tunnel::TunnelConfig =
                serde_json::from_value(config).map_err(|e| e.to_string())?;
            let result = crate::tunnel::tunnel_start(tunnel_config, app_handle.clone()).await?;
            Ok(IpcResult::success(serde_json::to_value(&result).map_err(|e| e.to_string())?))
        }
        "tunnel_stop" => {
            let params = params.ok_or("Missing params")?;
            let tunnel_id: String = serde_json::from_value(params["tunnelId"].clone())
                .map_err(|e| format!("Invalid tunnelId: {}", e))?;
            let result = crate::tunnel::tunnel_stop(tunnel_id, app_handle.clone()).await?;
            Ok(IpcResult::success(serde_json::to_value(&result).map_err(|e| e.to_string())?))
        }
        "tunnel_list" => {
            let result = crate::tunnel::tunnel_list().await?;
            Ok(IpcResult::success(serde_json::to_value(&result).map_err(|e| e.to_string())?))
        }
        "ws_get_audit_log" => {
            let audit_log = server.get_audit_log().await;
            Ok(IpcResult::success(serde_json::to_value(&audit_log).map_err(|e| e.to_string())?))
        }
        "ws_rotate_token" => {
            let new_token = server.rotate_token().await;
            Ok(IpcResult::success(serde_json::json!({ "token": new_token })))
        }
        "get_projects" => {
            let projs = server.projects.lock().await;
            let active_proj = server.active_project.lock().await;

            let mut active_id = String::new();
            if let Some(ap) = &*active_proj {
                for p in projs.iter() {
                    if p.name == ap.name && p.path == Some(ap.path.clone()) {
                        active_id = p.id.clone();
                        break;
                    }
                }
            }

            Ok(IpcResult::success(serde_json::json!({
                "projects": *projs,
                "activeProjectId": if active_id.is_empty() { None } else { Some(active_id) }
            })))
        }
        "set_active_project" => {
            let params = params.ok_or("Missing params")?;
            let project_id: String = serde_json::from_value(params["projectId"].clone())
                .map_err(|e| format!("Invalid projectId: {}", e))?;

            let projs = server.projects.lock().await;
            if let Some(proj) = projs.iter().find(|p| p.id == project_id) {
                server.set_active_project(
                    proj.name.clone(),
                    proj.path.clone().unwrap_or_default(),
                    None,
                    Some(proj.color.clone()),
                ).await;

                use tauri::Emitter;
                let _ = app_handle.emit("ws-active-project-changed", serde_json::json!({
                    "projectId": project_id
                }));

                let _ = server.event_tx.send(WsOutbound::Event {
                    event: "projects-changed".to_string(),
                    payload: Some(serde_json::json!({
                        "projects": *projs,
                        "activeProjectId": Some(project_id.clone()),
                    })),
                });

                Ok(IpcResult::success(serde_json::json!(true)))
            } else {
                Ok(IpcResult::error(format!("Project not found: {}", project_id), "PROJECT_NOT_FOUND"))
            }
        }
        "detect_shells" => {
            match crate::detect_shells_inner() {
                Ok(shells) => Ok(IpcResult::success(serde_json::to_value(&shells).map_err(|e| e.to_string())?)),
                Err(e) => Ok(IpcResult::error(e, "DETECT_SHELLS_FAILED")),
            }
        }
        "get_home_directory" => {
            match crate::get_home_directory_inner() {
                Ok(path) => Ok(IpcResult::success(serde_json::to_value(&path).map_err(|e| e.to_string())?)),
                Err(e) => Ok(IpcResult::error(e, "GET_HOME_DIRECTORY_FAILED")),
            }
        }
        other => {
            Ok(IpcResult::error(format!("Unknown method: {}", other), "METHOD_NOT_FOUND"))
        }
    }
}
