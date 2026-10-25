//! The stdio protocol: one JSON object per line. `apps/gpuix/src/browser/protocol.ts` is the
//! other side; keep the two in step.

use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// App -> helper. Every command but `quit` carries `req`, answered by one `ack`.
#[derive(Deserialize, Debug, PartialEq)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Command {
    Create { req: u64, id: String, url: String, bounds: Bounds },
    /// A canvas tab: the relay page, which frames `url` and passes messages both ways.
    CreateCanvas { req: u64, id: String, url: String, bounds: Bounds },
    /// Deliver `data` (one message as JSON text) to a canvas tab's framed page.
    Post { req: u64, id: String, data: String },
    Bounds { req: u64, id: String, bounds: Bounds },
    Show { req: u64, id: String },
    Hide { req: u64, id: String },
    Navigate { req: u64, id: String, url: String },
    Back { req: u64, id: String },
    Forward { req: u64, id: String },
    Reload { req: u64, id: String },
    Devtools { req: u64, id: String },
    Destroy { req: u64, id: String },
    /// Give the keyboard back to the app window (a GPUIX element took focus).
    Blur { req: u64 },
    Quit,
}

impl Command {
    pub fn req(&self) -> Option<u64> {
        match self {
            Command::Create { req, .. }
            | Command::CreateCanvas { req, .. }
            | Command::Post { req, .. }
            | Command::Bounds { req, .. }
            | Command::Show { req, .. }
            | Command::Hide { req, .. }
            | Command::Navigate { req, .. }
            | Command::Back { req, .. }
            | Command::Forward { req, .. }
            | Command::Reload { req, .. }
            | Command::Devtools { req, .. }
            | Command::Destroy { req, .. }
            | Command::Blur { req } => Some(*req),
            Command::Quit => None,
        }
    }
}

/// Helper -> app.
#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "ev", rename_all = "camelCase")]
pub enum Event {
    Ready { parent: u64, pid: u32 },
    Ack {
        req: u64,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Navigated { id: String, url: String },
    Loaded { id: String, url: String },
    Title { id: String, title: String },
    Console { id: String, level: String, text: String },
    /// A message a canvas tab's framed page posted to its parent, as JSON text.
    CanvasMessage { id: String, data: String },
    /// Which webview holds the keyboard; `None` means the app window does.
    Keyboard { owner: Option<String> },
    /// The helper cannot run (no parent window, no X display) and exits.
    Fatal { error: String },
    /// A line the helper could not parse.
    Invalid { line: String, error: String },
}

/// What the page's init script posts through `window.ipc`.
#[derive(Deserialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PageMessage {
    Console { level: String, text: String },
    Url { url: String },
    /// The canvas relay page forwarding one message from its frame.
    CanvasMessage { data: String },
}

pub fn parse_command(line: &str) -> Result<Command, String> {
    serde_json::from_str(line).map_err(|e| e.to_string())
}

pub fn parse_page_message(body: &str) -> Option<PageMessage> {
    serde_json::from_str(body).ok()
}

pub fn encode(event: &Event) -> String {
    serde_json::to_string(event).expect("events serialize")
}

#[cfg(test)]
#[path = "protocol_tests.rs"]
mod tests;
