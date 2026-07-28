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
    use crate::acp::AcpManager;
    use crate::web::project_registry::{ProjectRegistry, ProjectSummary};
    use crate::web::sink::WsRelaySink;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use std::sync::Arc;
    use tower::ServiceExt;

    fn state_with(registry: Arc<ProjectRegistry>) -> AppState {
        AppState {
            acp: Arc::new(AcpManager::new(vec![])),
            relay: Arc::new(WsRelaySink::new()),
            registry,
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
        assert!(serde_json::from_slice::<serde_json::Value>(&body)
            .unwrap()["data"]["projects"][0]
            .as_object()
            .unwrap()
            .get("envVars")
            .is_none());
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
}
