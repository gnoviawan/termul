//! Session WS handlers: CRUD, payload/cursor reads, snapshot recovery,
//! agent-switch records, and persisted-session reopen.

use super::*;

/// `delete_session` request payload (CAP-11).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DeleteSessionPayload {
    session_id: String,
}

/// `delete_session` — permanently remove a persisted session from the
/// host-owned `SessionPersistence` store (CAP-11; desktop parity with the
/// `acp_history_delete` Tauri command). Mirrors
/// `handle_list_persisted_sessions`'s gating (server history mode + attached
/// persistence, else `unsupported`). The reply data is the typed idempotent
/// delete contract (`{ "deleted": true }` when a record was removed,
/// `{ "deleted": false }` when it was already absent — never a not-found
/// error), so the renderer can treat delete as idempotent without string
/// sniffing. On success the relay forgets any in-memory state for the session
/// and every connected client is told to refetch the index
/// (`chat_history_changed`).
pub(super) async fn handle_delete_session(
    id: String,
    payload: &Value,
    relay: &Arc<WsRelaySink>,
    history_mode: HistoryMode,
) -> WsReply {
    if history_mode != HistoryMode::Server {
        return WsReply::err(
            id,
            WsErrorCode::Unsupported,
            "persisted history is unavailable",
        );
    }
    let parsed: DeleteSessionPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed delete_session payload (want sessionId): {e}"),
            )
        }
    };
    let Some(persistence) = relay.persistence() else {
        return WsReply::err(
            id,
            WsErrorCode::Unsupported,
            "persisted history is unavailable",
        );
    };
    match persistence.delete_session(&parsed.session_id).await {
        Ok(()) => {
            relay.forget_session(&parsed.session_id).await;
            broadcast_chat_history_changed(relay);
            WsReply::ok(id, Some(json!({ "deleted": true })))
        }
        Err(crate::acp::session_persistence::SessionPersistenceError::SessionNotFound) => {
            // Typed idempotent delete: the record is already gone — the desired
            // end state holds, reported as `{ deleted: false }` (never a
            // not-found error). Drop stale in-memory relay state too — the
            // record is gone from disk, so a lingering live session would
            // resurrect it on save.
            relay.forget_session(&parsed.session_id).await;
            WsReply::ok(id, Some(json!({ "deleted": false })))
        }
        Err(error) => {
            // Full storage error stays in the host log; the client gets a fixed
            // generic message — the storage error may embed filesystem paths.
            warn!("[ws] delete_session failed: {error}");
            WsReply::err_with_code(
                id,
                "SESSION_DELETE_FAILED",
                "failed to delete persisted session",
            )
        }
    }
}

pub(super) async fn handle_list_persisted_sessions(
    id: String,
    relay: &Arc<WsRelaySink>,
    history_mode: HistoryMode,
) -> WsReply {
    if history_mode != HistoryMode::Server {
        return WsReply::err(
            id,
            WsErrorCode::Unsupported,
            "persisted history is unavailable",
        );
    }
    // Host-owned history (CAP-2): both desktop shared-live and the standalone
    // server serve the file-backed `SessionPersistence` index.
    match relay.persistence() {
        Some(persistence) => ok_with_payload(id, &persistence.list_sessions()),
        None => WsReply::err(
            id,
            WsErrorCode::Unsupported,
            "persisted history is unavailable",
        ),
    }
}

/// `get_session_payload` — fetch the FULL stored transcript (`{ metadata,
/// messages }`) for a session id. Both desktop shared-live and the standalone
/// server materialize the renderer shape from the host-owned
/// `SessionPersistence` JSONL records. Returns
/// `{ ok:false, err:'not_found' }` when the id is absent (web shows "chat
/// unavailable").
pub(super) async fn handle_get_session_payload(
    id: String,
    payload: &Value,
    relay: &Arc<WsRelaySink>,
    history_mode: HistoryMode,
) -> WsReply {
    if history_mode != HistoryMode::Server {
        return WsReply::err(
            id,
            WsErrorCode::Unsupported,
            "persisted history is unavailable",
        );
    }
    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct GetSessionPayloadRequest {
        session_id: String,
    }
    let parsed: GetSessionPayloadRequest = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed get_session_payload payload (want sessionId): {e}"),
            )
        }
    };
    // Host-owned history (CAP-2): materialize the renderer-shaped payload from
    // the durable JSONL records (pure fold of `user_prompt` / `message_chunk`).
    // `session_payload_async` flushes the writer queue first, so an active
    // session reads every already-assigned seq; a finalized session is served
    // read-only. Errors fail closed — never a fabricated empty payload.
    match relay.persistence() {
        Some(persistence) => {
            match persistence.session_payload_async(&parsed.session_id).await {
                Ok(payload) => {
                    tracing::debug!(
                        target: "termul::web::ws",
                        session_id = %parsed.session_id,
                        messages = payload.messages.len(),
                        "get_session_payload: materialized host payload"
                    );
                    ok_with_payload(id, &payload)
                }
                Err(crate::acp::SessionPersistenceError::SessionNotFound) => {
                    WsReply::err(id, WsErrorCode::NotFound, "session payload not found")
                }
                Err(error) => {
                    // Fail closed with a generic client-facing message: storage
                    // error strings can carry absolute paths and internal
                    // detail that do not belong on the wire. The full context
                    // stays in the host log.
                    tracing::warn!(
                        target: "termul::web::ws",
                        session_id = %parsed.session_id,
                        error = %error,
                        "get_session_payload: host payload materialization failed"
                    );
                    WsReply::err(
                        id,
                        WsErrorCode::Unsupported,
                        "failed to read session payload",
                    )
                }
            }
        }
        None => WsReply::err(id, WsErrorCode::NotFound, "session payload not found"),
    }
}

/// `get_session_payload_tail` — tail-first variant of `get_session_payload`.
/// Fetches only the last `limit` messages + matching tool calls so the
/// renderer can install the recent transcript immediately and lazy-load the
/// full payload on scroll-up. Mirrors `handle_get_session_payload` but calls
/// `session_payload_tail_async`.
pub(super) async fn handle_get_session_payload_tail(
    id: String,
    payload: &Value,
    relay: &Arc<WsRelaySink>,
    history_mode: HistoryMode,
) -> WsReply {
    if history_mode != HistoryMode::Server {
        return WsReply::err(
            id,
            WsErrorCode::Unsupported,
            "persisted history is unavailable",
        );
    }
    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct GetSessionPayloadTailRequest {
        session_id: String,
        limit: Option<u32>,
    }
    let parsed: GetSessionPayloadTailRequest = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed get_session_payload_tail payload (want sessionId, limit?): {e}"),
            )
        }
    };
    let limit = parsed.limit.unwrap_or(50).clamp(1, 500) as usize;
    match relay.persistence() {
        Some(persistence) => {
            match persistence
                .session_payload_tail_async(&parsed.session_id, limit)
                .await
            {
                Ok(payload) => {
                    tracing::debug!(
                        target: "termul::web::ws",
                        session_id = %parsed.session_id,
                        messages = payload.messages.len(),
                        "get_session_payload_tail: materialized host tail payload"
                    );
                    ok_with_payload(id, &payload)
                }
                Err(crate::acp::SessionPersistenceError::SessionNotFound) => {
                    WsReply::err(id, WsErrorCode::NotFound, "session payload not found")
                }
                Err(error) => {
                    tracing::warn!(
                        target: "termul::web::ws",
                        session_id = %parsed.session_id,
                        error = %error,
                        "get_session_payload_tail: host tail materialization failed"
                    );
                    WsReply::err(
                        id,
                        WsErrorCode::Unsupported,
                        "failed to read session payload tail",
                    )
                }
            }
        }
        None => WsReply::err(id, WsErrorCode::NotFound, "session payload not found"),
    }
}

/// `record_agent_switch` request payload (CAP-2). Mirrors the Tauri command
/// args and the durable record's payload shape byte-for-byte.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RecordAgentSwitchPayload {
    session_id: String,
    from_config_id: String,
    to_config_id: String,
    new_session_id: String,
    summary_text: String,
}

/// `record_agent_switch` — durably record an agent-switch marker (CAP-2).
/// Desktop parity with the `acp_record_agent_switch` Tauri command: the host
/// is the sole author of the marker. Persists the `agent_switch` record
/// through `SessionPersistence` (writer-assigned seq) + flush, then fans the
/// synthetic `acp:agent_switch` event through the manager's sinks. Unknown
/// session → `not_found`; storage failure → `unsupported` (fail closed — no
/// partial state). Boundary logging carries ids only, never the summary.
pub(super) async fn handle_record_agent_switch(
    id: String,
    payload: &Value,
    acp: &Arc<AcpManager>,
    relay: &Arc<WsRelaySink>,
    history_mode: HistoryMode,
) -> WsReply {
    if history_mode != HistoryMode::Server {
        return WsReply::err(
            id,
            WsErrorCode::Unsupported,
            "persisted history is unavailable",
        );
    }
    let parsed: RecordAgentSwitchPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!(
                    "malformed record_agent_switch payload (want sessionId, fromConfigId, \
                     toConfigId, newSessionId, summaryText): {e}"
                ),
            )
        }
    };
    if parsed.session_id.trim().is_empty() || parsed.to_config_id.trim().is_empty() {
        return WsReply::err(
            id,
            WsErrorCode::Unsupported,
            "sessionId and toConfigId are required",
        );
    }
    let Some(persistence) = relay.persistence() else {
        return WsReply::err(
            id,
            WsErrorCode::Unsupported,
            "persisted history is unavailable",
        );
    };
    // Unknown session fails closed BEFORE any durable write.
    if persistence.metadata(&parsed.session_id).is_err() {
        return WsReply::err(id, WsErrorCode::NotFound, "persisted session not found");
    }
    // Note: the event's agent id resolves inside the manager from the
    // session metadata (the OLD session's runtime agent) — nothing to
    // pre-resolve here.
    let record = crate::acp::session_persistence::AgentSwitchRecord {
        session_id: parsed.session_id.clone(),
        from_config_id: parsed.from_config_id,
        to_config_id: parsed.to_config_id,
        new_session_id: parsed.new_session_id,
        summary_text: parsed.summary_text,
    };
    match acp
        .record_agent_switch(parsed.session_id.clone(), record)
        .await
    {
        Ok(()) => {
            tracing::debug!(
                target: "termul::web::ws",
                session_id = %parsed.session_id,
                "record_agent_switch: durable marker recorded"
            );
            WsReply::ok(id, Some(json!({})))
        }
        Err(error) => {
            // A catalog-known session whose writer runtime is gone (a
            // post-restart recovered session: metadata check above passed,
            // but `append_agent_switch` hits SessionNotFound) surfaces as a
            // typed `not_found` so the client can distinguish "unknown
            // session" from a real storage failure.
            if error.contains("session not found")
                || error.contains("not found")
                || error.contains("session writer unavailable")
            {
                return WsReply::err(id, WsErrorCode::NotFound, "persisted session not found");
            }
            // Other failures stay fail-closed with a generic client-facing
            // message: the error string may embed filesystem paths.
            // Ids-only context stays in the host log.
            tracing::warn!(
                target: "termul::web::ws",
                session_id = %parsed.session_id,
                error = %error,
                "record_agent_switch: durable marker write failed"
            );
            WsReply::err(
                id,
                WsErrorCode::Unsupported,
                "failed to record agent switch",
            )
        }
    }
}

pub(super) async fn handle_recover_session_snapshot(
    id: String,
    payload: &Value,
    relay: &Arc<WsRelaySink>,
    out_tx: &mpsc::UnboundedSender<Outbound>,
    subscribed_clients: &mut Vec<(String, ClientId)>,
    history_mode: HistoryMode,
) -> WsReply {
    if history_mode != HistoryMode::Server {
        return WsReply::err(
            id,
            WsErrorCode::Unsupported,
            "atomic snapshot recovery is unavailable in live-only mode",
        );
    }
    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct RecoverSnapshotRequest {
        session_id: String,
    }
    let parsed: RecoverSnapshotRequest = match serde_json::from_value(payload.clone()) {
        Ok(parsed) => parsed,
        Err(error) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed recover_session_snapshot payload: {error}"),
            )
        }
    };
    if parsed.session_id.is_empty() {
        return WsReply::err(id, WsErrorCode::Unsupported, "sessionId is required");
    }
    let prior_clients: Vec<ClientId> = subscribed_clients
        .iter()
        .filter(|(sid, _)| sid == &parsed.session_id)
        .map(|(_, client_id)| *client_id)
        .collect();
    let (client_id, mut rx, events, watermark) =
        match relay.subscribe_snapshot(&parsed.session_id).await {
            Ok(result) => result,
            Err(error) => {
                if relay.persistence().is_some_and(|persistence| {
                    matches!(
                        persistence.metadata(&parsed.session_id),
                        Err(crate::acp::SessionPersistenceError::SessionNotFound)
                    )
                }) {
                    return WsReply::err(id, WsErrorCode::NotFound, "session snapshot not found");
                }
                tracing::warn!(
                    target: "termul::web::ws",
                    session_id = %parsed.session_id,
                    error = %error,
                    "recover_session_snapshot: transient snapshot materialization failure"
                );
                return WsReply::err(
                    id,
                    WsErrorCode::AgentCrashed,
                    "session snapshot is temporarily unavailable; retry after reconnect",
                );
            }
        };
    subscribed_clients.retain(|(sid, client_id)| {
        if sid == &parsed.session_id && prior_clients.contains(client_id) {
            relay.unsubscribe(sid, *client_id);
            false
        } else {
            true
        }
    });
    subscribed_clients.push((parsed.session_id.clone(), client_id));
    if let Some(rendezvous) = relay.rendezvous() {
        rendezvous.cancel_disconnect_grace(&parsed.session_id);
    }
    let forward_tx = out_tx.clone();
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            if forward_tx.send(Outbound::Event(event)).is_err() {
                break;
            }
        }
    });
    WsReply::ok(
        id,
        Some(json!({
            "sessionId": parsed.session_id,
            "watermark": watermark,
            "events": events,
        })),
    )
}

/// `get_session_cursor` (R2) — returns the server-authoritative replay
/// watermark `{ sessionId, watermark }` for a session WITHOUT subscribing
/// (contrast `recover_session_snapshot`, which re-registers a subscription
/// and emits the snapshot payload). A refreshed WS transport seeds its
/// per-session `lastSeq` from this before the first `subscribeSession`, so
/// events missed during the reload gap (seq > watermark) replay instead of
/// running live-only (the stale-recovery path that fires only on a `STALE`
/// error). Best-effort: an unknown session or a payload without `seq`-bearing
/// messages resolves to `watermark: 0` (live-only subscribe), never an error.
pub(super) async fn handle_get_session_cursor(
    id: String,
    payload: &Value,
    relay: &Arc<WsRelaySink>,
    history_mode: HistoryMode,
) -> WsReply {
    if history_mode != HistoryMode::Server {
        return WsReply::err(
            id,
            WsErrorCode::Unsupported,
            "persisted history is unavailable",
        );
    }
    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct GetSessionCursorRequest {
        session_id: String,
    }
    let parsed: GetSessionCursorRequest = match serde_json::from_value(payload.clone()) {
        Ok(parsed) => parsed,
        Err(e) => {
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed get_session_cursor payload (want sessionId): {e}"),
            )
        }
    };
    if parsed.session_id.is_empty() {
        return WsReply::err(id, WsErrorCode::Unsupported, "sessionId is required");
    }
    // Host-owned history (CAP-2): both desktop shared-live and the standalone
    // server resolve the authoritative JSONL append log's `last_seq`.
    // `last_seq` returns `Ok(0)` for a genuinely unknown (brand-new) session,
    // but `Err(_)` for a real I/O / decode failure. `unwrap_or(0)` would mask a
    // storage failure as "new session" in the reply + logs; log the `Err` first
    // so a corrupted payload or permission error is visible, then default to 0.
    let watermark = relay
        .persistence()
        .map(|persistence| {
            persistence
                .last_seq(&parsed.session_id)
                .unwrap_or_else(|error| {
                    tracing::warn!(
                        session_id = %parsed.session_id,
                        error = ?error,
                        "get_session_cursor: last_seq lookup failed"
                    );
                    0
                })
        })
        .unwrap_or(0);
    tracing::debug!(
        target: "termul::web::ws",
        session_id = %parsed.session_id,
        watermark,
        "get_session_cursor"
    );
    WsReply::ok(
        id,
        Some(json!({ "sessionId": parsed.session_id, "watermark": watermark })),
    )
}

pub(super) async fn handle_open_persisted_session(
    id: String,
    payload: &Value,
    relay: &Arc<WsRelaySink>,
    out_tx: &mpsc::UnboundedSender<Outbound>,
    subscribed_clients: &mut Vec<(String, ClientId)>,
    history_mode: HistoryMode,
) -> WsReply {
    if history_mode != HistoryMode::Server {
        return WsReply::err(
            id,
            WsErrorCode::Unsupported,
            "persisted history is unavailable",
        );
    }
    handle_subscribe(id, payload, relay, out_tx, subscribed_clients).await
}
