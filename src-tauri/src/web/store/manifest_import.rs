//! One-shot import of the retired workspace manifests (issue #1073).
//!
//! Until the manifest was retired, the host kept one `<projectId>.json` file
//! per project in its `workspace-manifests` directory: an envelope
//! `{schemaVersion: 1, manifest}` carrying a portable pane tree, the active
//! pane and the open terminal and editor descriptors. The renderer now keeps
//! that state in its own `workspace/<projectId>` key. When the first device
//! adopts the store ([`super::legacy::adopt`]), every manifest is converted to
//! the `PersistedEditorState` shape the renderer reads there and written under
//! that device's partition — only where the key is still absent. The directory
//! is then renamed to `<dir>.imported-<unix-secs>`; it is a backup and is never
//! deleted.
//!
//! A manifest file that cannot be read, parsed or converted is skipped with a
//! warning and stays where it is.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};
use tracing::{info, warn};

use super::STORE_VALUE_MAX_BYTES;

/// The manifest envelope version this build reads.
const MANIFEST_SCHEMA_VERSION: u64 = 1;

/// Version stamp the web persistence facade puts on every stored value.
const STORED_VALUE_VERSION: u64 = 1;

/// Largest manifest file read (they are a few KiB).
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;

/// Read every manifest file under `dir` and convert it to the renderer's
/// stored workspace value. Returns `(projectId, value)` pairs ordered by
/// project id. Files that are not manifests (lock file, backups, temp files)
/// are ignored; unreadable or unconvertible manifests are skipped with a
/// warning.
pub fn read_workspaces(dir: &Path) -> Vec<(String, Value)> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) => {
            warn!(
                target: "termul::web::store",
                "could not list the workspace manifests in '{}': {error}",
                dir.display()
            );
            return Vec::new();
        }
    };
    let mut files: Vec<(String, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension()? != "json" {
                return None;
            }
            let project_id = path.file_stem()?.to_str()?.to_string();
            (!project_id.starts_with('.')).then_some((project_id, path))
        })
        .collect();
    files.sort();
    files
        .into_iter()
        .filter_map(|(project_id, path)| match convert_file(&path) {
            Ok(Some(value)) => Some((project_id, value)),
            Ok(None) => None,
            Err(reason) => {
                warn!(
                    target: "termul::web::store",
                    "skipped the workspace manifest '{}': {reason}",
                    path.display()
                );
                None
            }
        })
        .collect()
}

/// `<name>.imported-<unix-secs>` beside `path` (with a `-<n>` suffix when that
/// name is taken): where an imported source is kept as a backup.
pub(super) fn retired_target(path: &Path, now_ms: u64) -> Option<PathBuf> {
    let name = path.file_name()?;
    let base = format!("{}.imported-{}", name.to_string_lossy(), now_ms / 1000);
    let mut target = path.with_file_name(&base);
    let mut attempt = 1;
    while target.exists() {
        target = path.with_file_name(format!("{base}-{attempt}"));
        attempt += 1;
    }
    Some(target)
}

/// Rename `dir` to `<dir>.imported-<unix-secs>` (with a `-<n>` suffix when that
/// name is taken). A failure only warns: the import is not repeated because the
/// store marks the adoption done.
pub fn retire_dir(dir: &Path, now_ms: u64) {
    let Some(target) = retired_target(dir, now_ms) else {
        return;
    };
    match fs::rename(dir, &target) {
        Ok(()) => info!(
            target: "termul::web::store",
            "workspace manifests imported; the directory is kept as '{}'",
            target.display()
        ),
        Err(error) => warn!(
            target: "termul::web::store",
            "could not rename the imported workspace manifests '{}' to '{}': {error}",
            dir.display(),
            target.display()
        ),
    }
}

fn convert_file(path: &Path) -> Result<Option<Value>, String> {
    let length = fs::metadata(path).map_err(|e| e.to_string())?.len();
    if length > MAX_MANIFEST_BYTES {
        return Err(format!(
            "the file is {length} bytes (max {MAX_MANIFEST_BYTES})"
        ));
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let envelope: Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("invalid JSON: {e}"))?;
    match envelope.get("schemaVersion").and_then(Value::as_u64) {
        Some(MANIFEST_SCHEMA_VERSION) => {}
        other => return Err(format!("unsupported schemaVersion {other:?}")),
    }
    let manifest = envelope
        .get("manifest")
        .and_then(Value::as_object)
        .ok_or("the envelope has no manifest object")?;
    let Some(state) = convert(manifest) else {
        return Ok(None);
    };
    let stored = json!({ "_version": STORED_VALUE_VERSION, "data": state });
    let size = serde_json::to_vec(&stored)
        .map_err(|e| e.to_string())?
        .len();
    if size > STORE_VALUE_MAX_BYTES {
        return Err(format!(
            "the converted value is {size} bytes (max {STORE_VALUE_MAX_BYTES})"
        ));
    }
    Ok(Some(stored))
}

/// A tab the portable manifest can describe.
enum Tab {
    Terminal(String),
    Editor(String),
}

impl Tab {
    /// The renderer's tab id (`workspace-store/tree.ts`).
    fn id(&self) -> String {
        match self {
            Self::Terminal(terminal_id) => format!("term-{terminal_id}"),
            Self::Editor(file_path) => format!("edit-{file_path}"),
        }
    }

    fn to_json(&self) -> Value {
        match self {
            Self::Terminal(terminal_id) => json!({ "type": "terminal", "terminalId": terminal_id }),
            Self::Editor(file_path) => json!({ "type": "editor", "filePath": file_path }),
        }
    }
}

/// The pane tree, rebuilt from the portable topology.
enum Pane {
    Leaf {
        id: String,
        tabs: Vec<Tab>,
        active_tab_id: Option<String>,
    },
    Split {
        id: String,
        direction: &'static str,
        children: Vec<Pane>,
        sizes: Vec<Value>,
    },
}

impl Pane {
    fn to_json(&self) -> Value {
        match self {
            Self::Leaf {
                id,
                tabs,
                active_tab_id,
            } => json!({
                "type": "leaf",
                "id": id,
                "tabs": tabs.iter().map(Tab::to_json).collect::<Vec<_>>(),
                "activeTabId": active_tab_id,
            }),
            Self::Split {
                id,
                direction,
                children,
                sizes,
            } => json!({
                "type": "split",
                "id": id,
                "direction": direction,
                "children": children.iter().map(Self::to_json).collect::<Vec<_>>(),
                "sizes": sizes,
            }),
        }
    }

    /// Leaves in tree order.
    fn leaves<'a>(&'a self, out: &mut Vec<&'a Pane>) {
        match self {
            Self::Leaf { .. } => out.push(self),
            Self::Split { children, .. } => {
                for child in children {
                    child.leaves(out);
                }
            }
        }
    }
}

/// The manifest's descriptors, by the ids a pane tree refers to them with.
struct Descriptors<'a> {
    terminals: HashSet<&'a str>,
    /// `editorId` -> file path.
    editors: HashMap<&'a str, &'a str>,
}

/// Convert one manifest to a `PersistedEditorState`. `None` when the manifest
/// carries nothing a restore would show (no editor, no terminal tab).
fn convert(manifest: &Map<String, Value>) -> Option<Value> {
    let list = |name: &str| -> &[Value] {
        manifest
            .get(name)
            .and_then(Value::as_array)
            .map_or(&[], Vec::as_slice)
    };
    let descriptors = Descriptors {
        terminals: list("terminals")
            .iter()
            .filter_map(|terminal| terminal.get("terminalId")?.as_str())
            .collect(),
        editors: list("editors")
            .iter()
            .filter_map(|editor| {
                Some((editor.get("editorId")?.as_str()?, editor.get("filePath")?.as_str()?))
            })
            .collect(),
    };

    // Every editor descriptor is an open file, in manifest order, once.
    let mut seen = HashSet::new();
    let file_paths: Vec<&str> = list("editors")
        .iter()
        .filter_map(|editor| editor.get("filePath")?.as_str())
        .filter(|path| seen.insert(*path))
        .collect();

    let root = manifest
        .get("topology")
        .and_then(|node| rebuild(node, &descriptors));
    let mut leaves = Vec::new();
    if let Some(root) = &root {
        root.leaves(&mut leaves);
    }
    let has_tabs = leaves
        .iter()
        .any(|leaf| matches!(leaf, Pane::Leaf { tabs, .. } if !tabs.is_empty()));
    if file_paths.is_empty() && !has_tabs {
        return None;
    }

    let last_modified = manifest.get("updatedAt").and_then(Value::as_u64).unwrap_or(0);
    let open_files: Vec<Value> = file_paths
        .iter()
        .map(|path| {
            json!({
                "filePath": path,
                "cursorPosition": { "line": 1, "col": 1 },
                "scrollTop": 0,
                "viewMode": view_mode(path),
                "isDirty": false,
                "lastModified": last_modified,
            })
        })
        .collect();

    let mut state = json!({
        "openFiles": open_files,
        "activeFilePath": null,
        "expandedDirs": [],
        "activeTabId": null,
    });
    if let (Some(root), Some(&first)) = (&root, leaves.first()) {
        let requested = manifest.get("activePaneId").and_then(Value::as_str);
        let active = leaves
            .iter()
            .copied()
            .find(|leaf| matches!(leaf, Pane::Leaf { id, .. } if Some(id.as_str()) == requested))
            .unwrap_or(first);
        if let Pane::Leaf {
            id,
            tabs,
            active_tab_id,
        } = active
        {
            state["activePaneId"] = json!(id);
            state["activeTabId"] = json!(active_tab_id);
            state["activeFilePath"] = tabs
                .iter()
                .find(|tab| Some(tab.id()) == *active_tab_id)
                .and_then(|tab| match tab {
                    Tab::Editor(path) => Some(json!(path)),
                    Tab::Terminal(_) => None,
                })
                .unwrap_or(Value::Null);
        }
        state["paneLayout"] = root.to_json();
    }
    Some(state)
}

/// Rebuild one portable node. A terminal or editor id without a descriptor is
/// dropped; a node that is not a leaf or split (or lacks an id or a valid
/// direction) is dropped with its subtree.
fn rebuild(node: &Value, descriptors: &Descriptors<'_>) -> Option<Pane> {
    let id = node.get("id")?.as_str()?.to_string();
    match node.get("type")?.as_str()? {
        "leaf" => {
            let ids = |name: &str| -> Vec<&str> {
                node.get(name)
                    .and_then(Value::as_array)
                    .map_or_else(Vec::new, |ids| ids.iter().filter_map(Value::as_str).collect())
            };
            let mut tabs: Vec<Tab> = ids("terminalIds")
                .into_iter()
                .filter(|terminal_id| descriptors.terminals.contains(terminal_id))
                .map(|terminal_id| Tab::Terminal(terminal_id.to_string()))
                .collect();
            tabs.extend(
                ids("editorIds")
                    .into_iter()
                    .filter_map(|editor_id| descriptors.editors.get(editor_id))
                    .map(|path| Tab::Editor((*path).to_string())),
            );
            let requested = node.get("activeTabId").and_then(Value::as_str);
            let active_tab_id = requested
                .filter(|wanted| tabs.iter().any(|tab| tab.id() == *wanted))
                .map(str::to_string)
                .or_else(|| tabs.first().map(Tab::id));
            Some(Pane::Leaf {
                id,
                tabs,
                active_tab_id,
            })
        }
        "split" => {
            let direction = match node.get("direction")?.as_str()? {
                "horizontal" => "horizontal",
                "vertical" => "vertical",
                _ => return None,
            };
            let children: Vec<Pane> = node
                .get("children")?
                .as_array()?
                .iter()
                .filter_map(|child| rebuild(child, descriptors))
                .collect();
            if children.is_empty() {
                return None;
            }
            Some(Pane::Split {
                id,
                direction,
                sizes: split_sizes(node.get("sizes"), children.len()),
                children,
            })
        }
        _ => None,
    }
}

/// The recorded sizes when they fit the surviving children, else an even split.
fn split_sizes(recorded: Option<&Value>, children: usize) -> Vec<Value> {
    let usable = recorded
        .and_then(Value::as_array)
        .filter(|sizes| {
            sizes.len() == children
                && sizes
                    .iter()
                    .all(|size| size.as_f64().is_some_and(|n| n.is_finite() && n > 0.0))
        })
        .cloned();
    usable.unwrap_or_else(|| vec![json!(100.0 / children as f64); children])
}

/// The editor's default view of a file: Markdown renders, everything else is code.
fn view_mode(file_path: &str) -> &'static str {
    let name = file_path.rsplit(['/', '\\']).next().unwrap_or(file_path);
    match name.rsplit_once('.') {
        Some((_, extension)) if extension.eq_ignore_ascii_case("md") => "markdown",
        _ => "code",
    }
}
