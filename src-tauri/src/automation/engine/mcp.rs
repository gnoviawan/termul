//! `mcp_tool` nodes: one `tools/call` on a project MCP server, with no LLM.
//! The server is resolved when the step runs, the arguments render with no
//! secrets, and the call never answers a request for user input. Logs name
//! the server, tool, outcome and duration, never arguments or results.

use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use super::nodes::{render, NodeError, NodeScope};
use crate::automation::mcp::{CallOutcome, McpFailure, ToolResponse};
use crate::automation::model::NamedTemplate;
use crate::automation::schema;

/// Characters of a tool's error text kept in the step error.
const ERROR_TEXT_CHARS: usize = 500;

pub(super) const INPUT_REQUIRED: &str =
    "mcp_input_required: the tool asked for user input; automation runs cannot answer it";

pub(super) struct McpSpec<'a> {
    pub server_id: &'a str,
    pub tool: &'a str,
    pub arguments: &'a [NamedTemplate],
    pub timeout_ms: u64,
}

pub(super) async fn run(scope: &NodeScope<'_>, spec: McpSpec<'_>) -> Result<Value, NodeError> {
    let engine = scope.run.engine;
    let project_id = scope.run.project_id;
    let server = engine
        .mcp
        .server(project_id, spec.server_id)
        .ok_or_else(|| NodeError::failed(format!("mcp_server_unknown:{}", spec.server_id)))?;
    let ctx = scope.render_context(None);
    let mut arguments = Map::new();
    for argument in spec.arguments {
        arguments.insert(argument.name.clone(), render(&argument.value, &ctx)?);
    }
    let started = Instant::now();
    let call =
        engine
            .mcp
            .client()
            .call_tool(&server.config, Some(scope.run.cwd), spec.tool, arguments);
    let called = tokio::select! {
        called = tokio::time::timeout(Duration::from_millis(spec.timeout_ms), call) => called,
        _ = scope.run.cancel.cancelled() => {
            log::info!(
                "[Automation] run {} step {}: MCP {} tool {} cancelled after {} ms",
                scope.run.run.id,
                scope.node_id,
                server.server_id,
                spec.tool,
                started.elapsed().as_millis()
            );
            return Err(NodeError::Cancelled);
        }
    };
    let result = match called {
        Err(_) => Err(NodeError::failed("mcp_timeout")),
        Ok(Err(failure)) => Err(NodeError::failed(failure_message(failure, spec.tool))),
        Ok(Ok(outcome)) => {
            engine
                .mcp
                .record(project_id, &server, outcome.tools.clone());
            output(outcome, engine.http.body_cap())
        }
    };
    log::info!(
        "[Automation] run {} step {}: MCP {} ({}) tool {} {} in {} ms",
        scope.run.run.id,
        scope.node_id,
        server.server_id,
        server.name,
        spec.tool,
        match &result {
            Ok(_) => "succeeded".to_string(),
            Err(NodeError::Failed { message, .. }) => {
                message.split(':').next().unwrap_or_default().to_string()
            }
            Err(_) => "stopped".to_string(),
        },
        started.elapsed().as_millis()
    );
    result
}

fn failure_message(failure: McpFailure, tool: &str) -> String {
    match failure {
        McpFailure::AuthRequired => "mcp_auth_required".to_string(),
        McpFailure::Unavailable(reason) => format!("mcp_server_unavailable: {reason}"),
        McpFailure::UnknownTool => format!("mcp_tool_unknown:{tool}"),
    }
}

/// The step output: `structuredContent` when the tool declares an output
/// schema (checked against it when the schema is inside the supported
/// subset) or sends one, else the text blocks as `{text}`.
fn output(outcome: CallOutcome, cap: usize) -> Result<Value, NodeError> {
    let (structured, text) = match outcome.response {
        ToolResponse::InputRequired => return Err(NodeError::failed(INPUT_REQUIRED)),
        ToolResponse::Task => return Err(NodeError::failed("mcp_task_unsupported")),
        ToolResponse::Complete {
            is_error: true,
            text,
            ..
        } => {
            let short: String = text.chars().take(ERROR_TEXT_CHARS).collect();
            return Err(NodeError::Failed {
                message: format!("mcp_tool_error: {short}"),
                output: Some(text_output(text, cap)),
            });
        }
        ToolResponse::Complete {
            structured, text, ..
        } => (structured, text),
    };
    match (&outcome.tool.output_schema, structured) {
        (Some(_), None) => Err(NodeError::failed("mcp_structured_content_missing")),
        (Some(declared), Some(value)) => {
            if let Ok(schema) = schema::parse(declared) {
                let errors = schema::validate(&schema, &value);
                if !errors.is_empty() {
                    let errors: Vec<String> = errors.iter().map(ToString::to_string).collect();
                    return Err(NodeError::failed(format!(
                        "mcp_output_invalid: {}",
                        errors.join("; ")
                    )));
                }
            }
            Ok(value)
        }
        (None, Some(value)) => Ok(value),
        (None, None) => Ok(text_output(text, cap)),
    }
}

/// `{text}`, cut at `cap` bytes on a character boundary (`truncated: true`).
fn text_output(mut text: String, cap: usize) -> Value {
    if text.len() <= cap {
        return json!({ "text": text });
    }
    let mut end = cap;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    json!({ "text": text, "truncated": true })
}
