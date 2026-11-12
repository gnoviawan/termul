//! The MCP servers as `mcp_tool` nodes see them: the host's one list in its
//! web store (see `web::mcp_registry`), the same for every project.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;

use super::McpServerConfig;
use crate::web::mcp_registry::STORE_KEY;
use crate::web::store::WebStore;

/// The enabled MCP servers of a project id.
pub type ProjectMcpServers = Arc<dyn Fn(&str) -> Vec<McpServerEntry> + Send + Sync>;

/// An enabled server. `server_id` is the stored entry's host-assigned `id`.
#[derive(Debug, Clone, PartialEq)]
pub struct McpServerEntry {
    pub server_id: String,
    pub name: String,
    pub config: McpServerConfig,
}

#[derive(Deserialize)]
struct StoredEntry {
    id: String,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(flatten)]
    config: McpServerConfig,
}

/// The enabled, well-formed entries of a stored list, bare or in the
/// renderer's `{ _version, data }` envelope. The first entry wins a
/// duplicate id.
pub fn parse_registry(value: &Value) -> Vec<McpServerEntry> {
    let Some(items) = registry_items(value) else {
        log::warn!(
            "[Automation] the stored MCP registry is not a list; no MCP servers are available"
        );
        return Vec::new();
    };
    let mut entries: Vec<McpServerEntry> = Vec::new();
    let mut malformed = 0;
    for item in items {
        let Ok(stored) = StoredEntry::deserialize(item) else {
            malformed += 1;
            continue;
        };
        let (id, name) = (stored.id.trim(), stored.config.name.trim());
        if id.is_empty() || name.is_empty() {
            malformed += 1;
            continue;
        }
        if stored.enabled == Some(false) || entries.iter().any(|e| e.server_id == id) {
            continue;
        }
        entries.push(McpServerEntry {
            server_id: id.to_string(),
            name: name.to_string(),
            config: stored.config,
        });
    }
    if malformed > 0 {
        log::debug!("[Automation] skipped {malformed} malformed MCP registry entries");
    }
    entries
}

/// The stored list, bare or in the `{ _version, data }` envelope; `None`
/// when `value` has neither shape.
fn registry_items(value: &Value) -> Option<&Vec<Value>> {
    match value {
        Value::Array(items) => Some(items),
        Value::Object(map) => match map.get("data") {
            Some(Value::Array(items)) => Some(items),
            _ => None,
        },
        _ => None,
    }
}

/// The host's one MCP server list, for every project. A store with no list
/// yet, a value without list shape, or a store that cannot be read yields no
/// servers.
pub fn store_servers(store: Arc<WebStore>) -> ProjectMcpServers {
    Arc::new(move |_project_id| match store.peek(STORE_KEY) {
        Ok(Some(value)) => parse_registry(&value),
        Ok(None) => Vec::new(),
        Err(error) => {
            log::warn!("[Automation] MCP servers unreadable from the store: {error}");
            Vec::new()
        }
    })
}
