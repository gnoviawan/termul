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

use agent_client_protocol as acp;
use agent_client_protocol::schema::{
    ClientCapabilities, FileSystemCapabilities, ReadTextFileRequest, ReadTextFileResponse,
    SessionNotification, SessionUpdate, WriteTextFileRequest, WriteTextFileResponse,
};
use tauri::AppHandle;

use crate::acp::config::AgentId;
use crate::acp::events::{
    self, ChunkRole, CommandsUpdateEvent, ConfigOptionsUpdateEvent, MessageChunkEvent,
    ModeUpdateEvent, PlanUpdateEvent, ToolCallEvent, ToolCallUpdateEvent,
};

/// Build the client capabilities advertised to the agent during `initialize`.
///
/// We always advertise `fs.readTextFile` and `fs.writeTextFile`. The `terminal`
/// capability is advertised ONLY when the agent's config opted in
/// (`allow_terminal`). Terminal access is arbitrary command execution, so it is
/// off by default (M6) and enabled per trusted agent.
#[must_use]
pub fn client_capabilities(allow_terminal: bool) -> ClientCapabilities {
    ClientCapabilities::new()
        .fs(FileSystemCapabilities::new()
            .read_text_file(true)
            .write_text_file(true))
        .terminal(allow_terminal)
}

/// Resolve an agent-supplied absolute path against a session's workspace root,
/// rejecting anything that escapes the root.
///
/// Defeats both lexical `..` traversal (rejected outright) and symlink
/// traversal (the longest existing ancestor is canonicalized and must remain
/// within the canonicalized root). Returns the original requested path on
/// success; the caller performs the actual read/write on it.
///
/// `root` is the session `cwd`. When it is `None` (session unknown / not yet
/// scoped) the request is rejected — we never service an unscoped fs request.
async fn scope_to_workspace(
    requested: &Path,
    root: Option<&Path>,
) -> Result<PathBuf, acp::Error> {
    if !requested.is_absolute() {
        return Err(acp::Error::invalid_params()
            .data(format!("path must be absolute: {}", requested.display())));
    }

    let Some(root) = root else {
        return Err(acp::Error::invalid_params()
            .data("no workspace is associated with this session; fs access denied"));
    };

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

    let canon_root = tokio::fs::canonicalize(root).await.map_err(|e| {
        acp::util::internal_error(format!(
            "failed to resolve workspace root {}: {e}",
            root.display()
        ))
    })?;

    // Walk up to the longest existing ancestor and canonicalize it (resolving
    // any symlinks). The (possibly not-yet-existing) suffix cannot escape
    // because we already rejected `..` components.
    //
    // NOTE: a residual TOCTOU window exists between this check and the caller's
    // I/O (a concurrent symlink swap could redirect the resolved path). Fully
    // closing it requires descriptor-relative `openat`/cap-std I/O, which is a
    // larger change deferred intentionally: this is a local desktop trust
    // boundary already gated by the per-agent `terminal`/fs capability and the
    // `..`-reject + canonicalize+starts_with checks here, so the marginal risk
    // does not justify a cap-std migration in this pass.
    let mut ancestor = requested;
    loop {
        match tokio::fs::canonicalize(ancestor).await {
            Ok(canon) => {
                if !canon.starts_with(&canon_root) {
                    return Err(acp::Error::invalid_params().data(format!(
                        "path escapes the session workspace: {}",
                        requested.display()
                    )));
                }
                break;
            }
            Err(_) => match ancestor.parent() {
                Some(parent) if parent != ancestor => ancestor = parent,
                _ => {
                    return Err(acp::Error::invalid_params().data(format!(
                        "path escapes the session workspace: {}",
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
/// Scopes the read to the session workspace `root`, honors the optional 1-based
/// `line` start and `limit` line count, and preserves the file's original line
/// terminators when slicing. Returns an ACP error for relative paths, paths
/// that escape the workspace, or filesystem failures.
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
/// Scopes the write to the session workspace `root` and creates parent
/// directories as needed. Returns an ACP error for relative paths, paths that
/// escape the workspace, or filesystem failures.
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
/// `acp:*` Tauri event and emit it.
///
/// Unknown / unhandled update variants are ignored (the enum is
/// `#[non_exhaustive]`, so a catch-all is required).
pub fn emit_session_update(app: &AppHandle, agent_id: &AgentId, notification: SessionNotification) {
    let session_id = crate::acp::config::SessionId::from(notification.session_id);

    match notification.update {
        SessionUpdate::UserMessageChunk(chunk) => events::emit(
            app,
            events::EVENT_MESSAGE_CHUNK,
            MessageChunkEvent {
                agent_id: agent_id.clone(),
                session_id,
                role: ChunkRole::User,
                content: chunk.content,
            },
        ),
        SessionUpdate::AgentMessageChunk(chunk) => events::emit(
            app,
            events::EVENT_MESSAGE_CHUNK,
            MessageChunkEvent {
                agent_id: agent_id.clone(),
                session_id,
                role: ChunkRole::Agent,
                content: chunk.content,
            },
        ),
        SessionUpdate::AgentThoughtChunk(chunk) => events::emit(
            app,
            events::EVENT_MESSAGE_CHUNK,
            MessageChunkEvent {
                agent_id: agent_id.clone(),
                session_id,
                role: ChunkRole::Thought,
                content: chunk.content,
            },
        ),
        SessionUpdate::ToolCall(tool_call) => events::emit(
            app,
            events::EVENT_TOOL_CALL,
            ToolCallEvent {
                agent_id: agent_id.clone(),
                session_id,
                tool_call,
            },
        ),
        SessionUpdate::ToolCallUpdate(update) => events::emit(
            app,
            events::EVENT_TOOL_CALL_UPDATE,
            ToolCallUpdateEvent {
                agent_id: agent_id.clone(),
                session_id,
                update,
            },
        ),
        SessionUpdate::Plan(plan) => events::emit(
            app,
            events::EVENT_PLAN_UPDATE,
            PlanUpdateEvent {
                agent_id: agent_id.clone(),
                session_id,
                plan,
            },
        ),
        SessionUpdate::AvailableCommandsUpdate(update) => events::emit(
            app,
            events::EVENT_COMMANDS_UPDATE,
            CommandsUpdateEvent {
                agent_id: agent_id.clone(),
                session_id,
                available_commands: update.available_commands,
            },
        ),
        SessionUpdate::CurrentModeUpdate(update) => events::emit(
            app,
            events::EVENT_MODE_UPDATE,
            ModeUpdateEvent {
                agent_id: agent_id.clone(),
                session_id,
                current_mode_id: update.current_mode_id,
                available_modes: Vec::new(),
            },
        ),
        SessionUpdate::ConfigOptionUpdate(update) => events::emit(
            app,
            events::EVENT_CONFIG_OPTIONS_UPDATE,
            ConfigOptionsUpdateEvent {
                agent_id: agent_id.clone(),
                session_id,
                config_options: update.config_options,
            },
        ),
        // SessionInfoUpdate and any future (non_exhaustive) variants have no
        // dedicated P0 event; ignore them.
        _ => {}
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
    async fn read_without_workspace_root_is_denied() {
        // An absolute path with no associated session root must be rejected.
        let dir = std::env::temp_dir().join(format!("acp-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("file.txt");
        std::fs::write(&path, "secret").unwrap();

        let req = ReadTextFileRequest::new("sess", &path);
        let err = handle_read_text_file(&req, None).await.unwrap_err();
        assert_eq!(err.code, acp::ErrorCode::InvalidParams);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn read_outside_workspace_is_rejected() {
        // Two sibling dirs: workspace and a secret dir outside it.
        let base = std::env::temp_dir().join(format!("acp-test-{}", uuid::Uuid::new_v4()));
        let workspace = base.join("workspace");
        let outside = base.join("outside");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let secret = outside.join("secret.txt");
        std::fs::write(&secret, "top secret").unwrap();

        // Direct absolute path outside the workspace root.
        let req = ReadTextFileRequest::new("sess", &secret);
        let err = handle_read_text_file(&req, Some(workspace.as_path()))
            .await
            .unwrap_err();
        assert_eq!(err.code, acp::ErrorCode::InvalidParams);

        // `..` traversal out of the workspace is also rejected.
        let escape = workspace.join("..").join("outside").join("secret.txt");
        let req = ReadTextFileRequest::new("sess", &escape);
        let err = handle_read_text_file(&req, Some(workspace.as_path()))
            .await
            .unwrap_err();
        assert_eq!(err.code, acp::ErrorCode::InvalidParams);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn write_outside_workspace_is_rejected() {
        let base = std::env::temp_dir().join(format!("acp-test-{}", uuid::Uuid::new_v4()));
        let workspace = base.join("workspace");
        let outside = base.join("outside");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&outside).unwrap();

        let target = outside.join("evil.txt");
        let req = WriteTextFileRequest::new("sess", &target, "pwned");
        let err = handle_write_text_file(&req, Some(workspace.as_path()))
            .await
            .unwrap_err();
        assert_eq!(err.code, acp::ErrorCode::InvalidParams);
        assert!(!target.exists(), "write must not have escaped the workspace");

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
