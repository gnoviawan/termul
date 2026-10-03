//! Platform-neutral CDP protocol helpers for the trusted Windows eval
//! transport (spec `spec-acp-browser-automation-v2`).
//!
//! Pure JSON-in/JSON-out seams so the protocol details — method name,
//! `Runtime.evaluate` params, reply parsing, and the failure
//! classification that drives the JS-eval bridge fallback decision — are
//! unit-testable on every platform. The Windows-only `cdp` module shells
//! these into `CallDevToolsProtocolMethod` round trips.
//!
//! Fallback policy: only commands that never reached the page may retry
//! through the JS-eval bridge. A script that ran (page exception) or may
//! have run (result timeout) could double-apply side effects when
//! re-executed — fill re-fires input/change events, press Enter re-clicks
//! — so every other failure kind is terminal.

use serde_json::{json, Value};

use super::BrowserError;

/// CDP method for the trusted eval transport.
pub(super) const EVALUATE_METHOD: &str = "Runtime.evaluate";

/// Why a CDP eval attempt failed — drives the bridge-fallback decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CdpEvalFailureKind {
    /// The command never reached the page: webview lookup, UI-thread
    /// dispatch, or issue-phase failure/timeout. The script did not run,
    /// so a bridge retry is side-effect-safe.
    NotDelivered,
    /// The page script ran and threw (`exceptionDetails`).
    PageException,
    /// The command was issued but no reply arrived in time (result
    /// timeout or a dropped completion) — the script may have run.
    NoReply,
    /// The protocol answered with an error (CDP-level error reply body or
    /// a completion error).
    ProtocolError,
    /// A reply arrived but carried no usable result (unparseable JSON,
    /// missing or malformed `result`).
    MalformedReply,
}

/// A CDP eval failure: the wire-typed error plus why it failed.
#[derive(Debug)]
pub(super) struct CdpEvalError {
    /// Wire-typed error (code + message) — returned to the agent when the
    /// attempt is terminal.
    pub(super) error: BrowserError,
    /// Why the attempt failed — see [`CdpEvalFailureKind`].
    pub(super) kind: CdpEvalFailureKind,
}

impl CdpEvalError {
    pub(super) fn new(kind: CdpEvalFailureKind, error: BrowserError) -> Self {
        Self { error, kind }
    }
}

/// Pure fallback decision: retry the JS-eval bridge only when the CDP
/// command never reached the page. A page exception already ran the
/// script, a missing reply means it may have, and error/malformed replies
/// mean the command was processed — re-running a mutating script could
/// double its side effects, so every other kind is terminal.
pub(super) fn should_fallback_to_bridge(err: &CdpEvalError) -> bool {
    err.kind == CdpEvalFailureKind::NotDelivered
}

/// `Runtime.evaluate` params (pure — pinned by unit tests). `returnByValue`
/// ships the completion value back as JSON; `awaitPromise` resolves promise
/// results before replying.
pub(super) fn evaluate_params(expression: &str) -> Value {
    json!({
        "expression": expression,
        "returnByValue": true,
        "awaitPromise": true,
    })
}

/// Parse a `Runtime.evaluate` reply (pure — pinned by unit tests): the
/// completion value (an absent `value` key means `undefined` → null, parity
/// with the bridge's `JSON.stringify` handling), or a classified failure.
/// Protocol error replies, page exceptions, and malformed replies are all
/// terminal — the command was processed, so the script may have run.
pub(super) fn parse_evaluate_result(out: &Value) -> Result<Value, CdpEvalError> {
    // Protocol-level error body (e.g. method rejected): surface the CDP
    // error string.
    if let Some(err) = out.get("error").filter(|e| e.is_object()) {
        let text = err
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("cdp protocol error");
        return Err(CdpEvalError::new(
            CdpEvalFailureKind::ProtocolError,
            BrowserError::internal(format!("cdp error: {text}")),
        ));
    }
    // A JSON `null` exceptionDetails must not enter the exception branch.
    if let Some(exc) = out.get("exceptionDetails").filter(|e| e.is_object()) {
        // The description can quote page content — it flows back to the
        // agent that invoked the script, but must never reach the logs
        // (CWE-532).
        let detail = exc
            .get("exception")
            .and_then(|x| x.get("description"))
            .and_then(Value::as_str)
            .or_else(|| exc.get("text").and_then(Value::as_str))
            .unwrap_or("page script exception");
        return Err(CdpEvalError::new(
            CdpEvalFailureKind::PageException,
            BrowserError::internal(format!("eval exception: {detail}")),
        ));
    }
    match out.get("result") {
        Some(r) if r.is_object() => Ok(r.get("value").cloned().unwrap_or(Value::Null)),
        _ => Err(CdpEvalError::new(
            CdpEvalFailureKind::MalformedReply,
            BrowserError::internal("Runtime.evaluate reply missing or malformed result"),
        )),
    }
}
