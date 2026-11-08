//! `ReadChat` frames: any chat on this host, in any project, rendered by
//! `host_mcp::read_chat`. Logs carry redacted ids and counts, never titles
//! or message text.

use std::sync::Arc;

use serde_json::Value;

use super::HostPlanServer;
use crate::acp::host_mcp::read_chat::{
    chat_from_records, render_page, switch_link, Message, Names, ReadChatInput, Role,
};
use crate::acp::host_mcp::FrameReply;
use crate::acp::session_persistence::{
    PersistedEventRecord, SessionMetadata, SessionPersistence, SessionPersistenceError,
};
use crate::logging::redact_session_id;

/// How many agent-switch links one read follows before it stops, so a
/// corrupt chain cannot replay every session on the host.
const MAX_LINKED_SEGMENTS: usize = 20;

impl HostPlanServer {
    pub(super) async fn read_chat(
        &self,
        caller_session_id: &str,
        input: Option<ReadChatInput>,
    ) -> FrameReply {
        let caller = redact_session_id(caller_session_id);
        let Some(input) = input else {
            return FrameReply::err("a read_chat frame needs a chat_id");
        };
        let target = redact_session_id(&input.chat_id);
        let Some(persistence) = self.persistence.as_ref() else {
            log::warn!("[host-mcp] read_chat by session {caller} of chat {target} refused: no chat history");
            return FrameReply::err("chat history is not available on this Troupe host");
        };
        match load(persistence, &input.chat_id).await {
            Ok(first) => {
                // A chat that switched agents continues in the linked
                // session; pull every segment before folding so the page does
                // not stop at the switch. A chain that cannot be fully read
                // is noted on the transcript rather than passed off as whole.
                // Each segment after the first carries the switch record's
                // time so the boundary line shows when the handoff happened.
                let mut segments = vec![(0, first)];
                let mut visited: std::collections::HashSet<String> =
                    [input.chat_id.clone()].into_iter().collect();
                let mut continuation: Option<String> = None;
                while segments.len() < MAX_LINKED_SEGMENTS {
                    let Some((linked, switch_at)) =
                        switch_link(&segments.last().expect("non-empty").1.records)
                            .filter(|(id, _)| !visited.contains(id))
                    else {
                        break;
                    };
                    visited.insert(linked.clone());
                    match load(persistence, &linked).await {
                        Ok(segment) => segments.push((switch_at, segment)),
                        Err(error) => {
                            log::warn!(
                                "[host-mcp] read_chat by session {caller} of chat {target}: linked chat {} unreadable: {error}",
                                redact_session_id(&linked)
                            );
                            continuation = Some(format!(
                                "the chat continues in linked chat {linked}, which could not be read; retry or call read_chat with chat_id {linked}"
                            ));
                            break;
                        }
                    }
                }
                if continuation.is_none() {
                    if let Some((next, _)) =
                        switch_link(&segments.last().expect("non-empty").1.records)
                            .filter(|(id, _)| !visited.contains(id))
                    {
                        continuation = Some(format!(
                            "the chat's agent-switch chain exceeds {MAX_LINKED_SEGMENTS} chats; continue from chat {next} with read_chat"
                        ));
                    }
                }
                // The fold and render are pure CPU; keep them off the
                // listener's single-thread runtime so other sessions' frames
                // are not starved by a long chat.
                let chat = match tokio::task::spawn_blocking(move || {
                    let registry = crate::web::project_registry::installed();
                    let mut iter = segments.into_iter();
                    let (_, first) = iter.next().expect("one segment");
                    let mut stale = first.stale;
                    let mut chat = chat_from_records(
                        &first.metadata,
                        &first.records,
                        names(&first.metadata, registry.as_deref()),
                    );
                    let mut previous_agent = chat.agent.clone();
                    for (switch_at, segment) in iter {
                        let linked = chat_from_records(
                            &segment.metadata,
                            &segment.records,
                            names(&segment.metadata, registry.as_deref()),
                        );
                        // A boundary line between segments so messages past a
                        // switch are not attributed to the chat's first agent.
                        chat.messages.push(Message {
                            role: Role::Assistant,
                            timestamp: switch_at,
                            body: format!(
                                "--- agent switch: {} → {} (chat {}) ---",
                                previous_agent.as_deref().unwrap_or("unknown agent"),
                                linked.agent.as_deref().unwrap_or("unknown agent"),
                                linked.id
                            ),
                            tools: Vec::new(),
                        });
                        // The live end describes the chat now: status,
                        // activity and agent come from the last segment while
                        // identity stays the original chat's.
                        chat.status = linked.status.clone();
                        chat.last_activity_at = linked.last_activity_at;
                        chat.agent = linked.agent.clone();
                        previous_agent = linked.agent;
                        chat.messages.extend(linked.messages);
                        stale |= segment.stale;
                    }
                    if stale {
                        chat.notes.push(
                            "recent messages may be missing: the chat's writer could not flush its queue"
                                .to_string(),
                        );
                    }
                    if let Some(continuation) = continuation {
                        chat.notes.push(continuation);
                    }
                    chat
                })
                .await
                {
                    Ok(chat) => chat,
                    Err(error) => {
                        log::warn!(
                            "[host-mcp] read_chat by session {caller} of chat {target} failed: {error}"
                        );
                        return FrameReply::err("could not read that chat's history");
                    }
                };
                let page = render_page(&chat, input.offset, input.limit);
                log::info!(
                    "[host-mcp] read_chat by session {caller} of chat {target}: {} of {} messages",
                    page.returned,
                    chat.messages.len()
                );
                FrameReply::ok_with(Value::String(page.text))
            }
            Err(SessionPersistenceError::SessionNotFound) => {
                log::info!("[host-mcp] read_chat by session {caller} of chat {target}: not found");
                FrameReply::err(format!(
                    "No chat with ID {} on this Troupe host.",
                    input.chat_id
                ))
            }
            Err(error) => {
                log::warn!(
                    "[host-mcp] read_chat by session {caller} of chat {target} failed: {error}"
                );
                FrameReply::err("could not read that chat's history")
            }
        }
    }
}

/// One readable segment: the chat's metadata and every durable record, plus
/// whether the durable tail may lag the live session.
struct Loaded {
    metadata: SessionMetadata,
    records: Vec<PersistedEventRecord>,
    /// `true` when the writer could not flush its queue — replay then works
    /// but can end before the session's newest records.
    stale: bool,
}

/// The chat's metadata and every durable record, after the writer flushed
/// what it had queued. A failed data flush leaves the tail potentially stale
/// (`stale`); a failed index write does not — durable records are already
/// complete and must not block reading a finalized chat.
async fn load(
    persistence: &Arc<SessionPersistence>,
    chat_id: &str,
) -> Result<Loaded, SessionPersistenceError> {
    let stale = match persistence.flush_session(chat_id).await {
        Ok(()) => false,
        Err(
            error @ (SessionPersistenceError::PersistenceUnhealthy(_)
            | SessionPersistenceError::WriterStopped),
        ) => {
            log::warn!(
                "[host-mcp] read_chat flush of chat {} failed, durable records may lag: {error}",
                redact_session_id(chat_id)
            );
            true
        }
        Err(error) => {
            log::warn!(
                "[host-mcp] read_chat flush of chat {} failed, reading durable state: {error}",
                redact_session_id(chat_id)
            );
            false
        }
    };
    let metadata = persistence.metadata(chat_id)?;
    let records = persistence
        .replay_after_async(chat_id.to_string(), 0)
        .await?;
    Ok(Loaded {
        metadata,
        records,
        stale,
    })
}

/// The project's name from `registry` and the agent's name from the agents
/// this host has launched, when either knows the id.
pub(super) fn names(
    metadata: &SessionMetadata,
    registry: Option<&crate::web::project_registry::ProjectRegistry>,
) -> Names {
    let project = metadata.project_id.as_deref().and_then(|id| {
        registry?.get(id).map(|project| project.name)
    });
    let agent = metadata
        .stable_agent_namespace
        .as_deref()
        .and_then(|namespace| namespace.strip_prefix("config:"))
        .and_then(|config_id| {
            crate::automation::service::installed()?
                .engine()
                .agents()
                .resolve(config_id)
                .map(|config| config.name)
        });
    Names { project, agent }
}
