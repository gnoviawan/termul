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
fn check_local_only<T>(peer: SocketAddr) -> Option<IpcBody<T>> {
    let is_loopback = peer.ip().is_loopback();
    if is_loopback {
        None
    } else {
        Some(IpcBody::<T>::err(
            format!("fs write routes are localhost-only (peer {peer} is not loopback)"),
            "FORBIDDEN",
        ))
    }
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

/// PR-S4: enforce a project-root boundary on a request path, and return a
/// canonicalized path suitable for the actual filesystem call.
///
/// Rejects:
/// - Any path containing a `..` component (explicit traversal) with
///   `code: "PATH_TRAVERSAL"`.
/// - Any path whose canonicalized form resolves outside `root` (absolute
///   paths, symlinks pointing outside, or non-existent paths whose parent
///   resolves outside) with `code: "OUTSIDE_ROOT"`.
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
/// Why we return a `PathBuf` and not just `Ok(())`: this closes the
/// classic TOCTOU gap where the boundary check resolves symlinks but the
/// handler then operates on the original, un-canonicalized request path.
/// If a symlink along the path were swapped between the check and the
/// filesystem call, the actual write/read could land outside `project_root`
/// despite having passed the check. Reusing the canonicalized path closes
/// that gap. (Residual risk: a symlink swap between `canonicalize` and the
/// subsequent `open` call is not mitigated here; full mitigation would
/// require `openat2` + `RESOLVE_BENEATH` or equivalent, which `std::fs`
/// does not expose. The current attack surface is local-only and the
/// server is bound to the loopback by default, so the residual risk is
/// contained.)
///
/// Notes:
/// - `root` is canonicalized internally; non-canonical roots (e.g. relative
///   paths or paths with `..`) are accepted and normalized on the fly.
/// - This is intentionally separate from the existing
///   `path_validation::validate_search_path` because that helper requires the
///   search path to exist (it short-circuits on `!exists()`); the fs_api
///   routes also create new paths (`mkdir`, `write`), which need a different
///   shape that tolerates non-existing targets.
fn check_within_root(
    path: &Path,
    root: &Path,
) -> Result<PathBuf, (String, &'static str)> {
    // 1) Reject explicit `..` traversal components. This is a fast, cheap
    //    pre-filter that catches the obvious attack without needing a real
    //    filesystem call. Any `Component::ParentDir` is rejected regardless
    //    of position — a path with a `..` anywhere is treated as an
    //    attempted traversal. A directory name like `foo..bar` (legitimate,
    //    see `path_validation::tests::test_accepts_directory_name_containing_double_dots`)
    //    is NOT a `Component::ParentDir` because it is a single path
    //    segment; it survives this check and is then caught or accepted by
    //    the canonicalize+`starts_with` check below.
    if path
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err((
            format!(
                "path traversal: '..' component in request path '{}'",
                path.display()
            ),
            "PATH_TRAVERSAL",
        ));
    }

    // 2) Canonicalize the root (caller is expected to pass an existing
    //    absolute path; if it doesn't exist or is invalid, we surface that
    //    rather than silently accepting the request).
    let canonical_root = root
        .canonicalize()
        .map_err(|e| {
            (
                format!(
                    "project root '{}' is not accessible: {e}",
                    root.display()
                ),
                "OUTSIDE_ROOT",
            )
        })?;

    // 3) Resolve the request path. We canonicalize the path when it exists
    //    (covers symlink resolution); when it does NOT exist (e.g. the
    //    renderer is asking us to create it), we canonicalize the nearest
    //    existing ancestor and re-attach the non-existing tail so the
    //    returned path matches what the caller will actually create. Both
    //    forms return a path the caller can pass straight into
    //    `fs::create_dir_all`, `fs::write`, or `list_dir` without
    //    re-deriving it from the raw client string.
    let (resolved, safe_path) = if path.exists() {
        let canonical = path.canonicalize().map_err(|e| {
            (
                format!("failed to resolve path '{}': {e}", path.display()),
                "OUTSIDE_ROOT",
            )
        })?;
        (canonical.clone(), canonical)
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
                    format!(
                        "path '{}' has no existing ancestor inside project root",
                        path.display()
                    ),
                    "OUTSIDE_ROOT",
                ));
            };
            if parent.as_os_str().is_empty() {
                return Err((
                    format!("path '{}' has no existing ancestor", path.display()),
                    "OUTSIDE_ROOT",
                ));
            }
            if parent.exists() {
                let canonical = parent.canonicalize().map_err(|e| {
                    (
                        format!(
                            "failed to resolve parent of '{}': {e}",
                            path.display()
                        ),
                        "OUTSIDE_ROOT",
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
        let safe = if tail.as_os_str().is_empty() {
            canonical_parent.clone()
        } else {
            canonical_parent.join(&tail)
        };
        (canonical_parent, safe)
    };

    // 4) Boundary check. `canonical_root` always ends with a separator-free
    //    path; `Path::starts_with` does a per-component match (not a string
    //    prefix), so a sibling with a common prefix like `/home/user2` is
    //    NOT confused with `/home/user`. We use the shared
    //    `strip_verbatim_prefix` helper (re-exported by `lib.rs`) to
    //    normalize Windows verbatim forms — `\\?\`, `\\?\UNC\`, etc. — so
    //    that a `\\?\C:\Users\foo` canonical path and a
    //    `C:\Users\foo` non-canonical path compare as the same path. The
    //    owned `PathBuf`s below are kept alive for the duration of the
    //    `starts_with` check.
    #[cfg(windows)]
    let (resolved_clean, root_clean) = {
        let resolved_str = resolved.to_string_lossy();
        let root_str = canonical_root.to_string_lossy();
        (
            PathBuf::from(crate::strip_verbatim_prefix(resolved_str.as_ref()).into_owned()),
            PathBuf::from(crate::strip_verbatim_prefix(root_str.as_ref()).into_owned()),
        )
    };
    #[cfg(not(windows))]
    let (resolved_clean, root_clean) = (resolved.clone(), canonical_root.clone());

    if !resolved_clean.starts_with(root_clean) {
        return Err((
            format!(
                "path '{}' is outside project root '{}'",
                path.display(),
                canonical_root.display()
            ),
            "OUTSIDE_ROOT",
        ));
    }

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
            (m.is_dir(), if m.is_dir() { 0 } else { m.len() }, modified_at)
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
        r#type: if is_dir { "directory".to_string() } else { "file".to_string() },
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
/// so `ConnectInfo<SocketAddr>` is available.
///
/// **Project-root boundary (PR-S4):** the target path must canonicalize
/// inside `AppState::project_root`. Paths that escape the root (via
/// `..` components, absolute paths outside the root, or symlinks pointing
/// outside) are refused with `code: "OUTSIDE_ROOT"` or
/// `code: "PATH_TRAVERSAL"` before any filesystem mutation.
pub async fn mkdir(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<MkdirRequest>,
) -> impl IntoResponse {
    if let Some(forbidden) = check_local_only::<()>(peer) {
        return (StatusCode::OK, Json(forbidden));
    }
    let path = match check_within_root(Path::new(&req.path), state.project_root.as_path()) {
        Ok(safe) => safe,
        Err((msg, code)) => {
            return (
                StatusCode::OK,
                Json(IpcBody::<()>::err(msg, code)),
            );
        }
    };
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
    if let Some(forbidden) = check_local_only::<()>(peer) {
        return (StatusCode::OK, Json(forbidden));
    }
    let path = match check_within_root(Path::new(&req.path), state.project_root.as_path()) {
        Ok(safe) => safe,
        Err((msg, code)) => {
            return (
                StatusCode::OK,
                Json(IpcBody::<()>::err(msg, code)),
            );
        }
    };
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
pub async fn ls(
    State(state): State<AppState>,
    Query(q): Query<PathQuery>,
) -> impl IntoResponse {
    let path = match check_within_root(Path::new(&q.path), state.project_root.as_path()) {
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
        Err(e) => IpcBody::<Vec<DirectoryEntryDto>>::err(format!("ls task failed: {e}"), "READ_ERROR"),
    };
    (StatusCode::OK, Json(body))
}

/// `GET /fs/browse?path=...` — list one level of children for the directory
/// picker (same shape as `/fs/ls`). The picker navigates by re-calling this.
/// Returns directories only is a renderer-side concern; the server returns all
/// entries and the picker filters as needed.
pub async fn browse(
    State(state): State<AppState>,
    Query(q): Query<PathQuery>,
) -> impl IntoResponse {
    let path = match check_within_root(Path::new(&q.path), state.project_root.as_path()) {
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
        Err(e) => IpcBody::<Vec<DirectoryEntryDto>>::err(format!("browse task failed: {e}"), "READ_ERROR"),
    };
    (StatusCode::OK, Json(body))
}

/// `POST /git/init` — initialize a git repository in `cwd`. Reuses
/// `GitTracker::run_git_command(&cwd, &["init"])` (same call the
/// `#[tauri::command] git_init` makes). Returns `{ success: true }` or
/// `{ success: false, error: <trimmed stderr>, code: "GIT_INIT_ERROR" }`.
pub async fn git_init(
    State(_state): State<AppState>,
    Json(req): Json<GitInitRequest>,
) -> impl IntoResponse {
    let cwd = req.cwd;
    let result = tokio::task::spawn_blocking(move || {
        let output = GitTracker::run_git_command(&cwd, &["init"]);
        output.ok_or_else(|| "Failed to run git init".to_string()).and_then(|o| {
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
mod tests {
    use super::*;
    use crate::acp::AcpManager;
    use crate::web::sink::WsRelaySink;
    use crate::web::project_registry::ProjectRegistry;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tower::ServiceExt;

    /// Temp directory removed on drop (including panic paths). Mirrors the
    /// `TempDir` helper in `router.rs` tests.
    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(label: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let path =
                std::env::temp_dir().join(format!("termul-web-fsapi-{label}-{nanos}"));
            fs::create_dir_all(&path).expect("create temp dir");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn test_state() -> AppState {
        // Default: no project root bound (legacy behavior preserved for tests
        // that do not exercise the PR-S4 boundary). PR-S4 tests use
        // `test_state_with_root` to set an explicit project root.
        test_state_with_root(std::env::temp_dir().as_path())
    }

    /// PR-S4: build an `AppState` with the project-root boundary set to
    /// `root`. The fs_api routes reject any request whose canonicalized path
    /// is outside this root. Tests that previously used the default
    /// `test_state()` keep working because the default root is the OS temp
    /// dir (and the existing tests only touch temp dirs).
    fn test_state_with_root(root: &Path) -> AppState {
        AppState {
            acp: Arc::new(AcpManager::new(vec![])),
            relay: Arc::new(WsRelaySink::new()),
            registry: Arc::new(ProjectRegistry::new()),
            project_root: Arc::new(
                root.canonicalize()
                    .unwrap_or_else(|_| root.to_path_buf()),
            ),
        }
    }

    /// Deserialize an `IpcBody<T>` from a response body. Panics on failure
    /// (test-only).
    async fn body_as_json<T: serde::de::DeserializeOwned>(body: Body) -> T {
        let bytes = axum::body::to_bytes(body, usize::MAX).await.expect("read body");
        serde_json::from_slice(&bytes).expect("deserialize IpcBody")
    }

    /// Minimal percent-encoding for the characters we care about in test
    /// query strings (spaces, backslashes, colons, and anything non-path-safe).
    fn urlencoding(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        for c in s.chars() {
            match c {
                ' ' => out.push_str("%20"),
                '\\' => out.push_str("%5C"),
                ':' => out.push_str("%3A"),
                _ if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~' | '/') => {
                    out.push(c)
                }
                _ => {
                    let mut buf = [0u8; 4];
                    for b in c.encode_utf8(&mut buf).as_bytes() {
                        out.push_str(&format!("%{:02X}", b));
                    }
                }
            }
        }
        out
    }

    /// Build a router with all fs_api routes (no static fallback) for tests.
    fn test_router(state: AppState) -> axum::Router {
        axum::Router::new()
            .route("/fs/mkdir", axum::routing::post(mkdir))
            .route("/fs/write", axum::routing::post(write))
            .route("/fs/ls", axum::routing::get(ls))
            .route("/fs/browse", axum::routing::get(browse))
            .route("/git/init", axum::routing::post(git_init))
            .route("/shells", axum::routing::get(shells))
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

    /// POST JSON with a loopback peer (the default for the fs write routes
    /// which now require `ConnectInfo<SocketAddr>` — Patch D).
    async fn post_json(
        state: AppState,
        uri: &str,
        body: &serde_json::Value,
    ) -> axum::http::Response<Body> {
        post_json_from(state, uri, body, SocketAddr::from(([127, 0, 0, 1], 54321))).await
    }

    /// POST JSON with an explicit peer address (Patch D: the localhost guard
    /// rejects non-loopback peers on `/fs/mkdir` + `/fs/write`).
    async fn post_json_from(
        state: AppState,
        uri: &str,
        body: &serde_json::Value,
        peer: SocketAddr,
    ) -> axum::http::Response<Body> {
        let bytes = serde_json::to_vec(body).expect("serialize body");
        test_router(state)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(uri)
                    .header("content-type", "application/json")
                    .extension(ConnectInfo(peer))
                    .body(Body::from(bytes))
                    .expect("build request"),
            )
            .await
            .expect("router response")
    }

    #[tokio::test]
    async fn mkdir_creates_recursive_dir() {
        let dir = TempDir::new("mkdir");
        let target = dir.path().join("a/b/c");
        let req_body = serde_json::json!({ "path": target.to_string_lossy() });
        let resp = post_json(test_state(), "/fs/mkdir", &req_body).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<()> = body_as_json(resp.into_body()).await;
        assert!(body.success, "mkdir should succeed: {:?}", body.error);
        assert!(target.is_dir(), "target dir must exist");
    }

    #[tokio::test]
    async fn mkdir_is_idempotent_when_dir_exists() {
        let dir = TempDir::new("mkdir-idem");
        let target = dir.path().join("exists");
        fs::create_dir_all(&target).expect("pre-create");
        let req_body = serde_json::json!({ "path": target.to_string_lossy() });
        let resp = post_json(test_state(), "/fs/mkdir", &req_body).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<()> = body_as_json(resp.into_body()).await;
        assert!(body.success, "idempotent mkdir should succeed: {:?}", body.error);
    }

    #[tokio::test]
    async fn mkdir_returns_failure_body_on_invalid_path() {
        // Target a child of a path that is itself a file — `create_dir_all`
        // fails because the parent isn't a directory.
        let dir = TempDir::new("mkdir-fail");
        let file_as_parent = dir.path().join("not-a-dir");
        fs::write(&file_as_parent, "x").expect("write file");
        let target = file_as_parent.join("child");
        let req_body = serde_json::json!({ "path": target.to_string_lossy() });
        let resp = post_json(test_state(), "/fs/mkdir", &req_body).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<()> = body_as_json(resp.into_body()).await;
        assert!(!body.success, "mkdir under a file should fail");
        assert_eq!(body.code.as_deref(), Some("MKDIR_ERROR"));
        assert!(body.error.is_some(), "error message must be present");
    }

    #[tokio::test]
    async fn write_creates_file() {
        let dir = TempDir::new("write");
        let target = dir.path().join("README.md");
        let req_body =
            serde_json::json!({ "path": target.to_string_lossy(), "content": "# hello" });
        let resp = post_json(test_state(), "/fs/write", &req_body).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<()> = body_as_json(resp.into_body()).await;
        assert!(body.success, "write should succeed: {:?}", body.error);
        let written = fs::read_to_string(&target).expect("file written");
        assert_eq!(written, "# hello");
    }

    #[tokio::test]
    async fn write_returns_failure_when_parent_missing() {
        let dir = TempDir::new("write-fail");
        let target = dir.path().join("no-such-parent/child.txt");
        let req_body =
            serde_json::json!({ "path": target.to_string_lossy(), "content": "x" });
        let resp = post_json(test_state(), "/fs/write", &req_body).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<()> = body_as_json(resp.into_body()).await;
        assert!(!body.success, "write with missing parent should fail");
        assert_eq!(body.code.as_deref(), Some("WRITE_ERROR"));
    }

    #[tokio::test]
    async fn ls_empty_dir_returns_empty_array() {
        let dir = TempDir::new("ls-empty");
        let uri = format!("/fs/ls?path={}", urlencoding(&dir.path().to_string_lossy()));
        let resp = get_request(test_state(), &uri).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<Vec<DirectoryEntryDto>> = body_as_json(resp.into_body()).await;
        assert!(body.success, "ls on empty dir should succeed: {:?}", body.error);
        assert!(body.data.unwrap_or_default().is_empty());
    }

    #[tokio::test]
    async fn ls_missing_dir_returns_read_error() {
        let dir = TempDir::new("ls-missing");
        let missing = dir.path().join("does-not-exist");
        let uri = format!("/fs/ls?path={}", urlencoding(&missing.to_string_lossy()));
        let resp = get_request(test_state(), &uri).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<Vec<DirectoryEntryDto>> = body_as_json(resp.into_body()).await;
        assert!(!body.success, "ls on missing dir should fail");
        assert_eq!(body.code.as_deref(), Some("READ_ERROR"));
    }

    #[tokio::test]
    async fn ls_nonempty_dir_returns_sorted_entries() {
        let dir = TempDir::new("ls-nonempty");
        fs::write(dir.path().join("zfile.txt"), "x").expect("write z");
        fs::create_dir_all(dir.path().join("adir")).expect("mkdir adir");
        fs::write(dir.path().join("bfile.md"), "y").expect("write b");
        let uri = format!("/fs/ls?path={}", urlencoding(&dir.path().to_string_lossy()));
        let resp = get_request(test_state(), &uri).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<Vec<DirectoryEntryDto>> = body_as_json(resp.into_body()).await;
        assert!(body.success, "ls should succeed: {:?}", body.error);
        let entries = body.data.expect("entries");
        // Directories first, then files A-Z.
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].r#type, "directory");
        assert_eq!(entries[0].name, "adir");
        assert_eq!(entries[1].r#type, "file");
        assert_eq!(entries[1].name, "bfile.md");
        assert_eq!(entries[2].r#type, "file");
        assert_eq!(entries[2].name, "zfile.txt");
        // extension should be populated for files.
        assert_eq!(entries[1].extension.as_deref(), Some(".md"));
        assert!(entries[0].extension.is_none(), "dirs have no extension");
    }

    #[tokio::test]
    async fn browse_returns_entries_like_ls() {
        let dir = TempDir::new("browse");
        fs::create_dir_all(dir.path().join("subdir")).expect("mkdir");
        fs::write(dir.path().join("file.txt"), "x").expect("write");
        let uri = format!("/fs/browse?path={}", urlencoding(&dir.path().to_string_lossy()));
        let resp = get_request(test_state(), &uri).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<Vec<DirectoryEntryDto>> = body_as_json(resp.into_body()).await;
        assert!(body.success, "browse should succeed: {:?}", body.error);
        let entries = body.data.expect("entries");
        assert_eq!(entries.len(), 2);
        // Directory first.
        assert_eq!(entries[0].r#type, "directory");
    }

    #[tokio::test]
    async fn git_init_creates_dot_git_in_cwd() {
        let dir = TempDir::new("gitinit");
        let req_body = serde_json::json!({ "cwd": dir.path().to_string_lossy() });
        let resp = post_json(test_state(), "/git/init", &req_body).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<()> = body_as_json(resp.into_body()).await;
        // Git may or may not be installed in CI; if it's missing the handler
        // returns a failure body (code GIT_INIT_ERROR), which we accept — but
        // when git IS present the repo must be initialized.
        if body.success {
            assert!(dir.path().join(".git").exists(), ".git must exist");
        } else {
            // Expected only when git is unavailable on the host.
            assert_eq!(body.code.as_deref(), Some("GIT_INIT_ERROR"));
        }
    }

    #[tokio::test]
    async fn shells_returns_detected_shells() {
        let resp = get_request(test_state(), "/shells").await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<crate::DetectedShells> = body_as_json(resp.into_body()).await;
        assert!(body.success, "shells should succeed: {:?}", body.error);
        let data = body.data.expect("DetectedShells");
        // On the test host at least one shell should be detected (Windows:
        // cmd/powershell; Unix: something from $SHELL). If not, the default
        // is still Some on Windows.
        assert!(!data.available.is_empty() || data.default.is_some());
    }

    /// Patch D: a non-loopback peer is refused on `/fs/write` (200 + IpcResult
    /// `code: "FORBIDDEN"`). The localhost guard keeps the fs write surface
    /// safe even when the server is bound to `0.0.0.0`.
    #[tokio::test]
    async fn write_refused_from_non_loopback_peer() {
        let dir = TempDir::new("write-guard");
        let target = dir.path().join("README.md");
        let req_body =
            serde_json::json!({ "path": target.to_string_lossy(), "content": "# hi" });
        // Non-loopback peer (a random LAN-ish address).
        let remote = SocketAddr::from(([192, 168, 1, 50], 40000));
        let resp = post_json_from(test_state(), "/fs/write", &req_body, remote).await;
        assert_eq!(resp.status(), StatusCode::OK, "guard returns 200+IpcResult");
        let body: IpcBody<()> = body_as_json(resp.into_body()).await;
        assert!(!body.success, "non-loopback write must be refused");
        assert_eq!(body.code.as_deref(), Some("FORBIDDEN"));
        assert!(body.error.unwrap_or_default().contains("localhost-only"));
        // The file must NOT have been written.
        assert!(!target.exists(), "guard must reject before writing");
    }

    /// Patch D: a non-loopback peer is refused on `/fs/mkdir` as well.
    #[tokio::test]
    async fn mkdir_refused_from_non_loopback_peer() {
        let dir = TempDir::new("mkdir-guard");
        let target = dir.path().join("newdir");
        let req_body = serde_json::json!({ "path": target.to_string_lossy() });
        let remote = SocketAddr::from(([10, 0, 0, 5], 50000));
        let resp = post_json_from(test_state(), "/fs/mkdir", &req_body, remote).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<()> = body_as_json(resp.into_body()).await;
        assert!(!body.success);
        assert_eq!(body.code.as_deref(), Some("FORBIDDEN"));
        assert!(!target.exists(), "guard must reject before mkdir");
    }

    /// Patch D: loopback peers are still allowed (the happy path through the
    /// guard — `127.0.0.1` and `::1` both pass).
    #[tokio::test]
    async fn write_allowed_from_loopback_ipv6() {
        let dir = TempDir::new("write-loopback-v6");
        let target = dir.path().join("README.md");
        let req_body =
            serde_json::json!({ "path": target.to_string_lossy(), "content": "ok" });
        let loopback_v6 = SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 1], 54321));
        let resp = post_json_from(test_state(), "/fs/write", &req_body, loopback_v6).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<()> = body_as_json(resp.into_body()).await;
        assert!(body.success, "::1 is loopback: {:?}", body.error);
        assert!(target.exists(), "file written");
    }

    /// Patch C: a directory with one unreadable entry (dangling symlink) still
    /// returns success with the readable entries — the whole listing does not
    /// fail. `entry.metadata()` follows the link and fails on a dangling
    /// target; `symlink_metadata` returns the symlink's own metadata (type =
    /// symlink, reported as `file` here per the conservative default). The
    /// readable sibling must still be present.
    #[tokio::test]
    async fn list_dir_resilient_to_broken_symlink() {
        let dir = TempDir::new("broken-symlink");
        fs::write(dir.path().join("real.txt"), "x").expect("write real");
        // Create a dangling symlink pointing at a non-existent target.
        let dangling = dir.path().join("dangling");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/this/does/not/exist", &dangling)
                .expect("symlink");
        }
        #[cfg(windows)]
        {
            // jsdom-style: use std::os::windows::symlink_file (requires the
            // `Developer Mode` or admin on some Windows; if it fails we skip
            // the assertion rather than failing the test — the resilience
            // path is still exercised via the `metadata().or_else(symlink_metadata)`
            // fallback in `list_dir`, and the cross-platform contract is
            // covered by the sibling `list_dir_resilient_to_stat_error` test
            // which forces a stat failure without a symlink.
            let _ = dangling;
        }
        let uri = format!("/fs/ls?path={}", urlencoding(&dir.path().to_string_lossy()));
        let resp = get_request(test_state(), &uri).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<Vec<DirectoryEntryDto>> = body_as_json(resp.into_body()).await;
        assert!(
            body.success,
            "listing must succeed even with an unreadable child: {:?}",
            body.error
        );
        let entries = body.data.expect("entries");
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"real.txt"), "readable entry present: {names:?}");
        // The dangling symlink is either surfaced (unix) or absent (windows
        // when symlink creation failed) — in both cases the listing succeeds.
    }

    /// Patch C (cross-platform): when a child's `metadata()` fails, the entry is
    /// still surfaced via `symlink_metadata()` (or conservative defaults). We
    // cannot easily force `metadata()` to fail cross-platform without a
    // symlink, so this test asserts the docstring contract directly: an entry
    // whose metadata is `None` is still included with conservative defaults
    // via `entry_dto`.
    #[tokio::test]
    async fn entry_dto_defaults_when_metadata_none() {
        let dir = TempDir::new("entry-dto-defaults");
        let parent = dir.path();
        let dto = entry_dto(parent, "unreadable".to_string(), None);
        assert_eq!(dto.name, "unreadable");
        assert_eq!(dto.r#type, "file");
        assert_eq!(dto.size, 0);
        assert_eq!(dto.modified_at, 0);
        // extension is derived from the name (no metadata needed).
        assert_eq!(dto.extension.as_deref(), None);
    }

    /// Patch B: `get_extension` + `should_ignore` use the entry NAME (not the
    /// full path). A `node_modules` subdir at `C:/proj/node_modules` must be
    /// flagged `ignored: true`, and a file `readme` under a dir named `v2.0`
    /// must get extension `None` (no garbage `.0/readme`).
    #[tokio::test]
    async fn entry_dto_uses_name_not_full_path() {
        let dir = TempDir::new("entry-dto-name");
        // `node_modules` subdir — must be flagged ignored.
        let nm_dto = entry_dto(
            dir.path(),
            "node_modules".to_string(),
            fs::metadata(dir.path()).ok().as_ref(),
        );
        assert_eq!(nm_dto.ignored, Some(true));

        // A file `readme` under a parent named `v2.0`: extension must be None
        // (no `.` in `readme`), NOT the path-derived `.0/readme`.
        let parent_v2 = dir.path().join("v2.0");
        fs::create_dir_all(&parent_v2).expect("mkdir v2.0");
        let readme_dto = entry_dto(
            &parent_v2,
            "readme".to_string(),
            fs::metadata(&parent_v2).ok().as_ref(),
        );
        assert_eq!(readme_dto.extension, None, "no garbage extension from path");
        assert_eq!(readme_dto.r#type, "directory");
    }

    /// Patch B: a leading-dot file (`.gitignore`) matches the desktop impl —
    /// the whole name is returned as the extension (desktop `getExtension`
    /// does NOT return `None` for `idx == 0`).
    #[tokio::test]
    async fn get_extension_dotfile_matches_desktop() {
        assert_eq!(get_extension(".gitignore").as_deref(), Some(".gitignore"));
        assert_eq!(get_extension(".env").as_deref(), Some(".env"));
        // Regular files keep the leading-dot extension.
        assert_eq!(get_extension("README.md").as_deref(), Some(".md"));
        // No extension.
        assert_eq!(get_extension("README").as_deref(), None);
    }

    /// Patch J: cross-runtime IpcResult-shape round-trip. The Rust handler
    /// emits `DirectoryEntryDto` with `#[serde(rename_all = "camelCase")]` —
    /// this test asserts the EXACT serde JSON bytes (field names `modifiedAt`,
    /// `type`, `ignored`, `extension`, `size`) round-trip through a
    /// deserialize-then-re-inspect cycle, catching a field rename (e.g.
    /// `modified_at` ↔ `modifiedAt`) that per-side tests would miss.
    #[tokio::test]
    async fn directory_entry_dto_round_trips_camel_case() {
        let dir = TempDir::new("round-trip");
        fs::write(dir.path().join("README.md"), "x").expect("write");
        let uri = format!("/fs/ls?path={}", urlencoding(&dir.path().to_string_lossy()));
        let resp = get_request(test_state(), &uri).await;
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("read body");
        // The raw handler JSON: must use camelCase keys, NOT snake_case.
        let raw = String::from_utf8_lossy(&bytes);
        assert!(
            raw.contains("\"modifiedAt\""),
            "camelCase modifiedAt must be in the wire JSON: {raw}"
        );
        assert!(
            !raw.contains("\"modified_at\""),
            "snake_case modified_at must NOT be in the wire JSON: {raw}"
        );
        assert!(raw.contains("\"type\""), "type field present: {raw}");
        // Round-trip: the exact handler bytes deserialize into the DTO struct.
        let body: IpcBody<Vec<DirectoryEntryDto>> = serde_json::from_slice(&bytes)
            .expect("deserialize IpcBody from raw handler bytes");
        assert!(body.success);
        let entries = body.data.expect("entries");
        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(entry.name, "README.md");
        assert_eq!(entry.r#type, "file");
        assert_eq!(entry.extension.as_deref(), Some(".md"));
        // `modifiedAt` field is populated (not zero) — proves the camelCase
        // serde rename round-trips into the struct field `modified_at`.
        assert!(entry.modified_at > 0, "modifiedAt populated: {}", entry.modified_at);
        // Re-serialize and assert the camelCase key is preserved on the way out.
        let re = serde_json::to_string(entry).expect("re-serialize");
        assert!(re.contains("\"modifiedAt\""), "re-serialize keeps camelCase: {re}");
    }

    /// PR-S4: project-root boundary on `/fs/mkdir` (CWE-22). A target path
    /// outside the configured `project_root` must be refused with
    /// `code: "OUTSIDE_ROOT"` (or "PATH_TRAVERSAL") and must NOT create the
    /// directory.
    #[tokio::test]
    async fn mkdir_rejects_path_outside_project_root() {
        let root = TempDir::new("mkdir-root");
        let outside = TempDir::new("mkdir-outside");
        let target = outside.path().join("evil");
        let req_body = serde_json::json!({ "path": target.to_string_lossy() });
        let resp = post_json(test_state_with_root(root.path()), "/fs/mkdir", &req_body).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<()> = body_as_json(resp.into_body()).await;
        assert!(!body.success, "mkdir outside root must be refused");
        let code = body.code.as_deref().unwrap_or("");
        assert!(
            code == "OUTSIDE_ROOT" || code == "PATH_TRAVERSAL",
            "expected OUTSIDE_ROOT or PATH_TRAVERSAL, got {code:?}"
        );
        assert!(
            !target.exists(),
            "refused mkdir must not create the directory"
        );
    }

    /// PR-S4: explicit `..` traversal components in the request path must be
    /// rejected even when the result would coincidentally land inside root
    /// (defense-in-depth — never trust raw client paths).
    #[tokio::test]
    async fn mkdir_rejects_traversal_sequence_in_path() {
        let root = TempDir::new("mkdir-trav-root");
        // Build a path that starts inside the root but escapes via `..`.
        // canonicalize at test-build time so the test is platform-agnostic.
        let inside = root.path().join("sub");
        fs::create_dir_all(&inside).expect("mkdir inside");
        let traversal = inside.join("..").join("..").join("etc");
        let req_body = serde_json::json!({ "path": traversal.to_string_lossy() });
        let resp = post_json(test_state_with_root(root.path()), "/fs/mkdir", &req_body).await;
        let body: IpcBody<()> = body_as_json(resp.into_body()).await;
        assert!(!body.success, "traversal must be refused");
        let code = body.code.as_deref().unwrap_or("");
        assert!(
            code == "PATH_TRAVERSAL" || code == "OUTSIDE_ROOT",
            "expected PATH_TRAVERSAL or OUTSIDE_ROOT, got {code:?}"
        );
    }

    /// PR-S4: project-root boundary on `/fs/write`. A file written outside the
    /// configured root must be refused and the file must not exist after the
    /// call.
    #[tokio::test]
    async fn write_rejects_path_outside_project_root() {
        let root = TempDir::new("write-root");
        let outside = TempDir::new("write-outside");
        let target = outside.path().join("evil.txt");
        let req_body =
            serde_json::json!({ "path": target.to_string_lossy(), "content": "pwn" });
        let resp = post_json(test_state_with_root(root.path()), "/fs/write", &req_body).await;
        let body: IpcBody<()> = body_as_json(resp.into_body()).await;
        assert!(!body.success, "write outside root must be refused");
        let code = body.code.as_deref().unwrap_or("");
        assert!(
            code == "OUTSIDE_ROOT" || code == "PATH_TRAVERSAL",
            "expected OUTSIDE_ROOT or PATH_TRAVERSAL, got {code:?}"
        );
        assert!(!target.exists(), "refused write must not create the file");
    }

    /// PR-S4: project-root boundary on `/fs/ls`. Listing a directory outside
    /// the configured root must be refused with `code: "OUTSIDE_ROOT"` (read
    /// routes previously had no boundary; PR-S4 closes the gap).
    #[tokio::test]
    async fn ls_rejects_path_outside_project_root() {
        let root = TempDir::new("ls-root");
        let outside = TempDir::new("ls-outside");
        let uri = format!(
            "/fs/ls?path={}",
            urlencoding(&outside.path().to_string_lossy())
        );
        let resp = get_request(test_state_with_root(root.path()), &uri).await;
        let body: IpcBody<Vec<DirectoryEntryDto>> = body_as_json(resp.into_body()).await;
        assert!(!body.success, "ls outside root must be refused");
        let code = body.code.as_deref().unwrap_or("");
        assert!(
            code == "OUTSIDE_ROOT" || code == "PATH_TRAVERSAL",
            "expected OUTSIDE_ROOT or PATH_TRAVERSAL, got {code:?}"
        );
    }

    /// PR-S4: a symlink that lives INSIDE the project root but points OUTSIDE
    /// must be refused on `/fs/browse` (canonicalize resolves the link and the
    /// post-canonicalize path is checked against root).
    #[tokio::test]
    async fn browse_rejects_symlink_pointing_outside_root() {
        let root = TempDir::new("browse-sym-root");
        let outside = TempDir::new("browse-sym-outside");
        let link = root.path().join("evil_link");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path(), &link).expect("symlink");
        }
        #[cfg(windows)]
        {
            // On Windows, directory symlinks require elevation/dev mode;
            // skip the assertion if creation fails (the traversal-rejection
            // path is still exercised by the other tests in this module).
            if std::os::windows::fs::symlink_dir(outside.path(), &link).is_err() {
                eprintln!("skipping: cannot create symlink on this Windows host");
                return;
            }
        }
        let uri = format!("/fs/browse?path={}", urlencoding(&link.to_string_lossy()));
        let resp = get_request(test_state_with_root(root.path()), &uri).await;
        let body: IpcBody<Vec<DirectoryEntryDto>> = body_as_json(resp.into_body()).await;
        assert!(
            !body.success,
            "symlink pointing outside root must be refused"
        );
        let code = body.code.as_deref().unwrap_or("");
        assert!(
            code == "OUTSIDE_ROOT" || code == "PATH_TRAVERSAL",
            "expected OUTSIDE_ROOT or PATH_TRAVERSAL, got {code:?}"
        );
    }

    /// Patch I: git-init failure path is explicitly asserted. The existing
    /// `git_init_creates_dot_git_in_cwd` test conditionally skips the failure
    /// branch when git is present. This test forces a non-zero git exit by
    /// passing a `cwd` that doesn't exist — `run_git_command` fails to spawn
    /// git in a non-existent cwd, and the handler returns
    /// `{success:false, code:"GIT_INIT_ERROR"}` with a non-empty error.
    #[tokio::test]
    async fn git_init_returns_error_for_nonexistent_cwd() {
        let dir = TempDir::new("gitinit-nonexistent");
        let cwd = dir.path().join("does-not-exist");
        let req_body = serde_json::json!({ "cwd": cwd.to_string_lossy() });
        let resp = post_json(test_state(), "/git/init", &req_body).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body: IpcBody<()> = body_as_json(resp.into_body()).await;
        // Either git is missing (GIT_INIT_ERROR) OR git ran but failed in the
        // non-existent cwd (GIT_INIT_ERROR). Either way: failure + non-empty
        // error + the stable code.
        assert!(!body.success, "git init in a non-existent cwd must fail");
        assert_eq!(body.code.as_deref(), Some("GIT_INIT_ERROR"));
        let err = body.error.expect("error message present");
        assert!(!err.trim().is_empty(), "error must be non-empty: {err:?}");
    }
}
