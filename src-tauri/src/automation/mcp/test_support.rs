use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures::future::{BoxFuture, FutureExt};
use parking_lot::Mutex;
use serde_json::{json, Map, Value};

use super::{
    CallOutcome, McpClient, McpFailure, McpServerConfig, McpServerEntry, ProjectMcpServers,
    ToolResponse, ToolSchema,
};
use crate::acp::mcp_probe::McpNameValuePair;

/// The env value every fake server carries, so a test can prove it never
/// leaves the host.
pub const SENTINEL_SECRET: &str = "sentinel-secret-8c1f";

pub fn server(id: &str, name: &str) -> McpServerEntry {
    McpServerEntry {
        server_id: id.to_string(),
        name: name.to_string(),
        config: McpServerConfig {
            r#type: None,
            name: name.to_string(),
            command: Some(format!("/opt/{name}/bin/server")),
            args: vec!["--token".into(), SENTINEL_SECRET.into()],
            env: vec![McpNameValuePair {
                name: "API_TOKEN".into(),
                value: SENTINEL_SECRET.into(),
            }],
            url: None,
            headers: vec![McpNameValuePair {
                name: "Authorization".into(),
                value: format!("Bearer {SENTINEL_SECRET}"),
            }],
        },
    }
}

/// `servers` for every project id.
pub fn registry(servers: Vec<McpServerEntry>) -> ProjectMcpServers {
    Arc::new(move |_| servers.clone())
}

pub fn tool(name: &str, input_schema: Value, output_schema: Option<Value>) -> ToolSchema {
    ToolSchema {
        name: name.to_string(),
        description: Some(format!("{name} tool")),
        input_schema,
        output_schema,
    }
}

/// `search(query: string required, limit?: integer)`, closed to other
/// arguments, with no output schema.
pub fn search_tool() -> ToolSchema {
    tool(
        "search",
        json!({ "type": "object",
                "properties": { "query": { "type": "string" }, "limit": { "type": "integer" } },
                "required": ["query"], "additionalProperties": false }),
        None,
    )
}

#[derive(Debug, Clone, PartialEq)]
pub struct SeenCall {
    pub server: String,
    pub cwd: Option<PathBuf>,
    pub tool: String,
    pub arguments: Map<String, Value>,
}

/// Servers keyed by config name. A server with no listing fails as
/// unavailable; a tool with no response answers an empty text result.
#[derive(Default)]
pub struct FakeMcp {
    pub listings: Mutex<HashMap<String, Result<Vec<ToolSchema>, McpFailure>>>,
    pub responses: Mutex<HashMap<String, ToolResponse>>,
    /// Calls wait this long before answering.
    pub call_delay: Mutex<Option<Duration>>,
    pub list_calls: AtomicUsize,
    /// The working directory of every listing, in order.
    pub list_cwds: Mutex<Vec<Option<PathBuf>>>,
    pub calls: Mutex<Vec<SeenCall>>,
}

impl FakeMcp {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn lists(&self, server: &str, listing: Result<Vec<ToolSchema>, McpFailure>) {
        self.listings.lock().insert(server.to_string(), listing);
    }

    pub fn answers(&self, tool: &str, response: ToolResponse) {
        self.responses.lock().insert(tool.to_string(), response);
    }

    pub fn list_count(&self) -> usize {
        self.list_calls.load(Ordering::SeqCst)
    }

    fn listing(&self, server: &McpServerConfig) -> Result<Vec<ToolSchema>, McpFailure> {
        self.listings
            .lock()
            .get(&server.name)
            .cloned()
            .unwrap_or_else(|| Err(McpFailure::Unavailable("no such fake server".into())))
    }
}

impl McpClient for FakeMcp {
    fn list_tools<'a>(
        &'a self,
        server: &'a McpServerConfig,
        cwd: Option<&'a Path>,
    ) -> BoxFuture<'a, Result<Vec<ToolSchema>, McpFailure>> {
        self.list_calls.fetch_add(1, Ordering::SeqCst);
        self.list_cwds.lock().push(cwd.map(Path::to_path_buf));
        let listing = self.listing(server);
        async move { listing }.boxed()
    }

    fn call_tool<'a>(
        &'a self,
        server: &'a McpServerConfig,
        cwd: Option<&'a Path>,
        tool: &'a str,
        arguments: Map<String, Value>,
    ) -> BoxFuture<'a, Result<CallOutcome, McpFailure>> {
        self.calls.lock().push(SeenCall {
            server: server.name.clone(),
            cwd: cwd.map(Path::to_path_buf),
            tool: tool.to_string(),
            arguments,
        });
        let delay = *self.call_delay.lock();
        async move {
            if let Some(delay) = delay {
                tokio::time::sleep(delay).await;
            }
            let tools = self.listing(server)?;
            let schema = tools
                .iter()
                .find(|t| t.name == tool)
                .cloned()
                .ok_or(McpFailure::UnknownTool)?;
            let response =
                self.responses
                    .lock()
                    .get(tool)
                    .cloned()
                    .unwrap_or(ToolResponse::Complete {
                        structured: None,
                        text: String::new(),
                        is_error: false,
                    });
            Ok(CallOutcome {
                tool: schema,
                tools,
                response,
            })
        }
        .boxed()
    }
}
