//! Page helper scripts the core hands to [`super::BrowserEngine::evaluate`].
//!
//! Each helper is a static function body over one parameter object `p`,
//! built from the files in `assets/` at compile time. Agent strings reach
//! a helper only inside `p`, which every engine passes as a native call
//! argument, so no agent text is ever part of script source. An element is
//! named by the structural path the snapshot reported for it, which also
//! pins a fingerprint of the element (its telling attributes, the text of
//! the list item or card holding it, and for an element with no name the
//! text before it), so a path that now leads to another element finds
//! nothing. Helpers keep no state between calls, save one exception: an
//! upload's `input`/`change` watch leaves the hook that ends it early on
//! the agent world's own document wrapper, where page script cannot reach
//! it, and removes it when it ends.

use serde_json::{json, Value};

/// The isolated script world every helper runs in.
pub const WORLD_NAME: &str = "termul_agent";

macro_rules! helper {
    ($name:literal) => {
        Helper {
            name: $name,
            body: concat!(
                include_str!("assets/prelude.js"),
                include_str!(concat!("assets/", $name, ".js"))
            ),
        }
    };
}

/// One static helper: a function body over the parameter object `p`
/// whose return value is JSON-serializable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Helper {
    pub name: &'static str,
    pub body: &'static str,
}

pub const SNAPSHOT: Helper = helper!("snapshot");
pub const RESOLVE: Helper = helper!("resolve");
pub const CLICK: Helper = helper!("click");
pub const FILL: Helper = helper!("fill");
pub const TYPE: Helper = helper!("type");
pub const PRESS: Helper = helper!("press");
pub const SCROLL: Helper = helper!("scroll");
pub const HOVER: Helper = helper!("hover");
pub const DRAG: Helper = helper!("drag");
pub const CONTAINS_TEXT: Helper = helper!("contains_text");
pub const READ_TEXT: Helper = helper!("read_text");
pub const READY_STATE: Helper = helper!("ready_state");
pub const FACTS: Helper = helper!("facts");
pub const PREPARE_TEXT: Helper = helper!("prepare_text");
pub const FOCUSED_EDITABLE: Helper = helper!("focused_editable");
pub const VIEWPORT: Helper = helper!("viewport");
pub const SETTLE: Helper = helper!("settle");
pub const LOCATION: Helper = helper!("location");
pub const CHECKED_STATE: Helper = helper!("checked_state");
pub const SELECT_OPTION: Helper = helper!("select_option");
pub const FRAME_ORIGIN: Helper = helper!("frame_origin");
pub const FOCUSED_FRAME: Helper = helper!("focused_frame");
#[cfg(any(test, target_os = "windows"))]
pub const OWNER_PATH: Helper = helper!("owner_path");
#[cfg_attr(target_os = "windows", allow(dead_code, reason = "WebView2 reads the console through CDP"))]
pub const CONSOLE_PULL: Helper = helper!("console_pull");
pub const SENSITIVITY: Helper = helper!("sensitivity");
pub const CARD_FIELDS: Helper = helper!("card_fields");
pub const OVERLAY_VISIBILITY: Helper = helper!("overlay_visibility");
pub const FRAME_SOURCES: Helper = helper!("frame_sources");
/// The conformance suite's probe of the agent overlay.
#[cfg(any(test, feature = "conformance"))]
pub const OVERLAY_STATE: Helper = helper!("overlay_state");
/// Only CDP engines set a file input through the element itself.
#[cfg(any(test, target_os = "windows"))]
pub const FILE_INPUT: Helper = helper!("file_input");
/// WebKit engines set a file input by answering the chooser it opens.
#[cfg(any(test, target_os = "macos", target_os = "linux"))]
pub const OPEN_FILE_CHOOSER: Helper = helper!("open_file_chooser");
/// WebKit engines confirm the answered chooser filled the input.
#[cfg(any(test, target_os = "macos", target_os = "linux"))]
pub const INPUT_FILE_COUNT: Helper = helper!("input_file_count");
/// WebKit engines also hear the input change, for a page that clears it.
#[cfg(any(test, target_os = "macos", target_os = "linux"))]
pub const WATCH_INPUT_FILES: Helper = helper!("watch_input_files");
/// And end that watch once the upload settled.
#[cfg(any(test, target_os = "macos", target_os = "linux"))]
pub const END_INPUT_WATCH: Helper = helper!("end_input_watch");

/// Main-world script every agent tab frame runs at document start on
/// engines whose console is observed by page script: it buffers console
/// calls and uncaught errors until [`console_pull`] collects them. Page
/// script can read, forge or bypass it, so its entries are synthetic.
#[cfg_attr(target_os = "windows", allow(dead_code, reason = "WebView2 reads the console through CDP"))]
pub const CONSOLE_SHIM: &str = include_str!("assets/console_shim.js");

/// Main-world script every agent tab's main frame runs at document start:
/// the "Iris" agent-control overlay, a pointer-transparent pixel grid on a
/// closed shadow root under `<html>`. Page script can find or tamper with
/// it (accepted); the trusted agent indicators live outside the page.
pub const AGENT_OVERLAY: &str = include_str!("assets/agent_overlay.js");

/// The tag of the overlay's host element, which [`overlay_visibility`]
/// finds it by.
#[cfg(test)]
pub const OVERLAY_TAG: &str = "termul-agent-overlay";

/// A helper with its parameters, ready for an engine.
#[derive(Debug, Clone, PartialEq)]
pub struct Script {
    pub helper: Helper,
    pub params: Value,
}

impl Script {
    fn new(helper: Helper, params: Value) -> Self {
        Self { helper, params }
    }
}

/// Hide (`false`) or show the agent overlay. Hiding resolves after two
/// frames, so a capture taken next has no overlay in it, and the overlay
/// shows itself again after [`OVERLAY_SELF_RESTORE`] unless a show came
/// first.
pub fn overlay_visibility(visible: bool) -> Script {
    let restore_ms = u64::try_from(OVERLAY_SELF_RESTORE.as_millis()).unwrap_or(u64::MAX);
    Script::new(
        OVERLAY_VISIBILITY,
        json!({ "visible": visible, "restoreMs": restore_ms }),
    )
}

/// How long a hidden overlay waits for the host's show before it shows
/// itself: a failed, timed-out or dropped restore cannot leave it hidden.
pub const OVERLAY_SELF_RESTORE: std::time::Duration = std::time::Duration::from_secs(3);

/// How many agent overlays hang off `<html>`, and whether the first shows.
#[cfg(any(test, feature = "conformance"))]
pub fn overlay_state() -> Script {
    Script::new(OVERLAY_STATE, json!({}))
}

/// The absolute URLs the document's frames, objects and embeds point at.
pub fn frame_sources() -> Script {
    Script::new(FRAME_SOURCES, json!({}))
}

/// `document.readyState`, to settle after a navigation.
pub fn ready_state() -> Script {
    Script::new(READY_STATE, json!({}))
}

/// The page outline: structured items, with one `node` per actionable
/// element carrying its role, name and structural path.
pub fn snapshot() -> Script {
    Script::new(SNAPSHOT, json!({}))
}

/// The outline of a cross-origin child frame the host reached on its own:
/// each node path also pins the frame's current document.
pub fn frame_snapshot() -> Script {
    Script::new(SNAPSHOT, json!({ "inFrame": true }))
}

/// The path of the frame element holding focus when its document is out
/// of this frame's reach (another origin); null otherwise.
pub fn focused_frame() -> Script {
    Script::new(FOCUSED_FRAME, json!({}))
}

/// Where the content box of the frame element at `path` starts, in this
/// frame's viewport px.
pub fn frame_origin(path: &str) -> Script {
    Script::new(FRAME_ORIGIN, json!({ "path": path }))
}

/// The path of the element the call is bound to (`this`), for engines
/// that resolve a frame's owner element natively.
#[cfg(any(test, target_os = "windows"))]
pub fn owner_path() -> Script {
    Script::new(OWNER_PATH, json!({}))
}

/// Collect what the console shim buffered, in this frame and its
/// same-origin frames.
#[cfg_attr(target_os = "windows", allow(dead_code, reason = "WebView2 reads the console through CDP"))]
pub fn console_pull() -> Script {
    Script::new(CONSOLE_PULL, json!({}))
}

/// Scroll the element at `path` into view and report its centre, role and
/// name.
pub fn resolve(path: &str) -> Script {
    Script::new(RESOLVE, json!({ "path": path }))
}

/// Report the centre, role and name of the element at `path` without
/// scrolling it, for verbs that only read it.
pub fn resolve_in_place(path: &str) -> Script {
    Script::new(RESOLVE, json!({ "path": path, "scroll": false }))
}

/// Synthetic pointer and click events on the element at `path`.
pub fn click(path: &str) -> Script {
    Script::new(CLICK, json!({ "path": path }))
}

/// Replace the value of the field at `path`, with input and change events.
pub fn fill(path: &str, value: &str) -> Script {
    Script::new(FILL, json!({ "path": path, "value": value }))
}

/// Append `text` to the field at `path`, or to the focused element.
pub fn type_text(path: Option<&str>, text: &str) -> Script {
    Script::new(TYPE, json!({ "path": path, "text": text }))
}

/// Key events for `key` on the element at `path`, or the focused element.
pub fn press(path: Option<&str>, key: &str) -> Script {
    Script::new(PRESS, json!({ "path": path, "key": key }))
}

/// Scroll the element at `path` into view, or the page by `dy` px.
pub fn scroll(path: Option<&str>, dy: f64) -> Script {
    Script::new(SCROLL, json!({ "path": path, "dy": dy }))
}

/// Synthetic hover events on the element at `path`.
pub fn hover(path: &str) -> Script {
    Script::new(HOVER, json!({ "path": path }))
}

/// Synthetic pointer and mouse events that press on the element at `path`,
/// move in steps to the element at `to` and release there. Both are in the
/// frame the helper runs in.
pub fn drag(path: &str, to: &str) -> Script {
    Script::new(DRAG, json!({ "path": path, "to": to }))
}

/// The closed sensitivity facts about the element at `path`, or about the
/// focused element without one.
pub fn sensitivity(path: Option<&str>) -> Script {
    Script::new(SENSITIVITY, json!({ "path": path }))
}

/// Whether the document shows a payment-card field, its open shadow roots
/// and same-origin frames included.
pub fn card_fields() -> Script {
    Script::new(CARD_FIELDS, json!({}))
}

/// The file input at `path` itself, for engines that set its files by
/// element handle; null when `path` names anything else.
#[cfg(any(test, target_os = "windows"))]
pub fn file_input(path: &str) -> Script {
    Script::new(FILE_INPUT, json!({ "path": path }))
}

/// Have the file input at `path` open its chooser; false when `path`
/// names anything else.
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn open_file_chooser(path: &str) -> Script {
    Script::new(OPEN_FILE_CHOOSER, json!({ "path": path }))
}

/// How many files the file input at `path` holds; -1 when `path` names
/// anything else.
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn input_file_count(path: &str) -> Script {
    Script::new(INPUT_FILE_COUNT, json!({ "path": path }))
}

/// Resolves true once the file input at `path` fires a trusted `input` or
/// `change`, false after `wait`, when [`end_input_watch`] ends watch `id`,
/// or at once when `path` names anything else. Issued before the chooser
/// opens, so it hears the upload land even when the page clears the input
/// in its handler.
#[cfg(any(test, target_os = "macos", target_os = "linux"))]
pub fn watch_input_files(path: &str, id: u64, wait: std::time::Duration) -> Script {
    let ms = u64::try_from(wait.as_millis()).unwrap_or(u64::MAX);
    Script::new(
        WATCH_INPUT_FILES,
        json!({ "path": path, "id": id.to_string(), "ms": ms }),
    )
}

/// End watch `id` from [`watch_input_files`] now, releasing its listeners
/// and timer; true when it was still listening.
#[cfg(any(test, target_os = "macos", target_os = "linux"))]
pub fn end_input_watch(id: u64) -> Script {
    Script::new(END_INPUT_WATCH, json!({ "id": id.to_string() }))
}

/// Up to `limit` UTF-16 units of the rendered text of the element at
/// `path`, or of the whole document, from offset `cursor`, with the offset
/// the slice ends at and the text's full length.
pub fn read_text(path: Option<&str>, cursor: u64, limit: u64) -> Script {
    Script::new(READ_TEXT, json!({ "path": path, "cursor": cursor, "limit": limit }))
}

/// Whether the page's visible text contains `text`.
pub fn contains_text(text: &str) -> Script {
    Script::new(CONTAINS_TEXT, json!({ "text": text }))
}

/// Actionability facts for the element at `path`, measured over two
/// animation frames; parsed by [`super::input::parse_facts`]. It finds the
/// element whether or not it is shown, so a hidden target reports
/// `visible: false` instead of reading as gone. An element outside the
/// viewport is scrolled into view, and that round reports it unstable.
pub fn facts(path: &str) -> Script {
    Script::new(FACTS, json!({ "path": path }))
}

/// After a trusted click focused the text control at `path`: select its
/// whole content (`replace`) or put the caret at its end. Fails with
/// `not_focused` when the click did not focus it.
pub fn prepare_text(path: &str, replace: bool) -> Script {
    Script::new(PREPARE_TEXT, json!({ "path": path, "replace": replace }))
}

/// Whether the focused element takes typed text.
pub fn focused_editable() -> Script {
    Script::new(FOCUSED_EDITABLE, json!({}))
}

/// Resolves after the page has rendered two frames, so input queued
/// before it has been handled.
pub fn settle() -> Script {
    Script::new(SETTLE, json!({}))
}

/// The viewport size, for page-level wheel input.
pub fn viewport() -> Script {
    Script::new(VIEWPORT, json!({}))
}

/// The document's own URL, which also moves on `pushState`.
pub fn location() -> Script {
    Script::new(LOCATION, json!({}))
}

/// Whether the checkbox, switch or radio at `path` is checked.
pub fn checked_state(path: &str) -> Script {
    Script::new(CHECKED_STATE, json!({ "path": path }))
}

/// Pick the option of the select at `path` whose value, else label, is
/// `value`, through the same value setter and events as `fill`.
pub fn select_option(path: &str, value: &str) -> Script {
    Script::new(SELECT_OPTION, json!({ "path": path, "value": value }))
}

#[cfg(test)]
#[path = "assets_tests.rs"]
mod tests;
