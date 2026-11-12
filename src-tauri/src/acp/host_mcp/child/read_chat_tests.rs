//! `read_chat` as an agent calls it: an MCP client on the child's stdio
//! transport, through the real parent, to another project's chat on disk.

use serde_json::{json, Value};

use super::tests::{read_json_id, send_line, with_mcp_session, ClientReader, ClientWriter};
use crate::acp::host_mcp::gateway_harness::Harness;
use crate::acp::session_persistence::{PersistedEventRecord, SESSION_SCHEMA_VERSION};

/// 2025-11-08T10:00:00Z.
const BASE: u64 = 1_762_596_000_000;

fn record_in(session_id: &str, seq: u64, type_: &str, payload: Value) -> PersistedEventRecord {
    PersistedEventRecord {
        schema_version: SESSION_SCHEMA_VERSION,
        session_id: session_id.to_string(),
        seq,
        type_: type_.to_string(),
        recorded_at: BASE + seq * 1000,
        payload,
    }
}

fn record(seq: u64, type_: &str, payload: Value) -> PersistedEventRecord {
    record_in("chat-b", seq, type_, payload)
}

/// `(is_error, text)` of one `read_chat` call.
async fn read_chat(
    writer: &mut ClientWriter,
    reader: &mut ClientReader,
    id: i64,
    arguments: Value,
) -> (bool, String) {
    let request = json!({
        "jsonrpc": "2.0", "id": id, "method": "tools/call",
        "params": { "name": "read_chat", "arguments": arguments },
    });
    send_line(writer, &request.to_string()).await;
    let reply = read_json_id(reader, id).await;
    let text = reply["result"]["content"][0]["text"]
        .as_str()
        .unwrap_or_else(|| panic!("no text in {reply}"))
        .to_string();
    (reply["result"]["isError"] == true, text)
}

#[test]
fn an_agent_reads_a_chat_of_another_project_by_its_id() {
    let (harness, configs) =
        Harness::new(&[("chat-a", Some("proj-a")), ("chat-b", Some("proj-b"))]);
    let persistence = harness.persistence();
    for record in [
        record(
            1,
            "user_prompt",
            json!({ "content": [{ "type": "text", "text": "Run the release skill" }] }),
        ),
        record(
            2,
            "message_chunk",
            json!({ "role": "thought", "content": { "type": "text", "text": "hmm" } }),
        ),
        record(
            3,
            "message_chunk",
            json!({ "role": "agent", "content": { "type": "text", "text": "Step 2 failed." } }),
        ),
        record(
            4,
            "tool_call",
            json!({ "toolCall": { "toolCallId": "t1", "kind": "execute", "status": "failed", "rawInput": { "command": "secret" } } }),
        ),
    ] {
        persistence.enqueue_event(record).unwrap();
    }
    let created = harness.runtime.block_on(async {
        persistence.flush_session("chat-b").await.unwrap();
        persistence.metadata("chat-b").unwrap().created_at
    });
    let created = chrono::DateTime::from_timestamp_millis(created as i64)
        .unwrap()
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    // `register_session` persists the canonicalized cwd without a `\\?\`
    // verbatim prefix, and on Windows the temp dir's short-name form differs
    // from the canonical one, so the expected Folder line is built the same
    // way rather than from `harness.cwd` directly.
    let canonical_cwd = harness
        .cwd
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let expected_cwd = crate::path_validation::strip_verbatim_prefix(&canonical_cwd);
    let header = format!(
        "Chat: Run the release skill\nChat ID: chat-b\nProject: ID proj-b\nFolder: {expected_cwd}\nAgent: test"
    );
    let caller = configs[0].clone();
    harness.runtime.block_on(with_mcp_session(
        caller,
        |mut writer, mut reader| async move {
            let (is_error, text) =
                read_chat(&mut writer, &mut reader, 2, json!({ "chat_id": "chat-b" })).await;
            assert!(!is_error, "{text}");
            let (head, rest) = text.split_once("\nStatus: ").unwrap();
            assert_eq!(head, header);
            assert!(
                rest.starts_with(&format!("active · created {created} · last activity ")),
                "{rest}"
            );
            assert_eq!(
                rest.split_once('\n').unwrap().1,
                "Messages 1-2 of 2.

[1] user · 2025-11-08T10:00:01Z
Run the release skill

[2] assistant · 2025-11-08T10:00:03Z
Step 2 failed.
  tool: execute (failed)"
            );

            let missing =
                read_chat(&mut writer, &mut reader, 3, json!({ "chat_id": "nope" })).await;
            assert_eq!(
                missing,
                (
                    true,
                    "No chat with ID nope on this Troupe host.".to_string()
                )
            );
        },
    ));
}

#[test]
fn a_read_follows_an_agent_switch_into_the_linked_chat() {
    let (harness, configs) = Harness::new(&[
        ("chat-a", Some("proj-a")),
        ("chat-b", Some("proj-b")),
        ("chat-c", Some("proj-b")),
    ]);
    let persistence = harness.persistence();
    for record in [
        record_in(
            "chat-b",
            1,
            "user_prompt",
            json!({ "content": [{ "type": "text", "text": "Start here." }] }),
        ),
        record_in(
            "chat-b",
            2,
            "agent_switch",
            json!({ "fromConfigId": "x", "toConfigId": "y", "newSessionId": "chat-c" }),
        ),
        // The linked chat opens with its summary-only handoff prompt.
        record_in(
            "chat-c",
            1,
            "user_prompt",
            json!({ "content": [{ "type": "text", "text": "# Conversation handoff\n\nsummary" }] }),
        ),
        record_in(
            "chat-c",
            2,
            "message_chunk",
            json!({ "role": "agent", "content": { "type": "text", "text": "Continuing here." } }),
        ),
    ] {
        persistence.enqueue_event(record).unwrap();
    }
    harness.runtime.block_on(async {
        persistence.flush_session("chat-b").await.unwrap();
        persistence.flush_session("chat-c").await.unwrap();
    });
    let caller = configs[0].clone();
    harness.runtime.block_on(with_mcp_session(
        caller,
        |mut writer, mut reader| async move {
            let (is_error, text) =
                read_chat(&mut writer, &mut reader, 2, json!({ "chat_id": "chat-b" })).await;
            assert!(!is_error, "{text}");
            let body = text.split_once('\n').unwrap().1;
            assert!(
                body.ends_with(
                    "Messages 1-3 of 3.\n\n[1] user · 2025-11-08T10:00:01Z\nStart here.\n\n[2] assistant · 2025-11-08T10:00:02Z\n--- agent switch: test → test (chat chat-c) ---\n\n[3] assistant · 2025-11-08T10:00:02Z\nContinuing here."
                ),
                "{text}"
            );
        },
    ));
}

#[test]
fn an_agent_switch_cycle_stops_instead_of_looping_forever() {
    let (harness, configs) = Harness::new(&[
        ("chat-a", Some("proj-a")),
        ("chat-b", Some("proj-b")),
        ("chat-c", Some("proj-b")),
    ]);
    let persistence = harness.persistence();
    for record in [
        record_in(
            "chat-b",
            1,
            "user_prompt",
            json!({ "content": [{ "type": "text", "text": "Start here." }] }),
        ),
        record_in(
            "chat-b",
            2,
            "agent_switch",
            json!({ "fromConfigId": "x", "toConfigId": "y", "newSessionId": "chat-c" }),
        ),
        // The linked chat's records come after the switch that opened it.
        PersistedEventRecord {
            recorded_at: BASE + 3000,
            ..record_in(
                "chat-c",
                1,
                "message_chunk",
                json!({ "role": "agent", "content": { "type": "text", "text": "Middle." } }),
            )
        },
        // The cycle back to chat-b ends the chain, not the transcript.
        PersistedEventRecord {
            recorded_at: BASE + 4000,
            ..record_in(
                "chat-c",
                2,
                "agent_switch",
                json!({ "fromConfigId": "y", "toConfigId": "x", "newSessionId": "chat-b" }),
            )
        },
    ] {
        persistence.enqueue_event(record).unwrap();
    }
    harness.runtime.block_on(async {
        persistence.flush_session("chat-b").await.unwrap();
        persistence.flush_session("chat-c").await.unwrap();
    });
    let caller = configs[0].clone();
    harness.runtime.block_on(with_mcp_session(
        caller,
        |mut writer, mut reader| async move {
            let (is_error, text) =
                read_chat(&mut writer, &mut reader, 2, json!({ "chat_id": "chat-b" })).await;
            assert!(!is_error, "{text}");
            let body = text.split_once('\n').unwrap().1;
            assert!(
                body.ends_with(
                    "Messages 1-3 of 3.\n\n[1] user · 2025-11-08T10:00:01Z\nStart here.\n\n[2] assistant · 2025-11-08T10:00:02Z\n--- agent switch: test → test (chat chat-c) ---\n\n[3] assistant · 2025-11-08T10:00:03Z\nMiddle."
                ),
                "{text}"
            );
            assert!(!text.contains("Note:"), "{text}");
        },
    ));
}
