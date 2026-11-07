//! The canvas gateway's renderer leg on `/ws` (spine AD-21, AD-29): the same
//! requests and frame on the desktop Channel and on a browser socket.
//!
//! - `canvas_mount{projectId, mountSeq}`: this connection now runs the
//!   project's mount. Refused `{attached: false, heldElsewhere}` when the
//!   host holds no such mount for this renderer; `heldElsewhere` says another
//!   renderer holds the project's lease (AD-30);
//!   gateway calls for it arrive here as top-level
//!   `{"type":"canvas_call", callId, projectId, mountSeq, method, params,
//!   timeoutMs?}` frames, including the host's own `host.snapshot` /
//!   `host.markSaved` when it closes the mount (AD-31).
//! - `canvas_unmount{projectId, mountSeq}`: it no longer does; the mount
//!   itself closes only through the host's AD-31 sequence.
//! - `{"type":"canvas_lease_lost", projectId, mountSeq}` (host → renderer):
//!   another renderer opened the canvas and the mount was saved and
//!   unmounted for it (AD-30). The connection's renderer is its
//!   `clientInstanceId`, so a reload or reconnect of the same window or tab
//!   can report its mount again.
//! - `canvas_reply{callId, mountSeq, ok, result | error: {code, message}}`:
//!   the answer to one `canvas_call`; `params` and `result` are JSON text.
//!   A long `result` is sent as several `canvas_reply` messages, each with
//!   `partial: true` but the last: `/ws` takes no message past tungstenite's
//!   default (16 MiB frame, 64 MiB message) from any peer, and a connection
//!   cannot raise that limit once it has authenticated. A slice is answered
//!   `{accepted}`; `false` tells the sender the call is gone or the reply
//!   passed the limit.
//!
//! The connection closing releases its mounts (`ConnectionCleanup`). Logs name
//! the project and method, never params or results.

use super::*;
use crate::acp::host_mcp::canvas::{
    CanvasCallFrame, CanvasHolder, CanvasLeaseLostFrame, CanvasMountPayload, CanvasReplyPayload,
    RendererId,
};

fn malformed(id: String, request: &str, want: &str, error: &serde_json::Error) -> WsReply {
    warn!(target: "termul::web::ws", "{request} refused: failure=malformed_payload");
    WsReply::err(
        id,
        WsErrorCode::Unsupported,
        format!("malformed {request} payload (want {want}): {error}"),
    )
}

/// The router's handle on this connection: frames go through its bounded
/// outbound queue without waiting. Its renderer is the authenticated
/// `clientInstanceId` (every post-auth request has one).
fn holder_for(env: &HandlerEnv) -> CanvasHolder {
    let connection_id = env.connection_id.to_string();
    let renderer = RendererId::new(env.identity.get().map_or_else(
        || connection_id.clone(),
        |identity| identity.client_instance_id.clone(),
    ));
    let calls = env.out_tx.clone();
    let notices = env.out_tx.clone();
    CanvasHolder::new(
        connection_id,
        renderer,
        Arc::new(move |frame: CanvasCallFrame| {
            calls.try_enqueue(Outbound::Canvas(frame)) == EnqueueOutcome::Enqueued
        }),
    )
    .with_lease_notice(Arc::new(move |frame: CanvasLeaseLostFrame| {
        notices.try_enqueue(Outbound::CanvasLeaseLost(frame)) == EnqueueOutcome::Enqueued
    }))
}

pub(super) fn handle_canvas_mount(id: String, payload: &Value, env: &HandlerEnv) -> WsReply {
    let parsed: CanvasMountPayload = match serde_json::from_value(payload.clone()) {
        Ok(parsed) => parsed,
        Err(error) => return malformed(id, "canvas_mount", "projectId, mountSeq", &error),
    };
    let holder = holder_for(env);
    let renderer = holder.renderer().clone();
    let router = env.acp.canvas_router();
    if router.mount(&parsed.project_id, parsed.mount_seq, holder) {
        return WsReply::ok(id, Some(json!({ "attached": true })));
    }
    let held_elsewhere = router
        .mounts()
        .lease_holder(&parsed.project_id)
        .is_some_and(|holder| holder != renderer);
    WsReply::ok(
        id,
        Some(json!({ "attached": false, "heldElsewhere": held_elsewhere })),
    )
}

pub(super) fn handle_canvas_unmount(id: String, payload: &Value, env: &HandlerEnv) -> WsReply {
    let parsed: CanvasMountPayload = match serde_json::from_value(payload.clone()) {
        Ok(parsed) => parsed,
        Err(error) => return malformed(id, "canvas_unmount", "projectId, mountSeq", &error),
    };
    let unmounted = env.acp.canvas_router().unmount(
        &parsed.project_id,
        &env.connection_id.to_string(),
        parsed.mount_seq,
    );
    WsReply::ok(id, Some(json!({ "unmounted": unmounted })))
}

pub(super) fn handle_canvas_reply(id: String, payload: &Value, env: &HandlerEnv) -> WsReply {
    let parsed = match CanvasReplyPayload::deserialize(payload) {
        Ok(parsed) => parsed,
        Err(error) => {
            return malformed(
                id,
                "canvas_reply",
                "callId, mountSeq, ok, result | error",
                &error,
            )
        }
    };
    let (call_id, mount_seq) = (parsed.call_id, parsed.mount_seq);
    if parsed.partial {
        let Some(slice) = parsed.result.as_deref().filter(|_| parsed.ok) else {
            warn!(target: "termul::web::ws", "canvas_reply refused: failure=partial_without_result");
            return WsReply::err(
                id,
                WsErrorCode::Unsupported,
                "a partial canvas_reply must be ok and carry a result",
            );
        };
        let accepted =
            env.acp
                .canvas_router()
                .reply_slice(&env.connection_id.to_string(), call_id, slice);
        return WsReply::ok(id, Some(json!({ "accepted": accepted })));
    }
    let resolved = env.acp.canvas_router().reply(
        &env.connection_id.to_string(),
        call_id,
        mount_seq,
        parsed.into_outcome(),
    );
    if !resolved {
        debug!(
            target: "termul::web::ws",
            call_id,
            "canvas_reply for a call that is no longer waiting"
        );
    }
    WsReply::ok(id, Some(json!({ "resolved": resolved })))
}
