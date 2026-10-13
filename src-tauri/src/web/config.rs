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
use crate::web::origin::OriginPolicy;

/// Non-empty, trimmed value of a path-like environment variable.
/// Whitespace-only and unset values are ignored so resolution falls
/// through to the next branch instead of becoming a blank path.
fn trimmed_env_path(key: &str) -> Option<PathBuf> {
    std::env::var(key).ok().and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| PathBuf::from(trimmed))
    })
}

/// Default idle-agent reap window in seconds (30 min). The one definition the
/// standalone server and the desktop host both read; no client holds a copy.
pub const DEFAULT_AGENT_IDLE_WINDOW_SECS: u64 = 1800;
/// Default reliable-queue overflow tolerance per client.
pub const DEFAULT_OVERFLOW_TOLERANCE: usize = 15;
/// Default command-receipt retention in seconds (10 min).
pub const DEFAULT_RECEIPT_RETENTION_SECS: u64 = 600;
/// Default age after which an unseen, absent device's store partition is
/// garbage collected: 90 days.
pub const DEFAULT_PARTITION_GC_AGE_SECS: u64 = 90 * 24 * 60 * 60;
/// Default per-device store partition byte budget: 16 MiB.
pub const DEFAULT_PARTITION_BYTE_BUDGET: u64 = 16 * 1024 * 1024;
/// Longest command-receipt retention the host honors (7 days); a larger
/// `--receipt-retention-secs` is clamped to it at startup.
pub const MAX_RECEIPT_RETENTION_SECS: u64 = 7 * 24 * 60 * 60;

const AGENT_IDLE_WINDOW_ENV: &str = "TERMUL_AGENT_IDLE_REAP_SECS";
const PARTITION_GC_AGE_ENV: &str = "TERMUL_PARTITION_GC_AGE_SECS";
const PARTITION_BYTE_BUDGET_ENV: &str = "TERMUL_PARTITION_BYTE_BUDGET";

/// Parse a strictly positive integer from a flag or env value.
fn parse_positive<T>(source: &str, value: &str) -> Result<T, ParseCliError>
where
    T: std::str::FromStr + PartialEq + From<u8>,
{
    let parsed = value.trim().parse::<T>().map_err(|_| {
        ParseCliError::Message(format!(
            "invalid {source} '{value}': expected a positive integer"
        ))
    })?;
    if parsed == T::from(0) {
        return Err(ParseCliError::Message(format!(
            "invalid {source} '{value}': use a positive integer"
        )));
    }
    Ok(parsed)
}

/// Positive integer from an env var. Unset and blank values mean "not
/// configured". An invalid value is ignored with a queued startup warning
/// (the pre-existing `TERMUL_AGENT_IDLE_REAP_SECS` behavior) — unlike the
/// flags, which fail startup.
fn positive_env<T>(key: &str, warnings: &mut Vec<String>) -> Option<T>
where
    T: std::str::FromStr + PartialEq + From<u8>,
{
    let raw = std::env::var(key).ok()?;
    if raw.trim().is_empty() {
        return None;
    }
    match parse_positive(&format!("${key}"), &raw) {
        Ok(value) => Some(value),
        Err(error) => {
            warnings.push(format!("{error}; ignoring it"));
            None
        }
    }
}

/// Next CLI token as a flag's value, or the shared `missing value` error.
fn require_value<S, I>(iter: &mut I, flag: &str) -> Result<S, ParseCliError>
where
    I: Iterator<Item = S>,
{
    iter.next()
        .ok_or_else(|| ParseCliError::Message(format!("missing value for {flag}")))
}

/// Consume the value of a removed flag when the next token is not another
/// `--flag`; `None` when the value is absent.
fn take_removed_flag_value<S, I>(iter: &mut std::iter::Peekable<I>) -> Option<String>
where
    S: AsRef<str>,
    I: Iterator<Item = S>,
{
    // `-h` stays the help flag, never the removed flag's value.
    if iter
        .peek()
        .is_some_and(|next| !next.as_ref().starts_with("--") && next.as_ref() != "-h")
    {
        iter.next().map(|value| value.as_ref().to_string())
    } else {
        None
    }
}

/// The single startup warning for one removed flag.
fn removed_flag_warning(flag: &str, value: Option<&str>) -> String {
    match value {
        Some(value) => format!(
            "{flag} (value '{value}') is a removed option: it is parsed and ignored; remove it from the launch command"
        ),
        None => format!(
            "{flag} (no value) is a removed option: it is parsed and ignored; remove it from the launch command"
        ),
    }
}

/// Resolve the default ACP session-history root for the standalone
/// `termul-server`: `$TERMUL_SESSIONS_DIR` (trimmed, non-empty) →
/// `$XDG_STATE_HOME/termul/sessions` →
/// `$HOME/.local/state/termul/sessions` →
/// `%LOCALAPPDATA%/Termul/sessions`.
///
/// Empty-string env vars (`XDG_STATE_HOME=""`, `HOME=""`,
/// `LOCALAPPDATA=""`) are filtered out so the default never becomes a
/// CWD-relative `termul/sessions` dir; a RELATIVE `XDG_STATE_HOME` is
/// likewise ignored (the XDG base-dir spec requires an absolute path) —
/// the same guard as [`default_projects_file`] (issue #839).
pub fn default_sessions_dir() -> Option<PathBuf> {
    if let Some(path) = trimmed_env_path("TERMUL_SESSIONS_DIR") {
        return Some(path);
    }
    #[cfg(unix)]
    {
        // Issue #839: empty-string env vars (XDG_STATE_HOME="", HOME="")
        // are filtered out so the default never becomes a CWD-relative
        // `termul/sessions` dir, and a RELATIVE XDG_STATE_HOME is ignored
        // (the XDG base-dir spec requires an absolute path) — mirroring
        // the guard documented on `default_projects_file` below.
        if let Some(base) = std::env::var_os("XDG_STATE_HOME")
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty() && p.is_absolute())
        {
            return Some(base.join("termul").join("sessions"));
        }
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty() && p.is_absolute())
            .map(|home| {
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
            .filter(|p| !p.as_os_str().is_empty())
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
    if let Some(path) = trimmed_env_path("TERMUL_PROJECTS_FILE") {
        return Some(path);
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

/// Resolve the default seed root registered as the one project when the
/// registry is empty. The `/fs/*` routes are intentionally unconfined
/// (ADR-007); the operation routes are bounded by the registry via
/// `git_api::ensure_within_project_boundary`.
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
/// binary) so the seeded project (and the registry-only boundary in
/// `git_api::ensure_within_project_boundary`) can rely on `project_root`
/// being a real, accessible directory rather than a path string that only
/// resolves correctly at the first request. The `/fs/*` browse/read routes
/// are intentionally broader (no boundary — ADR-007).
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
    /// Idle window (seconds) after which the host reaps an idle agent.
    /// `--agent-idle-window-secs` → `$TERMUL_AGENT_IDLE_REAP_SECS` →
    /// [`DEFAULT_AGENT_IDLE_WINDOW_SECS`] (1800). The desktop host reads the
    /// same default const.
    pub agent_idle_window_secs: u64,
    /// Outbound-queue overflow tolerance per client: consecutive failed
    /// enqueues before a peer that stopped draining is closed.
    /// `--overflow-tolerance` → [`DEFAULT_OVERFLOW_TOLERANCE`] (15). Read by
    /// `serve_router` into the connection runtime every `/ws` socket uses.
    pub overflow_tolerance: usize,
    /// How long the command ledger keeps a command's outcome, in seconds
    /// (bare command ids are kept six times as long).
    /// `--receipt-retention-secs` → [`DEFAULT_RECEIPT_RETENTION_SECS`] (600).
    /// `termul-server` builds its ledger from it; the desktop shared-live host
    /// uses the default.
    pub receipt_retention_secs: u64,
    /// Age (seconds) after which an unused per-device store partition is
    /// garbage collected. `--partition-gc-age-secs` →
    /// `$TERMUL_PARTITION_GC_AGE_SECS` → [`DEFAULT_PARTITION_GC_AGE_SECS`]
    /// (90 days). Read by the host's [`crate::web::store::StorePolicy`].
    pub partition_gc_age_secs: u64,
    /// Per-device store partition byte budget. `--partition-byte-budget` →
    /// `$TERMUL_PARTITION_BYTE_BUDGET` → [`DEFAULT_PARTITION_BYTE_BUDGET`]
    /// (16 MiB). A write that would push a partition past it is refused
    /// `STORE_PARTITION_FULL`.
    pub partition_byte_budget: u64,
    /// Startup warnings gathered while parsing: removed flags that are still
    /// accepted and ignored, and invalid tunable env values that were
    /// ignored. Tracing is initialised after parsing, so
    /// `server_main` emits each with `tracing::warn!` right after
    /// `init_tracing`. Empty for programmatic constructions.
    pub deprecation_warnings: Vec<String>,
    /// Seed root: when the project registry is empty at startup, one project
    /// is registered at this path (see
    /// `ProjectRegistry::seed_root_if_no_usable_project`) so the registry-only boundary
    /// (`git_api::ensure_within_project_boundary`) does not reject everything.
    /// It is NOT a boundary by itself — a non-empty registry ignores it. The
    /// `/fs/*` browse/read routes are intentionally not confined (ADR-007
    /// breadth policy). Defaults to the user's home directory when unset (see
    /// [`default_project_root`]).
    pub project_root: PathBuf,
    /// Server-owned VFS-roots registry file (VPS mode, Story 4.1). The
    /// standalone `termul-server` binary loads this at startup and seeds the
    /// in-memory [`crate::web::project_registry::ProjectRegistry`] from it.
    /// [`ServerConfig::from_args`] resolves this as `--projects-file` →
    /// `$TERMUL_PROJECTS_FILE` → `<--state-dir>/projects.json` when
    /// `--state-dir` was passed → the platform state dir (`$XDG_STATE_HOME`
    /// / `$HOME` / `%LOCALAPPDATA%`, via [`default_projects_file`]). An
    /// explicit `--state-dir` therefore beats HOME/XDG (issue #839 / #879).
    /// `None` survives only when no state dir is discoverable —
    /// the binary then serves an in-memory registry (projects do NOT
    /// persist across restarts; `server_main` logs a warning). The file
    /// need not exist at parse time — a missing file loads as an empty
    /// registry, not a fatal error (only a corrupt/present file or an
    /// invalid root is). Desktop-hosted shared-live mode leaves this
    /// `None` (it queries the live `AcpManager`, not a registry file).
    pub projects_file: Option<PathBuf>,
    /// Standalone-only durable session root. Resolved by
    /// [`ServerConfig::from_args`] as `--sessions-dir` →
    /// `$TERMUL_SESSIONS_DIR` → `<--state-dir>/sessions` when `--state-dir`
    /// was passed → the platform state dir (issue #839 / #879). Desktop
    /// shared-live uses `None` and does not consult this resolver.
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
    /// Extra `http`/`https` origins accepted when a request carries `Origin`
    /// and that origin's host and port differ from the request `Host`
    /// header. Empty (the default) accepts only the request's own host and
    /// port. Set via `--allowed-origins` or `$TERMUL_ALLOWED_ORIGINS` for a
    /// reverse proxy whose public origin does not match the `Host` header
    /// the server sees. Clients that omit `Origin` are unchanged.
    pub allowed_origins: OriginPolicy,
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
        let mut agent_idle_window_secs: Option<u64> = None;
        let mut overflow_tolerance: usize = DEFAULT_OVERFLOW_TOLERANCE;
        let mut receipt_retention_secs: u64 = DEFAULT_RECEIPT_RETENTION_SECS;
        // The last requested value above the cap; the clamp warning is queued
        // after parsing so a repeated flag cannot leave a stale warning.
        let mut receipt_retention_over_cap: Option<u64> = None;
        let mut partition_gc_age_secs: Option<u64> = None;
        let mut partition_byte_budget: Option<u64> = None;
        let mut deprecation_warnings: Vec<String> = Vec::new();
        // PR-S4: when `--project-root` is absent, fall back to the env var or
        // the user's home directory via `default_project_root()`. The
        // resolved value is run through `resolve_and_validate_project_root`
        // (below, after the match block) so a misconfigured environment
        // fails fast at startup rather than leaking through to the
        // boundary check.
        let mut project_root: Option<PathBuf> = None;
        // Story 4.1: the VFS-roots registry file. Parsed but NOT validated
        // against the filesystem here (a missing file loads as an empty
        // registry at load, not a fatal error). When the flag is absent,
        // resolution after the loop is `$TERMUL_PROJECTS_FILE`, then
        // `<--state-dir>/projects.json` when `--state-dir` was passed, then
        // the HOME/XDG platform default (`default_projects_file`).
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
        // Extra origins for a reverse proxy. `None` until a flag is seen so
        // the env var is consulted only when the flag is absent.
        let mut allowed_origins_cli: Option<OriginPolicy> = None;

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
                "--agent-idle-window-secs" => {
                    let value = require_value(&mut iter, "--agent-idle-window-secs")?;
                    agent_idle_window_secs =
                        Some(parse_positive::<u64>("--agent-idle-window-secs", value.as_ref())?);
                }
                "--overflow-tolerance" => {
                    let value = require_value(&mut iter, "--overflow-tolerance")?;
                    overflow_tolerance =
                        parse_positive::<usize>("--overflow-tolerance", value.as_ref())?;
                }
                "--receipt-retention-secs" => {
                    let value = require_value(&mut iter, "--receipt-retention-secs")?;
                    receipt_retention_secs =
                        parse_positive::<u64>("--receipt-retention-secs", value.as_ref())?;
                    receipt_retention_over_cap = (receipt_retention_secs
                        > MAX_RECEIPT_RETENTION_SECS)
                        .then_some(receipt_retention_secs);
                    receipt_retention_secs =
                        receipt_retention_secs.min(MAX_RECEIPT_RETENTION_SECS);
                }
                "--partition-gc-age-secs" => {
                    let value = require_value(&mut iter, "--partition-gc-age-secs")?;
                    partition_gc_age_secs =
                        Some(parse_positive::<u64>("--partition-gc-age-secs", value.as_ref())?);
                }
                "--partition-byte-budget" => {
                    let value = require_value(&mut iter, "--partition-byte-budget")?;
                    partition_byte_budget =
                        Some(parse_positive::<u64>("--partition-byte-budget", value.as_ref())?);
                }
                // Removed flags: still parsed (so existing launch scripts and
                // unit files keep starting) but ignored. Their value is
                // consumed when present and never validated — a zero,
                // non-numeric or missing value must not abort startup. One
                // warning each is queued for `server_main` to emit once
                // tracing is initialised.
                "--permission-timeout" | "--permission-reconnect-grace" => {
                    let value = take_removed_flag_value(&mut iter);
                    deprecation_warnings.push(removed_flag_warning(arg, value.as_deref()));
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
                "--allowed-origins" => {
                    let value = iter.next().ok_or_else(|| {
                        ParseCliError::Message("missing value for --allowed-origins".into())
                    })?;
                    let parsed = OriginPolicy::parse_list(value.as_ref()).map_err(|error| {
                        ParseCliError::Message(format!("invalid --allowed-origins: {error}"))
                    })?;
                    allowed_origins_cli = Some(match allowed_origins_cli.take() {
                        Some(previous) => previous.merge(parsed),
                        None => parsed,
                    });
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

        // Story 4.1 / issue #839 / #879: resolve the projects registry file.
        // `--projects-file` wins, then `$TERMUL_PROJECTS_FILE`, then
        // `<--state-dir>/projects.json` when `--state-dir` was passed, and
        // only then the HOME/XDG platform default. The platform default must
        // not run first: `$HOME` is almost always set, so putting
        // `default_projects_file()` ahead of the state-dir derivation made
        // `--state-dir` a no-op for projects. The specific env var still
        // outranks `--state-dir` so an operator's TERMUL_PROJECTS_FILE keeps
        // its registry. With no `--state-dir`, resolution is unchanged
        // (env, then HOME/XDG) — the desktop app and unscoped server starts
        // rely on that. The file is NOT validated against the filesystem
        // here; a missing file loads as an empty registry at load time.
        // `None` survives only when no state dir is discoverable — the
        // binary then serves an in-memory registry (`server_main` warns).
        let projects_file = projects_file
            .or_else(|| trimmed_env_path("TERMUL_PROJECTS_FILE"))
            .or_else(|| state_dir.as_ref().map(|dir| dir.join("projects.json")))
            .or_else(default_projects_file);

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
        let allowed_origins =
            OriginPolicy::from_cli_or_env(allowed_origins_cli).map_err(ParseCliError::Message)?;

        // Issue #839 / #879: explicit --sessions-dir wins, then
        // `$TERMUL_SESSIONS_DIR`, then `<--state-dir>/sessions` when
        // `--state-dir` was passed, and only then the HOME/XDG platform
        // default. HOME/XDG must not outrank `--state-dir` — `$HOME` is set
        // on a real machine, so the old order never reached the derivation
        // and sessions leaked into `~/.local/state/termul/sessions`. With no
        // `--state-dir`, `default_sessions_dir()` is unchanged. A session
        // dir derived from `--state-dir` is created on demand by the
        // persistence layer. The onboard wizard still passes `--sessions-dir`
        // explicitly (that flag wins) and appends the same `--state-dir` it
        // printed, so the launched server stays on the wizard's paths.
        let sessions_dir = sessions_dir
            .or_else(|| trimmed_env_path("TERMUL_SESSIONS_DIR"))
            .or_else(|| state_dir.as_ref().map(|dir| dir.join("sessions")))
            .or_else(default_sessions_dir)
            .ok_or_else(|| {
                ParseCliError::Message(
                    "could not determine sessions directory: set --sessions-dir, --state-dir, or $TERMUL_SESSIONS_DIR"
                        .into(),
                )
            })?;
        if sessions_dir.exists() && !sessions_dir.is_dir() {
            return Err(ParseCliError::Message(format!(
                "sessions directory '{}' is not a directory",
                sessions_dir.display()
            )));
        }

        if let Some(requested) = receipt_retention_over_cap {
            deprecation_warnings.push(format!(
                "--receipt-retention-secs {requested} exceeds the maximum; using {MAX_RECEIPT_RETENTION_SECS} (7 days)"
            ));
        }

        // Tunables: `--flag` wins, then the env var (where one exists), then
        // the shared `DEFAULT_*` const. An invalid env value is ignored with
        // a startup warning; an invalid flag value already failed above.
        let agent_idle_window_secs = agent_idle_window_secs
            .or_else(|| positive_env::<u64>(AGENT_IDLE_WINDOW_ENV, &mut deprecation_warnings))
            .unwrap_or(DEFAULT_AGENT_IDLE_WINDOW_SECS);
        let partition_gc_age_secs = partition_gc_age_secs
            .or_else(|| positive_env::<u64>(PARTITION_GC_AGE_ENV, &mut deprecation_warnings))
            .unwrap_or(DEFAULT_PARTITION_GC_AGE_SECS);
        let partition_byte_budget = partition_byte_budget
            .or_else(|| positive_env::<u64>(PARTITION_BYTE_BUDGET_ENV, &mut deprecation_warnings))
            .unwrap_or(DEFAULT_PARTITION_BYTE_BUDGET);

        Ok(Self {
            host,
            port,
            event_log_capacity,
            agent_idle_window_secs,
            overflow_tolerance,
            receipt_retention_secs,
            partition_gc_age_secs,
            partition_byte_budget,
            deprecation_warnings,
            project_root,
            projects_file,
            sessions_dir: Some(sessions_dir),
            workspace_manifests_dir,
            acp_catalog_dir,
            store_file,
            state_dir,
            allow_remote_writes,
            web_auth_token,
            allowed_origins,
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
