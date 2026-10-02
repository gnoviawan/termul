use super::{sanitize_log_field, IpcResult};
use std::sync::Arc;
use tauri::State;

// ============================================================================
// Workspace Manifest Commands (CAP-5 / Story 5)
// ============================================================================
//
// Host-owned versioned workspace manifests — one per project, atomically
// persisted, revision-checked. Conflict is a success-body variant of
// `WriteOutcome`, NOT an error code; serde `deny_unknown_fields` rejection
// (an over-serialized payload with `envVars` / raw `claim` /
// `fullscreenPaneId`) maps to `VALIDATION_ERROR`. Mirrors the three HTTP
// routes in `web/workspace_api.rs` byte-for-byte (camelCase `IpcResult<T>`).

/// Host-owned workspace-manifest state (CAP-5). `None` when the desktop could
/// not open `WorkspaceManifestService` at startup (degraded fresh-only mode);
/// commands must treat absence as an empty manifest, never crash.
///
/// Patch 12: the inner field is private (not `pub`) so callers cannot reach
/// the `Arc` directly — they go through [`Self::store`] (read) or
/// [`Self::new`] (construct). This keeps the access surface tight so a future
/// swap (e.g. a manager wrapper that owns the `Arc`) doesn't break every call
/// site.
#[derive(Default)]
pub struct HostWorkspaceManifestStore(Option<Arc<crate::acp::WorkspaceManifestService>>);

impl HostWorkspaceManifestStore {
    /// Construct from an already-opened `WorkspaceManifestService` (`None`
    /// for degraded fresh-only mode — the desktop could not open the store
    /// at startup).
    #[must_use]
    pub fn new(service: Option<Arc<crate::acp::WorkspaceManifestService>>) -> Self {
        Self(service)
    }

    /// Access the inner `WorkspaceManifestService` (`None` in degraded mode).
    /// Callers that need to clone the `Arc` should `.as_ref().map(Arc::clone)`.
    #[must_use]
    pub(crate) fn store(&self) -> Option<&Arc<crate::acp::WorkspaceManifestService>> {
        self.0.as_ref()
    }
}

/// Tauri state wrapper for the host-owned `AcpCatalogService` (CAP-6 / Story
/// 8). Mirrors `HostWorkspaceManifestStore`: `None` degrades to
/// `ACP_CATALOG_UNAVAILABLE` (the desktop could not open the catalog root at
/// startup). Held as `Option<Arc<…>>` so the desktop's degraded path is
/// graceful, not a boot failure.
#[derive(Default)]
pub struct HostAcpCatalogStore(Option<Arc<crate::acp::AcpCatalogService>>);

impl HostAcpCatalogStore {
    /// Construct from an already-opened `AcpCatalogService` (`None` for
    /// degraded mode — the desktop could not open the store at startup).
    #[must_use]
    pub fn new(service: Option<Arc<crate::acp::AcpCatalogService>>) -> Self {
        Self(service)
    }

    /// Access the inner `AcpCatalogService` (`None` in degraded mode).
    /// Callers that need to clone the `Arc` should `.as_ref().map(Arc::clone)`.
    #[must_use]
    pub(crate) fn store(&self) -> Option<&Arc<crate::acp::AcpCatalogService>> {
        self.0.as_ref()
    }
}

/// Tauri state wrapper for the host-owned `AcpInstallService` (CAP-6 / Story
/// 9). Mirrors `HostAcpCatalogStore`: `None` degrades to
/// `ACP_INSTALL_UNAVAILABLE` (the desktop could not open the install root at
/// startup). Held as `Option<Arc<…>>` so the desktop's degraded path is
/// graceful, not a boot failure.
#[derive(Default)]
pub struct HostAcpInstallStore(Option<Arc<crate::acp::install::AcpInstallService>>);

impl HostAcpInstallStore {
    /// Construct from an already-opened `AcpInstallService` (`None` for
    /// degraded mode — the desktop could not open the store at startup).
    #[must_use]
    pub fn new(service: Option<Arc<crate::acp::install::AcpInstallService>>) -> Self {
        Self(service)
    }

    /// Access the inner `AcpInstallService` (`None` in degraded mode).
    /// Callers that need to clone the `Arc` should `.as_ref().map(Arc::clone)`.
    #[must_use]
    pub(crate) fn store(&self) -> Option<&Arc<crate::acp::install::AcpInstallService>> {
        self.0.as_ref()
    }
}

/// `workspace_manifest_get(projectId)` — load a project's manifest. Returns
/// `IpcResult::success(None)` when no manifest exists (the success path — a
/// workspace reload starts fresh) OR when the host store is unavailable
/// (degraded mode). Mirrors `GET /workspace/:projectId` byte-for-byte.
#[tauri::command]
pub async fn workspace_manifest_get(
    project_id: String,
    store: State<'_, HostWorkspaceManifestStore>,
) -> Result<IpcResult<Option<crate::acp::WorkspaceManifest>>, String> {
    let log_project_id = sanitize_log_field(&project_id);
    log::info!(
        "[workspace-manifest] get start project_id={}",
        log_project_id
    );
    let Some(service) = store.store().map(Arc::clone) else {
        log::info!(
            "[workspace-manifest] get unavailable project_id={}",
            log_project_id
        );
        return Ok(IpcResult::success(None));
    };
    match service.load(&project_id).await {
        Ok(manifest) => {
            log::info!(
                "[workspace-manifest] get success project_id={} revision={}",
                log_project_id,
                manifest.as_ref().map_or(0, |m| m.revision)
            );
            Ok(IpcResult::success(manifest))
        }
        Err(error) => {
            log::error!(
                "[workspace-manifest] get failure project_id={} error={}",
                log_project_id,
                error
            );
            Ok(IpcResult::error(
                error.to_string(),
                "WORKSPACE_MANIFEST_GET_FAILED",
            ))
        }
    }
}

/// `workspace_manifest_write(projectId, basedRevision, manifest)` —
/// revision-checked write. The host compares `basedRevision` (null = initial
/// write) against the on-disk `revision`; on match → apply + increment +
/// persist + return `WriteOutcome::Updated`; on mismatch → return
/// `WriteOutcome::Conflict` WITHOUT mutating state. Conflict is a SUCCESS
/// body variant (NOT an error code) — the caller branches on the
/// `status` discriminator.
///
/// Patch 1: the `manifest` argument is `serde_json::Value` (not
/// `WorkspaceManifest`) so the manual deserialization inside the command
/// catches a `deny_unknown_fields` rejection (an excluded field like
/// `envVars` / raw `claim` / `fullscreenPaneId`) and maps it to
/// `IpcResult::error(VALIDATION_ERROR)` — BEFORE the service is reached, with
/// NO state change. If the argument were typed `WorkspaceManifest`, Tauri's
/// IPC deserialization layer would reject the payload before this command
/// body runs, surfacing as an `INVOKE_ERROR` (a thrown IPC error) instead of
/// the spec-required `VALIDATION_ERROR`.
#[tauri::command]
pub async fn workspace_manifest_write(
    project_id: String,
    based_revision: Option<u64>,
    manifest: serde_json::Value,
    store: State<'_, HostWorkspaceManifestStore>,
) -> Result<IpcResult<crate::acp::WriteOutcome>, String> {
    let log_project_id = sanitize_log_field(&project_id);
    log::info!(
        "[workspace-manifest] write start project_id={} based_revision={:?}",
        log_project_id,
        based_revision
    );
    // Patch 1: manual deserialization so a `deny_unknown_fields` rejection
    // (envVars / raw claim / fullscreenPaneId / agentLauncherPaneId) surfaces
    // as `IpcResult::error(VALIDATION_ERROR)` — NOT a thrown IPC error
    // (`INVOKE_ERROR`) that would mask the validation failure.
    let manifest: crate::acp::WorkspaceManifest = match serde_json::from_value(manifest) {
        Ok(m) => m,
        Err(error) => {
            log::warn!(
                "[workspace-manifest] write payload validation failed project_id={} error={}",
                log_project_id,
                error
            );
            return Ok(IpcResult::error(
                format!("payload validation failed: {error}"),
                "VALIDATION_ERROR",
            ));
        }
    };
    let Some(service) = store.store().map(Arc::clone) else {
        log::error!(
            "[workspace-manifest] write unavailable project_id={}",
            log_project_id
        );
        return Ok(IpcResult::error(
            "workspace manifest store is unavailable",
            "WORKSPACE_MANIFEST_UNAVAILABLE",
        ));
    };
    match service.write(&project_id, based_revision, manifest).await {
        Ok(outcome) => {
            // Boundary log emits project_id + revision + update_identity —
            // never the topology or claim. The service already logged it.
            Ok(IpcResult::success(outcome))
        }
        Err(error) => {
            log::error!(
                "[workspace-manifest] write failure project_id={} error={}",
                log_project_id,
                error
            );
            Ok(IpcResult::error(
                error.to_string(),
                "WORKSPACE_MANIFEST_WRITE_FAILED",
            ))
        }
    }
}

/// `workspace_manifest_delete(projectId)` — idempotent delete. Returns
/// `IpcResult::success(())` whether the file existed or not. Never touches
/// the PTY / agent layer (the manifest is a passive durable projection).
#[tauri::command]
pub async fn workspace_manifest_delete(
    project_id: String,
    store: State<'_, HostWorkspaceManifestStore>,
) -> Result<IpcResult<()>, String> {
    let log_project_id = sanitize_log_field(&project_id);
    log::info!(
        "[workspace-manifest] delete start project_id={}",
        log_project_id
    );
    let Some(service) = store.store().map(Arc::clone) else {
        log::info!(
            "[workspace-manifest] delete unavailable project_id={}",
            log_project_id
        );
        // Idempotent success — there is nothing to delete in degraded mode.
        return Ok(IpcResult::success(()));
    };
    match service.delete(&project_id).await {
        Ok(()) => Ok(IpcResult::success(())),
        Err(error) => {
            log::error!(
                "[workspace-manifest] delete failure project_id={} error={}",
                log_project_id,
                error
            );
            Ok(IpcResult::error(
                error.to_string(),
                "WORKSPACE_MANIFEST_DELETE_FAILED",
            ))
        }
    }
}
