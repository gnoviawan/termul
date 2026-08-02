//! ACP `Client`-role behavior: capability advertisement, inbound request
//! handling (permission, filesystem), session-update fan-out, and terminal
//! stubs.
//!
//! In `agent-client-protocol` 0.12 there is no `Client` *trait* to implement;
//! instead the client role is expressed by registering handler closures on a
//! `Client.builder()` and driving it via `connect_with`. The functions here are
//! the reusable bodies those closures call, kept separate from the connection
//! wiring in `manager.rs` so they can be unit-tested in isolation.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use agent_client_protocol as acp;
use agent_client_protocol::schema::v1::{
    ClientCapabilities, FileSystemCapabilities, Meta, ReadTextFileRequest, ReadTextFileResponse,
    SessionNotification, SessionUpdate, WriteTextFileRequest, WriteTextFileResponse,
};

use crate::acp::config::AgentId;
use crate::acp::events::{
    self, ChunkRole, CommandsUpdateEvent, ConfigOptionsUpdateEvent, MessageChunkEvent,
    ModeUpdateEvent, PlanUpdateEvent, SessionInfoUpdateEvent, ToolCallEvent, ToolCallUpdateEvent,
    UsageCostEvent, UsageUpdateEvent,
};
use crate::web::EventSink;

/// Cursor ACP extension: when present on `clientCapabilities._meta`, Cursor
/// exposes Fast / thought-level as separate session `configOptions` instead of
/// collapsing each model to a single default variant.
///
/// Not part of the ACP spec; advertised via the standard `_meta` extensibility
/// hook. Unknown agents ignore unrecognized `_meta` keys.
const PARAMETERIZED_MODEL_PICKER_META_KEY: &str = "parameterizedModelPicker";

/// Build the client capabilities advertised to the agent during `initialize`.
///
/// We always advertise `fs.readTextFile` and `fs.writeTextFile`. The `terminal`
/// capability is advertised ONLY when the agent's config opted in
/// (`allow_terminal`). Terminal access is arbitrary command execution, so it is
/// off by default (M6) and enabled per trusted agent.
///
/// Always advertise Cursor's `parameterizedModelPicker` `_meta` flag so Cursor
/// ACP sessions can surface Fast / reasoning controls through standard
/// `configOptions`. Harmless for agents that ignore unknown `_meta` keys.
#[must_use]
pub fn client_capabilities(allow_terminal: bool) -> ClientCapabilities {
    let meta = Meta::from_iter([(
        PARAMETERIZED_MODEL_PICKER_META_KEY.into(),
        serde_json::Value::Bool(true),
    )]);
    ClientCapabilities::new()
        .fs(FileSystemCapabilities::new()
            .read_text_file(true)
            .write_text_file(true))
        .terminal(allow_terminal)
        .meta(meta)
}

/// Resolve an agent-supplied absolute path, rejecting lexical `..` traversal
/// and canonicalizing for symlink resolution.
///
/// The project-root prefix-containment check that previously lived here was
/// removed by explicit decision (spec-remove-web-fs-path-jail) so that any
/// absolute path the agent requests is resolved and served. The retained
/// guards are: `..`-component rejection (defense-in-depth) and path
/// canonicalization / ancestor-walking (symlink resolution). When `root` is
/// `None` the absolute path is resolved directly (no longer denied). `root`
/// remains in the signature as the session `cwd` for future relative-path
/// resolution; it is not used for containment.
async fn scope_to_workspace(
    requested: &Path,
    _root: Option<&Path>,
) -> Result<PathBuf, acp::Error> {
    if !requested.is_absolute() {
        return Err(acp::Error::invalid_params()
            .data(format!("path must be absolute: {}", requested.display())));
    }

    // Lexical `..` can escape regardless of symlinks; reject early.
    if requested
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err(acp::Error::invalid_params().data(format!(
            "path must not contain '..': {}",
            requested.display()
        )));
    }

    // Walk up to the longest existing ancestor and canonicalize it (resolving
    // any symlinks). The (possibly not-yet-existing) suffix cannot escape
    // because we already rejected `..` components.
    //
    // NOTE: a residual TOCTOU window exists between this check and the caller's
    // I/O (a concurrent symlink swap could redirect the resolved path). Fully
    // closing it requires descriptor-relative `openat`/cap-std I/O, which is a
    // larger change deferred intentionally.
    let mut ancestor = requested;
    loop {
        match tokio::fs::canonicalize(ancestor).await {
            Ok(_) => break,
            Err(_) => match ancestor.parent() {
                Some(parent) if parent != ancestor => ancestor = parent,
                _ => {
                    return Err(acp::Error::invalid_params().data(format!(
                        "path cannot be resolved: {}",
                        requested.display()
                    )));
                }
            },
        }
    }

    Ok(requested.to_path_buf())
}

/// Handle an inbound `fs/read_text_file` request from the agent.
///
/// Resolves the request path (rejecting `..`, canonicalizing for symlink
/// resolution), honors the optional 1-based `line` start and `limit` line
/// count, and preserves the file's original line terminators when slicing.
/// Returns an ACP error for relative paths, `..` traversal, or filesystem
/// failures.
pub async fn handle_read_text_file(
    req: &ReadTextFileRequest,
    root: Option<&Path>,
) -> Result<ReadTextFileResponse, acp::Error> {
    let path = scope_to_workspace(&req.path, root).await?;

    let contents = tokio::fs::read_to_string(&path).await.map_err(|e| {
        acp::util::internal_error(format!("failed to read {}: {e}", path.display()))
    })?;

    // Fast path: no slicing requested.
    if req.line.is_none() && req.limit.is_none() {
        return Ok(ReadTextFileResponse::new(contents));
    }

    // Slice byte-faithfully: `split_inclusive('\n')` keeps each line's original
    // terminator (including `\r\n`) and any trailing newline, so a downstream
    // read-modify-write does not normalize CRLF or drop the final newline.
    let start = req.line.unwrap_or(1).max(1) as usize - 1;
    let pieces = contents.split_inclusive('\n');
    let selected: String = match req.limit {
        Some(limit) => pieces.skip(start).take(limit as usize).collect(),
        None => pieces.skip(start).collect(),
    };

    Ok(ReadTextFileResponse::new(selected))
}

/// Handle an inbound `fs/write_text_file` request from the agent.
///
/// Resolves the request path (rejecting `..`, canonicalizing for symlink
/// resolution) and creates parent directories as needed. Returns an ACP
/// error for relative paths, `..` traversal, or filesystem failures.
pub async fn handle_write_text_file(
    req: &WriteTextFileRequest,
    root: Option<&Path>,
) -> Result<WriteTextFileResponse, acp::Error> {
    let path = scope_to_workspace(&req.path, root).await?;

    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| {
                acp::util::internal_error(format!(
                    "failed to create directory {}: {e}",
                    parent.display()
                ))
            })?;
        }
    }

    tokio::fs::write(&path, &req.content).await.map_err(|e| {
        acp::util::internal_error(format!("failed to write {}: {e}", path.display()))
    })?;

    Ok(WriteTextFileResponse::new())
}

/// Translate an inbound `session/update` notification into the matching
/// `acp:*` event and fan it out through the dispatcher's sinks.
///
/// Unknown / unhandled update variants are ignored (the enum is
/// `#[non_exhaustive]`, so a catch-all is required).
///
/// Every event here is session-scoped, so `sid` is `Some(session_id)`. The
/// payload struct is built first and then borrowed, so `session_id` moves into
/// the struct once and the `sid` borrows from it — no extra clone, no borrow
/// conflict (serialize-once-fan-out-N is preserved by [`events::fan_out`]).
pub fn emit_session_update(
    sinks: &[Arc<dyn EventSink>],
    agent_id: &AgentId,
    notification: SessionNotification,
) {
    let session_id = crate::acp::config::SessionId::from(notification.session_id);

    match notification.update {
        SessionUpdate::UserMessageChunk(chunk) => {
            let event = MessageChunkEvent {
                agent_id: agent_id.clone(),
                session_id,
                role: ChunkRole::User,
                content: chunk.content,
            };
            events::fan_out(sinks, Some(event.session_id.0.as_str()), events::EVENT_MESSAGE_CHUNK, &event);
        }
        SessionUpdate::AgentMessageChunk(chunk) => {
            let preview = match &chunk.content {
                agent_client_protocol::schema::v1::ContentBlock::Text(text) => {
                    let t: &str = text.text.as_ref();
                    if t.chars().count() > 40 {
                        let truncated: String = t.chars().take(40).collect();
                        format!("{truncated}…")
                    } else {
                        t.to_string()
                    }
                }
                other => format!("{other:?}"),
            };
            log::debug!(
                "[acp] agent {agent_id} session {} agent_message_chunk: {preview}",
                session_id.0
            );
            let event = MessageChunkEvent {
                agent_id: agent_id.clone(),
                session_id,
                role: ChunkRole::Agent,
                content: chunk.content,
            };
            events::fan_out(sinks, Some(event.session_id.0.as_str()), events::EVENT_MESSAGE_CHUNK, &event);
        }
        SessionUpdate::AgentThoughtChunk(chunk) => {
            let event = MessageChunkEvent {
                agent_id: agent_id.clone(),
                session_id,
                role: ChunkRole::Thought,
                content: chunk.content,
            };
            events::fan_out(sinks, Some(event.session_id.0.as_str()), events::EVENT_MESSAGE_CHUNK, &event);
        }
        SessionUpdate::ToolCall(tool_call) => {
            let event = ToolCallEvent {
                agent_id: agent_id.clone(),
                session_id,
                tool_call,
            };
            events::fan_out(sinks, Some(event.session_id.0.as_str()), events::EVENT_TOOL_CALL, &event);
        }
        SessionUpdate::ToolCallUpdate(update) => {
            let event = ToolCallUpdateEvent {
                agent_id: agent_id.clone(),
                session_id,
                update,
            };
            events::fan_out(sinks, Some(event.session_id.0.as_str()), events::EVENT_TOOL_CALL_UPDATE, &event);
        }
        SessionUpdate::Plan(plan) => {
            // ACP agent-plan: each update is a full replace; forward verbatim.
            // https://agentclientprotocol.com/protocol/v1/agent-plan
            let event = PlanUpdateEvent {
                agent_id: agent_id.clone(),
                session_id,
                plan,
            };
            events::fan_out(sinks, Some(event.session_id.0.as_str()), events::EVENT_PLAN_UPDATE, &event);
        }
        SessionUpdate::AvailableCommandsUpdate(update) => {
            let event = CommandsUpdateEvent {
                agent_id: agent_id.clone(),
                session_id,
                available_commands: update.available_commands,
            };
            events::fan_out(sinks, Some(event.session_id.0.as_str()), events::EVENT_COMMANDS_UPDATE, &event);
        }
        SessionUpdate::CurrentModeUpdate(update) => {
            let event = ModeUpdateEvent {
                agent_id: agent_id.clone(),
                session_id,
                current_mode_id: update.current_mode_id,
                available_modes: Vec::new(),
            };
            events::fan_out(sinks, Some(event.session_id.0.as_str()), events::EVENT_MODE_UPDATE, &event);
        }
        SessionUpdate::ConfigOptionUpdate(update) => {
            let event = ConfigOptionsUpdateEvent {
                agent_id: agent_id.clone(),
                session_id,
                config_options: update.config_options,
            };
            events::fan_out(sinks, Some(event.session_id.0.as_str()), events::EVENT_CONFIG_OPTIONS_UPDATE, &event);
        }
        SessionUpdate::SessionInfoUpdate(update) => {
            // `title` is `MaybeUndefined<String>`: Undefined = not sent (skip),
            // Null = explicitly cleared (emit None), Value = set (emit Some).
            match update.title.as_opt_ref() {
                None => {} // Undefined — no title field sent, skip
                Some(None) => {
                    let event = SessionInfoUpdateEvent {
                        agent_id: agent_id.clone(),
                        session_id,
                        title: None,
                    };
                    events::fan_out(sinks, Some(event.session_id.0.as_str()), events::EVENT_SESSION_INFO_UPDATE, &event);
                }
                Some(Some(t)) => {
                    let event = SessionInfoUpdateEvent {
                        agent_id: agent_id.clone(),
                        session_id,
                        title: Some(t.clone()),
                    };
                    events::fan_out(sinks, Some(event.session_id.0.as_str()), events::EVENT_SESSION_INFO_UPDATE, &event);
                }
            }
        }
        SessionUpdate::UsageUpdate(update) => {
            let cost = update.cost.map(|c| UsageCostEvent {
                amount: c.amount,
                currency: c.currency,
            });
            let event = UsageUpdateEvent {
                agent_id: agent_id.clone(),
                session_id,
                used: update.used,
                size: update.size,
                cost,
            };
            events::fan_out(sinks, Some(event.session_id.0.as_str()), events::EVENT_USAGE_UPDATE, &event);
        }
        // Any future (non_exhaustive) variants have no dedicated event;
        // ignore them — but log so a silently-dropped update can be diagnosed
        // instead of vanishing.
        ref other => {
            log::debug!(
                "[acp] agent {agent_id} sent an unhandled session/update variant: {other:?}"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_capabilities_advertise_fs_and_gate_terminal() {
        let caps = client_capabilities(true);
        assert!(caps.fs.read_text_file);
        assert!(caps.fs.write_text_file);
        assert!(caps.terminal);
        // Default-deny: terminal is omitted unless the agent opted in.
        let denied = client_capabilities(false);
        assert!(denied.fs.read_text_file);
        assert!(!denied.terminal);
    }

    #[test]
    fn client_capabilities_advertise_parameterized_model_picker_meta() {
        let caps = client_capabilities(false);
        let meta = caps.meta.expect("expected client capabilities _meta");
        assert_eq!(
            meta.get(PARAMETERIZED_MODEL_PICKER_META_KEY),
            Some(&serde_json::Value::Bool(true))
        );
    }

    #[tokio::test]
    async fn read_text_file_rejects_relative_path() {
        let req = ReadTextFileRequest::new("sess", "relative/path.txt");
        let root = std::env::temp_dir();
        let err = handle_read_text_file(&req, Some(root.as_path()))
            .await
            .unwrap_err();
        assert_eq!(err.code, acp::ErrorCode::InvalidParams);
    }

    #[tokio::test]
    async fn read_without_workspace_root_succeeds() {
        // An absolute path with no associated session root is now resolved
        // directly (no longer denied — the containment jail was removed by
        // spec-remove-web-fs-path-jail).
        let dir = std::env::temp_dir().join(format!("acp-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("file.txt");
        std::fs::write(&path, "secret").unwrap();

        let req = ReadTextFileRequest::new("sess", &path);
        let resp = handle_read_text_file(&req, None).await.unwrap();
        assert_eq!(resp.content, "secret");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn read_outside_workspace_is_allowed() {
        // A direct absolute path outside the workspace root is now allowed
        // (the containment jail was removed by spec-remove-web-fs-path-jail).
        let base = std::env::temp_dir().join(format!("acp-test-{}", uuid::Uuid::new_v4()));
        let workspace = base.join("workspace");
        let outside = base.join("outside");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let secret = outside.join("secret.txt");
        std::fs::write(&secret, "top secret").unwrap();

        let req = ReadTextFileRequest::new("sess", &secret);
        let resp = handle_read_text_file(&req, Some(workspace.as_path()))
            .await
            .unwrap();
        assert_eq!(resp.content, "top secret");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn read_rejects_traversal_sequence_in_path() {
        // `..` traversal is still rejected even though containment is removed.
        let base = std::env::temp_dir().join(format!("acp-test-{}", uuid::Uuid::new_v4()));
        let workspace = base.join("workspace");
        let outside = base.join("outside");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let secret = outside.join("secret.txt");
        std::fs::write(&secret, "top secret").unwrap();

        let escape = workspace.join("..").join("outside").join("secret.txt");
        let req = ReadTextFileRequest::new("sess", &escape);
        let err = handle_read_text_file(&req, Some(workspace.as_path()))
            .await
            .unwrap_err();
        assert_eq!(err.code, acp::ErrorCode::InvalidParams);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn write_outside_workspace_is_allowed() {
        // A write to a path outside the workspace root is now allowed (the
        // containment jail was removed by spec-remove-web-fs-path-jail).
        let base = std::env::temp_dir().join(format!("acp-test-{}", uuid::Uuid::new_v4()));
        let workspace = base.join("workspace");
        let outside = base.join("outside");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&outside).unwrap();

        let target = outside.join("evil.txt");
        let req = WriteTextFileRequest::new("sess", &target, "pwned");
        handle_write_text_file(&req, Some(workspace.as_path()))
            .await
            .unwrap();
        assert!(target.exists(), "write outside workspace must succeed");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "pwned");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn write_then_read_roundtrips() {
        let workspace = std::env::temp_dir().join(format!("acp-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&workspace).unwrap();
        let path = workspace.join("nested").join("file.txt");

        let write_req = WriteTextFileRequest::new("sess", &path, "line1\nline2\nline3");
        handle_write_text_file(&write_req, Some(workspace.as_path()))
            .await
            .unwrap();

        let read_req = ReadTextFileRequest::new("sess", &path);
        let resp = handle_read_text_file(&read_req, Some(workspace.as_path()))
            .await
            .unwrap();
        assert_eq!(resp.content, "line1\nline2\nline3");

        // line/limit slicing: start at line 2, take 1 line.
        let sliced = ReadTextFileRequest::new("sess", &path)
            .line(2u32)
            .limit(1u32);
        let resp = handle_read_text_file(&sliced, Some(workspace.as_path()))
            .await
            .unwrap();
        // Slicing preserves the original terminator on the sliced line.
        assert_eq!(resp.content, "line2\n");

        let _ = std::fs::remove_dir_all(&workspace);
    }

    #[tokio::test]
    async fn slicing_preserves_crlf_and_trailing_newline() {
        let workspace = std::env::temp_dir().join(format!("acp-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&workspace).unwrap();
        let path = workspace.join("crlf.txt");

        // CRLF file ending in a trailing newline.
        std::fs::write(&path, "a\r\nb\r\nc\r\n").unwrap();

        // Take all three lines starting at line 1: must be byte-identical.
        let req = ReadTextFileRequest::new("sess", &path).line(1u32).limit(3u32);
        let resp = handle_read_text_file(&req, Some(workspace.as_path()))
            .await
            .unwrap();
        assert_eq!(resp.content, "a\r\nb\r\nc\r\n");

        // Take the middle line: keep its CRLF terminator.
        let req = ReadTextFileRequest::new("sess", &path).line(2u32).limit(1u32);
        let resp = handle_read_text_file(&req, Some(workspace.as_path()))
            .await
            .unwrap();
        assert_eq!(resp.content, "b\r\n");

        let _ = std::fs::remove_dir_all(&workspace);
    }
}
