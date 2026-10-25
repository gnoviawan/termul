//! Trusted input over CDP's `Input` domain. Coordinates are main-frame
//! CSS px, which is what `Input.dispatchMouseEvent` takes.

use serde_json::{json, Value};

use super::{CdpMethod, CdpTransport};
use crate::browser_automation::engine::{EngineError, Key, NamedKey, Point};

/// Pointer moves between a drag's press and release.
const DRAG_STEPS: u32 = 6;

async fn mouse(transport: &dyn CdpTransport, tab: &str, params: Value) -> Result<(), EngineError> {
    transport
        .call(tab, CdpMethod::InputDispatchMouseEvent, params)
        .await
        .map(drop)
}

pub async fn move_to(transport: &dyn CdpTransport, tab: &str, at: Point) -> Result<(), EngineError> {
    mouse(transport, tab, json!({ "type": "mouseMoved", "x": at.x, "y": at.y })).await
}

pub async fn wheel(
    transport: &dyn CdpTransport,
    tab: &str,
    at: Point,
    dx: f64,
    dy: f64,
) -> Result<(), EngineError> {
    mouse(
        transport,
        tab,
        json!({ "type": "mouseWheel", "x": at.x, "y": at.y, "deltaX": dx, "deltaY": dy }),
    )
    .await
}

/// Press at `from`, move to `to` in steps with the left button held, and
/// release there: the sequence mouse-event drags (sliders, canvases) see.
pub async fn drag(
    transport: &dyn CdpTransport,
    tab: &str,
    from: Point,
    to: Point,
) -> Result<(), EngineError> {
    let button = |kind: &str, at: Point| {
        json!({ "type": kind, "x": at.x, "y": at.y, "button": "left", "buttons": 1, "clickCount": 1 })
    };
    mouse(transport, tab, json!({ "type": "mouseMoved", "x": from.x, "y": from.y })).await?;
    mouse(transport, tab, button("mousePressed", from)).await?;
    for step in 1..=DRAG_STEPS {
        let t = f64::from(step) / f64::from(DRAG_STEPS);
        let at = Point {
            x: from.x + (to.x - from.x) * t,
            y: from.y + (to.y - from.y) * t,
        };
        mouse(
            transport,
            tab,
            json!({ "type": "mouseMoved", "x": at.x, "y": at.y, "button": "left", "buttons": 1 }),
        )
        .await?;
    }
    mouse(transport, tab, button("mouseReleased", to)).await
}

/// Insert text into the focused element (`beforeinput` and `input`, no
/// key events), as an IME commit does.
pub async fn insert_text(transport: &dyn CdpTransport, tab: &str, text: &str) -> Result<(), EngineError> {
    transport
        .call(tab, CdpMethod::InputInsertText, json!({ "text": text }))
        .await
        .map(drop)
}

/// `(key, code, windowsVirtualKeyCode, text)` for a key, as a US layout
/// produces them.
fn key_fields(key: Key) -> (String, String, u32, Option<String>) {
    let named = |code: &str, vk: u32, text: Option<&str>| (code.to_string(), vk, text.map(str::to_string));
    let (code, vk, text) = match key {
        Key::Named(k) => match k {
            NamedKey::Enter => named("Enter", 13, Some("\r")),
            NamedKey::Tab => named("Tab", 9, None),
            NamedKey::Escape => named("Escape", 27, None),
            NamedKey::Backspace => named("Backspace", 8, None),
            NamedKey::Delete => named("Delete", 46, None),
            NamedKey::ArrowLeft => named("ArrowLeft", 37, None),
            NamedKey::ArrowUp => named("ArrowUp", 38, None),
            NamedKey::ArrowRight => named("ArrowRight", 39, None),
            NamedKey::ArrowDown => named("ArrowDown", 40, None),
            NamedKey::Home => named("Home", 36, None),
            NamedKey::End => named("End", 35, None),
            NamedKey::PageUp => named("PageUp", 33, None),
            NamedKey::PageDown => named("PageDown", 34, None),
            NamedKey::Space => named("Space", 32, Some(" ")),
        },
        Key::Char(c) => {
            let upper = c.to_ascii_uppercase();
            let (code, vk) = if upper.is_ascii_uppercase() {
                (format!("Key{upper}"), u32::from(upper))
            } else if c.is_ascii_digit() {
                (format!("Digit{c}"), u32::from(c))
            } else {
                (String::new(), 0)
            };
            (code, vk, Some(c.to_string()))
        }
    };
    (key.dom_key(), code, vk, text)
}

/// One key's down and up. A key with text sends `keyDown` (which inserts
/// it); one without sends `rawKeyDown`.
pub async fn press(transport: &dyn CdpTransport, tab: &str, key: Key) -> Result<(), EngineError> {
    let (key, code, vk, text) = key_fields(key);
    let mut down = json!({
        "type": if text.is_some() { "keyDown" } else { "rawKeyDown" },
        "key": key,
        "code": code,
        "windowsVirtualKeyCode": vk,
    });
    if let Some(text) = text {
        down["text"] = Value::String(text.clone());
        down["unmodifiedText"] = Value::String(text);
    }
    transport.call(tab, CdpMethod::InputDispatchKeyEvent, down).await?;
    let up = json!({ "type": "keyUp", "key": key, "code": code, "windowsVirtualKeyCode": vk });
    transport
        .call(tab, CdpMethod::InputDispatchKeyEvent, up)
        .await
        .map(drop)
}

#[cfg(test)]
#[path = "input_tests.rs"]
mod tests;
