//! The canvas `Bridge`: Termul's implementation of figcraft-mcp's `Backend`
//! (spine AD-18), living in the `host_mcp` child.
//!
//! `call` sends one `Canvas` frame to the parent over the same loopback TCP
//! channel the other host tools use and blocks until the parent answers. The
//! parent's router forwards it to the renderer holding the session's project
//! canvas and owns the call timeout (AD-29), so the bridge sets none and holds
//! no document state. Errors come back as the JSON encoding of `{code,
//! message}`, the only shape `Backend` can carry.
//!
//! The trait is synchronous, so the bridge uses blocking std sockets: callers
//! on an async runtime run it on a blocking thread.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;

use base64::Engine as _;
use figcraft_mcp::Backend;
use serde_json::{json, Value};

use crate::acp::host_mcp::canvas::{CanvasError, CanvasErrorCode};
use crate::acp::host_mcp::child::ChildConfig;
use crate::acp::host_mcp::{FrameKind, FrameReply, FrameRequest};

/// Replies carry rendered PNGs and exports as base64, so the cap is far above
/// the other host tools' 1 MiB.
const MAX_REPLY_BYTES: u64 = 256 * 1024 * 1024;

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
            todos: Vec::new(),
            title: None,
            branch: None,
            browser_action: None,
            browser_args: None,
            browser_element: None,
            ask: None,
            canvas_method: Some(method.to_string()),
            canvas_params: Some(params.to_string()),
            canvas_tool: self.tool.clone(),
        };
        let reply = exchange(self.config.port, &frame).map_err(|error| {
            CanvasError::new(
                CanvasErrorCode::CanvasClosed,
                format!("the canvas gateway is unreachable: {error}"),
            )
        })?;
        if !reply.ok {
            let message = reply.error.unwrap_or_else(|| "unknown error".to_string());
            // A refusal without a code (auth, no active turn) means the
            // gateway cannot reach any canvas for this session.
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
}

/// One frame out, one newline-terminated reply in, on a fresh connection.
fn exchange(port: u16, frame: &FrameRequest) -> Result<FrameReply, String> {
    let mut stream =
        TcpStream::connect(("127.0.0.1", port)).map_err(|e| format!("connect failed: {e}"))?;
    let mut buf = serde_json::to_vec(frame).map_err(|e| format!("encode frame: {e}"))?;
    buf.push(b'\n');
    stream
        .write_all(&buf)
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
        self.request(method, &params)
            .map_err(|error| error.to_backend_string())
    }

    fn has_ui(&self) -> bool {
        true
    }

    fn describe(&self) -> String {
        "Termul canvas".to_string()
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
            .to_backend_string());
        };
        base64::engine::general_purpose::STANDARD
            .decode(encoded.trim())
            .map_err(|error| {
                CanvasError::new(
                    CanvasErrorCode::EngineError,
                    format!("host.renderPng returned invalid base64: {error}"),
                )
                .to_backend_string()
            })
    }
}

#[cfg(test)]
mod tests;
