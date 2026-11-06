//! `mark_chat_read` handler: a surface has read a chat up to a seq. The host
//! keeps the marker ([`crate::web::chat_reads`]) and re-derives the chat's
//! `chat_activity` record when it moves, so the dot clears on every surface.

use super::*;
use crate::logging::redact_session_id;
use crate::web::chat_reads::MarkOutcome;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MarkChatReadPayload {
    session_id: String,
    seq: u64,
    log_epoch: Option<String>,
}

/// `mark_chat_read{sessionId, seq, logEpoch?}` → `{sessionId, seq, logEpoch}`,
/// the marker as it stands. Idempotent and monotonic: an older or repeated
/// seq, or a seq from another log epoch than the session's, is a no-op that
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
    let outcome = relay.chat_reads().mark(
        &parsed.session_id,
        &head,
        parsed.log_epoch.as_deref(),
        parsed.seq,
    );
    let mark = match outcome {
        MarkOutcome::Moved(mark) => {
            info!(
                target: "termul::web::ws",
                session = %session,
                seq = mark.seq,
                "chat read marker moved"
            );
            relay.refresh_chat_activity(&parsed.session_id);
            mark
        }
        MarkOutcome::Unchanged(mark) => {
            debug!(
                target: "termul::web::ws",
                session = %session,
                seq = mark.seq,
                requested = parsed.seq,
                "chat read marker already covers the seq"
            );
            mark
        }
        MarkOutcome::OtherEpoch(mark) => {
            info!(
                target: "termul::web::ws",
                session = %session,
                requested = parsed.seq,
                "chat read ignored: it was against another log epoch than the session's"
            );
            mark
        }
    };
    WsReply::ok(id, Some(mark.to_wire(&parsed.session_id)))
}
