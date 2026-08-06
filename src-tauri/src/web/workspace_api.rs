//! HTTP handlers for the host-owned versioned workspace manifest (CAP-5).
//!
//! Mirrors the desktop `#[tauri::command] workspace_manifest_*` handlers over
//! HTTP so the web/remote client can load/write/delete a project's workspace
//! manifest through the same `IpcBody<T>` contract. Story 5 ships the schema,
//! persistence API, parity surfaces, and exclusion enforcement; Story 6 wires
//! the renderer to read/write/conflict-render through this contract.
//!
//! - **`GET /workspace/:projectId`** — load (returns `IpcBody::ok(None)` when
//!   no manifest exists — a workspace reload starts fresh; the success path).
//! - **`POST /workspace/:projectId/write`** — revision-checked write. Body:
//!   `{ basedRevision: number | null, manifest: WorkspaceManifest }`. Returns
//!   `IpcBody::ok(WriteOutcome)` — conflict is a SUCCESS body variant
//!   (`status: 'conflict'`), NOT an error code.
//! - **`POST /workspace/:projectId/delete`** — idempotent delete; returns
//!   `IpcBody::ok(())`.
//!
//! Write + delete are loopback-only (mirrors `log_api::frontend_error` /
//! `git_api::*`'s `ConnectInfo` guard) so a LAN client cannot mutate the
//! host's manifest store. Load is open (read-only parity with
//! `GET /projects`).
//!
//! Exclusion enforcement: `#[serde(deny_unknown_fields)]` on the manifest +
//! each descriptor struct rejects an over-serialized payload (`envVars`, raw
//! `claim`, `fullscreenPaneId`, …) loudly at the host boundary. The `write`
//! handler manually deserializes the body (via `axum::body::Bytes` + `serde_json::from_slice`)
//! so the `deny_unknown_fields` rejection is caught and mapped to a 200 +
//! `IpcBody::err(VALIDATION_ERROR)` — NOT a 4xx (Patch 1: the IpcBody contract
//! uses 200 for both success and app-level failure so the renderer maps the
//! `VALIDATION_ERROR` code, not a transport `NETWORK_ERROR`).

use std::net::SocketAddr;

use axum::{
    body::Bytes,
    extract::{ConnectInfo, Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use tracing::{debug, warn};

use crate::acp::{WorkspaceManifest, WriteOutcome};
use crate::web::fs_api::IpcBody;
use crate::web::ws::AppState;

/// `POST /workspace/:projectId/write` body. The `manifest` field carries the
/// full portable manifest; `basedRevision` is `null` for the initial write
/// (no prior revision) or the on-disk `revision` for a subsequent write.
///
/// Patch 6: `deny_unknown_fields` rejects an extra top-level field loudly so
/// an over-serialized `{ basedRevision, manifest, debug: true }` envelope
/// surfaces as `VALIDATION_ERROR` (not silently dropped).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteRequest {
    /// Caller's last-known revision. `null` = "no prior revision, treat as
    /// initial write". The host compares against the on-disk `revision` and
    /// returns `WriteOutcome::Conflict` on mismatch WITHOUT mutating state.
    pub based_revision: Option<u64>,
    /// The portable manifest payload. `deny_unknown_fields` on the struct +
    /// every descriptor rejects excluded fields (`envVars`, raw `claim`,
    /// `fullscreenPaneId`, …) loudly — mapped to `VALIDATION_ERROR`.
    pub manifest: WorkspaceManifest,
}

/// `GET /workspace/:projectId` — load a project's manifest.
///
/// Returns `IpcBody::ok(None)` when the file is missing (the success path —
/// a workspace reload starts fresh), OR when the host store is unavailable
/// (degraded fresh-only mode). A corrupt / wrong-schema-version file is
/// backed up by the service then treated as fresh — also `Ok(None)`.
pub async fn get(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> impl IntoResponse {
    let Some(service) = state.workspace_manifest.as_ref() else {
        // Degraded fresh-only mode — no host store attached.
        return (StatusCode::OK, Json(IpcBody::<Option<WorkspaceManifest>>::ok(None)));
    };
    match service.load(&project_id).await {
        Ok(manifest) => {
            debug!(
                target: "termul::web::workspace_api",
                project_id = %project_id,
                revision = manifest.as_ref().map_or(0, |m| m.revision),
                "get: loaded manifest"
            );
            (StatusCode::OK, Json(IpcBody::ok(manifest)))
        }
        Err(error) => {
            warn!(
                target: "termul::web::workspace_api",
                project_id = %project_id,
                error = %error,
                "get: host load failed"
            );
            (
                StatusCode::OK,
                Json(IpcBody::<Option<WorkspaceManifest>>::err(
                    error.to_string(),
                    "WORKSPACE_MANIFEST_GET_FAILED",
                )),
            )
        }
    }
}

/// `POST /workspace/:projectId/write` — revision-checked write.
///
/// Body: `WriteRequest { basedRevision, manifest }`. The host compares
/// `basedRevision` against the on-disk `revision`; on match → apply, increment,
/// persist atomically, return `WriteOutcome::Updated`. On mismatch → return
/// `WriteOutcome::Conflict` WITHOUT mutating state. **Conflict is a SUCCESS
/// body variant** (`status: 'conflict'`), NOT an error code — the caller
/// branches on the `status` discriminator.
///
/// Loopback-only (refused from non-loopback peers) so a LAN client cannot
/// mutate the host's manifest store. An over-serialized payload carrying an
/// excluded field (`envVars`, raw `claim`, `fullscreenPaneId`) fails serde
/// `deny_unknown_fields` — Patch 1: the handler manually deserializes the
/// body so this rejection surfaces as 200 + `IpcBody::err(VALIDATION_ERROR)`
/// (NOT a 4xx — the IpcBody contract uses 200 for app-level failures so the
/// renderer maps the `VALIDATION_ERROR` code rather than a transport
/// `NETWORK_ERROR`).
pub async fn write(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(project_id): Path<String>,
    body: Bytes,
) -> impl IntoResponse {
    if let Some(forbidden) = check_local_only::<WriteOutcome>(peer) {
        return (StatusCode::OK, Json(forbidden));
    }
    // Patch 1: manual deserialization so a `deny_unknown_fields` rejection
    // (envVars / raw claim / fullscreenPaneId / extra envelope field) is
    // caught here and mapped to a 200 + `IpcBody::err(VALIDATION_ERROR)` —
    // NOT a 4xx JsonRejection (which the renderer would map to
    // `NETWORK_ERROR`, masking the validation failure).
    let req: WriteRequest = match serde_json::from_slice(&body) {
        Ok(req) => req,
        Err(error) => {
            warn!(
                target: "termul::web::workspace_api",
                project_id = %project_id,
                error = %error,
                "write: payload validation failed (deny_unknown_fields or malformed JSON)"
            );
            return (
                StatusCode::OK,
                Json(IpcBody::<WriteOutcome>::err(
                    format!("payload validation failed: {error}"),
                    "VALIDATION_ERROR",
                )),
            );
        }
    };
    let Some(service) = state.workspace_manifest.as_ref() else {
        return (
            StatusCode::OK,
            Json(IpcBody::<WriteOutcome>::err(
                "workspace manifest store is unavailable",
                "WORKSPACE_MANIFEST_UNAVAILABLE",
            )),
        );
    };
    match service
        .write(&project_id, req.based_revision, req.manifest)
        .await
    {
        Ok(outcome) => {
            // Boundary logging at the service layer already emits project_id
            // + revision + update_identity (never topology or claim).
            (StatusCode::OK, Json(IpcBody::ok(outcome)))
        }
        Err(error) => {
            warn!(
                target: "termul::web::workspace_api",
                project_id = %project_id,
                error = %error,
                "write: host write failed"
            );
            (
                StatusCode::OK,
                Json(IpcBody::<WriteOutcome>::err(
                    error.to_string(),
                    "WORKSPACE_MANIFEST_WRITE_FAILED",
                )),
            )
        }
    }
}

/// `POST /workspace/:projectId/delete` — idempotent delete. Returns
/// `IpcBody::ok(())` whether the file existed or not. Never touches the PTY /
/// agent layer (the manifest is a passive durable projection; the live process
/// layer is unaffected by stale revisions). Loopback-only.
pub async fn delete(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(project_id): Path<String>,
) -> impl IntoResponse {
    if let Some(forbidden) = check_local_only::<()>(peer) {
        return (StatusCode::OK, Json(forbidden));
    }
    let Some(service) = state.workspace_manifest.as_ref() else {
        // Idempotent success — degraded mode has nothing to delete.
        return (StatusCode::OK, Json(IpcBody::<()>::ok(())));
    };
    match service.delete(&project_id).await {
        Ok(()) => (StatusCode::OK, Json(IpcBody::<()>::ok(()))),
        Err(error) => {
            warn!(
                target: "termul::web::workspace_api",
                project_id = %project_id,
                error = %error,
                "delete: host delete failed"
            );
            (
                StatusCode::OK,
                Json(IpcBody::<()>::err(
                    error.to_string(),
                    "WORKSPACE_MANIFEST_DELETE_FAILED",
                )),
            )
        }
    }
}

/// Localhost-only guard for write/delete routes (mirrors
/// `log_api::frontend_error` / `fs_api::check_local_only`). Returns `None`
/// when the peer is loopback, or `Some(IpcBody::err(...))` with `code:
/// "FORBIDDEN"` when remote. 200+IpcResult convention (200 with the error body)
/// so the renderer maps it to a uniform failure body.
fn check_local_only<T>(peer: SocketAddr) -> Option<IpcBody<T>> {
    if peer.ip().is_loopback() {
        None
    } else {
        Some(IpcBody::<T>::err(
            format!("workspace manifest write/delete routes are localhost-only (peer {peer} is not loopback)"),
            "FORBIDDEN",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::{
        LeafNode, PaneNode, TerminalDescriptor, WorkspaceManifest,
        WorkspaceManifestService,
    };
    use crate::acp::workspace_manifest::WORKSPACE_MANIFEST_SCHEMA_VERSION;
    use crate::web::ws::HistoryMode;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::routing::{get, post};
    use std::sync::Arc;
    use tower::ServiceExt;

    /// Temp directory removed on drop (including panic paths).
    struct TempDir(std::path::PathBuf);
    impl TempDir {
        fn new(label: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let path = std::env::temp_dir().join(format!(
                "termul-workspace-api-{label}-{}-{nanos}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).expect("create temp dir");
            Self(path)
        }
        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn sample_manifest(project_id: &str) -> WorkspaceManifest {
        WorkspaceManifest {
            project_id: project_id.to_string(),
            revision: 0,
            update_identity: Some("conn-1".to_string()),
            updated_at: 0,
            topology: Some(PaneNode::Leaf(LeafNode {
                id: "leaf-1".to_string(),
                terminal_ids: vec!["terminal-1".to_string()],
                editor_ids: vec![],
                active_tab_id: Some("tab-1".to_string()),
            })),
            active_pane_id: Some("leaf-1".to_string()),
            focused_session_id: Some("session-1".to_string()),
            terminals: vec![TerminalDescriptor {
                terminal_id: "terminal-1".to_string(),
                project_id: project_id.to_string(),
                shell: "pwsh".to_string(),
                cwd: "/dev/proj".to_string(),
                name: "main".to_string(),
                worktree_id: Some("wt-1".to_string()),
                claim_handle: Some("handle-1".to_string()),
            }],
            editors: vec![],
        }
    }

    async fn state_with_store(
        root: &std::path::Path,
    ) -> AppState {
        let store = WorkspaceManifestService::open(root.join("manifests"))
            .await
            .expect("open store");
        let pty = crate::web::test_pty_manager();
        AppState {
            acp: Arc::new(crate::acp::AcpManager::new(vec![])),
            terminal_events: pty.terminal_events(),
            cwd_tracker: pty.cwd_tracker(),
            git_tracker: pty.git_tracker(),
            exit_code_tracker: pty.exit_code_tracker(),
            pty,
            relay: Arc::new(crate::web::sink::WsRelaySink::new()),
            registry: Arc::new(crate::web::project_registry::ProjectRegistry::new()),
            registry_persistence: None,
            projects_file: None,
            history_mode: HistoryMode::LiveOnly,
            project_root: Arc::new(std::env::temp_dir()),
            workspace_manifest: Some(store),
            acp_catalog: None,
            acp_install: None,
        }
    }

    /// Patch 7: degraded-mode (`None` store) test helper. Mirrors
    /// `state_with_store` but sets `workspace_manifest: None` so the routes
    /// surface degraded-mode responses (get → Ok(None); write →
    /// WORKSPACE_MANIFEST_UNAVAILABLE; delete → Ok(())).
    async fn state_without_store() -> AppState {
        let pty = crate::web::test_pty_manager();
        AppState {
            acp: Arc::new(crate::acp::AcpManager::new(vec![])),
            terminal_events: pty.terminal_events(),
            cwd_tracker: pty.cwd_tracker(),
            git_tracker: pty.git_tracker(),
            exit_code_tracker: pty.exit_code_tracker(),
            pty,
            relay: Arc::new(crate::web::sink::WsRelaySink::new()),
            registry: Arc::new(crate::web::project_registry::ProjectRegistry::new()),
            registry_persistence: None,
            projects_file: None,
            history_mode: HistoryMode::LiveOnly,
            project_root: Arc::new(std::env::temp_dir()),
            workspace_manifest: None,
            acp_catalog: None,
            acp_install: None,
        }
    }

    // ---- Patch 7: degraded-mode (`None` store) responses ----

    #[tokio::test]
    async fn get_manifest_degraded_returns_ok_none() {
        let state = state_without_store().await;
        let resp = get_manifest(state, "project-1").await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<Option<WorkspaceManifest>> = body_as_json(resp.into_body()).await;
        assert!(body.success, "degraded get must succeed with null data");
        assert!(
            body.data.is_none() || body.data.unwrap().is_none(),
            "degraded get returns Ok(None)"
        );
    }

    #[tokio::test]
    async fn write_degraded_returns_unavailable_error() {
        let state = state_without_store().await;
        let manifest = serde_json::to_value(sample_manifest("project-1")).unwrap();
        let body = serde_json::json!({
            "basedRevision": null,
            "manifest": manifest
        });
        let resp = post_write(state, "project-1", &body, loopback_peer()).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<WriteOutcome> = body_as_json(resp.into_body()).await;
        assert!(!body.success);
        assert_eq!(body.code.as_deref(), Some("WORKSPACE_MANIFEST_UNAVAILABLE"));
    }

    #[tokio::test]
    async fn delete_degraded_returns_ok_idempotent() {
        let state = state_without_store().await;
        let resp = post_delete(state, "project-1", loopback_peer()).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<()> = body_as_json(resp.into_body()).await;
        assert!(body.success, "degraded delete is idempotent success");
    }

    fn test_router(state: AppState) -> axum::Router {
        axum::Router::new()
            .route("/workspace/{projectId}", get(super::get))
            .route("/workspace/{projectId}/write", post(write))
            .route("/workspace/{projectId}/delete", post(delete))
            .with_state(state)
    }

    async fn get_manifest(
        state: AppState,
        project_id: &str,
    ) -> axum::http::Response<Body> {
        test_router(state)
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/workspace/{project_id}"))
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response")
    }

    async fn post_write(
        state: AppState,
        project_id: &str,
        body: &serde_json::Value,
        peer: SocketAddr,
    ) -> axum::http::Response<Body> {
        let bytes = serde_json::to_vec(body).expect("serialize body");
        test_router(state)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/workspace/{project_id}/write"))
                    .header("content-type", "application/json")
                    .extension(ConnectInfo(peer))
                    .body(Body::from(bytes))
                    .expect("build request"),
            )
            .await
            .expect("router response")
    }

    async fn post_delete(
        state: AppState,
        project_id: &str,
        peer: SocketAddr,
    ) -> axum::http::Response<Body> {
        test_router(state)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/workspace/{project_id}/delete"))
                    .extension(ConnectInfo(peer))
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response")
    }

    async fn body_as_json<T: serde::de::DeserializeOwned>(body: Body) -> T {
        let bytes = axum::body::to_bytes(body, usize::MAX)
            .await
            .expect("read body");
        serde_json::from_slice(&bytes).expect("deserialize IpcBody")
    }

    fn loopback_peer() -> SocketAddr {
        SocketAddr::from(([127, 0, 0, 1], 54321))
    }

    fn remote_peer() -> SocketAddr {
        SocketAddr::from(([192, 168, 1, 50], 40000))
    }

    #[tokio::test]
    async fn get_missing_manifest_returns_ok_none() {
        let dir = TempDir::new("get-missing");
        let state = state_with_store(dir.path()).await;
        let resp = get_manifest(state, "project-1").await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<Option<WorkspaceManifest>> = body_as_json(resp.into_body()).await;
        assert!(body.success, "missing manifest = Ok(None), got: {:?}", body);
        assert!(body.data.is_none() || body.data.unwrap().is_none());
    }

    #[tokio::test]
    async fn write_then_get_round_trips() {
        let dir = TempDir::new("write-get");
        let state = state_with_store(dir.path()).await;
        let manifest = serde_json::to_value(sample_manifest("project-1")).unwrap();
        let body = serde_json::json!({
            "basedRevision": null,
            "manifest": manifest
        });
        let resp = post_write(state.clone(), "project-1", &body, loopback_peer()).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let outcome: IpcBody<WriteOutcome> = body_as_json(resp.into_body()).await;
        assert!(outcome.success);
        let data = outcome.data.unwrap();
        match data {
            WriteOutcome::Updated { revision, .. } => assert_eq!(revision, 1),
            _ => panic!("expected Updated, got Conflict"),
        }

        // GET returns the persisted manifest with revision=1.
        let resp = get_manifest(state, "project-1").await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<Option<WorkspaceManifest>> = body_as_json(resp.into_body()).await;
        assert!(body.success);
        let loaded = body.data.unwrap().unwrap();
        assert_eq!(loaded.revision, 1);
        assert_eq!(loaded.project_id, "project-1");
        assert_eq!(loaded.terminals.len(), 1);
    }

    #[tokio::test]
    async fn stale_revision_conflict_does_not_mutate_state() {
        let dir = TempDir::new("stale-conflict");
        let state = state_with_store(dir.path()).await;
        let manifest = serde_json::to_value(sample_manifest("project-1")).unwrap();
        let body = serde_json::json!({
            "basedRevision": null,
            "manifest": manifest
        });
        // Drive on-disk revision to 3.
        let resp = post_write(state.clone(), "project-1", &body, loopback_peer()).await;
        let outcome: IpcBody<WriteOutcome> = body_as_json(resp.into_body()).await;
        assert!(matches!(
            outcome.data.unwrap(),
            WriteOutcome::Updated { revision: 1, .. }
        ));
        let body = serde_json::json!({
            "basedRevision": 1,
            "manifest": manifest
        });
        let resp = post_write(state.clone(), "project-1", &body, loopback_peer()).await;
        let outcome: IpcBody<WriteOutcome> = body_as_json(resp.into_body()).await;
        assert!(matches!(
            outcome.data.unwrap(),
            WriteOutcome::Updated { revision: 2, .. }
        ));
        let body = serde_json::json!({
            "basedRevision": 2,
            "manifest": manifest
        });
        let resp = post_write(state.clone(), "project-1", &body, loopback_peer()).await;
        let outcome: IpcBody<WriteOutcome> = body_as_json(resp.into_body()).await;
        assert!(matches!(
            outcome.data.unwrap(),
            WriteOutcome::Updated { revision: 3, .. }
        ));

        // Stale write: basedRevision=1 against on-disk=3 → Conflict.
        let body = serde_json::json!({
            "basedRevision": 1,
            "manifest": manifest
        });
        let resp = post_write(state.clone(), "project-1", &body, loopback_peer()).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let outcome: IpcBody<WriteOutcome> = body_as_json(resp.into_body()).await;
        assert!(outcome.success, "conflict is a success-body variant");
        match outcome.data.unwrap() {
            WriteOutcome::Conflict {
                current_revision,
                current_update_identity,
                ..
            } => {
                assert_eq!(current_revision, 3);
                assert_eq!(current_update_identity.as_deref(), Some("conn-1"));
            }
            _ => panic!("expected Conflict"),
        }

        // GET returns the persisted revision=3 (no mutation).
        let resp = get_manifest(state, "project-1").await;
        let body: IpcBody<Option<WorkspaceManifest>> = body_as_json(resp.into_body()).await;
        let loaded = body.data.unwrap().unwrap();
        assert_eq!(loaded.revision, 3);
    }

    #[tokio::test]
    async fn write_rejects_excluded_env_vars_field() {
        let dir = TempDir::new("excluded-env");
        let state = state_with_store(dir.path()).await;
        // Patch 1: the `write` handler manually deserializes the body so a
        // `deny_unknown_fields` rejection (envVars in the manifest payload)
        // surfaces as 200 + `IpcBody::err(VALIDATION_ERROR)` — NOT a 4xx
        // JsonRejection (which the renderer would map to NETWORK_ERROR,
        // masking the validation failure).
        let manifest = serde_json::json!({
            "projectId": "project-1",
            "revision": 0,
            "updateIdentity": "conn-1",
            "updatedAt": 0,
            "terminals": [],
            "editors": [],
            "envVars": { "SECRET": "leaked" }
        });
        let body = serde_json::json!({
            "basedRevision": null,
            "manifest": manifest
        });
        let resp = post_write(state.clone(), "project-1", &body, loopback_peer()).await;
        assert_eq!(
            resp.status(),
            StatusCode::OK,
            "deny_unknown_fields rejection must surface as 200 + IpcBody::err (Patch 1), got {}",
            resp.status()
        );
        let body: IpcBody<WriteOutcome> = body_as_json(resp.into_body()).await;
        assert!(!body.success, "envVars payload must be rejected");
        assert_eq!(body.code.as_deref(), Some("VALIDATION_ERROR"));

        // And the manifest is NOT persisted.
        let resp = get_manifest(state, "project-1").await;
        let body: IpcBody<Option<WorkspaceManifest>> = body_as_json(resp.into_body()).await;
        assert!(body.success);
        assert!(body.data.is_none() || body.data.unwrap().is_none());
    }

    #[tokio::test]
    async fn write_rejects_excluded_fullscreen_pane_id_field() {
        let dir = TempDir::new("excluded-fullscreen");
        let state = state_with_store(dir.path()).await;
        let manifest = serde_json::json!({
            "projectId": "project-1",
            "revision": 0,
            "updatedAt": 0,
            "terminals": [],
            "editors": [],
            "fullscreenPaneId": "leaf-1"
        });
        let body = serde_json::json!({
            "basedRevision": null,
            "manifest": manifest
        });
        let resp = post_write(state, "project-1", &body, loopback_peer()).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<WriteOutcome> = body_as_json(resp.into_body()).await;
        assert!(!body.success);
        assert_eq!(body.code.as_deref(), Some("VALIDATION_ERROR"));
    }

    #[tokio::test]
    async fn write_rejects_excluded_agent_launcher_pane_id_field() {
        // Patch 18 (web parity): agentLauncherPaneId is device-specific UI
        // chrome — must be rejected at the host boundary.
        let dir = TempDir::new("excluded-agent-launcher");
        let state = state_with_store(dir.path()).await;
        let manifest = serde_json::json!({
            "projectId": "project-1",
            "revision": 0,
            "updatedAt": 0,
            "terminals": [],
            "editors": [],
            "agentLauncherPaneId": "leaf-1"
        });
        let body = serde_json::json!({
            "basedRevision": null,
            "manifest": manifest
        });
        let resp = post_write(state, "project-1", &body, loopback_peer()).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<WriteOutcome> = body_as_json(resp.into_body()).await;
        assert!(!body.success);
        assert_eq!(body.code.as_deref(), Some("VALIDATION_ERROR"));
    }

    #[tokio::test]
    async fn write_rejects_excluded_raw_claim_in_terminal_descriptor() {
        let dir = TempDir::new("excluded-claim");
        let state = state_with_store(dir.path()).await;
        let manifest = serde_json::json!({
            "projectId": "project-1",
            "revision": 0,
            "updatedAt": 0,
            "terminals": [{
                "terminalId": "t-1",
                "projectId": "project-1",
                "shell": "pwsh",
                "cwd": "/dev/proj",
                "name": "main",
                "claim": "raw-claim-credential"
            }],
            "editors": []
        });
        let body = serde_json::json!({
            "basedRevision": null,
            "manifest": manifest
        });
        let resp = post_write(state, "project-1", &body, loopback_peer()).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<WriteOutcome> = body_as_json(resp.into_body()).await;
        assert!(!body.success);
        assert_eq!(body.code.as_deref(), Some("VALIDATION_ERROR"));
    }

    #[tokio::test]
    async fn write_rejects_extra_top_level_envelope_field() {
        // Patch 6: WriteRequest carries `deny_unknown_fields` so an extra
        // top-level field (e.g. `debug: true`) is rejected loudly as
        // VALIDATION_ERROR — NOT silently dropped.
        let dir = TempDir::new("extra-envelope");
        let state = state_with_store(dir.path()).await;
        let manifest = serde_json::to_value(sample_manifest("project-1")).unwrap();
        let body = serde_json::json!({
            "basedRevision": null,
            "manifest": manifest,
            "debug": true
        });
        let resp = post_write(state, "project-1", &body, loopback_peer()).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<WriteOutcome> = body_as_json(resp.into_body()).await;
        assert!(!body.success, "extra top-level field must be rejected");
        assert_eq!(body.code.as_deref(), Some("VALIDATION_ERROR"));
    }

    #[tokio::test]
    async fn write_rejects_malformed_json_body() {
        // Patch 1: a non-JSON body surfaces as 200 + VALIDATION_ERROR (the
        // manual deserialization catches `serde_json::Error`).
        let dir = TempDir::new("malformed");
        let state = state_with_store(dir.path()).await;
        let bytes = b"{ not valid json";
        let resp = test_router(state)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/workspace/project-1/write")
                    .header("content-type", "application/json")
                    .extension(ConnectInfo(loopback_peer()))
                    .body(Body::from(bytes.to_vec()))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<WriteOutcome> = body_as_json(resp.into_body()).await;
        assert!(!body.success);
        assert_eq!(body.code.as_deref(), Some("VALIDATION_ERROR"));
    }

    #[tokio::test]
    async fn write_refused_from_non_loopback() {
        let dir = TempDir::new("write-remote");
        let state = state_with_store(dir.path()).await;
        let manifest = serde_json::to_value(sample_manifest("project-1")).unwrap();
        let body = serde_json::json!({
            "basedRevision": null,
            "manifest": manifest
        });
        let resp = post_write(state, "project-1", &body, remote_peer()).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<WriteOutcome> = body_as_json(resp.into_body()).await;
        assert!(!body.success, "non-loopback write must be refused");
        assert_eq!(body.code.as_deref(), Some("FORBIDDEN"));
    }

    #[tokio::test]
    async fn delete_refused_from_non_loopback() {
        let dir = TempDir::new("delete-remote");
        let state = state_with_store(dir.path()).await;
        // Seed a manifest so we can prove the delete did NOT happen.
        let manifest = serde_json::to_value(sample_manifest("project-1")).unwrap();
        let body = serde_json::json!({
            "basedRevision": null,
            "manifest": manifest
        });
        let resp = post_write(state.clone(), "project-1", &body, loopback_peer()).await;
        assert!(matches!(
            body_as_json::<IpcBody<WriteOutcome>>(resp.into_body())
                .await
                .data
                .unwrap(),
            WriteOutcome::Updated { .. }
        ));

        // Non-loopback delete → FORBIDDEN, no mutation.
        let resp = post_delete(state.clone(), "project-1", remote_peer()).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<()> = body_as_json(resp.into_body()).await;
        assert!(!body.success);
        assert_eq!(body.code.as_deref(), Some("FORBIDDEN"));

        // The manifest survives.
        let resp = get_manifest(state, "project-1").await;
        let body: IpcBody<Option<WorkspaceManifest>> = body_as_json(resp.into_body()).await;
        assert!(body.data.unwrap().is_some());
    }

    #[tokio::test]
    async fn delete_idempotent_on_missing() {
        let dir = TempDir::new("delete-missing");
        let state = state_with_store(dir.path()).await;
        let resp = post_delete(state, "project-1", loopback_peer()).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<()> = body_as_json(resp.into_body()).await;
        assert!(body.success);
    }

    #[tokio::test]
    async fn concurrent_writes_serialize_exactly_one_updated_one_conflict() {
        let dir = TempDir::new("concurrent");
        let state = state_with_store(dir.path()).await;
        let manifest = serde_json::to_value(sample_manifest("project-1")).unwrap();
        let body = serde_json::json!({
            "basedRevision": null,
            "manifest": manifest
        });
        // Initial write so both concurrent writes present basedRevision=1
        // against on-disk revision=1.
        let resp = post_write(state.clone(), "project-1", &body, loopback_peer()).await;
        assert!(matches!(
            body_as_json::<IpcBody<WriteOutcome>>(resp.into_body())
                .await
                .data
                .unwrap(),
            WriteOutcome::Updated { revision: 1, .. }
        ));

        // Two concurrent writes with basedRevision=1.
        let manifest = serde_json::to_value(sample_manifest("project-1")).unwrap();
        let body1 = serde_json::json!({
            "basedRevision": 1,
            "manifest": manifest
        });
        let manifest = serde_json::to_value(sample_manifest("project-1")).unwrap();
        let body2 = serde_json::json!({
            "basedRevision": 1,
            "manifest": manifest
        });
        let state1 = state.clone();
        let state2 = state.clone();
        let (r1, r2) = tokio::join!(
            async move { post_write(state1, "project-1", &body1, loopback_peer()).await },
            async move { post_write(state2, "project-1", &body2, loopback_peer()).await },
        );
        let o1: IpcBody<WriteOutcome> = body_as_json(r1.into_body()).await;
        let o2: IpcBody<WriteOutcome> = body_as_json(r2.into_body()).await;
        let outcomes = [o1.data.unwrap(), o2.data.unwrap()];
        let updated = outcomes
            .iter()
            .filter(|o| matches!(o, WriteOutcome::Updated { revision: 2, .. }))
            .count();
        let conflicted = outcomes
            .iter()
            .filter(|o| matches!(o, WriteOutcome::Conflict { current_revision: 2, .. }))
            .count();
        assert_eq!(updated, 1, "exactly one Updated");
        assert_eq!(conflicted, 1, "exactly one Conflict");
    }

    /// Serde shape test: the WriteOutcome wire shape is byte-identical
    /// between the Tauri command and the HTTP route (camelCase +
    /// `tag=status`).
    #[test]
    fn write_outcome_wire_shape_is_camel_case_with_status_tag() {
        let updated = WriteOutcome::Updated {
            revision: 5,
            updated_at: 1_700_000_000_000,
        };
        let value = serde_json::to_value(&updated).unwrap();
        assert_eq!(value["status"], "updated");
        assert_eq!(value["revision"], 5);
        assert_eq!(
            value["updatedAt"].as_u64().unwrap(),
            1_700_000_000_000u64
        );

        let conflict = WriteOutcome::Conflict {
            current_revision: 7,
            current_updated_at: 1_700_000_000_001,
            current_update_identity: Some("conn-2".to_string()),
        };
        let value = serde_json::to_value(&conflict).unwrap();
        assert_eq!(value["status"], "conflict");
        assert_eq!(value["currentRevision"], 7);
        assert_eq!(
            value["currentUpdatedAt"].as_u64().unwrap(),
            1_700_000_000_001u64
        );
        assert_eq!(value["currentUpdateIdentity"], "conn-2");
    }

    /// Serde shape test: the WorkspaceManifest envelope is byte-identical
    /// between the Tauri command and the HTTP route (camelCase).
    #[test]
    fn workspace_manifest_wire_shape_is_camel_case() {
        let manifest = sample_manifest("project-1");
        let value = serde_json::to_value(&manifest).unwrap();
        assert!(value.get("projectId").is_some());
        assert!(value.get("revision").is_some());
        assert!(value.get("updateIdentity").is_some());
        assert!(value.get("updatedAt").is_some());
        assert!(value.get("topology").is_some());
        assert!(value.get("activePaneId").is_some());
        assert!(value.get("focusedSessionId").is_some());
        assert!(value.get("terminals").is_some());
        assert!(value.get("editors").is_some());
        // No excluded fields ever serialized.
        for excluded in [
            "envVars",
            "env",
            "tokens",
            "credentials",
            "claim",
            "viewport",
            "windowState",
            "fullscreenPaneId",
            "agentLauncherPaneId",
        ] {
            assert!(value.get(excluded).is_none(), "{excluded} must not be serialized");
        }
    }

    /// Schema version is 1 (Story 5's only version). A bump here is a
    /// breaking change that requires a migrate hook.
    #[test]
    fn schema_version_is_one() {
        assert_eq!(WORKSPACE_MANIFEST_SCHEMA_VERSION, 1);
    }
}

