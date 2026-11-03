use serde_json::json;

use super::derive_title;

fn title_of(text: &str) -> String {
    derive_title(&json!({ "content": [{ "type": "text", "text": text }] }))
}

#[test]
fn a_skill_framed_prompt_titles_from_the_user_text() {
    assert_eq!(
        title_of("# Agent Skills\n\ngit-worktree: /skills/git-worktree/SKILL.md\n\n---\n\nmake a worktree with (git-worktree)"),
        "make a worktree with (git-worktree)"
    );
}

#[test]
fn a_command_prefixed_skill_prompt_keeps_the_command() {
    assert_eq!(
        title_of("/review # Agent Skills\n\nCafé-review: C:/skills/cafe/SKILL.md\n\n---\n\n(Café-review) the login form"),
        "/review (Café-review) the login form"
    );
}

#[test]
fn a_crlf_framed_prompt_titles_from_the_user_text() {
    assert_eq!(
        title_of(
            "# Agent Skills\r\n\r\ngit-worktree: /a/SKILL.md\r\n\r\n---\r\n\r\n(git-worktree) hi"
        ),
        "(git-worktree) hi"
    );
}

#[test]
fn a_token_only_skill_prompt_titles_from_the_framed_names() {
    assert_eq!(
        title_of("# Agent Skills\n\ngit-worktree: /a/SKILL.md\nrelease-version: /b/SKILL.md"),
        "(git-worktree) (release-version)"
    );
}

#[test]
fn text_that_only_resembles_the_framing_keeps_its_first_line() {
    assert_eq!(
        title_of("# Agent Skills\n\nnot a skill line\n\n---\n\nhello"),
        "# Agent Skills"
    );
    assert_eq!(title_of("/compact hello"), "/compact hello");
}

#[test]
fn a_framed_handoff_draft_with_skills_titles_from_the_user_text() {
    assert_eq!(
        title_of("# Conversation handoff\n\nYou are taking over.\n\n---\n\n# Agent Skills\n\nfix-repo: /skills/fix-repo.md\n\n---\n\n(fix-repo) now"),
        "(fix-repo) now"
    );
}

fn durable_tool_meta(type_: &str, meta: serde_json::Value) -> serde_json::Value {
    let key = if type_ == "tool_call" {
        "toolCall"
    } else {
        "update"
    };
    let payload = json!({
        "agentId": "agent",
        "sessionId": "chat",
        key: {
            "toolCallId": "toolu_1",
            "title": "Agent",
            "rawInput": { "prompt": "secret plan" },
            "_meta": meta,
        },
    });
    super::normalize_durable_payload(type_, &payload)[key].clone()
}

#[test]
fn the_durable_tool_dto_admits_only_the_subagent_meta() {
    let record = json!({
        "id": "toolu_1",
        "activity": "idle",
        "end": { "reason": "completed" },
        "usage": { "inputTokens": 1, "outputTokens": 2, "totalTokens": 3 },
    });
    let kept = durable_tool_meta(
        "tool_call",
        json!({
            "termul/subagent": record,
            "termul/subagentControl": { "subagentIds": ["toolu_0"] },
            "claudeCode": {
                "parentToolUseId": "toolu_parent",
                "toolName": "Agent",
                "toolResponse": { "content": "report" },
            },
            "other": { "token": "x" },
        }),
    );
    assert_eq!(
        kept,
        json!({
            "toolCallId": "toolu_1",
            "_meta": {
                "termul/subagent": record,
                "termul/subagentControl": { "subagentIds": ["toolu_0"] },
                "claudeCode": { "parentToolUseId": "toolu_parent" },
            },
        }),
        "token counts survive; nothing else from _meta or the call does"
    );
    let update = durable_tool_meta(
        "tool_call_update",
        json!({ "claudeCode": { "toolName": "Read" } }),
    );
    assert_eq!(update, json!({ "toolCallId": "toolu_1" }));
}

#[test]
fn the_durable_subagent_meta_is_bounded() {
    let long_prompt = "x".repeat(17 * 1024);
    let kept = durable_tool_meta(
        "tool_call",
        json!({ "termul/subagent": { "id": "toolu_1", "prompt": long_prompt } }),
    );
    assert_eq!(
        kept["_meta"],
        json!({ "termul/subagent": { "id": "toolu_1" } }),
        "an oversized record loses its prompt first"
    );
    let huge_title = "x".repeat(17 * 1024);
    let dropped = durable_tool_meta(
        "tool_call",
        json!({
            "termul/subagent": { "title": huge_title },
            "termul/subagentControl": { "subagentIds": ["y".repeat(5 * 1024)] },
            "claudeCode": { "parentToolUseId": "p".repeat(513) },
        }),
    );
    assert!(dropped.get("_meta").is_none(), "{dropped}");
    let malformed = durable_tool_meta(
        "tool_call",
        json!({ "termul/subagent": "running", "claudeCode": { "parentToolUseId": "" } }),
    );
    assert!(malformed.get("_meta").is_none());
}
