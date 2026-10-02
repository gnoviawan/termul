//! Bind configuration for the standalone `termul-server` HTTP listener.
//!
//! Mirrors `remote::host::RemoteBindMode` so `--host` parsing stays consistent
//! across the desktop-hosted shared-live server and the headless ACP server.
//! The single-token web auth gate (CAP-1 interim) is configured here
//! (`--web-auth-token` / `$TERMUL_WEB_AUTH_TOKEN`); resolution + persistence
//! live in `web::auth`, the Epic-2 identity/authz model replaces both later.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use crate::web::auth::WebAuthToken;

/// Resolve the default project-root boundary for the routes that enforce it
/// (`/git/*`, `/skills`, `/search/content`). The `/fs/*` routes are
/// intentionally unconfined (ADR-007); this boundary applies to the
/// operation routes via `git_api::ensure_within_project_boundary`.
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

/// Resolve the default VFS-roots registry file (Story 4.1) for the
/// standalone `termul-server`. Mirrors [`default_sessions_dir`]'s chain:
/// `$TERMUL_PROJECTS_FILE` (trimmed, non-empty) →
/// `$XDG_STATE_HOME/termul/projects.json` →
/// `$HOME/.local/state/termul/projects.json` →
/// `%LOCALAPPDATA%/Termul/projects.json`.
///
/// Empty-string env vars (`XDG_STATE_HOME=""`, `HOME=""`,
/// `LOCALAPPDATA=""`) are filtered out so the default never becomes a
/// CWD-relative `termul/projects.json` (mirrors the Patch-15 guard in
/// [`ServerConfig::service_account_state_dir`]); an empty value falls
/// through to the next branch or the `None` outcome. A RELATIVE
/// `XDG_STATE_HOME` is likewise ignored (the XDG base-dir spec requires an
/// absolute path), falling through to the `$HOME/.local/state` fallback.
///
/// `None` is returned only when no platform state dir is discoverable and
/// the env var is unset; `ServerConfig::from_args` then leaves
/// `projects_file: None` and the server runs an in-memory registry
/// (projects do not persist across restarts — `server_main` logs a
/// warning). The file need not exist: a missing file loads as an empty
/// registry and is created on the first project mutation
/// (`FileProjectRegistry`'s atomic save creates the parent dirs).
pub fn default_projects_file() -> Option<PathBuf> {
    if let Ok(value) = std::env::var("TERMUL_PROJECTS_FILE") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    #[cfg(unix)]
    {
        if let Some(base) = std::env::var_os("XDG_STATE_HOME")
            .map(PathBuf::from)
            // The XDG base-dir spec requires XDG_STATE_HOME to be absolute;
            // a relative value is invalid and must be IGNORED so resolution
            // falls through to the $HOME/.local/state fallback below (a
            // relative path would silently become CWD-relative).
            .filter(|p| !p.as_os_str().is_empty() && p.is_absolute())
        {
            return Some(base.join("termul").join("projects.json"));
        }
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty())
            .map(|home| {
                home.join(".local")
                    .join("state")
                    .join("termul")
                    .join("projects.json")
            })
    }
    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty())
            .map(|base| base.join("Termul").join("projects.json"))
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
    // 2) Must be a directory. The `/fs/*` routes default-navigation and the
    //    `/git/*` containment both expect a directory root; a file would make
    //    `mkdir` unable to create children, `ls`/`browse` unable to list, so
    //    fail fast at startup instead.
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
    /// Project-root boundary for the routes that explicitly enforce it
    /// (`/git/*`, `/skills`, `/search/content` via
    /// `git_api::ensure_within_project_boundary` — refuses paths outside this
    /// root with `code: "OUTSIDE_ROOT"`, or `PATH_TRAVERSAL` for explicit `..`
    /// components). The `/fs/*` routes are intentionally NOT confined to this
    /// root (ADR-007 breadth policy: the directory picker + editor navigate
    /// outside the project); `/fs/*` writes reject only `..` traversal.
    /// Defaults to the user's home directory when unset (see
    /// [`default_project_root`]).
    pub project_root: PathBuf,
    /// Server-owned VFS-roots registry file (VPS mode, Story 4.1). The
    /// standalone `termul-server` binary loads this at startup and seeds the
    /// in-memory [`crate::web::project_registry::ProjectRegistry`] from it.
    /// [`ServerConfig::from_args`] resolves the state-dir default via
    /// [`default_projects_file`] (flag → `$TERMUL_PROJECTS_FILE` →
    /// `<state dir>/projects.json`), so `None` survives only when no
    /// platform state dir is discoverable — the binary then serves an
    /// in-memory registry and projects do NOT persist across restarts
    /// (`server_main` logs a warning). The file need not exist at parse
    /// time — a missing file loads as an empty registry, not a fatal error
    /// (only a corrupt/present file or an invalid root is). Desktop-hosted
    /// shared-live mode leaves this `None` (it queries the live
    /// `AcpManager`, not a registry file).
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
    /// mutations). The web auth token gate (`web_auth_token`)
    /// is independent: it authenticates the client, while this flag admits
    /// non-loopback peers to the write routes at all.
    pub allow_remote_writes: bool,
    /// Optional single-token web auth gate (CAP-1 interim, QA remediation
    /// Story 1). When `Some`, the server requires this bearer token on the
    /// `/ws` `authenticate` handshake, gates `/terminal/ws` operations until
    /// `authenticate`, and the router middleware requires it on every gated
    /// HTTP API route. Set via `--web-auth-token` or
    /// `$TERMUL_WEB_AUTH_TOKEN`. On a public bind (`--host 0.0.0.0`) with no
    /// configured token, `server_main` generates + persists one via
    /// `web::auth::resolve` (fail-closed); a loopback bind without a token
    /// stays ungated (legacy behavior). The desktop shared-live host always
    /// passes `None`.
    pub web_auth_token: Option<WebAuthToken>,
    /// Explicit service-account state dir override (`--state-dir`). When
    /// `Some`, [`Self::service_account_state_dir`] returns it verbatim
    /// instead of resolving `$XDG_STATE_HOME`/`$HOME`/`%LOCALAPPDATA%` from
    /// the process environment. The onboard wizard sets this so the
    /// background-launched server (systemd unit or `setsid` child) uses the
    /// exact state dir the wizard printed — a systemd unit without an env
    /// file otherwise resolves a DIFFERENT dir (its environment lacks the
    /// operator's `XDG_STATE_HOME`/`HOME`), and the generated web auth token
    /// would land somewhere other than the advertised path.
    pub state_dir: Option<PathBuf>,
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
        // Explicit `--state-dir` wins over every env-based branch: the
        // onboard wizard passes the dir it resolved (and printed) so the
        // background-launched server agrees with it byte-for-byte.
        if let Some(dir) = &self.state_dir {
            return dir.clone();
        }
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
        // registry at load, not a fatal error). When the flag is absent, the
        // $TERMUL_PROJECTS_FILE env var and then the platform state-dir
        // default (<state dir>/projects.json) are honored after the loop via
        // `default_projects_file()` — mirroring `default_sessions_dir`.
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
        // Explicit service-account state dir override (`--state-dir`); `None`
        // keeps the env-based resolution in `service_account_state_dir`.
        let mut state_dir: Option<PathBuf> = None;
        // Operator opt-in for non-loopback fs/git/workspace write peers
        // (CWE-306 guard relaxation). CLI flag wins over env; an
        // unset/invalid env var stays `false` (lenient — no fatal startup).
        let mut allow_remote_writes = false;
        // Optional web auth token (CAP-1 interim). The CLI flag wins over
        // $TERMUL_WEB_AUTH_TOKEN; an empty flag value is a parse error, an
        // empty env value is ignored (mirrors the other env fallbacks).
        let mut web_auth_token: Option<WebAuthToken> = None;

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
                    // `OUTSIDE_ROOT` on the containment-enforcing routes
                    // (`/git/*`, `/skills`, `/search/content` — NOT `/fs/*`,
                    // which is unconfined per ADR-007). Hard to diagnose
                    // post-mortem. The canonical absolute form is stored
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
                        ParseCliError::Message("missing value for --workspace-manifests-dir".into())
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
                        ParseCliError::Message("missing value for --acp-catalog-dir".into())
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
                "--state-dir" => {
                    let value = iter.next().ok_or_else(|| {
                        ParseCliError::Message("missing value for --state-dir".into())
                    })?;
                    let trimmed = value.as_ref().trim();
                    if trimmed.is_empty() {
                        return Err(ParseCliError::Message(
                            "invalid --state-dir '': must be a non-empty path".into(),
                        ));
                    }
                    state_dir = Some(PathBuf::from(trimmed));
                }
                "--allow-remote-writes" => {
                    // Bare flag (no value). CLI wins over the env var; the
                    // env is read below only when the flag is absent.
                    allow_remote_writes = true;
                }
                "--web-auth-token" => {
                    let value = iter.next().ok_or_else(|| {
                        ParseCliError::Message("missing value for --web-auth-token".into())
                    })?;
                    web_auth_token = Some(WebAuthToken::new(value.as_ref()).ok_or_else(|| {
                        ParseCliError::Message(
                            "invalid --web-auth-token: must be a non-empty token".into(),
                        )
                    })?);
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

        // Story 4.1 / QA remediation: resolve the projects registry file —
        // explicit --projects-file wins, then $TERMUL_PROJECTS_FILE, then the
        // platform state-dir default (<state dir>/projects.json) via
        // `default_projects_file()` — mirroring `sessions_dir`'s chain. The
        // file is NOT validated against the filesystem here; a missing file
        // loads as an empty registry at load time (and is created on the
        // first project mutation). `None` survives only when no state dir is
        // discoverable — the binary then serves an in-memory registry
        // (projects do not persist across restarts; `server_main` warns).
        let projects_file = projects_file.or_else(default_projects_file);

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
        // Optional $TERMUL_WEB_AUTH_TOKEN fallback when --web-auth-token is
        // absent. An unset/EMPTY env var is ignored (no token); only the CLI
        // flag rejects an empty value.
        let web_auth_token = web_auth_token.or_else(|| {
            std::env::var("TERMUL_WEB_AUTH_TOKEN")
                .ok()
                .and_then(|v| WebAuthToken::new(&v))
        });

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
            state_dir,
            allow_remote_writes,
            web_auth_token,
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
mod tests;
