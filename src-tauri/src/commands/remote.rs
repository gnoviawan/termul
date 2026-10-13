use super::{HostAcpCatalogStore, HostAcpInstallStore, IpcResult};
use crate::pty::PtyManager;
use crate::remote;
use std::sync::Arc;
use tauri::State;

// ==================== Remote Server Commands ====================

/// Start the desktop-hosted shared-live web server.
///
/// Shares the desktop's live `AcpManager` sessions with a phone/browser client.
///
/// Starts the in-process localhost web server (the same one the standalone
/// `termul-server` binary uses), then brings up a built-in cloudflared
/// quick-tunnel so the phone can reach it on any network — the popover renders
/// the ephemeral `https://*.trycloudflare.com` URL as a QR. The `bind_mode`
/// param is accepted for API stability but ignored (the tunnel targets
/// localhost). The tunnel is always started right after the server binds, so
/// the shared-live host is always token-gated (AD-3): the bearer token is
/// required on HTTP, `/ws` and `/terminal/ws`, and the URL in the status
/// (QR / copy link) carries it in the `#token=` fragment. The desktop's single
/// web store (`shared_live_data`) is reused across stop/start cycles.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn remote_server_start(
    acp_manager: State<'_, Arc<crate::acp::AcpManager>>,
    pty_manager: State<'_, Arc<PtyManager>>,
    ws_relay: State<'_, Arc<crate::web::WsRelaySink>>,
    remote_state: State<'_, Arc<remote::RemoteServerState>>,
    project_registry: State<'_, Arc<crate::web::ProjectRegistry>>,
    acp_catalog_store: State<'_, HostAcpCatalogStore>,
    acp_install_store: State<'_, HostAcpInstallStore>,
    shared_live_data: State<'_, remote::SharedLiveData>,
    bind_mode: Option<String>,
) -> Result<IpcResult<remote::RemoteStatus>, String> {
    // Default to localhost only when the caller omits the bind mode; an
    // explicit-but-unrecognized value (e.g. a typo of "all") is an error — do
    // not silently downgrade to localhost (the phone would silently fail to
    // connect).
    let bind_mode = match bind_mode.as_deref() {
        None => remote::RemoteBindMode::Localhost,
        Some(s) => remote::RemoteBindMode::parse(s)
            .ok_or_else(|| format!("invalid bind mode '{s}': use 'localhost' or 'all'",))?,
    };
    // CAP-6 / Story 8: thread the desktop's `AcpCatalogService` (opened under
    // `<app_data_dir>/acp-catalog` in `lib.rs`) through to `serve_router` so
    // the web/remote client can resolve the catalog through `GET /acp/catalog`
    // + WS `list_acp_catalog`. `None` degrades to `ACP_CATALOG_UNAVAILABLE`.
    let acp_catalog = acp_catalog_store.store().map(Arc::clone);
    // CAP-6 / Story 9: thread the desktop's `AcpInstallService` (opened under
    // `<app_data_dir>/acp-registry-binaries` in `lib.rs`) through to
    // `serve_router` so the web/remote client can install through
    // `POST /acp/install` + WS `install_acp_agent`. `None` degrades to
    // `ACP_INSTALL_UNAVAILABLE`.
    let acp_install = acp_install_store.store().map(Arc::clone);
    let started = remote_state
        .start(
            acp_manager.inner().clone(),
            pty_manager.inner().clone(),
            ws_relay.inner().clone(),
            project_registry.inner().clone(),
            bind_mode,
            // The cloudflared tunnel starts right after the bind below, so the
            // host must be token-gated from the first request.
            true,
            shared_live_data.inner(),
            acp_catalog,
            acp_install,
        )
        .await;
    match started {
        Ok(status) => {
            // Server is up on localhost. Bring up the cloudflared quick-tunnel so
            // the phone can reach it on any network — the QR encodes the resulting
            // ephemeral HTTPS URL (edge TLS via cloudflared) plus the bearer token.
            // On tunnel failure, drain the server and surface the error so the
            // popover never holds a localhost-only server + a stale toggle.
            let port = match status.port {
                Some(p) => p,
                None => {
                    return Ok(IpcResult::error(
                        "started remote server reported no port".to_string(),
                        "REMOTE_START_FAILED",
                    ))
                }
            };
            match remote::cloudflared::start_quick_tunnel(port).await {
                Ok(tunnel) => {
                    // Clone the URL before attach consumes it, so the background
                    // probe can log reachability without blocking the QR.
                    let probe_url = tunnel.url.clone();
                    if let Err(e) = remote_state.attach_tunnel(tunnel.url, tunnel.child) {
                        // Server stopped between start and attach; attach already
                        // killed the orphan child. Surface the error.
                        return Ok(IpcResult::error(e, "REMOTE_TUNNEL_FAILED"));
                    }
                    // Best-effort reachability probe in the background — logs
                    // whether the edge routes to the origin. Non-blocking so the
                    // QR appears immediately; never hides the QR on probe timeout
                    // (a slow edge / cold start must not block the connect UI).
                    tokio::spawn(remote::cloudflared::log_tunnel_reachability(probe_url));
                    Ok(IpcResult::success(remote_state.status()))
                }
                Err(e) => {
                    let _ = remote_state.stop().await;
                    Ok(IpcResult::error(e, "REMOTE_TUNNEL_FAILED"))
                }
            }
        }
        Err(e) => Ok(IpcResult::error(e, "REMOTE_START_FAILED")),
    }
}

/// Stop the desktop-hosted web server.
///
/// Signals graceful shutdown to the serve task. The desktop's live agents are
/// NOT killed — they survive a shared-live toggle-off. The durable project
/// registry is NOT cleared: it belongs to the desktop, not to the server, and
/// keeps serving the project list while shared-live is off.
#[tauri::command]
pub async fn remote_server_stop(
    remote_state: State<'_, Arc<remote::RemoteServerState>>,
) -> Result<IpcResult<remote::RemoteStatus>, String> {
    match remote_state.stop().await {
        Ok(status) => Ok(IpcResult::success(status)),
        Err(e) => Ok(IpcResult::error(e, "REMOTE_STOP_FAILED")),
    }
}

/// Get the desktop-hosted web server status.
#[tauri::command]
pub async fn remote_server_status(
    remote_state: State<'_, Arc<remote::RemoteServerState>>,
) -> Result<IpcResult<remote::RemoteStatus>, String> {
    Ok(IpcResult::success(remote_state.status()))
}

/// Push the desktop renderer's current project list into the durable
/// [`ProjectRegistry`] (written through to `projects.json`) and publish the new
/// state to every `projects` watcher. Called by the renderer on server-start
/// success + on every project-store mutation while it is still the writer
/// (transitional until it reads the registry through the projects watch). No
/// env-var values cross the wire — `ProjectSummary` redacts-by-omission.
///
/// Desktop navigation does not move the host default: the payload carries no
/// `defaultProjectId`. The registry keeps its CURRENT default while that
/// project is still switchable (so a default set from the web or by
/// `set_host_default_project` is never reverted by a later list mutation);
/// only when there is none does it take the project the summaries flag as
/// stored default (`isDefault`), else the first switchable project, so the
/// host always has a default to bridge MCP files to. The reply carries the
/// resulting default id so the renderer can tell when the effective default
/// changed. The sync only mirrors the list — it rebinds nothing.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProjectsPayload {
    pub projects: Vec<crate::web::ProjectSummary>,
}

/// The default a project-list sync keeps: `current` while it is still a
/// switchable project in `projects`, else the summary flagged `is_default`,
/// else the first switchable project.
pub(super) fn default_after_sync(
    projects: &[crate::web::ProjectSummary],
    current: Option<&str>,
) -> Option<String> {
    let switchable = |p: &crate::web::ProjectSummary| {
        !p.is_archived && p.path.as_deref().is_some_and(|path| !path.trim().is_empty())
    };
    projects
        .iter()
        .find(|p| Some(p.id.as_str()) == current && switchable(p))
        .or_else(|| projects.iter().find(|p| p.is_default && switchable(p)))
        .or_else(|| projects.iter().find(|p| switchable(p)))
        .map(|p| p.id.clone())
}

#[tauri::command]
pub async fn remote_sync_projects(
    payload: SyncProjectsPayload,
    project_registry: State<'_, Arc<crate::web::ProjectRegistry>>,
    ws_relay: State<'_, Arc<crate::web::WsRelaySink>>,
) -> Result<IpcResult<Option<String>>, String> {
    match crate::web::project_registry::replace_projects(
        project_registry.inner(),
        ws_relay.inner(),
        payload.projects,
        default_after_sync,
    ) {
        Ok(default_id) => Ok(IpcResult::success(default_id)),
        Err(error) => {
            log::error!("remote_sync_projects: {error}");
            Ok(IpcResult::error(error.message(), error.http_code()))
        }
    }
}

/// Explicitly set the host's default project (Epic 7 — cross-client
/// workspace continuity). Distinct from a per-connection `switch_project`:
/// this changes the host default that new web clients start with. Validates
/// the project is switchable, persists, and publishes the project state to
/// every `projects` watcher. This is the only desktop path that moves the host
/// default; it stores the default and rebinds nothing.
#[tauri::command]
pub async fn set_host_default_project(
    project_id: String,
    project_registry: State<'_, Arc<crate::web::ProjectRegistry>>,
    ws_relay: State<'_, Arc<crate::web::WsRelaySink>>,
) -> Result<IpcResult<()>, String> {
    match crate::web::project_registry::set_default_project(
        project_registry.inner(),
        ws_relay.inner(),
        &project_id,
    ) {
        Ok(()) => {
            log::info!("set_host_default_project: host default updated to '{project_id}'");
            Ok(IpcResult::success(()))
        }
        Err(error) => {
            log::warn!("set_host_default_project: project '{project_id}': {error}");
            Ok(IpcResult::error(error.message(), error.http_code()))
        }
    }
}

/// Payload of [`project_registry_import`].
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRegistryImportPayload {
    pub projects: Vec<crate::web::ProjectSummary>,
    #[serde(default)]
    pub default_project_id: Option<String>,
}

/// One-shot import of the renderer's old project list into the durable
/// registry (first launch after the upgrade). Allowed only while the registry
/// file says nothing was imported: ids not yet registered are added, existing
/// ids are kept (never overwritten), the default applies only when none is
/// set, and the registry is marked imported — durably, even for an empty list.
/// A repeat is an ok no-op replying `{ imported: false }`. The renderer deletes
/// its own `projects` key only after this acknowledges.
#[tauri::command]
pub async fn project_registry_import(
    payload: ProjectRegistryImportPayload,
    project_registry: State<'_, Arc<crate::web::ProjectRegistry>>,
    ws_relay: State<'_, Arc<crate::web::WsRelaySink>>,
) -> Result<IpcResult<crate::web::project_registry::ImportOutcome>, String> {
    match crate::web::project_registry::import_projects(
        project_registry.inner(),
        ws_relay.inner(),
        payload.projects,
        payload.default_project_id,
    ) {
        Ok(outcome) => Ok(IpcResult::success(outcome)),
        Err(error) => {
            log::error!("project_registry_import: {error}");
            Ok(IpcResult::error(error.message(), error.http_code()))
        }
    }
}

/// Compatibility refresh command for older renderer callers.
///
/// Durable desktop history is owned by `acp_history_*`; this command retains
/// the old invoke shape but only tells `chat_history` watchers the index changed.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct SyncChatHistoryPayload {
    /// The full session index (wire `PersistedSessionSummary[]` shape).
    /// `None` on a payload-only sync (the `useAcpHistorySync` hook owns the
    /// index push; `persistSession` pushes only its payload to avoid a
    /// double `set_index` + double broadcast per mutation).
    #[serde(default)]
    pub index: Option<Vec<crate::acp::SessionIndexEntry>>,
    /// Monotonic revision stamped by the renderer on each index push
    /// (`useAcpHistorySync` increments it; the seed in `RemoteAccessPopover`
    /// omits it → `0`). `set_index` rejects a push whose revision is strictly
    /// lower than the current one so a delayed older index cannot replace a
    /// newer snapshot. Absent on a payload-only sync (unused).
    #[serde(default)]
    pub revision: Option<u64>,
    /// Optional per-session payloads (`{ metadata, messages }`) — pushed lazily
    /// (only sessions the renderer has in memory). Omitted on an index-only sync.
    #[serde(default)]
    pub payloads: Option<std::collections::HashMap<String, serde_json::Value>>,
}

#[tauri::command]
pub async fn remote_sync_chat_history(
    payload: SyncChatHistoryPayload,
    ws_relay: State<'_, Arc<crate::web::WsRelaySink>>,
    remote_state: State<'_, Arc<remote::RemoteServerState>>,
) -> Result<IpcResult<()>, String> {
    // Defense in depth: the TS caller already gates on `running`, but the
    // server may have just been stopped (`remote_server_stop` clears the
    // cache). Early-return so a late push does not repopulate a cache that
    // was just cleared.
    if !remote_state.status().running {
        return Ok(IpcResult::success(()));
    }
    // Compatibility bridge only: durable desktop history is now written by
    // the dedicated `acp_history_*` commands. Existing callers may still use
    // this command to request a browser index refresh, but payload/index values
    // are deliberately not retained or cloned in Rust memory.
    let _ = payload;
    crate::web::watch::publish_chat_history(ws_relay.inner(), &[]);
    Ok(IpcResult::success(()))
}

/// Mirror the desktop app-store MCP registry to the named project's
/// `.termul/mcp-servers.json` (CAP-7 — registry sync gap).
///
/// Desktop MCP servers live in `termul-data.json["acp/mcp-servers"]`
/// (tauri-plugin-store, app-data dir), while the web `GET /mcp-servers?projectId=`
/// route reads `{project_root}/.termul/mcp-servers.json`. Without this bridge the web
/// route never sees desktop-configured servers, so `McpBadge` stays hidden on
/// web/mobile. Called best-effort after every desktop MCP save and when the
/// host default project changes — a sync failure is logged but never blocks the app-store save.
///
/// The caller names the project (`projectId`); its canonical root comes from the
/// durable registry (`canonical_root`), exactly like the web route — an unknown,
/// archived or pathless project is refused `NOT_FOUND`, never redirected to a
/// default or to the home directory. The write reuses
/// `mcp_servers_api::registry_path` + `atomic_file::replace` so the sync writes
/// the exact file the web route reads.
#[tauri::command]
pub async fn remote_sync_mcp_registry(
    project_id: String,
    registry: serde_json::Value,
    project_registry: State<'_, Arc<crate::web::ProjectRegistry>>,
) -> Result<IpcResult<()>, String> {
    Ok(sync_mcp_registry_to_project_file(project_registry.inner(), &project_id, registry).await)
}

/// Testable core of `remote_sync_mcp_registry`: writes `registry` to
/// `{project_root}/.termul/mcp-servers.json` via `atomic_file::replace`.
/// Extracted so a Rust unit test can exercise the write path without a Tauri
/// `AppHandle` (CAP-7 regression guard).
pub(crate) async fn sync_mcp_registry_to_project_file(
    project_registry: &crate::web::ProjectRegistry,
    project_id: &str,
    registry: serde_json::Value,
) -> IpcResult<()> {
    log::info!("remote_sync_mcp_registry: start");

    // Validate the payload is an array (mirrors `mcp_servers_api::put`).
    if !registry.is_array() {
        log::warn!("remote_sync_mcp_registry: rejected non-array payload");
        return IpcResult::error("MCP registry must be a JSON array", "MCP_REGISTRY_INVALID");
    }

    // Serialize + enforce the 1 MiB ceiling (mirrors `mcp_servers_api::put`).
    let bytes = match serde_json::to_vec(&registry) {
        Ok(bytes) if bytes.len() <= crate::web::mcp_servers_api::MAX_REGISTRY_BYTES => bytes,
        Ok(_) => {
            log::warn!("remote_sync_mcp_registry: rejected payload over 1 MiB");
            return IpcResult::error(
                "MCP registry exceeds the 1 MiB limit",
                "MCP_REGISTRY_TOO_LARGE",
            );
        }
        Err(_) => {
            log::warn!("remote_sync_mcp_registry: payload not serializable");
            return IpcResult::error("MCP registry is not serializable", "MCP_REGISTRY_INVALID");
        }
    };

    let Some(project_root) = crate::web::mcp_servers_api::project_root(project_registry, project_id)
    else {
        log::warn!(
            "remote_sync_mcp_registry: project '{project_id}' is unknown, archived or has no \
             usable path"
        );
        return IpcResult::error(
            crate::web::mcp_servers_api::PROJECT_NOT_FOUND_MESSAGE,
            crate::web::mcp_servers_api::PROJECT_NOT_FOUND_CODE,
        );
    };

    let path = crate::web::mcp_servers_api::registry_path(&project_root);
    let write_path = path.clone();
    let bytes_len = bytes.len();
    let write_result =
        tokio::task::spawn_blocking(move || crate::acp::atomic_file::replace(&write_path, &bytes))
            .await;
    match write_result {
        Ok(Ok(())) => {
            log::info!(
                "remote_sync_mcp_registry: success ({} bytes → {})",
                bytes_len,
                path.display()
            );
            IpcResult::success(())
        }
        Ok(Err(error)) => {
            log::error!(
                "remote_sync_mcp_registry: atomic write failed for {}: {}",
                path.display(),
                error
            );
            IpcResult::error("Failed to persist MCP registry", "MCP_REGISTRY_WRITE_ERROR")
        }
        Err(error) => {
            log::error!(
                "remote_sync_mcp_registry: write task panicked for {}: {}",
                path.display(),
                error
            );
            IpcResult::error("Failed to persist MCP registry", "MCP_REGISTRY_WRITE_ERROR")
        }
    }
}
