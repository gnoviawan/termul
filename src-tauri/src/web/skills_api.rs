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
    // the server's `project_root` or any registered project root (mirrors
    // `/git/*` + `/search/*`). A non-existent projectRoot canonicalizes to Err
    // and is allowed through (no project skills scanned; only global skills —
    // harmless degrade).
    if let Some(pr) = &q.project_root {
        if let Ok(canonical) = std::path::Path::new(pr).canonicalize() {
            // CAP-1: lock-read the live boundary (may have been rebound).
            // CAP-2: also check all registered project roots so a web client
            // that switched to a non-default project can list skills.
            // Scope in a block so the `!Send` guard drops before the
            // `spawn_blocking` `.await` (keeps the handler future `Send`).
            let outside_err = {
                let project_root = state.project_root.read();
                crate::web::git_api::ensure_within_project_boundary::<Vec<AgentSkillSummary>>(
                    &canonical,
                    &project_root,
                    &state.registry,
                )
            };
            if let Some(err) = outside_err {
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
            // CAP-1: lock-read the live boundary (may have been rebound).
            // CAP-2: also check all registered project roots.
            // Scope in a block so the `!Send` guard drops before the
            // `spawn_blocking` `.await` (keeps the handler future `Send`).
            let outside_err = {
                let project_root = state.project_root.read();
                crate::web::git_api::ensure_within_project_boundary::<AgentSkillContent>(
                    &canonical,
                    &project_root,
                    &state.registry,
                )
            };
            if let Some(err) = outside_err {
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
mod tests;
