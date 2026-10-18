//! figcraft's agent surface in the host `termul` MCP child (spine AD-18,
//! AD-21): its tools, resources and prompts, answered by `figcraft-mcp` itself
//! over a [`Bridge`].
//!
//! The tool list is read from `figcraft_mcp::tool_definitions()` at runtime
//! rather than mirrored as `#[tool]` functions (SPEC Q6), so names, schemas and
//! descriptions are the pinned crate's and cannot drift. Resources and prompts
//! go through figcraft's own JSON-RPC handler for the same reason.
//!
//! `Bridge` blocks on std sockets and the child runs a current-thread runtime,
//! so every figcraft call runs on a blocking thread.

use rmcp::model::{CallToolResult, ContentBlock, ErrorCode, Tool};
use rmcp::ErrorData;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

use crate::acp::host_mcp::bridge::Bridge;
use crate::acp::host_mcp::child::ChildConfig;

/// figcraft's tools as rmcp definitions.
#[must_use]
pub fn tools() -> Vec<Tool> {
    figcraft_mcp::tool_definitions()
        .into_iter()
        .filter_map(
            |definition| match serde_json::from_value::<Tool>(definition) {
                Ok(tool) => Some(tool),
                Err(error) => {
                    eprintln!("[host-mcp-child] skipped a figcraft tool definition: {error}");
                    None
                }
            },
        )
        .collect()
}

/// Run one figcraft tool against the session's canvas. Every failure is a
/// tool error the agent reads, as in figcraft's own server.
pub async fn call_tool(config: ChildConfig, name: String, arguments: Value) -> CallToolResult {
    let ran = tokio::task::spawn_blocking(move || {
        let mut bridge = Bridge::new(config).with_tool(&name);
        figcraft_mcp::call_tool(&mut bridge, &name, &arguments).to_value()
    })
    .await;
    let result = match ran {
        Ok(value) => complete::<CallToolResult>(value)
            .map_err(|error| format!("the canvas tool returned an unreadable result: {error}")),
        Err(error) => Err(format!("the canvas tool stopped: {error}")),
    };
    result.unwrap_or_else(|message| CallToolResult::error(vec![ContentBlock::text(message)]))
}

/// One resources or prompts request, answered by figcraft's own server.
pub async fn request<T>(
    config: ChildConfig,
    method: &'static str,
    params: Value,
) -> Result<T, ErrorData>
where
    T: DeserializeOwned,
{
    let reply = tokio::task::spawn_blocking(move || {
        let bridge = Bridge::new(config).with_tool(method);
        figcraft_mcp::Server::new(Box::new(bridge)).handle(json!({
            "jsonrpc": "2.0",
            "id": 0,
            "method": method,
            "params": params,
        }))
    })
    .await
    .map_err(|error| ErrorData::internal_error(format!("{method} stopped: {error}"), None))?
    .ok_or_else(|| ErrorData::internal_error(format!("{method} gave no reply"), None))?;
    if let Some(error) = reply.get("error") {
        let code = error
            .get("code")
            .and_then(Value::as_i64)
            .and_then(|code| i32::try_from(code).ok())
            .unwrap_or(ErrorCode::INTERNAL_ERROR.0);
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("figcraft request failed")
            .to_string();
        return Err(ErrorData::new(ErrorCode(code), message, None));
    }
    complete(reply.get("result").cloned().unwrap_or(Value::Null)).map_err(|error| {
        ErrorData::internal_error(
            format!("{method} returned an unreadable result: {error}"),
            None,
        )
    })
}

/// figcraft speaks MCP 2025-06-18, which has no `resultType`; rmcp clears it
/// again for clients on older revisions.
fn complete<T: DeserializeOwned>(mut result: Value) -> Result<T, serde_json::Error> {
    if let Some(fields) = result.as_object_mut() {
        fields
            .entry("resultType")
            .or_insert_with(|| Value::String("complete".to_string()));
    }
    serde_json::from_value(result)
}
