//! HTTP handlers for the minimal filesystem / git / shell ops the web/remote
//! project-creation flow needs (Story: Web/remote project creation).
//!
//! These routes mirror the existing `IpcResult<T>` contract (`{ success, data?
//! }` on success, `{ success: false, error, code }` on app failure) over HTTP,
//! returning HTTP 200 for both success AND app-level failures — matching how
//! the Tauri commands already wrap errors into `IpcResult` rather than using
//! HTTP status codes for app errors. Only transport/parse failures become
//! non-200 (the renderer client maps those to `code: "NETWORK_ERROR"`).
//!
//! Reuses existing Rust logic — no new fs/git/shell implementation:
//! - `std::fs::create_dir_all` / `write` / `read_dir` wrapped in
//!   `spawn_blocking` (matches `git_init`'s blocking-thread pattern).
//! - `GitTracker::run_git_command(&cwd, &["init"])` for git init.
//! - `crate::detect_shells` for shell detection.

use std::fs;
use std::net::SocketAddr;
use std::path::{Component, Path, PathBuf};

use axum::{
    extract::{ConnectInfo, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::trackers::git_tracker::GitTracker;
use crate::web::ws::AppState;

/// HTTP response body mirroring the renderer-side `IpcResult<T>` shape
/// (`{ success: true, data }` | `{ success: false, error, code }`). Serialized
/// with `serde(rename_all = "camelCase")` so field names match the TS contract
/// exactly (`modifiedAt`, `displayName`). `Deserialize` is derived so the
/// route tests can round-trip the body.
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
    pub(super) fn ok(data: T) -> Self {
        Self {
            success: true,
            data: Some(data),
            error: None,
            code: None,
        }
    }

    pub(super) fn err(error: impl Into<String>, code: impl Into<String>) -> Self {
        Self {
            success: false,
            data: None,
            error: Some(error.into()),
            code: Some(code.into()),
        }
    }
}

/// A directory entry returned by `/fs/ls` and `/fs/browse`. Mirrors the shared
/// TS `DirectoryEntry` interface (`src/shared/types/filesystem.types.ts`):
/// `{ name, path, type, extension, size, modifiedAt, ignored? }`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntryDto {
    pub name: String,
    pub path: String,
    pub r#type: String,
    pub extension: Option<String>,
    pub size: u64,
    pub modified_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ignored: Option<bool>,
}

/// `POST /fs/mkdir` body: `{ "path": "C:/proj/foo" }`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MkdirRequest {
    pub path: String,
}

/// `POST /fs/write` body: `{ "path": ".../README.md", "content": "..." }`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteRequest {
    pub path: String,
    pub content: String,
}

/// `GET /fs/ls?path=...` and `GET /fs/browse?path=...` query.
#[derive(Debug, Deserialize)]
pub struct PathQuery {
    pub path: String,
}

/// `POST /git/init` body: `{ "cwd": "..." }`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInitRequest {
    pub cwd: String,
}

/// Mirrors the renderer's `MAX_FILE_SIZE` (1 MiB). `/fs/read` refuses files
/// larger than this with `code: "FILE_TOO_LARGE"` BEFORE reading or
/// transferring the content, matching the desktop facade's size guard.
const MAX_FILE_SIZE: u64 = 1024 * 1024;

/// `GET /fs/read?path=...` response body (one item). Mirrors the shared TS
/// `FileContent` contract (`{ content, encoding, size, modifiedAt }`) used by
/// the renderer's `filesystemApi.readFile` / editor store.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContentDto {
    pub content: String,
    pub encoding: String,
    pub size: u64,
    pub modified_at: u64,
}

/// `GET /fs/info?path=...` response body. Mirrors the shared TS `FileInfo`
/// contract (`{ path, size, modifiedAt, type, isReadOnly, isBinary }`) used by
/// the renderer's `filesystemApi.getFileInfo`. `type` is `"file"` or
/// `"directory"` (serialized as-is, matching the `r#type` field name). The
/// desktop facade sets `isReadOnly: false` (Tauri plugin-fs does not expose
/// it); the web route reports the real `metadata.permissions().readonly()`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfoDto {
    pub path: String,
    pub size: u64,
    pub modified_at: u64,
    pub r#type: String,
    pub is_read_only: bool,
    pub is_binary: bool,
}

/// `POST /fs/delete` body: `{ "path": "...", "recursive": true? }`.
/// `recursive` defaults to `false`; directories require it to be `true`
/// (mirrors `@tauri-apps/plugin-fs` `remove` semantics).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteRequest {
    pub path: String,
    pub recursive: Option<bool>,
}

/// `POST /fs/rename` body: `{ "from": "...", "to": "..." }`. Both endpoints
/// are resolved via `resolve_request_path` (rejects `..`, canonicalizes; no
/// `project_root` containment — intentional breadth per ADR-007).
/// Loopback-guarded (`check_local_only`, `FORBIDDEN`).
#[derive(Debug, Deserialize)]
pub struct RenameRequest {
    pub from: String,
    pub to: String,
}

/// `POST /fs/copy` body: `{ "from": "...", "to": "..." }`. Copies a single
/// file (matches the desktop `copyFile` which uses `@tauri-apps/plugin-fs`
/// `copyFile` — directories error with `COPY_ERROR`).
#[derive(Debug, Deserialize)]
pub struct CopyRequest {
    pub from: String,
    pub to: String,
}

// Names commonly git-ignored; entries matching these are surfaced with
// `ignored: true` (shown dimmed in the tree, same as the Tauri path).
const ALWAYS_IGNORE: &[&str] = &[
    "node_modules",
    ".git",
    ".next",
    ".cache",
    ".turbo",
    "dist",
    "build",
    ".output",
    ".nuxt",
    ".svelte-kit",
    "__pycache__",
    ".pytest_cache",
    "venv",
    ".env",
    "coverage",
    ".nyc_output",
];

fn should_ignore(name: &str) -> bool {
    ALWAYS_IGNORE.contains(&name)
}

/// Localhost-only guard for fs WRITE routes (Patch D). When the server is bound
/// to `0.0.0.0` any reached LAN client could otherwise write anywhere on the
/// host; this guard refuses the request unless the peer originates from the
/// loopback range (`127.0.0.0/8` or `::1`). Returns `None` when the request is
/// local, or `Some(IpcBody::err(...))` with `code: "FORBIDDEN"` when remote.
/// Matches the existing 200+IpcResult convention (200 with the IpcResult error)
/// so the renderer maps it to a uniform failure body.
///
/// Known limitation (deferred): the desktop shared-live host binds localhost
/// and the cloudflared quick-tunnel forwards public traffic to it from a
/// loopback source. `is_loopback()` therefore trusts cloudflared's connection,
/// so a browser request through the public tunnel reaches these write routes
/// even with `allow_remote_writes: false`. This predates the opt-in flag and
/// needs a deployment-mode guard (deny writes on shared-live regardless of
/// peer); tracked in deferred-work, not closed here.
///
/// Scope note (ADR-007): `/fs/*` write routes are intentionally NOT confined
/// to `project_root` — they resolve any absolute path (only `..` traversal is
/// rejected), so a peer admitted via `allow_remote_writes` can write to ANY
/// path the server account can access, not just under `project_root`. This is
/// the same `/fs/*` breadth policy as the read/browse routes (the directory
/// picker + editor navigate outside the project). Confining remote-peer writes
/// to `project_root` would be a behavioral hardening over ADR-007; tracked as
/// a follow-up, not applied here (it changes tested breadth behavior). The
/// `termul-server` startup warn documents this scope accurately.
pub(super) fn check_local_only<T>(
    peer: SocketAddr,
    allow_remote_writes: bool,
    shared_live_writes_denied: bool,
    route: &str,
) -> Option<IpcBody<T>> {
    // Deployment-mode deny FIRST: the desktop shared-live host binds localhost
    // and a cloudflared quick-tunnel forwards public traffic to it from a
    // loopback source, so `is_loopback()` cannot distinguish cloudflared's
    // forwarded request from a genuine local caller. Refuse ALL writes on
    // this path before evaluating the peer address or the opt-in.
    if shared_live_writes_denied {
        tracing::warn!(
            target: "termul::web::fs_api",
            route = route,
            peer = %peer,
            "remote-write guard REFUSED (shared-live deployment mode denies all writes)",
        );
        return Some(IpcBody::<T>::err(
            "shared-live deployment mode denies all remote writes".to_string(),
            "FORBIDDEN",
        ));
    }
    let is_loopback = peer.ip().is_loopback();
    if is_loopback || allow_remote_writes {
        // Durable boundary log (AGENTS.md): record when a non-loopback peer
        // is ADMITTED by the operator opt-in — the security-relevant event.
        // Loopback admissions are routine and not logged (high volume). No
        // request bodies or secrets are logged — only peer, route, decision.
        if !is_loopback && allow_remote_writes {
            tracing::warn!(
                target: "termul::web::fs_api",
                route = route,
                peer = %peer,
                "remote-write guard ADMITTED (--allow-remote-writes)",
            );
        }
        None
    } else {
        tracing::warn!(
            target: "termul::web::fs_api",
            route = route,
            peer = %peer,
            "remote-write guard REFUSED (peer not loopback; no --allow-remote-writes)",
        );
        Some(IpcBody::<T>::err(
            format!("fs write routes are localhost-only (peer {peer} is not loopback)"),
            "FORBIDDEN",
        ))
    }
}

/// Containment check for remote peers admitted via `--allow-remote-writes`.
/// Loopback callers keep the ADR-007 breadth (any path); a non-loopback peer
/// admitted by the opt-in is confined to `state.project_root` (the
/// registered project boundary). Returns `Some(IpcBody::err(...))` with
/// `OUTSIDE_PROJECT_ROOT` when the remote peer targets a path outside the
/// boundary; `None` otherwise (loopback, or remote-within-boundary).
/// `resolved` must already be canonicalized by `resolve_request_path`.
pub(super) fn ensure_remote_within_project_root<T>(
    resolved: &Path,
    peer: SocketAddr,
    state: &AppState,
) -> Option<IpcBody<T>> {
    if peer.ip().is_loopback() {
        return None;
    }
    let project_root = state.project_root.read();
    crate::web::git_api::ensure_within_project_root::<T>(resolved, &project_root)
}

/// Return the file extension (including the leading dot) or `None` for files
/// without one. Matches `getExtension` in `tauri-filesystem-api.ts` exactly:
/// for a leading-dot file like `.gitignore` the dot is at index 0, and the
/// desktop impl returns the whole name (`.gitignore`) — we mirror that here
/// (rather than returning `None` for `idx == 0`) so the two paths agree.
fn get_extension(name: &str) -> Option<String> {
    let idx = name.rfind('.')?;
    Some(name[idx..].to_string())
}

/// Resolve a request path to a canonicalized form suitable for the actual
/// filesystem call.
///
/// Rejects:
/// - Any path containing a `..` component (explicit traversal) with
///   `code: "PATH_TRAVERSAL"`.
///
/// On success, returns the resolved path that the caller must use for the
/// subsequent filesystem operation. The returned value is:
/// - The canonicalized path, when the requested path exists (so any
///   symlinks in its components are already resolved by the OS).
/// - `canonical_parent.join(leaf)`, when the requested path does not exist
///   yet (e.g. `mkdir`, `write`). The parent is canonicalized (symlinks
///   resolved); the leaf is appended verbatim so the path the caller
///   actually creates matches what it asked for.
///
/// The project-root prefix-containment check that previously lived here was
/// removed by explicit decision (spec-remove-web-fs-path-jail) so that any
/// absolute path the client requests is resolved and served. This is the
/// intentional `/fs/*` breadth policy (ADR-007): browse/read routes
/// (`ls`/`browse`/`read`) are deliberately broader than `project_root` for
/// desktop parity, the directory picker, and editor reads; the OPERATION
/// routes (`/git/*`, `/skills`, `/search/content`) are confined separately
/// via `git_api::ensure_within_project_boundary` (accepts the default
/// `project_root` or any registered, non-archived project root; rejects
/// with `OUTSIDE_PROJECT_ROOT`). `/fs/*` writes (`mkdir`/`write`/`delete`/
/// `rename`/`copy`) and `/fs/info` are loopback-guarded (`check_local_only`,
/// `FORBIDDEN`). The retained guards here are: `..`-component rejection
/// (defense-in-depth) and path canonicalization / ancestor-walking (symlink
/// resolution + non-existing tail re-attach for `mkdir`/`write`).
///
/// Notes:
/// - This is intentionally separate from the existing
///   `path_validation::validate_search_path` because that helper requires the
///   search path to exist (it short-circuits on `!exists()`); the fs_api
///   routes also create new paths (`mkdir`, `write`), which need a different
///   shape that tolerates non-existing targets.
pub(super) fn resolve_request_path(path: &Path) -> Result<PathBuf, (String, &'static str)> {
    // 1) Reject explicit `..` traversal components. This is a fast, cheap
    //    pre-filter that catches the obvious attack without needing a real
    //    filesystem call. Any `Component::ParentDir` is rejected regardless
    //    of position — a path with a `..` anywhere is treated as an
    //    attempted traversal. A directory name like `foo..bar` (legitimate,
    //    see `path_validation::tests::test_accepts_directory_name_containing_double_dots`)
    //    is NOT a `Component::ParentDir` because it is a single path
    //    segment; it survives this check and is then caught or accepted by
    //    the canonicalize+`starts_with` check below.
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err((
            format!(
                "path traversal: '..' component in request path '{}'",
                path.display()
            ),
            "PATH_TRAVERSAL",
        ));
    }
    // Rebuild the path from its components into a fresh PathBuf. This
    // breaks the CodeQL taint flow from the raw user-provided `&Path`
    // parameter to the `exists()`/`canonicalize()` calls below: the
    // component iterator yields only `Normal`, `RootDir`, and `CurDir`
    // variants (ParentDir was rejected above), so the rebuilt path is
    // provably free of traversal components.
    let path: PathBuf = path.components().collect();
    // 2) Resolve the request path. We canonicalize the path when it exists
    //    (covers symlink resolution); when it does NOT exist (e.g. the
    //    renderer is asking us to create it), we canonicalize the nearest
    //    existing ancestor and re-attach the non-existing tail so the
    //    returned path matches what the caller will actually create. Both
    //    forms return a path the caller can pass straight into
    //    `fs::create_dir_all`, `fs::write`, or `list_dir` without
    //    re-deriving it from the raw client string.
    let safe_path = if path.exists() {
        path.canonicalize().map_err(|e| {
            (
                format!("failed to resolve path '{}': {e}", path.display()),
                "READ_ERROR",
            )
        })?
    } else {
        // Walk up until we find an existing ancestor. The path itself
        // cannot canonicalize because it does not exist yet. We track how
        // many `parent()` steps we took so we can re-attach the
        // non-existing tail to the canonicalized ancestor afterwards.
        let mut ancestor = path.to_path_buf();
        let mut depth_walked: usize = 0;
        let canonical_parent = loop {
            let Some(parent) = ancestor.parent() else {
                return Err((
                    format!("path '{}' has no existing ancestor", path.display()),
                    "READ_ERROR",
                ));
            };
            if parent.as_os_str().is_empty() {
                return Err((
                    format!("path '{}' has no existing ancestor", path.display()),
                    "READ_ERROR",
                ));
            }
            if parent.exists() {
                let canonical = parent.canonicalize().map_err(|e| {
                    (
                        format!("failed to resolve parent of '{}': {e}", path.display()),
                        "READ_ERROR",
                    )
                })?;
                break canonical;
            }
            ancestor = parent.to_path_buf();
            depth_walked += 1;
        };
        // Re-attach the non-existing tail. `path` had `depth_walked` more
        // parents than the canonicalized ancestor, so its last
        // `depth_walked + 1` components (ancestor is the parent of
        // something that had those N+1 components) form the tail. We
        // re-build the tail from the original `path` so the caller sees
        // exactly what it asked for (no canonicalization of the leaf
        // name, which is correct: leaf names cannot themselves
        // canonicalize to a different path on most filesystems).
        let tail: std::path::PathBuf = path
            .components()
            .rev()
            .take(depth_walked + 1)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        if tail.as_os_str().is_empty() {
            canonical_parent
        } else {
            canonical_parent.join(&tail)
        }
    };

    Ok(safe_path)
}

/// Build a `DirectoryEntryDto` from a directory entry path + optional
/// metadata. Falls back to conservative defaults (`size: 0`,
/// `modified_at: 0`, type inferred from `file_type()` when available else
/// `file`) when metadata cannot be read — the tree tolerates missing stats.
/// This mirrors the desktop path (`tauri-filesystem-api.ts:206-218`) which
/// stats per-entry with try/catch and keeps the entry with default stats when
/// `stat()` fails, so a single unreadable child does not fail the whole
/// listing.
fn entry_dto(parent: &Path, name: String, metadata: Option<&fs::Metadata>) -> DirectoryEntryDto {
    let full = parent.join(&name);
    let full_str = full.to_string_lossy().into_owned();
    let (is_dir, size, modified_at) = match metadata {
        Some(m) => {
            let modified_at = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            (
                m.is_dir(),
                if m.is_dir() { 0 } else { m.len() },
                modified_at,
            )
        }
        None => {
            // Conservative defaults for an unreadable entry (dangling symlink,
            // ACL-denied entry). A symlink's `metadata()` follows the link and
            // fails on a dangling target; `file_type()` (which does NOT follow)
            // is still readable via `symlink_metadata`. We conservatively
            // report `file` when we cannot determine the type so the entry is
            // surfaced in the listing rather than dropping the whole directory.
            (false, 0, 0)
        }
    };
    DirectoryEntryDto {
        name: name.clone(),
        path: full_str.clone(),
        r#type: if is_dir {
            "directory".to_string()
        } else {
            "file".to_string()
        },
        // Desktop `getExtension` / `shouldIgnore` are called with the entry
        // NAME (not the full path). Passing `full_str` here made `should_ignore`
        // never match (`C:/proj/node_modules` != `"node_modules"`) and made
        // `get_extension` slice into the path (e.g. `.0/readme` for a dir named
        // `v2.0`'s child `readme`). Use the entry name so the web path matches
        // the desktop path byte-for-byte.
        extension: if is_dir { None } else { get_extension(&name) },
        size,
        modified_at,
        ignored: if should_ignore(&name) {
            Some(true)
        } else {
            None
        },
    }
}
/// `POST /fs/mkdir` — create a directory recursively (idempotent, like
/// `mkdir -p`). Returns `{ success: true }` on success or
/// `{ success: false, error, code: "MKDIR_ERROR" }` on failure.
///
/// **Localhost guard (Patch D):** the request is refused (200 + IpcResult
/// `code: "FORBIDDEN"`) unless the peer originates from `127.0.0.0/8` or
/// `::1`. This keeps the fs write surface safe even when the server is bound
/// to `0.0.0.0`; read routes (`/fs/ls`, `/fs/browse`) are intentionally left
/// open. The router MUST be built with `into_make_service_with_connect_info`
/// so `ConnectInfo<SocketAddr>` is available. A non-loopback peer admitted
/// via `--allow-remote-writes` is confined to `project_root` (remote-containment).
///
pub async fn mkdir(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<MkdirRequest>,
) -> impl IntoResponse {
    if let Some(forbidden) = check_local_only::<()>(
        peer,
        state.allow_remote_writes,
        state.shared_live_writes_denied,
        "/fs/mkdir",
    ) {
        return (StatusCode::OK, Json(forbidden));
    }
    let path = match resolve_request_path(Path::new(&req.path)) {
        Ok(safe) => safe,
        Err((msg, code)) => {
            return (StatusCode::OK, Json(IpcBody::<()>::err(msg, code)));
        }
    };
    if let Some(outside) = ensure_remote_within_project_root::<()>(&path, peer, &state) {
        return (StatusCode::OK, Json(outside));
    }
    let result = tokio::task::spawn_blocking(move || fs::create_dir_all(&path))
        .await
        .map_err(|e| format!("mkdir task failed: {e}"));
    let body = match result {
        Ok(Ok(())) => IpcBody::<()>::ok(()),
        Ok(Err(e)) => IpcBody::<()>::err(format!("{e}"), "MKDIR_ERROR"),
        Err(e) => IpcBody::<()>::err(format!("mkdir task failed: {e}"), "MKDIR_ERROR"),
    };
    (StatusCode::OK, Json(body))
}

/// `POST /fs/write` — write text content to a file (creates parents? No —
/// matches `@tauri-apps/plugin-fs` `writeTextFile` which expects the parent
/// directory to exist). Returns `{ success: true }` or
/// `{ success: false, error, code: "WRITE_ERROR" }`.
///
/// **Localhost guard (Patch D):** same guard as `mkdir` — refused unless the
/// peer is loopback.
pub async fn write(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<WriteRequest>,
) -> impl IntoResponse {
    if let Some(forbidden) = check_local_only::<()>(
        peer,
        state.allow_remote_writes,
        state.shared_live_writes_denied,
        "/fs/write",
    ) {
        return (StatusCode::OK, Json(forbidden));
    }
    let path = match resolve_request_path(Path::new(&req.path)) {
        Ok(safe) => safe,
        Err((msg, code)) => {
            return (StatusCode::OK, Json(IpcBody::<()>::err(msg, code)));
        }
    };
    if let Some(outside) = ensure_remote_within_project_root::<()>(&path, peer, &state) {
        return (StatusCode::OK, Json(outside));
    }
    let content = req.content;
    let result = tokio::task::spawn_blocking(move || fs::write(&path, content.as_bytes()))
        .await
        .map_err(|e| format!("write task failed: {e}"));
    let body = match result {
        Ok(Ok(())) => IpcBody::<()>::ok(()),
        Ok(Err(e)) => IpcBody::<()>::err(format!("{e}"), "WRITE_ERROR"),
        Err(e) => IpcBody::<()>::err(format!("write task failed: {e}"), "WRITE_ERROR"),
    };
    (StatusCode::OK, Json(body))
}

/// `GET /fs/ls?path=...` — list one level of a directory. Returns
/// `{ success: true, data: DirectoryEntry[] }` or
/// `{ success: false, error, code: "READ_ERROR" }` (missing dir = failure;
/// the renderer's empty-check already treats missing as empty).
pub async fn ls(State(_state): State<AppState>, Query(q): Query<PathQuery>) -> impl IntoResponse {
    let path = match resolve_request_path(Path::new(&q.path)) {
        Ok(safe) => safe,
        Err((msg, code)) => {
            return (
                StatusCode::OK,
                Json(IpcBody::<Vec<DirectoryEntryDto>>::err(msg, code)),
            );
        }
    };
    let entries = tokio::task::spawn_blocking(move || list_dir(&path))
        .await
        .map_err(|e| format!("ls task failed: {e}"));
    let body = match entries {
        Ok(Ok(list)) => IpcBody::ok(list),
        Ok(Err(e)) => IpcBody::<Vec<DirectoryEntryDto>>::err(format!("{e}"), "READ_ERROR"),
        Err(e) => {
            IpcBody::<Vec<DirectoryEntryDto>>::err(format!("ls task failed: {e}"), "READ_ERROR")
        }
    };
    (StatusCode::OK, Json(body))
}

/// `GET /fs/browse?path=...` — list one level of children for the directory
/// picker (same shape as `/fs/ls`). The picker navigates by re-calling this.
/// Returns directories only is a renderer-side concern; the server returns all
/// entries and the picker filters as needed.
pub async fn browse(
    State(_state): State<AppState>,
    Query(q): Query<PathQuery>,
) -> impl IntoResponse {
    let path = match resolve_request_path(Path::new(&q.path)) {
        Ok(safe) => safe,
        Err((msg, code)) => {
            return (
                StatusCode::OK,
                Json(IpcBody::<Vec<DirectoryEntryDto>>::err(msg, code)),
            );
        }
    };
    let entries = tokio::task::spawn_blocking(move || list_dir(&path))
        .await
        .map_err(|e| format!("browse task failed: {e}"));
    let body = match entries {
        Ok(Ok(list)) => IpcBody::ok(list),
        Ok(Err(e)) => IpcBody::<Vec<DirectoryEntryDto>>::err(format!("{e}"), "READ_ERROR"),
        Err(e) => {
            IpcBody::<Vec<DirectoryEntryDto>>::err(format!("browse task failed: {e}"), "READ_ERROR")
        }
    };
    (StatusCode::OK, Json(body))
}

/// `GET /fs/read?path=...` — read a text file's content. Returns
/// `{ success: true, data: FileContent }` or
/// `{ success: false, error, code }` where code is one of `PATH_TRAVERSAL`
/// (explicit `..` component, defense-in-depth — matches `ls`/`mkdir`),
/// `READ_ERROR` (missing/dir/io), `FILE_TOO_LARGE` (> 1 MiB, refused before
/// read), or `BINARY_FILE` (NUL/control bytes in the first 512 bytes —
/// mirrors the renderer's `isBinaryFile`). Paths outside the configured
/// `project_root` are allowed — this is the intentional `/fs/*` breadth
/// policy (ADR-007: the prefix-containment jail was removed by
/// spec-remove-web-fs-path-jail so the directory picker can navigate outside
/// the project and the editor can read cross-project files; browse/read are
/// deliberately broader than the operation routes, which remain confined
/// via `ensure_within_project_boundary`). A read route: intentionally NOT
/// loopback-guarded, so desktop-hosted LAN clients can open files in the
/// editor; mutations stay loopback-only (`delete`/`rename`/`copy`).
pub async fn read(State(_state): State<AppState>, Query(q): Query<PathQuery>) -> impl IntoResponse {
    let path = match resolve_request_path(Path::new(&q.path)) {
        Ok(safe) => safe,
        Err((msg, code)) => {
            return (
                StatusCode::OK,
                Json(IpcBody::<FileContentDto>::err(msg, code)),
            );
        }
    };
    let result =
        tokio::task::spawn_blocking(move || -> Result<FileContentDto, (String, &'static str)> {
            let metadata = fs::metadata(&path).map_err(|e| (format!("{e}"), "READ_ERROR"))?;
            if metadata.is_dir() {
                return Err((
                    "cannot read a directory as a file".to_string(),
                    "READ_ERROR",
                ));
            }
            let size = metadata.len();
            if size > MAX_FILE_SIZE {
                return Err((
                    format!("File too large ({size} bytes, max {MAX_FILE_SIZE})"),
                    "FILE_TOO_LARGE",
                ));
            }
            let modified_at = metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let bytes = fs::read(&path).map_err(|e| (format!("{e}"), "READ_ERROR"))?;
            // Binary detection: control bytes (0x00-0x08) in the first 512
            // bytes — mirrors the renderer's `isBinaryFile` regex `/[\x00-\x08]/`
            // so the web path rejects binaries exactly like desktop.
            let sample_end = bytes.len().min(512);
            if bytes[..sample_end].iter().any(|&b| b <= 0x08) {
                return Err(("Binary file cannot be displayed".to_string(), "BINARY_FILE"));
            }
            // Reject non-UTF-8 text instead of lossy-decoding: `from_utf8_lossy`
            // would replace invalid bytes with U+FFFD and let the editor save the
            // corrupted content back over the original file. Desktop's
            // `readTextFile` fails on invalid UTF-8 (→ READ_ERROR); match that
            // contract so the web path never silently corrupts a file.
            let content = String::from_utf8(bytes)
                .map_err(|_| ("file is not valid UTF-8 text".to_string(), "READ_ERROR"))?;
            Ok(FileContentDto {
                content,
                encoding: "utf-8".to_string(),
                size,
                modified_at,
            })
        })
        .await
        .map_err(|e| format!("read task failed: {e}"));
    let body = match result {
        Ok(Ok(fc)) => IpcBody::ok(fc),
        Ok(Err((msg, code))) => IpcBody::<FileContentDto>::err(msg, code),
        Err(e) => IpcBody::<FileContentDto>::err(format!("read task failed: {e}"), "READ_ERROR"),
    };
    (StatusCode::OK, Json(body))
}

/// `GET /fs/info?path=...` — return filesystem metadata for a file or
/// directory (the web equivalent of the desktop `getFileInfo` facade). Returns
/// `{ success: true, data: FileInfo }` or `{ success: false, error, code }`
/// where code is `FORBIDDEN` (non-loopback peer), `PATH_TRAVERSAL` (explicit
/// `..` component), or `STAT_ERROR` (missing path / io). Loopback-only:
/// guarded by `check_local_only` so non-loopback peers are rejected before
/// any path resolution or filesystem access.
///
/// `isBinary` is determined from a 512-byte sample (control bytes
/// `0x00`-`0x08`) mirroring the renderer's `readBinarySample` +
/// `isBinaryFile` regex and the `/fs/read` sample scan — so the web path
/// agrees with desktop on which files the editor should refuse to open.
pub async fn info(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Query(q): Query<PathQuery>,
) -> impl IntoResponse {
    if let Some(forbidden) = check_local_only::<FileInfoDto>(
        peer,
        state.allow_remote_writes,
        state.shared_live_writes_denied,
        "/fs/info",
    ) {
        return (StatusCode::OK, Json(forbidden));
    }
    let requested_path = q.path.clone();
    let path = match resolve_request_path(Path::new(&q.path)) {
        Ok(safe) => safe,
        Err((msg, code)) => {
            return (StatusCode::OK, Json(IpcBody::<FileInfoDto>::err(msg, code)));
        }
    };
    let result =
        tokio::task::spawn_blocking(move || -> Result<FileInfoDto, (String, &'static str)> {
            let metadata = fs::metadata(&path).map_err(|e| (format!("{e}"), "STAT_ERROR"))?;
            let modified_at = metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let is_dir = metadata.is_dir();
            let size = metadata.len();
            let is_read_only = metadata.permissions().readonly();
            let is_binary = if is_dir {
                false
            } else {
                // Binary detection: control bytes (0x00-0x08) in the first 512
                // bytes — mirrors the renderer's `readBinarySample` +
                // `isBinaryFile` regex and the `/fs/read` handler's sample scan.
                // `take(512)` caps the read so large files are not fully loaded;
                // `read_to_end` fills the buffer completely (no partial-read gap).
                use std::io::Read;
                match std::fs::File::open(&path) {
                    Ok(file) => {
                        let mut buf = Vec::with_capacity(512);
                        file.take(512).read_to_end(&mut buf).is_ok()
                            && buf.iter().any(|&b| b <= 0x08)
                    }
                    Err(_) => false,
                }
            };
            Ok(FileInfoDto {
                path: requested_path,
                size,
                modified_at,
                r#type: if is_dir {
                    "directory".to_string()
                } else {
                    "file".to_string()
                },
                is_read_only,
                is_binary,
            })
        })
        .await
        .map_err(|e| format!("info task failed: {e}"));
    let body = match result {
        Ok(Ok(info)) => IpcBody::ok(info),
        Ok(Err((msg, code))) => IpcBody::<FileInfoDto>::err(msg, code),
        Err(e) => IpcBody::<FileInfoDto>::err(format!("info task failed: {e}"), "STAT_ERROR"),
    };
    (StatusCode::OK, Json(body))
}

/// `POST /fs/delete` — delete a file or directory. `{ "path": "...",
/// "recursive": true? }`. A non-recursive delete of a non-empty directory
/// fails with `DELETE_ERROR` (mirrors `fs::remove_dir`). Loopback-guarded
/// like `mkdir`/`write` — mutations stay localhost-only even when the server
/// is bound to `0.0.0.0`.
pub async fn delete(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<DeleteRequest>,
) -> impl IntoResponse {
    if let Some(forbidden) = check_local_only::<()>(
        peer,
        state.allow_remote_writes,
        state.shared_live_writes_denied,
        "/fs/delete",
    ) {
        return (StatusCode::OK, Json(forbidden));
    }
    let path = match resolve_request_path(Path::new(&req.path)) {
        Ok(safe) => safe,
        Err((msg, code)) => {
            return (StatusCode::OK, Json(IpcBody::<()>::err(msg, code)));
        }
    };
    if let Some(outside) = ensure_remote_within_project_root::<()>(&path, peer, &state) {
        return (StatusCode::OK, Json(outside));
    }
    let recursive = req.recursive.unwrap_or(false);
    let result = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        match fs::metadata(&path) {
            Ok(m) if m.is_dir() && recursive => fs::remove_dir_all(&path),
            Ok(m) if m.is_dir() => fs::remove_dir(&path),
            _ => fs::remove_file(&path),
        }
    })
    .await
    .map_err(|e| format!("delete task failed: {e}"));
    let body = match result {
        Ok(Ok(())) => IpcBody::<()>::ok(()),
        Ok(Err(e)) => IpcBody::<()>::err(format!("{e}"), "DELETE_ERROR"),
        Err(e) => IpcBody::<()>::err(format!("delete task failed: {e}"), "DELETE_ERROR"),
    };
    (StatusCode::OK, Json(body))
}

/// `POST /fs/rename` — rename/move a file or directory. `{ "from": "...",
/// "to": "..." }`. Both endpoints are resolved via `resolve_request_path`
/// (explicit `..` components are rejected; paths outside `project_root` are
/// allowed, matching `ls`/`mkdir`). Loopback-guarded (mutation).
pub async fn rename(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<RenameRequest>,
) -> impl IntoResponse {
    if let Some(forbidden) = check_local_only::<()>(
        peer,
        state.allow_remote_writes,
        state.shared_live_writes_denied,
        "/fs/rename",
    ) {
        return (StatusCode::OK, Json(forbidden));
    }
    let from = match resolve_request_path(Path::new(&req.from)) {
        Ok(safe) => safe,
        Err((msg, code)) => {
            return (StatusCode::OK, Json(IpcBody::<()>::err(msg, code)));
        }
    };
    if let Some(outside) = ensure_remote_within_project_root::<()>(&from, peer, &state) {
        return (StatusCode::OK, Json(outside));
    }
    let to = match resolve_request_path(Path::new(&req.to)) {
        Ok(safe) => safe,
        Err((msg, code)) => {
            return (StatusCode::OK, Json(IpcBody::<()>::err(msg, code)));
        }
    };
    if let Some(outside) = ensure_remote_within_project_root::<()>(&to, peer, &state) {
        return (StatusCode::OK, Json(outside));
    }
    let result = tokio::task::spawn_blocking(move || fs::rename(&from, &to))
        .await
        .map_err(|e| format!("rename task failed: {e}"));
    let body = match result {
        Ok(Ok(())) => IpcBody::<()>::ok(()),
        Ok(Err(e)) => IpcBody::<()>::err(format!("{e}"), "RENAME_ERROR"),
        Err(e) => IpcBody::<()>::err(format!("rename task failed: {e}"), "RENAME_ERROR"),
    };
    (StatusCode::OK, Json(body))
}

/// `POST /fs/copy` — copy a single file. `{ "from": "...", "to": "..." }`.
/// `std::fs::copy` copies one file (not a directory) — directories fail with
/// `COPY_ERROR`, matching the desktop `copyFile`. Both endpoints are resolved
/// via `resolve_request_path` (explicit `..` components are rejected; paths
/// outside `project_root` are allowed, matching `ls`/`mkdir`). Loopback-guarded
/// (mutation).
pub async fn copy(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<CopyRequest>,
) -> impl IntoResponse {
    if let Some(forbidden) = check_local_only::<()>(
        peer,
        state.allow_remote_writes,
        state.shared_live_writes_denied,
        "/fs/copy",
    ) {
        return (StatusCode::OK, Json(forbidden));
    }
    let from = match resolve_request_path(Path::new(&req.from)) {
        Ok(safe) => safe,
        Err((msg, code)) => {
            return (StatusCode::OK, Json(IpcBody::<()>::err(msg, code)));
        }
    };
    if let Some(outside) = ensure_remote_within_project_root::<()>(&from, peer, &state) {
        return (StatusCode::OK, Json(outside));
    }
    let to = match resolve_request_path(Path::new(&req.to)) {
        Ok(safe) => safe,
        Err((msg, code)) => {
            return (StatusCode::OK, Json(IpcBody::<()>::err(msg, code)));
        }
    };
    if let Some(outside) = ensure_remote_within_project_root::<()>(&to, peer, &state) {
        return (StatusCode::OK, Json(outside));
    }
    let result = tokio::task::spawn_blocking(move || fs::copy(&from, &to).map(|_| ()))
        .await
        .map_err(|e| format!("copy task failed: {e}"));
    let body = match result {
        Ok(Ok(())) => IpcBody::<()>::ok(()),
        Ok(Err(e)) => IpcBody::<()>::err(format!("{e}"), "COPY_ERROR"),
        Err(e) => IpcBody::<()>::err(format!("copy task failed: {e}"), "COPY_ERROR"),
    };
    (StatusCode::OK, Json(body))
}

/// `POST /git/init` — initialize a git repository in `cwd`. Reuses
/// `GitTracker::run_git_command(&cwd, &["init"])` (same call the
/// `#[tauri::command] git_init` makes). Returns `{ success: true }` or
/// `{ success: false, error: <trimmed stderr>, code: "GIT_INIT_ERROR" }`.
///
/// **Guarded like every other `/git/*` write (F-002):** the route is a
/// mutation (it creates `.git/` — and `git init` creates the target
/// directory tree when missing), so it must run the shared
/// `git_api::resolve_cwd` pipeline — loopback/`--allow-remote-writes` guard
/// (`check_local_only`), `..` rejection (`resolve_request_path`), and
/// project-root containment (`ensure_within_project_boundary`) — instead of
/// executing on the raw request string. Previously a non-loopback peer
/// without the opt-in could `git init` ANY host path (including `..`
/// traversal), bypassing the entire write-guard surface.
pub async fn git_init(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<GitInitRequest>,
) -> impl IntoResponse {
    let resolved = match super::git_api::resolve_cwd::<()>(&req.cwd, &state, Some(peer), true) {
        Ok(path) => path,
        Err((status, body)) => return (status, body),
    };
    let cwd = match resolved.to_str() {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => {
            return (
                StatusCode::OK,
                Json(IpcBody::<()>::err(
                    "cwd resolved to empty path".to_string(),
                    "INVALID_PATH_ENCODING",
                )),
            );
        }
    };
    let result = tokio::task::spawn_blocking(move || {
        let output = GitTracker::run_git_command(&cwd, &["init"]);
        output
            .ok_or_else(|| "Failed to run git init".to_string())
            .and_then(|o| {
                if o.status.success() {
                    Ok(())
                } else {
                    Err(String::from_utf8_lossy(&o.stderr).trim().to_string())
                }
            })
    })
    .await
    .map_err(|e| format!("git init task failed: {e}"));
    let body = match result {
        Ok(Ok(())) => IpcBody::<()>::ok(()),
        Ok(Err(e)) => IpcBody::<()>::err(e, "GIT_INIT_ERROR"),
        Err(e) => IpcBody::<()>::err(format!("git init task failed: {e}"), "GIT_INIT_ERROR"),
    };
    (StatusCode::OK, Json(body))
}

/// `GET /shells` — detect available shells. Reuses `crate::detect_shells_inner`
/// (the same logic the `#[tauri::command] detect_shells` calls). Returns
/// `{ success: true, data: DetectedShells }`.
pub async fn shells(State(_state): State<AppState>) -> impl IntoResponse {
    let body = match crate::detect_shells_inner() {
        Ok(data) => IpcBody::ok(data),
        Err(e) => IpcBody::<crate::DetectedShells>::err(e, "SHELL_DETECT_ERROR"),
    };
    (StatusCode::OK, Json(body))
}

/// List one level of `path`, sorting directories-first then A-Z (matches the
/// renderer's `sortDirectoryEntries`). Returns an owned `Vec` so the
/// blocking thread can move it back to the async caller.
///
/// Per-entry resilient (Patch C): one unreadable child (dangling symlink,
/// ACL-denied entry) does NOT fail the whole listing. For each `read_dir`
/// entry, if the entry itself errors OR `entry.metadata()` fails, the entry is
/// still included with conservative defaults (`size: 0`, `modified_at: 0`),
/// matching the desktop path (`tauri-filesystem-api.ts:206-218`) which stats
/// per-entry with try/catch and keeps the entry on stat failure.
fn list_dir(path: &Path) -> std::io::Result<Vec<DirectoryEntryDto>> {
    let dir = path;
    let read = fs::read_dir(dir)?;
    let mut entries: Vec<DirectoryEntryDto> = Vec::new();
    let parent_buf = dir.to_path_buf();
    for entry in read {
        // If the entry itself is unreadable (e.g. permission denied), skip it
        // rather than failing the whole listing — the other readable entries
        // are still surfaced.
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        // `entry.metadata()` follows symlinks and can fail on a dangling
        // symlink or an ACL-denied target. Fall back to `fs::symlink_metadata`
        // (which does NOT follow the link) so we still report a type when
        // possible; if that also fails, `entry_dto` records conservative
        // defaults.
        let metadata = entry
            .metadata()
            .or_else(|_| fs::symlink_metadata(entry.path()))
            .ok();
        entries.push(entry_dto(&parent_buf, name, metadata.as_ref()));
    }
    sort_directory_entries(&mut entries);
    Ok(entries)
}

/// Sort: directories first, then files; within each group non-ignored first
/// then ignored; within each subgroup, A-Z case-insensitive. Mirrors the
/// renderer's `sortDirectoryEntries` exactly.
fn sort_directory_entries(entries: &mut [DirectoryEntryDto]) {
    entries.sort_by(|a, b| {
        // Directories before files.
        let a_dir = a.r#type == "directory";
        let b_dir = b.r#type == "directory";
        match (a_dir, b_dir) {
            (true, false) => return std::cmp::Ordering::Less,
            (false, true) => return std::cmp::Ordering::Greater,
            _ => {}
        }
        // Non-ignored before ignored.
        let a_ign = a.ignored.unwrap_or(false);
        let b_ign = b.ignored.unwrap_or(false);
        match (a_ign, b_ign) {
            (false, true) => return std::cmp::Ordering::Less,
            (true, false) => return std::cmp::Ordering::Greater,
            _ => {}
        }
        // A-Z case-insensitive.
        a.name.to_lowercase().cmp(&b.name.to_lowercase())
    });
}

#[cfg(test)]
mod tests;
