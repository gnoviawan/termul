//! Shared dispatch to the target PTY's session gate for both RPC carriers.

use super::frame::SessionRpcResult;
use super::gate::{CompletionRequest, CompletionStart};

/// Host deadline before a completion enters draining.
pub const COMPLETION_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(1500);
use crate::pty::claims::{ClaimError, ClaimWriteLease};
use crate::pty::PtyManager;

pub async fn submit(
    pty: &PtyManager,
    terminal_id: &str,
    draft: &str,
    allow_write: bool,
) -> SessionRpcResult {
    submit_authorized(pty, terminal_id, draft, allow_write, None)
        .await
        .unwrap_or(SessionRpcResult::NotStarted)
}

pub async fn submit_authorized(
    pty: &PtyManager,
    terminal_id: &str,
    draft: &str,
    allow_write: bool,
    authorization: Option<&ClaimWriteLease<'_>>,
) -> Result<SessionRpcResult, ClaimError> {
    let result = match pty.get(terminal_id) {
        Some(terminal) => {
            terminal
                .session_gate
                .submit_authorized(draft, allow_write, authorization)
                .await?
        }
        None => SessionRpcResult::NotStarted,
    };
    Ok(record_result("submit", result))
}

/// Terminal outcome of an admitted completion request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum CompletionOutcome {
    Completed,
    Cancelled,
    Dropped,
    TimedOut,
}

/// Client-visible completion fields; shell credentials never leave the host.
#[derive(Debug, serde::Serialize)]
pub struct CompletionResult {
    pub request_id: String,
    pub buffer_revision: u64,
    pub cursor: u64,
    pub prompt_generation: u64,
    pub cwd: String,
    pub output: String,
}

impl From<super::frame::CompletionResult> for CompletionResult {
    fn from(frame: super::frame::CompletionResult) -> Self {
        Self {
            request_id: frame.request_id,
            buffer_revision: frame.buffer_revision,
            cursor: frame.cursor,
            prompt_generation: frame.prompt_generation,
            cwd: frame.cwd,
            output: frame.output,
        }
    }
}

/// Reply shared by desktop and websocket transports.
#[derive(Debug, serde::Serialize)]
pub struct CompletionReply {
    pub result: SessionRpcResult,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<CompletionOutcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completion: Option<CompletionResult>,
}

pub async fn request_completion(
    pty: &PtyManager,
    terminal_id: &str,
    request: &CompletionRequest,
    allow_write: bool,
) -> CompletionReply {
    wait_for_completion(admit_completion(pty, terminal_id, request, allow_write).await).await
}

/// Admission is serialized by each transport; only waiting may be spawned.
pub async fn admit_completion(
    pty: &PtyManager,
    terminal_id: &str,
    request: &CompletionRequest,
    allow_write: bool,
) -> CompletionStart {
    admit_completion_authorized(pty, terminal_id, request, allow_write, None)
        .await
        .unwrap_or_else(|_| CompletionStart::without_waiter(SessionRpcResult::NotStarted))
}

pub async fn admit_completion_authorized(
    pty: &PtyManager,
    terminal_id: &str,
    request: &CompletionRequest,
    allow_write: bool,
    authorization: Option<&ClaimWriteLease<'_>>,
) -> Result<CompletionStart, ClaimError> {
    let start = if let Some(terminal) = pty.get(terminal_id) {
        if let Some(provider) = terminal.session_gate.first_completion_provider() {
            let start = terminal
                .session_gate
                .request_completion_authorized(request, &provider, allow_write, authorization)
                .await?;
            if let Some(epoch) = start.epoch {
                terminal.session_gate.start_completion_watchdog(epoch);
            }
            start
        } else {
            CompletionStart::without_waiter(SessionRpcResult::NotStarted)
        }
    } else {
        CompletionStart::without_waiter(SessionRpcResult::NotStarted)
    };
    record_result("request_completion", start.result);
    Ok(start)
}

pub async fn wait_for_completion(start: CompletionStart) -> CompletionReply {
    let result = start.result;
    let mut reply = CompletionReply {
        result,
        outcome: None,
        completion: None,
    };
    if let Some(waiter) = start.waiter {
        match waiter.await {
            Ok(Ok(frame)) => {
                reply.outcome = Some(CompletionOutcome::Completed);
                reply.completion = Some(frame.into());
            }
            Ok(Err(outcome)) => reply.outcome = Some(outcome),
            Err(_) => reply.outcome = Some(CompletionOutcome::Cancelled),
        }
    }
    reply
}

pub async fn cancel_completion(
    pty: &PtyManager,
    terminal_id: &str,
    request_id: &str,
) -> SessionRpcResult {
    let released = pty
        .get(terminal_id)
        .is_some_and(|terminal| terminal.session_gate.cancel_completion(request_id));
    let result = if released {
        SessionRpcResult::Accepted
    } else {
        SessionRpcResult::NotStarted
    };
    record_result("cancel_completion", result)
}

pub async fn restore_prompt(
    pty: &PtyManager,
    terminal_id: &str,
    allow_write: bool,
) -> SessionRpcResult {
    restore_prompt_authorized(pty, terminal_id, allow_write, None)
        .await
        .unwrap_or(SessionRpcResult::NotStarted)
}

pub async fn restore_prompt_authorized(
    pty: &PtyManager,
    terminal_id: &str,
    allow_write: bool,
    authorization: Option<&ClaimWriteLease<'_>>,
) -> Result<SessionRpcResult, ClaimError> {
    let result = match pty.get(terminal_id) {
        Some(terminal) => {
            terminal
                .session_gate
                .restore_prompt_authorized(allow_write, authorization)
                .await?
        }
        None => SessionRpcResult::NotStarted,
    };
    Ok(record_result("restore_prompt", result))
}

fn record_result(operation: &str, result: SessionRpcResult) -> SessionRpcResult {
    log::debug!("[session-rpc] operation={operation} result={result:?}");
    tracing::debug!("[session-rpc] operation={operation} result={result:?}");
    result
}

/// Encodes an owner's namespace and request id as shell-safe, unambiguous bytes.
pub fn owned_request_id(owner: &str, request_id: &str) -> String {
    fn hex(value: &str) -> String {
        value
            .as_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }
    format!("{}:{}", hex(owner), hex(request_id))
}

/// Restores the client-local id after the gate has checked the owner's namespace.
pub fn local_completion_reply(mut reply: CompletionReply, request_id: String) -> CompletionReply {
    if let Some(completion) = &mut reply.completion {
        completion.request_id = request_id;
    }
    reply
}
