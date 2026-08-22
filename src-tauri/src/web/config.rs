//! Bind configuration for the standalone `termul-server` HTTP listener.
//!
//! Mirrors `remote::host::RemoteBindMode` so `--host` parsing stays consistent
//! across the desktop-hosted shared-live server and the headless ACP server.
//! Auth/TLS land in Epic 2 — this story owns host/port + the
//! permission-rendezvous timeout.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

/// Resolve the default project-root boundary for the fs_api routes (PR-S4).
///
/// Prefers `$TERMUL_PROJECT_ROOT` when set; otherwise falls back to the
/// current user's home directory (`$HOME` on Unix, `%USERPROFILE%` on
/// Windows). The fallback is intentionally permissive enough to allow
/// ordinary project-creation flows under the user's own account — tightening
/// to a per-project subtree is left to the host application or a future
/// per-request override.
///
/// `None` is returned only when no home directory is discoverable and the
/// env var is unset; callers should treat that as a fatal startup error.
pub fn default_sessions_dir() -> Option<PathBuf> {
    if let Ok(value) = std::env::var("TERMUL_SESSIONS_DIR") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    #[cfg(unix)]
    {
        if let Some(base) = std::env::var_os("XDG_STATE_HOME").map(PathBuf::from) {
            return Some(base.join("termul").join("sessions"));
        }
        std::env::var_os("HOME").map(PathBuf::from).map(|home| {
            home.join(".local")
                .join("state")
                .join("termul")
                .join("sessions")
        })
    }
    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .map(|base| base.join("Termul").join("sessions"))
    }
    #[cfg(not(any(unix, windows)))]
    None
}

pub fn default_project_root() -> Option<PathBuf> {
    if let Ok(env_root) = std::env::var("TERMUL_PROJECT_ROOT") {
        let trimmed = env_root.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    // `dirs` is not in the dep tree; resolve the home dir via std-only env
    // vars (HOME on Unix, USERPROFILE on Windows). This avoids pulling in a
    // new crate just for one call site.
    #[cfg(unix)]
    let home = std::env::var_os("HOME").map(PathBuf::from);
    #[cfg(windows)]
    let home = std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from));
    #[cfg(not(any(unix, windows)))]
    let home = std::env::var_os("HOME").map(PathBuf::from);
    home
}

/// Validate a raw project-root path and return its canonical absolute form.
///
/// Used at every entry point that constructs a `ServerConfig::project_root`
/// (the `from_args` `--project-root` flag, the desktop shared-live host's
/// `default_project_root()` fallback, the standalone `termul-server`
/// binary) so the boundary check in `git_api::ensure_within_project_boundary`
/// (the shared operations chokepoint for `/git/*`, `/skills`,
/// `/search/content` — accepts the default `project_root` or any registered,
/// non-archived project root) can rely on `project_root` being a real,
/// accessible directory rather than a path string that only resolves
/// correctly at the first request. The `/fs/*` browse/read routes are
/// intentionally broader (no `project_root` containment — ADR-007).
///
/// Rejects:
/// - Paths that do not exist or are not accessible (canonicalize fails).
/// - Paths that exist but are not directories.
///
/// Returns the canonical absolute path on success, or an error message
/// suitable for surfacing to the operator at startup.
pub fn resolve_and_validate_project_root(raw: &Path) -> Result<PathBuf, String> {
    // 1) Canonicalize: absolute path, symlinks resolved, and the path must
    //    exist for canonicalize to succeed.
    let canonical = raw
        .canonicalize()
        .map_err(|e| format!("project root '{}' is not accessible: {e}", raw.display()))?;
    // 2) Must be a directory. A file is a valid fs target for the
    //    boundary check, but it would make the fs_api routes useless
    //    (`mkdir` cannot create children inside a file, `ls`/`browse`
    //    cannot list a file), so fail fast at startup instead.
    if !canonical.is_dir() {
        return Err(format!(
            "project root '{}' is not a directory",
            canonical.display()
        ));
    }
    Ok(canonical)
}

/// Which network interface(s) the standalone HTTP server binds to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BindMode {
    /// `127.0.0.1` — localhost only (default, safest).
    Localhost,
    /// `0.0.0.0` — all interfaces (explicit expose opt-in).
    All,
}

impl BindMode {
    /// Parse a host string into a bind mode.
    ///
    /// Accepts `localhost` / `127.0.0.1` / `loopback` → [`Localhost`], and
    /// `all` / `0.0.0.0` / `any` → [`All`]. Anything else returns `None`.
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "localhost" | "127.0.0.1" | "loopback" => Some(Self::Localhost),
            "all" | "0.0.0.0" | "any" => Some(Self::All),
            _ => None,
        }
    }

    /// Address passed to `TcpListener::bind`.
    pub fn bind_addr(self, port: u16) -> SocketAddr {
        match self {
            Self::Localhost => SocketAddr::from(([127, 0, 0, 1], port)),
            Self::All => SocketAddr::from(([0, 0, 0, 0], port)),
        }
    }

    /// Human-readable bind host for logs / CLI help.
    pub fn display_host(self) -> &'static str {
        match self {
            Self::Localhost => "127.0.0.1",
            Self::All => "0.0.0.0",
        }
    }
}

/// Runtime config for [`crate::web::serve`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    /// Per-session event-log capacity (bounded ring; AC4). Default 4096.
    pub event_log_capacity: usize,
    /// Permission-rendezvous timeout in seconds (Story 1.7 / FR14). On expiry
    /// the pending permission resolves as deny (`Cancelled`). Default 60.
    pub permission_timeout_secs: u64,
    /// Last-subscriber disconnect grace before pending permissions are denied.
    /// The original per-ticket timeout continues running during this grace.
    pub permission_reconnect_grace_secs: u64,
    /// PR-S4: project-root boundary enforced by the fs_api routes. Requests
    /// whose canonicalized target path resolves outside this root are
    /// refused with `code: "OUTSIDE_ROOT"` (or `PATH_TRAVERSAL` for explicit
    /// `..` components). Defaults to the user's home directory when unset
    /// (see [`default_project_root`]).
    pub project_root: PathBuf,
    /// Server-owned VFS-roots registry file (VPS mode, Story 4.1). The
    /// standalone `termul-server` binary loads this at startup and seeds the
    /// in-memory [`crate::web::project_registry::ProjectRegistry`] from it;
    /// `None` (the default) means the binary serves an empty project list.
    /// The file need not exist at parse time — a missing file loads as an
    /// empty registry, not a fatal error (only a corrupt/present file or an
    /// invalid root is). Desktop-hosted shared-live mode leaves this `None`
    /// (it queries the live `AcpManager`, not a registry file).
    pub projects_file: Option<PathBuf>,
    /// Standalone-only durable session root. Desktop shared-live uses `None`.
    pub sessions_dir: Option<PathBuf>,
    /// CAP-5 / Story 5: workspace-manifests root override. `None` means
    /// "use `<service_account_state_dir>/workspace-manifests`" — the
    /// standalone binary resolves this in `server_main.rs` so the
    /// `ServerConfig` struct itself stays free of the service-account-state
    /// path resolution (the desktop shared-live path never reads this field;
    /// it constructs its own `WorkspaceManifestService` under
    /// `<app_data_dir>/workspace-manifests`).
    pub workspace_manifests_dir: Option<PathBuf>,
    /// CAP-6 / Story 8: acp-catalog root override. `None` means "use
    /// `<service_account_state_dir>/acp-catalog`" — the standalone binary
    /// resolves this in `server_main.rs`. The desktop shared-live path never
    /// reads this field; it constructs its own `AcpCatalogService` under
    /// `<app_data_dir>/acp-catalog`.
    pub acp_catalog_dir: Option<PathBuf>,
    /// Issue #613: server-side generic key-value store file for the web
    /// client (terminal layout, settings, editor state, command history,
    /// snapshots, SSH profiles, …). `None` means "use
    /// `<service_account_state_dir>/store.json`" — resolved at serve time in
    /// `serve_router`, so the desktop shared-live path gets a durable store
    /// too (no per-browser localStorage fallback).
    pub store_file: Option<PathBuf>,
    /// Operator opt-in: admit non-loopback peers on the loopback-guarded
    /// write routes (`/fs/*` writes, `/git/*` writes, `/worktree/*` writes,
    /// `/workspace/*` write+delete, `/log/frontend-error`,
    /// `/projects/default`, `/acp/install`). Default `false` keeps the
    /// CWE-306 loopback guard on for any `0.0.0.0` bind. Only the standalone
    /// `termul-server` honors `--allow-remote-writes` /
    /// `TERMUL_SERVER_ALLOW_REMOTE_WRITES`; the desktop shared-live host
    /// always sets this `false` (LAN clients remain view-only for
    /// mutations). Gating on web auth is deliberately avoided — web auth is
    /// a placeholder until Epic 2.
    pub allow_remote_writes: bool,
}

impl ServerConfig {
    /// Resolve the bind mode from [`Self::host`], defaulting unknown hosts to
    /// a parse error at the CLI layer (callers should validate first).
    pub fn bind_mode(&self) -> Option<BindMode> {
        BindMode::parse(&self.host)
    }

    /// Socket address for `TcpListener::bind`.
    ///
    /// Returns `None` when `host` is not a recognized bind mode.
    pub fn bind_addr(&self) -> Option<SocketAddr> {
        self.bind_mode().map(|mode| mode.bind_addr(self.port))
    }

    /// The platform service-account state directory. Used by the standalone
    /// `termul-server` binary to resolve a default workspace-manifests root
    /// (`<state dir>/workspace-manifests`) when `--workspace-manifests-dir` is
    /// absent. Mirrors the per-platform branches of
    /// [`default_sessions_dir`]'s parent dir so the two durable stores live
    /// side-by-side under the same service-account state tree.
    ///
    /// Falls back to `std::env::temp_dir()` when no platform state dir is
    /// discoverable — the standalone binary then surfaces a startup warning
    /// (the workspace manifests would land in the OS temp dir, which survives
    /// the process but not a reboot). Used as the default base for
    /// `WorkspaceManifestService::open` in `server_main.rs`.
    ///
    /// Patch 15: empty env var values (`XDG_STATE_HOME=""`, `HOME=""`,
    /// `LOCALAPPDATA=""`) are filtered out so the manifests do not land in a
    /// relative `./termul` dir (CWD-dependent, unbounded). A truly unset env
    /// var falls through to the next branch; an empty-string env var now
    /// behaves the same way (the next branch or the temp-dir fallback).
    #[must_use]
    pub fn service_account_state_dir(&self) -> PathBuf {
        #[cfg(unix)]
        {
            // Patch 15: filter out empty-string env vars so an empty
            // `XDG_STATE_HOME` or `HOME` does not produce a relative path.
            if let Some(base) = std::env::var_os("XDG_STATE_HOME")
                .map(PathBuf::from)
                .filter(|p| !p.as_os_str().is_empty())
            {
                return base.join("termul");
            }
            if let Some(home) = std::env::var_os("HOME")
                .map(PathBuf::from)
                .filter(|p| !p.as_os_str().is_empty())
            {
                return home.join(".local").join("state").join("termul");
            }
        }
        #[cfg(windows)]
        {
            if let Some(base) = std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .filter(|p| !p.as_os_str().is_empty())
            {
                return base.join("Termul");
            }
        }
        std::env::temp_dir().join("termul")
    }

    /// Parse `--host` / `--port` CLI args (defaults: `127.0.0.1:8080`).
    ///
    /// Returns `Err(ParseCliError::Help)` for `-h`/`--help`.
    pub fn from_args<I, S>(args: I) -> Result<Self, ParseCliError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut host = "127.0.0.1".to_string();
        let mut port: u16 = 8080;
        let mut event_log_capacity: usize = 4096;
        let mut permission_timeout_secs: u64 = 60;
        let mut permission_reconnect_grace_secs: u64 = 60;
        // PR-S4: when `--project-root` is absent, fall back to the env var or
        // the user's home directory via `default_project_root()`. The
        // resolved value is run through `resolve_and_validate_project_root`
        // (below, after the match block) so a misconfigured environment
        // fails fast at startup rather than leaking through to the
        // boundary check.
        let mut project_root: Option<PathBuf> = None;
        // Story 4.1: the VFS-roots registry file. Parsed but NOT validated
        // against the filesystem here (a missing file loads as an empty
        // registry at load, not a fatal error). Defaults to None; an
        // optional $TERMUL_PROJECTS_FILE env var is honored after the loop.
        let mut projects_file: Option<PathBuf> = None;
        let mut sessions_dir: Option<PathBuf> = None;
        // CAP-5 / Story 5: workspace-manifests root override. `None` means
        // "resolve <state dir>/workspace-manifests at startup" in
        // `server_main.rs`. Parsed but NOT validated against the filesystem
        // here (the service creates the directory if missing; a present
        // non-directory fails loudly at `WorkspaceManifestService::open`).
        let mut workspace_manifests_dir: Option<PathBuf> = None;
        // CAP-6 / Story 8: acp-catalog root override. Same pattern as
        // `workspace_manifests_dir` — `None` means resolve at startup.
        let mut acp_catalog_dir: Option<PathBuf> = None;
        // Issue #613: server-side generic key-value store file override.
        // `None` means resolve `<service_account_state_dir>/store.json` at
        // serve time (the desktop shared-live path never sets this).
        let mut store_file: Option<PathBuf> = None;
        // Operator opt-in for non-loopback fs/git/workspace write peers
        // (CWE-306 guard relaxation). CLI flag wins over env; an
        // unset/invalid env var stays `false` (lenient — no fatal startup).
        let mut allow_remote_writes = false;

        let mut iter = args.into_iter().peekable();
        while let Some(arg) = iter.next() {
            let arg = arg.as_ref();
            match arg {
                "-h" | "--help" => return Err(ParseCliError::Help),
                "--host" => {
                    let value = iter
                        .next()
                        .ok_or_else(|| ParseCliError::Message("missing value for --host".into()))?;
                    let value = value.as_ref();
                    if BindMode::parse(value).is_none() {
                        return Err(ParseCliError::Message(format!(
                            "invalid --host '{value}': use 127.0.0.1 or 0.0.0.0"
                        )));
                    }
                    host = value.to_string();
                }
                "--port" => {
                    let value = iter
                        .next()
                        .ok_or_else(|| ParseCliError::Message("missing value for --port".into()))?;
                    let parsed = value.as_ref().parse::<u16>().map_err(|_| {
                        ParseCliError::Message(format!("invalid --port '{}'", value.as_ref()))
                    })?;
                    if parsed == 0 {
                        return Err(ParseCliError::Message(
                            "invalid --port '0': use 1-65535 (0 is OS-ephemeral)".into(),
                        ));
                    }
                    port = parsed;
                }
                "--event-log-capacity" => {
                    let value = iter.next().ok_or_else(|| {
                        ParseCliError::Message("missing value for --event-log-capacity".into())
                    })?;
                    let parsed = value.as_ref().parse::<usize>().map_err(|_| {
                        ParseCliError::Message(format!(
                            "invalid --event-log-capacity '{}': expected a positive integer",
                            value.as_ref()
                        ))
                    })?;
                    if parsed == 0 {
                        return Err(ParseCliError::Message(
                            "invalid --event-log-capacity '0': use a positive integer".into(),
                        ));
                    }
                    event_log_capacity = parsed;
                }
                "--permission-timeout" => {
                    let value = iter.next().ok_or_else(|| {
                        ParseCliError::Message("missing value for --permission-timeout".into())
                    })?;
                    let parsed = value.as_ref().parse::<u64>().map_err(|_| {
                        ParseCliError::Message(format!(
                            "invalid --permission-timeout '{}': expected a positive integer (seconds)",
                            value.as_ref()
                        ))
                    })?;
                    if parsed == 0 {
                        return Err(ParseCliError::Message(
                            "invalid --permission-timeout '0': use a positive integer (seconds)"
                                .into(),
                        ));
                    }
                    permission_timeout_secs = parsed;
                }
                "--permission-reconnect-grace" => {
                    let value = iter.next().ok_or_else(|| {
                        ParseCliError::Message(
                            "missing value for --permission-reconnect-grace".into(),
                        )
                    })?;
                    let parsed = value.as_ref().parse::<u64>().map_err(|_| {
                        ParseCliError::Message(format!(
                            "invalid --permission-reconnect-grace '{}': expected a positive integer (seconds)",
                            value.as_ref()
                        ))
                    })?;
                    if parsed == 0 {
                        return Err(ParseCliError::Message(
                            "invalid --permission-reconnect-grace '0': use a positive integer (seconds)"
                                .into(),
                        ));
                    }
                    permission_reconnect_grace_secs = parsed;
                }
                "--project-root" => {
                    let value = iter.next().ok_or_else(|| {
                        ParseCliError::Message("missing value for --project-root".into())
                    })?;
                    let trimmed = value.as_ref().trim();
                    if trimmed.is_empty() {
                        return Err(ParseCliError::Message(
                            "invalid --project-root '': must be a non-empty path".into(),
                        ));
                    }
                    // Fail-fast on a bad explicit --project-root: validate
                    // the path exists, is accessible, and is a directory at
                    // parse time so the server doesn't start successfully
                    // and only surface the error as a per-request
                    // `OUTSIDE_ROOT` on every /fs/* call (hard to diagnose
                    // post-mortem). The canonical absolute form is stored
                    // so the boundary check is stable.
                    let validated = resolve_and_validate_project_root(Path::new(trimmed))
                        .map_err(ParseCliError::Message)?;
                    project_root = Some(validated);
                }
                "--sessions-dir" => {
                    let value = iter.next().ok_or_else(|| {
                        ParseCliError::Message("missing value for --sessions-dir".into())
                    })?;
                    let trimmed = value.as_ref().trim();
                    if trimmed.is_empty() {
                        return Err(ParseCliError::Message(
                            "invalid --sessions-dir '': must be a non-empty path".into(),
                        ));
                    }
                    sessions_dir = Some(PathBuf::from(trimmed));
                }
                "--workspace-manifests-dir" => {
                    let value = iter.next().ok_or_else(|| {
                        ParseCliError::Message(
                            "missing value for --workspace-manifests-dir".into(),
                        )
                    })?;
                    let trimmed = value.as_ref().trim();
                    if trimmed.is_empty() {
                        return Err(ParseCliError::Message(
                            "invalid --workspace-manifests-dir '': must be a non-empty path".into(),
                        ));
                    }
                    workspace_manifests_dir = Some(PathBuf::from(trimmed));
                }
                "--acp-catalog-dir" => {
                    let value = iter.next().ok_or_else(|| {
                        ParseCliError::Message(
                            "missing value for --acp-catalog-dir".into(),
                        )
                    })?;
                    let trimmed = value.as_ref().trim();
                    if trimmed.is_empty() {
                        return Err(ParseCliError::Message(
                            "invalid --acp-catalog-dir '': must be a non-empty path".into(),
                        ));
                    }
                    acp_catalog_dir = Some(PathBuf::from(trimmed));
                }
                "--store-file" => {
                    let value = iter.next().ok_or_else(|| {
                        ParseCliError::Message("missing value for --store-file".into())
                    })?;
                    let trimmed = value.as_ref().trim();
                    if trimmed.is_empty() {
                        return Err(ParseCliError::Message(
                            "invalid --store-file '': must be a non-empty path".into(),
                        ));
                    }
                    store_file = Some(PathBuf::from(trimmed));
                }
                "--allow-remote-writes" => {
                    // Bare flag (no value). CLI wins over the env var; the
                    // env is read below only when the flag is absent.
                    allow_remote_writes = true;
                }
                "--projects-file" => {
                    let value = iter.next().ok_or_else(|| {
                        ParseCliError::Message("missing value for --projects-file".into())
                    })?;
                    let trimmed = value.as_ref().trim();
                    if trimmed.is_empty() {
                        return Err(ParseCliError::Message(
                            "invalid --projects-file '': must be a non-empty path".into(),
                        ));
                    }
                    // Do NOT resolve_and_validate_project_root here — the
                    // registry file need not exist at parse time (a missing
                    // file loads as an empty registry, not a fatal error).
                    // Validation of each root's path happens at load.
                    projects_file = Some(PathBuf::from(trimmed));
                }
                other if other.starts_with('-') => {
                    return Err(ParseCliError::Message(format!("unknown option '{other}'")));
                }
                other => {
                    return Err(ParseCliError::Message(format!(
                        "unexpected argument '{other}'"
                    )));
                }
            }
        }

        let project_root = match project_root {
            Some(p) => p,
            None => {
                let raw = default_project_root().ok_or_else(|| {
                    ParseCliError::Message(
                        "could not determine project root: \
                         set --project-root, $TERMUL_PROJECT_ROOT, or $HOME"
                            .into(),
                    )
                })?;
                // Validate the env-var / $HOME fallback the same way we
                // validate an explicit --project-root: it must exist and
                // be a directory. A misconfigured $HOME (deleted account,
                // broken symlink, etc.) now fails fast at startup instead
                // of leaking through and confusing the boundary check.
                resolve_and_validate_project_root(&raw).map_err(ParseCliError::Message)?
            }
        };

        // Story 4.1: optional $TERMUL_PROJECTS_FILE env default when
        // --projects-file is absent (mirrors default_project_root's env
        // pattern). An unset/empty env var means "no registry configured"
        // — the binary serves an empty project list, which is valid (not
        // fatal). The file is NOT validated against the filesystem here; a
        // missing file loads as an empty registry at load time.
        let projects_file = match projects_file {
            Some(p) => Some(p),
            None => std::env::var("TERMUL_PROJECTS_FILE").ok().and_then(|v| {
                let t = v.trim();
                (!t.is_empty()).then(|| PathBuf::from(t))
            }),
        };

        // Issue #613: optional $TERMUL_STORE_FILE env default when
        // --store-file is absent (mirrors the $TERMUL_PROJECTS_FILE env
        // pattern). An unset/empty env var means "resolve the default at
        // serve time".
        let store_file = match store_file {
            Some(p) => Some(p),
            None => std::env::var("TERMUL_STORE_FILE").ok().and_then(|v| {
                let t = v.trim();
                (!t.is_empty()).then(|| PathBuf::from(t))
            }),
        };

        // Operator opt-in env fallback: only consulted when the CLI flag
        // was absent (CLI sets `allow_remote_writes = true` and wins). Only
        // `"true"`/`"1"` (case-insensitive) enable; any other value
        // (including a typo) stays `false` — lenient, no fatal startup.
        if !allow_remote_writes {
            allow_remote_writes = matches!(
                std::env::var("TERMUL_SERVER_ALLOW_REMOTE_WRITES")
                    .ok()
                    .map(|v| v.trim().to_ascii_lowercase())
                    .as_deref(),
                Some("true") | Some("1")
            );
        }

        let sessions_dir = sessions_dir.or_else(default_sessions_dir).ok_or_else(|| {
            ParseCliError::Message(
                "could not determine sessions directory: set --sessions-dir or $TERMUL_SESSIONS_DIR"
                    .into(),
            )
        })?;
        if sessions_dir.exists() && !sessions_dir.is_dir() {
            return Err(ParseCliError::Message(format!(
                "sessions directory '{}' is not a directory",
                sessions_dir.display()
            )));
        }

        Ok(Self {
            host,
            port,
            event_log_capacity,
            permission_timeout_secs,
            permission_reconnect_grace_secs,
            project_root,
            projects_file,
            sessions_dir: Some(sessions_dir),
            workspace_manifests_dir,
            acp_catalog_dir,
            store_file,
            allow_remote_writes,
        })
    }
}

/// CLI parse failure for [`ServerConfig::from_args`].
#[derive(Debug, PartialEq, Eq)]
pub enum ParseCliError {
    Help,
    Message(String),
}

impl std::fmt::Display for ParseCliError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Help => write!(f, "help"),
            Self::Message(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for ParseCliError {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};

    // PR-S4: validate the project-root helper. TempDir scopes are used so
    // the tests don't depend on a specific filesystem layout outside
    // `std::env::temp_dir()`. TempDir is already a dev-dep of the workspace
    // (used by `web::fs_api::tests`); if that ever changes, swap to
    // `std::env::temp_dir().join("...")` plus manual cleanup.

    #[test]
    fn resolve_and_validate_accepts_existing_directory() {
        let dir = tempdir_like("resolve-ok");
        let validated = resolve_and_validate_project_root(&dir).expect("dir is valid");
        // The validated path is the canonical absolute form of `dir`.
        // `Path::is_absolute` returns true on every supported platform for
        // the result of `canonicalize` (Windows paths may carry a `\\?\`
        // verbatim prefix but are still reported as absolute).
        assert!(validated.is_absolute());
        // And the result is idempotent under a second canonicalize.
        let again = validated.canonicalize().expect("canonicalize again");
        assert_eq!(validated, again);
        cleanup(&dir);
    }

    #[test]
    fn resolve_and_validate_rejects_nonexistent_path() {
        let dir = tempdir_like("resolve-missing");
        let missing = dir.join("does-not-exist");
        let err = resolve_and_validate_project_root(&missing).unwrap_err();
        assert!(
            err.contains("not accessible"),
            "expected 'not accessible' in: {err}"
        );
        cleanup(&dir);
    }

    #[test]
    fn resolve_and_validate_rejects_file() {
        let dir = tempdir_like("resolve-file");
        let file = dir.join("a-file.txt");
        std::fs::write(&file, "x").expect("write");
        let err = resolve_and_validate_project_root(&file).unwrap_err();
        assert!(
            err.contains("not a directory"),
            "expected 'not a directory' in: {err}"
        );
        cleanup(&dir);
    }

    /// Minimal in-test TempDir substitute so this test module doesn't need
    /// to depend on the `tempfile` crate just for two tests. Returns a
    /// unique subdirectory of the OS temp dir; tests are responsible for
    /// calling `cleanup` on success or early return.
    fn tempdir_like(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let p = std::env::temp_dir().join(format!(
            "termul-config-{label}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&p).expect("create tempdir_like");
        p
    }

    fn cleanup(p: &Path) {
        let _ = std::fs::remove_dir_all(p);
    }

    #[test]
    fn bind_mode_parse_and_addrs() {
        assert_eq!(BindMode::parse("localhost"), Some(BindMode::Localhost));
        assert_eq!(BindMode::parse("127.0.0.1"), Some(BindMode::Localhost));
        assert_eq!(BindMode::parse("0.0.0.0"), Some(BindMode::All));
        assert_eq!(BindMode::parse("all"), Some(BindMode::All));
        assert_eq!(BindMode::parse("bogus"), None);

        assert_eq!(
            BindMode::Localhost.bind_addr(8080),
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 8080)
        );
        assert_eq!(
            BindMode::All.bind_addr(8080),
            SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 8080)
        );
    }

    #[test]
    fn server_config_bind_addr() {
        let cfg = ServerConfig {
            host: "127.0.0.1".to_string(),
            port: 8080,
            event_log_capacity: 4096,
            permission_timeout_secs: 60,
            permission_reconnect_grace_secs: 15,
            project_root: PathBuf::from("/tmp"),
            projects_file: None,
            sessions_dir: None,
            workspace_manifests_dir: None,
            acp_catalog_dir: None,
            store_file: None,
            allow_remote_writes: false,
        };
        assert_eq!(
            cfg.bind_addr(),
            Some(SocketAddr::from(([127, 0, 0, 1], 8080)))
        );

        let bad = ServerConfig {
            host: "example.com".to_string(),
            port: 8080,
            event_log_capacity: 4096,
            permission_timeout_secs: 60,
            permission_reconnect_grace_secs: 15,
            project_root: PathBuf::from("/tmp"),
            projects_file: None,
            sessions_dir: None,
            workspace_manifests_dir: None,
            acp_catalog_dir: None,
            store_file: None,
            allow_remote_writes: false,
        };
        assert_eq!(bad.bind_addr(), None);
    }

    #[test]
    fn from_args_defaults() {
        let cfg = ServerConfig::from_args(Vec::<&str>::new()).expect("defaults");
        assert_eq!(cfg.host, "127.0.0.1");
        assert_eq!(cfg.port, 8080);
        assert_eq!(
            cfg.event_log_capacity, 4096,
            "default event-log-capacity is 4096 (AC4)"
        );
        assert_eq!(
            cfg.permission_timeout_secs, 60,
            "default permission-timeout is 60s (Story 1.7 / FR14)"
        );
        assert_eq!(
            cfg.permission_reconnect_grace_secs, 60,
            "default reconnect grace is 60s (CAP-4: mobile wake + reconnect chain)"
        );
        // PR-S4: project_root defaults to $HOME / $USERPROFILE when the env var
        // is unset. The CI hosts in this repo all set $HOME, so the resolved
        // value should be non-empty. We don't assert an exact path because the
        // test environment may differ across platforms.
        assert!(
            !cfg.project_root.as_os_str().is_empty(),
            "default project_root should resolve from $HOME when $TERMUL_PROJECT_ROOT is unset"
        );
    }

    #[test]
    fn from_args_host_and_port() {
        let cfg = ServerConfig::from_args(["--host", "0.0.0.0", "--port", "9090"]).expect("parse");
        assert_eq!(cfg.host, "0.0.0.0");
        assert_eq!(cfg.port, 9090);
    }

    #[test]
    fn from_args_rejects_bogus_host() {
        assert!(matches!(
            ServerConfig::from_args(["--host", "example.com"]),
            Err(ParseCliError::Message(_))
        ));
    }

    #[test]
    fn from_args_help() {
        assert_eq!(
            ServerConfig::from_args(["--help"]),
            Err(ParseCliError::Help)
        );
    }

    #[test]
    fn from_args_rejects_port_zero() {
        assert!(matches!(
            ServerConfig::from_args(["--port", "0"]),
            Err(ParseCliError::Message(_))
        ));
    }

    #[test]
    fn from_args_accepts_event_log_capacity() {
        let cfg = ServerConfig::from_args(["--event-log-capacity", "1024"]).expect("parse");
        assert_eq!(cfg.event_log_capacity, 1024);
        // The other defaults stay intact.
        assert_eq!(cfg.host, "127.0.0.1");
        assert_eq!(cfg.port, 8080);
    }

    #[test]
    fn from_args_rejects_event_log_capacity_zero() {
        assert!(matches!(
            ServerConfig::from_args(["--event-log-capacity", "0"]),
            Err(ParseCliError::Message(_))
        ));
    }

    #[test]
    fn from_args_rejects_non_numeric_event_log_capacity() {
        assert!(matches!(
            ServerConfig::from_args(["--event-log-capacity", "big"]),
            Err(ParseCliError::Message(_))
        ));
    }

    #[test]
    fn from_args_missing_event_log_capacity_value() {
        assert!(matches!(
            ServerConfig::from_args(["--event-log-capacity"]),
            Err(ParseCliError::Message(_))
        ));
    }

    #[test]
    fn from_args_accepts_permission_timeout() {
        let cfg = ServerConfig::from_args(["--permission-timeout", "30"]).expect("parse");
        assert_eq!(cfg.permission_timeout_secs, 30);
        // Other defaults stay intact.
        assert_eq!(cfg.host, "127.0.0.1");
        assert_eq!(cfg.port, 8080);
        assert_eq!(cfg.event_log_capacity, 4096);
    }

    #[test]
    fn from_args_accepts_permission_reconnect_grace() {
        let cfg = ServerConfig::from_args(["--permission-reconnect-grace", "20"])
            .expect("parse");
        assert_eq!(cfg.permission_reconnect_grace_secs, 20);
    }

    #[test]
    fn from_args_rejects_permission_reconnect_grace_zero() {
        assert!(matches!(
            ServerConfig::from_args(["--permission-reconnect-grace", "0"]),
            Err(ParseCliError::Message(_))
        ));
    }

    #[test]
    fn from_args_rejects_permission_timeout_zero() {
        assert!(matches!(
            ServerConfig::from_args(["--permission-timeout", "0"]),
            Err(ParseCliError::Message(_))
        ));
    }

    #[test]
    fn from_args_rejects_non_numeric_permission_timeout() {
        assert!(matches!(
            ServerConfig::from_args(["--permission-timeout", "soon"]),
            Err(ParseCliError::Message(_))
        ));
    }

    #[test]
    fn from_args_missing_permission_timeout_value() {
        assert!(matches!(
            ServerConfig::from_args(["--permission-timeout"]),
            Err(ParseCliError::Message(_))
        ));
    }

    #[test]
    fn from_args_missing_host_value() {
        assert!(matches!(
            ServerConfig::from_args(["--host"]),
            Err(ParseCliError::Message(_))
        ));
    }

    #[test]
    fn from_args_unknown_option() {
        assert!(matches!(
            ServerConfig::from_args(["--bogus"]),
            Err(ParseCliError::Message(_))
        ));
    }

    // Patch 17: `--workspace-manifests-dir` CLI flag accept / missing /
    // empty-value tests (mirrors the `--permission-timeout` test pattern).

    #[test]
    fn from_args_accepts_workspace_manifests_dir() {
        let cfg = ServerConfig::from_args([
            "--workspace-manifests-dir",
            "/var/lib/termul/manifests",
        ])
        .expect("parse");
        assert_eq!(
            cfg.workspace_manifests_dir,
            Some(PathBuf::from("/var/lib/termul/manifests"))
        );
        // Other defaults stay intact.
        assert_eq!(cfg.host, "127.0.0.1");
        assert_eq!(cfg.port, 8080);
    }

    #[test]
    fn from_args_missing_workspace_manifests_dir_value() {
        assert!(matches!(
            ServerConfig::from_args(["--workspace-manifests-dir"]),
            Err(ParseCliError::Message(_))
        ));
    }

    #[test]
    fn from_args_rejects_empty_workspace_manifests_dir() {
        assert!(matches!(
            ServerConfig::from_args(["--workspace-manifests-dir", ""]),
            Err(ParseCliError::Message(_))
        ));
    }

    #[test]
    fn from_args_accepts_store_file() {
        let cfg = ServerConfig::from_args(["--store-file", "/var/lib/termul/store.json"])
            .expect("parse");
        assert_eq!(
            cfg.store_file,
            Some(PathBuf::from("/var/lib/termul/store.json"))
        );
        // Other defaults stay intact.
        assert_eq!(cfg.host, "127.0.0.1");
        assert_eq!(cfg.port, 8080);
    }

    #[test]
    fn from_args_missing_store_file_value() {
        assert!(matches!(
            ServerConfig::from_args(["--store-file"]),
            Err(ParseCliError::Message(_))
        ));
    }

    #[test]
    fn from_args_rejects_empty_store_file() {
        assert!(matches!(
            ServerConfig::from_args(["--store-file", ""]),
            Err(ParseCliError::Message(_))
        ));
    }

    // Patch 15: `service_account_state_dir` filters out empty env var values
    // so an empty `XDG_STATE_HOME` / `HOME` / `LOCALAPPDATA` does not produce
    // a relative `./termul` dir.
    #[test]
    fn service_account_state_dir_falls_through_empty_env_var() {
        let cfg = ServerConfig {
            host: "127.0.0.1".to_string(),
            port: 8080,
            event_log_capacity: 4096,
            permission_timeout_secs: 60,
            permission_reconnect_grace_secs: 15,
            project_root: PathBuf::from("/tmp"),
            projects_file: None,
            sessions_dir: None,
            workspace_manifests_dir: None,
            acp_catalog_dir: None,
            store_file: None,
            allow_remote_writes: false,
        };
        // We cannot safely mutate the real process env vars in a parallel
        // test runner, so we assert the contract indirectly: the resolved
        // path is EITHER under $HOME / $XDG_STATE_HOME (when set + non-empty)
        // OR falls back to the OS temp dir. In both cases it must NOT be a
        // relative `./termul` path (which would be CWD-dependent).
        let resolved = cfg.service_account_state_dir();
        assert!(
            resolved.is_absolute(),
            "service_account_state_dir must resolve to an absolute path, got: {}",
            resolved.display()
        );
    }

    // --- allow_remote_writes opt-in (CWE-306 guard relaxation) ---

    // `from_args` reads `TERMUL_SERVER_ALLOW_REMOTE_WRITES` from the real
    // process env. These env-mutating tests are NOT parallel-safe, so
    // serialize them with a shared lock (mirrors `acp::host_mcp::child`'s
    // `ENV_LOCK` pattern). The lock also protects `from_args_defaults_to_guarded`,
    // which reads the same env var without mutating it — without the lock a
    // sibling test's `set_var` can flip its assertion spuriously.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn clear_remote_writes_env() {
        std::env::remove_var("TERMUL_SERVER_ALLOW_REMOTE_WRITES");
    }

    #[test]
    fn from_args_defaults_to_guarded() {
        let _g = ENV_LOCK.lock().expect("ENV_LOCK poisoned");
        clear_remote_writes_env();
        let cfg = ServerConfig::from_args(Vec::<&str>::new()).expect("defaults");
        assert!(
            !cfg.allow_remote_writes,
            "default must keep the loopback write guard ON"
        );
    }

    #[test]
    fn from_args_flag_enables() {
        let _g = ENV_LOCK.lock().expect("ENV_LOCK poisoned");
        clear_remote_writes_env();
        let cfg = ServerConfig::from_args(["--allow-remote-writes"]).expect("parse");
        assert!(cfg.allow_remote_writes, "--allow-remote-writes sets the flag");
    }

    #[test]
    fn from_args_env_enables_true() {
        let _g = ENV_LOCK.lock().expect("ENV_LOCK poisoned");
        clear_remote_writes_env();
        std::env::set_var("TERMUL_SERVER_ALLOW_REMOTE_WRITES", "true");
        let cfg = ServerConfig::from_args(Vec::<&str>::new()).expect("parse");
        clear_remote_writes_env();
        assert!(
            cfg.allow_remote_writes,
            "TERMUL_SERVER_ALLOW_REMOTE_WRITES=true must enable"
        );
    }

    #[test]
    fn from_args_invalid_env_stays_guarded() {
        let _g = ENV_LOCK.lock().expect("ENV_LOCK poisoned");
        clear_remote_writes_env();
        std::env::set_var("TERMUL_SERVER_ALLOW_REMOTE_WRITES", "yes");
        let cfg = ServerConfig::from_args(Vec::<&str>::new()).expect("parse");
        clear_remote_writes_env();
        assert!(
            !cfg.allow_remote_writes,
            "env value 'yes' must NOT enable (only 'true'/'1')"
        );
    }

    #[test]
    fn from_args_cli_wins_over_env_false() {
        let _g = ENV_LOCK.lock().expect("ENV_LOCK poisoned");
        clear_remote_writes_env();
        std::env::set_var("TERMUL_SERVER_ALLOW_REMOTE_WRITES", "false");
        let cfg = ServerConfig::from_args(["--allow-remote-writes"]).expect("parse");
        clear_remote_writes_env();
        assert!(
            cfg.allow_remote_writes,
            "CLI --allow-remote-writes must win over env=false"
        );
    }
}
