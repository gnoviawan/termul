//! One case per capability the host offers today. Each case drives its own
//! session through navigate, snapshot and the other verbs, and checks the page
//! state the verbs should have produced.
//!
//! A case that needs page access is not run once the capability it builds on
//! has failed, so one broken engine path is one failure plus blocked cases
//! instead of a wait for every case to time out.

use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::adapter::{Engine, StepError};
use crate::input_cases;
use crate::sensitive_cases;
use termul_manager_lib::conformance_support::Support;
use crate::fixture_server::{FixtureServer, REDIRECT_PATH, REDIRECT_TARGET_PATH};

#[path = "event_cases.rs"]
mod events;
#[path = "form_cases.rs"]
mod forms;
#[path = "frame_cases.rs"]
mod frames;
#[path = "observe_cases.rs"]
mod observe;

const FORM_READY: &str = "Conformance form";
const DELAYED_READY: &str = "Delayed element";
const REDIRECT_READY: &str = "Redirect target reached";
const TAMPER_READY: &str = "Tamper fixture ready";

/// How long a screenshot is retried while the new tab has nothing to capture.
const SCREENSHOT_RETRY: Duration = Duration::from_secs(10);

/// Code of a case that did not run because a capability it needs failed.
pub const BLOCKED: &str = "blocked";

pub struct Capability {
    pub id: &'static str,
    pub needs: &'static [&'static str],
}

const fn cap(id: &'static str, needs: &'static [&'static str]) -> Capability {
    Capability { id, needs }
}

pub const CAPABILITIES: &[Capability] = &[
    cap("tab_lifecycle", &[]),
    cap("error_codes", &[]),
    cap("screenshot", &[]),
    cap("navigate", &[]),
    cap("snapshot", &["navigate"]),
    cap("click", &["snapshot"]),
    cap("fill", &["snapshot"]),
    cap("type", &["snapshot"]),
    cap("link_click", &["snapshot"]),
    cap("wait_text", &["snapshot"]),
    cap("redirect", &["snapshot"]),
    cap("back", &["snapshot"]),
    cap("reload", &["snapshot"]),
    cap("stale_ref", &["snapshot"]),
    cap("tamper", &["snapshot"]),
    cap("labelled_form", &["fill", "click"]),
    cap("shifted_rows", &["click"]),
    cap("actionability_covered", &["snapshot"]),
    cap("actionability_moving", &["snapshot"]),
    cap("actionability_hidden", &["snapshot"]),
    cap("input_pointer_click", &["navigate"]),
    cap("input_trusted_key", &["navigate"]),
    cap("input_pointer_move", &["navigate"]),
    cap("input_wheel", &["navigate"]),
    cap("input_drag", &["navigate"]),
    cap("drag", &["snapshot"]),
    cap("focus_retention", &["navigate"]),
    cap("dialog_alert", &["click"]),
    cap("dialog_confirm", &["click"]),
    cap("dialog_prompt", &["click"]),
    cap("dialog_beforeunload", &["click"]),
    cap("dialog_on_load", &["navigate"]),
    cap("popup", &["click"]),
    cap("external_protocol", &["click"]),
    cap("permissions", &["snapshot"]),
    cap("select_option", &["snapshot"]),
    cap("check", &["click"]),
    cap("wait_semantic", &["navigate"]),
    cap("switch_tab", &["snapshot"]),
    cap("console", &["navigate"]),
    cap("network", &["navigate"]),
    cap("iframe_same_origin", &["fill", "click"]),
    cap("iframe_cross_origin", &["fill", "click"]),
    cap("shadow_dom", &["fill", "click"]),
    cap("csp_snapshot", &["click"]),
    cap("password_submit", &["snapshot"]),
    cap("password_submit_global", &["snapshot"]),
    cap("password_submit_asked", &["snapshot"]),
    cap("focused_password_submit", &["navigate"]),
    cap("check_password_submit", &["snapshot"]),
    cap("formless_password_submit", &["snapshot"]),
    cap("payment_outside_form", &["click"]),
    cap("tainted_link_enter", &["snapshot"]),
    cap("tainted_navigation", &["snapshot"]),
    cap("upload", &["snapshot"]),
    cap("upload_refusals", &["snapshot"]),
    cap("file_chooser", &["click"]),
    cap("download", &["snapshot"]),
    cap("download_preapproved", &["snapshot"]),
    cap("download_size_cap", &["snapshot"]),
    cap("frame_password_submit", &["click"]),
    cap("frame_focused_password_submit", &["fill"]),
    cap("frame_focused_key", &["fill"]),
    cap("frame_upload", &["snapshot"]),
    cap("frame_file_chooser", &["click"]),
    cap("frame_denied_origin", &["snapshot"]),
];

pub fn ids() -> Vec<&'static str> {
    CAPABILITIES.iter().map(|c| c.id).collect()
}

#[derive(Debug)]
pub struct Failure {
    pub code: String,
    pub reason: Option<String>,
    pub message: String,
}

impl From<StepError> for Failure {
    fn from(e: StepError) -> Self {
        Self {
            code: e.code,
            reason: e.reason,
            message: e.message,
        }
    }
}

pub(crate) fn mismatch(message: impl Into<String>) -> Failure {
    Failure {
        code: "assertion".into(),
        reason: None,
        message: message.into(),
    }
}

pub(crate) type CaseResult = Result<(), Failure>;

pub(crate) struct Snapshot {
    pub text: String,
    url: String,
    title: String,
}

pub(crate) struct Ctx<'a> {
    pub engine: &'a Engine,
    pub fixtures: &'a FixtureServer,
    /// A second loopback port, for cross-origin content.
    pub cross: &'a FixtureServer,
    pub session: String,
}

pub fn tab_id(reply: &Value) -> Result<String, Failure> {
    reply["tab"]["id"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| mismatch("reply carries no tab id"))
}

fn tier_name(support: Support) -> &'static str {
    match support {
        Support::Trusted => "trusted",
        Support::Synthetic => "synthetic",
        Support::Unavailable(_) => "unavailable",
    }
}

/// The reply names a fidelity, for verbs whose tier the cases do not model.
pub fn expect_some_fidelity(reply: &Value, what: &str) -> CaseResult {
    match reply["fidelity"].as_str() {
        Some("trusted" | "synthetic") => Ok(()),
        other => Err(mismatch(format!("{what} reply fidelity is {other:?}"))),
    }
}

/// The reply's fidelity is the tier the engine declares for the input.
pub fn expect_fidelity(reply: &Value, tier: Support, what: &str) -> CaseResult {
    match reply["fidelity"].as_str() {
        Some(f) if f == tier_name(tier) => Ok(()),
        other => Err(mismatch(format!(
            "{what} reply fidelity is {other:?}, the declared tier is {}",
            tier_name(tier)
        ))),
    }
}

/// Trusted text needs a trusted click to focus the field first.
fn text_tier(c: &Ctx<'_>) -> Support {
    let tiers = c.engine.tiers();
    match (tiers.text, tiers.pointer_click) {
        (Support::Trusted, Support::Trusted) => Support::Trusted,
        (Support::Trusted, _) => Support::Synthetic,
        (other, _) => other,
    }
}

impl Ctx<'_> {
    pub(crate) async fn call(&self, action: &str, args: Value) -> Result<Value, Failure> {
        Ok(self.engine.call(&self.session, action, args).await?)
    }

    pub(crate) async fn navigate(&self, path: &str) -> Result<Value, Failure> {
        self.call("navigate", json!({ "url": self.fixtures.url(path) }))
            .await
    }

    /// Navigate, then wait until the page's own text is visible. A call that
    /// returns before the new document commits would otherwise race the next
    /// snapshot.
    pub(crate) async fn open(&self, path: &str, ready_text: &str) -> CaseResult {
        self.navigate(path).await?;
        self.call("wait", json!({ "text": ready_text })).await?;
        Ok(())
    }

    pub(crate) async fn snapshot(&self) -> Result<Snapshot, Failure> {
        let reply = self.call("snapshot", json!({})).await?;
        let field = |name: &str| reply["page"][name].as_str().unwrap_or_default().to_string();
        Ok(Snapshot {
            text: field("snapshot"),
            url: field("url"),
            title: field("title"),
        })
    }

    pub(crate) async fn ref_of(&self, role: &str, name: &str) -> Result<String, Failure> {
        let snap = self.snapshot().await?;
        find_ref(&snap.text, role, name)
            .ok_or_else(|| mismatch(format!("snapshot has no {role} \"{name}\" ref")))
    }

    pub(crate) async fn click(&self, role: &str, name: &str) -> CaseResult {
        let target = self.ref_of(role, name).await?;
        let reply = self.call("click", json!({ "ref": target })).await?;
        expect_fidelity(&reply, self.engine.tiers().pointer_click, "click")
    }

    pub(crate) async fn expect_text(&self, needle: &str) -> CaseResult {
        let snap = self.snapshot().await?;
        if snap.text.contains(needle) {
            Ok(())
        } else {
            Err(mismatch(format!("snapshot lacks \"{needle}\": {}", snap.text)))
        }
    }

    pub(crate) async fn expect_url(&self, path: &str, what: &str) -> CaseResult {
        let snap = self.snapshot().await?;
        if snap.url == self.fixtures.url(path) {
            Ok(())
        } else {
            Err(mismatch(format!("{what} landed on {}", snap.url)))
        }
    }
}

/// `- button "Submit" @e2` -> `@e2`.
pub fn find_ref(snapshot: &str, role: &str, name: &str) -> Option<String> {
    find_refs(snapshot, role, name).into_iter().next()
}

/// Every ref the snapshot prints for `role` named exactly `name`.
pub fn find_refs(snapshot: &str, role: &str, name: &str) -> Vec<String> {
    let prefix = format!("- {role} \"{name}\" @e");
    snapshot
        .lines()
        .filter_map(|line| {
            let rest = line.trim_start().strip_prefix(&prefix)?;
            let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
            (!digits.is_empty()).then(|| format!("@e{digits}"))
        })
        .collect()
}

pub fn expect_code_reason(result: Result<Value, Failure>, code: &str, reason: &str, what: &str) -> CaseResult {
    match result {
        Err(f) if f.code == code && f.reason.as_deref() == Some(reason) => Ok(()),
        Err(f) => Err(mismatch(format!(
            "{what}: expected {code}/{reason}, got {}/{:?}",
            f.code, f.reason
        ))),
        Ok(_) => Err(mismatch(format!("{what}: expected {code}/{reason}, call succeeded"))),
    }
}

pub(crate) fn expect_code(result: Result<Value, Failure>, code: &str, what: &str) -> CaseResult {
    match result {
        Err(f) if f.code == code => Ok(()),
        Err(f) => Err(mismatch(format!("{what}: expected {code}, got {}", f.code))),
        Ok(_) => Err(mismatch(format!("{what}: expected {code}, call succeeded"))),
    }
}

async fn tab_lifecycle(c: &Ctx<'_>) -> CaseResult {
    let opened = c
        .call("new_tab", json!({ "url": c.fixtures.url("/form.html") }))
        .await?;
    let id = tab_id(&opened)?;
    let listed = c.call("list_tabs", json!({})).await?;
    let ids: Vec<&str> = listed["data"]["tabs"]
        .as_array()
        .map(|tabs| {
            tabs.iter()
                .filter_map(|t| t["tab"]["id"].as_str())
                .collect()
        })
        .unwrap_or_default();
    if ids != [id.as_str()] {
        return Err(mismatch(format!("list_tabs returned {ids:?}")));
    }
    c.call("close_tab", json!({ "tabId": id })).await?;
    let after = c.call("list_tabs", json!({})).await?;
    match after["data"]["tabs"].as_array() {
        Some(tabs) if tabs.is_empty() => Ok(()),
        _ => Err(mismatch("list_tabs still lists the closed tab")),
    }
}

async fn error_codes(c: &Ctx<'_>) -> CaseResult {
    expect_code(
        c.call("navigate", json!({ "url": "file:///etc/hosts" }))
            .await,
        "invalid_params",
        "navigate to a file url",
    )?;
    expect_code(
        c.call("navigate", json!({})).await,
        "invalid_params",
        "navigate without a url",
    )?;
    expect_code(
        c.call(
            "navigate",
            json!({ "url": c.fixtures.url("/form.html"), "tabId": "agent-missing" }),
        )
        .await,
        "tab_not_found",
        "navigate with an unknown tabId",
    )?;
    expect_code(
        c.call("snapshot", json!({ "tabId": "agent-missing" }))
            .await,
        "tab_not_found",
        "snapshot with an unknown tabId",
    )?;
    expect_code(
        c.call("no_such_action", json!({})).await,
        "invalid_params",
        "unknown action",
    )
}

async fn navigate(c: &Ctx<'_>) -> CaseResult {
    let reply = c.navigate("/form.html").await?;
    tab_id(&reply)?;
    expect_fidelity(&reply, Support::Trusted, "navigate")
}

async fn snapshot(c: &Ctx<'_>) -> CaseResult {
    c.open("/form.html", FORM_READY).await?;
    let snap = c.snapshot().await?;
    if snap.url != c.fixtures.url("/form.html") {
        return Err(mismatch(format!("snapshot url is {}", snap.url)));
    }
    if snap.title != "Conformance form" {
        return Err(mismatch(format!("snapshot title is {}", snap.title)));
    }
    for line in [
        "- heading \"Conformance form\"",
        "- textbox \"Name\" @e",
        "- button \"Submit\" @e",
        "- link \"Next page\" @e",
    ] {
        if !snap.text.contains(line) {
            return Err(mismatch(format!("snapshot lacks `{line}`")));
        }
    }
    Ok(())
}

async fn click(c: &Ctx<'_>) -> CaseResult {
    c.open("/form.html", FORM_READY).await?;
    c.click("button", "Submit").await?;
    let trusted = c.engine.tiers().pointer_click == Support::Trusted;
    c.expect_text(&format!("Result: submitted [] clicks=1 trusted={trusted}")).await
}

async fn fill(c: &Ctx<'_>) -> CaseResult {
    c.open("/form.html", FORM_READY).await?;
    let field = c.ref_of("textbox", "Name").await?;
    let reply = c
        .call("fill", json!({ "ref": field, "value": "Ada" }))
        .await?;
    expect_fidelity(&reply, text_tier(c), "fill")?;
    c.click("button", "Submit").await?;
    c.expect_text("Result: submitted [Ada]").await
}

async fn type_text(c: &Ctx<'_>) -> CaseResult {
    c.open("/form.html", FORM_READY).await?;
    let field = c.ref_of("textbox", "Name").await?;
    let reply = c
        .call("type", json!({ "ref": field, "text": "Bob" }))
        .await?;
    expect_fidelity(&reply, text_tier(c), "type")?;
    c.click("button", "Submit").await?;
    c.expect_text("Result: submitted [Bob]").await
}

async fn link_click(c: &Ctx<'_>) -> CaseResult {
    c.open("/form.html", FORM_READY).await?;
    c.click("link", "Next page").await?;
    c.call("wait", json!({ "text": "Form done" })).await?;
    c.expect_url("/form-done.html", "the link").await
}

async fn wait_text(c: &Ctx<'_>) -> CaseResult {
    c.open("/delayed.html", DELAYED_READY).await?;
    c.call("wait", json!({ "text": "Late element ready" }))
        .await?;
    c.expect_text("Late element ready").await
}

async fn redirect(c: &Ctx<'_>) -> CaseResult {
    c.open(REDIRECT_PATH, REDIRECT_READY).await?;
    c.expect_url(REDIRECT_TARGET_PATH, "the redirect").await
}

async fn back(c: &Ctx<'_>) -> CaseResult {
    c.open("/form.html", FORM_READY).await?;
    c.open("/delayed.html", DELAYED_READY).await?;
    c.call("back", json!({})).await?;
    c.call("wait", json!({ "text": FORM_READY })).await?;
    c.expect_url("/form.html", "back").await
}

async fn reload(c: &Ctx<'_>) -> CaseResult {
    c.open("/form.html", FORM_READY).await?;
    c.click("button", "Submit").await?;
    c.expect_text("clicks=1").await?;
    c.call("reload", json!({})).await?;
    c.call("wait", json!({ "text": "Result: none" })).await?;
    Ok(())
}

async fn stale_ref(c: &Ctx<'_>) -> CaseResult {
    c.open("/form.html", FORM_READY).await?;
    let submit = c.ref_of("button", "Submit").await?;
    c.open("/delayed.html", DELAYED_READY).await?;
    expect_code(
        c.call("click", json!({ "ref": submit })).await,
        "stale_ref",
        "click on a ref from the previous document",
    )
}

/// A page that overrides the prototypes and globals helpers would use, and
/// traps any helper state that reaches its world, changes no result.
async fn tamper(c: &Ctx<'_>) -> CaseResult {
    c.open("/tamper.html", TAMPER_READY).await?;
    let snap = c.snapshot().await?;
    if snap.title != "Tamper fixture" {
        return Err(mismatch(format!("snapshot title is {}", snap.title)));
    }
    for line in [
        "- textbox \"Secret field\" @e",
        "- button \"Real button\" @e",
        "Leaks: none",
    ] {
        if !snap.text.contains(line) {
            return Err(mismatch(format!("snapshot lacks `{line}`: {}", snap.text)));
        }
    }
    if snap.text.contains("FORGED") {
        return Err(mismatch(format!("snapshot read forged values: {}", snap.text)));
    }
    let field = find_ref(&snap.text, "textbox", "Secret field")
        .ok_or_else(|| mismatch("no Secret field ref"))?;
    c.call("fill", json!({ "ref": field, "value": "Ada" })).await?;
    c.click("button", "Real button").await?;
    let after = c.snapshot().await?;
    for line in ["Result: clicked real [Ada]", "Leaks: none"] {
        if !after.text.contains(line) {
            return Err(mismatch(format!("after fill and click, snapshot lacks `{line}`: {}", after.text)));
        }
    }
    Ok(())
}

async fn screenshot(c: &Ctx<'_>) -> CaseResult {
    c.call("new_tab", json!({ "url": c.fixtures.url("/form.html") }))
        .await?;
    let deadline = Instant::now() + SCREENSHOT_RETRY;
    loop {
        let attempt = match c.call("screenshot", json!({})).await {
            Ok(reply) => read_png(&reply),
            Err(f) if f.code == "capability_unavailable" => return Err(f),
            Err(f) => Err(f),
        };
        match attempt {
            Ok(()) => return Ok(()),
            Err(f) if Instant::now() > deadline => return Err(f),
            Err(_) => tokio::time::sleep(Duration::from_millis(300)).await,
        }
    }
}

fn read_png(reply: &Value) -> CaseResult {
    let path = reply["data"]["path"]
        .as_str()
        .ok_or_else(|| mismatch("screenshot reply carries no path"))?;
    let bytes = std::fs::read(path).map_err(|e| mismatch(format!("screenshot unreadable: {e}")))?;
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        Ok(())
    } else {
        Err(mismatch(format!(
            "screenshot is {} bytes, not a PNG",
            bytes.len()
        )))
    }
}

pub struct Outcome {
    pub capability: &'static str,
    pub failure: Option<Failure>,
    pub duration: Duration,
}

/// Runs `capability`, or reports it blocked when a capability in `broken`
/// that it needs already failed.
pub async fn run(
    engine: &Engine,
    fixtures: &FixtureServer,
    cross: &FixtureServer,
    capability: &Capability,
    broken: &[&'static str],
) -> Outcome {
    if let Some(need) = capability.needs.iter().find(|n| broken.contains(n)) {
        return Outcome {
            capability: capability.id,
            failure: Some(Failure {
                code: BLOCKED.into(),
                reason: None,
                message: format!("needs {need}, which failed"),
            }),
            duration: Duration::ZERO,
        };
    }
    let ctx = Ctx {
        engine,
        fixtures,
        cross,
        session: format!("conformance-{}", capability.id),
    };
    let started = Instant::now();
    let result = match capability.id {
        "tab_lifecycle" => tab_lifecycle(&ctx).await,
        "error_codes" => error_codes(&ctx).await,
        "navigate" => navigate(&ctx).await,
        "snapshot" => snapshot(&ctx).await,
        "click" => click(&ctx).await,
        "fill" => fill(&ctx).await,
        "type" => type_text(&ctx).await,
        "link_click" => link_click(&ctx).await,
        "wait_text" => wait_text(&ctx).await,
        "redirect" => redirect(&ctx).await,
        "back" => back(&ctx).await,
        "reload" => reload(&ctx).await,
        "stale_ref" => stale_ref(&ctx).await,
        "tamper" => tamper(&ctx).await,
        "labelled_form" => forms::labelled_form(&ctx).await,
        "shifted_rows" => forms::shifted_rows(&ctx).await,
        "screenshot" => screenshot(&ctx).await,
        "actionability_covered" => input_cases::actionability_covered(&ctx).await,
        "actionability_moving" => input_cases::actionability_moving(&ctx).await,
        "actionability_hidden" => input_cases::actionability_hidden(&ctx).await,
        "input_pointer_click" => input_cases::pointer_click(&ctx).await,
        "input_trusted_key" => input_cases::trusted_key(&ctx).await,
        "input_pointer_move" => input_cases::pointer_move(&ctx).await,
        "input_wheel" => input_cases::wheel(&ctx).await,
        "input_drag" => input_cases::drag(&ctx).await,
        "drag" => input_cases::drag_verb(&ctx).await,
        "focus_retention" => input_cases::focus_retention(&ctx).await,
        "dialog_alert" => events::dialog_alert(&ctx).await,
        "dialog_confirm" => events::dialog_confirm(&ctx).await,
        "dialog_prompt" => events::dialog_prompt(&ctx).await,
        "dialog_beforeunload" => events::dialog_beforeunload(&ctx).await,
        "dialog_on_load" => events::dialog_on_load(&ctx).await,
        "popup" => events::popup(&ctx).await,
        "external_protocol" => events::external_protocol(&ctx).await,
        "permissions" => events::permissions(&ctx).await,
        "select_option" => events::select_option(&ctx).await,
        "check" => events::check(&ctx).await,
        "wait_semantic" => events::wait_semantic(&ctx).await,
        "switch_tab" => events::switch_tab(&ctx).await,
        "console" => observe::console(&ctx).await,
        "network" => observe::network(&ctx).await,
        "iframe_same_origin" => frames::iframe_same_origin(&ctx).await,
        "iframe_cross_origin" => frames::iframe_cross_origin(&ctx).await,
        "shadow_dom" => frames::shadow_dom(&ctx).await,
        "csp_snapshot" => frames::csp_snapshot(&ctx).await,
        "password_submit" => sensitive_cases::password_submit(&ctx).await,
        "password_submit_global" => sensitive_cases::password_submit_global(&ctx).await,
        "password_submit_asked" => sensitive_cases::password_submit_asked(&ctx).await,
        "focused_password_submit" => sensitive_cases::focused_password_submit(&ctx).await,
        "check_password_submit" => sensitive_cases::check_password_submit(&ctx).await,
        "formless_password_submit" => sensitive_cases::formless_password_submit(&ctx).await,
        "payment_outside_form" => sensitive_cases::payment_outside_form(&ctx).await,
        "tainted_link_enter" => sensitive_cases::tainted_link_enter(&ctx).await,
        "tainted_navigation" => sensitive_cases::tainted_navigation(&ctx).await,
        "upload" => sensitive_cases::upload(&ctx).await,
        "upload_refusals" => sensitive_cases::upload_refusals(&ctx).await,
        "file_chooser" => sensitive_cases::file_chooser(&ctx).await,
        "download" => sensitive_cases::download(&ctx).await,
        "download_preapproved" => sensitive_cases::download_preapproved(&ctx).await,
        "download_size_cap" => sensitive_cases::download_size_cap(&ctx).await,
        "frame_password_submit" => frames::frame_password_submit(&ctx).await,
        "frame_focused_password_submit" => frames::frame_focused_password_submit(&ctx).await,
        "frame_focused_key" => frames::frame_focused_key(&ctx).await,
        "frame_upload" => frames::frame_upload(&ctx).await,
        "frame_file_chooser" => frames::frame_file_chooser(&ctx).await,
        "frame_denied_origin" => frames::frame_denied_origin(&ctx).await,
        other => Err(mismatch(format!("no case named {other}"))),
    };
    engine.end_session(&ctx.session);
    Outcome {
        capability: capability.id,
        failure: result.err(),
        duration: started.elapsed(),
    }
}
