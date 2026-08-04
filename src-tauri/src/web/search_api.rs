//! HTTP handlers for content search exposed to the web/remote client
//! (CAP-2: Web & Mobile 1:1 Parity).
//!
//! Mirrors the desktop `#[tauri::command] search_get_rg_info` /
//! `search_content` / `search_content_cancel` handlers over HTTP, reusing the
//! SAME ripgrep logic in `crate::commands` (`resolve_rg_path`,
//! `validated_search_root`, `build_search_args`, `detect_rg_path`,
//! `configure_background_command`, `search_processes`). The web client has no
//! Tauri runtime to invoke these commands; these routes let the Search panel
//! work on `bun run dev:web`.
//!
//! Each route:
//! - wraps results in `IpcBody<T>` so the renderer facade swaps transparently.
//! - runs blocking rg calls on `tokio::task::spawn_blocking`.
//! - logs at route boundaries via `tracing`.
//!
//! **Note:** the streaming search WS endpoint (`/search/ws`) is not yet
//! implemented — the non-streaming `POST /search/content` covers the common
//! case (Search panel uses it for one-shot queries). Streaming + cancellation
//! via WS is tracked as a follow-up (bounded-scrollback + `Lossy` backpressure
//! per `terminal_ws.rs`).

use std::collections::BTreeMap;

use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    Json,
};

use crate::commands::{
    build_search_args, configure_background_command, detect_rg_path, resolve_rg_path,
    search_processes, validated_search_root, FileSearchMatch, FileSearchResponse,
    FileSearchResult, RgInfoResponse, SearchContentCancelRequest, SearchContentRequest,
    MAX_SEARCH_QUERY_LEN,
};
use crate::web::fs_api::IpcBody;
use crate::web::ws::AppState;

/// `GET /search/rg-info` — return the resolved ripgrep binary info. Reuses
/// `crate::commands::resolve_rg_path` (same function the
/// `#[tauri::command] search_get_rg_info` calls). Returns
/// `IpcBody::ok(RgInfoResponse)`.
pub async fn rg_info(State(_state): State<AppState>) -> impl IntoResponse {
    let (resolved_path, source) = resolve_rg_path();
    let exists = std::path::PathBuf::from(&resolved_path).exists();
    (
        StatusCode::OK,
        Json(IpcBody::ok(RgInfoResponse {
            sidecar_binary_name: "rg".to_string(),
            resolved_path,
            source,
            exists,
        })),
    )
}

/// `POST /search/content` — one-shot content search. Reuses the same ripgrep
/// logic as the desktop `search_content` command: `validated_search_root` +
/// `build_search_args` + `detect_rg_path` + JSON output parsing. Returns
/// `IpcBody::ok(FileSearchResponse)` or
/// `IpcBody::err(msg, "SEARCH_ERROR" | "PATH_VALIDATION_FAILED")`.
pub async fn content(
    State(state): State<AppState>,
    Json(req): Json<SearchContentRequest>,
) -> impl IntoResponse {
    let trimmed_query = req.query.trim().to_string();
    if trimmed_query.is_empty() {
        return (
            StatusCode::OK,
            Json(IpcBody::ok(FileSearchResponse {
                results: vec![],
                truncated: false,
                scanned_files: 0,
                failed_files: 0,
            })),
        );
    }

    let query_char_count = trimmed_query.chars().count();
    if query_char_count > MAX_SEARCH_QUERY_LEN {
        tracing::warn!(
            "[Security] Search query rejected: length {} exceeds limit of {}",
            query_char_count,
            MAX_SEARCH_QUERY_LEN
        );
        return (
            StatusCode::OK,
            Json(IpcBody::<FileSearchResponse>::err(
                format!(
                    "Search query too long: {} characters (max {})",
                    query_char_count, MAX_SEARCH_QUERY_LEN
                ),
                "QUERY_TOO_LONG",
            )),
        );
    }

    let validated_root = match validated_search_root(&req.scope_root, &req.root_path) {
        Ok(path) => path,
        Err(e) => {
            tracing::warn!(
                "[Security] Content search rejected: scope='{}' root='{}': {}",
                req.scope_root,
                req.root_path,
                e
            );
            return (
                StatusCode::OK,
                Json(IpcBody::<FileSearchResponse>::err(
                    format!("Invalid search path: {}", e),
                    "PATH_VALIDATION_FAILED",
                )),
            );
        }
    };

    // Enforce `project_root` containment (web-server security boundary). The
    // Acceptance Criteria require `/search/*` to reject paths outside
    // `project_root` with `OUTSIDE_PROJECT_ROOT`, mirroring `/git/*`. Both sides
    // are canonicalized (`project_root` at startup, the search root here) so
    // `starts_with` is reliable across platforms.
    let canonical_root = match std::path::Path::new(&validated_root).canonicalize() {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(
                "[Security] Content search rejected: cannot canonicalize root '{}': {}",
                validated_root,
                e
            );
            return (
                StatusCode::OK,
                Json(IpcBody::<FileSearchResponse>::err(
                    format!("Invalid search root: {e}"),
                    "PATH_VALIDATION_FAILED",
                )),
            );
        }
    };
    if let Some(err) = crate::web::git_api::ensure_within_project_root::<FileSearchResponse>(
        &canonical_root,
        &state.project_root,
    ) {
        tracing::warn!(
            "[Security] Content search rejected: root '{}' outside project_root",
            canonical_root.display()
        );
        return (StatusCode::OK, Json(err));
    }

    let max_files_with_matches: usize = 100;
    let max_matches_per_file: usize = 30;
    let args = build_search_args(&trimmed_query, &validated_root, max_matches_per_file);

    let result = tokio::task::spawn_blocking(move || -> Result<FileSearchResponse, (String, &'static str)> {
        let rg_path = detect_rg_path();
        let mut rg_command = std::process::Command::new(&rg_path);
        rg_command.args(args);
        configure_background_command(&mut rg_command);
        let output = match rg_command.output() {
            Ok(o) => o,
            Err(e) => {
                return Err((
                    format!("rg spawn failed (path: {}): {}", rg_path, e),
                    "SEARCH_ERROR",
                ))
            }
        };

        let code = output.status.code();
        // rg exits 1 when it finds no matches (a successful search with 0
        // results) — treat only `>1` or signal-death (`None`) as failure so a
        // killed rg does not return partial/empty stdout as a complete success.
        if code.is_none() || code.is_some_and(|c| c > 1) {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            return Err((
                format!("rg failed (exit {code:?}): {stderr}"),
                "SEARCH_ERROR",
            ));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut grouped: BTreeMap<String, Vec<FileSearchMatch>> = BTreeMap::new();
        let mut truncated = false;

        for line in stdout.lines() {
            let parsed: serde_json::Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            if parsed.get("type").and_then(|v| v.as_str()) != Some("match") {
                continue;
            }

            let file_path = match parsed
                .get("data")
                .and_then(|d| d.get("path"))
                .and_then(|p| p.get("text"))
                .and_then(|t| t.as_str())
            {
                Some(p) => p.replace('\\', "/"),
                None => continue,
            };

            let line_number = match parsed
                .get("data")
                .and_then(|d| d.get("line_number"))
                .and_then(|n| n.as_u64())
            {
                Some(n) => n as usize,
                None => continue,
            };

            let line_text = parsed
                .get("data")
                .and_then(|d| d.get("lines"))
                .and_then(|l| l.get("text"))
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .trim_end_matches(['\r', '\n'])
                .to_string();

            if !grouped.contains_key(&file_path) {
                if grouped.len() >= max_files_with_matches {
                    truncated = true;
                    break;
                }
                grouped.insert(file_path.clone(), Vec::new());
            }

            if let Some(matches) = grouped.get_mut(&file_path) {
                if matches.len() >= max_matches_per_file {
                    truncated = true;
                    continue;
                }
                matches.push(FileSearchMatch {
                    line_number,
                    line_text,
                });
            }
        }

        let results: Vec<FileSearchResult> = grouped
            .into_iter()
            .map(|(file_path, matches)| FileSearchResult { file_path, matches })
            .collect();

        Ok(FileSearchResponse {
            results,
            truncated,
            scanned_files: 0,
            failed_files: 0,
        })
    })
    .await
    .map_err(|e| format!("search task failed: {e}"));

    let body = match result {
        Ok(Ok(data)) => IpcBody::ok(data),
        Ok(Err((msg, code))) => IpcBody::<FileSearchResponse>::err(msg, code),
        Err(e) => IpcBody::<FileSearchResponse>::err(
            format!("search task failed: {e}"),
            "SEARCH_ERROR",
        ),
    };
    (StatusCode::OK, Json(body))
}

/// `POST /search/cancel` — cancel a running streaming search. Reuses
/// `crate::commands::search_processes` (the same static hashmap the desktop
/// `search_content_cancel` command uses). No-op (returns success) when the
/// `searchId` is not found — matching the desktop contract.
///
/// **Note:** the non-streaming `POST /search/content` handler does NOT register
/// its rg child in `search_processes()` (parity with the desktop
/// `search_content` command, which is also unregistered). So this cancel
/// route is currently inert for one-shot content searches — it becomes
/// functional once the deferred streaming `/search/ws` endpoint lands and
/// registers its streaming rg children. Left wired now for protocol parity.
pub async fn cancel(
    State(_state): State<AppState>,
    Json(req): Json<SearchContentCancelRequest>,
) -> impl IntoResponse {
    let search_id = req.search_id;
    let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut guard = search_processes().lock().map_err(|e| e.to_string())?;
        if let Some(child_handle) = guard.remove(&search_id) {
            if let Ok(mut child) = child_handle.lock() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("search cancel task failed: {e}"));

    let body = match result {
        Ok(Ok(())) => IpcBody::<()>::ok(()),
        Ok(Err(e)) => IpcBody::<()>::err(e, "SEARCH_CANCEL_ERROR"),
        Err(e) => IpcBody::<()>::err(format!("search cancel task failed: {e}"), "SEARCH_CANCEL_ERROR"),
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
    use axum::routing::{get, post};
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
            .route("/search/rg-info", get(rg_info))
            .route("/search/content", post(content))
            .route("/search/cancel", post(cancel))
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

    async fn post_json(
        state: AppState,
        uri: &str,
        body: &serde_json::Value,
    ) -> axum::http::Response<Body> {
        let bytes = serde_json::to_vec(body).expect("serialize body");
        test_router(state)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(uri)
                    .header("content-type", "application/json")
                    .body(Body::from(bytes))
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
    async fn rg_info_returns_info() {
        let resp = get_request(test_state(), "/search/rg-info").await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<RgInfoResponse> = body_as_json(resp.into_body()).await;
        assert!(body.success, "rg-info should succeed: {:?}", body.error);
        let data = body.data.expect("RgInfoResponse");
        assert!(!data.resolved_path.is_empty());
    }

    #[tokio::test]
    async fn content_search_empty_query_returns_empty() {
        let req = serde_json::json!({
            "scopeRoot": "/tmp",
            "rootPath": "/tmp",
            "query": ""
        });
        let resp = post_json(test_state(), "/search/content", &req).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<FileSearchResponse> = body_as_json(resp.into_body()).await;
        assert!(body.success, "empty query should succeed: {:?}", body.error);
        let data = body.data.expect("FileSearchResponse");
        assert!(data.results.is_empty());
    }

    #[tokio::test]
    async fn content_search_too_long_query_rejected() {
        let huge_query = "x".repeat(MAX_SEARCH_QUERY_LEN + 10);
        let req = serde_json::json!({
            "scopeRoot": "/tmp",
            "rootPath": "/tmp",
            "query": huge_query
        });
        let resp = post_json(test_state(), "/search/content", &req).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<FileSearchResponse> = body_as_json(resp.into_body()).await;
        assert!(!body.success, "too-long query should be rejected");
        assert_eq!(body.code.as_deref(), Some("QUERY_TOO_LONG"));
    }

    #[tokio::test]
    async fn cancel_unknown_search_id_returns_success() {
        let req = serde_json::json!({ "searchId": "nonexistent-id" });
        let resp = post_json(test_state(), "/search/cancel", &req).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<()> = body_as_json(resp.into_body()).await;
        assert!(body.success, "cancel of unknown id should succeed");
    }
}
