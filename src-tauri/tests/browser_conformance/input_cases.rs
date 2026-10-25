//! Input cases. Actionability cases go through `dispatch` like the rest.
//! Tier cases drive the engine adapter directly against `input.html` and
//! read what the page saw from its reports, so they run on engines whose
//! eval channel cannot reach the host. Every tier case also checks that
//! the chat stand-in kept focus.

use std::time::{Duration, Instant};

use serde_json::{json, Value};
use termul_manager_lib::conformance_support::{
    EngineError, EngineErrorKind, InputMode, Key, KeyInput, NamedKey, Point, Support,
};

use crate::cases::{expect_code, expect_code_reason, expect_fidelity, find_ref, mismatch, tab_id, CaseResult, Ctx, Failure};

const READY_WAIT: Duration = Duration::from_secs(10);
const REPORT_WAIT: Duration = Duration::from_secs(5);
/// Longer than the Linux adapter's focus-lock hold, so a deferred focus
/// grab would have landed before the chat is checked.
const FOCUS_SETTLE: Duration = Duration::from_millis(900);
const CHAT_FOCUS_WAIT: Duration = Duration::from_secs(3);

const BUTTON: Point = Point { x: 120.0, y: 60.0 };
const FIELD: Point = Point { x: 160.0, y: 136.0 };
const HOVER: Point = Point { x: 120.0, y: 220.0 };
/// The button inside the fixture's same-origin frame.
const FRAME_BUTTON: Point = Point { x: 120.0, y: 360.0 };
const PAGE_MIDDLE: Point = Point { x: 400.0, y: 400.0 };
const HANDLE: Point = Point { x: 50.0, y: 290.0 };
const HANDLE_TARGET: Point = Point { x: 210.0, y: 290.0 };

const ACTIONABILITY_READY: &str = "Actionability fixture";
const DRAG_READY: &str = "Drag fixture";

fn is(report: &Value, src: &str, ev: &str) -> bool {
    report["src"] == src && report["ev"] == ev
}

fn engine_failure(what: &str, kind: EngineErrorKind) -> Failure {
    Failure {
        code: "engine".into(),
        reason: Some(format!("{kind:?}")),
        message: format!("{what}: the engine refused or failed"),
    }
}

impl Ctx<'_> {
    fn mark(&self) -> usize {
        self.fixtures.reports().len()
    }

    fn since(&self, mark: usize) -> Vec<Value> {
        self.fixtures.reports().split_off(mark.min(self.fixtures.reports().len()))
    }

    async fn await_report(
        &self,
        mark: usize,
        wait: Duration,
        what: &str,
        found: impl Fn(&Value) -> bool,
    ) -> Result<Value, Failure> {
        let deadline = Instant::now() + wait;
        loop {
            if let Some(report) = self.since(mark).into_iter().find(|r| found(r)) {
                return Ok(report);
            }
            if Instant::now() > deadline {
                let seen: Vec<Value> = self.since(mark).into_iter().filter(|r| r["src"] == "agent").collect();
                return Err(mismatch(format!("the page never reported {what}; it reported {seen:?}")));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// Open `input.html` in an agent tab and wait for it to load.
    async fn input_tab(&self) -> Result<String, Failure> {
        let mark = self.mark();
        let reply = self
            .call("new_tab", json!({ "url": self.fixtures.url("/input.html") }))
            .await?;
        let id = tab_id(&reply)?;
        self.await_report(mark, READY_WAIT, "ready", |r| is(r, "agent", "ready"))
            .await?;
        Ok(id)
    }

    /// Focus the chat stand-in and wait until it reports page focus.
    async fn chat_focused(&self) -> CaseResult {
        let mark = self.mark();
        self.engine.focus_chat();
        let deadline = Instant::now() + CHAT_FOCUS_WAIT;
        loop {
            let focused = self.fixtures.reports().into_iter().rev().find(|r| r["src"] == "chat");
            if focused.as_ref().is_some_and(|r| r["hasFocus"] == true && r["active"] == "chat") {
                return Ok(());
            }
            if Instant::now() > deadline {
                let seen = self.since(mark).len();
                return Err(mismatch(format!(
                    "the chat stand-in never had focus ({seen} reports since focusing it); retention cannot be shown"
                )));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// The chat saw nothing since `mark`: no blur, no key or text, and it
    /// never lost page focus.
    async fn chat_untouched(&self, mark: usize, what: &str) -> CaseResult {
        tokio::time::sleep(FOCUS_SETTLE).await;
        let touched: Vec<Value> = self
            .since(mark)
            .into_iter()
            .filter(|r| r["src"] == "chat")
            .filter(|r| {
                ["blur", "window_blur", "keydown", "input"].contains(&r["ev"].as_str().unwrap_or(""))
                    || r["hasFocus"] == false
                    || r["value"] != ""
            })
            .collect();
        if touched.is_empty() {
            Ok(())
        } else {
            Err(mismatch(format!("{what} reached the chat: {touched:?}")))
        }
    }

    async fn trusted_report(
        &self,
        mark: usize,
        what: &str,
        found: impl Fn(&Value) -> bool,
    ) -> CaseResult {
        let report = self.await_report(mark, REPORT_WAIT, what, found).await?;
        if report["trusted"] == true {
            Ok(())
        } else {
            Err(mismatch(format!("{what} was not trusted: {report}")))
        }
    }

    async fn trusted_click(&self, tab: &str, at: Point, what: &str) -> CaseResult {
        self.engine
            .input()
            .pointer_click(tab, at, InputMode::Trusted)
            .await
            .map_err(|e| engine_failure(what, e.kind))
    }
}

/// A capability the engine declares synthetic must refuse trusted input.
fn refused(result: Result<(), EngineError>, what: &str) -> CaseResult {
    match result {
        Err(e) if e.kind == EngineErrorKind::Unsupported => Ok(()),
        Err(e) => Err(engine_failure(what, e.kind)),
        Ok(()) => Err(mismatch(format!("{what} is declared synthetic but trusted input ran"))),
    }
}

fn unavailable(what: &str, support: Support) -> Failure {
    Failure {
        code: "capability_unavailable".into(),
        reason: None,
        message: format!("{what} is {support:?}"),
    }
}

pub async fn pointer_click(c: &Ctx<'_>) -> CaseResult {
    let tab = c.input_tab().await?;
    match c.engine.tiers().pointer_click {
        Support::Trusted => {
            c.chat_focused().await?;
            let mark = c.mark();
            c.trusted_click(&tab, BUTTON, "click").await?;
            c.trusted_report(mark, "a button click", |r| is(r, "agent", "click") && r["id"] == "btn")
                .await?;
            c.chat_untouched(mark, "the click").await
        }
        Support::Synthetic => refused(c.engine.input().pointer_click(&tab, BUTTON, InputMode::Trusted).await, "click"),
        other => Err(unavailable("pointer_click", other)),
    }
}

pub async fn trusted_key(c: &Ctx<'_>) -> CaseResult {
    let tiers = c.engine.tiers();
    match tiers.text {
        Support::Trusted => {}
        Support::Synthetic => {
            let tab = c.input_tab().await?;
            let input = c.engine.input();
            refused(input.key(&tab, KeyInput::Text("abc"), InputMode::Trusted).await, "text")?;
            return refused(input.key(&tab, KeyInput::Press(Key::Char('d')), InputMode::Trusted).await, "press");
        }
        other => return Err(unavailable("trusted_key text entry", other)),
    }
    let tab = c.input_tab().await?;
    c.chat_focused().await?;
    let mark = c.mark();
    c.trusted_click(&tab, FIELD, "focus click").await?;
    c.await_report(mark, REPORT_WAIT, "field focus", |r| is(r, "agent", "focus") && r["id"] == "field")
        .await?;
    let input = c.engine.input();
    input
        .key(&tab, KeyInput::Text("abc"), InputMode::Trusted)
        .await
        .map_err(|e| engine_failure("text", e.kind))?;
    c.trusted_report(mark, "typed text", |r| is(r, "agent", "input") && r["value"] == "abc")
        .await?;
    let press = KeyInput::Press(Key::Char('d'));
    match tiers.press {
        Support::Trusted => {
            input
                .key(&tab, press, InputMode::Trusted)
                .await
                .map_err(|e| engine_failure("press", e.kind))?;
            c.trusted_report(mark, "a key press", |r| is(r, "agent", "keydown") && r["key"] == "d")
                .await?;
            input
                .key(&tab, KeyInput::Press(Key::Named(NamedKey::Backspace)), InputMode::Trusted)
                .await
                .map_err(|e| engine_failure("backspace", e.kind))?;
            c.trusted_report(mark, "backspace", |r| {
                is(r, "agent", "keydown") && r["key"] == "Backspace"
            })
            .await?;
        }
        Support::Synthetic => refused(input.key(&tab, press, InputMode::Trusted).await, "press")?,
        other => return Err(unavailable("trusted_key press", other)),
    }
    c.chat_untouched(mark, "the typing").await
}

pub async fn pointer_move(c: &Ctx<'_>) -> CaseResult {
    let tab = c.input_tab().await?;
    match c.engine.tiers().pointer_move {
        Support::Trusted => {
            c.chat_focused().await?;
            let mark = c.mark();
            c.engine
                .input()
                .pointer_move(&tab, HOVER, InputMode::Trusted)
                .await
                .map_err(|e| engine_failure("move", e.kind))?;
            c.trusted_report(mark, "a hover", |r| {
                is(r, "agent", "mouseover") && r["id"] == "hov" && r["hover"] == true
            })
            .await?;
            c.chat_untouched(mark, "the pointer move").await
        }
        Support::Synthetic => refused(c.engine.input().pointer_move(&tab, HOVER, InputMode::Trusted).await, "move"),
        other => Err(unavailable("pointer_move", other)),
    }
}

pub async fn wheel(c: &Ctx<'_>) -> CaseResult {
    let tab = c.input_tab().await?;
    match c.engine.tiers().wheel {
        Support::Trusted => {
            c.chat_focused().await?;
            let mark = c.mark();
            c.engine
                .input()
                .wheel(&tab, PAGE_MIDDLE, (0.0, 300.0), InputMode::Trusted)
                .await
                .map_err(|e| engine_failure("wheel", e.kind))?;
            c.trusted_report(mark, "a wheel event", |r| is(r, "agent", "wheel")).await?;
            c.await_report(mark, REPORT_WAIT, "a scroll", |r| {
                is(r, "agent", "scroll") && r["scrollY"].as_f64().unwrap_or(0.0) > 0.0
            })
            .await?;
            c.chat_untouched(mark, "the wheel").await
        }
        Support::Synthetic => refused(
            c.engine.input().wheel(&tab, PAGE_MIDDLE, (0.0, 300.0), InputMode::Trusted).await,
            "wheel",
        ),
        other => Err(unavailable("wheel", other)),
    }
}

pub async fn drag(c: &Ctx<'_>) -> CaseResult {
    let tab = c.input_tab().await?;
    match c.engine.tiers().drag {
        Support::Trusted => {
            c.chat_focused().await?;
            let mark = c.mark();
            c.engine
                .input()
                .drag(&tab, HANDLE, HANDLE_TARGET, InputMode::Trusted)
                .await
                .map_err(|e| engine_failure("drag", e.kind))?;
            c.trusted_report(mark, "a slider drag", |r| {
                is(r, "agent", "dragged") && r["left"].as_f64().unwrap_or(0.0) >= 100.0
            })
            .await?;
            c.chat_untouched(mark, "the drag").await
        }
        Support::Synthetic => refused(
            c.engine.input().drag(&tab, HANDLE, HANDLE_TARGET, InputMode::Trusted).await,
            "drag",
        ),
        other => Err(unavailable("drag", other)),
    }
}

/// The `drag` verb on `drag.html`: a slider thumb dragged onto a marker and
/// a list item onto another, both through pointer events, with the reply's
/// fidelity matching what the page saw.
pub async fn drag_verb(c: &Ctx<'_>) -> CaseResult {
    c.open("/drag.html", DRAG_READY).await?;
    let snap = c.snapshot().await?;
    let find = |role: &str, name: &str| {
        find_ref(&snap.text, role, name).ok_or_else(|| mismatch(format!("no {role} \"{name}\" in {}", snap.text)))
    };
    let (thumb, max) = (find("slider", "Volume")?, find("button", "Max")?);
    let (alpha, charlie) = (find("listitem", "Alpha")?, find("listitem", "Charlie")?);
    let tier = c.engine.tiers().drag;
    let seen = if tier == Support::Trusted { "trusted" } else { "synthetic" };
    for (from, to, result) in [
        (&thumb, &max, "Volume: 100"),
        (&alpha, &charlie, "Order: Bravo, Charlie, Alpha"),
    ] {
        let reply = c.call("drag", json!({ "ref": from, "toRef": to })).await?;
        expect_fidelity(&reply, tier, "drag")?;
        c.call("wait", json!({ "text": result })).await?;
        c.call("wait", json!({ "text": format!("Events: {seen}") })).await?;
    }
    expect_code(c.call("drag", json!({ "ref": thumb })).await, "invalid_params", "drag without a target")
}

/// The chat keeps focus and sees nothing while the agent tab is clicked
/// (on the page and inside a same-origin frame) and typed into through
/// every trusted path the engine declares. Where focusing an element
/// moves native focus to the tab, the core never clicks a field with
/// trusted input, so neither does this case.
pub async fn focus_retention(c: &Ctx<'_>) -> CaseResult {
    let tiers = c.engine.tiers();
    if tiers.pointer_click != Support::Trusted {
        return Err(unavailable("pointer_click", tiers.pointer_click));
    }
    let tab = c.input_tab().await?;
    c.chat_focused().await?;
    let mark = c.mark();
    let input = c.engine.input();
    c.trusted_click(&tab, BUTTON, "click").await?;
    c.trusted_report(mark, "a button click", |r| is(r, "agent", "click") && r["id"] == "btn")
        .await?;
    c.trusted_click(&tab, FRAME_BUTTON, "frame click").await?;
    c.trusted_report(mark, "a click in a same-origin frame", |r| is(r, "agent", "click") && r["id"] == "inner")
        .await?;
    if !tiers.focus_moves {
        c.trusted_click(&tab, FIELD, "focus click").await?;
        c.await_report(mark, REPORT_WAIT, "field focus", |r| is(r, "agent", "focus") && r["id"] == "field")
            .await?;
    }
    if tiers.text == Support::Trusted {
        input
            .key(&tab, KeyInput::Text("xyz"), InputMode::Trusted)
            .await
            .map_err(|e| engine_failure("text", e.kind))?;
        c.await_report(mark, REPORT_WAIT, "typed text", |r| is(r, "agent", "input") && r["value"] == "xyz")
            .await?;
    }
    if tiers.press == Support::Trusted {
        input
            .key(&tab, KeyInput::Press(Key::Named(NamedKey::Enter)), InputMode::Trusted)
            .await
            .map_err(|e| engine_failure("press", e.kind))?;
    }
    if tiers.wheel == Support::Trusted {
        input
            .wheel(&tab, PAGE_MIDDLE, (0.0, 200.0), InputMode::Trusted)
            .await
            .map_err(|e| engine_failure("wheel", e.kind))?;
    }
    c.chat_untouched(mark, "agent input").await
}

async fn open_actionability(c: &Ctx<'_>) -> CaseResult {
    c.open("/actionability.html", ACTIONABILITY_READY).await
}

async fn expect_untouched(c: &Ctx<'_>, clicks: &str) -> CaseResult {
    c.expect_text(&format!("Clicks: {clicks}")).await
}

pub async fn actionability_covered(c: &Ctx<'_>) -> CaseResult {
    open_actionability(c).await?;
    let target = c.ref_of("button", "Covered target").await?;
    expect_code_reason(
        c.call("click", json!({ "ref": target })).await,
        "timeout",
        "covered",
        "click on a covered button",
    )?;
    expect_untouched(c, "none").await
}

pub async fn actionability_moving(c: &Ctx<'_>) -> CaseResult {
    open_actionability(c).await?;
    let target = c.ref_of("button", "Moving target").await?;
    expect_code_reason(
        c.call("click", json!({ "ref": target })).await,
        "timeout",
        "unstable",
        "click on a moving button",
    )?;
    expect_untouched(c, "none").await
}

pub async fn actionability_hidden(c: &Ctx<'_>) -> CaseResult {
    open_actionability(c).await?;
    // One snapshot for both refs: a later one would supersede the first.
    let snap = c.snapshot().await?;
    let find = |name: &str| {
        find_ref(&snap.text, "button", name).ok_or_else(|| mismatch(format!("snapshot has no button \"{name}\"")))
    };
    let (target, hide) = (find("Hidden target")?, find("Hide it")?);
    c.call("click", json!({ "ref": hide })).await?;
    expect_code_reason(
        c.call("click", json!({ "ref": target })).await,
        "timeout",
        "not_visible",
        "click on a hidden button",
    )?;
    expect_untouched(c, "hide").await
}
