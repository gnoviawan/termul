use super::*;

#[test]
fn parses_well_formed_registry() {
    let body = r#"{
            "agents": [
                {
                    "id": "claude-acp",
                    "name": "Claude Code",
                    "description": "Anthropic's agent",
                    "website": "https://claude.com",
                    "icon": "https://cdn/icon.svg",
                    "distribution": { "binary": { "cmd": "claude-agent-acp", "args": [] } }
                }
            ]
        }"#;
    let entries = parse_registry(body).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].id, "claude-acp");
    assert_eq!(entries[0].name, "Claude Code");
    assert_eq!(entries[0].icon.as_deref(), Some("https://cdn/icon.svg"));
}

#[test]
fn missing_name_falls_back_to_id() {
    let body = r#"{ "agents": [ { "id": "mystery" } ] }"#;
    let entries = parse_registry(body).unwrap();
    assert_eq!(entries[0].name, "mystery");
}

#[test]
fn ignores_unknown_fields_including_distribution() {
    // The parser distills identity only; `distribution` (the ACP invocation)
    // must never leak into the returned entry shape.
    let body = r#"{ "agents": [ { "id": "x", "distribution": { "npx": { "cmd": "x-acp" } }, "extra": 1 } ] }"#;
    let entries = parse_registry(body).unwrap();
    assert_eq!(entries.len(), 1);
    let json = serde_json::to_string(&entries[0]).unwrap();
    assert!(!json.contains("distribution"));
    assert!(!json.contains("x-acp"));
}

#[test]
fn empty_agents_list_is_ok() {
    let body = r#"{ "agents": [] }"#;
    assert_eq!(parse_registry(body).unwrap().len(), 0);
}

#[test]
fn malformed_json_errors() {
    assert!(parse_registry("not json").is_err());
}
