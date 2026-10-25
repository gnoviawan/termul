use parking_lot::Mutex;
use serde_json::{json, Value};

use super::*;
use crate::browser_automation::engine::EngineFuture;

#[derive(Default)]
struct Recorder(Mutex<Vec<(&'static str, Value)>>);

impl CdpTransport for Recorder {
    fn call<'a>(&'a self, _tab: &'a str, method: CdpMethod, params: Value) -> EngineFuture<'a, Value> {
        self.0.lock().push((method.as_str(), params));
        Box::pin(async { Ok(json!({})) })
    }
}

impl Recorder {
    fn calls(&self) -> Vec<(&'static str, Value)> {
        self.0.lock().clone()
    }
}

#[tokio::test]
async fn enter_sends_a_text_key_down_and_arrow_down_a_raw_one() {
    let t = Recorder::default();
    press(&t, "agent-1", Key::Named(NamedKey::Enter)).await.unwrap();
    press(&t, "agent-1", Key::Named(NamedKey::ArrowDown)).await.unwrap();
    assert_eq!(
        t.calls(),
        [
            (
                "Input.dispatchKeyEvent",
                json!({ "type": "keyDown", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "text": "\r", "unmodifiedText": "\r" })
            ),
            (
                "Input.dispatchKeyEvent",
                json!({ "type": "keyUp", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13 })
            ),
            (
                "Input.dispatchKeyEvent",
                json!({ "type": "rawKeyDown", "key": "ArrowDown", "code": "ArrowDown", "windowsVirtualKeyCode": 40 })
            ),
            (
                "Input.dispatchKeyEvent",
                json!({ "type": "keyUp", "key": "ArrowDown", "code": "ArrowDown", "windowsVirtualKeyCode": 40 })
            ),
        ]
    );
}

#[tokio::test]
async fn a_letter_key_carries_its_us_layout_code() {
    let t = Recorder::default();
    press(&t, "agent-1", Key::Char('q')).await.unwrap();
    let (_, down) = &t.calls()[0];
    assert_eq!(down["code"], "KeyQ");
    assert_eq!(down["windowsVirtualKeyCode"], 81);
    assert_eq!(down["text"], "q");
}

#[tokio::test]
async fn a_drag_presses_moves_with_the_button_held_and_releases_at_the_end() {
    let t = Recorder::default();
    drag(&t, "agent-1", Point { x: 0.0, y: 10.0 }, Point { x: 60.0, y: 10.0 })
        .await
        .unwrap();
    let calls = t.calls();
    let kinds: Vec<&str> = calls.iter().map(|(_, p)| p["type"].as_str().unwrap()).collect();
    assert_eq!(
        kinds,
        ["mouseMoved", "mousePressed", "mouseMoved", "mouseMoved", "mouseMoved", "mouseMoved", "mouseMoved", "mouseMoved", "mouseReleased"]
    );
    assert!(calls[2..8].iter().all(|(_, p)| p["buttons"] == 1));
    assert_eq!(calls[7].1["x"], 60.0);
    assert_eq!(calls[8].1["x"], 60.0);
}

#[tokio::test]
async fn text_goes_through_insert_text_and_pointer_events_carry_their_point() {
    let t = Recorder::default();
    insert_text(&t, "agent-1", "héllo").await.unwrap();
    move_to(&t, "agent-1", Point { x: 5.0, y: 6.0 }).await.unwrap();
    wheel(&t, "agent-1", Point { x: 5.0, y: 6.0 }, 0.0, 300.0).await.unwrap();
    assert_eq!(
        t.calls(),
        [
            ("Input.insertText", json!({ "text": "héllo" })),
            ("Input.dispatchMouseEvent", json!({ "type": "mouseMoved", "x": 5.0, "y": 6.0 })),
            (
                "Input.dispatchMouseEvent",
                json!({ "type": "mouseWheel", "x": 5.0, "y": 6.0, "deltaX": 0.0, "deltaY": 300.0 })
            ),
        ]
    );
}
