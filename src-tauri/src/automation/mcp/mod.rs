//! What `mcp_tool` nodes call: the project's configured MCP servers, the
//! client seam, and the live `tools/list` cache that validation and runs
//! share. A server's credentials (env and header values, OAuth tokens) live
//! only in its [`McpServerConfig`], which never leaves this module and the
//! engine; every wire view carries the server id, name, transport and tool
//! schemas only.

mod client;
mod registry;
mod tools;

use std::path::Path;

use futures::future::BoxFuture;
use serde::Serialize;
use serde_json::{Map, Value};

pub use client::RmcpClient;
pub use registry::{parse_registry, store_servers, McpServerEntry, ProjectMcpServers};
pub use tools::{
    Listing, Lookup, McpTools, OnListingChanged, ServerStatus, ServerTools, LISTING_DEADLINE,
};

pub use crate::acp::mcp_probe::McpServerConfig;

/// One tool of a server's `tools/list`, as an automation author reads it.
#[derive(Debug, Clone, PartialEq, Serialize, schemars::JsonSchema)]
pub struct ToolSchema {
    pub name: String,
    pub description: Option<String>,
    pub input_schema: Value,
    pub output_schema: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpFailure {
    /// The server wants an OAuth sign-in the host does not hold.
    AuthRequired,
    /// Value-free reason: spawn, connect, initialize or listing failed.
    Unavailable(String),
    /// The live `tools/list` has no tool of that name.
    UnknownTool,
}

/// One `tools/call`, with the listing the same connection saw first.
#[derive(Debug, Clone, PartialEq)]
pub struct CallOutcome {
    pub tool: ToolSchema,
    pub tools: Vec<ToolSchema>,
    pub response: ToolResponse,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ToolResponse {
    Complete {
        structured: Option<Value>,
        /// The text content blocks, joined by newlines.
        text: String,
        is_error: bool,
    },
    /// The server asked for user input (SEP-2322 `input_required`).
    InputRequired,
    /// The server turned the call into a task (SEP-2663).
    Task,
}

/// The seam between the automation host and MCP servers. Each call opens its
/// own connection and closes it before returning.
pub trait McpClient: Send + Sync {
    /// A stdio server starts in `cwd` when given.
    fn list_tools<'a>(
        &'a self,
        server: &'a McpServerConfig,
        cwd: Option<&'a Path>,
    ) -> BoxFuture<'a, Result<Vec<ToolSchema>, McpFailure>>;

    /// Lists the tools, then calls `tool` once if the listing has it. A
    /// stdio server starts in `cwd` when given.
    fn call_tool<'a>(
        &'a self,
        server: &'a McpServerConfig,
        cwd: Option<&'a Path>,
        tool: &'a str,
        arguments: Map<String, Value>,
    ) -> BoxFuture<'a, Result<CallOutcome, McpFailure>>;
}

#[cfg(test)]
mod client_tests;
#[cfg(test)]
mod registry_tests;
#[cfg(test)]
pub(crate) mod test_support;
#[cfg(test)]
mod tools_tests;
