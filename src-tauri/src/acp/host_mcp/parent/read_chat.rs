//! `ReadChat` frames: any chat on this host, in any project, rendered by
//! `host_mcp::read_chat`. Logs carry redacted ids and counts, never titles
//! or message text.

use std::sync::Arc;

use serde_json::Value;

use super::HostPlanServer;
use crate::acp::host_mcp::read_chat::{
    chat_from_records, render_page, switch_target, Names, ReadChatInput,
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
                // not stop at the switch.
                let mut segments = vec![first];
                let mut visited: std::collections::HashSet<String> =
                    [input.chat_id.clone()].into_iter().collect();
                while segments.len() < MAX_LINKED_SEGMENTS {
                    let Some(linked) = switch_target(&segments.last().expect("non-empty").1)
                        .filter(|id| !visited.contains(id))
                    else {
                        break;
                    };
                    visited.insert(linked.clone());
                    match load(persistence, &linked).await {
                        Ok(segment) => segments.push(segment),
                        Err(error) => {
                            log::warn!(
                                "[host-mcp] read_chat by session {caller} of chat {target}: linked chat {} unreadable: {error}",
                                redact_session_id(&linked)
                            );
                            break;
                        }
                    }
                }
                // The fold and render are pure CPU; keep them off the
                // listener's single-thread runtime so other sessions' frames
                // are not starved by a long chat.
                let chat = match tokio::task::spawn_blocking(move || {
                    let registry = crate::web::project_registry::installed();
                    let mut iter = segments.into_iter();
                    let (metadata, records) = iter.next().expect("one segment");
                    let mut chat =
                        chat_from_records(&metadata, &records, names(&metadata, registry.as_deref()));
                    for (metadata, records) in iter {
                        let segment = chat_from_records(
                            &metadata,
                            &records,
                            names(&metadata, registry.as_deref()),
                        );
                        chat.messages.extend(segment.messages);
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

/// The chat's metadata and every durable record, after the writer flushed
/// what it had queued. A failed flush only leaves the tail one batch stale —
/// index persistence rides along in it and must not block reading a
/// finalized chat.
async fn load(
    persistence: &Arc<SessionPersistence>,
    chat_id: &str,
) -> Result<(SessionMetadata, Vec<PersistedEventRecord>), SessionPersistenceError> {
    if let Err(error) = persistence.flush_session(chat_id).await {
        log::warn!(
            "[host-mcp] read_chat flush of chat {} failed, reading durable state: {error}",
            redact_session_id(chat_id)
        );
    }
    let metadata = persistence.metadata(chat_id)?;
    let records = persistence
        .replay_after_async(chat_id.to_string(), 0)
        .await?;
    Ok((metadata, records))
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
