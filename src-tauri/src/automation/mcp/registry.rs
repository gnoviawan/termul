//! The project's MCP servers as `mcp_tool` nodes see them. Every client
//! stores the same array of `{ id, enabled?, name, type?, command?, args?,
//! env?, url?, headers?, catalog? }`: termul-server in the project's
//! `.termul/mcp-servers.json`, the desktop once in its web store (the project
//! file there is a best-effort mirror of the active project).

use std::path::Path;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;

use super::McpServerConfig;
use crate::automation::engine::ProjectRoots;
use crate::web::mcp_servers_api::{registry_path, MAX_REGISTRY_BYTES};
use crate::web::store::WebStore;

/// The desktop web store key of the MCP server list.
pub const DESKTOP_STORE_KEY: &str = "shared/lww/acp/mcp-servers";

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

/// At most one byte past the limit, so an oversized file is refused
/// without loading it.
fn read_capped(path: &Path) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(MAX_REGISTRY_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn read_project_file(root: &Path) -> Vec<McpServerEntry> {
    let path = registry_path(root);
    match read_capped(&path) {
        Ok(bytes) if bytes.len() > MAX_REGISTRY_BYTES => {
            log::warn!("[Automation] MCP registry file is over 1 MiB; ignoring it");
            Vec::new()
        }
        Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(value) => parse_registry(&value),
            Err(_) => {
                log::warn!("[Automation] MCP registry file is not JSON; ignoring it");
                Vec::new()
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => {
            log::warn!("[Automation] MCP registry file unreadable: {error}");
            Vec::new()
        }
    }
}

/// termul-server: the project's `.termul/mcp-servers.json`.
pub fn project_file_servers(roots: ProjectRoots) -> ProjectMcpServers {
    Arc::new(move |project_id| {
        roots(project_id)
            .map(|root| read_project_file(&root))
            .unwrap_or_default()
    })
}

/// Desktop: the one list in the web store, for every project. A store with
/// no list yet, a value that is not a list, or a store that cannot be read
/// falls back to the project file.
pub fn desktop_store_servers(store: Arc<WebStore>, roots: ProjectRoots) -> ProjectMcpServers {
    let from_file = project_file_servers(roots);
    Arc::new(move |project_id| match store.peek(DESKTOP_STORE_KEY) {
        Ok(Some(value)) if registry_items(&value).is_some() => parse_registry(&value),
        Ok(Some(_)) => {
            log::warn!("[Automation] the stored MCP server list has no list shape; reading the project file");
            from_file(project_id)
        }
        Ok(None) => from_file(project_id),
        Err(error) => {
            log::warn!("[Automation] MCP servers unreadable from the store: {error}");
            from_file(project_id)
        }
    })
}
