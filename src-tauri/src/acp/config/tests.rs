use super::*;

#[test]
fn probe_registry_runtime_reports_launcher_flags() {
    let probe = probe_registry_runtime();
    assert_eq!(probe.npx, is_registry_launcher_on_path("npx"));
    assert_eq!(probe.uvx, is_registry_launcher_on_path("uvx"));
}

#[test]
fn agent_id_is_unique() {
    let a = AgentId::new();
    let b = AgentId::new();
    assert_ne!(a, b);
}

#[test]
fn session_id_roundtrips_through_protocol_type() {
    let original = SessionId::new("sess-123");
    let proto: agent_client_protocol::schema::v1::SessionId = (&original).into();
    let back: SessionId = proto.into();
    assert_eq!(original, back);
}

/// OQ1: the shared `require_config_id` guard — rejects `None`, empty, and
/// whitespace-only configId so the spawn path never falls back to the
/// name+command hash for namespace derivation.
#[test]
fn require_config_id_rejects_missing() {
    let config = AgentConfig {
        config_id: None,
        name: "H".to_string(),
        command: "node".to_string(),
        args: vec![],
        env: HashMap::new(),
        allow_terminal: false,
    };
    let err = require_config_id(&config).expect_err("None configId must be rejected");
    assert!(
        err.contains("configId"),
        "err should mention configId: {err}"
    );
}

#[test]
fn require_config_id_rejects_empty() {
    for bad in ["", "   ", "\t"] {
        let config = AgentConfig {
            config_id: Some(bad.to_string()),
            name: "H".to_string(),
            command: "node".to_string(),
            args: vec![],
            env: HashMap::new(),
            allow_terminal: false,
        };
        require_config_id(&config).expect_err("empty/whitespace configId must be rejected");
    }
}

#[test]
fn require_config_id_accepts_present() {
    let config = AgentConfig {
        config_id: Some("custom-abc".to_string()),
        name: "H".to_string(),
        command: "node".to_string(),
        args: vec![],
        env: HashMap::new(),
        allow_terminal: false,
    };
    require_config_id(&config).expect("a non-empty configId must pass the guard");
}

/// OQ3: `deny_unknown_fields` on `AgentConfig` rejects extra fields at the
/// serde boundary (the TS import guard is the first line; this is the
/// spawn-path backstop). An `id`/`templateId`-carrying paste must be
/// rejected here so it cannot sneak StoredAgentConfig-only fields through.
#[test]
fn agent_config_rejects_unknown_fields_at_serde_boundary() {
    let json = r#"{
            "configId": "custom-abc1",
            "name": "Internal Helper",
            "command": "node",
            "args": ["/path/to/agent.js"],
            "env": { "API_KEY": "$INTERNAL_API_KEY" },
            "allowTerminal": false,
            "id": "custom-abc1"
        }"#;
    let parsed: Result<AgentConfig, _> = serde_json::from_str(json);
    let err = parsed.expect_err("unknown field `id` must be rejected");
    assert!(
        err.to_string().contains("unknown field"),
        "expected unknown-field rejection, got: {err}"
    );
}

/// OQ3 companion: a minimal conforming `AgentConfig` (only the 6 allowed
/// fields) deserializes cleanly through `deny_unknown_fields`.
#[test]
fn agent_config_accepts_conforming_payload() {
    let json = r#"{
            "configId": "custom-abc1",
            "name": "Internal Helper",
            "command": "node",
            "args": ["/path/to/agent.js"],
            "env": { "API_KEY": "$INTERNAL_API_KEY" },
            "allowTerminal": false
        }"#;
    let parsed: AgentConfig = serde_json::from_str(json).expect("conforming payload deserializes");
    assert_eq!(parsed.config_id.as_deref(), Some("custom-abc1"));
    assert_eq!(parsed.name, "Internal Helper");
    assert_eq!(parsed.command, "node");
    assert_eq!(parsed.args, vec!["/path/to/agent.js".to_string()]);
    assert_eq!(
        parsed.env.get("API_KEY").map(String::as_str),
        Some("$INTERNAL_API_KEY")
    );
    assert!(!parsed.allow_terminal);
}

#[cfg(not(target_os = "windows"))]
#[test]
fn resolve_executable_in_path_finds_executable_in_later_segment() {
    use std::os::unix::fs::PermissionsExt;

    let base = std::env::temp_dir().join(format!("termul-acp-path-{}", uuid::Uuid::new_v4()));
    let empty_dir = base.join("empty");
    let bin_dir = base.join("bin");
    std::fs::create_dir_all(&empty_dir).unwrap();
    std::fs::create_dir_all(&bin_dir).unwrap();
    let exe = bin_dir.join("npx");
    std::fs::write(&exe, b"#!/bin/sh\n").unwrap();
    std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();

    let path = format!("{}:{}", empty_dir.display(), bin_dir.display());
    assert_eq!(
        resolve_executable_in_path("npx", &path),
        Some(exe.to_string_lossy().into_owned())
    );

    // A non-executable file of the same name is skipped, yielding None.
    let plain = empty_dir.join("npx");
    std::fs::write(&plain, b"not exec").unwrap();
    assert_eq!(
        resolve_executable_in_path("npx", &empty_dir.display().to_string()),
        None
    );

    // An explicit path is returned unchanged.
    assert_eq!(
        resolve_executable_in_path("/usr/bin/npx", &path),
        Some("/usr/bin/npx".to_string())
    );

    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn agent_config_builds_stdio_server() {
    let mut env = HashMap::new();
    env.insert("API_KEY".to_string(), "secret".to_string());
    let config = AgentConfig {
        config_id: None,
        name: "test-agent".to_string(),
        command: "/usr/bin/agent".to_string(),
        args: vec!["--acp".to_string()],
        env,
        allow_terminal: false,
    };

    match config.to_mcp_server(None) {
        agent_client_protocol::schema::v1::McpServer::Stdio(stdio) => {
            assert_eq!(stdio.name, "test-agent");
            assert_eq!(stdio.command, std::path::PathBuf::from("/usr/bin/agent"));
            assert_eq!(stdio.args, vec!["--acp".to_string()]);
            // The configured env is preserved. A login-shell PATH may also be
            // merged in (env-dependent), so look the var up by name rather
            // than asserting an exact count/order.
            let api_key = stdio
                .env
                .iter()
                .find(|var| var.name == "API_KEY")
                .expect("API_KEY env var preserved");
            assert_eq!(api_key.value, "secret");
        }
        _ => panic!("expected stdio server"),
    }
}

#[cfg(target_os = "windows")]
#[test]
fn agent_config_rewrites_windows_cmd_shim_and_orders_args() {
    // Simulate an npm-installed agent that exists only as a `.cmd` shim.
    let dir = std::env::temp_dir().join("termul-test-acp-cmd-shim");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("node.exe"), b"MZ").unwrap();
    std::fs::create_dir_all(dir.join("node_modules\\gemini\\bin")).unwrap();
    std::fs::write(dir.join("node_modules\\gemini\\bin\\gemini"), b"").unwrap();

    let shim_path = dir.join("gemini.cmd");
    let shim_content = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\n\
            endLocal & goto #_undefined_# 2>NUL || \"%_prog%\" \"%dp0%\\node_modules\\gemini\\bin\\gemini\" %*\r\n";
    std::fs::write(&shim_path, shim_content).unwrap();

    let config = AgentConfig {
        config_id: None,
        name: "gemini".to_string(),
        command: shim_path.to_string_lossy().to_string(),
        args: vec!["--experimental-acp".to_string()],
        env: HashMap::new(),
        allow_terminal: false,
    };

    match config.to_mcp_server(None) {
        agent_client_protocol::schema::v1::McpServer::Stdio(stdio) => {
            // Command rewritten to the directly-executable interpreter.
            assert!(
                stdio.command.to_string_lossy().ends_with("node.exe"),
                "expected node.exe, got: {}",
                stdio.command.display()
            );
            // Script path is prepended ahead of the user's configured args.
            assert_eq!(stdio.args.len(), 2);
            assert!(
                stdio.args[0].contains("gemini\\bin\\gemini"),
                "expected script path first, got: {:?}",
                stdio.args
            );
            assert_eq!(stdio.args[1], "--experimental-acp");
        }
        _ => panic!("expected stdio server"),
    }

    let _ = std::fs::remove_dir_all(&dir);
}

/// POSIX shim injection (spec-acp-terminal-auth): `to_mcp_server(Some(dir))`
/// prepends the shim dir to PATH and points BROWSER at its `xdg-open`, so
/// the agent's browser-open is captured by the shim's `urls` sink.
#[cfg(unix)]
#[test]
fn to_mcp_server_injects_shim_env() {
    let shim_dir = std::path::PathBuf::from("/tmp/termul-acp-shim/agent-x");
    let config = AgentConfig {
        config_id: None,
        name: "test-agent".to_string(),
        command: "/usr/bin/agent".to_string(),
        args: vec![],
        env: HashMap::new(),
        allow_terminal: false,
    };

    match config.to_mcp_server(Some(&shim_dir)) {
        agent_client_protocol::schema::v1::McpServer::Stdio(stdio) => {
            let path = stdio
                .env
                .iter()
                .find(|v| v.name == "PATH")
                .expect("PATH env var present");
            assert!(
                path.value.starts_with("/tmp/termul-acp-shim/agent-x:"),
                "shim dir must be FIRST on PATH, got: {}",
                path.value
            );
            let browser = stdio
                .env
                .iter()
                .find(|v| v.name == "BROWSER")
                .expect("BROWSER env var present");
            assert_eq!(browser.value, "/tmp/termul-acp-shim/agent-x/xdg-open");
        }
        _ => panic!("expected stdio server"),
    }
}

/// Without a shim dir the env carries no BROWSER override (the unshimmed
/// path — tests, non-agent spawns — must not shadow a real browser).
#[cfg(unix)]
#[test]
fn to_mcp_server_without_shim_sets_no_browser() {
    let config = AgentConfig {
        config_id: None,
        name: "test-agent".to_string(),
        command: "/usr/bin/agent".to_string(),
        args: vec![],
        env: HashMap::new(),
        allow_terminal: false,
    };

    match config.to_mcp_server(None) {
        agent_client_protocol::schema::v1::McpServer::Stdio(stdio) => {
            assert!(
                stdio.env.iter().all(|v| v.name != "BROWSER"),
                "no BROWSER override without a shim dir"
            );
        }
        _ => panic!("expected stdio server"),
    }
}
