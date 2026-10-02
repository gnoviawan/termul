use super::IpcResult;
use crate::path_validation;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchMatch {
    pub line_number: usize,
    pub line_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchResult {
    pub file_path: String,
    pub matches: Vec<FileSearchMatch>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchResponse {
    pub results: Vec<FileSearchResult>,
    pub truncated: bool,
    pub scanned_files: usize,
    pub failed_files: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchContentRequest {
    pub scope_root: String,
    pub root_path: String,
    pub query: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchContentStreamRequest {
    pub scope_root: String,
    pub root_path: String,
    pub query: String,
    pub search_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchContentCancelRequest {
    pub search_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFileNamesCancelRequest {
    pub search_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchContentBatchEvent {
    pub search_id: String,
    pub results: Vec<FileSearchResult>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchContentDoneEvent {
    pub search_id: String,
    pub truncated: bool,
    pub scanned_files: usize,
    pub failed_files: usize,
    /// Programmatic error code (e.g. `QUERY_TOO_LONG`). Mirrors the field on
    /// `SearchFileNamesDoneEvent` so the renderer can branch on it.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFileNamesStreamRequest {
    pub scope_root: String,
    pub root_path: String,
    pub query: String,
    pub search_id: String,
    /// When true, run `rg --no-ignore --hidden` and emit ignored/hidden files
    /// with `ignored: true` so the @-mention picker can dim them. When false
    /// (the default), the common-ignore exclusions are applied and every hit
    /// carries `ignored: false`. See ADR 0003.
    #[serde(default)]
    pub include_ignored: bool,
}

/// One filename-search hit. `ignored` is set when the path runs through a
/// commonly-ignored directory or a hidden/cruft segment, so the @-mention
/// picker can dim it. `ignored: false` for every hit when the caller did not
/// request `include_ignored`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFileHit {
    pub path: String,
    pub ignored: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFileNamesBatchEvent {
    pub search_id: String,
    pub files: Vec<SearchFileHit>,
    /// `None` on mid-stream batches (final truncation state is not yet known).
    /// `Some(true)` is set on the trailing batch if the result was capped, and
    /// `Some(false)` otherwise. `serde` skips `None` so the field is omitted
    /// on the wire when not set.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub truncated: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFileNamesDoneEvent {
    pub search_id: String,
    pub truncated: bool,
    pub total_files: usize,
    /// Programmatic error code (e.g. `QUERY_TOO_LONG`, `PATH_VALIDATION_FAILED`,
    /// `RG_SPAWN_FAILED`). Set when `error` is set; otherwise `None`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RgInfoResponse {
    pub sidecar_binary_name: String,
    pub resolved_path: String,
    pub source: String,
    pub exists: bool,
}

static SEARCH_PROCESSES: OnceLock<Mutex<HashMap<String, Arc<Mutex<Child>>>>> = OnceLock::new();
static FILENAME_SEARCH_PROCESSES: OnceLock<Mutex<HashMap<String, Arc<Mutex<Child>>>>> =
    OnceLock::new();
static RG_PATH_CACHE: OnceLock<String> = OnceLock::new();

pub(crate) fn search_processes() -> &'static Mutex<HashMap<String, Arc<Mutex<Child>>>> {
    SEARCH_PROCESSES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn filename_search_processes() -> &'static Mutex<HashMap<String, Arc<Mutex<Child>>>> {
    FILENAME_SEARCH_PROCESSES.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(target_os = "windows")]
pub(crate) fn rg_sidecar_name() -> &'static str {
    "rg-x86_64-pc-windows-msvc.exe"
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub(crate) fn rg_sidecar_name() -> &'static str {
    "rg-aarch64-apple-darwin"
}

#[cfg(all(target_os = "macos", not(target_arch = "aarch64")))]
pub(crate) fn rg_sidecar_name() -> &'static str {
    "rg-x86_64-apple-darwin"
}

#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
pub(crate) fn rg_sidecar_name() -> &'static str {
    "rg-aarch64-unknown-linux-gnu"
}

#[cfg(all(target_os = "linux", target_arch = "arm"))]
pub(crate) fn rg_sidecar_name() -> &'static str {
    "rg-armv7-unknown-linux-gnueabihf"
}

#[cfg(all(
    target_os = "linux",
    not(any(target_arch = "aarch64", target_arch = "arm"))
))]
pub(crate) fn rg_sidecar_name() -> &'static str {
    "rg-x86_64-unknown-linux-musl"
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub(crate) fn rg_sidecar_name() -> &'static str {
    "rg"
}

/// Name Tauri writes next to the app executable for `bundle.externalBin`
/// `bin/rg`. On macOS that file is `Contents/MacOS/rg`, not
/// `rg-aarch64-apple-darwin`.
pub(crate) fn rg_bundled_file_name() -> &'static str {
    if cfg!(windows) {
        "rg.exe"
    } else {
        "rg"
    }
}

/// Sidecar locations, first match wins. The bundled name beside the running
/// executable comes before the triple-named dev file so a packaged app does
/// not fall through to `rg` on `PATH`.
fn rg_sidecar_candidates(cwd: Option<&Path>, exe_dir: Option<&Path>) -> Vec<PathBuf> {
    let bundled = rg_bundled_file_name();
    let triple = rg_sidecar_name();
    let mut candidates = Vec::new();

    if let Some(exe_dir) = exe_dir {
        candidates.push(exe_dir.join(bundled));
        candidates.push(exe_dir.join("../Resources").join(bundled));
        candidates.push(exe_dir.join("../lib").join(bundled));
    }

    if let Some(cwd) = cwd {
        candidates.push(cwd.join("src-tauri").join("bin").join(triple));
        candidates.push(cwd.join("bin").join(triple));
    }

    if let Some(exe_dir) = exe_dir {
        candidates.push(exe_dir.join(triple));
        candidates.push(exe_dir.join("../Resources").join(triple));
        candidates.push(exe_dir.join("../lib").join(triple));
    }

    candidates
}

fn first_existing_file(candidates: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    candidates
        .into_iter()
        .find(|path| path.exists() && path.is_file())
}

/// Resolve ripgrep from an explicit cwd and executable directory. `source` is
/// `"sidecar"` when a file is found and `"path"` for the bare `rg` fallback.
pub(crate) fn resolve_rg_path_from(cwd: Option<&Path>, exe_dir: Option<&Path>) -> (String, String) {
    if let Some(found) = first_existing_file(rg_sidecar_candidates(cwd, exe_dir)) {
        return (found.to_string_lossy().to_string(), "sidecar".to_string());
    }

    ("rg".to_string(), "path".to_string())
}

pub(crate) fn resolve_rg_path() -> (String, String) {
    let from_env = std::env::var("TERMUL_RG_PATH")
        .ok()
        .filter(|v| !v.trim().is_empty());
    if let Some(path) = from_env {
        let env_path = PathBuf::from(&path);
        if env_path.is_absolute() {
            return (path, "env".to_string());
        }

        if let Ok(cwd) = std::env::current_dir() {
            let direct = cwd.join(&env_path);
            if direct.exists() && direct.is_file() {
                return (direct.to_string_lossy().to_string(), "env".to_string());
            }

            let from_src_tauri = cwd.join("src-tauri").join(&env_path);
            if from_src_tauri.exists() && from_src_tauri.is_file() {
                return (
                    from_src_tauri.to_string_lossy().to_string(),
                    "env".to_string(),
                );
            }
        }

        return (path, "env".to_string());
    }

    let cwd = std::env::current_dir().ok();
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|parent| parent.to_path_buf()));
    resolve_rg_path_from(cwd.as_deref(), exe_dir.as_deref())
}

pub(crate) fn detect_rg_path() -> String {
    if let Some(cached) = RG_PATH_CACHE.get() {
        return cached.clone();
    }

    let (detected, _source) = resolve_rg_path();
    let _ = RG_PATH_CACHE.set(detected.clone());
    detected
}

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(target_os = "windows")]
pub(crate) fn configure_background_command(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn configure_background_command(_command: &mut Command) {}

/// Maximum allowed search query length to prevent resource exhaustion via
/// oversized input passed to ripgrep or the file-name walker.
pub(crate) const MAX_SEARCH_QUERY_LEN: usize = 500;

pub(crate) fn validated_search_root(scope_root: &str, search_root: &str) -> Result<String, String> {
    path_validation::validate_search_path(search_root, scope_root)
        .map(|path| path.to_string_lossy().to_string())
}

pub(crate) fn build_search_args(
    query: &str,
    root_path: &str,
    max_matches_per_file: usize,
) -> Vec<String> {
    let mut args = vec![
        "--json".to_string(),
        "-F".to_string(),
        "-i".to_string(),
        "-n".to_string(),
        "--max-filesize".to_string(),
        "1M".to_string(),
        "--max-count".to_string(),
        max_matches_per_file.to_string(),
    ];

    for ignored in [
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
        "coverage",
        ".nyc_output",
    ] {
        args.push("-g".to_string());
        args.push(format!("!**/{}/**", ignored));
    }

    args.push("--".to_string());
    args.push(query.to_string());
    args.push(root_path.to_string());
    args
}

/// Directory basenames that are commonly git-ignored. Entries under these are
/// still walked when `include_ignored` is set, but classified as `ignored` so
/// the @-mention picker can dim them. Mirrors the renderer's `ALWAYS_IGNORE`
/// list in `tauri-filesystem-api.ts` so the two sides agree on "ignored".
const COMMONLY_IGNORED_NAMES: &[&str] = &[
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
    "coverage",
    ".nyc_output",
];

/// Cruft file basenames (not dir names) that should be dimmed when surfaced.
const COMMONLY_IGNORED_FILES: &[&str] = &["Thumbs.db", "desktop.ini", ".DS_Store"];

/// True when a (slash-normalized, relative) path runs through a
/// commonly-ignored directory, a hidden segment, or a cruft basename. Used to
/// tag `SearchFileHit.ignored` for the @-mention picker. Pure so it can be
/// unit-tested directly.
pub(crate) fn path_is_ignored(rel_path: &str) -> bool {
    let segments: Vec<&str> = rel_path.split(['/', '\\']).collect();
    for seg in &segments {
        if seg.is_empty() {
            continue;
        }
        if seg.starts_with('.') || COMMONLY_IGNORED_NAMES.contains(seg) {
            return true;
        }
    }
    if let Some(basename) = segments.last() {
        if COMMONLY_IGNORED_FILES.contains(basename) {
            return true;
        }
    }
    false
}

/// Concatenate non-ignored hits first, then ignored hits up to `cap`. Pure so
/// it can be unit-tested directly. The caller is expected to have already
/// capped `non_ignored` at `cap`; this extends with ignored only into the
/// remaining slots so ignored files can never crowd out non-ignored ones.
/// Reap an rg child after stdout reading stops. When the reader breaks early
/// (cap hit) stdout is no longer drained; kill first so rg cannot block on a
/// full pipe before `wait()` returns.
fn reap_rg_child_after_stdout(
    child: &mut Child,
    stdout_stopped_early: bool,
) -> Option<std::process::ExitStatus> {
    if stdout_stopped_early {
        let _ = child.kill();
    }
    child.wait().ok()
}

pub(crate) fn rank_search_hits(
    non_ignored: Vec<SearchFileHit>,
    ignored: Vec<SearchFileHit>,
    cap: usize,
) -> Vec<SearchFileHit> {
    let mut out = non_ignored;
    let remaining = cap.saturating_sub(out.len());
    if remaining > 0 {
        out.extend(ignored.into_iter().take(remaining));
    }
    out
}

/// Build the ripgrep argv for a streaming filename search.
///
/// We rely on `rg --files --iglob` so we get the same multi-threaded tree walk
/// that powers content search. The glob form is `**/*{escaped_query}*` to
/// match the previous "filename contains query" behavior at any directory
/// depth. `-i` keeps the match case-insensitive on every platform (ripgrep's
/// default is already case-insensitive on Windows, but Linux/macOS would
/// otherwise be sensitive). Glob metacharacters in the query are escaped so
/// they match literally, mirroring the old `contains` semantics.
///
/// When `include_ignored` is true, the common-ignore exclusions are dropped
/// and `--no-ignore --hidden` are added so ignored/hidden files surface;
/// classification + non-ignored-first ranking happen after the walk. See ADR
/// 0003.
pub(crate) fn build_file_name_search_args(
    query: &str,
    root_path: &str,
    include_ignored: bool,
) -> Vec<String> {
    // Escape glob metacharacters that ripgrep would otherwise interpret as
    // wildcards (`*`, `?`, `[`, `]`, `{`, `}`, `\`) so the query is matched
    // as a substring of the basename. `{`/`}` are alternation in globset.
    let mut escaped = String::with_capacity(query.len());
    for ch in query.chars() {
        match ch {
            '*' | '?' | '[' | ']' | '{' | '}' | '\\' => {
                escaped.push('\\');
                escaped.push(ch);
            }
            _ => escaped.push(ch),
        }
    }

    let mut args = vec![
        "--files".to_string(),
        "-i".to_string(),
        "--iglob".to_string(),
        format!("**/*{}*", escaped),
    ];

    if include_ignored {
        // Surface ignored + hidden files so they can be mentioned and dimmed.
        // No `-g !<name>` exclusions; per-hit classification and non-ignored-
        // first ranking happen after the walk.
        args.push("--no-ignore".to_string());
        args.push("--hidden".to_string());
    } else {
        // NB: In `--files` + `--iglob` mode, ripgrep only honors `-g` ignore
        // patterns written as bare basenames (e.g. `-g '!node_modules'`). The
        // `!**/name/**` form that `build_search_args` uses for content search
        // is silently dropped here, so we explicitly use the basename form.
        for ignored in COMMONLY_IGNORED_NAMES {
            args.push("-g".to_string());
            args.push(format!("!{}", ignored));
        }
        // Exclude platform cruft and common dotenv secrets. The exact `.env`
        // exclusion matches the spec; `.env.local` / `.env.production` are
        // deliberately left to `.gitignore` so a project's own ignore list is
        // honored.
        args.push("-g".to_string());
        args.push("!.env".to_string());
        args.push("-g".to_string());
        args.push("!Thumbs.db".to_string());
        args.push("-g".to_string());
        args.push("!desktop.ini".to_string());
        args.push("-g".to_string());
        args.push("!.DS_Store".to_string());
    }

    args.push(root_path.to_string());
    args
}

#[tauri::command]
pub async fn search_get_rg_info() -> Result<IpcResult<RgInfoResponse>, String> {
    let (resolved_path, source) = resolve_rg_path();
    let exists = PathBuf::from(&resolved_path).exists();

    Ok(IpcResult::success(RgInfoResponse {
        sidecar_binary_name: rg_sidecar_name().to_string(),
        resolved_path,
        source,
        exists,
    }))
}

#[tauri::command]
pub async fn search_content_stream(
    request: SearchContentStreamRequest,
    app_handle: AppHandle,
) -> Result<IpcResult<()>, String> {
    let trimmed_query = request.query.trim().to_string();
    if trimmed_query.is_empty() {
        let _ = app_handle.emit(
            "search-content-done",
            SearchContentDoneEvent {
                search_id: request.search_id,
                truncated: false,
                scanned_files: 0,
                failed_files: 0,
                code: None,
                error: None,
            },
        );
        return Ok(IpcResult::success(()));
    }

    let query_char_count = trimmed_query.chars().count();
    if query_char_count > MAX_SEARCH_QUERY_LEN {
        log::warn!(
            "[Security] Search query rejected: length {} characters exceeds limit of {}",
            query_char_count,
            MAX_SEARCH_QUERY_LEN
        );
        let _ = app_handle.emit(
            "search-content-done",
            SearchContentDoneEvent {
                search_id: request.search_id,
                truncated: false,
                scanned_files: 0,
                failed_files: 0,
                code: Some("QUERY_TOO_LONG".to_string()),
                error: Some(format!(
                    "Search query too long: {} characters (max {})",
                    query_char_count, MAX_SEARCH_QUERY_LEN
                )),
            },
        );
        return Ok(IpcResult::success(()));
    }

    let validated_root = match validated_search_root(&request.scope_root, &request.root_path) {
        Ok(path) => path,
        Err(e) => {
            log::warn!(
                "[Security] File search rejected: scope='{}' root='{}': {}",
                request.scope_root,
                request.root_path,
                e
            );
            let _ = app_handle.emit(
                "search-content-done",
                SearchContentDoneEvent {
                    search_id: request.search_id,
                    truncated: false,
                    scanned_files: 0,
                    failed_files: 0,
                    code: Some("PATH_VALIDATION_FAILED".to_string()),
                    error: Some(format!("Invalid search path: {}", e)),
                },
            );
            return Ok(IpcResult::success(()));
        }
    };

    let max_files_with_matches: usize = 100;
    let max_matches_per_file: usize = 30;
    let args = build_search_args(&trimmed_query, &validated_root, max_matches_per_file);

    let rg_path = detect_rg_path();
    let mut rg_command = Command::new(&rg_path);
    rg_command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    configure_background_command(&mut rg_command);
    let mut child = match rg_command.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = app_handle.emit(
                "search-content-done",
                SearchContentDoneEvent {
                    search_id: request.search_id,
                    truncated: false,
                    scanned_files: 0,
                    failed_files: 0,
                    code: Some("RG_SPAWN_FAILED".to_string()),
                    error: Some(format!("rg spawn failed (path: {}): {}", rg_path, e)),
                },
            );
            return Ok(IpcResult::success(()));
        }
    };

    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            let _ = app_handle.emit(
                "search-content-done",
                SearchContentDoneEvent {
                    search_id: request.search_id,
                    truncated: false,
                    scanned_files: 0,
                    failed_files: 1,
                    // Distinct from `RG_SPAWN_FAILED` (rg binary never
                    // started). Here rg did start, but its pipe was
                    // already closed when we tried to take it.
                    code: Some("RG_STDOUT_CAPTURE_FAILED".to_string()),
                    error: Some("failed to capture rg stdout".to_string()),
                },
            );
            return Ok(IpcResult::success(()));
        }
    };

    let child_handle = Arc::new(Mutex::new(child));
    {
        let mut guard = search_processes().lock().map_err(|e| e.to_string())?;
        guard.insert(request.search_id.clone(), Arc::clone(&child_handle));
    }

    let search_id = request.search_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let reader = BufReader::new(stdout);
        let mut grouped: BTreeMap<String, Vec<FileSearchMatch>> = BTreeMap::new();
        let mut pending_matches: BTreeMap<String, Vec<FileSearchMatch>> = BTreeMap::new();
        let mut truncated = false;
        let mut stdout_stopped_early = false;
        let mut stream_error: Option<String> = None;

        let flush_batch = |pending: &mut BTreeMap<String, Vec<FileSearchMatch>>,
                           truncated: bool| {
            if pending.is_empty() {
                return;
            }
            let batch: Vec<FileSearchResult> = pending
                .iter()
                .map(|(file_path, matches)| FileSearchResult {
                    file_path: file_path.clone(),
                    matches: matches.clone(),
                })
                .collect();
            let _ = app_handle.emit(
                "search-content-batch",
                SearchContentBatchEvent {
                    search_id: search_id.clone(),
                    results: batch,
                    truncated,
                },
            );
            pending.clear();
        };

        // Manual loop so we can record the first I/O error instead of
        // silently dropping it (which `for line in reader.lines()` would
        // do via its `Err(_) => continue` swallow).
        let mut iter = reader.lines();
        loop {
            let line = match iter.next() {
                Some(Ok(v)) => v,
                Some(Err(e)) => {
                    stream_error = Some(format!("stdout read error: {}", e));
                    break;
                }
                None => break,
            };

            let parsed: serde_json::Value = match serde_json::from_str(&line) {
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
                    stdout_stopped_early = true;
                    break;
                }
                grouped.insert(file_path.clone(), Vec::new());
            }

            if let Some(matches) = grouped.get_mut(&file_path) {
                if matches.len() >= max_matches_per_file {
                    truncated = true;
                    continue;
                }
                let new_match = FileSearchMatch {
                    line_number,
                    line_text,
                };
                matches.push(new_match.clone());
                pending_matches
                    .entry(file_path)
                    .or_default()
                    .push(new_match);
            }

            if pending_matches.values().map(Vec::len).sum::<usize>() >= 25 {
                flush_batch(&mut pending_matches, truncated);
            }
        }

        flush_batch(&mut pending_matches, truncated);

        // Reap the child and propagate non-zero exit status (other than 1,
        // which rg uses for "no matches") as a surfaced error. Mirrors the
        // pattern from `search_file_names_stream` so the renderer can
        // distinguish a clean run from a runtime rg failure.
        let exit_status = {
            let mut child = match child_handle.lock() {
                Ok(c) => c,
                Err(_) => {
                    stream_error.get_or_insert("child handle poisoned".to_string());
                    return;
                }
            };
            reap_rg_child_after_stdout(&mut child, stdout_stopped_early)
        };
        if let Ok(mut guard) = search_processes().lock() {
            guard.remove(&search_id);
        }

        let final_error = stream_error.or_else(|| {
            exit_status
                .as_ref()
                .filter(|s| !s.success() && s.code() != Some(1))
                .map(|s| format!("rg exited with status: {:?}", s))
        });

        // `RG_STREAM_FAILED` is the catch-all code for any error that
        // surfaces mid-walk (stdout I/O error or non-zero exit other than
        // rg's "no matches" code 1). Mirrors the filename stream's
        // semantic.
        let final_code = if final_error.is_some() {
            Some("RG_STREAM_FAILED".to_string())
        } else {
            None
        };

        let _ = app_handle.emit(
            "search-content-done",
            SearchContentDoneEvent {
                search_id,
                truncated,
                scanned_files: 0,
                failed_files: 0,
                code: final_code,
                error: final_error,
            },
        );
    });

    Ok(IpcResult::success(()))
}

#[tauri::command]
pub async fn search_content_cancel(
    request: SearchContentCancelRequest,
) -> Result<IpcResult<()>, String> {
    let mut guard = search_processes().lock().map_err(|e| e.to_string())?;
    if let Some(child_handle) = guard.remove(&request.search_id) {
        if let Ok(mut child) = child_handle.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    Ok(IpcResult::success(()))
}

#[tauri::command]
pub async fn search_file_names_stream(
    request: SearchFileNamesStreamRequest,
    app_handle: AppHandle,
) -> Result<IpcResult<()>, String> {
    let trimmed_query = request.query.trim().to_string();
    let search_id = request.search_id.clone();

    if trimmed_query.is_empty() {
        let _ = app_handle.emit(
            "search-file-names-done",
            SearchFileNamesDoneEvent {
                search_id,
                truncated: false,
                total_files: 0,
                code: None,
                error: None,
            },
        );
        return Ok(IpcResult::success(()));
    }

    if trimmed_query.chars().count() > MAX_SEARCH_QUERY_LEN {
        log::warn!(
            "[Security] File name search query rejected: length {} exceeds limit of {}",
            trimmed_query.chars().count(),
            MAX_SEARCH_QUERY_LEN
        );
        let _ = app_handle.emit(
            "search-file-names-done",
            SearchFileNamesDoneEvent {
                search_id,
                truncated: false,
                total_files: 0,
                code: Some("QUERY_TOO_LONG".to_string()),
                error: Some(format!(
                    "Search query too long: {} characters (max {})",
                    trimmed_query.chars().count(),
                    MAX_SEARCH_QUERY_LEN
                )),
            },
        );
        return Ok(IpcResult::success(()));
    }

    let query_char_count = trimmed_query.chars().count();
    if query_char_count > MAX_SEARCH_QUERY_LEN {
        log::warn!(
            "[Security] File name search query rejected: length {} characters exceeds limit of {}",
            query_char_count,
            MAX_SEARCH_QUERY_LEN
        );
        return Ok(IpcResult::error(
            format!(
                "Search query too long: {} characters (max {})",
                query_char_count, MAX_SEARCH_QUERY_LEN
            ),
            "QUERY_TOO_LONG",
        ));
    }

    let validated_root = match validated_search_root(&request.scope_root, &request.root_path) {
        Ok(path) => path,
        Err(e) => {
            log::warn!(
                "[Security] File name search rejected: scope='{}' root='{}': {}",
                request.scope_root,
                request.root_path,
                e
            );
            let _ = app_handle.emit(
                "search-file-names-done",
                SearchFileNamesDoneEvent {
                    search_id,
                    truncated: false,
                    total_files: 0,
                    code: Some("PATH_VALIDATION_FAILED".to_string()),
                    error: Some(format!("Invalid search path: {}", e)),
                },
            );
            return Ok(IpcResult::success(()));
        }
    };

    let args =
        build_file_name_search_args(&trimmed_query, &validated_root, request.include_ignored);

    let rg_path = detect_rg_path();
    let mut rg_command = Command::new(&rg_path);
    rg_command
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    configure_background_command(&mut rg_command);

    let mut child = match rg_command.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = app_handle.emit(
                "search-file-names-done",
                SearchFileNamesDoneEvent {
                    search_id,
                    truncated: false,
                    total_files: 0,
                    code: Some("RG_SPAWN_FAILED".to_string()),
                    error: Some(format!("rg spawn failed (path: {}): {}", rg_path, e)),
                },
            );
            return Ok(IpcResult::success(()));
        }
    };

    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            let _ = child.kill().ok();
            let _ = app_handle.emit(
                "search-file-names-done",
                SearchFileNamesDoneEvent {
                    search_id,
                    truncated: false,
                    total_files: 0,
                    // Distinct from `RG_SPAWN_FAILED` (which means the rg
                    // binary never started). Here rg DID start, but the
                    // pipe was already closed when we tried to take it.
                    code: Some("RG_STDOUT_CAPTURE_FAILED".to_string()),
                    error: Some("failed to capture rg stdout".to_string()),
                },
            );
            return Ok(IpcResult::success(()));
        }
    };

    let child_handle = Arc::new(Mutex::new(child));
    {
        let mut guard = filename_search_processes()
            .lock()
            .map_err(|e| e.to_string())?;
        guard.insert(search_id.clone(), Arc::clone(&child_handle));
    }

    let include_ignored = request.include_ignored;

    tauri::async_runtime::spawn_blocking(move || {
        let reader = BufReader::new(stdout);
        let max_files: usize = 100;
        let batch_size: usize = 25;
        let mut truncated = false;
        let mut stream_error: Option<String> = None;

        // `files` is the default-path bucket (mid-stream batched).
        // `non_ignored` + `ignored_bucket` are the `include_ignored`-path
        // buckets, ranked after the walk so node_modules can't crowd out
        // source files. See ADR 0003.
        let mut files: Vec<SearchFileHit> = Vec::new();
        let mut non_ignored: Vec<SearchFileHit> = Vec::new();
        let mut ignored_bucket: Vec<SearchFileHit> = Vec::new();
        const IGNORED_CAP: usize = 20;
        let mut ignored_dropped: usize = 0;
        let mut broke_at_cap = false;
        let mut stdout_stopped_early = false;
        let mut last_batch_count: usize = 0;

        // Collect output until we hit the cap, EOF, or a pipe error. The
        // iterator-based form `map_while(Result::ok)` would swallow I/O
        // errors, so we use a manual loop that records the first error.
        let mut iter = reader.lines();
        loop {
            match iter.next() {
                Some(Ok(line)) => {
                    // ripgrep on Windows may emit verbatim paths
                    // (e.g. `\\?\C:\...`) when the root is canonicalized.
                    // Strip the prefix before the slash-normalization so the
                    // renderer never sees a `\\?\` blob in click paths.
                    let normalized =
                        path_validation::strip_verbatim_prefix(&line).replace('\\', "/");
                    if include_ignored {
                        // Stop as soon as the non-ignored bucket is full: later
                        // ignored hits can no longer survive `rank_search_hits`,
                        // so walking further just wastes time in large repos.
                        if non_ignored.len() >= max_files {
                            broke_at_cap = true;
                            stdout_stopped_early = true;
                            break;
                        }
                        if path_is_ignored(&normalized) {
                            if ignored_bucket.len() < IGNORED_CAP {
                                ignored_bucket.push(SearchFileHit {
                                    path: normalized,
                                    ignored: true,
                                });
                            } else {
                                ignored_dropped += 1;
                            }
                        } else {
                            non_ignored.push(SearchFileHit {
                                path: normalized,
                                ignored: false,
                            });
                        }
                    } else {
                        if files.len() >= max_files {
                            truncated = true;
                            stdout_stopped_early = true;
                            break;
                        }
                        files.push(SearchFileHit {
                            path: normalized,
                            ignored: false,
                        });
                        // Emit a mid-stream batch when we cross a batch
                        // boundary, but skip the trailing batch below if we
                        // already published this exact count.
                        if files.len().is_multiple_of(batch_size) {
                            // Mid-stream batch — final truncation state is
                            // not known yet, so the field is `None` (serde
                            // omits it from the wire). The trailing batch
                            // below carries the authoritative value.
                            let _ = app_handle.emit(
                                "search-file-names-batch",
                                SearchFileNamesBatchEvent {
                                    search_id: search_id.clone(),
                                    files: files.clone(),
                                    truncated: None,
                                },
                            );
                            last_batch_count = files.len();
                        }
                    }
                }
                Some(Err(e)) => {
                    stream_error = Some(format!("stdout read error: {}", e));
                    break;
                }
                None => break,
            }
        }

        // Publish the authoritative final batch. For `include_ignored`, emit
        // a single ranked batch (non-ignored first) so the picker never
        // flickers between mid-stream order and the ranked order. For the
        // default path, skip if the count matches the last mid-stream batch.
        let final_files: Vec<SearchFileHit> = if include_ignored {
            truncated = broke_at_cap || ignored_dropped > 0;
            let ranked = rank_search_hits(non_ignored, ignored_bucket, max_files);
            let _ = app_handle.emit(
                "search-file-names-batch",
                SearchFileNamesBatchEvent {
                    search_id: search_id.clone(),
                    files: ranked.clone(),
                    truncated: Some(truncated),
                },
            );
            ranked
        } else {
            if files.len() != last_batch_count {
                let _ = app_handle.emit(
                    "search-file-names-batch",
                    SearchFileNamesBatchEvent {
                        search_id: search_id.clone(),
                        files: files.clone(),
                        truncated: Some(truncated),
                    },
                );
            }
            files
        };

        // Reap the child and propagate a non-zero exit status (other than 1,
        // which rg uses for "no matches") as a surfaced error. The previous
        // `try_wait().or_else(wait)` pattern was a no-op for the common
        // `Ok(None)` case, so we always wait.
        let exit_status = {
            let mut child = match child_handle.lock() {
                Ok(c) => c,
                Err(_) => {
                    stream_error.get_or_insert("child handle poisoned".to_string());
                    return;
                }
            };
            reap_rg_child_after_stdout(&mut child, stdout_stopped_early)
        };
        if let Ok(mut guard) = filename_search_processes().lock() {
            guard.remove(&search_id);
        }

        let final_error = stream_error.or_else(|| {
            exit_status
                .as_ref()
                .filter(|s| !s.success() && s.code() != Some(1))
                .map(|s| format!("rg exited with status: {:?}", s))
        });

        // `RG_STREAM_FAILED` is the catch-all code for any error that
        // surfaces mid-walk (stdout I/O error or non-zero exit other than
        // rg's "no matches" code 1). Distinct from `RG_SPAWN_FAILED`,
        // which is reserved for the rg binary failing to start in the
        // first place. The renderer can branch on it alongside the inline
        // `QUERY_TOO_LONG` / `PATH_VALIDATION_FAILED` / `RG_STDOUT_CAPTURE_FAILED`
        // codes emitted earlier in the command.
        let final_code = if final_error.is_some() {
            Some("RG_STREAM_FAILED".to_string())
        } else {
            None
        };

        let _ = app_handle.emit(
            "search-file-names-done",
            SearchFileNamesDoneEvent {
                search_id,
                truncated,
                total_files: final_files.len(),
                code: final_code,
                error: final_error,
            },
        );
    });

    Ok(IpcResult::success(()))
}

#[tauri::command]
pub async fn search_file_names_cancel(
    request: SearchFileNamesCancelRequest,
) -> Result<IpcResult<()>, String> {
    let mut guard = filename_search_processes()
        .lock()
        .map_err(|e| e.to_string())?;
    if let Some(child_handle) = guard.remove(&request.search_id) {
        if let Ok(mut child) = child_handle.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    Ok(IpcResult::success(()))
}

#[tauri::command]
pub async fn search_content(
    request: SearchContentRequest,
) -> Result<IpcResult<FileSearchResponse>, String> {
    let trimmed_query = request.query.trim();
    if trimmed_query.is_empty() {
        return Ok(IpcResult::success(FileSearchResponse {
            results: vec![],
            truncated: false,
            scanned_files: 0,
            failed_files: 0,
        }));
    }

    let max_files_with_matches: usize = 100;
    let max_matches_per_file: usize = 30;

    let validated_root = match validated_search_root(&request.scope_root, &request.root_path) {
        Ok(path) => path,
        Err(e) => {
            log::warn!(
                "[Security] Content search rejected: scope='{}' root='{}': {}",
                request.scope_root,
                request.root_path,
                e
            );
            return Ok(IpcResult::error(
                format!("Invalid search path: {}", e),
                "PATH_VALIDATION_FAILED",
            ));
        }
    };

    let args = build_search_args(trimmed_query, &validated_root, max_matches_per_file);

    let rg_path = detect_rg_path();
    let mut rg_command = Command::new(&rg_path);
    rg_command.args(args);
    configure_background_command(&mut rg_command);
    let output = rg_command.output();
    let output = match output {
        Ok(o) => o,
        Err(e) => {
            return Ok(IpcResult::error(
                format!("rg spawn failed (path: {}): {}", rg_path, e),
                "SEARCH_ERROR",
            ))
        }
    };

    let code = output.status.code().unwrap_or(0);
    if code > 1 {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Ok(IpcResult::error(
            format!("rg failed ({}): {}", code, stderr),
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

    let results = grouped
        .into_iter()
        .map(|(file_path, matches)| FileSearchResult { file_path, matches })
        .collect();

    Ok(IpcResult::success(FileSearchResponse {
        results,
        truncated,
        scanned_files: 0,
        failed_files: 0,
    }))
}
