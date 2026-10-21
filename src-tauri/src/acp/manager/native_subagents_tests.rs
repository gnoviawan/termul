use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{json, Value};

use super::native_subagents::{
    advertise_subagents, deliver_native_update, parse_semver, route_session_update,
    uses_air_native_subagents, NativeRoute,
};
use super::*;

const ROOT: &str = "sess-root";
const CHILD: &str = "sess-child";
const GRANDCHILD: &str = "sess-grandchild";

#[derive(Default)]
struct CapturingSink {
    seen: Mutex<Vec<crate::web::sink::AcpEvent>>,
}

impl EventSink for CapturingSink {
    fn emit(&self, event: &crate::web::sink::AcpEvent) {
        self.seen.lock().push(event.clone());
    }
}

fn update(session_id: &str, update: Value) -> Value {
    json!({ "sessionId": session_id, "update": update })
}

fn spawned(parent: &str, child: &str) -> Value {
    update(
        parent,
        json!({
            "sessionUpdate": "subagent_spawned",
            "subagentSessionId": child,
            "name": "Explore repo",
            "task": "Read every file under src/",
            "capabilities": {},
        }),
    )
}

fn ended(child: &str, state: &str) -> Value {
    update(
        ROOT,
        json!({
            "sessionUpdate": "subagent_state_update",
            "subagentSessionId": child,
            "state": state,
        }),
    )
}

fn agent_chunk(session_id: &str, text: &str) -> Value {
    update(
        session_id,
        json!({
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "text", "text": text },
        }),
    )
}

fn claimed(route: NativeRoute) -> Vec<Value> {
    match route {
        NativeRoute::Claimed(values) => values,
        NativeRoute::PassThrough => panic!("expected the update to be claimed"),
    }
}

fn single(route: NativeRoute) -> Value {
    let mut values = claimed(route);
    assert_eq!(values.len(), 1, "expected one synthesized update");
    values.remove(0)
}

fn typed(value: Value) -> agent_client_protocol::schema::v1::SessionNotification {
    serde_json::from_value(value).expect("synthesized update must parse as a typed notification")
}

fn claude_config(args: Vec<String>) -> AgentConfig {
    AgentConfig {
        config_id: Some("acp-registry:claude-acp".to_string()),
        name: "Claude".to_string(),
        command: "npx".to_string(),
        args,
        env: HashMap::new(),
        allow_terminal: false,
    }
}

#[test]
fn chat_updates_pass_through_unchanged() {
    let state = Mutex::new(DriverState::new());
    assert_eq!(
        route_session_update(&state, &agent_chunk(ROOT, "hello"), 1),
        NativeRoute::PassThrough
    );
    assert_eq!(
        route_session_update(&state, &json!({ "sessionId": ROOT }), 1),
        NativeRoute::PassThrough
    );
}

#[test]
fn spawn_synthesizes_a_running_dispatch_card_on_the_chat() {
    use agent_client_protocol::schema::v1::{SessionUpdate, ToolCallStatus};
    let state = Mutex::new(DriverState::new());
    let card = single(route_session_update(&state, &spawned(ROOT, CHILD), 1));
    assert_eq!(card["sessionId"], ROOT);
    let meta = &card["update"]["_meta"];
    assert_eq!(meta["termul/subagent"]["state"], "running");
    assert_eq!(meta["termul/subagent"]["sessionId"], CHILD);
    assert!(
        meta.get("claudeCode").is_none(),
        "a top-level subagent has no parent"
    );
    assert_eq!(
        card["update"]["rawInput"]["prompt"],
        "Read every file under src/"
    );

    let SessionUpdate::ToolCall(call) = typed(card).update else {
        panic!("the dispatch card must be a tool_call");
    };
    assert_eq!(call.tool_call_id.0.as_ref(), "termul-subagent:sess-child");
    assert_eq!(call.title, "Explore repo");
    assert_eq!(call.status, ToolCallStatus::InProgress);
}

#[test]
fn nested_spawn_lands_on_the_chat_under_its_parent_dispatch() {
    let state = Mutex::new(DriverState::new());
    claimed(route_session_update(&state, &spawned(ROOT, CHILD), 1));
    let card = single(route_session_update(&state, &spawned(CHILD, GRANDCHILD), 2));
    assert_eq!(card["sessionId"], ROOT);
    assert_eq!(
        card["update"]["_meta"]["claudeCode"]["parentToolUseId"],
        "termul-subagent:sess-child"
    );
}

#[test]
fn spawn_without_a_usable_child_id_is_dropped() {
    let state = Mutex::new(DriverState::new());
    assert!(claimed(route_session_update(&state, &spawned(ROOT, ""), 1)).is_empty());
    assert!(claimed(route_session_update(&state, &spawned(ROOT, ROOT), 1)).is_empty());
    let long_id = "x".repeat(513);
    assert!(claimed(route_session_update(&state, &spawned(ROOT, &long_id), 1)).is_empty());
}

#[test]
fn child_history_is_rerouted_to_the_chat_with_its_dispatch_stamp() {
    use agent_client_protocol::schema::v1::SessionUpdate;
    let state = Mutex::new(DriverState::new());
    claimed(route_session_update(&state, &spawned(ROOT, CHILD), 1));

    let chunk = single(route_session_update(
        &state,
        &agent_chunk(CHILD, "found it"),
        2,
    ));
    assert_eq!(chunk["sessionId"], ROOT);
    let notification = typed(chunk);
    assert_eq!(notification.session_id.0.as_ref(), ROOT);
    let SessionUpdate::AgentMessageChunk(content) = notification.update else {
        panic!("a child chunk must stay a chunk");
    };
    assert_eq!(
        crate::acp::client::chunk_parent_tool_call_id(&content).as_deref(),
        Some("termul-subagent:sess-child")
    );

    let child_call = update(
        CHILD,
        json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "toolu_read",
            "title": "Read",
            "_meta": { "claudeCode": { "toolName": "Read" } },
        }),
    );
    let call = single(route_session_update(&state, &child_call, 3));
    assert_eq!(call["sessionId"], ROOT);
    assert_eq!(call["update"]["_meta"]["claudeCode"]["toolName"], "Read");
    assert_eq!(
        call["update"]["_meta"]["claudeCode"]["parentToolUseId"],
        "termul-subagent:sess-child"
    );
}

#[test]
fn child_state_updates_are_dropped() {
    let state = Mutex::new(DriverState::new());
    claimed(route_session_update(&state, &spawned(ROOT, CHILD), 1));
    let usage = update(
        CHILD,
        json!({ "sessionUpdate": "usage_update", "used": 10, "size": 100 }),
    );
    assert!(claimed(route_session_update(&state, &usage, 2)).is_empty());
}

#[test]
fn state_update_ends_the_dispatch_card() {
    use agent_client_protocol::schema::v1::{SessionUpdate, ToolCallStatus};
    let state = Mutex::new(DriverState::new());
    claimed(route_session_update(&state, &spawned(ROOT, CHILD), 1));
    let end = single(route_session_update(&state, &ended(CHILD, "completed"), 42));
    assert_eq!(end["sessionId"], ROOT);
    let marker = &end["update"]["_meta"]["termul/subagent"];
    assert_eq!(marker["state"], "completed");
    assert_eq!(marker["endedAt"], 42);
    let SessionUpdate::ToolCallUpdate(update) = typed(end).update else {
        panic!("the end must be a tool_call_update");
    };
    assert_eq!(update.tool_call_id.0.as_ref(), "termul-subagent:sess-child");
    assert_eq!(update.fields.status, Some(ToolCallStatus::Completed));

    let late = single(route_session_update(
        &state,
        &agent_chunk(CHILD, "late"),
        43,
    ));
    assert_eq!(
        late["sessionId"], ROOT,
        "an ended child still routes to its chat"
    );
}

#[test]
fn state_update_maps_each_end_state() {
    for (raw, lifecycle, status) in [
        ("failed", "failed", "failed"),
        ("disconnected", "failed", "failed"),
        ("cancelled", "cancelled", "completed"),
    ] {
        let state = Mutex::new(DriverState::new());
        claimed(route_session_update(&state, &spawned(ROOT, CHILD), 1));
        let end = single(route_session_update(&state, &ended(CHILD, raw), 2));
        assert_eq!(end["update"]["status"], status, "{raw}");
        assert_eq!(
            end["update"]["_meta"]["termul/subagent"]["state"], lifecycle,
            "{raw}"
        );
    }
}

#[test]
fn unknown_state_or_unknown_child_is_dropped() {
    let state = Mutex::new(DriverState::new());
    claimed(route_session_update(&state, &spawned(ROOT, CHILD), 1));
    assert!(claimed(route_session_update(&state, &ended(CHILD, "paused"), 2)).is_empty());
    assert!(claimed(route_session_update(
        &state,
        &ended("sess-other", "completed"),
        2
    ))
    .is_empty());
}

#[test]
fn rfd_form_updates_are_dropped() {
    let state = Mutex::new(DriverState::new());
    for kind in ["subagent_update", "session_message"] {
        let value = update(ROOT, json!({ "sessionUpdate": kind }));
        assert!(
            claimed(route_session_update(&state, &value, 1)).is_empty(),
            "{kind}"
        );
    }
}

#[test]
fn initialize_advertises_subagents_only_when_enabled() {
    let request = InitializeRequest::new(ProtocolVersion::V1)
        .client_capabilities(client::client_capabilities(false));
    let params = |native: bool| {
        let message = initialize_message(&request, native).expect("initialize message");
        serde_json::to_value(&message.params).expect("params")
    };
    assert_eq!(params(true)["clientCapabilities"]["subagents"], json!({}));
    assert!(params(false)["clientCapabilities"]
        .get("subagents")
        .is_none());

    let mut no_caps = json!({ "protocolVersion": 1 });
    advertise_subagents(&mut no_caps);
    assert!(no_caps.get("clientCapabilities").is_none());
}

#[test]
fn native_form_is_gated_on_the_claude_adapter_version() {
    let pinned = |version: &str| {
        claude_config(vec![format!(
            "@agentclientprotocol/claude-agent-acp@{version}"
        )])
    };
    assert!(uses_air_native_subagents(&pinned("0.78.0")));
    assert!(uses_air_native_subagents(&pinned("0.89.9")));
    assert!(!uses_air_native_subagents(&pinned("0.77.3")));
    assert!(!uses_air_native_subagents(&pinned("0.94.0")));

    let other = AgentConfig {
        config_id: Some("acp-registry:codex".to_string()),
        name: "Codex".to_string(),
        command: "codex-acp".to_string(),
        args: Vec::new(),
        env: HashMap::new(),
        allow_terminal: false,
    };
    assert!(!uses_air_native_subagents(&other));

    assert_eq!(parse_semver("0.78.0"), Some((0, 78, 0)));
    assert_eq!(parse_semver("1.2.3-beta.1"), Some((1, 2, 3)));
    assert_eq!(parse_semver("1.2"), None);
    assert_eq!(parse_semver("1.2.3.4"), None);
}

#[test]
fn native_form_reads_the_installed_package_manifest() {
    let root = tempfile::tempdir().expect("tempdir");
    let package = root
        .path()
        .join("node_modules/@agentclientprotocol/claude-agent-acp");
    std::fs::create_dir_all(package.join("dist")).expect("package dir");
    let entry = package.join("dist/index.js");
    std::fs::write(&entry, "").expect("entry");
    let manifest = |version: &str| {
        std::fs::write(
            package.join("package.json"),
            json!({ "name": "@agentclientprotocol/claude-agent-acp", "version": version })
                .to_string(),
        )
        .expect("manifest");
    };
    let config = AgentConfig {
        command: "node".to_string(),
        ..claude_config(vec![entry.to_string_lossy().into_owned()])
    };

    manifest("0.78.0");
    assert!(uses_air_native_subagents(&config));
    manifest("0.90.0");
    assert!(!uses_air_native_subagents(&config));
    std::fs::write(package.join("package.json"), "not json").expect("bad manifest");
    assert!(!uses_air_native_subagents(&config));
}

#[tokio::test]
async fn claimed_updates_fan_out_on_the_chat_session() {
    let state = Arc::new(Mutex::new(DriverState::new()));
    let sink = Arc::new(CapturingSink::default());
    let sinks: Vec<Arc<dyn EventSink>> = vec![sink.clone()];
    let agent_id = AgentId::new();
    let deliver = |raw: Value| {
        let (state, sinks, agent_id) = (state.clone(), sinks.clone(), agent_id.clone());
        async move {
            deliver_native_update(&state, None, &sinks, &agent_id, &raw)
                .await
                .expect("fan out")
        }
    };
    assert!(!deliver(agent_chunk(ROOT, "chat text")).await);
    assert!(
        sink.seen.lock().is_empty(),
        "a pass-through is not fanned out here"
    );
    for raw in [
        spawned(ROOT, CHILD),
        agent_chunk(CHILD, "working"),
        ended(CHILD, "completed"),
    ] {
        assert!(deliver(raw).await);
    }
    let seen = sink.seen.lock();
    let kinds: Vec<_> = seen.iter().map(|event| event.type_).collect();
    assert_eq!(
        kinds,
        [
            crate::acp::events::EVENT_TOOL_CALL,
            crate::acp::events::EVENT_MESSAGE_CHUNK,
            crate::acp::events::EVENT_TOOL_CALL_UPDATE,
        ]
    );
    assert!(seen.iter().all(|event| event.sid.as_deref() == Some(ROOT)));
    assert_eq!(
        seen[1].payload["parentToolCallId"],
        "termul-subagent:sess-child"
    );
}
