//! Input port: the input commands the core sends an engine, the element
//! facts it checks before each one, and the layer that adds an adapter's
//! native input to its eval engine. Every coordinate is main-frame CSS px;
//! adapters convert to their own units.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;

use super::assets::{self, Script};
use super::{
    BrowserEngine, CapabilityId, EngineError, EngineErrorKind, EngineFacts,
    EngineFuture, Support,
};

/// The input mode the core picks from the capability tier.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputMode {
    Trusted,
    Synthetic,
}

/// A point in main-frame CSS px.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// Non-text keys an agent can press. Anything else is one character.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NamedKey {
    Enter,
    Tab,
    Escape,
    Backspace,
    Delete,
    ArrowLeft,
    ArrowUp,
    ArrowRight,
    ArrowDown,
    Home,
    End,
    PageUp,
    PageDown,
    Space,
}

impl NamedKey {
    const ALL: [NamedKey; 14] = [
        NamedKey::Enter,
        NamedKey::Tab,
        NamedKey::Escape,
        NamedKey::Backspace,
        NamedKey::Delete,
        NamedKey::ArrowLeft,
        NamedKey::ArrowUp,
        NamedKey::ArrowRight,
        NamedKey::ArrowDown,
        NamedKey::Home,
        NamedKey::End,
        NamedKey::PageUp,
        NamedKey::PageDown,
        NamedKey::Space,
    ];

    /// The DOM `KeyboardEvent.key` value.
    pub fn dom_key(self) -> &'static str {
        match self {
            NamedKey::Enter => "Enter",
            NamedKey::Tab => "Tab",
            NamedKey::Escape => "Escape",
            NamedKey::Backspace => "Backspace",
            NamedKey::Delete => "Delete",
            NamedKey::ArrowLeft => "ArrowLeft",
            NamedKey::ArrowUp => "ArrowUp",
            NamedKey::ArrowRight => "ArrowRight",
            NamedKey::ArrowDown => "ArrowDown",
            NamedKey::Home => "Home",
            NamedKey::End => "End",
            NamedKey::PageUp => "PageUp",
            NamedKey::PageDown => "PageDown",
            NamedKey::Space => " ",
        }
    }
}

/// One key press.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    Named(NamedKey),
    Char(char),
}

impl Key {
    /// Parse an agent key name: a DOM key name (`Enter`, `ArrowDown`,
    /// `Space`) or a single character.
    pub fn parse(name: &str) -> Option<Key> {
        if name == "Space" {
            return Some(Key::Named(NamedKey::Space));
        }
        if let Some(named) = NamedKey::ALL.into_iter().find(|k| k.dom_key() == name) {
            return Some(Key::Named(named));
        }
        let mut chars = name.chars();
        match (chars.next(), chars.next()) {
            (Some(c), None) if !c.is_control() => Some(Key::Char(c)),
            _ => None,
        }
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code, reason = "only CDP key events carry the DOM key name"))]
    pub fn dom_key(self) -> String {
        match self {
            Key::Named(k) => k.dom_key().to_string(),
            Key::Char(c) => c.to_string(),
        }
    }
}

/// Keyboard input. `Text` inserts characters into the focused element;
/// `Press` sends one key's down and up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyInput<'a> {
    Text(&'a str),
    Press(Key),
}

/// The two halves of `trusted_key`, which an engine may support at
/// different tiers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyKind {
    Text,
    Press,
}

/// What kind of form control an element is, for text entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ControlKind {
    /// Accepts typed text (`:read-write`).
    Text,
    Select,
    Other,
}

/// The checks the core runs before acting on an element.
#[derive(Debug, Clone, PartialEq)]
pub enum ActionabilityFacts {
    /// The ref's locator no longer finds an element.
    Detached,
    Present(ElementState),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ElementState {
    pub role: String,
    pub name: String,
    /// Where an action lands: the centre of the element's box.
    pub point: Point,
    pub visible: bool,
    /// In the viewport with the same box for two frames.
    pub stable: bool,
    /// The hit test at `point` lands on the element or its composed-tree
    /// descendant.
    pub hit: bool,
    pub enabled: bool,
    pub kind: ControlKind,
    /// A click at `point` focuses something: a text field, a select, an
    /// editable or tabindex element, or a label's control.
    pub focus_on_click: bool,
}

fn malformed() -> EngineError {
    EngineError::new(EngineErrorKind::Malformed)
}

/// The facts helper's reply, exactly as the helper writes it.
#[derive(Deserialize)]
#[serde(tag = "state", rename_all = "lowercase")]
enum FactsReply {
    Detached,
    Present(PresentFacts),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PresentFacts {
    role: String,
    name: String,
    x: f64,
    y: f64,
    visible: bool,
    stable: bool,
    hit: bool,
    enabled: bool,
    kind: ControlKind,
    focus_on_click: bool,
}

/// Parse the facts helper's reply ([`assets::facts`]). Any other shape is
/// malformed.
pub fn parse_facts(out: Value) -> Result<ActionabilityFacts, EngineError> {
    let reply = serde_json::from_value::<FactsReply>(out).map_err(|_| malformed())?;
    Ok(match reply {
        FactsReply::Detached => ActionabilityFacts::Detached,
        FactsReply::Present(f) => ActionabilityFacts::Present(ElementState {
            role: f.role,
            name: f.name,
            point: Point { x: f.x, y: f.y },
            visible: f.visible,
            stable: f.stable,
            hit: f.hit,
            enabled: f.enabled,
            kind: f.kind,
            focus_on_click: f.focus_on_click,
        }),
    })
}

/// Element facts through the engine's isolated-world helper eval, in
/// `frame` when the ref was minted in a child frame. The one place facts
/// are read from the page.
pub fn facts_via_eval<'a, E: BrowserEngine + ?Sized>(
    engine: &'a E,
    tab: &'a str,
    frame: Option<&'a str>,
    path: &'a str,
) -> EngineFuture<'a, ActionabilityFacts> {
    Box::pin(async move {
        let script = assets::facts(path);
        let out = match frame {
            Some(frame) => engine.evaluate_in_frame(tab, frame, script).await?,
            None => engine.evaluate(tab, script).await?,
        };
        parse_facts(out)
    })
}

pub(super) fn unsupported<'a, T: Send + 'a>() -> EngineFuture<'a, T> {
    Box::pin(async { Err(EngineError::new(EngineErrorKind::Unsupported)) })
}

/// An adapter's native (trusted) input. Every method may assume the
/// layer already checked the mode and the declared tier.
pub trait NativeInput: Send + Sync {
    /// The input tiers this adapter declares; each one has a conformance
    /// case that passes on its OS.
    fn tiers(&self) -> &'static [(CapabilityId, Support)];
    /// The `trusted_key` tier for key presses, when it differs from the
    /// tier for text entry.
    fn press_support(&self) -> Option<Support> {
        None
    }
    /// True when an element taking focus in the tab, by click or by
    /// script, moves native focus to the tab.
    fn element_focus_moves_tab_focus(&self) -> bool {
        false
    }
    fn click<'a>(&'a self, tab: &'a str, at: Point) -> EngineFuture<'a, ()>;
    fn move_to<'a>(&'a self, _tab: &'a str, _at: Point) -> EngineFuture<'a, ()> {
        unsupported()
    }
    fn wheel<'a>(&'a self, _tab: &'a str, _at: Point, _dx: f64, _dy: f64) -> EngineFuture<'a, ()> {
        unsupported()
    }
    fn drag<'a>(&'a self, _tab: &'a str, _from: Point, _to: Point) -> EngineFuture<'a, ()> {
        unsupported()
    }
    fn key<'a>(&'a self, _tab: &'a str, _input: KeyInput<'a>) -> EngineFuture<'a, ()> {
        unsupported()
    }
}

/// An eval engine with an adapter's native input on top. Facts are the
/// inner engine's with the input tiers raised to what `input` declares.
/// Every port method that is not input forwards to the inner engine: a
/// method left to the trait default would silently drop the adapter's own.
pub struct WithNativeInput<E> {
    inner: E,
    input: Arc<dyn NativeInput>,
    facts: EngineFacts,
}

impl<E: BrowserEngine> WithNativeInput<E> {
    pub fn new(inner: E, input: Arc<dyn NativeInput>) -> Self {
        let mut facts = inner.facts().clone();
        for &(id, support) in input.tiers() {
            facts.capabilities = facts.capabilities.with(id, support);
        }
        Self {
            inner,
            input,
            facts,
        }
    }

    fn trusted(&self, id: CapabilityId, mode: InputMode) -> bool {
        mode == InputMode::Trusted && self.facts.capabilities.get(id) == Support::Trusted
    }
}

impl<E: BrowserEngine> BrowserEngine for WithNativeInput<E> {
    fn facts(&self) -> &EngineFacts {
        &self.facts
    }

    fn evaluate<'a>(&'a self, tab: &'a str, script: Script) -> EngineFuture<'a, Value> {
        self.inner.evaluate(tab, script)
    }

    fn element_facts<'a>(
        &'a self,
        tab: &'a str,
        frame: Option<&'a str>,
        path: &'a str,
    ) -> EngineFuture<'a, ActionabilityFacts> {
        self.inner.element_facts(tab, frame, path)
    }

    fn pointer_click<'a>(&'a self, tab: &'a str, at: Point, mode: InputMode) -> EngineFuture<'a, ()> {
        if !self.trusted(CapabilityId::PointerClick, mode) {
            return unsupported();
        }
        self.input.click(tab, at)
    }

    fn pointer_move<'a>(&'a self, tab: &'a str, at: Point, mode: InputMode) -> EngineFuture<'a, ()> {
        if !self.trusted(CapabilityId::PointerMove, mode) {
            return unsupported();
        }
        self.input.move_to(tab, at)
    }

    fn wheel<'a>(
        &'a self,
        tab: &'a str,
        at: Point,
        delta: (f64, f64),
        mode: InputMode,
    ) -> EngineFuture<'a, ()> {
        if !self.trusted(CapabilityId::Wheel, mode) {
            return unsupported();
        }
        self.input.wheel(tab, at, delta.0, delta.1)
    }

    fn drag<'a>(&'a self, tab: &'a str, from: Point, to: Point, mode: InputMode) -> EngineFuture<'a, ()> {
        if !self.trusted(CapabilityId::Drag, mode) {
            return unsupported();
        }
        self.input.drag(tab, from, to)
    }

    fn element_focus_moves_tab_focus(&self) -> bool {
        self.input.element_focus_moves_tab_focus()
    }

    fn key_support(&self, kind: KeyKind) -> Support {
        let text = self.facts.capabilities.get(CapabilityId::TrustedKey);
        match kind {
            KeyKind::Text => text,
            KeyKind::Press => self.input.press_support().unwrap_or(text),
        }
    }

    fn key<'a>(&'a self, tab: &'a str, input: KeyInput<'a>, mode: InputMode) -> EngineFuture<'a, ()> {
        let kind = match input {
            KeyInput::Text(_) => KeyKind::Text,
            KeyInput::Press(_) => KeyKind::Press,
        };
        if mode != InputMode::Trusted || self.key_support(kind) != Support::Trusted {
            return unsupported();
        }
        self.input.key(tab, input)
    }

    fn screenshot<'a>(&'a self, tab: &'a str) -> EngineFuture<'a, Vec<u8>> {
        self.inner.screenshot(tab)
    }

    fn answer_dialog<'a>(
        &'a self,
        tab: &'a str,
        id: u64,
        answer: super::events::DialogAnswer,
    ) -> EngineFuture<'a, bool> {
        self.inner.answer_dialog(tab, id, answer)
    }

    fn pull_console<'a>(&'a self, tab: &'a str) -> EngineFuture<'a, Vec<super::observe::ConsoleEntry>> {
        self.inner.pull_console(tab)
    }

    fn child_frames<'a>(&'a self, tab: &'a str) -> EngineFuture<'a, Vec<super::ChildFrame>> {
        self.inner.child_frames(tab)
    }

    fn evaluate_in_frame<'a>(&'a self, tab: &'a str, frame: &'a str, script: Script) -> EngineFuture<'a, Value> {
        self.inner.evaluate_in_frame(tab, frame, script)
    }

    fn set_input_files<'a>(
        &'a self,
        tab: &'a str,
        frame: Option<&'a str>,
        path: &'a str,
        files: &'a [std::path::PathBuf],
    ) -> EngineFuture<'a, ()> {
        self.inner.set_input_files(tab, frame, path, files)
    }
}

#[cfg(test)]
#[path = "input_tests.rs"]
mod tests;
