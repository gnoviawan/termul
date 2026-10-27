//! What an agent's canvas call did, read from the call alone (spine AD-17:
//! the host keeps no document state). One figcraft tool sends several
//! control frames; the tool name says which of them carries the agent's
//! intent, so every other frame of that tool derives nothing.

use serde_json::Value;

/// How the editor rings the touched nodes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Look {
    Write,
    Read,
}

impl Look {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Write => "write",
            Self::Read => "read",
        }
    }
}

/// A node's `absoluteBounds`, in page coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Bounds {
    /// `absoluteBounds` of a node as `node.get` / `document.inspect` return it.
    #[must_use]
    pub fn of_node(node: &Value) -> Option<Self> {
        let bounds = node.get("absoluteBounds")?;
        let field = |key: &str| bounds.get(key).and_then(Value::as_f64);
        Some(Self {
            x: field("x")?,
            y: field("y")?,
            width: field("width")?,
            height: field("height")?,
        })
    }

    #[must_use]
    pub fn centre(self) -> (f64, f64) {
        (self.x + self.width / 2.0, self.y + self.height / 2.0)
    }
}

/// Where the activity happened.
#[derive(Debug, Clone, PartialEq)]
pub enum Targets {
    /// Nodes the call named or produced, in order; `last` carries the last
    /// one's bounds when the call's own result had them.
    Nodes { ids: Vec<u64>, last: Option<Bounds> },
    /// The call acted on the editor's selection without naming ids.
    Selection,
    /// The current page's top-level layers (a whole-page read).
    Page,
    /// The nodes are gone (a delete): the cursor stays where it was.
    InPlace,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Activity {
    pub kind: Look,
    pub targets: Targets,
}

/// At most this many ids are flashed per activity (the last ones touched).
pub const MAX_FLASH_IDS: usize = 40;

const EXECUTE: &str = "engine.execute";

/// Command namespaces that change no layer, so they show no presence.
const QUIET_NAMESPACES: &[&str] = &[
    "app",
    "dev",
    "doc",
    "file",
    "help",
    "layers",
    "libraries",
    "page",
    "pref",
    "tool",
    "version",
    "view",
    "window",
];

/// Commands in other namespaces that change no layer.
const QUIET_COMMANDS: &[&str] = &["proto.linkNotice"];

/// The activity behind one control frame `method(params) -> result` that the
/// agent tool `tool` sent, or `None` when the frame shows nothing (a helper
/// frame of the tool, a UI-only or file call). `result` is parsed only by
/// the tools whose ids or bounds live in it.
#[must_use]
pub fn derive_activity(tool: &str, method: &str, params: &Value, result: &str) -> Option<Activity> {
    let command = (method == EXECUTE).then(|| executed(params)).flatten();
    match (tool, method, command) {
        ("create_node", _, Some(("node.create", _))) => {
            write(nodes(ids_in(&command_result(params, result)), None))
        }
        ("set_properties", _, Some(("node.set", inner))) => write(named_or_selection(inner)),
        ("run_command" | "batch" | "undo" | "redo", _, Some((command, inner))) => {
            command_activity(command, inner, || command_result(params, result))
        }
        ("type_text", _, Some(("text.edit.begin", inner))) => write(nodes(ids_in(inner), None)),
        ("select", _, Some(("select.set", inner))) => read(nodes(ids_in(inner), None)),
        ("export", _, Some(("file.export", inner))) => read(named_or_selection(inner)),
        ("get_node", "node.get", _) => {
            let node = parse(result);
            read(nodes(ids_in(params), Bounds::of_node(&node)))
        }
        ("inspect_document", "document.inspect", _) => read(page_layers(&parse(result))),
        ("screenshot", "host.renderPng", _) => {
            let ids = ids_in(params);
            read(if ids.is_empty() {
                Targets::Page
            } else {
                nodes(ids, None)
            })
        }
        _ => None,
    }
}

/// A command the agent ran by name (`run_command`, `batch`, `undo`, `redo`).
fn command_activity(
    command: &str,
    params: &Value,
    result: impl FnOnce() -> Value,
) -> Option<Activity> {
    let namespace = command
        .split_once('.')
        .map_or(command, |(namespace, _)| namespace);
    match command {
        "command.batch" => {
            let mut ids = Vec::new();
            for step in params
                .get("commands")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(inner) = step.get("params") {
                    ids.extend(ids_in(inner));
                }
            }
            // termul-v0.4.0's editor answers a named batch with {results, names}.
            let result = result();
            let steps = result.get("results").unwrap_or(&result);
            for step in steps.as_array().into_iter().flatten() {
                ids.extend(ids_in(step));
            }
            write(if ids.is_empty() {
                Targets::Selection
            } else {
                nodes(ids, None)
            })
        }
        "edit.delete" => write(Targets::InPlace),
        "edit.undo" | "edit.redo" => write(Targets::Selection),
        "file.export" => read(named_or_selection(params)),
        "select.none" => None,
        // A font load changes only the auto-sizing text it refits.
        "text.loadFont" | "text.rescanFonts" => {
            let refitted = result()
                .get("refitted")
                .and_then(Value::as_array)
                .map(|ids| ids.iter().filter_map(Value::as_u64).collect())
                .unwrap_or_default();
            write(nodes(refitted, None))
        }
        _ if namespace == "select" => read(named_or_selection(params)),
        _ if QUIET_NAMESPACES.contains(&namespace) || QUIET_COMMANDS.contains(&command) => None,
        _ => {
            let mut ids = ids_in(params);
            ids.extend(ids_in(&result()));
            write(if ids.is_empty() {
                Targets::Selection
            } else {
                nodes(ids, None)
            })
        }
    }
}

/// `{command, params}` of an `engine.execute` frame.
fn executed(params: &Value) -> Option<(&str, &Value)> {
    let command = params.get("command")?.as_str()?;
    Some((command, params.get("params").unwrap_or(&Value::Null)))
}

fn write(targets: Targets) -> Option<Activity> {
    shown(Look::Write, targets)
}

fn read(targets: Targets) -> Option<Activity> {
    shown(Look::Read, targets)
}

/// Named nodes with no id (a result without one) show nothing.
fn shown(kind: Look, targets: Targets) -> Option<Activity> {
    match &targets {
        Targets::Nodes { ids, .. } if ids.is_empty() => None,
        _ => Some(Activity { kind, targets }),
    }
}

fn parse(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or(Value::Null)
}

/// The command's own result in the reply to the `engine.execute` frame
/// `execute`. figcraft-mcp asks a mutating call for its layout issues
/// (`issues: true`); an editor that lists them replies `{result, issues}`,
/// one that does not replies with the bare result.
fn command_result(execute: &Value, reply: &str) -> Value {
    let reply = parse(reply);
    if execute.get("issues") != Some(&Value::Bool(true)) {
        return reply;
    }
    match reply {
        Value::Object(mut envelope)
            if envelope.contains_key("result")
                && envelope.get("issues").is_some_and(Value::is_array) =>
        {
            envelope.remove("result").unwrap_or(Value::Null)
        }
        bare => bare,
    }
}

/// The ids, deduplicated in order of last mention, at most the last
/// [`MAX_FLASH_IDS`].
fn nodes(ids: Vec<u64>, last: Option<Bounds>) -> Targets {
    let mut kept: Vec<u64> = Vec::with_capacity(ids.len());
    for id in ids.into_iter().rev() {
        if !kept.contains(&id) {
            kept.push(id);
        }
        if kept.len() == MAX_FLASH_IDS {
            break;
        }
    }
    kept.reverse();
    Targets::Nodes { ids: kept, last }
}

fn named_or_selection(params: &Value) -> Targets {
    let ids = ids_in(params);
    if ids.is_empty() {
        Targets::Selection
    } else {
        nodes(ids, None)
    }
}

/// `ids` (an array or one id) and `id` of an object. Ids are u64 numbers;
/// a `$step`, `$ref` or `$name` reference or any other shape is skipped.
fn ids_in(value: &Value) -> Vec<u64> {
    let mut ids = Vec::new();
    match value.get("ids") {
        Some(Value::Array(list)) => ids.extend(list.iter().filter_map(Value::as_u64)),
        Some(one) => ids.extend(one.as_u64()),
        None => {}
    }
    ids.extend(value.get("id").and_then(Value::as_u64));
    ids
}

/// The current page's top-level layers of a `document.inspect` result, with
/// the last one's bounds; [`Targets::Page`] when it lists none.
pub(super) fn page_layers(document: &Value) -> Targets {
    let current = document.get("currentPage");
    let pages = document.get("pages").and_then(Value::as_array);
    let page = pages.and_then(|pages| {
        pages
            .iter()
            .find(|page| page.get("id") == current)
            .or_else(|| pages.first())
    });
    let layers: Vec<&Value> = page
        .and_then(|page| page.get("children"))
        .and_then(Value::as_array)
        .map(|children| children.iter().collect())
        .unwrap_or_default();
    if layers.is_empty() {
        return Targets::Page;
    }
    let ids = layers
        .iter()
        .filter_map(|layer| layer.get("id").and_then(Value::as_u64))
        .collect();
    let last = layers.last().and_then(|layer| Bounds::of_node(layer));
    nodes(ids, last)
}

/// The selection of a `document.inspect` result.
pub(super) fn selection_of(document: &Value) -> Targets {
    let ids = document
        .get("selection")
        .and_then(Value::as_array)
        .map(|ids| ids.iter().filter_map(Value::as_u64).collect())
        .unwrap_or_default();
    nodes(ids, None)
}
