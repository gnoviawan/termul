//! One case per capability the host offers today. Each case drives its own
//! session through navigate, snapshot and the other verbs, and checks the page
//! state the verbs should have produced.

use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::adapter::{Engine, StepError};
use crate::fixture_server::{FixtureServer, REDIRECT_PATH, REDIRECT_TARGET_PATH};

const FORM_READY: &str = "Conformance form";
const DELAYED_READY: &str = "Delayed element";
const REDIRECT_READY: &str = "Redirect target reached";

/// Budget for a call that opens a tab or loads a page.
const NAVIGATE_BUDGET: Duration = Duration::from_secs(15);
/// Budget for every other call.
const STEP_BUDGET: Duration = Duration::from_secs(10);

pub const CAPABILITIES: &[&str] = &[
    "tab_lifecycle",
    "error_codes",
    "navigate",
    "snapshot",
    "click",
    "fill",
    "type",
    "link_click",
    "wait_text",
    "redirect",
    "back",
    "reload",
    "stale_ref",
    "screenshot",
];

#[derive(Debug)]
pub struct Failure {
    pub code: String,
    pub message: String,
}

impl From<StepError> for Failure {
    fn from(e: StepError) -> Self {
        Self {
            code: e.code,
            message: e.message,
        }
    }
}

fn mismatch(message: impl Into<String>) -> Failure {
    Failure {
        code: "assertion".into(),
        message: message.into(),
    }
}

type CaseResult = Result<(), Failure>;

struct Snapshot {
    text: String,
    url: String,
    title: String,
}

struct Ctx<'a> {
    engine: &'a Engine,
    fixtures: &'a FixtureServer,
    session: String,
}

impl Ctx<'_> {
    async fn call(&self, action: &str, args: Value) -> Result<Value, Failure> {
        let budget = if action == "navigate" || action == "new_tab" {
            NAVIGATE_BUDGET
        } else {
            STEP_BUDGET
        };
        Ok(self
            .engine
            .call(&self.session, action, args, budget)
            .await?)
    }

    async fn navigate(&self, path: &str) -> Result<String, Failure> {
        let reply = self
            .call("navigate", json!({ "url": self.fixtures.url(path) }))
            .await?;
        reply["tabId"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| mismatch("navigate reply carries no tabId"))
    }

    /// Navigate, then wait until the page's own text is visible. A call that
    /// returns before the new document commits would otherwise race the next
    /// snapshot.
    async fn open(&self, path: &str, ready_text: &str) -> Result<String, Failure> {
        let tab_id = self.navigate(path).await?;
        self.call("wait", json!({ "text": ready_text })).await?;
        Ok(tab_id)
    }

    async fn snapshot(&self) -> Result<Snapshot, Failure> {
        let reply = self.call("snapshot", json!({})).await?;
        let field = |name: &str| reply[name].as_str().unwrap_or_default().to_string();
        Ok(Snapshot {
            text: field("snapshot"),
            url: field("url"),
            title: field("title"),
        })
    }

    async fn ref_of(&self, role: &str, name: &str) -> Result<String, Failure> {
        let snap = self.snapshot().await?;
        find_ref(&snap.text, role, name)
            .ok_or_else(|| mismatch(format!("snapshot has no {role} \"{name}\" ref")))
    }

    async fn click(&self, role: &str, name: &str) -> Result<(), Failure> {
        let target = self.ref_of(role, name).await?;
        self.call("click", json!({ "ref": target })).await?;
        Ok(())
    }

    async fn expect_text(&self, needle: &str) -> CaseResult {
        let snap = self.snapshot().await?;
        if snap.text.contains(needle) {
            Ok(())
        } else {
            Err(mismatch(format!("snapshot lacks \"{needle}\"")))
        }
    }
}

/// `- button "Submit" @e2` -> `@e2`.
fn find_ref(snapshot: &str, role: &str, name: &str) -> Option<String> {
    let prefix = format!("- {role} \"{name}\" @e");
    snapshot.lines().find_map(|line| {
        let rest = line.trim_start().strip_prefix(&prefix)?;
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        (!digits.is_empty()).then(|| format!("@e{digits}"))
    })
}

fn expect_code(result: Result<Value, Failure>, code: &str, what: &str) -> CaseResult {
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
    let tab_id = opened["tabId"]
        .as_str()
        .ok_or_else(|| mismatch("new_tab reply carries no tabId"))?
        .to_string();
    let listed = c.call("list_tabs", json!({})).await?;
    let ids: Vec<&str> = listed["tabs"]
        .as_array()
        .map(|tabs| tabs.iter().filter_map(|t| t["tabId"].as_str()).collect())
        .unwrap_or_default();
    if ids != [tab_id.as_str()] {
        return Err(mismatch(format!("list_tabs returned {ids:?}")));
    }
    c.call("close_tab", json!({ "tabId": tab_id })).await?;
    let after = c.call("list_tabs", json!({})).await?;
    match after["tabs"].as_array() {
        Some(tabs) if tabs.is_empty() => Ok(()),
        _ => Err(mismatch("list_tabs still lists the closed tab")),
    }
}

async fn error_codes(c: &Ctx<'_>) -> CaseResult {
    expect_code(
        c.call("navigate", json!({ "url": "file:///etc/hosts" })).await,
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
        c.call("snapshot", json!({ "tabId": "agent-missing" })).await,
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
    c.open("/form.html", FORM_READY).await.map(|_| ())
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
    c.expect_text("Result: submitted [] clicks=1").await
}

async fn fill(c: &Ctx<'_>) -> CaseResult {
    c.open("/form.html", FORM_READY).await?;
    let field = c.ref_of("textbox", "Name").await?;
    c.call("fill", json!({ "ref": field, "value": "Ada" })).await?;
    c.click("button", "Submit").await?;
    c.expect_text("Result: submitted [Ada]").await
}

async fn type_text(c: &Ctx<'_>) -> CaseResult {
    c.open("/form.html", FORM_READY).await?;
    let field = c.ref_of("textbox", "Name").await?;
    c.call("type", json!({ "ref": field, "text": "Bob" })).await?;
    c.click("button", "Submit").await?;
    c.expect_text("Result: submitted [Bob]").await
}

async fn link_click(c: &Ctx<'_>) -> CaseResult {
    c.open("/form.html", FORM_READY).await?;
    c.click("link", "Next page").await?;
    c.call("wait", json!({ "text": "Form done" })).await?;
    let snap = c.snapshot().await?;
    if snap.url == c.fixtures.url("/form-done.html") {
        Ok(())
    } else {
        Err(mismatch(format!("page url after the click is {}", snap.url)))
    }
}

async fn wait_text(c: &Ctx<'_>) -> CaseResult {
    c.open("/delayed.html", DELAYED_READY).await?;
    c.call("wait", json!({ "text": "Late element ready" })).await?;
    c.expect_text("Late element ready").await
}

async fn redirect(c: &Ctx<'_>) -> CaseResult {
    c.open(REDIRECT_PATH, REDIRECT_READY).await?;
    let snap = c.snapshot().await?;
    if snap.url == c.fixtures.url(REDIRECT_TARGET_PATH) {
        Ok(())
    } else {
        Err(mismatch(format!("redirect landed on {}", snap.url)))
    }
}

async fn back(c: &Ctx<'_>) -> CaseResult {
    c.open("/form.html", FORM_READY).await?;
    c.open("/delayed.html", DELAYED_READY).await?;
    c.call("back", json!({})).await?;
    c.call("wait", json!({ "text": "Conformance form" })).await?;
    let snap = c.snapshot().await?;
    if snap.url == c.fixtures.url("/form.html") {
        Ok(())
    } else {
        Err(mismatch(format!("back landed on {}", snap.url)))
    }
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

async fn screenshot(c: &Ctx<'_>) -> CaseResult {
    c.open("/form.html", FORM_READY).await?;
    let reply = c.call("screenshot", json!({})).await?;
    let path = reply["path"]
        .as_str()
        .ok_or_else(|| mismatch("screenshot reply carries no path"))?;
    let bytes = std::fs::read(path).map_err(|e| mismatch(format!("screenshot unreadable: {e}")))?;
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) && bytes.len() > 1024 {
        Ok(())
    } else {
        Err(mismatch(format!("screenshot is {} bytes, not a PNG", bytes.len())))
    }
}

pub struct Outcome {
    pub capability: &'static str,
    pub failure: Option<Failure>,
    pub duration: Duration,
}

pub async fn run(engine: &Engine, fixtures: &FixtureServer, capability: &'static str) -> Outcome {
    let ctx = Ctx {
        engine,
        fixtures,
        session: format!("conformance-{capability}"),
    };
    let started = Instant::now();
    let result = match capability {
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
        "screenshot" => screenshot(&ctx).await,
        other => Err(mismatch(format!("no case named {other}"))),
    };
    engine.end_session(&ctx.session);
    Outcome {
        capability,
        failure: result.err(),
        duration: started.elapsed(),
    }
}
