//! The OpenAPI 3.1 description of the HTTP surface [`crate::web::router::router`]
//! serves, built at runtime from [`ROUTES`] and the `JsonSchema` derives on the
//! serde types the handlers read and write, so field names cannot drift from
//! the wire. The host serves it at `GET /openapi.json`, `termul-server openapi`
//! prints it, and release CI attaches the YAML to each GitHub release. The
//! fence tests keep [`ROUTES`] in step with the registered routes.

use std::sync::OnceLock;

use axum::{http::header, response::IntoResponse};
use schemars::{generate::SchemaSettings, JsonSchema, Schema, SchemaGenerator};
use serde_json::{json, Map, Value};

use crate::web::router::requires_token;

pub mod cli;
mod document;
mod routes;

#[cfg(test)]
mod fence_tests;
#[cfg(test)]
mod tests;

pub use document::document;
pub use routes::ROUTES;

/// `GET /openapi.json`: [`document`], serialized once per process.
pub async fn serve_json() -> impl IntoResponse {
    static JSON: OnceLock<String> = OnceLock::new();
    let body = JSON.get_or_init(|| {
        let json = document().to_string();
        tracing::info!(
            target: "termul::web::openapi",
            operations = ROUTES.len(),
            bytes = json.len(),
            "built the OpenAPI document"
        );
        json
    });
    ([(header::CONTENT_TYPE, "application/json")], body.as_str())
}

/// Builds the schema of one request or reply type inside a shared generator.
pub type SchemaFn = fn(&mut SchemaGenerator) -> Schema;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum HttpMethod {
    Get,
    Post,
    Put,
    Delete,
}

impl HttpMethod {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Get => "get",
            Self::Post => "post",
            Self::Put => "put",
            Self::Delete => "delete",
        }
    }
}

/// What a successful call answers with.
#[derive(Clone, Copy)]
pub enum Reply {
    /// `IpcBody` envelope whose `data` is this schema.
    Ipc(SchemaFn),
    /// `IpcBody` envelope with `data: null`.
    IpcEmpty,
    /// A bare JSON body, not wrapped in the envelope.
    Bare(SchemaFn),
    /// Raw bytes in one of these content types.
    Bytes(&'static [&'static str]),
    /// Always `401` with the envelope (a path that exists only to refuse).
    Refused,
    /// A `303` redirect (the OAuth authorization server's return leg).
    Redirect,
    /// A WebSocket upgrade.
    Upgrade,
}

/// One documented operation: one method on one path.
#[derive(Clone, Copy)]
pub struct ApiRoute {
    pub method: HttpMethod,
    /// Axum syntax: `{param}` and `{*rest}`.
    pub path: &'static str,
    pub tag: Tag,
    pub summary: &'static str,
    pub description: Option<&'static str>,
    /// The `Query<T>` extractor, documented as one parameter per field.
    pub query: Option<SchemaFn>,
    /// The JSON request body.
    pub body: Option<SchemaFn>,
    pub reply: Reply,
}

fn reference<T: JsonSchema>(generator: &mut SchemaGenerator) -> Schema {
    generator.subschema_for::<T>()
}

fn inline<T: JsonSchema>(generator: &mut SchemaGenerator) -> Schema {
    T::json_schema(generator)
}

impl ApiRoute {
    const fn new(method: HttpMethod, path: &'static str, tag: Tag, summary: &'static str) -> Self {
        Self {
            method,
            path,
            tag,
            summary,
            description: None,
            query: None,
            body: None,
            reply: Reply::IpcEmpty,
        }
    }

    pub const fn get(path: &'static str, tag: Tag, summary: &'static str) -> Self {
        Self::new(HttpMethod::Get, path, tag, summary)
    }

    pub const fn post(path: &'static str, tag: Tag, summary: &'static str) -> Self {
        Self::new(HttpMethod::Post, path, tag, summary)
    }

    pub const fn put(path: &'static str, tag: Tag, summary: &'static str) -> Self {
        Self::new(HttpMethod::Put, path, tag, summary)
    }

    pub const fn delete(path: &'static str, tag: Tag, summary: &'static str) -> Self {
        Self::new(HttpMethod::Delete, path, tag, summary)
    }

    pub const fn query<T: JsonSchema>(mut self) -> Self {
        self.query = Some(inline::<T>);
        self
    }

    pub const fn json<T: JsonSchema>(mut self) -> Self {
        self.body = Some(reference::<T>);
        self
    }

    pub const fn ipc<T: JsonSchema>(mut self) -> Self {
        self.reply = Reply::Ipc(reference::<T>);
        self
    }

    pub const fn bare<T: JsonSchema>(mut self) -> Self {
        self.reply = Reply::Bare(reference::<T>);
        self
    }

    pub const fn reply(mut self, reply: Reply) -> Self {
        self.reply = reply;
        self
    }

    pub const fn describe(mut self, description: &'static str) -> Self {
        self.description = Some(description);
        self
    }

    /// The path in OpenAPI syntax: axum's `{*rest}` becomes `{rest}`.
    pub fn openapi_path(&self) -> String {
        self.path.replace("{*", "{")
    }

    /// Whether the bearer gate guards this route when the host has a token.
    pub fn requires_token(&self) -> bool {
        requires_token(&self.openapi_path())
    }
}

/// The groups operations are listed under. The order here is the order
/// readers see.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tag {
    Host,
    Realtime,
    Projects,
    Fs,
    Git,
    Github,
    Worktrees,
    Search,
    Skills,
    Acp,
    McpServers,
    McpCatalog,
    Automations,
    BrowserPolicy,
    Canvas,
    Diagnostics,
    ServerAdmin,
}

impl Tag {
    pub const ALL: &'static [Tag] = &[
        Tag::Host,
        Tag::Realtime,
        Tag::Projects,
        Tag::Fs,
        Tag::Git,
        Tag::Github,
        Tag::Worktrees,
        Tag::Search,
        Tag::Skills,
        Tag::Acp,
        Tag::McpServers,
        Tag::McpCatalog,
        Tag::Automations,
        Tag::BrowserPolicy,
        Tag::Canvas,
        Tag::Diagnostics,
        Tag::ServerAdmin,
    ];

    pub const fn name(self) -> &'static str {
        match self {
            Tag::Host => "Host",
            Tag::Realtime => "Realtime",
            Tag::Projects => "Projects",
            Tag::Fs => "Files",
            Tag::Git => "Git",
            Tag::Github => "GitHub",
            Tag::Worktrees => "Worktrees",
            Tag::Search => "Search",
            Tag::Skills => "Skills",
            Tag::Acp => "Agents",
            Tag::McpServers => "MCP servers",
            Tag::McpCatalog => "MCP catalog",
            Tag::Automations => "Automations",
            Tag::BrowserPolicy => "Browser policy",
            Tag::Canvas => "Canvas",
            Tag::Diagnostics => "Diagnostics",
            Tag::ServerAdmin => "Server admin",
        }
    }

    pub const fn description(self) -> &'static str {
        match self {
            Tag::Host => "Liveness, capabilities and host-wide settings.",
            Tag::Realtime => {
                "WebSocket endpoints. The message protocol is out of scope for this spec."
            }
            Tag::Projects => "The host's project registry.",
            Tag::Fs => "Files and directories inside registered projects.",
            Tag::Git => "Git status, diffs, staging, commits, stashes and branches.",
            Tag::Github => "GitHub issues, pull requests and checks through the host's `gh` CLI.",
            Tag::Worktrees => "Git worktrees for parallel work on one project.",
            Tag::Search => "Content and file-name search (ripgrep on the host).",
            Tag::Skills => "Agent skills installed for a project.",
            Tag::Acp => "The agent catalog and agent installs.",
            Tag::McpServers => "A project's MCP server registry, probes and OAuth.",
            Tag::McpCatalog => "Search and install servers from the MCP registry.",
            Tag::Automations => "Scheduled and triggered agent automations.",
            Tag::BrowserPolicy => "What agent browser automation may reach.",
            Tag::Canvas => "The design canvas: open, persist and serve the editor bundle.",
            Tag::Diagnostics => "Frontend error forwarding and bug reports.",
            Tag::ServerAdmin => "Reconfigure a standalone termul-server.",
        }
    }
}

/// Generator settings shared by the request and reply generators: draft
/// 2020-12 (what OpenAPI 3.1 uses) with definitions emitted straight into
/// `components.schemas`, so no `$ref` needs rewriting.
fn settings() -> SchemaSettings {
    SchemaSettings::draft2020_12().with(|s| {
        s.definitions_path = "/components/schemas".into();
        s.meta_schema = None;
    })
}

fn ref_to(name: &str) -> Value {
    json!({ "$ref": format!("#/components/schemas/{name}") })
}

fn into_object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        other => panic!("expected a JSON object, got {other}"),
    }
}
