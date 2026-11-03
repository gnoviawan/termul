//! `list_on` and `call_on` against a real rmcp server over an in-process
//! duplex pipe, with the client config every Termul MCP client sends.

use std::sync::Arc;

use parking_lot::Mutex;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ClientCapabilities, ContentBlock,
    InputRequiredResult, ListToolsResult, PaginatedRequestParams, ProtocolVersion,
    ServerCapabilities, ServerConfig, Tool,
};
use rmcp::service::{
    serve_client, serve_server, ClientLifecycleMode, ClientServiceExt, RequestContext, RoleClient,
    RoleServer, RunningService,
};
use rmcp::{ErrorData, ServerHandler};
use serde_json::{json, Map, Value};

use super::client::{call_on, list_on, Redactor};
use super::test_support::{server, SENTINEL_SECRET};
use super::{McpFailure, ToolResponse, ToolSchema};
use crate::acp::mcp_probe::{client_config, McpNameValuePair};
use rmcp::model::ClientConfig;

/// What the server saw of the client on its last `tools/call`.
#[derive(Clone, Default)]
struct Seen {
    capabilities: Arc<Mutex<Option<ClientCapabilities>>>,
    protocol: Arc<Mutex<Option<ProtocolVersion>>>,
    arguments: Arc<Mutex<Option<Map<String, Value>>>>,
}

#[derive(Clone, Default)]
struct TestServer {
    seen: Seen,
}

fn object(value: Value) -> Arc<Map<String, Value>> {
    match value {
        Value::Object(map) => Arc::new(map),
        _ => unreachable!("schemas are objects"),
    }
}

fn input_schema() -> Value {
    json!({ "type": "object", "properties": { "city": { "type": "string" } }, "required": ["city"] })
}

fn output_schema() -> Value {
    json!({ "type": "object", "properties": { "temp": { "type": "number" } }, "required": ["temp"] })
}

impl ServerHandler for TestServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult::with_all_items(vec![
            Tool::new("weather", "Current weather", object(input_schema()))
                .with_raw_output_schema(object(output_schema())),
            Tool::new(
                "confirm",
                "Asks the user first",
                object(json!({ "type": "object" })),
            ),
            Tool::new(
                "broken",
                "Always fails",
                object(json!({ "type": "object" })),
            ),
            Tool::new(
                "rejects",
                "Errors at the protocol level",
                object(json!({ "type": "object" })),
            ),
        ]))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        *self.seen.capabilities.lock() = context.client_capabilities();
        *self.seen.protocol.lock() = context.protocol_version();
        *self.seen.arguments.lock() = request.arguments.clone();
        match request.name.as_ref() {
            "weather" => {
                let mut result = CallToolResult::structured(json!({ "temp": 21.5 }));
                result.content = vec![ContentBlock::text("21.5 C")];
                Ok(result.into())
            }
            "confirm" => Ok(InputRequiredResult::from_request_state("opaque").into()),
            "broken" => Ok(CallToolResult::error(vec![ContentBlock::text("disk full")]).into()),
            _ => Err(ErrorData::invalid_params("bad city", None)),
        }
    }
}

/// A client with Termul's config over the `initialize` handshake, the one
/// `connect` uses, or over `server/discover` at protocol 2026-07-28.
async fn connected(modern: bool) -> (RunningService<RoleClient, ClientConfig>, Seen) {
    let handler = TestServer::default();
    let seen = handler.seen.clone();
    let (client_io, server_io) = tokio::io::duplex(64 * 1024);
    tokio::spawn(async move {
        if let Ok(running) = serve_server(handler, tokio::io::split(server_io)).await {
            let _ = running.waiting().await;
        }
    });
    let transport = tokio::io::split(client_io);
    let client = if modern {
        let lifecycle = ClientLifecycleMode::Discover {
            preferred_versions: vec![ProtocolVersion::V_2026_07_28],
        };
        client_config()
            .serve_with_lifecycle(transport, lifecycle)
            .await
    } else {
        serve_client(client_config(), transport).await
    };
    (client.expect("client initializes"), seen)
}

#[test]
fn termul_clients_advertise_no_capabilities() {
    assert_eq!(client_config().capabilities, ClientCapabilities::default());
    assert_eq!(
        serde_json::to_value(&client_config().capabilities).unwrap(),
        json!({})
    );
}

#[tokio::test]
async fn lists_tools_with_their_input_and_output_schemas() {
    let (client, _) = connected(false).await;
    let tools = list_on(&client).await.unwrap();
    assert_eq!(
        tools[0],
        ToolSchema {
            name: "weather".into(),
            description: Some("Current weather".into()),
            input_schema: input_schema(),
            output_schema: Some(output_schema()),
        }
    );
    assert_eq!(
        tools.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
        vec!["weather", "confirm", "broken", "rejects"]
    );
    assert_eq!(tools[1].output_schema, None);
}

#[tokio::test]
async fn a_call_returns_structured_content_and_sends_the_arguments() {
    let (client, seen) = connected(false).await;
    let mut arguments = Map::new();
    arguments.insert("city".into(), json!("Berlin"));
    let outcome = call_on(&client, "weather", arguments.clone())
        .await
        .unwrap();
    assert_eq!(outcome.tool.name, "weather");
    assert_eq!(outcome.tools.len(), 4);
    assert_eq!(
        outcome.response,
        ToolResponse::Complete {
            structured: Some(json!({ "temp": 21.5 })),
            text: "21.5 C".into(),
            is_error: false,
        }
    );
    assert_eq!(*seen.arguments.lock(), Some(arguments));
    assert_eq!(*seen.protocol.lock(), Some(ProtocolVersion::V_2025_11_25));
    let capabilities = seen.capabilities.lock().clone().unwrap_or_default();
    assert_eq!(serde_json::to_value(&capabilities).unwrap(), json!({}));
}

#[tokio::test]
async fn input_required_is_reported_and_never_answered() {
    let (client, seen) = connected(true).await;
    let outcome = call_on(&client, "confirm", Map::new()).await.unwrap();
    assert_eq!(outcome.response, ToolResponse::InputRequired);
    assert_eq!(*seen.protocol.lock(), Some(ProtocolVersion::V_2026_07_28));
    let capabilities = seen.capabilities.lock().clone().unwrap_or_default();
    assert_eq!(serde_json::to_value(&capabilities).unwrap(), json!({}));
}

/// Over `initialize` a server cannot send `input_required` at all: rmcp
/// turns it into an error, which fails the step as a tool error.
#[tokio::test]
async fn over_initialize_an_input_request_comes_back_as_a_tool_error() {
    let (client, _) = connected(false).await;
    let outcome = call_on(&client, "confirm", Map::new()).await.unwrap();
    assert_eq!(
        outcome.response,
        ToolResponse::Complete {
            structured: None,
            text: "InputRequiredResult requires negotiated protocol version 2026-07-28 or newer"
                .into(),
            is_error: true,
        }
    );
}

#[tokio::test]
async fn tool_errors_and_protocol_errors_are_tool_errors_and_an_unlisted_tool_is_unknown() {
    let (client, _) = connected(false).await;
    let broken = call_on(&client, "broken", Map::new()).await.unwrap();
    assert_eq!(
        broken.response,
        ToolResponse::Complete {
            structured: None,
            text: "disk full".into(),
            is_error: true,
        }
    );
    let rejects = call_on(&client, "rejects", Map::new()).await.unwrap();
    assert_eq!(
        rejects.response,
        ToolResponse::Complete {
            structured: None,
            text: "bad city".into(),
            is_error: true,
        }
    );
    assert_eq!(
        call_on(&client, "missing", Map::new()).await.unwrap_err(),
        McpFailure::UnknownTool
    );
}

#[test]
fn the_redactor_cuts_env_header_and_token_values_but_not_short_ones() {
    let mut config = server("srv", "files").config;
    config.env.push(McpNameValuePair {
        name: "DEBUG".into(),
        value: "1".into(),
    });
    config.url = Some("https://mcp.example.com/?key=abc".into());
    let redactor = Redactor::new(&config, Some("oauth-access-token-1"));
    assert_eq!(
        redactor.value(json!({
            "echo": format!("Bearer {SENTINEL_SECRET} and oauth-access-token-1"),
            "count": 1,
            SENTINEL_SECRET: ["1 item"]
        })),
        json!({ "echo": "[redacted] and [redacted]", "count": 1, "[redacted]": ["1 item"] })
    );
    assert_eq!(
        redactor.failure(McpFailure::Unavailable(
            "error sending request for url (https://mcp.example.com/?key=abc)".into()
        )),
        McpFailure::Unavailable("error sending request for url ([server url])".into())
    );
}
