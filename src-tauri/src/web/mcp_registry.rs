//! The host's one MCP server list: the array of `{ id, enabled?, name,
//! type?, command?, args?, env?, url?, headers?, catalog? }` every client
//! reads and writes through `persistenceApi` under the logical key
//! `acp/mcp-servers`, stored in the host [`WebStore`] at [`STORE_KEY`] in
//! the renderer's `{ _version, data }` envelope.
//!
//! Before the list was host-wide, `troupe-server` kept one list per project
//! in `<project root>/.termul/mcp-servers.json`. [`import_project_files`]
//! merges those files into the store once; the files stay on disk. The id of
//! an entry it drops as a copy of a kept one stays usable by automation
//! `mcp_tool` steps through [`ALIASES_KEY`].

use std::collections::{BTreeMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tracing::{info, warn};

use crate::web::project_registry::ProjectRegistry;
use crate::web::store::{unix_ms, StoreError, WebStore};

/// Host store key of the MCP server list.
pub const STORE_KEY: &str = "shared/lww/acp/mcp-servers";

/// Host store key of `{ droppedId: keptId }`: ids the import dropped with a
/// copy of a kept server, in the `{ _version, data }` envelope. Only the
/// import writes it; automation resolves a node's `server_id` through it.
pub const ALIASES_KEY: &str = "shared/lww/acp/mcp-server-aliases";

/// `_version` of the renderer's stored-value envelope.
const STORED_VALUE_VERSION: u64 = 1;

/// A legacy project file larger than this is skipped.
const MAX_LEGACY_FILE_BYTES: usize = 1024 * 1024;

/// The per-project list `troupe-server` kept before the list was host-wide.
#[must_use]
pub fn legacy_project_file(project_root: &Path) -> PathBuf {
    project_root.join(".termul").join("mcp-servers.json")
}

/// What [`import_project_files`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Import {
    /// The store already holds a list; nothing was read or written.
    AlreadyStored,
    /// The merged list of `files` readable project files was stored, with
    /// `aliases` dropped ids recorded under [`ALIASES_KEY`].
    Imported {
        servers: usize,
        files: usize,
        aliases: usize,
    },
}

/// Import the legacy list of every registered, non-archived project.
pub fn import_registered_project_files(
    store: &WebStore,
    registry: &ProjectRegistry,
) -> Result<Import, StoreError> {
    let roots: Vec<PathBuf> = registry
        .snapshot()
        .projects
        .iter()
        .filter_map(|project| registry.canonical_root(&project.id))
        .collect();
    import_project_files(store, &roots)
}

/// When the store holds no MCP server list, store the union of the legacy
/// files under `project_roots`, in order. A later entry with an id already
/// taken, or with a taken name and the same launch, is a duplicate and is
/// dropped; a taken name with a different launch is kept under the first
/// free `<name>-<n>`. The id of an entry dropped for its name and launch is
/// stored under [`ALIASES_KEY`] as an alias of the kept entry, before the
/// list, so a failed write leaves no list and the next start imports again.
/// Missing files are skipped silently, unreadable or malformed ones with a
/// warning. Writes at most once: a rerun finds the list.
pub fn import_project_files(
    store: &WebStore,
    project_roots: &[PathBuf],
) -> Result<Import, StoreError> {
    if store.peek(STORE_KEY)?.is_some() {
        return Ok(Import::AlreadyStored);
    }
    let mut merged = Merged::default();
    let mut files = 0;
    for root in project_roots {
        if let Some(entries) = read_legacy_file(&legacy_project_file(root)) {
            files += 1;
            for entry in entries {
                merged.add(entry);
            }
        }
    }
    let servers = merged.entries.len();
    let aliases = merged.kept_aliases();
    let alias_count = aliases.len();
    if alias_count > 0 {
        let value = json!({ "_version": STORED_VALUE_VERSION, "data": aliases });
        if !store.insert_if_absent(ALIASES_KEY, value, unix_ms())? {
            warn!("kept the MCP server aliases already in the store");
        }
    }
    let value = json!({ "_version": STORED_VALUE_VERSION, "data": merged.entries });
    if !store.insert_if_absent(STORE_KEY, value, unix_ms())? {
        return Ok(Import::AlreadyStored);
    }
    info!(
        servers,
        files,
        aliases = alias_count,
        "stored the MCP server list merged from the per-project files"
    );
    Ok(Import::Imported {
        servers,
        files,
        aliases: alias_count,
    })
}

fn read_legacy_file(path: &Path) -> Option<Vec<Value>> {
    let mut bytes = Vec::new();
    let read = std::fs::File::open(path).and_then(|file| {
        file.take(MAX_LEGACY_FILE_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
    });
    match read {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            warn!(path = %path.display(), %error, "skipping an unreadable project MCP server file");
            return None;
        }
    }
    if bytes.len() > MAX_LEGACY_FILE_BYTES {
        warn!(path = %path.display(), "skipping a project MCP server file over 1 MiB");
        return None;
    }
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(Value::Array(entries)) => Some(entries),
        Ok(_) | Err(_) => {
            warn!(path = %path.display(), "skipping a project MCP server file that is not a JSON array");
            None
        }
    }
}

#[derive(Default)]
struct Merged {
    entries: Vec<Value>,
    ids: HashSet<String>,
    /// The name each kept entry arrived with, its launch, and its id.
    launches: Vec<(String, Value, String)>,
    /// The id of each entry dropped for a kept entry's name and launch, to
    /// the kept entry's id.
    aliases: BTreeMap<String, String>,
}

impl Merged {
    fn add(&mut self, mut entry: Value) {
        let (Some(id), Some(name)) = (text_field(&entry, "id"), text_field(&entry, "name")) else {
            return;
        };
        let launch = launch_shape(&entry);
        if self.ids.contains(&id) {
            return;
        }
        if let Some((_, _, kept_id)) = self
            .launches
            .iter()
            .find(|(kept, kept_launch, _)| *kept == name && *kept_launch == launch)
        {
            self.aliases.entry(id).or_insert_with(|| kept_id.clone());
            return;
        }
        let taken: HashSet<&str> = self
            .entries
            .iter()
            .filter_map(|kept| kept.get("name").and_then(Value::as_str))
            .collect();
        let unique = unique_name(&name, &taken);
        if unique != name {
            entry["name"] = Value::String(unique);
        }
        self.ids.insert(id.clone());
        self.launches.push((name, launch, id));
        self.entries.push(entry);
    }

    /// The aliases, less any id a later kept entry has: that id names it.
    fn kept_aliases(&self) -> BTreeMap<&str, &str> {
        self.aliases
            .iter()
            .filter(|(alias, _)| !self.ids.contains(*alias))
            .map(|(alias, kept)| (alias.as_str(), kept.as_str()))
            .collect()
    }
}

fn text_field(entry: &Value, field: &str) -> Option<String> {
    let text = entry.get(field)?.as_str()?;
    (!text.trim().is_empty()).then(|| text.to_string())
}

/// What a launch digest covers, as the renderer's `sameLaunch` compares it:
/// the transport and its target, plus env or header names (not values).
fn launch_shape(entry: &Value) -> Value {
    let names = |field: &str| -> Vec<Value> {
        entry
            .get(field)
            .and_then(Value::as_array)
            .map(|pairs| {
                pairs
                    .iter()
                    .map(|pair| pair.get("name").cloned().unwrap_or(Value::Null))
                    .collect()
            })
            .unwrap_or_default()
    };
    match entry.get("type").and_then(Value::as_str) {
        Some(transport @ ("http" | "sse")) => {
            json!([transport, entry.get("url"), names("headers")])
        }
        _ => json!([
            "stdio",
            entry.get("command"),
            entry.get("args").cloned().unwrap_or_else(|| json!([])),
            names("env")
        ]),
    }
}

/// The renderer's `uniqueName`: `proposed`, or `proposed-<n>` for the
/// smallest `n >= 2` not taken.
fn unique_name(proposed: &str, taken: &HashSet<&str>) -> String {
    if !taken.contains(proposed) {
        return proposed.to_string();
    }
    (2..)
        .map(|suffix| format!("{proposed}-{suffix}"))
        .find(|candidate| !taken.contains(candidate.as_str()))
        .expect("a free suffix exists")
}

#[cfg(test)]
#[path = "mcp_registry_tests.rs"]
mod tests;
