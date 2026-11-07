//! The canvas `Bridge`: Troupe's implementation of figcraft-mcp's `Backend`
//! (spine AD-18), living in the `host_mcp` child.
//!
//! `call` sends one `Canvas` frame to the parent over the same loopback TCP
//! channel the other host tools use and blocks until the parent answers. The
//! parent's router forwards it to the renderer holding the session's project
//! canvas and owns the call timeout (AD-29), so the bridge sets none and holds
//! no document state. Errors come back as the JSON encoding of `{code,
//! message}`, the only shape `Backend` can carry.
//!
//! `events.poll` is the one call that sends several frames: the editor page
//! answers it at once, so the bridge gives `wait_for_changes` the long poll
//! figcraft's own control server gives it ([`Bridge::poll_events`]).
//!
//! The trait is synchronous, so the bridge uses blocking std sockets: callers
//! on an async runtime run it on a blocking thread.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

use base64::Engine as _;
use figcraft_mcp::Backend;
use serde_json::{json, Value};

use crate::acp::host_mcp::canvas::{CanvasError, CanvasErrorCode};
use crate::acp::host_mcp::child::ChildConfig;
use crate::acp::host_mcp::{FrameKind, FrameReply, FrameRequest, MAX_REQUEST_FRAME_BYTES};

/// Replies carry rendered PNGs and exports as base64, so the cap is far above
/// the other host tools' 1 MiB.
pub const MAX_REPLY_BYTES: u64 = 256 * 1024 * 1024;

const EVENTS_POLL: &str = "events.poll";
const POLL_INTERVAL: Duration = Duration::from_millis(250);

pub struct Bridge {
    config: ChildConfig,
    /// The agent tool this bridge serves, named in the gateway's logs.
    tool: Option<String>,
}

impl Bridge {
    #[must_use]
    pub fn new(config: ChildConfig) -> Self {
        Self { config, tool: None }
    }

    #[must_use]
    pub fn with_tool(mut self, tool: &str) -> Self {
        self.tool = Some(tool.to_string());
        self
    }

    fn request(&self, method: &str, params: &Value) -> Result<Value, CanvasError> {
        let frame = FrameRequest {
            token: self.config.token.clone(),
            session_id: self.config.session_id.clone(),
            kind: FrameKind::Canvas,
            canvas_method: Some(method.to_string()),
            canvas_params: Some(params.to_string()),
            canvas_tool: self.tool.clone(),
            ..FrameRequest::default()
        };
        let mut line = serde_json::to_vec(&frame).map_err(|error| {
            CanvasError::new(
                CanvasErrorCode::EngineError,
                format!("could not encode the canvas request: {error}"),
            )
        })?;
        line.push(b'\n');
        // The parent would cut an oversize line short and answer it like a
        // gateway refusal, which reads as "the canvas is closed".
        if line.len() as u64 > MAX_REQUEST_FRAME_BYTES {
            return Err(CanvasError::new(
                CanvasErrorCode::EngineError,
                format!(
                    "the {method} request is {} bytes, over the canvas gateway's {} byte limit; send smaller params",
                    line.len(),
                    MAX_REQUEST_FRAME_BYTES
                ),
            ));
        }
        let reply = exchange(self.config.port, &line).map_err(|error| {
            CanvasError::new(
                CanvasErrorCode::CanvasClosed,
                format!("the canvas gateway is unreachable: {error}"),
            )
        })?;
        if !reply.ok {
            let message = reply.error.unwrap_or_else(|| "unknown error".to_string());
            // A refusal without a code (auth, session not ready) means the
            // gateway cannot reach any canvas for this session. Turn routing
            // refusals carry their own codes (NO_ACTIVE_TURN,
            // AMBIGUOUS_SESSION) so the agent is not told to open a canvas
            // that is already open.
            let code = reply
                .code
                .as_deref()
                .map_or(CanvasErrorCode::CanvasClosed, CanvasErrorCode::parse);
            return Err(CanvasError::new(code, message));
        }
        let text = match reply.result {
            Some(Value::String(text)) => text,
            _ => {
                return Err(CanvasError::new(
                    CanvasErrorCode::EngineError,
                    "the canvas gateway returned no result",
                ))
            }
        };
        serde_json::from_str(&text).map_err(|error| {
            CanvasError::new(
                CanvasErrorCode::EngineError,
                format!("the editor returned invalid JSON: {error}"),
            )
        })
    }

    /// The page's one thread draws the editor and runs its commands, so it
    /// answers `events.poll` at once rather than wait for events no one could
    /// add meanwhile. Poll it again with the same params until events arrive,
    /// the event log resets, or the wait passes, then return the last reply.
    /// A later poll that times out (a busy editor near the deadline) returns
    /// the last reply instead, so the wait never ends in `CANVAS_TIMEOUT`
    /// after the editor has answered once.
    fn poll_events(&self, params: &Value) -> Result<Value, CanvasError> {
        let deadline = Instant::now() + poll_wait(params);
        let mut last: Option<Value> = None;
        loop {
            let reply = match (self.request(EVENTS_POLL, params), last.take()) {
                (Ok(reply), _) => reply,
                (Err(error), Some(previous)) if error.code == CanvasErrorCode::CanvasTimeout => {
                    return Ok(previous)
                }
                (Err(error), _) => return Err(error),
            };
            let woke = reply["events"]
                .as_array()
                .is_some_and(|events| !events.is_empty())
                || reply["reset"] == true;
            let left = deadline.saturating_duration_since(Instant::now());
            if woke || left.is_zero() {
                return Ok(reply);
            }
            last = Some(reply);
            std::thread::sleep(left.min(POLL_INTERVAL));
        }
    }
}

/// How long `events.poll` waits for events, as figcraft's control server has
/// it (`control_server.rs` `event_poll`): `timeoutMs`, 20 s by default and at
/// most 25 s.
fn poll_wait(params: &Value) -> Duration {
    let millis = params
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(20_000)
        .min(25_000);
    Duration::from_millis(millis)
}

/// One encoded frame line out, one newline-terminated reply in, on a fresh
/// connection.
fn exchange(port: u16, line: &[u8]) -> Result<FrameReply, String> {
    let mut stream =
        TcpStream::connect(("127.0.0.1", port)).map_err(|e| format!("connect failed: {e}"))?;
    stream
        .write_all(line)
        .map_err(|e| format!("write frame: {e}"))?;
    let mut reader = BufReader::new(stream.take(MAX_REPLY_BYTES));
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|e| format!("read reply: {e}"))?;
    serde_json::from_str(&line).map_err(|e| format!("decode reply: {e}"))
}

impl Backend for Bridge {
    fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let reply = if method == EVENTS_POLL {
            self.poll_events(&params)
        } else {
            self.request(method, &params)
        };
        reply.map_err(|error| error.to_backend_string_for(self.tool.as_deref()))
    }

    fn has_ui(&self) -> bool {
        true
    }

    fn describe(&self) -> String {
        "Troupe canvas".to_string()
    }

    /// The fork replaces `ui.render`'s file path with `host.renderPng`, which
    /// answers bare base64.
    fn render_png(&mut self, ids: &[u64], scale: f64) -> Result<Vec<u8>, String> {
        let mut params = json!({ "scale": scale });
        if !ids.is_empty() {
            params["ids"] = json!(ids);
        }
        let encoded = self.call("host.renderPng", params)?;
        let Some(encoded) = encoded.as_str() else {
            return Err(CanvasError::new(
                CanvasErrorCode::EngineError,
                "host.renderPng returned no base64",
            )
            .to_backend_string_for(self.tool.as_deref()));
        };
        base64::engine::general_purpose::STANDARD
            .decode(encoded.trim())
            .map_err(|error| {
                CanvasError::new(
                    CanvasErrorCode::EngineError,
                    format!("host.renderPng returned invalid base64: {error}"),
                )
                .to_backend_string_for(self.tool.as_deref())
            })
    }
}

#[cfg(test)]
mod tests;
