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
    ClientCapabilities, FileSystemCapabilities, Meta, ReadTextFileRequest, ReadTextFileResponse,
    SessionNotification, SessionUpdate, WriteTextFileRequest, WriteTextFileResponse,
};
use tauri::AppHandle;

use crate::acp::config::AgentId;
use crate::acp::events::{
    self, ChunkRole, CommandsUpdateEvent, ConfigOptionsUpdateEvent, MessageChunkEvent,
    ModeUpdateEvent, PlanUpdateEvent, SessionInfoUpdateEvent, ToolCallEvent, ToolCallUpdateEvent,
};

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
        SessionUpdate::AgentMessageChunk(chunk) => {
            let preview = match &chunk.content {
                agent_client_protocol::schema::ContentBlock::Text(text) => {
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
            log::info!(
                "[acp] agent {agent_id} session {} agent_message_chunk: {preview}",
                session_id.0
            );
            events::emit(
                app,
                events::EVENT_MESSAGE_CHUNK,
                MessageChunkEvent {
                    agent_id: agent_id.clone(),
                    session_id,
                    role: ChunkRole::Agent,
                    content: chunk.content,
                },
            )
        }
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
        SessionUpdate::SessionInfoUpdate(update) => {
            // `title` is `MaybeUndefined<String>`: Undefined = not sent (skip),
            // Null = explicitly cleared (emit None), Value = set (emit Some).
            match update.title.as_opt_ref() {
                None => {} // Undefined — no title field sent, skip
                Some(None) => events::emit(
                    app,
                    events::EVENT_SESSION_INFO_UPDATE,
                    SessionInfoUpdateEvent {
                        agent_id: agent_id.clone(),
                        session_id,
                        title: None,
                    },
                ),
                Some(Some(t)) => events::emit(
                    app,
                    events::EVENT_SESSION_INFO_UPDATE,
                    SessionInfoUpdateEvent {
                        agent_id: agent_id.clone(),
                        session_id,
                        title: Some(t.clone()),
                    },
                ),
            }
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

// ---------------------------------------------------------------------------
// Cursor `cursor/update_todos` extension
//
// Cursor CLI reports plan/todo progress via its own ACP extension method
// `cursor/update_todos` rather than the spec's `session/update` Plan variant,
// so the standard plan fan-out above never sees it. We register dedicated
// handlers (notification AND request form, since Cursor's docs are ambiguous)
// that translate the todos into a `Plan` and reuse `acp:plan_update`, so the
// existing PlanPanel updates live with no renderer changes.
// See: https://cursor.com/docs/cli/acp (Cursor extension methods).
// ---------------------------------------------------------------------------

/// Wire method name for Cursor's todo-progress notification/request.
pub const CURSOR_UPDATE_TODOS_METHOD: &str = "cursor/update_todos";

/// A single Cursor todo item. `status` may be pending / in_progress /
/// completed / cancelled; `cancelled` has no ACP equivalent and is dropped.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct CursorTodo {
    #[allow(dead_code)]
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub status: String,
}

/// Params for `cursor/update_todos`. `session_id` is optional because Cursor's
/// documented shape (`toolCallId`, `todos`, `merge`) omits it; when absent we
/// route to the session with an active prompt turn. `merge` controls whether
/// the incoming todos replace the list (false) or are merged into it (true).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorUpdateTodosParams {
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub todos: Vec<CursorTodo>,
    #[serde(default)]
    pub merge: bool,
}

/// Merge incoming Cursor todos into an existing list. With `merge = false` the
/// incoming list replaces everything. With `merge = true`, todos are matched by
/// `id`: existing entries are updated in place, and new ids are appended, so
/// prior tasks aren't lost when Cursor sends a partial update.
pub fn merge_cursor_todos(
    existing: &[CursorTodo],
    incoming: Vec<CursorTodo>,
    merge: bool,
) -> Vec<CursorTodo> {
    if !merge {
        return incoming;
    }
    let mut result: Vec<CursorTodo> = existing.to_vec();
    for todo in incoming {
        if let Some(slot) = result.iter_mut().find(|t| !t.id.is_empty() && t.id == todo.id) {
            *slot = todo;
        } else {
            result.push(todo);
        }
    }
    result
}

/// Map Cursor's todo status string to an ACP `PlanEntryStatus`. Unknown or
/// `cancelled` statuses return `None` so the entry is dropped from the plan.
fn map_todo_status(status: &str) -> Option<acp::schema::PlanEntryStatus> {
    use acp::schema::PlanEntryStatus;
    match status {
        "pending" => Some(PlanEntryStatus::Pending),
        "in_progress" => Some(PlanEntryStatus::InProgress),
        "completed" => Some(PlanEntryStatus::Completed),
        // `cancelled` (and anything unknown) has no ACP equivalent; drop it.
        _ => None,
    }
}

/// Translate Cursor todos into an ACP `Plan`. Cursor todos carry no priority,
/// so every entry is assigned `Medium`. Cancelled/unknown entries are dropped.
pub fn cursor_todos_to_plan(todos: &[CursorTodo]) -> acp::schema::Plan {
    use acp::schema::{PlanEntry, PlanEntryPriority};
    let entries = todos
        .iter()
        .filter_map(|t| {
            map_todo_status(&t.status)
                .map(|status| PlanEntry::new(t.content.clone(), PlanEntryPriority::Medium, status))
        })
        .collect();
    acp::schema::Plan::new(entries)
}

/// Per-session cache of the last-known Cursor todo list, used to honor
/// `merge: true` updates that only carry changed/added todos. Keyed by session
/// id. Held per connection (one agent process).
pub type CursorTodosCache = std::sync::Arc<parking_lot::Mutex<std::collections::HashMap<String, Vec<CursorTodo>>>>;

/// Handle a decoded `cursor/update_todos` payload: resolve the target session,
/// apply merge semantics against the cache, then emit `acp:plan_update` so the
/// PlanPanel refreshes. `fallback_session` is used when the payload omits a
/// session id (the active-turn session).
pub fn handle_cursor_update_todos(
    app: &AppHandle,
    agent_id: &AgentId,
    params: CursorUpdateTodosParams,
    fallback_session: Option<String>,
    cache: &CursorTodosCache,
) {
    let Some(session) = params.session_id.clone().or(fallback_session) else {
        log::debug!(
            "[acp] agent {agent_id} cursor/update_todos with no session id and no active turn; dropping"
        );
        return;
    };
    // Apply merge against the last-known list for this session, then cache it.
    let merged = {
        let mut guard = cache.lock();
        let existing = guard.get(&session).map(Vec::as_slice).unwrap_or(&[]);
        let merged = merge_cursor_todos(existing, params.todos, params.merge);
        guard.insert(session.clone(), merged.clone());
        merged
    };
    let plan = cursor_todos_to_plan(&merged);
    events::emit(
        app,
        events::EVENT_PLAN_UPDATE,
        PlanUpdateEvent {
            agent_id: agent_id.clone(),
            session_id: crate::acp::config::SessionId::new(session),
            plan,
        },
    );
}

/// Parse a raw JSON-RPC params value into [`CursorUpdateTodosParams`].
pub fn parse_cursor_update_todos(
    params: &serde_json::Value,
) -> Result<CursorUpdateTodosParams, serde_json::Error> {
    serde_json::from_value(params.clone())
}

/// A `JsonRpcMessage` type that claims Cursor's `cursor/update_todos` method.
/// Holds the raw params so the handler can decode them off the dispatch path.
/// Registered as both a notification and a request handler because Cursor's
/// docs are ambiguous about which wire form it uses.
#[derive(Debug, Clone)]
pub struct CursorUpdateTodosMessage {
    pub params: serde_json::Value,
}

impl acp::JsonRpcMessage for CursorUpdateTodosMessage {
    fn matches_method(method: &str) -> bool {
        method == CURSOR_UPDATE_TODOS_METHOD
    }

    fn method(&self) -> &str {
        CURSOR_UPDATE_TODOS_METHOD
    }

    fn to_untyped_message(&self) -> Result<acp::UntypedMessage, acp::Error> {
        acp::UntypedMessage::new(CURSOR_UPDATE_TODOS_METHOD, &self.params)
    }

    fn parse_message(
        method: &str,
        params: &impl serde::Serialize,
    ) -> Result<Self, acp::Error> {
        if method != CURSOR_UPDATE_TODOS_METHOD {
            return Err(acp::Error::method_not_found());
        }
        let value = serde_json::to_value(params).map_err(acp::Error::into_internal_error)?;
        Ok(Self { params: value })
    }
}

impl acp::JsonRpcNotification for CursorUpdateTodosMessage {}

impl acp::JsonRpcRequest for CursorUpdateTodosMessage {
    type Response = serde_json::Value;
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

    fn todo(id: &str, content: &str, status: &str) -> CursorTodo {
        CursorTodo {
            id: id.to_string(),
            content: content.to_string(),
            status: status.to_string(),
        }
    }

    #[test]
    fn cursor_todos_map_to_plan_entries_dropping_cancelled() {
        let todos = vec![
            todo("1", "first", "completed"),
            todo("2", "second", "in_progress"),
            todo("3", "third", "pending"),
            todo("4", "gone", "cancelled"),
            todo("5", "weird", "bogus"),
        ];
        let plan = cursor_todos_to_plan(&todos);
        // cancelled + unknown are dropped; the rest map by status.
        assert_eq!(plan.entries.len(), 3);
        assert_eq!(plan.entries[0].content, "first");
        assert_eq!(plan.entries[0].status, acp::schema::PlanEntryStatus::Completed);
        assert_eq!(plan.entries[1].status, acp::schema::PlanEntryStatus::InProgress);
        assert_eq!(plan.entries[2].status, acp::schema::PlanEntryStatus::Pending);
        // Cursor todos carry no priority; everything defaults to Medium.
        assert_eq!(plan.entries[0].priority, acp::schema::PlanEntryPriority::Medium);
    }

    #[test]
    fn merge_false_replaces_the_list() {
        let existing = vec![todo("1", "old", "completed")];
        let incoming = vec![todo("2", "new", "pending")];
        let out = merge_cursor_todos(&existing, incoming, false);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "2");
    }

    #[test]
    fn merge_true_updates_existing_and_appends_new() {
        let existing = vec![todo("1", "a", "pending"), todo("2", "b", "pending")];
        let incoming = vec![todo("1", "a", "completed"), todo("3", "c", "pending")];
        let out = merge_cursor_todos(&existing, incoming, true);
        assert_eq!(out.len(), 3);
        // id 1 updated in place (still first), status flipped to completed.
        assert_eq!(out[0].id, "1");
        assert_eq!(out[0].status, "completed");
        // id 2 untouched, id 3 appended.
        assert_eq!(out[1].id, "2");
        assert_eq!(out[2].id, "3");
    }

    #[test]
    fn parse_cursor_update_todos_reads_documented_shape() {
        let value = serde_json::json!({
            "toolCallId": "call_1",
            "merge": true,
            "todos": [
                { "id": "1", "content": "do a thing", "status": "in_progress" }
            ]
        });
        let params = parse_cursor_update_todos(&value).expect("parses");
        assert!(params.merge);
        assert_eq!(params.session_id, None);
        assert_eq!(params.todos.len(), 1);
        assert_eq!(params.todos[0].content, "do a thing");
    }

    #[test]
    fn cursor_message_matches_only_its_method() {
        use acp::JsonRpcMessage;
        assert!(CursorUpdateTodosMessage::matches_method("cursor/update_todos"));
        assert!(!CursorUpdateTodosMessage::matches_method("session/update"));
    }
}
