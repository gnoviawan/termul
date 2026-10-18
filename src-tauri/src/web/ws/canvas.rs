//! The canvas gateway's renderer leg on `/ws` (spine AD-21, AD-29): the same
//! requests and frame on the desktop Channel and on a browser socket.
//!
//! - `canvas_mount{projectId, mountSeq}`: this connection now runs the
//!   project's mount (`{attached: false}` when the host holds no such mount);
//!   gateway calls for it arrive here as top-level
//!   `{"type":"canvas_call", callId, projectId, mountSeq, method, params}`
//!   frames, including the host's own `host.snapshot` / `host.markSaved`
//!   when it closes the mount (AD-31).
//! - `canvas_unmount{projectId, mountSeq}`: it no longer does; the mount
//!   itself closes only through the host's AD-31 sequence.
//! - `canvas_reply{callId, mountSeq, ok, result | error: {code, message}}`:
//!   the answer to one `canvas_call`; `params` and `result` are JSON text.
//!
//! The connection closing releases its mounts (`ConnectionCleanup`). Logs name
//! the project and method, never params or results.

use super::*;
use crate::acp::host_mcp::canvas::{
    CanvasCallFrame, CanvasHolder, CanvasMountPayload, CanvasReplyPayload,
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
/// outbound queue without waiting.
fn holder_for(env: &HandlerEnv) -> CanvasHolder {
    let out = env.out_tx.clone();
    CanvasHolder::new(
        env.connection_id.to_string(),
        Arc::new(move |frame: CanvasCallFrame| {
            out.try_enqueue(Outbound::Canvas(frame)) == EnqueueOutcome::Enqueued
        }),
    )
}

pub(super) fn handle_canvas_mount(id: String, payload: &Value, env: &HandlerEnv) -> WsReply {
    let parsed: CanvasMountPayload = match serde_json::from_value(payload.clone()) {
        Ok(parsed) => parsed,
        Err(error) => return malformed(id, "canvas_mount", "projectId, mountSeq", &error),
    };
    let attached =
        env.acp
            .canvas_router()
            .mount(&parsed.project_id, parsed.mount_seq, holder_for(env));
    WsReply::ok(id, Some(json!({ "attached": attached })))
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
    let parsed: CanvasReplyPayload = match serde_json::from_value(payload.clone()) {
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
