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

/// Prefixed to every canvas tool's description. Some MCP clients never show
/// the server `instructions` to the model, and upstream's descriptions call
/// the editor "FigCraft", so without this an agent cannot tell that
/// `create_node` or `run_command` draw on the project's canvas.
pub const DESCRIPTION_TAG: &str = "Termul Canvas (this project's design canvas, a .figcraft \
document; change it only through these tools, never by editing files): ";

/// The canvas section of the session `instructions`, followed by figcraft's
/// own guide to its tools.
const CANVAS_GUIDE: &str = "Design canvas: this project has a design canvas, Termul Canvas, a \
Figma-class editor. Its document is the project's .figcraft file (design.figcraft by default). \
When the user asks for a design, mockup, wireframe, screen or anything \"on the canvas\", build it \
with this server's canvas tools: create_node, set_properties, list_commands, run_command, batch, \
inspect_document, get_node, select, screenshot, export, undo and redo (pointer, key, type_text and \
inspect_ui drive the editor UI and need the canvas on screen). save_file saves the document; \
Termul chooses the file and ignores any path you pass. Do not create or edit .figcraft, .pen or \
.op files on disk, do not call open_file, and do not look for other design tools, MCP servers or \
canvas apps: these tools are the canvas. Agents cannot open the canvas. A CANVAS_CLOSED error \
means it is not open, so ask the user to open it with the Canvas button in Termul's left rail, \
then retry. Before your first canvas edit in a session, call read_canvas_guide with no topic to \
read the termul-canvas skill index (SKILL.md), then call it again for the required topics \
canvas-basics and working-protocol and for the guide that fits the request. When the user \
gives no brand or style, call get_canvas_style, pick one, run its apply batch and tell the user \
which style you chose. The canvas editor is FigCraft, and the rest of this section is its own \
guide.";

/// The canvas part of the session `instructions`.
#[must_use]
pub fn instructions() -> String {
    format!("{CANVAS_GUIDE}\n\n{}", figcraft_mcp::INSTRUCTIONS)
}

/// What figcraft's `export` description says about `path`, and what Termul
/// does with it instead.
const EXPORT_PATH_UPSTREAM: &str = "(absolute path recommended)";
const EXPORT_PATH_TERMUL: &str =
    "(a path relative to the project; Termul writes only inside the project and may replace a file there)";

/// figcraft's tools as rmcp definitions, each description prefixed with
/// [`DESCRIPTION_TAG`]. figcraft marks `export` read-only, but with a `path`
/// Termul writes (and may replace) a project file, so it is advertised as
/// destructive, and its description no longer asks for an absolute path,
/// which Termul refuses.
#[must_use]
pub fn tools() -> Vec<Tool> {
    figcraft_mcp::tool_definitions()
        .into_iter()
        .map(|mut definition| {
            let export = definition["name"] == "export";
            if let Some(Value::String(description)) = definition.get_mut("description") {
                if export {
                    *description = description.replace(EXPORT_PATH_UPSTREAM, EXPORT_PATH_TERMUL);
                }
                description.insert_str(0, DESCRIPTION_TAG);
            }
            if export {
                if let Some(annotations) = definition
                    .get_mut("annotations")
                    .and_then(Value::as_object_mut)
                {
                    annotations.insert("readOnlyHint".to_string(), Value::Bool(false));
                    annotations.insert("destructiveHint".to_string(), Value::Bool(true));
                }
            }
            definition
        })
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
