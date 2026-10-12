//! `watch_project` / `unwatch_project` handlers: per-connection subscriptions
//! to a registered project's filesystem watcher. The refcounted watcher and the
//! targeted `fs_changed` delivery live in [`crate::web::fs_watcher::FsWatchHub`];
//! connection close releases subscriptions through `ConnectionCleanup`.
//!
//! `watch` / `unwatch` handlers: subscriptions to the state watches (projects,
//! chat-history index, agent roster) of [`crate::web::watch::WatchHub`].

use super::*;
use crate::web::watch::{
    agents_state, chat_history_state, projects_state, SubscribeError, WatchKind,
};

/// `watch_project` / `unwatch_project` payload.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WatchProjectPayload {
    project_id: String,
}

fn parse_payload(payload: &Value, request: &str) -> Result<WatchProjectPayload, String> {
    let parsed: WatchProjectPayload = serde_json::from_value(payload.clone())
        .map_err(|e| format!("malformed {request} payload (want projectId): {e}"))?;
    if parsed.project_id.trim().is_empty() {
        return Err("projectId is required".to_string());
    }
    Ok(parsed)
}

/// `watch_project{projectId}`: subscribe this connection to the project's
/// `fs_changed` events. Unknown/archived/unresolvable project → `not_found`.
/// Idempotent for an already-subscribed connection.
pub(super) fn handle_watch_project(
    id: String,
    payload: &Value,
    relay: &Arc<WsRelaySink>,
    registry: &Arc<ProjectRegistry>,
    out_tx: &OutboundSender,
) -> WsReply {
    let parsed = match parse_payload(payload, "watch_project") {
        Ok(parsed) => parsed,
        Err(message) => return WsReply::err(id, WsErrorCode::Unsupported, message),
    };
    match relay
        .fs_watches()
        .subscribe(registry, &parsed.project_id, out_tx)
    {
        Ok(()) => {
            log::info!(
                "[ws] watch_project subscribed project_id={}",
                parsed.project_id
            );
            WsReply::ok(id, Some(json!({ "projectId": parsed.project_id })))
        }
        Err(_) => {
            log::warn!(
                "[ws] watch_project failed failure=not_found project_id={}",
                parsed.project_id
            );
            WsReply::err(id, WsErrorCode::NotFound, "project not found")
        }
    }
}

/// `unwatch_project{projectId}`: release this connection's subscription (the
/// watcher is dropped on the last one). Always succeeds for a well-formed
/// request: afterwards the connection no longer watches the project, whether
/// it was subscribed, never subscribed, or the project was archived/removed
/// meanwhile (which already dropped the subscription). A client tearing down
/// after such a removal must not see an error.
pub(super) fn handle_unwatch_project(
    id: String,
    payload: &Value,
    relay: &Arc<WsRelaySink>,
    out_tx: &OutboundSender,
) -> WsReply {
    let parsed = match parse_payload(payload, "unwatch_project") {
        Ok(parsed) => parsed,
        Err(message) => return WsReply::err(id, WsErrorCode::Unsupported, message),
    };
    let was_subscribed = relay.fs_watches().unsubscribe(&parsed.project_id, out_tx);
    log::info!(
        "[ws] unwatch_project project_id={} was_subscribed={was_subscribed}",
        parsed.project_id
    );
    WsReply::ok(id, Some(json!({ "projectId": parsed.project_id })))
}

/// `watch` / `unwatch` payload: `{watch, scope?}`.
#[derive(Debug, Deserialize)]
struct WatchPayload {
    watch: String,
    #[serde(default)]
    scope: String,
}

fn parse_watch(payload: &Value, request: &str) -> Result<(WatchKind, String), String> {
    let parsed: WatchPayload = serde_json::from_value(payload.clone())
        .map_err(|e| format!("malformed {request} payload (want watch, scope?): {e}"))?;
    let kind = WatchKind::parse(&parsed.watch)
        .ok_or_else(|| format!("unknown watch `{}`", parsed.watch))?;
    if !kind.accepts_scope(&parsed.scope) {
        return Err(format!("watch `{}` has no scope `{}`", parsed.watch, parsed.scope));
    }
    Ok((kind, parsed.scope))
}

/// `watch{watch, scope?}`: subscribe this connection to a state watch. The
/// full-state frame (`reset`, revision `n = 1`) is queued before the reply, so
/// the client holds the state when the reply arrives; deltas follow under
/// `n + 1`. Watching again replaces the subscription and sends fresh state.
pub(super) fn handle_watch(id: String, payload: &Value, env: &HandlerEnv) -> WsReply {
    let (kind, scope) = match parse_watch(payload, "watch") {
        Ok(parsed) => parsed,
        Err(message) => return WsReply::err(id, WsErrorCode::Unsupported, message),
    };
    let relay = &env.relay;
    let subscribed = relay.watches().subscribe(kind, &scope, &env.out_tx, || match kind {
        WatchKind::Projects => projects_state(&env.registry),
        WatchKind::ChatHistory => chat_history_state(relay, env.history_mode),
        WatchKind::Agents => agents_state(&env.acp),
    });
    match subscribed {
        Ok(revision) => WsReply::ok(
            id,
            Some(json!({ "watch": kind.as_str(), "scope": scope, "revision": revision })),
        ),
        Err(SubscribeError::QueueFull) => WsReply::err(
            id,
            WsErrorCode::RateLimited,
            "connection queue is full; retry the watch",
        ),
        Err(SubscribeError::Closed) => {
            WsReply::err(id, WsErrorCode::RateLimited, "connection is closing")
        }
    }
}

/// `unwatch{watch, scope?}`: release the subscription. Always succeeds for a
/// well-formed request, subscribed or not.
pub(super) fn handle_unwatch(id: String, payload: &Value, env: &HandlerEnv) -> WsReply {
    let (kind, scope) = match parse_watch(payload, "unwatch") {
        Ok(parsed) => parsed,
        Err(message) => return WsReply::err(id, WsErrorCode::Unsupported, message),
    };
    let was_subscribed = env.relay.watches().unsubscribe(kind, &scope, &env.out_tx);
    log::info!("[ws] unwatch watch={} was_subscribed={was_subscribed}", kind.as_str());
    WsReply::ok(id, Some(json!({ "watch": kind.as_str(), "scope": scope })))
}
