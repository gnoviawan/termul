//! ACP module integration tests.
//!
//! The end-to-end handshake test requires a real ACP agent binary and a live
//! Tauri `AppHandle`, neither of which is available in a headless `cargo test`
//! run. It is therefore gated behind `#[ignore]` and documents how to drive a
//! real agent manually.
//!
//! Unit tests for capability gating, event serialization, config conversion,
//! and filesystem handlers live alongside their modules (`manager`, `events`,
//! `config`, `client`).

/// End-to-end smoke test against a real ACP agent.
///
/// This is ignored by default because it needs:
///   1. A locally installed ACP agent (e.g. `npx @zed-industries/claude-code-acp`
///      or `gemini --experimental-acp`).
///   2. A running Tauri application context to provide an `AppHandle`.
///
/// To exercise the full spawn → initialize → new_session → prompt →
/// `acp:prompt_complete` path, wire an `AcpManager` to a test `AppHandle`
/// inside a Tauri integration harness and remove the `#[ignore]`.
#[test]
#[ignore = "requires a real ACP agent binary and a live Tauri AppHandle"]
fn end_to_end_prompt_turn_against_real_agent() {
    // Intentionally a no-op placeholder. See the doc comment above for the
    // manual harness steps. Kept as a discoverable, named test so the gated
    // integration path is visible in `cargo test acp -- --ignored`.
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
        assert_eq!(config.env.get("ANTHROPIC_API_KEY").map(String::as_str), Some("x"));
    }

    #[test]
    fn agent_config_defaults_args_and_env() {
        let json = r#"{ "name": "a", "command": "agent" }"#;
        let config: AgentConfig = serde_json::from_str(json).unwrap();
        assert!(config.args.is_empty());
        assert!(config.env.is_empty());
    }
}
