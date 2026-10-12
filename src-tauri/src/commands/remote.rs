use super::{HostAcpCatalogStore, HostAcpInstallStore, HostWorkspaceManifestStore, IpcResult};
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
    workspace_manifest_store: State<'_, HostWorkspaceManifestStore>,
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
    // CAP-5: thread the desktop's `WorkspaceManifestService` (opened under
    // `<app_data_dir>/workspace-manifests` in `lib.rs`) through to
    // `serve_router` so the web/remote client can read/write a project's
    // manifest through the three `/workspace/*` routes. `None` degrades to
    // fresh-only mode (no host store attached).
    let workspace_manifest = workspace_manifest_store.store().map(Arc::clone);
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
            workspace_manifest,
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
/// NOT killed — they survive a shared-live toggle-off. The in-memory project
/// registry is cleared (it lives only while the server runs — Epic-4 bridge).
#[tauri::command]
pub async fn remote_server_stop(
    remote_state: State<'_, Arc<remote::RemoteServerState>>,
    project_registry: State<'_, Arc<crate::web::ProjectRegistry>>,
) -> Result<IpcResult<remote::RemoteStatus>, String> {
    let result = remote_state.stop().await;
    // Clear the in-memory project mirror so a stale list does not linger after
    // the server is off (the registry is renderer-fed; it is repopulated on the
    // next server start via `remote_sync_projects`).
    project_registry.clear();
    match result {
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

/// Push the desktop renderer's current project list into the in-memory
/// `ProjectRegistry` (Epic-4 bridge) and broadcast a `projects_changed` WS event
/// so connected web clients refetch `GET /projects`. Called by the renderer
/// on server-start success + on every project-store mutation while the server
/// runs. No env-var values cross the wire — `ProjectSummary` redacts-by-omission.
///
/// Desktop navigation does not move the host default: the payload carries no
/// `defaultProjectId`. The registry keeps the project the summaries flag as
/// stored default (`isDefault`, set by the explicit set-default action), else
/// its current default while that project is still switchable, else the first
/// switchable project so the host always has a default to bridge MCP files to.
/// The sync only mirrors the list — it rebinds nothing.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProjectsPayload {
    pub projects: Vec<crate::web::ProjectSummary>,
}

/// The default a project-list sync keeps: the summary flagged `is_default`,
/// else `current` while it is still a switchable project in `projects`, else
/// the first switchable project.
pub(super) fn default_after_sync(
    projects: &[crate::web::ProjectSummary],
    current: Option<&str>,
) -> Option<String> {
    let switchable = |p: &crate::web::ProjectSummary| {
        !p.is_archived && p.path.as_deref().is_some_and(|path| !path.trim().is_empty())
    };
    projects
        .iter()
        .find(|p| p.is_default && switchable(p))
        .or_else(|| projects.iter().find(|p| Some(p.id.as_str()) == current && switchable(p)))
        .or_else(|| projects.iter().find(|p| switchable(p)))
        .map(|p| p.id.clone())
}

#[tauri::command]
pub async fn remote_sync_projects(
    payload: SyncProjectsPayload,
    project_registry: State<'_, Arc<crate::web::ProjectRegistry>>,
    ws_relay: State<'_, Arc<crate::web::WsRelaySink>>,
) -> Result<IpcResult<()>, String> {
    let current = project_registry.snapshot().default_project_id;
    let default_id = default_after_sync(&payload.projects, current.as_deref());
    project_registry.set(payload.projects, default_id.clone());
    crate::web::broadcast_projects_changed(ws_relay.inner(), default_id.as_deref());
    Ok(IpcResult::success(()))
}

/// Explicitly set the host's default project (Epic 7 — cross-client
/// workspace continuity). Distinct from a per-connection `switch_project`:
/// this changes the host default that new web clients start with. Validates
/// the project is switchable, updates `registry.set_default_project`, and
/// broadcasts `projects_changed` to all connected web clients. Desktop-hosted
/// mode has no `FileProjectRegistry` (the file registry is VPS-only). This is
/// the only desktop path that moves the host default; it stores the default
/// and rebinds nothing.
#[tauri::command]
pub async fn set_host_default_project(
    project_id: String,
    project_registry: State<'_, Arc<crate::web::ProjectRegistry>>,
    ws_relay: State<'_, Arc<crate::web::WsRelaySink>>,
) -> Result<IpcResult<()>, String> {
    // Validate via switch_context (unknown/archived/pathless → NOT_FOUND).
    if project_registry.switch_context(&project_id).is_none() {
        log::warn!(
            "set_host_default_project: project '{}' not found or not switchable",
            project_id
        );
        return Ok(IpcResult::error(
            format!("project '{project_id}' not found or not switchable"),
            "NOT_FOUND",
        ));
    }
    if !project_registry.set_default_project(&project_id) {
        log::warn!(
            "set_host_default_project: project '{}' became unavailable before commit",
            project_id
        );
        return Ok(IpcResult::error(
            "target project became unavailable before commit".to_string(),
            "NOT_FOUND",
        ));
    }
    crate::web::broadcast_projects_changed(ws_relay.inner(), Some(&project_id));
    log::info!(
        "set_host_default_project: host default updated to '{}' + broadcast",
        project_id
    );
    Ok(IpcResult::success(()))
}

/// Compatibility refresh command for older renderer callers.
///
/// Durable desktop history is owned by `acp_history_*`; this command retains
/// the old invoke shape but only broadcasts `chat_history_changed`.
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
    crate::web::broadcast_chat_history_changed(ws_relay.inner());
    Ok(IpcResult::success(()))
}

/// Mirror the desktop app-store MCP registry to the host default project's
/// `.termul/mcp-servers.json` (CAP-7 — registry sync gap; interim bridge until
/// per-project MCP naming).
///
/// Desktop MCP servers live in `termul-data.json["acp/mcp-servers"]`
/// (tauri-plugin-store, app-data dir), while the web `GET /mcp-servers` route
/// reads `{default_project_root}/.termul/mcp-servers.json`. Without this bridge the web
/// route never sees desktop-configured servers, so `McpBadge` stays hidden on
/// web/mobile. Called best-effort after every desktop MCP save and when the
/// host default project changes — a sync failure is logged but never blocks the app-store save.
///
/// Resolves the root via the same chain `RemoteServerState::start`
/// uses: the registry's default-project path (canonicalized), falling back to
/// `default_project_root()` (`$TERMUL_PROJECT_ROOT` / `$HOME`) when the
/// registry has no default (server stopped / never started). The write reuses
/// `mcp_servers_api::registry_path` + `atomic_file::replace` so the sync writes
/// the exact file the web route reads.
#[tauri::command]
pub async fn remote_sync_mcp_registry(
    registry: serde_json::Value,
    project_registry: State<'_, Arc<crate::web::ProjectRegistry>>,
) -> Result<IpcResult<()>, String> {
    Ok(sync_mcp_registry_to_project_file(project_registry.inner(), registry).await)
}

/// Testable core of `remote_sync_mcp_registry`: writes `registry` to
/// `{default_project_root}/.termul/mcp-servers.json` via `atomic_file::replace`.
/// Extracted so a Rust unit test can exercise the write path without a Tauri
/// `AppHandle` (CAP-7 regression guard).
pub(crate) async fn sync_mcp_registry_to_project_file(
    project_registry: &crate::web::ProjectRegistry,
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

    // Resolve the active project root (same chain as `RemoteServerState::start`):
    // registry default → canonicalize; else `default_project_root()` → canonicalize.
    // A present-but-invalid default path returns an error rather than silently
    // falling back to the home directory (which the web route never reads).
    let project_root = match project_registry.default_project_path() {
        Some(p) => {
            match crate::web::config::resolve_and_validate_project_root(std::path::Path::new(&p)) {
                Ok(root) => root,
                Err(e) => {
                    log::error!(
                        "remote_sync_mcp_registry: default project path '{}' \
                     failed canonicalization: {}",
                        p,
                        e
                    );
                    return IpcResult::error(
                        "No active project root available for MCP registry sync",
                        "NO_ACTIVE_PROJECT_ROOT",
                    );
                }
            }
        }
        None => {
            log::warn!(
                "remote_sync_mcp_registry: no active project path in registry; \
                 falling back to default_project_root"
            );
            match crate::web::config::default_project_root() {
                Some(raw) => match crate::web::config::resolve_and_validate_project_root(&raw) {
                    Ok(root) => root,
                    Err(e) => {
                        log::error!(
                            "remote_sync_mcp_registry: default project root '{}' \
                             failed canonicalization: {}",
                            raw.display(),
                            e
                        );
                        return IpcResult::error(
                            "No active project root available for MCP registry sync",
                            "NO_ACTIVE_PROJECT_ROOT",
                        );
                    }
                },
                None => {
                    log::error!(
                        "remote_sync_mcp_registry: no active project root and \
                         default_project_root unavailable"
                    );
                    return IpcResult::error(
                        "No active project root available for MCP registry sync",
                        "NO_ACTIVE_PROJECT_ROOT",
                    );
                }
            }
        }
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
