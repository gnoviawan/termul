//! `watch` / `unwatch` handlers: subscriptions to the watches of
//! [`crate::web::watch::WatchHub`] (projects, chat-history index, agent
//! roster, project file changes, store keys, project terminal set). The
//! notify watchers behind the `fs` watch live in
//! [`crate::web::fs_watcher::FsWatchHub`]; connection close releases every
//! subscription through `ConnectionCleanup`.

use super::*;
use crate::web::watch::{
    agents_state, chat_history_state, fs_state, projects_state, store_state, terminals_state,
    SubscribeError, WatchKind,
};

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

/// `watch{watch, scope?}`: subscribe this connection to a watch. The
/// full-state frame (`reset`, revision `n = 1`) is queued before the reply, so
/// the client holds the state when the reply arrives; deltas follow under
/// `n + 1`. Watching again replaces the subscription and sends fresh state.
/// An `fs` watch of an unknown, archived or unwatchable project is `not_found`;
/// a `store` watch on a host without a store is `STORE_UNAVAILABLE`.
pub(super) fn handle_watch(id: String, payload: &Value, env: &HandlerEnv) -> WsReply {
    let (kind, scope) = match parse_watch(payload, "watch") {
        Ok(parsed) => parsed,
        Err(message) => return WsReply::err(id, WsErrorCode::Unsupported, message),
    };
    let relay = &env.relay;
    let hub = relay.watches();
    let subscribed = match kind {
        WatchKind::Projects | WatchKind::ChatHistory | WatchKind::Agents => {
            hub.subscribe(kind, &scope, &env.out_tx, || match kind {
                WatchKind::Projects => projects_state(&env.registry),
                WatchKind::ChatHistory => chat_history_state(relay, env.history_mode),
                _ => agents_state(&env.acp),
            })
        }
        WatchKind::Terminals => hub.subscribe(kind, &scope, &env.out_tx, || {
            terminals_state(&env.pty, &scope)
        }),
        WatchKind::Store => {
            let Some(store) = env.store.as_ref() else {
                return WsReply::err_with_code(id, "STORE_UNAVAILABLE", "server store is unavailable");
            };
            let Some(identity) = env.identity.get() else {
                return WsReply::err(
                    id,
                    WsErrorCode::Unauthorized,
                    "a store watch needs an authenticated connection",
                );
            };
            // The key must be one this device may read: shared, or its own
            // device partition.
            if let Err(violation) = crate::web::store::classify(&scope, &identity.device_id) {
                return WsReply::err_with_code(id, "STORE_KEY_SCOPE", violation.0);
            }
            hub.subscribe(kind, &scope, &env.out_tx, || {
                store_state(store, &scope, identity)
            })
        }
        WatchKind::Fs => {
            let Some(root) = env.registry.canonical_root(&scope) else {
                log::warn!("[ws] watch fs refused: failure=not_found project_id={scope}");
                return WsReply::err(id, WsErrorCode::NotFound, "project not found");
            };
            if relay
                .fs_watches()
                .subscribe(&env.registry, hub, &scope, &env.out_tx)
                .is_err()
            {
                return WsReply::err(id, WsErrorCode::NotFound, "project not found");
            }
            let subscribed = hub.subscribe(kind, &scope, &env.out_tx, || fs_state(&root));
            if subscribed.is_err() {
                relay.fs_watches().unsubscribe(&scope, &env.out_tx);
            }
            subscribed
        }
    };
    match subscribed {
        Ok(revision) => {
            log::info!("[ws] watch subscribed watch={}", kind.as_str());
            WsReply::ok(
                id,
                Some(json!({ "watch": kind.as_str(), "scope": scope, "revision": revision })),
            )
        }
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

/// `unwatch{watch, scope?}`: release the subscription (an `fs` watch releases
/// its notify watcher on the last one). Always succeeds for a well-formed
/// request, subscribed or not: a client tearing down after the project was
/// removed must not see an error.
pub(super) fn handle_unwatch(id: String, payload: &Value, env: &HandlerEnv) -> WsReply {
    let (kind, scope) = match parse_watch(payload, "unwatch") {
        Ok(parsed) => parsed,
        Err(message) => return WsReply::err(id, WsErrorCode::Unsupported, message),
    };
    let mut was_subscribed = env.relay.watches().unsubscribe(kind, &scope, &env.out_tx);
    if kind == WatchKind::Fs {
        was_subscribed |= env.relay.fs_watches().unsubscribe(&scope, &env.out_tx);
    }
    log::info!("[ws] unwatch watch={} was_subscribed={was_subscribed}", kind.as_str());
    WsReply::ok(id, Some(json!({ "watch": kind.as_str(), "scope": scope })))
}
