//! `/ws` side of the command ledger: validate a request's `commandId`, admit
//! ledgered commands through [`run_command`] (the helper the Tauri `acp_*`
//! commands share), stamp `visible_at` on session-scoped replies and convert
//! between [`WsReply`] and the carrier-neutral [`Settled`] outcome.
//!
//! A request without a `commandId` keeps today's behavior (executed, never
//! recorded). Capability refusals happen before this module runs, so a refused
//! request leaves no ledger entry.

use serde_json::json;

use crate::web::command_ledger::{
    class_of, is_valid_command_id, run_command, ClassKind, Command, CommandResult, Fingerprint,
    Settled, MAX_COMMAND_ID_LEN,
};
use crate::web::prompt_turn::ReceiptKind;

use super::*;

/// `{"receipt": "in_progress" | "accepted"}`.
fn receipt_payload(kind: ReceiptKind) -> Value {
    serde_json::to_value(crate::web::prompt_turn::PromptReceipt { receipt: kind })
        .unwrap_or(Value::Null)
}

/// Run one post-auth request: admit it through the ledger when it carries a
/// `commandId` and its class is ledgered, otherwise route it directly.
pub(super) async fn execute_request(request: WsRequest, env: &HandlerEnv) -> WsReply {
    let Some((kind, class)) = class_of(&request.type_) else {
        return route_request(request, env).await;
    };
    let Some(command_id) = request
        .command_id
        .as_deref()
        .filter(|_| class.kind != ClassKind::Read)
    else {
        return route_and_stamp(request, env).await;
    };
    if !is_valid_command_id(command_id) {
        return WsReply::err(
            request.id,
            WsErrorCode::InvalidCommandId,
            format!(
                "commandId must be 1-{MAX_COMMAND_ID_LEN} characters of A-Z, a-z, 0-9, `_` or `-`"
            ),
        );
    }
    if !class.ledgered() {
        return route_and_stamp(request, env).await;
    }

    let id = request.id.clone();
    let command_id = command_id.to_string();
    let command = Command {
        id: &command_id,
        kind,
        class,
        fingerprint: Fingerprint::of(kind, &request.payload),
    };
    let job_env = env.clone();
    let result = run_command(
        &env.relay,
        &env.acp,
        command,
        async move { settled_of(&route_and_stamp(request, &job_env).await) },
    )
    .await;
    reply_of(id, kind, result)
}

/// Route `request` and set `visible_at` on an ok reply of a session-scoped
/// mutation.
async fn route_and_stamp(request: WsRequest, env: &HandlerEnv) -> WsReply {
    let mutation = class_of(&request.type_).is_some_and(|(_, class)| class.kind != ClassKind::Read);
    let payload_session = request
        .payload
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let mut reply = route_request(request, env).await;
    if mutation && reply.ok {
        let session = payload_session.or_else(|| {
            reply
                .payload
                .as_ref()
                .and_then(|payload| payload.get("sessionId"))
                .and_then(Value::as_str)
                .map(str::to_string)
        });
        if let Some(session) = session {
            // The seq the effect is visible at: the session frontier after
            // the effect was enqueued. `0` (no log yet) means "visible on
            // reply", which the field's absence already says.
            let seq = env.relay.session_watermark(&session);
            if seq > 0 {
                reply.visible_at = Some(json!(seq));
            }
        }
    }
    reply
}

/// The carrier-neutral outcome of a reply.
fn settled_of(reply: &WsReply) -> Settled {
    match &reply.err {
        Some(error) if !reply.ok => Settled::Rejected {
            code: error.code.clone(),
            message: error.message.clone(),
        },
        _ => Settled::Accepted {
            payload: reply.payload.clone(),
            visible_at: reply.visible_at.clone().and_then(|value| value.as_u64()),
        },
    }
}

/// The reply for a ledger verdict.
fn reply_of(id: String, kind: &str, result: CommandResult) -> WsReply {
    match result {
        CommandResult::Done(Settled::Accepted { payload, visible_at }) => {
            let mut reply = WsReply::ok(
                id,
                Some(payload.unwrap_or_else(|| receipt_payload(ReceiptKind::Accepted))),
            );
            reply.visible_at = visible_at.map(|seq| json!(seq));
            reply
        }
        CommandResult::Done(Settled::Rejected { code, message }) => {
            WsReply::err_with_code(id, code, message)
        }
        CommandResult::InProgress => WsReply::ok(id, Some(receipt_payload(ReceiptKind::InProgress))),
        CommandResult::Unknown => WsReply::err(
            id,
            WsErrorCode::OutcomeUnknown,
            format!(
                "the outcome of this `{kind}` is no longer known; it was not run again. Check the entity's state before retrying"
            ),
        ),
        CommandResult::Conflict => WsReply::err(
            id,
            WsErrorCode::CommandConflict,
            format!("this commandId was already used for a different `{kind}` request"),
        ),
    }
}

/// `send_prompt`'s `turnId` is its `commandId`: a request carrying only a
/// `commandId` uses it as the turn id, and one carrying both must agree.
/// `Err` is the final refusal reply.
#[allow(clippy::result_large_err)]
pub(super) fn prompt_payload_with_turn_id(request: &WsRequest) -> Result<Value, WsReply> {
    let Some(command_id) = request.command_id.as_deref() else {
        return Ok(request.payload.clone());
    };
    if !is_valid_command_id(command_id) {
        return Err(WsReply::err(
            request.id.clone(),
            WsErrorCode::InvalidCommandId,
            format!(
                "commandId must be 1-{MAX_COMMAND_ID_LEN} characters of A-Z, a-z, 0-9, `_` or `-`"
            ),
        ));
    }
    let turn_id = request
        .payload
        .get("turnId")
        .and_then(Value::as_str)
        .filter(|turn_id| !turn_id.is_empty());
    match turn_id {
        Some(turn_id) if turn_id != command_id => Err(WsReply::err(
            request.id.clone(),
            WsErrorCode::InvalidCommandId,
            "send_prompt's commandId is its turnId; the two must be equal",
        )),
        Some(_) => Ok(request.payload.clone()),
        None => {
            let mut payload = request.payload.clone();
            if let Some(fields) = payload.as_object_mut() {
                fields.insert("turnId".to_string(), json!(command_id));
            }
            Ok(payload)
        }
    }
}
