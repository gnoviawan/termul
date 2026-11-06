//! The production [`McpClient`]: one rmcp connection per call through the
//! probe's [`connect`], which advertises no elicitation, sampling, roots or
//! tasks. A call never answers `input_required`; it reports it. Every result
//! and failure that leaves here has the server's url and its env values
//! (as written and as expanded), header values and OAuth token of at least
//! [`MIN_REDACTED_LEN`] bytes cut out, in case the server echoes them.
//! Shorter values pass through.

use std::path::Path;

use futures::future::{BoxFuture, FutureExt};
use rmcp::model::{CallToolRequestParams, CallToolResponse, Tool};
use rmcp::service::{RoleClient, RunningService, Service, ServiceError};
use serde_json::{Map, Value};

use super::{CallOutcome, McpClient, McpFailure, McpServerConfig, ToolResponse, ToolSchema};
use crate::acp::mcp_probe::{connect, ConnectError, McpConnection};

pub struct RmcpClient;

impl McpClient for RmcpClient {
    fn list_tools<'a>(
        &'a self,
        server: &'a McpServerConfig,
        cwd: Option<&'a Path>,
    ) -> BoxFuture<'a, Result<Vec<ToolSchema>, McpFailure>> {
        async move {
            let connection = open(server, cwd).await?;
            let redactor = Redactor::new(server, connection.bearer.as_deref());
            let listed = list_on(&connection.service).await;
            let _ = connection.service.cancel().await;
            listed.map_err(|failure| redactor.failure(failure))
        }
        .boxed()
    }

    fn call_tool<'a>(
        &'a self,
        server: &'a McpServerConfig,
        cwd: Option<&'a Path>,
        tool: &'a str,
        arguments: Map<String, Value>,
    ) -> BoxFuture<'a, Result<CallOutcome, McpFailure>> {
        async move {
            let connection = open(server, cwd).await?;
            let redactor = Redactor::new(server, connection.bearer.as_deref());
            let called = call_on(&connection.service, tool, arguments).await;
            let _ = connection.service.cancel().await;
            match called {
                Ok(outcome) => Ok(CallOutcome {
                    response: redactor.response(outcome.response),
                    ..outcome
                }),
                Err(failure) => Err(redactor.failure(failure)),
            }
        }
        .boxed()
    }
}

async fn open(server: &McpServerConfig, cwd: Option<&Path>) -> Result<McpConnection, McpFailure> {
    connect(server, cwd).await.map_err(|error| match error {
        ConnectError::AuthRequired { .. } => McpFailure::AuthRequired,
        ConnectError::Failed(reason) => {
            McpFailure::Unavailable(Redactor::new(server, None).text(&reason))
        }
    })
}

/// Values shorter than this are left alone: a `DEBUG=1` env value is no
/// credential, and cutting every `1` out of a result would wreck it.
const MIN_REDACTED_LEN: usize = 8;
const REDACTED: &str = "[redacted]";

pub(super) struct Redactor {
    secrets: Vec<String>,
    url: Option<String>,
}

impl Redactor {
    pub(super) fn new(server: &McpServerConfig, bearer: Option<&str>) -> Self {
        let mut secrets: Vec<String> = server
            .env
            .iter()
            .chain(&server.headers)
            .flat_map(|pair| {
                let last_word = pair.value.split_whitespace().last().map(str::to_string);
                [Some(pair.value.clone()), last_word]
            })
            .chain(
                server
                    .env
                    .iter()
                    .map(|pair| Some(crate::acp::mcp_probe::expand_env(&pair.value))),
            )
            .flatten()
            .chain(bearer.map(str::to_string))
            .filter(|value| value.len() >= MIN_REDACTED_LEN)
            .collect();
        secrets.sort_by_key(|value| std::cmp::Reverse(value.len()));
        secrets.dedup();
        Self {
            secrets,
            url: server.url.clone().filter(|url| !url.is_empty()),
        }
    }

    /// The server url goes too: it can carry a key in its query.
    fn text(&self, text: &str) -> String {
        let text = match &self.url {
            Some(url) => text.replace(url, "[server url]"),
            None => text.to_string(),
        };
        self.secrets
            .iter()
            .fold(text, |acc, secret| acc.replace(secret, REDACTED))
    }

    pub(super) fn failure(&self, failure: McpFailure) -> McpFailure {
        match failure {
            McpFailure::Unavailable(reason) => McpFailure::Unavailable(self.text(&reason)),
            other => other,
        }
    }

    pub(super) fn value(&self, value: Value) -> Value {
        match value {
            Value::String(s) => Value::String(self.text(&s)),
            Value::Array(items) => Value::Array(items.into_iter().map(|v| self.value(v)).collect()),
            Value::Object(map) => Value::Object(
                map.into_iter()
                    .map(|(k, v)| (self.text(&k), self.value(v)))
                    .collect(),
            ),
            other => other,
        }
    }

    fn response(&self, response: ToolResponse) -> ToolResponse {
        match response {
            ToolResponse::Complete {
                structured,
                text,
                is_error,
            } => ToolResponse::Complete {
                structured: structured.map(|v| self.value(v)),
                text: self.text(&text),
                is_error,
            },
            other => other,
        }
    }
}

fn schema_of(tool: Tool) -> ToolSchema {
    ToolSchema {
        name: tool.name.to_string(),
        description: tool.description.map(|d| d.to_string()),
        input_schema: Value::Object((*tool.input_schema).clone()),
        output_schema: tool.output_schema.map(|s| Value::Object((*s).clone())),
    }
}

/// Every tool of an initialized connection, all pages.
pub(crate) async fn list_on<S: Service<RoleClient>>(
    service: &RunningService<RoleClient, S>,
) -> Result<Vec<ToolSchema>, McpFailure> {
    service
        .list_all_tools()
        .await
        .map(|tools| tools.into_iter().map(schema_of).collect())
        .map_err(|error| McpFailure::Unavailable(format!("tools/list failed: {error}")))
}

/// Lists the tools, then sends one `tools/call` for `tool` and drives no
/// follow-up round. A JSON-RPC error from the server is a tool error, so the
/// node's `error` edge can route it like an `isError` result, except rmcp's
/// refusal to send an `InputRequiredResult` over a protocol older than
/// MRTR's, which is still a request for user input.
pub(crate) async fn call_on<S: Service<RoleClient>>(
    service: &RunningService<RoleClient, S>,
    tool: &str,
    arguments: Map<String, Value>,
) -> Result<CallOutcome, McpFailure> {
    let tools = list_on(service).await?;
    let schema = tools
        .iter()
        .find(|t| t.name == tool)
        .cloned()
        .ok_or(McpFailure::UnknownTool)?;
    let params = CallToolRequestParams::new(tool.to_string()).with_arguments(arguments);
    let response = match service.call_tool_once(params).await {
        Ok(CallToolResponse::Complete(result)) => ToolResponse::Complete {
            text: result
                .content
                .iter()
                .filter_map(|block| block.as_text().map(|t| t.text.as_str()))
                .collect::<Vec<_>>()
                .join("\n"),
            structured: result.structured_content,
            is_error: result.is_error == Some(true),
        },
        Ok(CallToolResponse::InputRequired(_)) => ToolResponse::InputRequired,
        Ok(CallToolResponse::Task(_)) => ToolResponse::Task,
        Ok(_) => {
            return Err(McpFailure::Unavailable(
                "tools/call returned an unknown result".to_string(),
            ))
        }
        Err(ServiceError::McpError(error)) if error.message.contains("InputRequiredResult") => {
            ToolResponse::InputRequired
        }
        Err(ServiceError::McpError(error)) => ToolResponse::Complete {
            structured: None,
            text: error.message.to_string(),
            is_error: true,
        },
        Err(error) => {
            return Err(McpFailure::Unavailable(format!(
                "tools/call failed: {error}"
            )))
        }
    };
    Ok(CallOutcome {
        tool: schema,
        tools,
        response,
    })
}
