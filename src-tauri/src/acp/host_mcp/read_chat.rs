//! The `read_chat` tool: another chat's conversation as plain text an agent
//! reads, oldest message first, one page at a time. The parent loads the
//! chat's durable records (`parent/read_chat.rs`); everything here is pure.
//!
//! Durable records keep no tool titles, arguments or output (see
//! `normalize_durable_payload`), so a tool call shows as its kind, any
//! changed file paths and its status.

use std::collections::HashMap;

use chrono::{DateTime, SecondsFormat};
use rmcp::schemars;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::acp::session_payload::fold_session_records;
use crate::acp::session_persistence::{
    PersistedEventRecord, PersistedSessionStatus, SessionMetadata, UNASSIGNED_PROJECT_ID,
};

pub const DESCRIPTION: &str = "Read another Troupe chat's conversation by its chat ID, such \
as one the user pasted from Copy Chat Reference. Returns the title, project, folder and \
messages, oldest first, as plain text; page with offset and limit. Any chat on this Troupe \
host can be read, in any project.";

pub const DEFAULT_LIMIT: u32 = 50;
pub const MAX_LIMIT: u32 = 200;
/// Characters of messages one page carries, so a page fits an agent's
/// context and the child's reply cap whatever the chat holds.
pub const TEXT_BUDGET: usize = 60_000;

/// Input of `read_chat`.
#[derive(Debug, Clone, Deserialize, Serialize, schemars::JsonSchema)]
pub struct ReadChatInput {
    /// The chat ID, as in a copied chat reference's "Chat ID" line.
    pub chat_id: String,
    /// How many messages to skip; 0, the default, starts at the oldest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u32>,
    /// How many messages to return: 50 by default, at most 200. A page also
    /// stops early once it holds about 60,000 characters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

/// One chat as `read_chat` shows it.
#[derive(Debug, Clone, PartialEq)]
pub struct Chat {
    pub id: String,
    pub title: String,
    pub project: Option<ChatProject>,
    pub cwd: String,
    pub agent: Option<String>,
    pub status: PersistedSessionStatus,
    pub created_at: u64,
    pub last_activity_at: u64,
    /// Only messages with something to read: no thoughts, no handoff
    /// boundary rows, no empty bubbles.
    pub messages: Vec<Message>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatProject {
    pub id: String,
    /// `None` when the host's project registry does not know the id.
    pub name: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Message {
    pub role: Role,
    pub timestamp: u64,
    /// The text blocks verbatim, then one `attachment:` line per attached
    /// file or image.
    pub body: String,
    /// One `tool:` line per tool call made after this message and before
    /// the next one.
    pub tools: Vec<String>,
}

/// Names the host resolved for a chat's ids.
#[derive(Debug, Clone, Default)]
pub struct Names {
    pub project: Option<String>,
    pub agent: Option<String>,
}

/// The chat behind `metadata`, from its seq-sorted durable records.
#[must_use]
pub fn chat_from_records(
    metadata: &SessionMetadata,
    records: &[PersistedEventRecord],
    names: Names,
) -> Chat {
    let (folded, _switches) = fold_session_records(records);
    let mut messages: Vec<(u64, Message)> = folded
        .into_iter()
        .filter(|message| !message.handoff_boundary)
        .filter_map(|message| {
            let role = match message.role {
                "user" => Role::User,
                "agent" => Role::Assistant,
                _ => return None,
            };
            let body = message_body(&message.blocks);
            (!body.trim().is_empty()).then_some((
                message.seq,
                Message {
                    role,
                    timestamp: message.timestamp,
                    body,
                    tools: Vec::new(),
                },
            ))
        })
        .collect();
    for (seq, line) in tool_lines(records) {
        if let Some((_, owner)) = messages.iter_mut().rev().find(|(at, _)| *at < seq) {
            owner.tools.push(line);
        }
    }
    let project = metadata
        .project_id
        .clone()
        .filter(|id| !id.is_empty() && id != UNASSIGNED_PROJECT_ID)
        .map(|id| ChatProject {
            id,
            name: names.project,
        });
    let agent = names.agent.or_else(|| {
        metadata.stable_agent_namespace.as_deref().map(|namespace| {
            namespace
                .strip_prefix("config:")
                .unwrap_or(namespace)
                .to_string()
        })
    });
    Chat {
        id: metadata.session_id.clone(),
        title: metadata
            .title
            .clone()
            .unwrap_or_else(|| "Untitled Chat".to_string()),
        project,
        cwd: metadata.cwd.clone(),
        agent,
        status: metadata.status.clone(),
        created_at: metadata.created_at,
        last_activity_at: metadata.last_activity_at,
        messages: messages.into_iter().map(|(_, message)| message).collect(),
    }
}

/// Text blocks verbatim, attachments as `attachment:` lines; other blocks
/// carry nothing to read.
fn message_body(blocks: &[Value]) -> String {
    let mut text: Vec<&str> = Vec::new();
    let mut attachments: Vec<String> = Vec::new();
    for block in blocks {
        let field = |key: &str| block.get(key).and_then(Value::as_str);
        match field("type") {
            Some("text") => text.extend(field("text")),
            Some("resource_link") => {
                attachments.extend(field("name").or(field("uri")).map(str::to_string));
            }
            Some("resource") => attachments.extend(
                block
                    .pointer("/resource/uri")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            ),
            Some("image") => attachments.push(field("uri").unwrap_or("image").to_string()),
            _ => {}
        }
    }
    let mut body = text.join("\n");
    for attachment in attachments {
        if !body.is_empty() {
            body.push('\n');
        }
        body.push_str("  attachment: ");
        body.push_str(&attachment);
    }
    body
}

/// A tool call as its records left it.
struct ToolCall {
    seq: u64,
    kind: Option<String>,
    status: Option<String>,
    paths: Vec<String>,
    subagent: bool,
}

/// `(seq of the first record, line)` per tool call of the chat's own agent,
/// in call order. A subagent's own calls are left out; its dispatch shows.
fn tool_lines(records: &[PersistedEventRecord]) -> Vec<(u64, String)> {
    let mut calls: Vec<ToolCall> = Vec::new();
    let mut index_by_id: HashMap<String, usize> = HashMap::new();
    for record in records {
        let key = match record.type_.as_str() {
            "tool_call" => "toolCall",
            "tool_call_update" => "update",
            _ => continue,
        };
        let Some(tool) = record.payload.get(key) else {
            continue;
        };
        let Some(id) = tool.get("toolCallId").and_then(Value::as_str) else {
            continue;
        };
        let meta = tool.get("_meta");
        if meta
            .and_then(|meta| meta.pointer("/claudeCode/parentToolUseId"))
            .is_some_and(Value::is_string)
        {
            continue;
        }
        let index = match index_by_id.get(id) {
            Some(&index) => index,
            None if key == "toolCall" => {
                index_by_id.insert(id.to_string(), calls.len());
                calls.push(ToolCall {
                    seq: record.seq,
                    kind: None,
                    status: None,
                    paths: Vec::new(),
                    subagent: false,
                });
                calls.len() - 1
            }
            None => continue,
        };
        let call = &mut calls[index];
        let text = |key: &str| tool.get(key).and_then(Value::as_str).map(str::to_string);
        call.kind = text("kind").or(call.kind.take());
        call.status = text("status").or(call.status.take());
        if let Some(locations) = tool.get("locations").and_then(Value::as_array) {
            call.paths = locations
                .iter()
                .filter_map(|location| location.get("path").and_then(Value::as_str))
                .map(str::to_string)
                .collect();
        }
        call.subagent |= meta
            .and_then(|meta| meta.get(crate::acp::subagents::SUBAGENT_META_KEY))
            .is_some();
    }
    calls
        .into_iter()
        .map(|call| {
            let label = if call.subagent {
                "subagent"
            } else {
                call.kind.as_deref().unwrap_or("other")
            };
            let mut line = format!("tool: {label}");
            if !call.paths.is_empty() {
                line.push(' ');
                line.push_str(&call.paths.join(", "));
            }
            if let Some(status) = call.status {
                line.push_str(&format!(" ({status})"));
            }
            (call.seq, line)
        })
        .collect()
}

/// One rendered page and how many messages it holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Page {
    pub text: String,
    pub returned: usize,
}

/// The page of `chat` that starts `offset` messages in: the header, the
/// range line, then up to `limit` messages (clamped to 1..=200) within
/// [`TEXT_BUDGET`] characters. A first message over the budget is cut, so
/// every page makes progress.
#[must_use]
pub fn render_page(chat: &Chat, offset: Option<u32>, limit: Option<u32>) -> Page {
    let total = chat.messages.len();
    let start = (offset.unwrap_or(0) as usize).min(total);
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT) as usize;
    let mut blocks: Vec<String> = Vec::new();
    let mut used = 0;
    for (index, message) in chat.messages.iter().enumerate().skip(start).take(limit) {
        let block = render_message(index + 1, message);
        let chars = block.chars().count();
        if used + chars > TEXT_BUDGET {
            if blocks.is_empty() {
                blocks.push(truncate(&block, chars));
            }
            break;
        }
        used += chars;
        blocks.push(block);
    }
    let end = start + blocks.len();
    let mut text = header(chat);
    text.push('\n');
    text.push_str(&if total == 0 {
        "This chat has no messages.".to_string()
    } else if blocks.is_empty() {
        format!("No messages at offset {start}; the chat has {total}.")
    } else if end < total {
        format!(
            "Messages {}-{end} of {total}. More: call read_chat with offset={end}.",
            start + 1
        )
    } else {
        format!("Messages {}-{end} of {total}.", start + 1)
    });
    for block in &blocks {
        text.push_str("\n\n");
        text.push_str(block);
    }
    Page {
        text,
        returned: blocks.len(),
    }
}

fn header(chat: &Chat) -> String {
    let title = chat.title.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut lines = vec![format!("Chat: {title}"), format!("Chat ID: {}", chat.id)];
    if let Some(project) = &chat.project {
        lines.push(match &project.name {
            Some(name) => format!("Project: {name} (ID {})", project.id),
            None => format!("Project: ID {}", project.id),
        });
    }
    if !chat.cwd.is_empty() {
        lines.push(format!("Folder: {}", chat.cwd));
    }
    if let Some(agent) = &chat.agent {
        lines.push(format!("Agent: {agent}"));
    }
    let status = match chat.status {
        PersistedSessionStatus::Active => "active",
        PersistedSessionStatus::Closed => "closed",
        PersistedSessionStatus::Error => "error",
    };
    lines.push(format!(
        "Status: {status} · created {} · last activity {}",
        iso(chat.created_at),
        iso(chat.last_activity_at)
    ));
    lines.join("\n")
}

fn render_message(number: usize, message: &Message) -> String {
    let role = match message.role {
        Role::User => "user",
        Role::Assistant => "assistant",
    };
    let mut block = format!(
        "[{number}] {role} · {}\n{}",
        iso(message.timestamp),
        message.body
    );
    for tool in &message.tools {
        block.push_str("\n  ");
        block.push_str(tool);
    }
    block
}

/// `block` cut to fit [`TEXT_BUDGET`] with the marker included.
fn truncate(block: &str, chars: usize) -> String {
    let marker_room = 40;
    let kept = TEXT_BUDGET - marker_room;
    let cut = block
        .char_indices()
        .nth(kept)
        .map_or(block.len(), |(index, _)| index);
    format!("{}\n[truncated {} chars]", &block[..cut], chars - kept)
}

fn iso(millis: u64) -> String {
    i64::try_from(millis)
        .ok()
        .and_then(DateTime::from_timestamp_millis)
        .map_or_else(
            || millis.to_string(),
            |time| time.to_rfc3339_opts(SecondsFormat::Secs, true),
        )
}
