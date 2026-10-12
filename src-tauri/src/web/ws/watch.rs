//! `watch_project` / `unwatch_project` handlers: per-connection subscriptions
//! to a registered project's filesystem watcher. The refcounted watcher and the
//! targeted `fs_changed` delivery live in [`crate::web::fs_watcher::FsWatchHub`];
//! connection close releases subscriptions through `ConnectionCleanup`.

use super::*;

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
