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
/// binary) so the boundary check in `fs_api::check_within_root` can rely
/// on `project_root` being a real, accessible directory rather than a path
/// string that only resolves correctly at the first request.
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
        let mut permission_reconnect_grace_secs: u64 = 15;
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
            cfg.permission_reconnect_grace_secs, 15,
            "default reconnect grace is 15s"
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
}
