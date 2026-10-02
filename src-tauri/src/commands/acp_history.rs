use super::IpcResult;
use std::sync::Arc;
use tauri::State;

/// Host-owned durable history state (CAP-2). `None` when the desktop could not
/// open `SessionPersistence` at startup (degraded live-only mode); commands
/// must treat absence as empty history, never crash.
#[derive(Default)]
pub struct HostHistoryStore(pub Option<Arc<crate::acp::SessionPersistence>>);

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatHistoryList {
    pub sessions: Vec<crate::acp::ChatHistoryIndexEntry>,
    pub legacy_import_complete: bool,
}

pub(crate) fn host_entry_to_desktop(
    entry: crate::acp::SessionIndexEntry,
) -> crate::acp::ChatHistoryIndexEntry {
    crate::acp::ChatHistoryIndexEntry {
        id: entry.session_id,
        agent_id: entry.runtime_agent_id.unwrap_or_default(),
        // The renderer maps `config:<id>` namespaces back to the bare config
        // id; anything else (absent or unprefixed) omits the key.
        agent_config_id: entry
            .stable_agent_namespace
            .as_deref()
            .and_then(|namespace| namespace.strip_prefix("config:"))
            .map(str::to_string),
        title: entry.title.unwrap_or_else(|| "Untitled Chat".to_string()),
        cwd: entry.cwd,
        project_id: entry.project_id.unwrap_or_default(),
        created_at: entry.created_at,
        last_activity_at: entry.last_activity_at,
        message_count: entry.message_count,
        status: match entry.status {
            crate::acp::PersistedSessionStatus::Active => crate::acp::ChatHistoryStatus::Active,
            crate::acp::PersistedSessionStatus::Error => crate::acp::ChatHistoryStatus::Error,
            crate::acp::PersistedSessionStatus::Closed => crate::acp::ChatHistoryStatus::Closed,
        },
        discovered: entry.discovered,
        worktree_path: entry.worktree_path,
        worktree_branch: entry.worktree_branch,
    }
}

#[tauri::command]
pub async fn acp_history_list(
    host: State<'_, HostHistoryStore>,
    store: State<'_, Arc<crate::acp::ChatHistoryStore>>,
) -> Result<IpcResult<DesktopChatHistoryList>, String> {
    log::info!("[acp-history] list start");
    // The legacy flag still gates the renderer's one-time KV wipe migration;
    // the session list itself is host-owned now.
    let legacy_import_complete = store.list().1;
    let sessions = match &host.0 {
        Some(persistence) => persistence
            .list_sessions()
            .into_iter()
            .map(host_entry_to_desktop)
            .collect(),
        None => Vec::new(),
    };
    log::info!("[acp-history] list success sessions={}", sessions.len());
    Ok(IpcResult::success(DesktopChatHistoryList {
        sessions,
        legacy_import_complete,
    }))
}

#[tauri::command]
pub async fn acp_history_get(
    session_id: String,
    host: State<'_, HostHistoryStore>,
) -> Result<IpcResult<Option<serde_json::Value>>, String> {
    let log_session_id = crate::logging::redact_session_id(&session_id);
    log::info!("[acp-history] get start session_id={}", log_session_id);
    let Some(persistence) = host.0.as_ref().map(Arc::clone) else {
        log::info!("[acp-history] get not_found session_id={}", log_session_id);
        return Ok(IpcResult::success(None));
    };
    match persistence.session_payload_async(&session_id).await {
        Ok(payload) => {
            log::info!("[acp-history] get success session_id={}", log_session_id);
            let value = serde_json::to_value(&payload).map_err(|error| error.to_string())?;
            Ok(IpcResult::success(Some(value)))
        }
        Err(crate::acp::SessionPersistenceError::SessionNotFound) => {
            log::info!("[acp-history] get not_found session_id={}", log_session_id);
            Ok(IpcResult::success(None))
        }
        Err(error) => {
            log::error!(
                "[acp-history] get failure session_id={} error={}",
                log_session_id,
                error
            );
            Ok(IpcResult::error(
                error.to_string(),
                "ACP_HISTORY_GET_FAILED",
            ))
        }
    }
}

/// Tail-first variant of [`acp_history_get`]: fetches only the last `limit`
/// messages + matching tool calls so the renderer can install the recent
/// transcript immediately and lazy-load the full payload on scroll-up.
/// `limit` is clamped to `[1, 500]` (defensive bounds — the live window is
/// 300, and a tail fetch larger than the full payload is pointless).
/// Mirrors `acp_history_get` but calls `session_payload_tail_async`.
#[tauri::command]
pub async fn acp_history_get_tail(
    session_id: String,
    limit: Option<u32>,
    host: State<'_, HostHistoryStore>,
) -> Result<IpcResult<Option<serde_json::Value>>, String> {
    let log_session_id = crate::logging::redact_session_id(&session_id);
    let limit = limit.unwrap_or(50).clamp(1, 500) as usize;
    log::info!(
        "[acp-history] get_tail start session_id={} limit={}",
        log_session_id,
        limit
    );
    let Some(persistence) = host.0.as_ref().map(Arc::clone) else {
        log::info!(
            "[acp-history] get_tail not_found session_id={}",
            log_session_id
        );
        return Ok(IpcResult::success(None));
    };
    match persistence
        .session_payload_tail_async(&session_id, limit)
        .await
    {
        Ok(payload) => {
            log::info!(
                "[acp-history] get_tail success session_id={} messages={}",
                log_session_id,
                payload.messages.len()
            );
            let value = serde_json::to_value(&payload).map_err(|error| error.to_string())?;
            Ok(IpcResult::success(Some(value)))
        }
        Err(crate::acp::SessionPersistenceError::SessionNotFound) => {
            log::info!(
                "[acp-history] get_tail not_found session_id={}",
                log_session_id
            );
            Ok(IpcResult::success(None))
        }
        Err(error) => {
            log::error!(
                "[acp-history] get_tail failure session_id={} error={}",
                log_session_id,
                error
            );
            Ok(IpcResult::error(
                error.to_string(),
                "ACP_HISTORY_GET_FAILED",
            ))
        }
    }
}

/// Legacy write path (renderer wipe-migration only). Live sessions are authored
/// by the host event/session layer and never flow through this command. The
/// payload lands in the legacy `ChatHistoryStore`; the incremental host import
/// then converges it into `SessionPersistence` so the host-owned `list`/`get`
/// read back exactly what was just saved (read-your-writes for the migration).
#[tauri::command]
pub async fn acp_history_save(
    session_id: String,
    payload: serde_json::Value,
    store: State<'_, Arc<crate::acp::ChatHistoryStore>>,
    host: State<'_, HostHistoryStore>,
    ws_relay: State<'_, Arc<crate::web::WsRelaySink>>,
) -> Result<IpcResult<()>, String> {
    let log_session_id = crate::logging::redact_session_id(&session_id);
    log::info!("[acp-history] save start session_id={}", log_session_id);
    let task_store = store.inner().clone();
    let task_id = session_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || task_store.save(&task_id, payload))
        .await
        .map_err(|error| error.to_string())?;
    match result {
        Ok(()) => {
            if let Some(persistence) = &host.0 {
                crate::acp::import_chat_history(persistence, store.inner()).await;
            }
            crate::web::broadcast_chat_history_changed(ws_relay.inner());
            log::info!("[acp-history] save success session_id={}", log_session_id);
            Ok(IpcResult::success(()))
        }
        Err(error) => {
            log::error!(
                "[acp-history] save failure session_id={} error={}",
                log_session_id,
                error
            );
            Ok(IpcResult::error(
                error.to_string(),
                "ACP_HISTORY_SAVE_FAILED",
            ))
        }
    }
}

#[tauri::command]
pub async fn acp_history_delete(
    session_id: String,
    host: State<'_, HostHistoryStore>,
    ws_relay: State<'_, Arc<crate::web::WsRelaySink>>,
) -> Result<IpcResult<bool>, String> {
    let log_session_id = crate::logging::redact_session_id(&session_id);
    log::info!("[acp-history] delete start session_id={}", log_session_id);
    match &host.0 {
        Some(persistence) => match persistence.delete_session(&session_id).await {
            Ok(()) => {
                crate::web::broadcast_chat_history_changed(ws_relay.inner());
                log::info!("[acp-history] delete success session_id={}", log_session_id);
                Ok(IpcResult::success(true))
            }
            Err(crate::acp::SessionPersistenceError::SessionNotFound) => {
                // Typed idempotent delete: the record is already gone — the
                // desired end state holds, reported as `data: false` so the
                // renderer never string-sniffs errors. A queued renderer
                // delete retrying a completion race must not spin error logs
                // (QA: repeated "delete failure … persisted session not
                // found").
                log::info!(
                    "[acp-history] delete not_found session_id={} (already absent)",
                    log_session_id
                );
                crate::web::broadcast_chat_history_changed(ws_relay.inner());
                Ok(IpcResult::success(false))
            }
            Err(error) => {
                log::error!(
                    "[acp-history] delete failure session_id={} error={}",
                    log_session_id,
                    error
                );
                Ok(IpcResult::error(
                    error.to_string(),
                    "ACP_HISTORY_DELETE_FAILED",
                ))
            }
        },
        // Degraded live-only mode: there is no durable history to delete, so
        // no record was deleted.
        None => Ok(IpcResult::success(false)),
    }
}

#[tauri::command]
pub async fn acp_history_flush(
    store: State<'_, Arc<crate::acp::ChatHistoryStore>>,
) -> Result<IpcResult<()>, String> {
    log::info!("[acp-history] flush start");
    let task_store = store.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || task_store.flush())
        .await
        .map_err(|error| error.to_string())?;
    match result {
        Ok(()) => {
            log::info!("[acp-history] flush success");
            Ok(IpcResult::success(()))
        }
        Err(error) => {
            log::error!("[acp-history] flush failure error={}", error);
            Ok(IpcResult::error(
                error.to_string(),
                "ACP_HISTORY_FLUSH_FAILED",
            ))
        }
    }
}

#[tauri::command]
pub async fn acp_history_mark_legacy_import_complete(
    store: State<'_, Arc<crate::acp::ChatHistoryStore>>,
    host: State<'_, HostHistoryStore>,
    ws_relay: State<'_, Arc<crate::web::WsRelaySink>>,
) -> Result<IpcResult<()>, String> {
    log::info!("[acp-history] legacy marker start");
    let task_store = store.inner().clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || task_store.mark_legacy_import_complete())
            .await
            .map_err(|error| error.to_string())?;
    match result {
        Ok(()) => {
            // The wipe migration may just have written new legacy entries;
            // converge the host store incrementally (idempotent).
            if let Some(persistence) = &host.0 {
                let imported = crate::acp::import_chat_history(persistence, store.inner()).await;
                if imported > 0 {
                    crate::web::broadcast_chat_history_changed(ws_relay.inner());
                }
            }
            log::info!("[acp-history] legacy marker success");
            Ok(IpcResult::success(()))
        }
        Err(error) => {
            log::error!("[acp-history] legacy marker failure error={}", error);
            Ok(IpcResult::error(
                error.to_string(),
                "ACP_HISTORY_MIGRATION_FAILED",
            ))
        }
    }
}

/// Legacy-store read used ONLY by the renderer's one-time KV wipe migration,
/// which must read back exactly what it wrote to the legacy
/// `ChatHistoryStore` (byte-for-byte verification). Live history reads use the
/// host-owned `acp_history_list` / `acp_history_get` instead.
#[tauri::command]
pub async fn acp_history_list_legacy(
    store: State<'_, Arc<crate::acp::ChatHistoryStore>>,
) -> Result<IpcResult<DesktopChatHistoryList>, String> {
    let (sessions, legacy_import_complete) = store.list();
    Ok(IpcResult::success(DesktopChatHistoryList {
        sessions,
        legacy_import_complete,
    }))
}

/// Legacy-store payload read for the wipe migration (see `acp_history_list_legacy`).
#[tauri::command]
pub async fn acp_history_get_legacy(
    session_id: String,
    store: State<'_, Arc<crate::acp::ChatHistoryStore>>,
) -> Result<IpcResult<Option<serde_json::Value>>, String> {
    let task_store = store.inner().clone();
    let task_id = session_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || task_store.get(&task_id))
        .await
        .map_err(|error| error.to_string())?;
    match result {
        Ok(payload) => Ok(IpcResult::success(Some(payload))),
        Err(crate::acp::ChatHistoryStoreError::SessionNotFound) => Ok(IpcResult::success(None)),
        Err(error) => Ok(IpcResult::error(
            error.to_string(),
            "ACP_HISTORY_GET_FAILED",
        )),
    }
}
