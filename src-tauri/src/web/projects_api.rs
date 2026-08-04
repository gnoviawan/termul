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

use axum::{extract::State, response::IntoResponse, Json};
use serde::{Deserialize, Serialize};

use crate::web::project_registry::ProjectListPayload;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::{AcpManager, FileProjectRegistry};
    use crate::web::project_registry::{seed_from_file, ProjectRegistry, ProjectSummary};
    use crate::web::sink::WsRelaySink;
    use crate::web::test_pty_manager;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
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
            project_root: Arc::new(std::path::PathBuf::new()),
        }
    }

    fn summary(id: &str, path: Option<&str>, archived: bool, active: bool) -> ProjectSummary {
        ProjectSummary {
            id: id.to_string(),
            name: format!("Proj {id}"),
            color: "blue".to_string(),
            path: path.map(str::to_string),
            is_archived: archived,
            is_active: active,
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
        assert_eq!(data.active_project_id.as_deref(), Some("p-1"));
        assert_eq!(data.projects[0].id, "p-1");
        assert!(data.projects[0].is_active);
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
        assert_eq!(data.active_project_id.as_deref(), Some("p-1"));
        assert_eq!(data.projects[0].id, "p-1");
        assert!(
            data.projects[0].is_active,
            "active flag derived from active_project_id"
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
        assert_eq!(data.active_project_id.as_deref(), Some("d-1"));
        assert_eq!(data.projects[0].id, "d-1");
        assert!(data.projects[0].is_active);

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
}
