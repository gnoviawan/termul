use super::*;

fn answers_localhost() -> OnboardAnswers {
    OnboardAnswers {
        host: "127.0.0.1".into(),
        port: 8080,
        project_root: PathBuf::from("/home/opus"),
        sessions_dir: PathBuf::from("/home/opus/.local/state/termul/sessions"),
        projects_file: PathBuf::from("/home/opus/.local/state/termul/projects.json"),
        allow_remote_writes: false,
        update_channel: None,
        update_interval_secs: 21600,
    }
}

fn answers_expose_remote() -> OnboardAnswers {
    OnboardAnswers {
        host: "0.0.0.0".into(),
        port: 8080,
        project_root: PathBuf::from("/home/opus"),
        sessions_dir: PathBuf::from("/home/opus/.local/state/termul/sessions"),
        projects_file: PathBuf::from("/home/opus/.local/state/termul/projects.json"),
        allow_remote_writes: true,
        update_channel: None,
        update_interval_secs: 21600,
    }
}

fn answers_with_update() -> OnboardAnswers {
    OnboardAnswers {
        host: "127.0.0.1".into(),
        port: 8080,
        project_root: PathBuf::from("/home/opus"),
        sessions_dir: PathBuf::from("/home/opus/.local/state/termul/sessions"),
        projects_file: PathBuf::from("/home/opus/.local/state/termul/projects.json"),
        allow_remote_writes: false,
        update_channel: Some(UpdateChannel::Stable),
        update_interval_secs: 21600,
    }
}

#[test]
fn command_args_loopback_no_remote_writes() {
    let a = answers_localhost();
    let args = a.to_command_args();
    assert_eq!(
        args,
        vec![
            "--host".to_string(),
            "127.0.0.1".into(),
            "--port".into(),
            "8080".into(),
            "--project-root".into(),
            "/home/opus".into(),
            "--sessions-dir".into(),
            "/home/opus/.local/state/termul/sessions".into(),
            "--projects-file".to_string(),
            "/home/opus/.local/state/termul/projects.json".into(),
        ]
    );
    assert!(!args.iter().any(|a| a == "--allow-remote-writes"));
}

#[test]
fn default_answers_args_and_config_carry_projects_file() {
    // QA remediation (story 2): the generated args — and hence the
    // systemd unit's ExecStart — must pin `--projects-file` explicitly so
    // the registry survives restarts even when the unit's environment
    // (e.g. HOME-less) could not re-resolve the same default. The
    // synthesized ServerConfig must carry `Some(projects_file)`.
    let a = OnboardAnswers::defaults();
    let args = a.to_command_args();
    let pos = args
        .iter()
        .position(|x| x == "--projects-file")
        .expect("default args must carry --projects-file");
    assert_eq!(
        args[pos + 1],
        a.projects_file.display().to_string(),
        "--projects-file must carry the resolved default, got: {args:?}"
    );
    let cfg = a.to_server_config();
    assert_eq!(
        cfg.projects_file,
        Some(a.projects_file.clone()),
        "synthesized ServerConfig.projects_file must be Some"
    );
}

#[test]
fn generated_unit_text_pins_projects_file() {
    // CAP-2 acceptance: the onboarding-GENERATED unit (not just the arg
    // vector) must wire the projects file. Composes the same steps
    // install_and_start uses: to_command_args → build_exec_start →
    // build_systemd_unit_text.
    let a = answers_localhost();
    let exec_start = build_exec_start(
        Path::new("/usr/local/bin/termul-server"),
        &a.to_command_args(),
    );
    let unit = build_systemd_unit_text(&exec_start, None, SystemdScope::System);
    assert!(
        unit.contains("\"--projects-file\""),
        "generated unit must pin --projects-file, got:\n{unit}"
    );
    assert!(
        unit.contains("\"/home/opus/.local/state/termul/projects.json\""),
        "generated unit must carry the projects file path, got:\n{unit}"
    );
}

#[test]
fn generated_unit_preserves_literal_percent_in_projects_file() {
    // systemd runs specifier expansion on the whole unit text regardless
    // of quoting: a literal `%` in the projects-file path must be doubled
    // (`%%`) in the generated ExecStart or systemd would expand/reject it
    // and the server would start with a wrong registry path.
    let mut a = answers_localhost();
    a.projects_file = PathBuf::from("/home/opus/.local/state/termul/100%/projects.json");
    let exec_start = build_exec_start(
        Path::new("/usr/local/bin/termul-server"),
        &a.to_command_args(),
    );
    let unit = build_systemd_unit_text(&exec_start, None, SystemdScope::System);
    assert!(
        unit.contains("\"/home/opus/.local/state/termul/100%%/projects.json\""),
        "generated unit must escape % as %%, got:\n{unit}"
    );
    assert!(
        !unit.contains("100%/projects.json"),
        "generated unit must not carry a bare %, got:\n{unit}"
    );
}

#[test]
fn collect_wires_typed_projects_file_through_args_and_config() {
    // Drives the interactive prompt loop with scripted answers (typed
    // values for the three path prompts, defaults elsewhere) and asserts
    // each typed value lands in its own field — a prompt-wiring miswire
    // (e.g. sessions_dir cloned into projects_file) fails here. No env
    // dependence: every value the loop consumes comes from the script.
    // The project-root prompt validates via resolve_and_validate_project_root
    // (canonicalize + must be an existing directory), so the scripted root
    // must exist on every test platform — /tmp would fail validation on
    // Windows, misaligning the remaining scripted lines. CARGO_MANIFEST_DIR
    // is always an existing directory when tests compile.
    let project_root = env!("CARGO_MANIFEST_DIR");
    let input =
        format!("\n\n{project_root}\n/tmp/qa-collect-sessions\n/tmp/qa-collect-projects.json\n\n");
    let mut stdin = std::io::BufReader::new(input.as_bytes());
    let mut stdout = Vec::new();
    let answers = OnboardAnswers::collect(&mut stdin, &mut stdout);
    assert_eq!(
        answers.sessions_dir,
        PathBuf::from("/tmp/qa-collect-sessions"),
        "sessions-dir prompt must land in sessions_dir"
    );
    assert_eq!(
        answers.projects_file,
        PathBuf::from("/tmp/qa-collect-projects.json"),
        "projects-file prompt must land in projects_file"
    );
    assert_ne!(
        answers.projects_file, answers.sessions_dir,
        "projects file and sessions dir must not be wired to the same value"
    );
    let args = answers.to_command_args();
    let pos = args
        .iter()
        .position(|a| a == "--projects-file")
        .expect("args must carry --projects-file");
    assert_eq!(args[pos + 1], "/tmp/qa-collect-projects.json");
    assert_eq!(
        answers.to_server_config().projects_file,
        Some(PathBuf::from("/tmp/qa-collect-projects.json"))
    );
}

#[test]
fn collect_normalizes_relative_projects_file_to_absolute() {
    // A relative projects-file answer must be resolved against the
    // operator's cwd before it reaches to_command_args / the generated
    // systemd unit (whose working directory is unpredictable). Absolute
    // answers are preserved verbatim (covered by
    // collect_wires_typed_projects_file_through_args_and_config).
    let project_root = env!("CARGO_MANIFEST_DIR");
    let input =
        format!("\n\n{project_root}\n/tmp/qa-collect-sessions\nqa-relative/projects.json\n\n");
    let mut stdin = std::io::BufReader::new(input.as_bytes());
    let mut stdout = Vec::new();
    let answers = OnboardAnswers::collect(&mut stdin, &mut stdout);
    let expected = std::env::current_dir()
        .expect("cwd")
        .join("qa-relative/projects.json");
    assert!(
        answers.projects_file.is_absolute(),
        "projects_file must be absolute after collect, got: {}",
        answers.projects_file.display()
    );
    assert_eq!(answers.projects_file, expected);
    let args = answers.to_command_args();
    let pos = args
        .iter()
        .position(|a| a == "--projects-file")
        .expect("args must carry --projects-file");
    assert_eq!(
        args[pos + 1],
        expected.display().to_string(),
        "generated args must carry the absolute normalized path"
    );
}

#[test]
fn command_args_expose_remote_writes_adds_flag() {
    let a = answers_expose_remote();
    let args = a.to_command_args();
    assert!(args.iter().any(|a| a == "--allow-remote-writes"));
}

#[test]
fn env_lines_loopback_no_updates_has_shell_home_only() {
    // Loopback + no updates: only SHELL/HOME (from passwd) plus no
    // remote-writes or update vars.
    let a = answers_localhost();
    let lines = a.to_env_lines();
    assert!(
        !lines
            .iter()
            .any(|l| l.starts_with("TERMUL_SERVER_ALLOW_REMOTE_WRITES")),
        "loopback must not emit remote-writes"
    );
    assert!(
        !lines.iter().any(|l| l.starts_with("TERMUL_SERVER_UPDATE")),
        "no update channel must not emit update vars"
    );
    #[cfg(unix)]
    if let Some(identity) = crate::pty::env_refresh::service_identity_from_passwd() {
        assert!(
            lines
                .iter()
                .any(|l| l == &format!("SHELL={}", identity.shell)),
            "must emit passwd SHELL, got: {lines:?}"
        );
        assert!(
            lines
                .iter()
                .any(|l| l == &format!("HOME={}", identity.home)),
            "must emit passwd HOME, got: {lines:?}"
        );
    }
}

#[test]
fn env_lines_expose_remote_writes() {
    let a = answers_expose_remote();
    let lines = a.to_env_lines();
    assert!(lines
        .iter()
        .any(|l| l == "TERMUL_SERVER_ALLOW_REMOTE_WRITES=true"));
}

#[test]
fn env_lines_with_update_channel() {
    let a = answers_with_update();
    let lines = a.to_env_lines();
    assert!(lines
        .iter()
        .any(|l| l == "TERMUL_SERVER_UPDATE_ENABLED=true"));
    assert!(lines
        .iter()
        .any(|l| l == "TERMUL_SERVER_UPDATE_CHANNEL=stable"));
    assert!(lines
        .iter()
        .any(|l| l == "TERMUL_SERVER_UPDATE_INTERVAL_SECS=21600"));
}

#[test]
fn to_server_config_loopback_disables_remote_writes() {
    let a = answers_localhost();
    let cfg = a.to_server_config();
    assert!(!cfg.allow_remote_writes);
    assert_eq!(cfg.host, "127.0.0.1");
    assert_eq!(cfg.port, 8080);
    assert_eq!(cfg.project_root, PathBuf::from("/home/opus"));
    assert_eq!(
        cfg.sessions_dir.as_ref(),
        Some(&PathBuf::from("/home/opus/.local/state/termul/sessions"))
    );
}

#[test]
fn to_server_config_expose_enables_remote_writes() {
    let a = answers_expose_remote();
    let cfg = a.to_server_config();
    assert!(cfg.allow_remote_writes);
}

#[test]
fn detect_from_systemd_root_is_system_scope() {
    assert_eq!(
        detect_from(true, true),
        ServiceManager::Systemd {
            scope: SystemdScope::System
        }
    );
}

#[test]
fn detect_from_systemd_nonroot_is_user_scope() {
    assert_eq!(
        detect_from(true, false),
        ServiceManager::Systemd {
            scope: SystemdScope::User
        }
    );
}

#[test]
fn detect_from_no_systemd_is_setsid() {
    assert_eq!(detect_from(false, true), ServiceManager::Setsid);
    assert_eq!(detect_from(false, false), ServiceManager::Setsid);
}

#[test]
fn systemd_unit_text_with_env_file_has_required_fields() {
    let unit = build_systemd_unit_text(
        "/usr/local/bin/termul-server --host 127.0.0.1",
        Some("/etc/termul/termul-server.env"),
        SystemdScope::System,
    );
    assert!(unit.contains("ExecStart="));
    assert!(unit.contains("EnvironmentFile="));
    assert!(unit.contains("Restart=on-failure"));
    assert!(unit.contains("WantedBy=multi-user.target"));
}

#[test]
fn systemd_unit_text_without_env_file_omits_environment_file() {
    let unit = build_systemd_unit_text(
        "/usr/local/bin/termul-server --host 127.0.0.1",
        None,
        SystemdScope::System,
    );
    assert!(unit.contains("ExecStart="));
    assert!(!unit.contains("EnvironmentFile="));
    assert!(unit.contains("Restart=on-failure"));
}

#[test]
fn systemd_unit_text_user_scope_uses_default_target() {
    // BH#2: user-scope units must use `default.target`, not
    // `multi-user.target` (which doesn't exist in the user systemd
    // instance and makes `systemctl --user enable` fail).
    let unit = build_systemd_unit_text(
        "/usr/local/bin/termul-server --host 127.0.0.1",
        None,
        SystemdScope::User,
    );
    assert!(
        unit.contains("WantedBy=default.target"),
        "user-scope unit must use default.target, got:\n{unit}"
    );
    assert!(
        !unit.contains("WantedBy=multi-user.target"),
        "user-scope unit must NOT use multi-user.target, got:\n{unit}"
    );
}

#[test]
fn systemd_unit_text_system_scope_uses_multi_user_target() {
    let unit = build_systemd_unit_text(
        "/usr/local/bin/termul-server --host 127.0.0.1",
        None,
        SystemdScope::System,
    );
    assert!(unit.contains("WantedBy=multi-user.target"));
}

#[test]
fn env_lines_expose_with_update_channel_orders_remote_then_update() {
    // BH#15: expose+update env-lines ordering + content.
    let mut a = answers_expose_remote();
    a.update_channel = Some(UpdateChannel::Nightly);
    a.update_interval_secs = 3600;
    let lines = a.to_env_lines();
    assert!(lines
        .iter()
        .any(|l| l == "TERMUL_SERVER_ALLOW_REMOTE_WRITES=true"));
    assert!(lines
        .iter()
        .any(|l| l == "TERMUL_SERVER_UPDATE_ENABLED=true"));
    assert!(lines
        .iter()
        .any(|l| l == "TERMUL_SERVER_UPDATE_CHANNEL=nightly"));
    assert!(lines
        .iter()
        .any(|l| l == "TERMUL_SERVER_UPDATE_INTERVAL_SECS=3600"));
}

#[test]
fn write_access_info_systemd_user_scope_includes_user_flag() {
    // BH#3: the TTY access-info path must print `--user` for user-scope
    // units (the non-TTY tip already did; this covers write_access_info).
    let mut out = Vec::new();
    write_access_info(
        &mut out,
        &ServiceManager::Systemd {
            scope: SystemdScope::User,
        },
        "127.0.0.1",
        8080,
        Path::new("/tmp"),
        false,
        None,
        Path::new("/usr/local/bin/termul-server"),
        &[],
    );
    let s = String::from_utf8(out).unwrap();
    assert!(s.contains("journalctl --user -u termul-server"), "got: {s}");
    assert!(
        s.contains("systemctl --user stop termul-server"),
        "got: {s}"
    );
}

#[test]
fn write_access_info_systemd_system_scope_omits_user_flag() {
    let mut out = Vec::new();
    write_access_info(
        &mut out,
        &ServiceManager::Systemd {
            scope: SystemdScope::System,
        },
        "127.0.0.1",
        8080,
        Path::new("/tmp"),
        false,
        None,
        Path::new("/usr/local/bin/termul-server"),
        &[],
    );
    let s = String::from_utf8(out).unwrap();
    assert!(s.contains("journalctl -u termul-server"), "got: {s}");
    assert!(!s.contains("journalctl --user"), "got: {s}");
}

#[test]
fn write_access_info_surfaces_update_channel_when_some() {
    // ECH#6: the chosen update channel must appear in stdout access info,
    // not just the boundary log.
    let mut out = Vec::new();
    write_access_info(
        &mut out,
        &ServiceManager::Setsid,
        "127.0.0.1",
        8080,
        Path::new("/tmp"),
        false,
        Some(UpdateChannel::Insider),
        Path::new("/usr/local/bin/termul-server"),
        &[],
    );
    let s = String::from_utf8(out).unwrap();
    assert!(s.contains("insider channel"), "got: {s}");
}

#[test]
fn run_non_tty_exits_zero_and_prints_defaults_without_spawning() {
    let mut out = Vec::new();
    let code = run_non_tty(&mut out);
    assert_eq!(code, ExitCode::SUCCESS);
    let s = String::from_utf8(out).unwrap();
    assert!(s.contains("stdin is not a TTY"), "got: {s}");
    assert!(s.contains("Default command:"), "got: {s}");
    assert!(
        s.contains("Mechanism:"),
        "non-TTY path must print the mechanism tip, got: {s}"
    );
}

#[test]
fn prompt_validated_retries_on_error_then_accepts_valid() {
    // Matrix row "Invalid answer then valid": a bad value is re-prompted
    // with the validator's message, then a valid value (or empty = default)
    // is accepted. Feed "abc" (invalid port) then "" (keep default 8080).
    let input = "abc\n\n".as_bytes();
    let mut stdin = std::io::BufReader::new(input);
    let mut stdout = Vec::new();
    let port: u16 = prompt_validated(&mut stdin, &mut stdout, "Bind port", "8080", |s| {
        let p: u16 = s
            .parse()
            .map_err(|_| format!("invalid port '{s}': expected 1-65535"))?;
        if p == 0 {
            return Err("invalid port '0': use 1-65535".into());
        }
        Ok(p)
    });
    assert_eq!(
        port, 8080,
        "empty line must keep the default after a bad input"
    );
    let out = String::from_utf8(stdout).unwrap();
    assert!(
        out.contains("invalid port 'abc'"),
        "retry must surface the validator error, got: {out}"
    );
}

#[test]
fn safe_systemd_env_line_rejects_control_chars_and_backslash() {
    use std::ffi::OsStr;
    assert_eq!(
        safe_systemd_env_line("HOME", OsStr::new("/root")),
        Some("HOME=/root".into())
    );
    assert!(safe_systemd_env_line("HOME", OsStr::new("/root\n")).is_none());
    assert!(safe_systemd_env_line("HOME", OsStr::new("/root\\")).is_none());
    assert!(safe_systemd_env_line("HOME", OsStr::new("")).is_none());
}

#[test]
fn prompt_yesno_retries_on_unrecognized_then_accepts_no() {
    // BH#10: a typo ("ye") re-prompts instead of silently counting as "no";
    // a subsequent "n" is then accepted.
    let input = "ye\nn\n".as_bytes();
    let mut stdin = std::io::BufReader::new(input);
    let mut stdout = Vec::new();
    let yes = prompt_yesno(&mut stdin, &mut stdout, "Allow?", false);
    assert!(!yes, "second answer 'n' must return false");
    let out = String::from_utf8(stdout).unwrap();
    assert!(
        out.contains("Please answer 'y' or 'n'"),
        "unrecognized input must re-prompt, got: {out}"
    );
}

#[test]
fn write_access_info_public_bind_points_at_token_file_not_logs() {
    // CAP-1 round 2: the access info must direct operators ONLY to the
    // owner-protected token file — never to service logs (the token is
    // never printed to stdout/logs anymore).
    let mut out = Vec::new();
    write_access_info(
        &mut out,
        &ServiceManager::Setsid,
        "0.0.0.0",
        8080,
        Path::new("/tmp/state"),
        false,
        None,
        Path::new("/usr/local/bin/termul-server"),
        &[],
    );
    let s = String::from_utf8(out).unwrap();
    assert!(s.contains("Web auth"), "got: {s}");
    assert!(
        s.contains("/tmp/state/web-auth-token"),
        "must name the owner-protected token file, got: {s}"
    );
    assert!(
        !s.contains("service log"),
        "must not direct operators to service logs for the token, got: {s}"
    );
}

#[test]
fn ensure_state_dir_creates_missing_dir() {
    let base = std::env::temp_dir().join(format!(
        "termul-onboard-state-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    let nested = base.join("a/b");
    let mut out = Vec::new();
    ensure_state_dir(&mut out, &nested).expect("creates a missing dir tree");
    assert!(nested.is_dir());
    assert!(out.is_empty(), "success must not print an error: {out:?}");
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn ensure_state_dir_fails_fast_when_path_is_a_file() {
    // A regular FILE at the state-dir path makes `create_dir_all` fail on
    // every platform, regardless of privileges (root bypasses permission
    // bits, so a chmod-based read-only dir is unreliable).
    let base = std::env::temp_dir().join(format!(
        "termul-onboard-state-file-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    std::fs::create_dir_all(&base).expect("create temp dir");
    let file_path = base.join("state-is-a-file");
    std::fs::write(&file_path, "not a directory").expect("write file");
    let mut out = Vec::new();
    let err = ensure_state_dir(&mut out, &file_path.join("child"))
        .expect_err("state dir under a regular file must fail");
    assert_eq!(
        err,
        ExitCode::FAILURE,
        "failure must abort the onboarding flow"
    );
    let s = String::from_utf8(out).unwrap();
    assert!(
        s.contains("cannot create state dir"),
        "error must name the cause, got: {s}"
    );
    let _ = std::fs::remove_dir_all(&base);
}
