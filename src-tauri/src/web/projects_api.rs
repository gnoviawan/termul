//! HTTP handler for `GET /projects` — the web/remote project-list mirror.
//!
//! Returns the desktop's non-archived + archived project summaries from the
//! in-memory [`ProjectRegistry`] (Epic-4 bridge). The renderer syncs the
//! registry via the `remote_sync_projects` Tauri command; the browser reads it
//! here. The body mirrors the `IpcResult<T>` contract over HTTP (HTTP 200 for
//! both success AND app-level failures — matching the other web routes), so the
//! renderer's `webServerProjects.list()` (which maps non-2xx → `NETWORK_ERROR`)
//! sees success/failure in the body, not the status code.
//!
//! Carries NO env-var values — [`ProjectSummary`] redacts-by-omission (frozen
//! constraint). Only the identity/display fields a project switcher needs.

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, State};
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::web::project_registry::ProjectListPayload;
use crate::web::sink::broadcast_projects_changed;
use crate::web::ws::AppState;

/// HTTP response body mirroring the renderer-side `IpcResult<T>` shape. Kept
/// local (mirrors `fs_api::IpcBody`) so this module stays self-contained.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IpcBody<T> {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

impl<T> IpcBody<T> {
    fn ok(data: T) -> Self {
        Self {
            success: true,
            data: Some(data),
            error: None,
            code: None,
        }
    }

    fn err(error: impl Into<String>, code: impl Into<String>) -> Self {
        Self {
            success: false,
            data: None,
            error: Some(error.into()),
            code: Some(code.into()),
        }
    }
}

/// `POST /projects/default` request body — the explicit host-default change
/// (Epic 7). Mirrors the `set_default_project` WS request payload + the
/// `set_host_default_project` Tauri command argument.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetDefaultProjectRequest {
    pub project_id: String,
}

/// `GET /projects` → the synced project list mirror.
///
/// Snapshots the registry (a short clone under the lock) and returns it. An
/// empty list is a valid success (the desktop hasn't synced yet, or the
/// standalone binary has no renderer source) — the web client renders an empty
/// sidebar, NOT an error. The registry is the source; if it is empty the
/// browser just shows nothing (the desktop will push a `projects_changed`
/// event when it syncs).
pub async fn list(State(state): State<AppState>) -> impl IntoResponse {
    let payload: ProjectListPayload = state.registry.snapshot();
    Json(IpcBody::ok(payload))
}

/// `POST /projects/default` → set the host's default project (Epic 7).
///
/// Validates the target is switchable (unknown/archived/pathless → `NOT_FOUND`),
/// updates `registry.set_default_project`, persists to `FileProjectRegistry`
/// (VPS only, with rollback on failure), and broadcasts `projects_changed`
/// carrying the new `defaultProjectId` to ALL connected clients. Mirrors the
/// `set_default_project` WS request + the `set_host_default_project` Tauri
/// command (transport parity). Desktop-hosted mode has no file registry — it
/// updates the in-memory registry + broadcasts only.
///
/// # Malformed body (P14)
///
/// Axum's `Json` extractor returns HTTP 422 (Unprocessable Entity) for a
/// malformed JSON body BEFORE this handler runs — so a `VALIDATION_ERROR`
/// code in the body is never produced. The 422 response is a transport-level
/// rejection, not an `IpcBody` success/failure. Clients map non-2xx →
/// `NETWORK_ERROR` (per `webServerProjects.setDefaultProject`).
///
/// Body: `{ "projectId": "<id>" }`.
pub async fn set_default_project(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<SetDefaultProjectRequest>,
) -> impl IntoResponse {
    // Loopback-only guard — this route mutates host state (persists the default
    // to `FileProjectRegistry` and broadcasts `projects_changed` to ALL
    // connected clients), so a LAN peer on a `0.0.0.0` bind must not reach it.
    // Mirrors the fs/git/workspace write routes' `check_local_only` (CWE-306).
    if !peer.ip().is_loopback() && !state.allow_remote_writes {
        return Json(IpcBody::<()>::err(
            format!("host-state write routes are localhost-only (peer {peer} is not loopback)"),
            "FORBIDDEN",
        ));
    }
    let project_id = req.project_id;
    // Validate via switch_context (same path as `switch_project`).
    if state.registry.switch_context(&project_id).is_none() {
        tracing::warn!(
            target: "termul::web::projects_api",
            project_id = %project_id,
            "set_default_project: project not found or not switchable"
        );
        return Json(IpcBody::<()>::err(
            format!("project '{project_id}' not found or not switchable"),
            "NOT_FOUND",
        ));
    }
    // VPS persistence (with rollback). Desktop-hosted: registry_persistence is None.
    // The old default is captured so the in-memory-set failure path below can
    // roll the file back (P1: no split-brain — if `registry.set_default_project`
    // returns false after the file was already persisted, the file is restored
    // + re-saved before returning the error).
    let mut persisted_old_default: Option<Option<String>> = None;
    if let (Some(file_registry), Some(path)) =
        (state.registry_persistence.as_ref(), state.projects_file.as_deref())
    {
        let persistence_result = {
            let mut file_registry = file_registry.lock();
            let old_default = file_registry.default_project_id().map(str::to_string);
            match file_registry.set_default_project(&project_id) {
                Ok(()) => match file_registry.save_atomic(path) {
                    Ok(()) => {
                        persisted_old_default = Some(old_default);
                        Ok(())
                    }
                    Err(error) => {
                        file_registry.restore_default_project(old_default);
                        Err(error)
                    }
                },
                Err(error) => Err(error),
            }
        };
        if let Err(error) = persistence_result {
            tracing::error!(
                target: "termul::web::projects_api",
                project_id = %project_id,
                error = %error,
                "set_default_project: persistence failed (rolled back)"
            );
            return Json(IpcBody::<()>::err(
                format!("failed to persist default project: {error}"),
                "PERSIST_FAILED",
            ));
        }
    }
    // Update the in-memory registry default + broadcast.
    // If the in-memory set fails (target vanished between validation and
    // commit), roll back the file registry (P1: no split-brain).
    if !state.registry.set_default_project(&project_id) {
        if let (Some(file_registry), Some(path), Some(old_default)) = (
            state.registry_persistence.as_ref(),
            state.projects_file.as_deref(),
            persisted_old_default,
        ) {
            let mut file_registry = file_registry.lock();
            file_registry.restore_default_project(old_default);
            if let Err(error) = file_registry.save_atomic(path) {
                tracing::warn!(
                    target: "termul::web::projects_api",
                    error = %error,
                    "set_default_project: failed to persist in-memory-set rollback"
                );
            }
        }
        tracing::warn!(
            target: "termul::web::projects_api",
            project_id = %project_id,
            "set_default_project: target became unavailable before commit (file rolled back)"
        );
        return Json(IpcBody::<()>::err(
            "target project became unavailable before commit".to_string(),
            "NOT_FOUND",
        ));
    }
    broadcast_projects_changed(&state.relay, Some(&project_id));
    tracing::info!(
        target: "termul::web::projects_api",
        project_id = %project_id,
        "set_default_project: host default updated + broadcast"
    );
    Json(IpcBody::ok(()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::{AcpManager, FileProjectRegistry};
    use crate::web::project_registry::{seed_from_file, ProjectRegistry, ProjectSummary};
    use crate::web::sink::WsRelaySink;
    use crate::web::test_pty_manager;
    use axum::body::Body;
    use axum::extract::ConnectInfo;
    use axum::http::{Request, StatusCode};
    use std::net::SocketAddr;
    use std::sync::Arc;
    use tower::ServiceExt;

    fn state_with(registry: Arc<ProjectRegistry>) -> AppState {
        let pty = test_pty_manager();
        AppState {
            acp: Arc::new(AcpManager::new(vec![])),
            terminal_events: pty.terminal_events(),
            cwd_tracker: pty.cwd_tracker(),
            git_tracker: pty.git_tracker(),
            exit_code_tracker: pty.exit_code_tracker(),
            pty,
            relay: Arc::new(WsRelaySink::new()),
            registry,
            registry_persistence: None,
            projects_file: None,
            history_mode: crate::web::ws::HistoryMode::LiveOnly,
            project_root: Arc::new(parking_lot::RwLock::new(std::path::PathBuf::new())),
            workspace_manifest: None,
            acp_catalog: None,
            acp_install: None,
            store: None,
            allow_remote_writes: false,
        }
    }

    /// Same as `state_with` but wires a VPS-mode `FileProjectRegistry` + path
    /// (for P11: the HTTP `set_default_project` persistence + rollback test).
    fn state_with_persistence(
        registry: Arc<ProjectRegistry>,
        file_registry: Arc<parking_lot::Mutex<FileProjectRegistry>>,
        relay: Arc<WsRelaySink>,
        projects_file: std::path::PathBuf,
    ) -> AppState {
        let pty = test_pty_manager();
        AppState {
            acp: Arc::new(AcpManager::new(vec![])),
            terminal_events: pty.terminal_events(),
            cwd_tracker: pty.cwd_tracker(),
            git_tracker: pty.git_tracker(),
            exit_code_tracker: pty.exit_code_tracker(),
            pty,
            relay,
            registry,
            registry_persistence: Some(file_registry),
            projects_file: Some(Arc::new(projects_file)),
            history_mode: crate::web::ws::HistoryMode::LiveOnly,
            project_root: Arc::new(parking_lot::RwLock::new(std::path::PathBuf::new())),
            workspace_manifest: None,
            acp_catalog: None,
            acp_install: None,
            store: None,
            allow_remote_writes: false,
        }
    }

    fn summary(id: &str, path: Option<&str>, archived: bool, default: bool) -> ProjectSummary {
        ProjectSummary {
            id: id.to_string(),
            name: format!("Proj {id}"),
            color: "blue".to_string(),
            path: path.map(str::to_string),
            is_archived: archived,
            is_default: default,
        }
    }

    #[tokio::test]
    async fn projects_returns_synced_list() {
        let registry = Arc::new(ProjectRegistry::new());
        registry.set(
            vec![
                summary("p-1", Some("/a"), false, true),
                summary("p-2", Some("/b"), false, false),
                summary("p-old", Some("/c"), true, false),
            ],
            Some("p-1".to_string()),
        );
        let app = axum::Router::new()
            .route("/projects", axum::routing::get(list))
            .with_state(state_with(registry));

        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/projects")
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("read body");
        let parsed: IpcBody<ProjectListPayload> =
            serde_json::from_slice(&body).expect("parse body");
        assert!(parsed.success);
        let data = parsed.data.expect("data");
        assert_eq!(data.projects.len(), 3);
        assert_eq!(data.default_project_id.as_deref(), Some("p-1"));
        assert_eq!(data.projects[0].id, "p-1");
        assert!(data.projects[0].is_default);
        assert!(data.projects[2].is_archived);
        // No env-var values cross the wire (redact-by-omission): ProjectSummary
        // simply has no env-var field — assert the shape.
        assert!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap()["data"]["projects"][0]
                .as_object()
                .unwrap()
                .get("envVars")
                .is_none()
        );
    }

    #[tokio::test]
    async fn projects_returns_empty_success_when_unsynced() {
        let registry = Arc::new(ProjectRegistry::new());
        let app = axum::Router::new()
            .route("/projects", axum::routing::get(list))
            .with_state(state_with(registry));

        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/projects")
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("read body");
        let parsed: IpcBody<ProjectListPayload> =
            serde_json::from_slice(&body).expect("parse body");
        assert!(parsed.success);
        assert!(parsed.data.unwrap().projects.is_empty());
    }

    /// Minimal std-only temp dir (reuses `web::config`'s pid+nanos pattern —
    /// no `tempfile` dev-dep). Caller must `cleanup` it.
    fn tempdir_like(label: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let p = std::env::temp_dir().join(format!(
            "termul-projects-api-{label}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&p).expect("create tempdir");
        p
    }

    fn cleanup(p: &std::path::Path) {
        let _ = std::fs::remove_dir_all(p);
    }

    // T5.9(a) — VPS mode: the standalone binary loads the file-backed
    // registry and seeds the in-memory registry from it. GET /projects
    // returns the file's VFS roots; switch_project resolves the cwd from the
    // seeded registry via the SAME in-memory read-path (handle_switch_project
    // calls registry.find_path — see web/ws.rs:894). FileProjectRegistry IS
    // constructed here; the mode difference vs desktop is the SEED source.
    #[tokio::test]
    async fn vps_mode_seeds_from_file_then_lists_and_resolves_cwd() {
        let dir = tempdir_like("vps-mode");
        let root_a = dir.join("proj-a");
        std::fs::create_dir_all(&root_a).expect("mkdir root-a");
        let file = dir.join("projects.json");
        std::fs::write(
            &file,
            serde_json::json!({
                "schemaVersion": 1,
                "activeProjectId": "p-1",
                "projects": [
                    { "id": "p-1", "name": "Project p-1", "path": root_a, "color": "blue", "isArchived": false },
                    { "id": "p-old", "name": "Project p-old", "path": root_a, "color": "green", "isArchived": true },
                ]
            })
            .to_string(),
        )
        .expect("write registry json");

        // VPS load path.
        let file_reg = FileProjectRegistry::load(&file).expect("load ok");
        assert_eq!(file_reg.roots().len(), 2);
        let registry = Arc::new(ProjectRegistry::new());
        seed_from_file(&registry, &file_reg);

        // GET /projects returns the file's VFS roots (list() = snapshot()).
        let app = axum::Router::new()
            .route("/projects", axum::routing::get(list))
            .with_state(state_with(Arc::clone(&registry)));
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/projects")
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("read body");
        let parsed: IpcBody<ProjectListPayload> =
            serde_json::from_slice(&body).expect("parse body");
        assert!(parsed.success);
        let data = parsed.data.expect("data");
        assert_eq!(data.projects.len(), 2, "file's VFS roots");
        assert_eq!(data.default_project_id.as_deref(), Some("p-1"));
        assert_eq!(data.projects[0].id, "p-1");
        assert!(
            data.projects[0].is_default,
            "default flag derived from default_project_id"
        );
        assert!(data.projects[1].is_archived);

        // switch_project resolves the cwd from the seeded registry via the
        // shared in-memory read-path (find_path). The active root's path is
        // the canonicalized VFS root.
        let expected_cwd = root_a
            .canonicalize()
            .expect("canonicalize")
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            registry.find_path("p-1").as_deref(),
            Some(expected_cwd.as_str()),
            "switch_project (handle_switch_project) resolves the cwd via find_path"
        );
        cleanup(&dir);
    }

    // T5.9(b) — Desktop-hosted mode: the renderer feeds the in-memory registry
    // via remote_sync_projects (here a direct set, the same call the command
    // makes). GET /projects returns the renderer list; switch_project resolves
    // the cwd. FileProjectRegistry is NOT constructed in the desktop path.
    #[tokio::test]
    async fn desktop_mode_seeds_from_renderer_then_lists_and_resolves_cwd() {
        let registry = Arc::new(ProjectRegistry::new());
        registry.set(
            vec![
                summary("d-1", Some("/renderer/cwd-a"), false, true),
                summary("d-2", Some("/renderer/cwd-b"), false, false),
            ],
            Some("d-1".to_string()),
        );

        let app = axum::Router::new()
            .route("/projects", axum::routing::get(list))
            .with_state(state_with(Arc::clone(&registry)));
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/projects")
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("read body");
        let parsed: IpcBody<ProjectListPayload> =
            serde_json::from_slice(&body).expect("parse body");
        assert!(parsed.success);
        let data = parsed.data.expect("data");
        assert_eq!(data.projects.len(), 2, "renderer-fed list");
        assert_eq!(data.default_project_id.as_deref(), Some("d-1"));
        assert_eq!(data.projects[0].id, "d-1");
        assert!(data.projects[0].is_default);

        // switch_project resolves the cwd from the renderer-fed registry.
        assert_eq!(
            registry.find_path("d-1").as_deref(),
            Some("/renderer/cwd-a")
        );
        assert_eq!(
            registry.find_path("d-2").as_deref(),
            Some("/renderer/cwd-b")
        );
    }

    /// `POST /projects/default` updates the host default in the in-memory
    /// registry (desktop-hosted mode: no `FileProjectRegistry`). Mirrors the
    /// `set_default_project` WS request + the `set_host_default_project` Tauri
    /// command (transport parity — Epic 7).
    #[tokio::test]
    async fn set_default_project_updates_host_default_and_flags() {
        let registry = Arc::new(ProjectRegistry::new());
        registry.set(
            vec![
                summary("p-1", Some("/a"), false, true),
                summary("p-2", Some("/b"), false, false),
            ],
            Some("p-1".to_string()),
        );
        let app = axum::Router::new()
            .route("/projects/default", axum::routing::post(set_default_project))
            .with_state(state_with(Arc::clone(&registry)));

        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/projects/default")
                    .header("content-type", "application/json")
                    .extension(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 54321))))
                    .body(Body::from(
                        serde_json::json!({ "projectId": "p-2" }).to_string(),
                    ))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("read body");
        let parsed: IpcBody<()> = serde_json::from_slice(&body).expect("parse body");
        assert!(parsed.success, "set_default_project succeeds: {parsed:?}");
        let snap = registry.snapshot();
        assert_eq!(snap.default_project_id.as_deref(), Some("p-2"));
        assert!(!snap.projects[0].is_default);
        assert!(snap.projects[1].is_default);
    }

    /// `POST /projects/default` with an unknown/archived/pathless project →
    /// `NOT_FOUND` (the registry validation rejects it before any mutation).
    #[tokio::test]
    async fn set_default_project_unknown_id_is_not_found() {
        let registry = Arc::new(ProjectRegistry::new());
        registry.set(
            vec![
                summary("p-1", Some("/a"), false, true),
                summary("p-archived", Some("/b"), true, false),
                summary("p-pathless", None, false, false),
            ],
            Some("p-1".to_string()),
        );
        let app = axum::Router::new()
            .route("/projects/default", axum::routing::post(set_default_project))
            .with_state(state_with(Arc::clone(&registry)));

        for bad in ["missing", "p-archived", "p-pathless"] {
            let resp = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/projects/default")
                        .header("content-type", "application/json")
                        .extension(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 54321))))
                        .body(Body::from(
                            serde_json::json!({ "projectId": bad }).to_string(),
                        ))
                        .expect("build request"),
                )
                .await
                .expect("router response");
            assert_eq!(resp.status(), StatusCode::OK);
            let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
                .await
                .expect("read body");
            let parsed: IpcBody<()> = serde_json::from_slice(&body).expect("parse body");
            assert!(!parsed.success, "{bad} should be rejected");
            assert_eq!(parsed.code.as_deref(), Some("NOT_FOUND"));
            // The registry default is unchanged.
            assert_eq!(
                registry.snapshot().default_project_id.as_deref(),
                Some("p-1")
            );
        }
    }

    /// P11 — `POST /projects/default` with VPS-mode `registry_persistence` +
    /// `projects_file` exercises the file persistence path. The file registry +
    /// the on-disk file carry the new default after the request succeeds.
    #[tokio::test]
    async fn set_default_project_http_persists_to_file_registry_vps_mode() {
        let dir = tempdir_like("http-vps-persist");
        let root_a = dir.join("proj-a");
        let root_b = dir.join("proj-b");
        std::fs::create_dir_all(&root_a).expect("mkdir root-a");
        std::fs::create_dir_all(&root_b).expect("mkdir root-b");
        let file = dir.join("projects.json");

        let file_registry = FileProjectRegistry::from_roots(
            vec![
                crate::acp::VfsRoot {
                    id: "p-1".to_string(),
                    name: "Proj p-1".to_string(),
                    path: root_a,
                    color: "blue".to_string(),
                    is_archived: false,
                    mcp_servers: vec![],
                },
                crate::acp::VfsRoot {
                    id: "p-2".to_string(),
                    name: "Proj p-2".to_string(),
                    path: root_b,
                    color: "green".to_string(),
                    is_archived: false,
                    mcp_servers: vec![],
                },
            ],
            Some("p-1".to_string()),
        );
        let file_registry = Arc::new(parking_lot::Mutex::new(file_registry));
        let relay = Arc::new(WsRelaySink::new());
        let registry = Arc::new(ProjectRegistry::new());
        // Seed the in-memory registry from the file (VPS load path).
        seed_from_file(&registry, &file_registry.lock());

        let app = axum::Router::new()
            .route(
                "/projects/default",
                axum::routing::post(set_default_project),
            )
            .with_state(state_with_persistence(
                Arc::clone(&registry),
                Arc::clone(&file_registry),
                Arc::clone(&relay),
                file.clone(),
            ));

        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/projects/default")
                    .header("content-type", "application/json")
                    .extension(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 54321))))
                    .body(Body::from(
                        serde_json::json!({ "projectId": "p-2" }).to_string(),
                    ))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("read body");
        let parsed: IpcBody<()> = serde_json::from_slice(&body).expect("parse body");
        assert!(parsed.success, "VPS set_default_project succeeds: {parsed:?}");

        // The in-memory registry default updated.
        let snap = registry.snapshot();
        assert_eq!(snap.default_project_id.as_deref(), Some("p-2"));
        // The file registry persisted (VPS mode).
        assert_eq!(file_registry.lock().default_project_id(), Some("p-2"));
        // The on-disk file carries the new default under the v3 field name.
        let saved = std::fs::read_to_string(&file).expect("persisted file exists");
        let v: serde_json::Value = serde_json::from_str(&saved).expect("valid json");
        assert_eq!(v["schemaVersion"], 3);
        assert_eq!(v["defaultProjectId"], "p-2");

        // P11 rollback: a second request with an UNKNOWN id must NOT corrupt
        // the file (the validation rejects before persistence; the file stays
        // at p-2).
        let app2 = axum::Router::new()
            .route(
                "/projects/default",
                axum::routing::post(set_default_project),
            )
            .with_state(state_with_persistence(
                Arc::clone(&registry),
                Arc::clone(&file_registry),
                Arc::clone(&relay),
                file.clone(),
            ));
        let resp2 = app2
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/projects/default")
                    .header("content-type", "application/json")
                    .extension(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 54321))))
                    .body(Body::from(
                        serde_json::json!({ "projectId": "missing" }).to_string(),
                    ))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        let body2 = axum::body::to_bytes(resp2.into_body(), usize::MAX)
            .await
            .expect("read body");
        let parsed2: IpcBody<()> = serde_json::from_slice(&body2).expect("parse body");
        assert!(!parsed2.success);
        assert_eq!(parsed2.code.as_deref(), Some("NOT_FOUND"));
        // File unchanged after the rejected request.
        assert_eq!(file_registry.lock().default_project_id(), Some("p-2"));

        cleanup(&dir);
    }

    /// `POST /projects/default` from a non-loopback peer → `FORBIDDEN`. The
    /// route mutates host state (persists + broadcasts), so a LAN client on a
    /// `0.0.0.0` bind must be rejected before any mutation (security parity
    /// with the fs/git/workspace write routes).
    #[tokio::test]
    async fn set_default_project_rejects_non_loopback_peer() {
        let registry = Arc::new(ProjectRegistry::new());
        registry.set(
            vec![summary("p-1", Some("/a"), false, true)],
            Some("p-1".to_string()),
        );
        let app = axum::Router::new()
            .route("/projects/default", axum::routing::post(set_default_project))
            .with_state(state_with(Arc::clone(&registry)));

        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/projects/default")
                    .header("content-type", "application/json")
                    // A LAN peer (10.0.0.5), not loopback.
                    .extension(ConnectInfo(SocketAddr::from(([10, 0, 0, 5], 54321))))
                    .body(Body::from(
                        serde_json::json!({ "projectId": "p-1" }).to_string(),
                    ))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("read body");
        let parsed: IpcBody<()> = serde_json::from_slice(&body).expect("parse body");
        assert!(!parsed.success, "non-loopback peer must be rejected");
        assert_eq!(parsed.code.as_deref(), Some("FORBIDDEN"));
        // The host default is untouched.
        assert_eq!(
            registry.snapshot().default_project_id.as_deref(),
            Some("p-1")
        );
    }

    /// `--allow-remote-writes`: a non-loopback peer is ADMITTED on
    /// `/projects/default` (the inline guard honors the opt-in) and the host
    /// default is actually mutated. Mirrors the refusal test with the flag on.
    #[tokio::test]
    async fn set_default_project_admits_non_loopback_peer_when_opt_in() {
        let registry = Arc::new(ProjectRegistry::new());
        registry.set(
            vec![
                summary("p-1", Some("/a"), false, true),
                summary("p-2", Some("/b"), false, false),
            ],
            Some("p-1".to_string()),
        );
        let mut state = state_with(Arc::clone(&registry));
        state.allow_remote_writes = true;
        let app = axum::Router::new()
            .route("/projects/default", axum::routing::post(set_default_project))
            .with_state(state);

        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/projects/default")
                    .header("content-type", "application/json")
                    // A LAN peer (10.0.0.5), not loopback.
                    .extension(ConnectInfo(SocketAddr::from(([10, 0, 0, 5], 54321))))
                    .body(Body::from(
                        serde_json::json!({ "projectId": "p-2" }).to_string(),
                    ))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("read body");
        let parsed: IpcBody<()> = serde_json::from_slice(&body).expect("parse body");
        assert!(
            parsed.success,
            "opt-in must admit non-loopback peer: {:?}",
            parsed.error
        );
        // The host default flipped to p-2.
        assert_eq!(
            registry.snapshot().default_project_id.as_deref(),
            Some("p-2")
        );
    }
}
