//! The live `tools/list` of every project MCP server, shared by validation
//! and runs. [`McpTools::lookup`] never blocks: a missing or stale listing
//! answers from what it has and lists the server again in the background.
//! [`McpTools::refresh`] lists every server now, for the capabilities answer.
//! [`McpTools::input_schema`] lists a server now when none is kept, for a run.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use futures::future::join_all;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;

use super::{
    find_server, McpClient, McpFailure, McpServerConfig, McpServerEntry, ProjectMcpServers,
    ToolSchema,
};
use crate::automation::engine::{Clock, ProjectRoots};

/// Like the settings probe: a server that has not listed by then is unavailable.
pub const LISTING_DEADLINE: Duration = Duration::from_secs(10);
/// A listing older than this is still answered and listed again.
pub const STALE_AFTER_MS: i64 = 60_000;

/// Called once with `(project_id, ids)` when a server's listing changed;
/// `ids` is the server's id followed by its aliases.
pub type OnListingChanged = Arc<dyn Fn(&str, &[String]) + Send + Sync>;

#[derive(Debug, Clone, PartialEq)]
pub enum Listing {
    Pending,
    Ready { tools: Vec<ToolSchema>, at_ms: i64 },
    Failed { failure: McpFailure, at_ms: i64 },
}

impl Listing {
    /// Equal apart from when it was taken.
    fn same_as(&self, other: &Listing) -> bool {
        match (self, other) {
            (Listing::Pending, Listing::Pending) => true,
            (Listing::Ready { tools: a, .. }, Listing::Ready { tools: b, .. }) => a == b,
            (Listing::Failed { failure: a, .. }, Listing::Failed { failure: b, .. }) => a == b,
            _ => false,
        }
    }
}

/// What validation knows about one server of a project right now.
#[derive(Debug, Clone, PartialEq)]
pub enum Lookup {
    UnknownServer,
    Pending,
    Ready(Vec<ToolSchema>),
    Failed(McpFailure),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ServerStatus {
    Connected,
    AuthRequired,
    Unavailable,
}

/// One server in `automation_capabilities`. Carries no command, args, env,
/// url, headers or tokens.
#[derive(Debug, Clone, PartialEq, Serialize, schemars::JsonSchema)]
pub struct ServerTools {
    pub server_id: String,
    pub name: String,
    pub transport: String,
    pub status: ServerStatus,
    pub error: Option<String>,
    pub tools: Vec<ToolSchema>,
}

impl ServerTools {
    fn new(server: &McpServerEntry, listing: Listing) -> Self {
        let (status, error, tools) = match listing {
            Listing::Ready { tools, .. } => (ServerStatus::Connected, None, tools),
            Listing::Failed {
                failure: McpFailure::AuthRequired,
                ..
            } => (
                ServerStatus::AuthRequired,
                Some("sign in to this server in the MCP settings".to_string()),
                Vec::new(),
            ),
            Listing::Failed {
                failure: McpFailure::Unavailable(reason),
                ..
            } => (ServerStatus::Unavailable, Some(reason), Vec::new()),
            Listing::Failed {
                failure: McpFailure::UnknownTool,
                ..
            }
            | Listing::Pending => (
                ServerStatus::Unavailable,
                Some("tools/list did not answer".to_string()),
                Vec::new(),
            ),
        };
        Self {
            server_id: server.server_id.clone(),
            name: server.name.clone(),
            transport: server.config.transport(),
            status,
            error,
            tools,
        }
    }
}

type Key = (String, String);

/// The config a listing was taken with, plus the server's OAuth token
/// generation, so an edited server or a sign-in lists it again.
type Identity = (McpServerConfig, u64);

fn identity(config: &McpServerConfig) -> Identity {
    let generation = config
        .url
        .as_deref()
        .map_or(0, crate::acp::mcp_oauth::token_generation);
    (config.clone(), generation)
}

struct Entry {
    identity: Identity,
    listing: Listing,
}

#[derive(Default)]
struct State {
    entries: HashMap<Key, Entry>,
    /// Background listings in flight, so a burst of lookups lists once.
    in_flight: HashSet<Key>,
}

pub struct McpTools {
    servers: ProjectMcpServers,
    roots: ProjectRoots,
    client: Arc<dyn McpClient>,
    clock: Arc<dyn Clock>,
    on_change: OnListingChanged,
    state: Mutex<State>,
}

impl McpTools {
    /// A stdio server lists in its project's root, as runs start it in the
    /// run's working directory.
    pub fn new(
        servers: ProjectMcpServers,
        roots: ProjectRoots,
        client: Arc<dyn McpClient>,
        clock: Arc<dyn Clock>,
        on_change: OnListingChanged,
    ) -> Arc<Self> {
        Arc::new(Self {
            servers,
            roots,
            client,
            clock,
            on_change,
            state: Mutex::new(State::default()),
        })
    }

    /// The project's enabled servers, read from its registry now.
    pub fn servers(&self, project_id: &str) -> Vec<McpServerEntry> {
        (self.servers)(project_id)
    }

    /// The enabled server `server_id` names, by id or alias.
    pub fn server(&self, project_id: &str, server_id: &str) -> Option<McpServerEntry> {
        find_server(&self.servers(project_id), server_id).cloned()
    }

    pub fn client(&self) -> &Arc<dyn McpClient> {
        &self.client
    }

    /// What is known about the server `server_id` names among `servers`, by
    /// id or alias; an alias shares its server's listing. A missing listing is
    /// `Pending`; it, and a listing older than [`STALE_AFTER_MS`], is listed
    /// again in the background when a Tokio runtime is current.
    pub fn lookup(
        self: &Arc<Self>,
        project_id: &str,
        servers: &[McpServerEntry],
        server_id: &str,
    ) -> Lookup {
        let Some(server) = find_server(servers, server_id) else {
            return Lookup::UnknownServer;
        };
        let key = (project_id.to_string(), server.server_id.clone());
        let identity = identity(&server.config);
        let now = self.clock.now_ms();
        let mut state = self.state.lock();
        let (lookup, due) = match state.entries.get(&key) {
            Some(entry) if entry.identity == identity => match &entry.listing {
                Listing::Pending => (Lookup::Pending, true),
                Listing::Ready { tools, at_ms } => {
                    (Lookup::Ready(tools.clone()), now - at_ms >= STALE_AFTER_MS)
                }
                Listing::Failed { failure, at_ms } => (
                    Lookup::Failed(failure.clone()),
                    now - at_ms >= STALE_AFTER_MS,
                ),
            },
            _ => {
                state.entries.insert(
                    key.clone(),
                    Entry {
                        identity,
                        listing: Listing::Pending,
                    },
                );
                (Lookup::Pending, true)
            }
        };
        if due && !state.in_flight.contains(&key) {
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                state.in_flight.insert(key.clone());
                let tools = Arc::clone(self);
                let server = server.clone();
                runtime.spawn(async move {
                    tools.list(&key.0, &server).await;
                    tools.state.lock().in_flight.remove(&key);
                });
            }
        }
        lookup
    }

    /// The input schema of `tool` in the listing kept for `server`'s current
    /// config, else from listing `server` now within [`LISTING_DEADLINE`] and
    /// keeping the result. `None` when that listing fails or lacks `tool`.
    /// Concurrent callers each list: only background lookups share one.
    pub async fn input_schema(
        &self,
        project_id: &str,
        server: &McpServerEntry,
        tool: &str,
    ) -> Option<Value> {
        if let Some(schema) = self.kept_input_schema(project_id, server, tool) {
            return Some(schema);
        }
        let Listing::Ready { tools, .. } = self.list(project_id, server).await else {
            return None;
        };
        tools
            .into_iter()
            .find(|t| t.name == tool)
            .map(|t| t.input_schema)
    }

    fn kept_input_schema(
        &self,
        project_id: &str,
        server: &McpServerEntry,
        tool: &str,
    ) -> Option<Value> {
        let key = (project_id.to_string(), server.server_id.clone());
        let identity = identity(&server.config);
        let state = self.state.lock();
        let entry = state.entries.get(&key).filter(|e| e.identity == identity)?;
        let Listing::Ready { tools, .. } = &entry.listing else {
            return None;
        };
        tools
            .iter()
            .find(|t| t.name == tool)
            .map(|t| t.input_schema.clone())
    }

    /// Lists every enabled server of the project concurrently, each within
    /// [`LISTING_DEADLINE`], and keeps the results.
    pub async fn refresh(&self, project_id: &str) -> Vec<ServerTools> {
        let servers = self.servers(project_id);
        let listings = join_all(servers.iter().map(|s| self.list(project_id, s))).await;
        servers
            .iter()
            .zip(listings)
            .map(|(server, listing)| ServerTools::new(server, listing))
            .collect()
    }

    /// Keeps the tools a run saw for `server`.
    pub fn record(&self, project_id: &str, server: &McpServerEntry, tools: Vec<ToolSchema>) {
        let listing = Listing::Ready {
            tools,
            at_ms: self.clock.now_ms(),
        };
        self.keep(project_id, server, listing);
    }

    async fn list(&self, project_id: &str, server: &McpServerEntry) -> Listing {
        let started = std::time::Instant::now();
        let root = (self.roots)(project_id);
        let listed = tokio::time::timeout(
            LISTING_DEADLINE,
            self.client.list_tools(&server.config, root.as_deref()),
        )
        .await;
        let at_ms = self.clock.now_ms();
        let listing = match listed {
            Ok(Ok(tools)) => Listing::Ready { tools, at_ms },
            Ok(Err(failure)) => Listing::Failed { failure, at_ms },
            Err(_) => Listing::Failed {
                failure: McpFailure::Unavailable(format!(
                    "tools/list did not answer within {} s",
                    LISTING_DEADLINE.as_secs()
                )),
                at_ms,
            },
        };
        log::info!(
            "[Automation] MCP server {} ({}) listed in project {project_id}: {} in {} ms",
            server.server_id,
            server.name,
            match &listing {
                Listing::Ready { tools, .. } => format!("{} tool(s)", tools.len()),
                Listing::Failed {
                    failure: McpFailure::AuthRequired,
                    ..
                } => "auth required".to_string(),
                _ => "unavailable".to_string(),
            },
            started.elapsed().as_millis()
        );
        self.keep(project_id, server, listing.clone());
        listing
    }

    fn keep(&self, project_id: &str, server: &McpServerEntry, listing: Listing) {
        let key = (project_id.to_string(), server.server_id.clone());
        let identity = identity(&server.config);
        let changed = {
            let mut state = self.state.lock();
            let changed = state
                .entries
                .get(&key)
                .is_none_or(|e| e.identity != identity || !e.listing.same_as(&listing));
            state.entries.insert(key, Entry { identity, listing });
            changed
        };
        if changed {
            let ids: Vec<String> = std::iter::once(&server.server_id)
                .chain(&server.aliases)
                .cloned()
                .collect();
            (self.on_change)(project_id, &ids);
        }
    }
}
