//! Input verbs. Each checks its target's actionability, then uses the
//! engine's trusted input where the capability table declares it and the
//! page-script fallback only where it declares synthetic, and replies with
//! the fidelity of the input that ran.
//!
//! Trusted text goes into an element focused by a trusted click. Where
//! focusing an element moves native focus to the tab (WKWebView makes it
//! first responder and blurs the chat), nothing focuses one: a click that
//! would is synthetic, and so is text entry, which writes the value with
//! input and change events. No helper calls `element.focus()`.

use std::future::Future;

use serde_json::Value;

use super::actionability::{wait_until_actionable, Need, Target};
use super::actions::{ref_arg, ResolvedRef};
use super::reply::{action_result, engine_error, focused_editable_result, viewport_result, Fidelity};
use super::tabs::RefNode;
use super::{BrowserError, DesktopBrowserHost, ERR_TIMEOUT};
use crate::browser_automation::budgets::{self, Deadline};
use crate::browser_automation::engine::assets::{self, Script};
use crate::browser_automation::engine::{
    CapabilityId, ControlKind, EngineFuture, InputMode, Key, KeyInput, KeyKind, Point, Support,
};

fn mode_of(support: Support) -> Result<InputMode, BrowserError> {
    match support {
        Support::Trusted => Ok(InputMode::Trusted),
        Support::Synthetic => Ok(InputMode::Synthetic),
        Support::Unavailable(reason) => Err(BrowserError::capability(reason)),
    }
}

fn fidelity(mode: InputMode) -> Fidelity {
    match mode {
        InputMode::Trusted => Fidelity::Trusted,
        InputMode::Synthetic => Fidelity::Synthetic,
    }
}

/// Run `step`, cut at `bound`.
async fn within<T>(
    bound: Deadline,
    step: impl Future<Output = Result<T, BrowserError>>,
) -> Result<T, BrowserError> {
    tokio::time::timeout(bound.remaining(), step)
        .await
        .unwrap_or_else(|_| {
            Err(BrowserError::new(ERR_TIMEOUT, "the input did not finish in time")
                .with_reason("input_deadline"))
        })
}

impl DesktopBrowserHost {
    pub(super) fn input_mode(&self, id: CapabilityId) -> Result<InputMode, BrowserError> {
        mode_of(self.engine.facts().capabilities.get(id))
    }

    /// The key tier for `kind`, and whether trusted keys can reach an
    /// element: that needs a trusted click to focus it first, one that
    /// leaves native focus with the chat.
    fn key_modes(&self, kind: KeyKind) -> Result<(InputMode, bool), BrowserError> {
        let mode = mode_of(self.engine.key_support(kind))?;
        let click = self.engine.facts().capabilities.get(CapabilityId::PointerClick);
        let by_click = mode == InputMode::Trusted
            && click == Support::Trusted
            && !self.engine.element_focus_moves_tab_focus();
        Ok((mode, by_click))
    }

    /// Run trusted input, then wait for the page to render after it.
    /// WebKitGTK queues events and returns before the page has handled
    /// them, so without the wait the next read can miss a click, and keys
    /// sent right after a focusing click can reach the field before the
    /// engine knows it is editable. The wait is best effort: input that
    /// navigates replaces the document it runs in.
    async fn input(&self, tab: &str, step: EngineFuture<'_, ()>) -> Result<(), BrowserError> {
        step.await.map_err(|e| {
            // Tab id + kind only (CWE-532).
            log::warn!(
                "[browser-agent] trusted input failed on tab {} ({:?})",
                super::events::label_prefix(tab),
                e.kind
            );
            engine_error(e, tab)
        })?;
        let _ = tokio::time::timeout(budgets::INPUT_SETTLE, self.eval(tab, assets::settle())).await;
        Ok(())
    }

    /// Run a synthetic input helper, in the frame `node`'s ref was minted
    /// in when there is one; only `{ok: true}` is success.
    async fn helper(
        &self,
        tab: &str,
        token: Option<&str>,
        node: Option<&RefNode>,
        script: Script,
    ) -> Result<(), BrowserError> {
        let out = match node {
            Some(node) => self.eval_ref(tab, node, script).await?,
            None => self.eval(tab, script).await?,
        };
        action_result(out, token)
    }

    /// Wait for the ref's element to meet `need`; the target point is in
    /// main-frame CSS px even when the ref lives in a child frame.
    async fn actionable(
        &self,
        tab: &str,
        token: &str,
        resolved: &ResolvedRef,
        need: Need,
        deadline: Deadline,
    ) -> Result<Target, BrowserError> {
        let mut target = wait_until_actionable(&*self.engine, tab, token, &resolved.node, need, deadline).await?;
        if !resolved.node.frame.is_empty() {
            let origin = self.frame_origin(tab, &resolved.node.frame).await?;
            target.point.x += origin.x;
            target.point.y += origin.y;
        }
        Ok(target)
    }

    /// Click `target` to focus it, then select its content (`replace`) or
    /// put the caret at its end.
    async fn focus_text(
        &self,
        tab: &str,
        token: &str,
        resolved: &ResolvedRef,
        target: Target,
        replace: bool,
        bound: Deadline,
    ) -> Result<(), BrowserError> {
        within(bound, self.input(tab, self.engine.pointer_click(tab, target.point, InputMode::Trusted))).await?;
        let script = assets::prepare_text(&resolved.node.path, replace);
        within(bound, self.helper(tab, Some(token), Some(&resolved.node), script)).await
    }

    pub(super) async fn click(
        &self,
        tab: &str,
        token: &str,
        resolved: &ResolvedRef,
        deadline: Deadline,
    ) -> Result<Fidelity, BrowserError> {
        let mut mode = self.input_mode(CapabilityId::PointerClick)?;
        let target = self.actionable(tab, token, resolved, Need::Activate, deadline).await?;
        if target.focus_on_click && self.engine.element_focus_moves_tab_focus() {
            mode = InputMode::Synthetic;
        }
        match mode {
            InputMode::Trusted => {
                self.input(tab, self.engine.pointer_click(tab, target.point, mode)).await?;
            }
            InputMode::Synthetic => {
                self.helper(tab, Some(token), Some(&resolved.node), assets::click(&resolved.node.path)).await?;
            }
        }
        Ok(fidelity(mode))
    }

    pub(super) async fn hover(
        &self,
        tab: &str,
        token: &str,
        resolved: &ResolvedRef,
        deadline: Deadline,
    ) -> Result<Fidelity, BrowserError> {
        let mode = self.input_mode(CapabilityId::PointerMove)?;
        let target = self.actionable(tab, token, resolved, Need::Pointer, deadline).await?;
        match mode {
            InputMode::Trusted => {
                self.input(tab, self.engine.pointer_move(tab, target.point, mode)).await?;
            }
            InputMode::Synthetic => {
                self.helper(tab, Some(token), Some(&resolved.node), assets::hover(&resolved.node.path)).await?;
            }
        }
        Ok(fidelity(mode))
    }

    /// Press on the source, move to the target and release there. Both are
    /// actionable before any button goes down. Where the tier is synthetic
    /// the page script presses and releases in one document, so both refs
    /// must live in the same frame.
    pub(super) async fn drag(
        &self,
        tab: &str,
        from: (&str, &ResolvedRef),
        to: (&str, &ResolvedRef),
        deadline: Deadline,
    ) -> Result<Fidelity, BrowserError> {
        let mode = self.input_mode(CapabilityId::Drag)?;
        if mode == InputMode::Synthetic && from.1.node.frame != to.1.node.frame {
            return Err(BrowserError::capability("this engine drags only within one frame")
                .with_reason("cross_frame_drag")
                .with_arg_keys(&["ref", "toRef"]));
        }
        let start = self.actionable(tab, from.0, from.1, Need::Activate, deadline).await?;
        let end = self.actionable(tab, to.0, to.1, Need::Pointer, deadline).await?;
        let bound = Deadline::after(deadline.clamp(budgets::DRAG_INPUT));
        match mode {
            InputMode::Trusted => {
                let drag = self.engine.drag(tab, start.point, end.point, mode);
                within(bound, self.input(tab, drag)).await?;
            }
            InputMode::Synthetic => {
                let script = assets::drag(&from.1.node.path, &to.1.node.path);
                within(bound, self.helper(tab, Some(from.0), Some(&from.1.node), script)).await?;
            }
        }
        Ok(fidelity(mode))
    }

    /// Scroll the page by `dy` with the wheel, or a ref into view (a
    /// programmatic scroll, so synthetic on every engine).
    pub(super) async fn scroll(&self, tab: &str, args: &Value) -> Result<Fidelity, BrowserError> {
        if let Some(token) = ref_arg(args)? {
            let resolved = self.resolve_ref(tab, token)?;
            self.revalidate(tab, token, &resolved).await?;
            return Ok(Fidelity::Synthetic);
        }
        let mode = self.input_mode(CapabilityId::Wheel)?;
        let dy = args.get("dy").and_then(Value::as_f64).unwrap_or(600.0);
        match mode {
            InputMode::Trusted => {
                let viewport = viewport_result(self.eval(tab, assets::viewport()).await?)?;
                let at = Point {
                    x: viewport.w / 2.0,
                    y: viewport.h / 2.0,
                };
                self.input(tab, self.engine.wheel(tab, at, (0.0, dy), mode)).await?;
            }
            InputMode::Synthetic => {
                self.helper(tab, None, None, assets::scroll(None, dy)).await?;
            }
        }
        Ok(fidelity(mode))
    }

    pub(super) async fn fill(
        &self,
        tab: &str,
        token: &str,
        resolved: &ResolvedRef,
        value: &str,
        deadline: Deadline,
    ) -> Result<Fidelity, BrowserError> {
        let (_, by_click) = self.key_modes(KeyKind::Text)?;
        let bound = Deadline::after(deadline.clamp(budgets::ACTION_TEXT));
        let target = self.actionable(tab, token, resolved, Need::Fill, bound).await?;
        if target.kind == ControlKind::Select || value.is_empty() || !by_click {
            let script = assets::fill(&resolved.node.path, value);
            within(bound, self.helper(tab, Some(token), Some(&resolved.node), script)).await?;
            return Ok(Fidelity::Synthetic);
        }
        self.focus_text(tab, token, resolved, target, true, bound).await?;
        let text = self.engine.key(tab, KeyInput::Text(value), InputMode::Trusted);
        within(bound, self.input(tab, text)).await?;
        Ok(Fidelity::Trusted)
    }

    pub(super) async fn type_text(&self, tab: &str, args: &Value, deadline: Deadline) -> Result<Fidelity, BrowserError> {
        let text = args
            .get("text")
            .and_then(Value::as_str)
            .ok_or_else(|| BrowserError::invalid("missing 'text'").with_arg_keys(&["text"]))?;
        let (mode, by_click) = self.key_modes(KeyKind::Text)?;
        let bound = Deadline::after(deadline.clamp(budgets::ACTION_TEXT));
        match ref_arg(args)? {
            Some(token) => {
                let resolved = self.resolve_ref(tab, token)?;
                let target = self.actionable(tab, token, &resolved, Need::Type, bound).await?;
                if !by_click {
                    let script = assets::type_text(Some(&resolved.node.path), text);
                    within(bound, self.helper(tab, Some(token), Some(&resolved.node), script)).await?;
                    return Ok(Fidelity::Synthetic);
                }
                self.focus_text(tab, token, &resolved, target, false, bound).await?;
            }
            None if mode == InputMode::Synthetic => {
                within(bound, self.helper(tab, None, None, assets::type_text(None, text))).await?;
                return Ok(Fidelity::Synthetic);
            }
            None => self.require_focused_editable(tab, bound).await?,
        }
        let input = self.engine.key(tab, KeyInput::Text(text), InputMode::Trusted);
        within(bound, self.input(tab, input)).await?;
        Ok(Fidelity::Trusted)
    }

    async fn require_focused_editable(&self, tab: &str, bound: Deadline) -> Result<(), BrowserError> {
        let out = within(bound, self.eval(tab, assets::focused_editable())).await?;
        if focused_editable_result(out)? {
            Ok(())
        } else {
            Err(BrowserError::invalid("no element has focus; pass a ref").with_reason("no_focused_element"))
        }
    }

    pub(super) async fn press(&self, tab: &str, args: &Value, deadline: Deadline) -> Result<Fidelity, BrowserError> {
        let name = args.get("key").and_then(Value::as_str).unwrap_or("Enter");
        let (mode, by_click) = self.key_modes(KeyKind::Press)?;
        let key = match (mode, Key::parse(name)) {
            (InputMode::Trusted, None) => {
                return Err(BrowserError::invalid(
                    "unknown key; pass one character or a key name such as Enter, Tab, Escape, Backspace, Delete, ArrowDown, Home, End, PageUp or Space",
                )
                .with_arg_keys(&["key"]));
            }
            (_, key) => key,
        };
        let bound = Deadline::after(deadline.clamp(budgets::ACTION_TEXT));
        let token = ref_arg(args)?;
        let mut trusted = mode == InputMode::Trusted;
        let mut node = None;
        if let Some(token) = token {
            let resolved = self.resolve_ref(tab, token)?;
            let target = self.actionable(tab, token, &resolved, Need::Activate, bound).await?;
            // Only a text control can be focused by a click without side
            // effects; anything else gets the key on the element itself.
            trusted = by_click && target.kind == ControlKind::Text;
            if trusted {
                self.focus_text(tab, token, &resolved, target, false, bound).await?;
            }
            node = Some(resolved.node);
        }
        match key {
            Some(key) if trusted => {
                let input = self.engine.key(tab, KeyInput::Press(key), InputMode::Trusted);
                within(bound, self.input(tab, input)).await?;
                Ok(Fidelity::Trusted)
            }
            _ => {
                let script = assets::press(node.as_ref().map(|n| n.path.as_str()), name);
                within(bound, self.helper(tab, token, node.as_ref(), script)).await?;
                Ok(Fidelity::Synthetic)
            }
        }
    }
}
