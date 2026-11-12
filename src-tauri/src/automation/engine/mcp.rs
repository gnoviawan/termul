//! `mcp_tool` nodes: one `tools/call` on a project MCP server, with no LLM.
//! The server is resolved by id or alias when the step runs, the arguments
//! render with no secrets, and the call never answers a request for user
//! input. A literal argument is parsed into the type the tool's input schema
//! declares for it (listing the server first when no listing is kept), and a
//! literal that fits none fails the step. Logs name the server, tool,
//! outcome, duration and argument names, never argument values or results.

use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use super::nodes::{render, NodeError, NodeScope};
use crate::automation::mcp::{
    is_literal, literal_argument, CallOutcome, Literal, McpFailure, ToolResponse,
};
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
    if server.server_id != spec.server_id {
        log::info!(
            "[Automation] run {} step {}: MCP server id {} is an alias of {}",
            scope.run.run.id,
            scope.node_id,
            spec.server_id,
            server.server_id
        );
    }
    let input_schema = if spec.arguments.iter().any(is_literal) {
        let schema = engine
            .mcp
            .input_schema(project_id, &server, spec.tool)
            .await;
        if schema.is_none() {
            log::warn!(
                "[Automation] run {} step {}: no input schema for MCP {} tool {}; literal arguments go as text",
                scope.run.run.id,
                scope.node_id,
                server.server_id,
                spec.tool
            );
        }
        schema
    } else {
        None
    };
    let ctx = scope.render_context(None);
    let mut arguments = Map::new();
    for argument in spec.arguments {
        let literal = input_schema
            .as_ref()
            .map_or(Literal::Render, |schema| literal_argument(schema, argument));
        let value = match literal {
            Literal::Render => render(&argument.value, &ctx)?,
            Literal::Typed(value) => {
                log::debug!(
                    "[Automation] run {} step {}: MCP tool {} argument {} typed by the input schema",
                    scope.run.run.id,
                    scope.node_id,
                    spec.tool,
                    argument.name
                );
                value
            }
            Literal::Mismatch(mismatch) => {
                log::warn!(
                    "[Automation] run {} step {}: MCP tool {} argument {} does not fit its declared type {}",
                    scope.run.run.id,
                    scope.node_id,
                    spec.tool,
                    argument.name,
                    mismatch.expected
                );
                return Err(NodeError::failed(format!(
                    "mcp_argument_invalid: {mismatch}"
                )));
            }
        };
        arguments.insert(argument.name.clone(), value);
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
/// subset) or sends one, else the text blocks as `{text}`. Structured
/// output over `cap` bytes fails the step: cut JSON would not parse.
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
            within_cap(value, cap)
        }
        (None, Some(value)) => within_cap(value, cap),
        (None, None) => Ok(text_output(text, cap)),
    }
}

fn within_cap(value: Value, cap: usize) -> Result<Value, NodeError> {
    let size = serde_json::to_vec(&value).map_or(0, |bytes| bytes.len());
    if size > cap {
        return Err(NodeError::failed(format!(
            "mcp_output_too_large: structured output is {size} bytes, over the {cap} byte cap"
        )));
    }
    Ok(value)
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
