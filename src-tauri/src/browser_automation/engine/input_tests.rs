use parking_lot::Mutex;
use serde_json::json;

use super::*;
use crate::browser_automation::engine::events::DialogAnswer;
use crate::browser_automation::engine::observe::ConsoleEntry;
use crate::browser_automation::engine::{CapabilityTable, ChildFrame, EngineTraits};

#[test]
fn key_names_parse_to_named_keys_or_one_character() {
    assert_eq!(Key::parse("Enter"), Some(Key::Named(NamedKey::Enter)));
    assert_eq!(Key::parse("ArrowDown"), Some(Key::Named(NamedKey::ArrowDown)));
    assert_eq!(Key::parse("Space"), Some(Key::Named(NamedKey::Space)));
    assert_eq!(Key::parse(" "), Some(Key::Named(NamedKey::Space)));
    assert_eq!(Key::parse("é"), Some(Key::Char('é')));
    assert_eq!(Key::parse("Control+a"), None);
    assert_eq!(Key::parse(""), None);
    assert_eq!(Key::parse("\u{7}"), None);
}

#[test]
fn facts_parse_from_the_helper_reply() {
    let facts = parse_facts(json!({
        "state": "present", "role": "textbox", "name": "Email", "x": 10.5, "y": 20.0,
        "visible": true, "stable": false, "hit": true, "enabled": true, "kind": "text",
        "focusOnClick": true
    }))
    .unwrap();
    assert_eq!(
        facts,
        ActionabilityFacts::Present(ElementState {
            role: "textbox".into(),
            name: "Email".into(),
            point: Point { x: 10.5, y: 20.0 },
            visible: true,
            stable: false,
            hit: true,
            enabled: true,
            kind: ControlKind::Text,
            focus_on_click: true,
        })
    );
    assert_eq!(parse_facts(json!({ "state": "detached" })).unwrap(), ActionabilityFacts::Detached);
    let with_extra = json!({
        "state": "present", "role": "textbox", "name": "Email", "x": 10.5, "y": 20.0,
        "visible": true, "stable": true, "hit": true, "enabled": true, "kind": "text",
        "focusOnClick": true, "forged": true
    });
    let bad_kind = json!({
        "state": "present", "role": "textbox", "name": "Email", "x": 10.5, "y": 20.0,
        "visible": true, "stable": true, "hit": true, "enabled": true, "kind": "button",
        "focusOnClick": true
    });
    for bad in [
        json!({}),
        json!({ "state": "present", "role": "x" }),
        json!("stale_ref"),
        json!({ "error": "stale_ref" }),
        with_extra,
        bad_kind,
    ] {
        assert_eq!(parse_facts(bad.clone()).unwrap_err().kind, EngineErrorKind::Malformed, "{bad}");
    }
}

struct Inner(EngineFacts);

impl BrowserEngine for Inner {
    fn facts(&self) -> &EngineFacts {
        &self.0
    }
    fn evaluate<'a>(&'a self, _tab: &'a str, script: Script) -> EngineFuture<'a, Value> {
        assert_eq!(script, assets::facts("html>body>button:nth-of-type(1)"));
        Box::pin(async { Ok(json!({ "state": "detached" })) })
    }
    fn pointer_click<'a>(&'a self, _tab: &'a str, _at: Point, _mode: InputMode) -> EngineFuture<'a, ()> {
        unreachable!("the layer owns input")
    }
    fn screenshot<'a>(&'a self, _tab: &'a str) -> EngineFuture<'a, Vec<u8>> {
        unreachable!()
    }
    fn answer_dialog<'a>(&'a self, _tab: &'a str, id: u64, answer: DialogAnswer) -> EngineFuture<'a, bool> {
        Box::pin(async move { Ok(id == 7 && answer == DialogAnswer::Dismiss) })
    }
    fn child_frames<'a>(&'a self, _tab: &'a str) -> EngineFuture<'a, Vec<ChildFrame>> {
        Box::pin(async {
            Ok(vec![ChildFrame {
                id: "F1".into(),
                parent: None,
                owner_path: "html>body>iframe:nth-of-type(1)".into(),
            }])
        })
    }
    fn evaluate_in_frame<'a>(&'a self, _tab: &'a str, frame: &'a str, script: Script) -> EngineFuture<'a, Value> {
        assert_eq!((frame, script), ("F1", assets::facts("html>body>a:nth-of-type(1)")));
        Box::pin(async {
            Ok(json!({
                "state": "present", "role": "link", "name": "Pay", "x": 5.0, "y": 6.0,
                "visible": true, "stable": true, "hit": true, "enabled": true, "kind": "other",
                "focusOnClick": false
            }))
        })
    }
    fn pull_console<'a>(&'a self, _tab: &'a str) -> EngineFuture<'a, Vec<ConsoleEntry>> {
        Box::pin(async { Err(EngineError::new(EngineErrorKind::FrameGone)) })
    }
    fn set_input_files<'a>(
        &'a self,
        _tab: &'a str,
        frame: Option<&'a str>,
        _path: &'a str,
        files: &'a [std::path::PathBuf],
    ) -> EngineFuture<'a, ()> {
        assert_eq!((frame, files.len()), (Some("F1"), 1));
        Box::pin(async { Ok(()) })
    }
}

#[derive(Default)]
struct Recorded(Mutex<Vec<String>>);

const MAC_LIKE: &[(CapabilityId, Support)] = &[
    (CapabilityId::PointerClick, Support::Trusted),
    (CapabilityId::TrustedKey, Support::Trusted),
    (CapabilityId::PointerMove, Support::Synthetic),
];

impl NativeInput for Recorded {
    fn tiers(&self) -> &'static [(CapabilityId, Support)] {
        MAC_LIKE
    }
    fn press_support(&self) -> Option<Support> {
        Some(Support::Synthetic)
    }
    fn click<'a>(&'a self, _tab: &'a str, at: Point) -> EngineFuture<'a, ()> {
        self.0.lock().push(format!("click {} {}", at.x, at.y));
        Box::pin(async { Ok(()) })
    }
    fn move_to<'a>(&'a self, _tab: &'a str, _at: Point) -> EngineFuture<'a, ()> {
        self.0.lock().push("move".into());
        Box::pin(async { Ok(()) })
    }
    fn key<'a>(&'a self, _tab: &'a str, input: KeyInput<'a>) -> EngineFuture<'a, ()> {
        self.0.lock().push(format!("{input:?}"));
        Box::pin(async { Ok(()) })
    }
}

fn layered() -> (WithNativeInput<Inner>, Arc<Recorded>) {
    let inner = Inner(EngineFacts {
        capabilities: CapabilityTable::unavailable("eval only")
            .with(CapabilityId::IsolatedEval, Support::Trusted)
            .with(CapabilityId::PointerClick, Support::Synthetic),
        traits: EngineTraits {
            isolated_world: true,
            background_render: false,
            network_observe: false,
        },
    });
    let input = Arc::new(Recorded::default());
    (WithNativeInput::new(inner, input.clone()), input)
}

#[tokio::test]
async fn the_layer_raises_declared_tiers_and_refuses_trusted_input_elsewhere() {
    let (engine, input) = layered();
    let caps = &engine.facts().capabilities;
    assert_eq!(caps.get(CapabilityId::PointerClick), Support::Trusted);
    assert_eq!(caps.get(CapabilityId::PointerMove), Support::Synthetic);
    assert_eq!(caps.get(CapabilityId::IsolatedEval), Support::Trusted, "eval tier is the inner engine's");
    assert!(matches!(caps.get(CapabilityId::Wheel), Support::Unavailable(_)));
    assert_eq!(engine.key_support(KeyKind::Text), Support::Trusted);
    assert_eq!(engine.key_support(KeyKind::Press), Support::Synthetic);

    let at = Point { x: 1.0, y: 2.0 };
    engine.pointer_click("agent-1", at, InputMode::Trusted).await.unwrap();
    engine.key("agent-1", KeyInput::Text("hi"), InputMode::Trusted).await.unwrap();
    let refused = [
        engine.pointer_click("agent-1", at, InputMode::Synthetic).await,
        engine.pointer_move("agent-1", at, InputMode::Trusted).await,
        engine.wheel("agent-1", at, (0.0, 10.0), InputMode::Trusted).await,
        engine.key("agent-1", KeyInput::Press(Key::Named(NamedKey::Enter)), InputMode::Trusted).await,
    ];
    for result in refused {
        assert_eq!(result.unwrap_err().kind, EngineErrorKind::Unsupported);
    }
    assert_eq!(input.0.lock().as_slice(), ["click 1 2", "Text(\"hi\")"]);
    assert_eq!(
        engine.element_facts("agent-1", None, "html>body>button:nth-of-type(1)").await.unwrap(),
        ActionabilityFacts::Detached,
        "facts come through the inner engine's eval"
    );
    assert!(
        engine.answer_dialog("agent-1", 7, DialogAnswer::Dismiss).await.unwrap(),
        "dialog answers reach the inner engine"
    );
    assert_eq!(engine.child_frames("agent-1").await.unwrap()[0].id, "F1");
    let framed = engine
        .element_facts("agent-1", Some("F1"), "html>body>a:nth-of-type(1)")
        .await
        .unwrap();
    assert!(
        matches!(framed, ActionabilityFacts::Present(ref s) if s.point == Point { x: 5.0, y: 6.0 }),
        "a frame ref's facts are read in its frame: {framed:?}"
    );
    assert_eq!(
        engine.pull_console("agent-1").await.unwrap_err().kind,
        EngineErrorKind::FrameGone,
        "console pulls reach the inner engine"
    );
    engine
        .set_input_files("agent-1", Some("F1"), "html>body>input:nth-of-type(1)", &["a.txt".into()])
        .await
        .unwrap();
}
