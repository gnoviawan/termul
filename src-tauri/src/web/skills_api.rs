//! HTTP handlers for agent skills discovery exposed to the web/remote client
//! (CAP-2: Web & Mobile 1:1 Parity).
//!
//! Mirrors the desktop `#[tauri::command] list_agent_skills_cmd` /
//! `read_agent_skill_cmd` handlers over HTTP, reusing the SAME pure-Rust
//! skill discovery logic in `crate::skills` (`list_agent_skills`,
//! `read_agent_skill`). These functions read Claude Code skills
//! (`~/.claude/skills/` and enabled plugins), `~/.agents/skills/` (global), and
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

use crate::skills::files::SkillFileEntry;
use crate::skills::{AgentSkillContent, AgentSkillSummary};
use crate::web::fs_api::IpcBody;
use crate::web::ws::AppState;

/// `GET /skills?projectRoot=` query. `projectRoot` is optional: when omitted,
/// project `.agents/skills/` and project Claude settings are not read. User
/// skills (`~/.agents/skills/`, `~/.claude/skills/`, and user-enabled plugins)
/// are still listed.
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
            if let Some(err) = crate::web::git_api::ensure_within_project_boundary::<
                Vec<AgentSkillSummary>,
            >(&canonical, &state.registry)
            {
                tracing::warn!(
                    "[Security] /skills rejected: projectRoot '{}' outside every registered project",
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
            if let Some(err) = crate::web::git_api::ensure_within_project_boundary::<
                AgentSkillContent,
            >(&canonical, &state.registry)
            {
                tracing::warn!(
                    "[Security] /skills/:name rejected: projectRoot '{}' outside every registered project",
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

/// `GET /skills-index?projectRoot=` — index every skill `SKILL.md` an agent
/// can load (Termul's `.agents` roots plus the harness roots). Reuses
/// `crate::skills::files::list_skill_files` (same function the
/// `#[tauri::command] list_skill_files_cmd` calls). Not nested under
/// `/skills/` so it cannot shadow a skill named by `/skills/{name}`; the
/// `/skills` gate prefix still covers it. Degrades to an empty list.
///
/// Unlike `/skills`, the index walks the project root's ancestors up to a git
/// root, so an unresolvable `projectRoot` cannot be let through: a missing
/// path inside another repository would walk into that repository. Such a
/// root is dropped (global roots only), and a resolved root is indexed by its
/// canonical path, never the raw query string.
pub async fn files(
    State(state): State<AppState>,
    Query(q): Query<SkillsQuery>,
) -> impl IntoResponse {
    let project_root = match q.project_root.as_deref().filter(|pr| !pr.is_empty()) {
        None => None,
        Some(pr) => match std::path::Path::new(pr).canonicalize() {
            Err(e) => {
                tracing::warn!(
                    "/skills-index: projectRoot '{pr}' does not resolve ({e}); indexing global roots only"
                );
                None
            }
            Ok(canonical) => {
                if let Some(err) = crate::web::git_api::ensure_within_project_boundary::<
                    Vec<SkillFileEntry>,
                >(&canonical, &state.registry)
                {
                    tracing::warn!(
                        "[Security] /skills-index rejected: projectRoot '{}' outside every registered project",
                        canonical.display()
                    );
                    return (StatusCode::OK, Json(err));
                }
                Some(
                    crate::path_validation::strip_verbatim_prefix(&canonical.to_string_lossy())
                        .into_owned(),
                )
            }
        },
    };
    let result = tokio::task::spawn_blocking(move || {
        crate::skills::files::list_skill_files(project_root.as_deref())
    })
    .await
    .map_err(|e| format!("skill index task failed: {e}"));

    let body = match result {
        Ok(Ok(entries)) => {
            tracing::debug!("skill index listed {} skill file(s)", entries.len());
            IpcBody::ok(entries)
        }
        Ok(Err(e)) => {
            tracing::warn!("skill index failed (degrading to empty list): {e}");
            IpcBody::ok(Vec::<SkillFileEntry>::new())
        }
        Err(e) => {
            tracing::error!("skill index task panicked: {e}");
            IpcBody::ok(Vec::<SkillFileEntry>::new())
        }
    };
    (StatusCode::OK, Json(body))
}

#[cfg(test)]
mod tests;
