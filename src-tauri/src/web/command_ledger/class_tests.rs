//! The class table: Rust <-> TS parity, dispatch completeness and the
//! fingerprint rules that keep secrets out of the ledger.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::json;

use super::*;

const TS_PROTOCOL: &str = include_str!("../../../../src/shared/types/web-protocol.types.ts");
const DISPATCH: &str = include_str!("../ws/dispatch.rs");

/// The quoted names inside `export const WS_REQUEST_TYPES = [ ... ] as const`.
fn ts_request_types() -> BTreeSet<String> {
    let body = TS_PROTOCOL
        .split("export const WS_REQUEST_TYPES = [")
        .nth(1)
        .and_then(|rest| rest.split("] as const").next())
        .expect("WS_REQUEST_TYPES block");
    body.lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .flat_map(|line| line.split('\'').skip(1).step_by(2))
        .map(str::to_string)
        .collect()
}

/// `name: ['kind', 'replay' | null],` rows of `WS_COMMAND_CLASSES`.
fn ts_command_classes() -> BTreeMap<String, (String, Option<String>)> {
    let body = TS_PROTOCOL
        .split("export const WS_COMMAND_CLASSES")
        .nth(1)
        .and_then(|rest| rest.split("\n}\n").next())
        .expect("WS_COMMAND_CLASSES block");
    body.lines()
        .filter_map(|line| {
            let (name, rest) = line.trim().split_once(": [")?;
            let (kind, replay) = rest.trim_end_matches([',', ']']).split_once(", ")?;
            let unquote = |text: &str| text.trim_matches('\'').to_string();
            let replay = (replay != "null").then(|| unquote(replay));
            Some((name.to_string(), (unquote(kind), replay)))
        })
        .collect()
}

fn kind_name(kind: ClassKind) -> &'static str {
    match kind {
        ClassKind::Create => "create",
        ClassKind::Command => "command",
        ClassKind::Idempotent => "idempotent",
        ClassKind::Read => "read",
    }
}

fn replay_name(replay: Replay) -> &'static str {
    match replay {
        Replay::Payload => "payload",
        Replay::Entity => "entity",
        Replay::ReceiptOnly => "receipt-only",
    }
}

#[test]
fn the_rust_table_and_the_ts_registries_list_the_same_request_types() {
    let rust: BTreeSet<String> = WS_COMMAND_CLASSES
        .iter()
        .map(|(name, _)| (*name).to_string())
        .collect();

    assert_eq!(rust.len(), WS_COMMAND_CLASSES.len(), "no duplicate rows");
    assert_eq!(rust, ts_request_types(), "WS_REQUEST_TYPES drifted from the Rust table");
}

#[test]
fn every_row_has_the_same_class_and_replay_policy_in_ts() {
    let ts = ts_command_classes();

    for (name, class) in WS_COMMAND_CLASSES {
        let (kind, replay) = ts.get(*name).unwrap_or_else(|| panic!("TS lacks {name}"));
        assert_eq!(kind, kind_name(class.kind), "{name} kind");
        assert_eq!(
            replay.as_deref(),
            class.replay.map(replay_name),
            "{name} replay policy"
        );
    }
    assert_eq!(ts.len(), WS_COMMAND_CLASSES.len());
}

#[test]
fn every_routed_request_type_has_a_class() {
    let routed = DISPATCH
        .split("match req.type_.as_str() {")
        .nth(1)
        .expect("route_request match");
    let mut names: BTreeSet<&str> = routed
        .lines()
        .filter_map(|line| {
            let rest = line.trim_start().strip_prefix('"')?;
            let (name, tail) = rest.split_once('"')?;
            let tail = tail.trim_start();
            (tail.starts_with("=>") || tail.starts_with('|')).then_some(name)
        })
        .collect();
    names.remove("panic_for_test");
    names.insert("send_prompt");

    for name in &names {
        assert!(class_of(name).is_some(), "`{name}` is routed but has no class");
    }
    for (name, _) in WS_COMMAND_CLASSES {
        assert!(names.contains(name), "`{name}` has a class but no route");
    }
}

#[test]
fn only_creates_and_non_prompt_commands_enter_the_ledger() {
    let ledgered: BTreeSet<&str> = WS_COMMAND_CLASSES
        .iter()
        .filter(|(_, class)| class.ledgered())
        .map(|(name, _)| *name)
        .collect();

    assert_eq!(
        ledgered,
        BTreeSet::from([
            "create_session",
            "spawn_agent",
            "load_session",
            "resume_session",
            "close_session",
            "respond_permission",
            "answer_question",
            "dispose_ephemeral_session",
            "promote_session",
            "register_discovered_session",
            "authenticate_agent",
            "respond_elicitation",
            "install_acp_agent",
            "acp_deliver_auth_redirect",
            "record_agent_switch",
        ])
    );
    assert!(!class_of("send_prompt").unwrap().1.ledgered(), "TurnWatermark owns prompts");
}

#[test]
fn credential_bearing_kinds_are_receipt_only() {
    for name in ["authenticate_agent", "respond_elicitation", "acp_deliver_auth_redirect"] {
        assert!(!class_of(name).unwrap().1.stores_payload(), "{name}");
    }
}

#[test]
fn every_tauri_command_maps_onto_a_class_row() {
    for command in [
        "acp_spawn_agent",
        "acp_new_session",
        "acp_load_session",
        "acp_resume_session",
        "acp_close_session",
        "acp_dispose_ephemeral_session",
        "acp_promote_session",
        "acp_register_discovered_session",
        "acp_record_agent_switch",
        "acp_authenticate",
        "acp_logout",
        "acp_auth_deliver_redirect",
        "acp_respond_elicitation",
        "acp_delete_agent_session",
        "acp_install_agent",
    ] {
        let request_type = tauri_request_type(command).expect(command);
        assert!(class_of(request_type).is_some(), "{command} -> {request_type}");
    }
}

#[test]
fn a_fingerprint_covers_identifying_fields_only() {
    let base = Fingerprint::of("create_session", &json!({"agentId": "x", "cwd": "/a"}));
    let reordered = Fingerprint::of("create_session", &json!({"cwd": "/a", "agentId": "x"}));
    let other_cwd = Fingerprint::of("create_session", &json!({"agentId": "x", "cwd": "/b"}));
    let other_type = Fingerprint::of("load_session", &json!({"agentId": "x", "cwd": "/a"}));
    let extra = Fingerprint::of(
        "create_session",
        &json!({"agentId": "x", "cwd": "/a", "mcpServers": [{"env": "SECRET"}], "ephemeral": true}),
    );

    assert_eq!(base, reordered);
    assert_ne!(base, other_cwd, "an identifying field differs");
    assert_ne!(base, other_type, "the request type is part of the fingerprint");
    assert_eq!(base, extra, "non-identifying fields are not digested");
}

#[test]
fn a_fingerprint_never_derives_from_args_env_text_or_credentials() {
    let spawn = |args: &str, env: &str| {
        Fingerprint::of(
            "spawn_agent",
            &json!({"config": {
                "name": "n", "command": "c", "configId": "id",
                "args": [args], "env": {"API_KEY": env},
            }}),
        )
    };
    assert_eq!(spawn("--a", "one"), spawn("--b", "two"));
    let other_command = Fingerprint::of(
        "spawn_agent",
        &json!({"config": {"name": "n", "command": "other", "configId": "id"}}),
    );
    assert_ne!(spawn("--a", "one"), other_command);

    let auth = |gateway: &str| {
        Fingerprint::of(
            "authenticate_agent",
            &json!({"agentId": "a", "methodId": "m", "gateway": {"apiKey": gateway}}),
        )
    };
    assert_eq!(auth("one"), auth("two"));
    let other_method = Fingerprint::of(
        "authenticate_agent",
        &json!({"agentId": "a", "methodId": "other"}),
    );
    assert_ne!(auth("one"), other_method, "identifying fields still count");

    let switch = |summary: &str| {
        Fingerprint::of(
            "record_agent_switch",
            &json!({"sessionId": "s", "fromConfigId": "a", "toConfigId": "b",
                    "newSessionId": "n", "summaryText": summary}),
        )
    };
    assert_eq!(switch("one"), switch("another summary"));
}

#[test]
fn identifying_fields_do_not_bleed_into_each_other() {
    let a = Fingerprint::of("close_session", &json!({"agentId": "ab", "sessionId": "c"}));
    let b = Fingerprint::of("close_session", &json!({"agentId": "a", "sessionId": "bc"}));
    assert_ne!(a, b);
}

#[test]
fn identifying_fields_hash_numbers_and_bools_and_keep_types_apart() {
    let print = |value: serde_json::Value| {
        Fingerprint::of("create_session", &json!({"agentId": "x", "cwd": "/a", "projectId": value}))
    };

    assert_ne!(print(json!(1)), print(json!(2)));
    assert_ne!(print(json!(true)), print(json!(false)));
    assert_ne!(print(json!(1)), print(json!("1")), "a number is not its string form");
    assert_eq!(print(json!(null)), Fingerprint::of("create_session", &json!({"agentId": "x", "cwd": "/a"})));
}

#[test]
fn blank_and_padded_ids_normalize_like_the_handlers_do() {
    let print = |project: serde_json::Value| {
        Fingerprint::of("create_session", &json!({"agentId": "x", "cwd": "/a", "projectId": project}))
    };
    let absent = Fingerprint::of("create_session", &json!({"agentId": "x", "cwd": "/a"}));

    assert_eq!(print(json!("   ")), absent, "a blank projectId is no projectId");
    assert_eq!(print(json!(" p1 ")), print(json!("p1")));
    assert_ne!(print(json!("p1")), print(json!("p2")));
}
