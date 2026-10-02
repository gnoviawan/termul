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
        web_auth_token: None,
        state_dir: None,
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
        web_auth_token: None,
        state_dir: None,
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
    let cfg = ServerConfig::from_args(["--permission-reconnect-grace", "20"]).expect("parse");
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
    let cfg = ServerConfig::from_args(["--workspace-manifests-dir", "/var/lib/termul/manifests"])
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
    let cfg =
        ServerConfig::from_args(["--store-file", "/var/lib/termul/store.json"]).expect("parse");
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

#[test]
fn from_args_accepts_state_dir_and_prefers_it() {
    let cfg = ServerConfig::from_args(["--state-dir", "/var/lib/termul-state"]).expect("parse");
    assert_eq!(
        cfg.state_dir.as_deref(),
        Some(Path::new("/var/lib/termul-state"))
    );
    // The override wins over every env-based branch — this is the
    // onboard-launched server agreeing with the wizard's printed path.
    assert_eq!(
        cfg.service_account_state_dir(),
        PathBuf::from("/var/lib/termul-state")
    );
}

#[test]
fn from_args_missing_state_dir_value() {
    assert!(matches!(
        ServerConfig::from_args(["--state-dir"]),
        Err(ParseCliError::Message(_))
    ));
}

// Story 4.1 / QA remediation: `--projects-file` CLI flag accept /
// missing / empty-value tests (mirrors the `--store-file` test trio).

#[test]
fn from_args_accepts_projects_file() {
    let cfg = ServerConfig::from_args(["--projects-file", "/var/lib/termul/projects.json"])
        .expect("parse");
    assert_eq!(
        cfg.projects_file,
        Some(PathBuf::from("/var/lib/termul/projects.json"))
    );
    // Other defaults stay intact.
    assert_eq!(cfg.host, "127.0.0.1");
    assert_eq!(cfg.port, 8080);
}

#[test]
fn from_args_missing_projects_file_value() {
    assert!(matches!(
        ServerConfig::from_args(["--projects-file"]),
        Err(ParseCliError::Message(_))
    ));
}

#[test]
fn from_args_rejects_empty_state_dir() {
    assert!(matches!(
        ServerConfig::from_args(["--state-dir", ""]),
        Err(ParseCliError::Message(_))
    ));
}

#[test]
fn from_args_rejects_empty_projects_file() {
    assert!(matches!(
        ServerConfig::from_args(["--projects-file", ""]),
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
        web_auth_token: None,
        state_dir: None,
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
    assert!(
        cfg.allow_remote_writes,
        "--allow-remote-writes sets the flag"
    );
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
// --- web auth token (CAP-1 interim gate) ---

fn clear_web_auth_env() {
    std::env::remove_var("TERMUL_WEB_AUTH_TOKEN");
}

#[test]
fn from_args_accepts_web_auth_token() {
    let _g = ENV_LOCK.lock().expect("ENV_LOCK poisoned");
    clear_web_auth_env();
    let cfg = ServerConfig::from_args(["--web-auth-token", "s3cret"]).expect("parse");
    // Debug must redact (the token never lands in logs).
    assert!(!format!("{cfg:?}").contains("s3cret"));
    let token = cfg.web_auth_token.as_ref().expect("token parsed");
    assert_eq!(token.as_str(), "s3cret");
}

#[test]
fn from_args_rejects_empty_web_auth_token() {
    let _g = ENV_LOCK.lock().expect("ENV_LOCK poisoned");
    clear_web_auth_env();
    assert!(matches!(
        ServerConfig::from_args(["--web-auth-token", ""]),
        Err(ParseCliError::Message(_))
    ));
    assert!(matches!(
        ServerConfig::from_args(["--web-auth-token", "   "]),
        Err(ParseCliError::Message(_))
    ));
}

#[test]
fn from_args_missing_web_auth_token_value() {
    let _g = ENV_LOCK.lock().expect("ENV_LOCK poisoned");
    clear_web_auth_env();
    assert!(matches!(
        ServerConfig::from_args(["--web-auth-token"]),
        Err(ParseCliError::Message(_))
    ));
}

#[test]
fn from_args_web_auth_token_env_fallback() {
    let _g = ENV_LOCK.lock().expect("ENV_LOCK poisoned");
    clear_web_auth_env();
    std::env::set_var("TERMUL_WEB_AUTH_TOKEN", "env-token");
    let cfg = ServerConfig::from_args(Vec::<&str>::new()).expect("parse");
    clear_web_auth_env();
    assert_eq!(
        cfg.web_auth_token.expect("env token parsed").as_str(),
        "env-token"
    );
}

#[test]
fn from_args_web_auth_token_empty_env_ignored() {
    let _g = ENV_LOCK.lock().expect("ENV_LOCK poisoned");
    clear_web_auth_env();
    std::env::set_var("TERMUL_WEB_AUTH_TOKEN", "");
    let cfg = ServerConfig::from_args(Vec::<&str>::new()).expect("parse");
    clear_web_auth_env();
    assert!(
        cfg.web_auth_token.is_none(),
        "an empty TERMUL_WEB_AUTH_TOKEN must be ignored (no token)"
    );
}

// --- projects_file env/default resolution (QA remediation story 2) ---
//
// `from_args` resolves `projects_file` from `--projects-file`, then
// `$TERMUL_PROJECTS_FILE`, then the platform state dir via
// `default_projects_file()`. These env-mutating tests serialize on the
// shared `ENV_LOCK` (same process-global env as the allow_remote_writes
// tests) and save/restore every var they touch so sibling tests see an
// unchanged environment.

fn save_env(keys: &[&str]) -> Vec<(String, Option<std::ffi::OsString>)> {
    keys.iter()
        .map(|k| (k.to_string(), std::env::var_os(k)))
        .collect()
}

fn restore_env(saved: Vec<(String, Option<std::ffi::OsString>)>) {
    for (key, value) in saved {
        match value {
            Some(v) => std::env::set_var(&key, v),
            None => std::env::remove_var(&key),
        }
    }
}

#[test]
fn from_args_projects_file_flag_wins_over_env() {
    let _g = ENV_LOCK.lock().expect("ENV_LOCK poisoned");
    let saved = save_env(&["TERMUL_PROJECTS_FILE"]);
    std::env::set_var("TERMUL_PROJECTS_FILE", "/tmp/termul-env/projects.json");
    let cfg = ServerConfig::from_args(["--projects-file", "/tmp/termul-flag/projects.json"])
        .expect("parse");
    restore_env(saved);
    assert_eq!(
        cfg.projects_file,
        Some(PathBuf::from("/tmp/termul-flag/projects.json")),
        "explicit --projects-file must win over $TERMUL_PROJECTS_FILE"
    );
}

#[cfg(unix)]
#[test]
fn from_args_projects_file_env_wins_over_state_dir() {
    let _g = ENV_LOCK.lock().expect("ENV_LOCK poisoned");
    let saved = save_env(&["TERMUL_PROJECTS_FILE", "XDG_STATE_HOME"]);
    let state = tempdir_like("projects-env-wins");
    std::env::set_var("XDG_STATE_HOME", &state);
    std::env::set_var("TERMUL_PROJECTS_FILE", "/tmp/termul-env/projects.json");
    let cfg = ServerConfig::from_args(Vec::<&str>::new()).expect("parse");
    restore_env(saved);
    cleanup(&state);
    assert_eq!(
        cfg.projects_file,
        Some(PathBuf::from("/tmp/termul-env/projects.json")),
        "$TERMUL_PROJECTS_FILE must win over the state-dir default"
    );
}

#[cfg(unix)]
#[test]
fn from_args_projects_file_defaults_to_state_dir() {
    let _g = ENV_LOCK.lock().expect("ENV_LOCK poisoned");
    let saved = save_env(&["TERMUL_PROJECTS_FILE", "XDG_STATE_HOME"]);
    let state = tempdir_like("projects-default");
    std::env::remove_var("TERMUL_PROJECTS_FILE");
    std::env::set_var("XDG_STATE_HOME", &state);
    let cfg = ServerConfig::from_args(Vec::<&str>::new()).expect("parse");
    restore_env(saved);
    let expected = state.join("termul").join("projects.json");
    cleanup(&state);
    assert_eq!(
        cfg.projects_file,
        Some(expected),
        "no flag/env must default to $XDG_STATE_HOME/termul/projects.json"
    );
}

#[cfg(unix)]
#[test]
fn from_args_projects_file_empty_env_ignored() {
    let _g = ENV_LOCK.lock().expect("ENV_LOCK poisoned");
    let saved = save_env(&["TERMUL_PROJECTS_FILE", "XDG_STATE_HOME"]);
    let state = tempdir_like("projects-empty-env");
    std::env::set_var("TERMUL_PROJECTS_FILE", "   ");
    std::env::set_var("XDG_STATE_HOME", &state);
    let cfg = ServerConfig::from_args(Vec::<&str>::new()).expect("parse");
    restore_env(saved);
    let expected = state.join("termul").join("projects.json");
    cleanup(&state);
    assert_eq!(
        cfg.projects_file,
        Some(expected),
        "whitespace-only $TERMUL_PROJECTS_FILE must be ignored in favor of the default"
    );
}

#[test]
fn from_args_web_auth_token_cli_wins_over_env() {
    let _g = ENV_LOCK.lock().expect("ENV_LOCK poisoned");
    clear_web_auth_env();
    std::env::set_var("TERMUL_WEB_AUTH_TOKEN", "env-token");
    let cfg = ServerConfig::from_args(["--web-auth-token", "flag-token"]).expect("parse");
    clear_web_auth_env();
    assert_eq!(
        cfg.web_auth_token.expect("flag token parsed").as_str(),
        "flag-token"
    );
}

#[test]
fn default_projects_file_trims_padded_env() {
    let _g = ENV_LOCK.lock().expect("ENV_LOCK poisoned");
    let saved = save_env(&["TERMUL_PROJECTS_FILE"]);
    std::env::set_var(
        "TERMUL_PROJECTS_FILE",
        "  /tmp/termul-padded/projects.json  ",
    );
    let resolved = default_projects_file();
    restore_env(saved);
    assert_eq!(
        resolved,
        Some(PathBuf::from("/tmp/termul-padded/projects.json")),
        "padded $TERMUL_PROJECTS_FILE must be trimmed"
    );
}

#[cfg(unix)]
#[test]
fn default_projects_file_relative_xdg_falls_back_to_home() {
    let _g = ENV_LOCK.lock().expect("ENV_LOCK poisoned");
    let saved = save_env(&["TERMUL_PROJECTS_FILE", "XDG_STATE_HOME", "HOME"]);
    let home = tempdir_like("projects-relative-xdg");
    std::env::remove_var("TERMUL_PROJECTS_FILE");
    // The XDG base-dir spec requires XDG_STATE_HOME to be absolute; a
    // relative value is invalid and must fall through to the HOME-based
    // fallback rather than resolving CWD-relative.
    std::env::set_var("XDG_STATE_HOME", "relative/state");
    std::env::set_var("HOME", &home);
    let resolved = default_projects_file();
    restore_env(saved);
    let expected = home.join(".local/state/termul/projects.json");
    cleanup(&home);
    assert_eq!(
        resolved,
        Some(expected),
        "a relative XDG_STATE_HOME must be ignored in favor of the HOME fallback"
    );
}

#[cfg(unix)]
#[test]
fn default_projects_file_empty_xdg_falls_back_to_home() {
    let _g = ENV_LOCK.lock().expect("ENV_LOCK poisoned");
    let saved = save_env(&["TERMUL_PROJECTS_FILE", "XDG_STATE_HOME", "HOME"]);
    let home = tempdir_like("projects-empty-xdg");
    std::env::remove_var("TERMUL_PROJECTS_FILE");
    // Empty-string env vars must be filtered (Patch-15 parity with
    // service_account_state_dir): an empty XDG_STATE_HOME must NOT
    // produce a CWD-relative "termul/projects.json".
    std::env::set_var("XDG_STATE_HOME", "");
    std::env::set_var("HOME", &home);
    let resolved = default_projects_file();
    restore_env(saved);
    let expected = home.join(".local/state/termul/projects.json");
    cleanup(&home);
    assert_eq!(
        resolved,
        Some(expected),
        "empty XDG_STATE_HOME must fall through to the $HOME default"
    );
}

#[cfg(unix)]
#[test]
fn default_projects_file_none_when_no_state_dir() {
    let _g = ENV_LOCK.lock().expect("ENV_LOCK poisoned");
    let saved = save_env(&["TERMUL_PROJECTS_FILE", "XDG_STATE_HOME", "HOME"]);
    std::env::remove_var("TERMUL_PROJECTS_FILE");
    std::env::remove_var("XDG_STATE_HOME");
    std::env::remove_var("HOME");
    let resolved = default_projects_file();
    restore_env(saved);
    assert_eq!(
        resolved, None,
        "no env + no state dir must resolve to None (in-memory registry)"
    );
}

#[cfg(unix)]
#[test]
fn from_args_projects_file_none_when_no_state_dir() {
    let _g = ENV_LOCK.lock().expect("ENV_LOCK poisoned");
    let saved = save_env(&["TERMUL_PROJECTS_FILE", "XDG_STATE_HOME", "HOME"]);
    std::env::remove_var("TERMUL_PROJECTS_FILE");
    std::env::remove_var("XDG_STATE_HOME");
    std::env::remove_var("HOME");
    // Pass --project-root + --sessions-dir explicitly so the missing
    // $HOME cannot fail those unrelated resolutions first.
    let cfg = ServerConfig::from_args([
        "--project-root",
        "/tmp",
        "--sessions-dir",
        "/tmp/termul-no-state-sessions",
    ])
    .expect("parse");
    restore_env(saved);
    assert_eq!(
        cfg.projects_file, None,
        "no flag/env and no state dir must leave projects_file None"
    );
}
