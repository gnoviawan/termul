//! Session payload parser. Field retention is filled in by later tests.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Submit and completion outcomes. Externally these are the variant names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SessionRpcResult {
    Accepted,
    PreWrite,
    Partial,
    NotStarted,
}

#[derive(Debug, PartialEq)]
pub enum Frame {
    PromptReady {
        nonce: String,
        prompt_generation: u64,
        line_empty: bool,
        prompt_suppressed: bool,
        cwd: String,
    },
    CommandStarted {
        nonce: Option<String>,
    },
    CommandFinished {
        nonce: Option<String>,
        exit_code: Option<i32>,
    },
    InitShell {
        session_id: String,
        nonce: String,
    },
    Completion(CompletionResult),
}

/// Validity fields plus the completer output. Not a mode frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletionResult {
    pub session_id: String,
    pub nonce: String,
    pub request_id: String,
    pub buffer_revision: u64,
    pub cursor: u64,
    pub prompt_generation: u64,
    pub cwd: String,
    pub output: String,
}

#[derive(Debug, PartialEq, Eq)]
pub struct ParseError;

fn require_string(payload: &Value, name: &str) -> Result<String, ParseError> {
    match payload.get(name).and_then(Value::as_str) {
        Some(value) => Ok(value.to_string()),
        None => Err(ParseError),
    }
}

fn require_u64(payload: &Value, name: &str) -> Result<u64, ParseError> {
    match payload.get(name).and_then(Value::as_u64) {
        Some(value) => Ok(value),
        None => Err(ParseError),
    }
}

fn require_bool(payload: &Value, name: &str) -> Result<bool, ParseError> {
    match payload.get(name).and_then(Value::as_bool) {
        Some(value) => Ok(value),
        None => Err(ParseError),
    }
}

fn frame_nonce(frame: &Frame) -> Option<&str> {
    match frame {
        Frame::PromptReady { nonce, .. } | Frame::InitShell { nonce, .. } => Some(nonce),
        Frame::CommandStarted { nonce } | Frame::CommandFinished { nonce, .. } => nonce.as_deref(),
        Frame::Completion(result) => Some(&result.nonce),
    }
}

/// Parse a session payload. A PromptReady that omits a field is rejected.
/// False flags stay on the frame. This parser does not decide raw mode.
/// A caller-supplied nonce that does not match is rejected and is not a mode signal.
pub fn parse(payload: &Value, registered_nonce: Option<&str>) -> Result<Frame, ParseError> {
    let frame = parse_frame(payload)?;
    if let Some(expected) = registered_nonce {
        if frame_nonce(&frame) != Some(expected) {
            return Err(ParseError);
        }
    }
    Ok(frame)
}

fn optional_nonce(payload: &Value) -> Result<Option<String>, ParseError> {
    payload
        .get("nonce")
        .map(|_| require_string(payload, "nonce"))
        .transpose()
}

fn parse_frame(payload: &Value) -> Result<Frame, ParseError> {
    match payload.get("type").and_then(Value::as_str) {
        Some("CommandStarted") => {
            return Ok(Frame::CommandStarted {
                nonce: optional_nonce(payload)?,
            });
        }
        Some("Completion") => {
            return Ok(Frame::Completion(CompletionResult {
                session_id: require_string(payload, "session_id")?,
                nonce: require_string(payload, "nonce")?,
                request_id: require_string(payload, "request_id")?,
                buffer_revision: require_u64(payload, "buffer_revision")?,
                cursor: require_u64(payload, "cursor")?,
                prompt_generation: require_u64(payload, "prompt_generation")?,
                cwd: require_string(payload, "cwd")?,
                output: require_string(payload, "output")?,
            }));
        }
        _ => {}
    }
    if payload.get("type").and_then(Value::as_str) == Some("InitShell") {
        return Ok(Frame::InitShell {
            session_id: require_string(payload, "session_id")?,
            nonce: require_string(payload, "nonce")?,
        });
    }
    if payload.get("type").and_then(Value::as_str) == Some("CommandFinished") {
        let exit_code = payload
            .get("exit_code")
            .and_then(Value::as_i64)
            .and_then(|code| i32::try_from(code).ok());
        return Ok(Frame::CommandFinished {
            nonce: optional_nonce(payload)?,
            exit_code,
        });
    }
    if payload.get("type").and_then(Value::as_str) != Some("PromptReady") {
        return Err(ParseError);
    }
    let line_empty = require_bool(payload, "line_empty")?;
    let prompt_suppressed = require_bool(payload, "prompt_suppressed")?;
    Ok(Frame::PromptReady {
        nonce: require_string(payload, "nonce")?,
        prompt_generation: require_u64(payload, "prompt_generation")?,
        line_empty,
        prompt_suppressed,
        cwd: require_string(payload, "cwd")?,
    })
}
