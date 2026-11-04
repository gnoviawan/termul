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

#[test]
fn a_subagents_own_call_keeps_its_masked_title_and_path() {
    let payload = json!({
        "toolCall": {
            "toolCallId": "c1",
            "kind": "read",
            "title": "Read src/a.ts with token sk-abcdefghijklmnopqrstuv",
            "rawInput": { "file_path": "https://bob:hunter2pass@example.com/a.ts" },
            "content": [{ "type": "content", "content": { "type": "text", "text": "file body" } }],
            "_meta": { "claudeCode": { "parentToolUseId": "d1" } },
        },
    });
    let kept = super::normalize_durable_payload("tool_call", &payload)["toolCall"].clone();
    let path = kept["locations"][0]["path"].as_str().unwrap();
    assert!(
        path.starts_with("https://bob:") && !path.contains("hunter2pass"),
        "{path}"
    );
    let title = kept["title"].as_str().unwrap();
    assert!(title.starts_with("Read src/a.ts with token "), "{title}");
    assert!(!title.contains("sk-abcdefghijklmnopqrstuv"));
    assert!(
        kept.get("content").is_none(),
        "a child call's output is never durable"
    );
    assert!(kept.get("rawInput").is_none());
}

#[test]
fn a_dispatch_keeps_its_bounded_text_result() {
    let long = "r".repeat(super::MAX_DURABLE_SUBAGENT_TEXT_CHARS + 10);
    let payload = json!({
        "update": {
            "toolCallId": "d1",
            "status": "completed",
            "title": "Agent",
            "content": [
                { "type": "content", "content": { "type": "image", "data": "AAAA" } },
                { "type": "content", "content": { "type": "text", "text": long } },
            ],
            "_meta": { "termul/subagent": { "id": "d1", "activity": "idle" } },
        },
    });
    let kept = super::normalize_durable_payload("tool_call_update", &payload)["update"].clone();
    let text = kept["content"][0]["content"]["text"].as_str().unwrap();
    assert_eq!(text.len(), super::MAX_DURABLE_SUBAGENT_TEXT_CHARS);
    assert_eq!(
        kept["content"].as_array().unwrap().len(),
        1,
        "only the text is kept"
    );
    assert!(
        kept.get("title").is_none(),
        "the record carries the dispatch title"
    );
}

fn reduced_edit(type_: &str, tool: serde_json::Value) -> serde_json::Value {
    let key = if type_ == "tool_call" {
        "toolCall"
    } else {
        "update"
    };
    let payload = json!({ "agentId": "agent", "sessionId": "chat", key: tool });
    super::normalize_durable_payload(type_, &payload)[key].clone()
}

#[test]
fn a_multi_file_edit_without_locations_persists_every_diff_path() {
    let edit = reduced_edit(
        "tool_call",
        json!({
            "toolCallId": "multi",
            "kind": "edit",
            "content": [
                { "type": "diff", "path": "/work/a.ts", "oldText": "a\n", "newText": "A\n" },
                { "type": "content", "content": { "type": "text", "text": "note" } },
                { "type": "diff", "path": "/work/b.ts", "oldText": null, "newText": "b\n" },
                { "type": "diff", "path": "", "newText": "x\n" },
                { "type": "diff", "path": "/work/a.ts", "oldText": "A\n", "newText": "AA\n" },
            ],
        }),
    );
    assert_eq!(
        edit["locations"],
        json!([{ "path": "/work/a.ts" }, { "path": "/work/b.ts" }]),
        "each diff path once, in order"
    );
    assert_eq!(edit["diffStat"], json!({ "added": 4, "removed": 2 }));
    let update = reduced_edit(
        "tool_call_update",
        json!({
            "toolCallId": "multi",
            "status": "completed",
            "content": [
                { "type": "diff", "path": "/work/a.ts", "newText": "A\n" },
                { "type": "diff", "path": "/work/c.ts", "newText": "c\n" },
            ],
        }),
    );
    assert_eq!(
        update["locations"],
        json!([{ "path": "/work/a.ts" }, { "path": "/work/c.ts" }])
    );
}

#[test]
fn a_file_change_summary_claims_every_location_and_diff_path_within_bounds() {
    let move_ = reduced_edit(
        "tool_call",
        json!({
            "toolCallId": "m",
            "kind": "move",
            "locations": [{ "path": "/work/old.ts" }, { "path": "/work/new.ts" }],
            "rawInput": { "path": "/work/input.ts" },
        }),
    );
    assert_eq!(
        move_["locations"],
        json!([{ "path": "/work/old.ts" }, { "path": "/work/new.ts" }]),
        "both ends of a move persist"
    );
    let huge = format!("/{}", "a".repeat(super::MAX_SUMMARY_PATH_CHARS));
    let items: Vec<serde_json::Value> = std::iter::once(huge)
        .chain((0..super::MAX_SUMMARY_PATHS + 5).map(|i| format!("/work/f{i}.ts")))
        .map(|path| json!({ "type": "diff", "path": path, "newText": "x\n" }))
        .collect();
    let many = reduced_edit(
        "tool_call",
        json!({ "toolCallId": "e", "kind": "edit", "content": items }),
    );
    let paths = many["locations"].as_array().unwrap();
    assert_eq!(paths.len(), super::MAX_SUMMARY_PATHS);
    assert_eq!(
        paths[0],
        json!({ "path": "/work/f0.ts" }),
        "an overlong path is skipped"
    );
}
