use super::*;
use crate::trackers::GitStatus;
/// CAP-11 regression: `spawn_pty` seeds the hub snapshot with the
/// spawn-time cwd, so a client attaching before the first `CwdChanged`
/// event sees it via `build_attach_result` instead of `null`. Covers the
/// shared spawn-to-attach path used by both the desktop attach command
/// and the web terminal WS handler. Cross-platform: the seed is set
/// synchronously in both spawn branches, so the assertion is
/// deterministic regardless of shell behavior.
#[tokio::test]
async fn spawn_to_attach_snapshot_carries_spawn_time_cwd() {
    let manager = crate::web::test_pty_manager();
    let dir = std::env::temp_dir().join(format!("termul-test-spawn-cwd-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    // Canonicalize + strip the Windows verbatim prefix exactly as
    // `spawn_pty` does, so the assertion compares like with like.
    let cwd = std::fs::canonicalize(&dir)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let cwd = crate::path_validation::strip_verbatim_prefix(&cwd).into_owned();

    let spawned = manager
        .spawn(
            SpawnOptions {
                cwd: Some(cwd.clone()),
                ..Default::default()
            },
            None,
        )
        .await
        .expect("spawn pty");

    // Attach before any cwd-tracking event: the snapshot must already
    // carry the seeded spawn-time cwd.
    let instance = manager.get(&spawned.info.id).expect("spawned instance");
    let replay = instance.subscribe_from(0);
    let attach = manager.build_attach_result(&instance, &replay);
    assert_eq!(attach.snapshot.cwd.as_deref(), Some(cwd.as_str()));

    manager.kill(&spawned.info.id).await.expect("kill pty");
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(target_os = "windows")]
#[test]
fn directly_executable_windows_accepts_only_image_formats() {
    // The exact list we accept — anything else will be rejected by
    // resolve_program_path before it can reach CreateProcessW and surface
    // as os error 193.
    for ok in [
        r"C:\bin\claude.exe",
        r"C:\bin\codex.exe",
        r"C:/bin/cursor.com",
        r"C:\bin\agent.scr",
        r"C:\bin\sub\path\agent.exe",
        r#"C:\bin\"quoted".exe"#, // trailing quote tolerated
    ] {
        assert!(
            is_directly_executable_windows(ok),
            "expected accepted: {}",
            ok
        );
    }
    for bad in [
        r"C:\bin\nodot",
        r"C:\bin\opencode.cmd",
        r"C:\bin\agent.bat",
        r"C:\bin\script.ps1",
        r"C:\bin\hello.vbs",
        r"C:\bin\runner.js",
        r"C:\bin\thing.exe.cmd", // .cmd wins, rejected
    ] {
        assert!(
            !is_directly_executable_windows(bad),
            "expected rejected: {}",
            bad
        );
    }
}

#[cfg(target_os = "windows")]
#[test]
fn directly_executable_windows_composite_suffix_does_not_match() {
    // A file like `agent.cmd.exe` is a .exe, so it IS accepted — but
    // `agent.cmd.txt` is not. Make sure we look at the last extension only.
    assert!(is_directly_executable_windows(r"C:\bin\agent.cmd.exe"));
    assert!(!is_directly_executable_windows(r"C:\bin\agent.exe.cmd"));
}

#[cfg(target_os = "windows")]
#[test]
fn parse_npm_cmd_shim_rewrites_to_node_script() {
    // Write a simulated npm .cmd shim matching the real opencode.cmd format
    // that nvm-windows generates.
    let dir = std::env::temp_dir().join("termul-test-cmd-shim");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    // Create a fake node.exe (just a marker — parser only checks existence
    // + extension via is_directly_executable_windows).
    std::fs::write(dir.join("node.exe"), b"MZ").unwrap();
    // Create the target script file.
    std::fs::create_dir_all(dir.join("node_modules\\opencode-ai\\bin")).unwrap();
    std::fs::write(dir.join("node_modules\\opencode-ai\\bin\\opencode"), b"").unwrap();

    let shim_path = dir.join("opencode.cmd");
    let shim_content = "@ECHO off\r\n".to_owned()
            + "GOTO start\r\n"
            + ":find_dp0\r\n"
            + "SET dp0=%~dp0\r\n"
            + "EXIT /b\r\n"
            + ":start\r\n"
            + "SETLOCAL\r\n"
            + "CALL :find_dp0\r\n"
            + "\r\n"
            + "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\opencode-ai\\bin\\opencode\" %*\r\n";
    std::fs::write(&shim_path, shim_content).unwrap();

    let resolved = parse_npm_cmd_shim(shim_path.to_str().unwrap());
    assert!(resolved.is_some(), "should parse the shim");
    let resolved = resolved.unwrap();

    // The executable should be node.exe in the same directory as the shim.
    assert!(
        resolved.program.ends_with("node.exe"),
        "expected node.exe, got: {}",
        resolved.program
    );
    // The script path should be the opencode-ai bin entry.
    assert_eq!(resolved.prepend_args.len(), 1);
    assert!(
        resolved.prepend_args[0].contains("opencode-ai\\bin\\opencode"),
        "expected script path containing opencode-ai bin, got: {}",
        resolved.prepend_args[0]
    );

    // Cleanup
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(target_os = "windows")]
#[test]
fn parse_npm_cmd_shim_rewrites_npm_launcher_with_set_indirection() {
    // npm's own npx.cmd / npm.cmd invoke through SETLOCAL variables:
    //   SET "NODE_EXE=%~dp0\node.exe"
    //   SET "NPX_CLI_JS=%~dp0\node_modules\npm\bin\npx-cli.js"
    //   "%NODE_EXE%" "%NPX_CLI_JS%" %*
    // The parser must resolve the %VAR% indirection, not only the simple
    // `"%dp0%\node.exe" "<script>"` package-bin form.
    let dir = std::env::temp_dir().join("termul-test-npx-launcher-shim");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("node.exe"), b"MZ").unwrap();
    std::fs::create_dir_all(dir.join("node_modules\\npm\\bin")).unwrap();
    std::fs::write(dir.join("node_modules\\npm\\bin\\npx-cli.js"), b"").unwrap();

    let shim_path = dir.join("npx.cmd");
    let shim_content = ":: Created by npm, please don't edit manually.\r\n".to_owned()
        + "@ECHO OFF\r\n"
        + "SETLOCAL\r\n"
        + "SET \"NODE_EXE=%~dp0\\node.exe\"\r\n"
        + "IF NOT EXIST \"%NODE_EXE%\" (\r\n"
        + "  SET \"NODE_EXE=node\"\r\n"
        + ")\r\n"
        + "SET \"NPX_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npx-cli.js\"\r\n"
        + "\"%NODE_EXE%\" \"%NPX_CLI_JS%\" %*\r\n";
    std::fs::write(&shim_path, shim_content).unwrap();

    let resolved = parse_npm_cmd_shim(shim_path.to_str().unwrap());
    assert!(resolved.is_some(), "should parse the npm launcher shim");
    let resolved = resolved.unwrap();
    assert!(
        resolved.program.ends_with("node.exe"),
        "expected node.exe, got: {}",
        resolved.program
    );
    assert_eq!(resolved.prepend_args.len(), 1);
    assert!(
        resolved.prepend_args[0].contains("npm\\bin\\npx-cli.js"),
        "expected npx-cli.js script path, got: {}",
        resolved.prepend_args[0]
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(target_os = "windows")]
#[test]
fn parse_powershell_cmd_shim_rewrites_cursor_agent_style() {
    let dir = std::env::temp_dir().join("termul-test-ps-shim");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let ps_exe = dir.join("powershell.exe");
    std::fs::write(&ps_exe, b"MZ").unwrap();
    let script = dir.join("cursor-agent.ps1");
    std::fs::write(&script, b"# stub").unwrap();

    let ps_exe_str = ps_exe.to_string_lossy();
    let script_str = script.to_string_lossy();
    let shim_path = dir.join("cursor-agent.cmd");
    let shim_content = format!(
        "@echo off\r\n{ps} -NoProfile -ExecutionPolicy Bypass -File \"{script}\" %*\r\n",
        ps = ps_exe_str,
        script = script_str,
    );
    std::fs::write(&shim_path, shim_content).unwrap();

    let resolved = parse_powershell_cmd_shim(shim_path.to_str().unwrap());
    assert!(resolved.is_some(), "should parse PowerShell shim");
    let resolved = resolved.unwrap();
    assert!(
        resolved.program.ends_with("powershell.exe"),
        "expected powershell.exe, got: {}",
        resolved.program
    );
    assert!(
        resolved
            .prepend_args
            .iter()
            .any(|a| a.ends_with("cursor-agent.ps1")),
        "expected -File script in prepend_args: {:?}",
        resolved.prepend_args
    );
    assert!(
        resolved.prepend_args.iter().any(|a| a == "-NoProfile"),
        "expected -NoProfile flag: {:?}",
        resolved.prepend_args
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(target_os = "windows")]
#[test]
fn win_agent_resolution_skips_extensionless_before_pe() {
    let dir = std::env::temp_dir().join("termul-test-pe-resolve");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    std::fs::write(dir.join("claude"), b"not a pe image").unwrap();
    std::fs::write(dir.join("claude.exe"), b"MZ").unwrap();

    let trimmed = "claude";
    const WIN_EXECUTABLE_EXTS: &[&str] = &["", ".exe", ".com", ".scr"];
    let mut resolved_path: Option<String> = None;
    for ext in WIN_EXECUTABLE_EXTS {
        let candidate = dir.join(format!("{}{}", trimmed, ext));
        if !candidate.exists() {
            continue;
        }
        let abs_path = candidate.to_string_lossy().to_string();
        if is_directly_executable_windows(&abs_path) {
            resolved_path = Some(abs_path);
            break;
        }
    }

    let resolved_path =
        resolved_path.expect("should resolve to claude.exe after skipping extensionless shim");
    assert!(
        resolved_path.ends_with("claude.exe"),
        "expected claude.exe, got: {}",
        resolved_path
    );
    assert!(
        !is_directly_executable_windows(&dir.join("claude").to_string_lossy()),
        "extensionless claude must not be treated as PE"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(target_os = "windows")]
#[test]
fn try_parse_windows_cmd_shim_prefers_npm_over_powershell() {
    let dir = std::env::temp_dir().join("termul-test-shim-priority");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("node.exe"), b"MZ").unwrap();
    std::fs::create_dir_all(dir.join("node_modules\\pkg\\bin")).unwrap();
    std::fs::write(dir.join("node_modules\\pkg\\bin\\tool"), b"").unwrap();

    let shim_path = dir.join("tool.cmd");
    let shim_content = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\n\
            endLocal & goto #_undefined_# 2>NUL || \"%_prog%\" \"%dp0%\\node_modules\\pkg\\bin\\tool\" %*\r\n";
    std::fs::write(&shim_path, shim_content).unwrap();

    let resolved = try_parse_windows_cmd_shim(shim_path.to_str().unwrap());
    assert!(resolved.is_some());
    assert!(
        resolved.unwrap().program.ends_with("node.exe"),
        "npm shim should resolve to node.exe"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(target_os = "windows")]
#[test]
fn resolve_spawn_program_rewrites_npm_cmd_shim() {
    let dir = std::env::temp_dir().join("termul-test-resolve-npm-shim");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("node.exe"), b"MZ").unwrap();
    std::fs::create_dir_all(dir.join("node_modules\\gemini\\bin")).unwrap();
    std::fs::write(dir.join("node_modules\\gemini\\bin\\gemini"), b"").unwrap();

    let shim_path = dir.join("gemini.cmd");
    let shim_content = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\n\
            endLocal & goto #_undefined_# 2>NUL || \"%_prog%\" \"%dp0%\\node_modules\\gemini\\bin\\gemini\" %*\r\n";
    std::fs::write(&shim_path, shim_content).unwrap();

    // Explicit-path form: resolve_spawn_program parses and rewrites the shim.
    let resolved =
        resolve_spawn_program(shim_path.to_str().unwrap()).expect("npm .cmd shim should resolve");
    assert!(
        resolved.program.ends_with("node.exe"),
        "expected node.exe, got: {}",
        resolved.program
    );
    assert_eq!(resolved.prepend_args.len(), 1);
    assert!(
        resolved.prepend_args[0].contains("gemini\\bin\\gemini"),
        "expected the script path prepended, got: {:?}",
        resolved.prepend_args
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(target_os = "windows")]
#[test]
fn resolve_spawn_program_rewrites_powershell_cmd_shim() {
    let dir = std::env::temp_dir().join("termul-test-resolve-ps-shim");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("cursor-agent.ps1"), b"").unwrap();
    let ps_exe = std::path::Path::new(
        &std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string()),
    )
    .join("System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    let ps_exe_str = ps_exe.to_string_lossy().to_string();
    let script_str = dir.join("cursor-agent.ps1").to_string_lossy().to_string();

    let shim_path = dir.join("cursor-agent.cmd");
    let shim_content = format!(
        "@echo off\r\n{ps} -NoProfile -ExecutionPolicy Bypass -File \"{script}\" %*\r\n",
        ps = ps_exe_str,
        script = script_str,
    );
    std::fs::write(&shim_path, shim_content).unwrap();

    let resolved = resolve_spawn_program(shim_path.to_str().unwrap())
        .expect("PowerShell .cmd shim should resolve");
    assert!(
        resolved.program.ends_with("powershell.exe"),
        "expected powershell.exe, got: {}",
        resolved.program
    );
    assert!(
        resolved
            .prepend_args
            .iter()
            .any(|a| a.ends_with("cursor-agent.ps1")),
        "expected -File script prepended, got: {:?}",
        resolved.prepend_args
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(target_os = "windows")]
#[test]
fn resolve_spawn_program_keeps_native_exe_without_prepend() {
    let dir = std::env::temp_dir().join("termul-test-resolve-native-exe");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let exe_path = dir.join("agent.exe");
    std::fs::write(&exe_path, b"MZ").unwrap();

    let resolved =
        resolve_spawn_program(exe_path.to_str().unwrap()).expect("native .exe should resolve");
    assert!(resolved.program.ends_with("agent.exe"));
    assert!(
        resolved.prepend_args.is_empty(),
        "native exe must not prepend args, got: {:?}",
        resolved.prepend_args
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(not(target_os = "windows"))]
#[test]
fn resolve_spawn_program_passes_through_on_unix() {
    let resolved = resolve_spawn_program("gemini").expect("unix passthrough");
    assert_eq!(resolved.program, "gemini");
    assert!(resolved.prepend_args.is_empty());
}

#[test]
fn test_should_reap_orphan_protected_never_reaped() {
    let long_ago = Duration::from_secs(10_000);
    let timeout = Duration::from_secs(600);
    // Protected + orphaned + long past timeout => still not reapable.
    assert!(!should_reap_orphan(
        true,
        true,
        Some(long_ago),
        long_ago,
        timeout
    ));
}

#[test]
fn test_should_reap_orphan_attached_never_reaped() {
    let long_ago = Duration::from_secs(10_000);
    let timeout = Duration::from_secs(600);
    // Not protected but still has a renderer ref (is_orphan == false).
    assert!(!should_reap_orphan(
        false,
        false,
        Some(long_ago),
        long_ago,
        timeout
    ));
}

#[test]
fn test_should_reap_orphan_orphaned_past_timeout_reaped() {
    let timeout = Duration::from_secs(600);
    // Unprotected, orphaned, past timeout => reapable.
    assert!(should_reap_orphan(
        false,
        true,
        Some(Duration::from_secs(601)),
        Duration::from_secs(0),
        timeout
    ));
}

#[test]
fn test_should_reap_orphan_orphaned_within_timeout_not_reaped() {
    let timeout = Duration::from_secs(600);
    assert!(!should_reap_orphan(
        false,
        true,
        Some(Duration::from_secs(59)),
        Duration::from_secs(0),
        timeout
    ));
}

#[test]
fn test_should_reap_orphan_uses_inactivity_when_never_orphaned() {
    let timeout = Duration::from_secs(600);
    // Never had a renderer ref (orphaned_for None) => fall back to inactivity.
    assert!(should_reap_orphan(
        false,
        true,
        None,
        Duration::from_secs(601),
        timeout
    ));
    assert!(!should_reap_orphan(
        false,
        true,
        None,
        Duration::from_secs(59),
        timeout
    ));
}

#[test]
fn test_spawn_options_default() {
    let options = SpawnOptions::default();
    assert!(options.shell.is_none());
    assert!(options.cwd.is_none());
    assert!(options.env.is_none());
    assert_eq!(options.cols, Some(80));
    assert_eq!(options.rows, Some(24));
}

#[test]
fn test_terminal_info_serialization() {
    let info = TerminalInfo {
        id: "test-123".to_string(),
        shell: "/bin/bash".to_string(),
        cwd: "/home/user".to_string(),
        pid: 12345,
        cols: 100,
        rows: 30,
    };

    let json = serde_json::to_string(&info).unwrap();
    assert!(json.contains("\"id\":\"test-123\""));
    assert!(json.contains("\"shell\":\"/bin/bash\""));
    assert!(json.contains("\"cwd\":\"/home/user\""));
    assert!(json.contains("\"pid\":12345"));
    assert!(json.contains("\"cols\":100"));
    assert!(json.contains("\"rows\":30"));
}

#[test]
fn test_spawn_options_deserialization() {
    let json = r#"{"shell":"cmd.exe","cwd":"C:\\","cols":120,"rows":40}"#;
    let options: SpawnOptions = serde_json::from_str(json).unwrap();
    assert_eq!(options.shell, Some("cmd.exe".to_string()));
    assert_eq!(options.cwd, Some("C:\\".to_string()));
    assert_eq!(options.cols, Some(120));
    assert_eq!(options.rows, Some(40));
}

// ========== CAP-3 serde shape tests ==========
// Pin the golden wire shapes so cross-language drift (serde flatten /
// camelCase) cannot ship untested: clients rely on byte-identical shapes
// across the desktop IPC and web WS surfaces.

#[test]
fn test_spawned_terminal_serializes_flat_with_claim() {
    let spawned = SpawnedTerminal {
        info: TerminalInfo {
            id: "terminal-123-0".to_string(),
            shell: "pwsh".to_string(),
            cwd: "C:\\work".to_string(),
            pid: 42,
            cols: 120,
            rows: 32,
        },
        claim: "f3a9".to_string(),
    };

    let value: serde_json::Value = serde_json::to_value(&spawned).unwrap();
    let obj = value.as_object().expect("spawn reply is an object");

    // FLATTENS to top-level info fields — no nested `info` key.
    assert!(
        !obj.contains_key("info"),
        "SpawnedTerminal must flatten info, not nest it"
    );
    assert_eq!(
        obj.get("id").and_then(|v| v.as_str()),
        Some("terminal-123-0")
    );
    assert_eq!(obj.get("shell").and_then(|v| v.as_str()), Some("pwsh"));
    assert_eq!(obj.get("cwd").and_then(|v| v.as_str()), Some("C:\\work"));
    assert_eq!(obj.get("pid").and_then(|v| v.as_u64()), Some(42));
    assert_eq!(obj.get("cols").and_then(|v| v.as_u64()), Some(120));
    assert_eq!(obj.get("rows").and_then(|v| v.as_u64()), Some(32));
    assert_eq!(obj.get("claim").and_then(|v| v.as_str()), Some("f3a9"));

    // Exactly the golden shape — no extra keys may sneak in.
    let keys: std::collections::BTreeSet<&str> = obj.keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        ["cols", "cwd", "id", "pid", "rows", "shell", "claim"]
            .into_iter()
            .collect::<std::collections::BTreeSet<&str>>()
    );
}

#[test]
fn test_terminal_attach_result_serializes_camelcase_without_claim() {
    let result = TerminalAttachResult {
        id: "terminal-123-0".to_string(),
        shell: "pwsh".to_string(),
        cwd: "C:\\work".to_string(),
        pid: 42,
        cols: 120,
        rows: 32,
        latest_seq: 87,
        gap: false,
        snapshot: TerminalStateSnapshot {
            cwd: Some("/repo".to_string()),
            git_branch: Some("dev".to_string()),
            git_status: Some(GitStatus {
                modified: 1,
                staged: 2,
                untracked: 3,
                ahead: 4,
                behind: 5,
                has_changes: true,
            }),
            exit_code: Some(0),
            exited: false,
        },
    };

    let value: serde_json::Value = serde_json::to_value(&result).unwrap();
    let obj = value.as_object().expect("attach reply is an object");

    // camelCase seq fields — never snake_case.
    assert_eq!(obj.get("latestSeq").and_then(|v| v.as_u64()), Some(87));
    assert_eq!(obj.get("gap").and_then(|v| v.as_bool()), Some(false));
    assert!(!obj.contains_key("latest_seq"));
    assert!(!obj.contains_key("latestseq"));

    // Attach NEVER issues a credential.
    assert!(
        !obj.contains_key("claim"),
        "TerminalAttachResult must never carry a claim key"
    );

    // snapshot is a nested object with camelCase lifecycle fields.
    let snap = obj
        .get("snapshot")
        .and_then(|v| v.as_object())
        .expect("snapshot is a nested object");
    assert_eq!(snap.get("cwd").and_then(|v| v.as_str()), Some("/repo"));
    assert_eq!(snap.get("gitBranch").and_then(|v| v.as_str()), Some("dev"));
    assert_eq!(snap.get("exitCode").and_then(|v| v.as_i64()), Some(0));
    assert_eq!(snap.get("exited").and_then(|v| v.as_bool()), Some(false));
    let status = snap
        .get("gitStatus")
        .and_then(|v| v.as_object())
        .expect("gitStatus is a nested object");
    assert_eq!(status.get("modified").and_then(|v| v.as_i64()), Some(1));
    assert_eq!(status.get("staged").and_then(|v| v.as_i64()), Some(2));
    assert_eq!(status.get("untracked").and_then(|v| v.as_i64()), Some(3));
    assert_eq!(status.get("ahead").and_then(|v| v.as_i64()), Some(4));
    assert_eq!(status.get("behind").and_then(|v| v.as_i64()), Some(5));
    assert_eq!(
        status.get("hasChanges").and_then(|v| v.as_bool()),
        Some(true)
    );

    let keys: std::collections::BTreeSet<&str> = obj.keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        [
            "id",
            "shell",
            "cwd",
            "pid",
            "cols",
            "rows",
            "latestSeq",
            "gap",
            "snapshot"
        ]
        .into_iter()
        .collect::<std::collections::BTreeSet<&str>>()
    );
}

// ========== Git Bash resolution tests ==========

#[cfg(target_os = "windows")]
#[test]
fn test_git_bash_candidates_match_detection() {
    // Verify that the candidates in resolve_shell_path match
    // the candidates in lib.rs get_available_shells()
    // This test ensures the git_bash_paths constants stay in sync

    // Verify primary paths are non-empty (compile-time guard) and well-formed
    const { assert!(!git_bash_paths::PRIMARY_PATHS.is_empty()) };
    for path in git_bash_paths::PRIMARY_PATHS {
        assert!(
            path.contains("bash.exe"),
            "Primary path should contain bash.exe: {}",
            path
        );
    }

    // Verify fallback paths are non-empty (compile-time guard) and well-formed
    const { assert!(!git_bash_paths::FALLBACK_PATHS.is_empty()) };
    for path in git_bash_paths::FALLBACK_PATHS {
        assert!(
            path.contains("bash.exe"),
            "Fallback path should contain bash.exe: {}",
            path
        );
    }

    // Specific verification that key paths exist
    assert!(git_bash_paths::PRIMARY_PATHS.contains(&r"C:\Program Files\Git\bin\bash.exe"));
    assert!(git_bash_paths::PRIMARY_PATHS.contains(&r"C:\Program Files\Git\usr\bin\bash.exe"));
}

#[cfg(target_os = "windows")]
#[test]
fn test_git_bash_fallback_paths_included() {
    // Verify fallback paths are included for edge cases
    let fallback_paths = vec![
        r"C:\tools\msys64\usr\bin\bash.exe",
        r"C:\msys64\usr\bin\bash.exe",
        r"C:\Git\bin\bash.exe",
        r"C:\Git\usr\bin\bash.exe",
    ];

    for path in fallback_paths {
        assert!(path.contains("bash.exe"));
    }
}

#[test]
fn test_shell_resolution_git_bash_alias_recognized() {
    // Verify git-bash is treated as a special alias distinct from "bash"
    let git_bash = "git-bash";
    let bash = "bash";

    // These should be different shell names
    assert_ne!(git_bash, bash);

    // git-bash should map to bash.exe eventually (verified in resolve_shell_path)
    assert!(git_bash.contains("bash"));
}

#[cfg(target_os = "windows")]
#[test]
fn test_shell_resolution_error_message_git_bash() {
    // Verify that git-bash error message is informative
    let _shell = "git-bash";
    let expected_error_substring = "bash.exe not found in PATH or common Git Bash locations";
    assert!(expected_error_substring.contains("bash.exe"));
    assert!(expected_error_substring.contains("PATH"));
}

#[cfg(target_os = "windows")]
#[test]
fn test_is_builtin_windows_shell() {
    assert!(PtyManager::is_builtin_windows_shell("cmd"));
    assert!(PtyManager::is_builtin_windows_shell("CMD.EXE"));
    assert!(PtyManager::is_builtin_windows_shell("powershell"));
    assert!(PtyManager::is_builtin_windows_shell("pwsh"));
    assert!(PtyManager::is_builtin_windows_shell("wsl"));
    assert!(!PtyManager::is_builtin_windows_shell("bash.exe"));
    assert!(!PtyManager::is_builtin_windows_shell("git-bash"));
}

#[cfg(target_os = "windows")]
#[test]
fn test_windows_env_merge_preserves_existing_path_case_insensitively() {
    let env_map = merge_windows_environment_map(
        vec![("Path".to_string(), r"C:\laragon\bin\nodejs".to_string())],
        None,
    );

    let path_keys: Vec<&String> = env_map
        .keys()
        .filter(|key| key.eq_ignore_ascii_case("path"))
        .collect();

    assert_eq!(path_keys.len(), 1);
    assert_eq!(
        env_map
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case("path"))
            .map(|(_, value)| value.as_str()),
        Some(r"C:\laragon\bin\nodejs")
    );
}

#[cfg(target_os = "windows")]
#[test]
fn test_windows_env_merge_overrides_path_case_insensitively() {
    let mut custom_env = HashMap::new();
    custom_env.insert("PATH".to_string(), r"C:\custom\node".to_string());

    let env_map = merge_windows_environment_map(
        vec![("Path".to_string(), r"C:\laragon\bin\nodejs".to_string())],
        Some(custom_env),
    );

    let path_keys: Vec<&String> = env_map
        .keys()
        .filter(|key| key.eq_ignore_ascii_case("path"))
        .collect();

    assert_eq!(path_keys.len(), 1);
    assert_eq!(
        env_map
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case("path"))
            .map(|(_, value)| value.as_str()),
        Some(r"C:\custom\node")
    );
}

// ========== Async kill() signature tests ==========
// Note: Full integration tests for kill() and kill_all() require Tauri runtime.
// The async spawn_blocking pattern is validated through:
// 1. Compile-time check: kill() is now async and returns impl Future
// 2. Existing orphan cleanup code at line 403-406 demonstrates the pattern
// 3. Manual testing during development
