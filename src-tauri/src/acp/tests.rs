//! ACP module integration tests.
//!
//! Unit tests for capability gating, event serialization, config conversion,
//! and filesystem handlers live alongside their modules (`manager`, `events`,
//! `config`, `client`).

/// Repo-root `cargo build --manifest-path` must compile async-process with
/// the SIGCHLD reaper.
///
/// Cargo reads `.cargo/config.toml` from the cwd and its parents only.
/// `src-tauri/.cargo/config.toml` is invisible when cwd is the repository
/// root. `tauri build` chdirs into `src-tauri` first; a root-cwd Cargo
/// invocation does not. Without the flag, the Linux pidfd wait loop runs on
/// `acp-agent-*` and can pin a core while the child is still alive
/// (issues #401 and #717).
#[test]
fn signal_reaper_cfg_is_set_for_repo_root_and_package_builds() {
    let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root_cfg = manifest_dir
        .parent()
        .expect("src-tauri has a parent")
        .join(".cargo/config.toml");
    let package_cfg = manifest_dir.join(".cargo/config.toml");
    for path in [&root_cfg, &package_cfg] {
        let text = std::fs::read_to_string(path)
            .unwrap_or_else(|err| panic!("missing {}: {err}", path.display()));
        assert!(
            text.contains("async_process_force_signal_backend"),
            "{} must force the async-process signal reaper",
            path.display()
        );
        assert!(
            text.contains("not(target_os = \"windows\")")
                || text.contains("not(target_os = 'windows')"),
            "{} must not apply the signal-backend cfg to Windows",
            path.display()
        );
    }
    // Compile-time guard: clippy's assertions_on_constants forbids a runtime
    // assert on cfg!(...), and a const item fails the build earlier anyway —
    // `cargo check`/`clippy` on Unix fails before tests run if the flag is
    // missing.
    #[cfg(unix)]
    const _: () = assert!(
        cfg!(async_process_force_signal_backend),
        "this build did not pass async_process_force_signal_backend to rustc"
    );
}

#[cfg(test)]
mod config_serialization {
    use crate::acp::config::AgentConfig;

    #[test]
    fn agent_config_deserializes_camel_case() {
        let json = r#"{
            "name": "claude",
            "command": "npx",
            "args": ["-y", "@zed-industries/claude-code-acp"],
            "env": { "ANTHROPIC_API_KEY": "x" }
        }"#;
        let config: AgentConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.name, "claude");
        assert_eq!(config.command, "npx");
        assert_eq!(config.args.len(), 2);
        assert_eq!(
            config.env.get("ANTHROPIC_API_KEY").map(String::as_str),
            Some("x")
        );
    }

    #[test]
    fn agent_config_defaults_args_and_env() {
        let json = r#"{ "name": "a", "command": "agent" }"#;
        let config: AgentConfig = serde_json::from_str(json).unwrap();
        assert!(config.args.is_empty());
        assert!(config.env.is_empty());
        // Default-deny: terminal access is off unless explicitly opted in (M6).
        assert!(!config.allow_terminal);
    }
}
