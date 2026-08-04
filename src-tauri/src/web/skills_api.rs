//! HTTP handlers for agent skills discovery exposed to the web/remote client
//! (CAP-2: Web & Mobile 1:1 Parity).
//!
//! Mirrors the desktop `#[tauri::command] list_agent_skills_cmd` /
//! `read_agent_skill_cmd` handlers over HTTP, reusing the SAME pure-Rust
//! skill discovery logic in `crate::skills` (`list_agent_skills`,
//! `read_agent_skill`). These functions read `~/.agents/skills/` (global) +
//! `{project}/.agents/skills/` (project-local) — no `AppHandle` needed, so they
//! work as-is on the standalone server.
//!
//! Each route:
//! - wraps results in `IpcBody<T>` so the renderer facade swaps transparently
//!   with the desktop command shape.
//! - runs blocking fs calls on `tokio::task::spawn_blocking`.
//! - logs at route boundaries via `tracing` (the standalone server's logger;
//!   a no-op when no subscriber is installed on the desktop shared-live path).
//! - degrades gracefully: scan failure returns an empty list, never throws
//!   (so the slash menu stays usable on web).

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::Deserialize;

use crate::skills::{AgentSkillContent, AgentSkillSummary};
use crate::web::fs_api::IpcBody;
use crate::web::ws::AppState;

/// `GET /skills?projectRoot=` query. `projectRoot` is optional: when omitted,
/// only global skills (`~/.agents/skills/`) are listed.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsQuery {
    pub project_root: Option<String>,
}

/// `GET /skills/:name?projectRoot=` path + query. Mirrors
/// `read_agent_skill(name, project_root)`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillNamePath {
    pub name: String,
}

/// `GET /skills?projectRoot=` — list installed agent skills. Reuses
/// `crate::skills::list_agent_skills` (same function the
/// `#[tauri::command] list_agent_skills_cmd` calls). Returns
/// `IpcBody::ok(Vec<AgentSkillSummary>)` or, on scan failure,
/// `IpcBody::ok(vec![])` (degrade — never throw, so the slash menu stays
/// usable on web).
pub async fn list(
    State(state): State<AppState>,
    Query(q): Query<SkillsQuery>,
) -> impl IntoResponse {
    // Enforce `project_root` containment (web-server security boundary): a web
    // client must not probe skills under an arbitrary host path — only under
    // the server's `project_root` (mirrors `/git/*` + `/search/*`). A
    // non-existent projectRoot canonicalizes to Err and is allowed through
    // (no project skills scanned; only global skills — harmless degrade).
    if let Some(pr) = &q.project_root {
        if let Ok(canonical) = std::path::Path::new(pr).canonicalize() {
            if let Some(err) =
                crate::web::git_api::ensure_within_project_root::<Vec<AgentSkillSummary>>(
                    &canonical,
                    &state.project_root,
                )
            {
                tracing::warn!(
                    "[Security] /skills rejected: projectRoot '{}' outside project_root",
                    canonical.display()
                );
                return (StatusCode::OK, Json(err));
            }
        }
    }
    let project_root = q.project_root;
    let result = tokio::task::spawn_blocking(move || {
        crate::skills::list_agent_skills(project_root.as_deref())
    })
    .await
    .map_err(|e| format!("skills list task failed: {e}"));

    let body = match result {
        Ok(Ok(skills)) => IpcBody::ok(skills),
        Ok(Err(e)) => {
            tracing::warn!("skills list failed (degrading to empty list): {e}");
            // Degrade: return an empty list so the slash menu stays usable,
            // matching the desktop's `Promise.resolve([])` fallback contract.
            IpcBody::ok(Vec::<AgentSkillSummary>::new())
        }
        Err(e) => {
            tracing::error!("skills list task panicked: {e}");
            IpcBody::ok(Vec::<AgentSkillSummary>::new())
        }
    };
    (StatusCode::OK, Json(body))
}

/// `GET /skills/:name?projectRoot=` — read a single skill's body. Reuses
/// `crate::skills::read_agent_skill` (same function the
/// `#[tauri::command] read_agent_skill_cmd` calls). Returns
/// `IpcBody::ok(AgentSkillContent)` or `IpcBody::err(msg, "SKILL_NOT_FOUND")`.
pub async fn read(
    State(state): State<AppState>,
    axum::extract::Path(name): axum::extract::Path<String>,
    Query(q): Query<SkillsQuery>,
) -> impl IntoResponse {
    // Enforce `project_root` containment (web-server security boundary) —
    // mirrors `/skills` (list). A non-existent projectRoot is allowed through.
    if let Some(pr) = &q.project_root {
        if let Ok(canonical) = std::path::Path::new(pr).canonicalize() {
            if let Some(err) = crate::web::git_api::ensure_within_project_root::<AgentSkillContent>(
                &canonical,
                &state.project_root,
            ) {
                tracing::warn!(
                    "[Security] /skills/:name rejected: projectRoot '{}' outside project_root",
                    canonical.display()
                );
                return (StatusCode::OK, Json(err));
            }
        }
    }
    let project_root = q.project_root;
    let name_for_log = name.clone();
    let result = tokio::task::spawn_blocking(move || {
        crate::skills::read_agent_skill(&name, project_root.as_deref())
    })
    .await
    .map_err(|e| format!("skills read task failed: {e}"));

    let body = match result {
        Ok(Ok(content)) => IpcBody::ok(content),
        Ok(Err(e)) => {
            tracing::warn!("skills read failed for '{name_for_log}': {e}");
            IpcBody::<AgentSkillContent>::err(e, "SKILL_NOT_FOUND")
        }
        Err(e) => {
            tracing::error!("skills read task panicked for '{name_for_log}': {e}");
            IpcBody::<AgentSkillContent>::err(
                format!("skills read task failed: {e}"),
                "SKILL_READ_ERROR",
            )
        }
    };
    (StatusCode::OK, Json(body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::AcpManager;
    use crate::web::project_registry::ProjectRegistry;
    use crate::web::sink::WsRelaySink;
    use crate::web::test_pty_manager;
    use axum::body::Body;
    use axum::http::Request;
    use axum::routing::get;
    use std::sync::Arc;
    use tower::ServiceExt;

    fn test_state() -> AppState {
        let pty = test_pty_manager();
        AppState {
            acp: Arc::new(AcpManager::new(vec![])),
            terminal_events: pty.terminal_events(),
            cwd_tracker: pty.cwd_tracker(),
            git_tracker: pty.git_tracker(),
            exit_code_tracker: pty.exit_code_tracker(),
            pty,
            relay: Arc::new(WsRelaySink::new()),
            registry: Arc::new(ProjectRegistry::new()),
            registry_persistence: None,
            projects_file: None,
            history_mode: crate::web::ws::HistoryMode::LiveOnly,
            project_root: Arc::new(
                std::env::temp_dir()
                    .canonicalize()
                    .unwrap_or_else(|_| std::env::temp_dir()),
            ),
        }
    }

    fn test_router(state: AppState) -> axum::Router {
        axum::Router::new()
            .route("/skills", get(list))
            .route("/skills/{name}", get(read))
            .with_state(state)
    }

    async fn get_request(state: AppState, uri: &str) -> axum::http::Response<Body> {
        test_router(state)
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(uri)
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

    #[tokio::test]
    async fn list_skills_returns_array() {
        let resp = get_request(test_state(), "/skills").await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<Vec<AgentSkillSummary>> = body_as_json(resp.into_body()).await;
        assert!(body.success, "skills list should succeed: {:?}", body.error);
        // May be empty on a CI host without ~/.agents/skills, but the body
        // must be a success with an array.
        let _ = body.data.expect("data array");
    }

    #[tokio::test]
    async fn list_skills_degrades_on_scan_failure() {
        // A non-existent project root — list_agent_skills rejects relative
        // paths, but an absolute non-existing path still scans (project
        // skills dir just doesn't exist → empty). Global skills may still
        // be found. The route must never throw.
        let resp = get_request(
            test_state(),
            "/skills?projectRoot=/nonexistent/absolute/path",
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<Vec<AgentSkillSummary>> = body_as_json(resp.into_body()).await;
        assert!(body.success, "must degrade gracefully: {:?}", body.error);
    }

    #[tokio::test]
    async fn list_skills_rejects_project_root_outside_project_root() {
        // A projectRoot that exists but is outside the server's project_root
        // (temp_dir's parent) must be rejected with OUTSIDE_PROJECT_ROOT.
        let state = test_state();
        let outside = state
            .project_root
            .parent()
            .map(std::path::Path::to_path_buf)
            .unwrap_or_else(|| std::path::PathBuf::from("/"));
        let uri = format!("/skills?projectRoot={}", outside.display());
        let resp = get_request(state, &uri).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<Vec<AgentSkillSummary>> = body_as_json(resp.into_body()).await;
        assert!(!body.success, "outside-project-root projectRoot must be rejected");
        assert_eq!(body.code.as_deref(), Some("OUTSIDE_PROJECT_ROOT"));
    }

    #[tokio::test]
    async fn read_skill_not_found_returns_error() {
        let resp = get_request(test_state(), "/skills/nonexistent-skill-12345").await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<AgentSkillContent> = body_as_json(resp.into_body()).await;
        // A nonexistent skill must return a failure body (never throw).
        assert!(!body.success, "nonexistent skill should not be found: {:?}", body.data);
        assert_eq!(body.code.as_deref(), Some("SKILL_NOT_FOUND"));
    }
}
