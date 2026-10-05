use super::*;

#[test]
fn merge_dedupes_case_insensitively_on_windows_style() {
    let merged = merge_path_segments(r"C:\Tools;C:\App", r"C:\tools;C:\Extra", ';');
    assert_eq!(merged, r"C:\Tools;C:\App;C:\Extra");
}

#[test]
fn merge_unix_colon_delimiter() {
    let merged = merge_path_segments("/usr/bin", "/bin:/usr/bin", ':');
    assert_eq!(merged, "/usr/bin:/bin");
}

#[test]
fn merge_skips_empty_segments() {
    let merged = merge_path_segments(";;/a", "/b;;", ';');
    assert_eq!(merged, "/a;/b");
}

#[test]
fn shell_login_arg_for_bash() {
    assert_eq!(shell_wants_login_arg("/usr/bin/bash"), Some("-l"));
}

#[cfg(not(target_os = "windows"))]
#[test]
fn trusted_shell_path_rejects_relative() {
    assert!(!is_trusted_shell_path("bash"));
    assert!(!is_trusted_shell_path("./bin/bash"));
}

#[cfg(not(target_os = "windows"))]
#[test]
fn trusted_shell_path_accepts_known_absolute_shells() {
    for candidate in ["/bin/bash", "/bin/sh", "/bin/dash"] {
        if Path::new(candidate).exists() {
            assert!(
                is_trusted_shell_path(candidate),
                "expected trusted: {candidate}"
            );
        }
    }
}

#[cfg(not(target_os = "windows"))]
#[test]
fn missing_shell_environment_uses_system_login_shell() {
    let expected = ["/bin/zsh", "/bin/bash", "/bin/sh"]
        .into_iter()
        .find(|shell| is_trusted_shell_path(shell))
        .expect("Unix should provide a trusted shell");
    assert_eq!(
        select_login_shell(None, Some(expected.to_string())),
        expected
    );
}

#[test]
fn path_probe_ignores_interactive_shell_startup_output() {
    assert_eq!(
        parse_login_path_output(
            b"zsh startup notice\n__TERMUL_LOGIN_PATH__=/custom/bin:/usr/bin\n"
        ),
        Some("/custom/bin:/usr/bin".to_string())
    );
}

#[cfg(target_os = "macos")]
#[test]
fn macos_account_database_resolves_the_login_shell() {
    let shell = login_shell_from_macos_account()
        .expect("macOS account database should provide the current user's login shell");
    assert!(
        is_trusted_shell_path(&shell),
        "account database returned an unsupported shell: {shell}"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn interactive_zsh_probe_includes_zshrc_path() {
    let zsh = Path::new("/bin/zsh");
    if !zsh.exists() {
        return;
    }

    let config_dir = tempfile::tempdir().expect("create temporary zsh config");
    std::fs::write(
        config_dir.path().join(".zshrc"),
        "export PATH=\"/termul-regression-bin:$PATH\"\n",
    )
    .expect("write temporary zshrc");
    let zdotdir = config_dir
        .path()
        .to_str()
        .expect("temporary config path is UTF-8");

    let output = run_shell_path_probe_with_env(
        zsh.to_str().expect("zsh path is UTF-8"),
        "-ilc",
        "printf '\\n__TERMUL_LOGIN_PATH__=%s\\n' \"$PATH\"",
        &[
            ("PATH", "/usr/bin:/bin:/usr/sbin:/sbin"),
            ("ZDOTDIR", zdotdir),
        ],
    )
    .expect("run interactive login zsh PATH probe");
    assert!(
        output.status.success(),
        "zsh PATH probe failed with {:?}",
        output.status.code()
    );
    let path = parse_login_path_output(&output.stdout).expect("PATH marker in zsh output");
    assert!(
        std::env::split_paths(&path).any(|entry| entry == Path::new("/termul-regression-bin")),
        "interactive .zshrc PATH entry was not detected"
    );
}

#[test]
fn shell_login_arg_for_cmd_none() {
    assert_eq!(shell_wants_login_arg("cmd.exe"), None);
}
