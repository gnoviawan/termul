use serde_json::{json, Value};

use super::*;

fn record(state: SubagentState, stop: Option<SubagentStop>) -> Subagent {
    Subagent {
        id: "child-1".to_string(),
        root_session_id: "chat-1".to_string(),
        parent_id: None,
        dispatch_tool_call_id: "termul-subagent:child-1".to_string(),
        source: SubagentSource::AcpRfd,
        title: "Explore".to_string(),
        description: None,
        role: None,
        prompt: None,
        background: false,
        state,
        started_at: Some(10),
        ended_at: None,
        model: None,
        usage: None,
        output_file: None,
        caps: SubagentCaps {
            stop,
            transcript: SubagentTranscript::Live,
            live_progress: true,
            usage: true,
        },
    }
}

#[test]
fn a_running_record_serializes_to_the_shared_type() {
    let running = record(SubagentState::Running, None);
    let value = serde_json::to_value(&running).expect("serialize");
    assert_eq!(
        value,
        json!({
            "id": "child-1",
            "rootSessionId": "chat-1",
            "dispatchToolCallId": "termul-subagent:child-1",
            "source": "acp-rfd",
            "title": "Explore",
            "background": false,
            "activity": "running",
            "startedAt": 10,
            "caps": { "stop": null, "transcript": "live", "liveProgress": true, "usage": true },
        })
    );
    assert!(value.get("end").is_none(), "only idle carries an end");
    let back: Subagent = serde_json::from_value(value).expect("deserialize");
    assert_eq!(back, running);
}

#[test]
fn an_idle_record_carries_its_end_and_every_optional_field() {
    let mut idle = record(
        SubagentState::Idle {
            end: SubagentEnd {
                reason: SubagentEndReason::Failed,
                error: Some("boom".to_string()),
            },
        },
        Some(SubagentStop::SessionCancel),
    );
    idle.parent_id = Some("child-0".to_string());
    idle.source = SubagentSource::ToolHeuristic;
    idle.description = Some("role".to_string());
    idle.role = Some("reviewer".to_string());
    idle.prompt = Some("Review".to_string());
    idle.background = true;
    idle.ended_at = Some(20);
    idle.model = Some("claude-haiku".to_string());
    idle.usage = Some(SubagentUsage {
        input_tokens: Some(1),
        output_tokens: Some(2),
        total_tokens: Some(3),
        tool_uses: Some(4),
        duration_ms: Some(5),
    });
    idle.output_file = Some("/tmp/out".to_string());
    idle.caps.transcript = SubagentTranscript::Final;
    let value = serde_json::to_value(&idle).expect("serialize");
    assert_eq!(
        value,
        json!({
            "id": "child-1",
            "rootSessionId": "chat-1",
            "parentId": "child-0",
            "dispatchToolCallId": "termul-subagent:child-1",
            "source": "tool-heuristic",
            "title": "Explore",
            "description": "role",
            "role": "reviewer",
            "prompt": "Review",
            "background": true,
            "activity": "idle",
            "end": { "reason": "failed", "error": "boom" },
            "startedAt": 10,
            "endedAt": 20,
            "model": "claude-haiku",
            "usage": { "inputTokens": 1, "outputTokens": 2, "totalTokens": 3, "toolUses": 4, "durationMs": 5 },
            "outputFile": "/tmp/out",
            "caps": { "stop": "session-cancel", "transcript": "final", "liveProgress": true, "usage": true },
        })
    );
    let back: Subagent = serde_json::from_value(value).expect("deserialize");
    assert_eq!(back, idle);
}

#[test]
fn every_activity_and_source_uses_the_shared_names() {
    let names: Vec<Value> = [
        SubagentState::Running,
        SubagentState::RequiresAction,
        SubagentState::idle(SubagentEndReason::Unexplained),
        SubagentState::Unknown,
    ]
    .into_iter()
    .map(|state| serde_json::to_value(record(state, None)).expect("serialize")["activity"].clone())
    .collect();
    assert_eq!(names, ["running", "requires_action", "idle", "unknown"]);
    let sources: Vec<Value> = [
        SubagentSource::AcpRfd,
        SubagentSource::AcpAir,
        SubagentSource::ClaudeMeta,
        SubagentSource::CodexCollab,
        SubagentSource::CursorTask,
        SubagentSource::OpencodeTask,
        SubagentSource::GeminiAgent,
        SubagentSource::ToolHeuristic,
    ]
    .into_iter()
    .map(|source| serde_json::to_value(source).expect("serialize"))
    .collect();
    assert_eq!(
        sources,
        [
            "acp-rfd",
            "acp-air",
            "claude-meta",
            "codex-collab",
            "cursor-task",
            "opencode-task",
            "gemini-agent",
            "tool-heuristic"
        ]
    );
    assert_eq!(
        serde_json::to_value(SubagentControl {
            subagent_ids: vec!["a".to_string()]
        })
        .expect("serialize"),
        json!({ "subagentIds": ["a"] })
    );
}

#[test]
fn set_state_keeps_the_first_end_and_clears_it_on_running() {
    let mut subagent = record(SubagentState::Running, None);
    subagent.set_state(SubagentState::idle(SubagentEndReason::Completed), 20);
    assert_eq!(subagent.ended_at, Some(20));
    subagent.set_state(SubagentState::idle(SubagentEndReason::Failed), 30);
    assert_eq!(subagent.ended_at, Some(20), "idle to idle keeps the stamp");
    subagent.set_state(SubagentState::Running, 40);
    assert_eq!(subagent.ended_at, None);
    subagent.set_state(SubagentState::Unknown, 50);
    assert_eq!(subagent.ended_at, None, "unknown is not an end");
}

#[test]
fn spoofed_host_keys_are_stripped_and_nothing_else() {
    let mut update = json!({
        "_meta": {
            "termul/subagent": {},
            "termul/subagentControl": {},
            "claudeCode": { "toolName": "Agent" },
        }
    });
    assert!(has_spoofed_meta(update.as_object().expect("object")));
    assert!(strip_spoofed_meta(&mut update));
    assert_eq!(
        update,
        json!({ "_meta": { "claudeCode": { "toolName": "Agent" } } })
    );
    assert!(!strip_spoofed_meta(&mut update));
    assert!(!strip_spoofed_meta(&mut json!({ "_meta": null })));
}

#[test]
fn counts_accept_only_finite_non_negative_numbers() {
    assert_eq!(count(&json!(5)), Some(5));
    assert_eq!(count(&json!(2.9)), Some(2));
    assert_eq!(count(&json!(-1)), None);
    assert_eq!(count(&json!("5")), None);
    assert_eq!(bounded_text(Some(&json!("  hi  ")), 1), Some("h"));
    assert_eq!(bounded_text(Some(&json!("   ")), 10), None);
}
