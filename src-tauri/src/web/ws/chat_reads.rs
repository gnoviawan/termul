//! `mark_chat_read` handler: a surface has read a chat up to a seq. The host
//! keeps the marker ([`crate::web::chat_reads`]) and tells every `chat_reads`
//! watcher when it moves, so a dot banked on another surface clears.

use super::*;
use crate::logging::redact_session_id;
use crate::web::chat_reads::MarkOutcome;
use crate::web::watch::publish_chat_read;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MarkChatReadPayload {
    session_id: String,
    seq: u64,
}

/// `mark_chat_read{sessionId, seq}` → `{sessionId, seq}`, the marker as it
/// stands. Idempotent and monotonic: an older or repeated seq is a no-op that
/// still replies with the current marker. Unknown session → `not_found`.
pub(super) fn handle_mark_chat_read(id: String, payload: &Value, relay: &WsRelaySink) -> WsReply {
    let parsed: MarkChatReadPayload = match serde_json::from_value(payload.clone()) {
        Ok(parsed) => parsed,
        Err(error) => {
            warn!(
                target: "termul::web::ws",
                "mark_chat_read refused: failure=malformed_payload"
            );
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                format!("malformed mark_chat_read payload (want sessionId, seq): {error}"),
            );
        }
    };
    let session = redact_session_id(&parsed.session_id);
    let Some(head) = relay.log_head(&parsed.session_id) else {
        warn!(
            target: "termul::web::ws",
            session = %session,
            "mark_chat_read refused: failure=not_found"
        );
        return WsReply::err(id, WsErrorCode::NotFound, "session not found");
    };
    let seq = match relay.chat_reads().mark(&parsed.session_id, &head, parsed.seq) {
        MarkOutcome::Moved(seq) => {
            info!(
                target: "termul::web::ws",
                session = %session,
                seq,
                "chat read marker moved"
            );
            publish_chat_read(relay, &parsed.session_id);
            seq
        }
        MarkOutcome::Unchanged(seq) => {
            debug!(
                target: "termul::web::ws",
                session = %session,
                seq,
                requested = parsed.seq,
                "chat read marker already covers the seq"
            );
            seq
        }
    };
    WsReply::ok(id, Some(json!({ "sessionId": parsed.session_id, "seq": seq })))
}
