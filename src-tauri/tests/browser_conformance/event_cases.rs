//! Cases for in-page events (script dialogs, popups, external-app links,
//! web permissions) and for the form, wait and tab verbs.

use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::{expect_code, expect_fidelity, expect_some_fidelity, find_ref, mismatch, tab_id, CaseResult, Ctx, Failure};
use termul_manager_lib::conformance_support::Support;

const DIALOGS_READY: &str = "Dialog fixture";
const POPUP_READY: &str = "Popup fixture";
const EXTERNAL_READY: &str = "External app fixture";
const PERMISSIONS_READY: &str = "Permission fixture";
const CONTROLS_READY: &str = "Form controls";

/// How long a case polls for an engine event to reach the host.
const EVENT_WAIT: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(200);

impl Ctx<'_> {
    async fn click_reply(&self, role: &str, name: &str) -> Result<Value, Failure> {
        let target = self.ref_of(role, name).await?;
        self.call("click", json!({ "ref": target })).await
    }

    async fn tab(&self) -> Result<String, Failure> {
        tab_id(&self.call("snapshot", json!({})).await?)
    }

    /// The dialog that holds the session's tab: from `reply` when the call
    /// ended on it, else from `list_tabs` once the engine event arrived.
    async fn open_dialog(&self, reply: &Value) -> Result<Value, Failure> {
        let dialog = &reply["page"]["dialog"];
        if dialog["state"] == "open" {
            return Ok(dialog.clone());
        }
        let until = Instant::now() + EVENT_WAIT;
        while Instant::now() < until {
            let listed = self.call("list_tabs", json!({})).await?;
            let open = listed["data"]["tabs"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|t| &t["page"]["dialog"])
                .find(|d| d["state"] == "open");
            if let Some(open) = open {
                return Ok(open.clone());
            }
            tokio::time::sleep(POLL).await;
        }
        Err(mismatch(format!(
            "no dialog opened; the click replied {reply}"
        )))
    }

    async fn expect_dialog(
        &self,
        reply: &Value,
        kind: &str,
        message: &str,
    ) -> Result<Value, Failure> {
        let dialog = self.open_dialog(reply).await?;
        if dialog["kind"] == kind && dialog["message"] == message {
            Ok(dialog)
        } else {
            Err(mismatch(format!(
                "expected an open {kind} \"{message}\", got {dialog}"
            )))
        }
    }

    /// The first agent tab whose opener is `opener`, other than `known`.
    async fn popup_of(&self, opener: &str, known: &[String]) -> Result<String, Failure> {
        let until = Instant::now() + EVENT_WAIT;
        while Instant::now() < until {
            let listed = self.call("list_tabs", json!({})).await?;
            let popup = listed["data"]["tabs"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|t| t["tab"]["opener"] == opener)
                .filter_map(|t| t["tab"]["id"].as_str())
                .find(|id| !known.iter().any(|k| k == id));
            if let Some(popup) = popup {
                return Ok(popup.to_string());
            }
            tokio::time::sleep(POLL).await;
        }
        Err(mismatch("no popup tab opened"))
    }

    async fn page_text(&self, tab: &str) -> Result<String, Failure> {
        let reply = self.call("snapshot", json!({ "tabId": tab })).await?;
        Ok(reply["page"]["snapshot"]
            .as_str()
            .unwrap_or_default()
            .to_string())
    }
}

pub async fn dialog_alert(c: &Ctx<'_>) -> CaseResult {
    c.open("/dialogs.html", DIALOGS_READY).await?;
    let reply = c.click_reply("button", "Show alert").await?;
    expect_fidelity(&reply, c.engine.tiers().pointer_click, "click")?;
    // A trusted click can reply before the page runs its handler, and an
    // accepted alert is reported once, on the first reply after it opened.
    let waited = c
        .call("wait", json!({ "text": "Result: alert closed" }))
        .await?;
    let after = c.call("snapshot", json!({})).await?;
    let reported = [&reply, &waited, &after].iter().any(|r| {
        r["page"]["dialog"]["kind"] == "alert" && r["page"]["dialog"]["state"] == "accepted"
    });
    if reported {
        Ok(())
    } else {
        Err(mismatch(format!(
            "the accepted alert was never reported: {reply} then {waited} then {after}"
        )))
    }
}

pub async fn dialog_confirm(c: &Ctx<'_>) -> CaseResult {
    c.open("/dialogs.html", DIALOGS_READY).await?;
    for (accept, result) in [
        (true, "Result: confirm true"),
        (false, "Result: confirm false"),
    ] {
        let reply = c.click_reply("button", "Show confirm").await?;
        c.expect_dialog(&reply, "confirm", "Fixture confirm?")
            .await?;
        expect_code(
            c.call("snapshot", json!({})).await,
            "confirmation_required",
            "a page verb on a blocked tab",
        )?;
        let answered = c.call("handle_dialog", json!({ "accept": accept })).await?;
        expect_some_fidelity(&answered, "handle_dialog")?;
        c.call("wait", json!({ "text": result })).await?;
    }
    Ok(())
}

pub async fn dialog_prompt(c: &Ctx<'_>) -> CaseResult {
    c.open("/dialogs.html", DIALOGS_READY).await?;
    let reply = c.click_reply("button", "Show prompt").await?;
    let dialog = c.expect_dialog(&reply, "prompt", "Fixture prompt?").await?;
    if dialog["default_text"] != "default name" {
        return Err(mismatch(format!("prompt default text: {dialog}")));
    }
    c.call("handle_dialog", json!({ "accept": true, "text": "Ada" }))
        .await?;
    c.call("wait", json!({ "text": "Result: prompt [Ada]" }))
        .await?;
    let reply = c.click_reply("button", "Show prompt").await?;
    c.expect_dialog(&reply, "prompt", "Fixture prompt?").await?;
    c.call("handle_dialog", json!({ "accept": false })).await?;
    c.call("wait", json!({ "text": "Result: prompt [null]" }))
        .await?;
    Ok(())
}

/// An unload guard never holds up a navigation the agent asked for.
pub async fn dialog_beforeunload(c: &Ctx<'_>) -> CaseResult {
    c.open("/dialogs.html", DIALOGS_READY).await?;
    c.click_reply("button", "Guard unload").await?;
    c.call("wait", json!({ "text": "Result: unload guarded" }))
        .await?;
    c.open("/form.html", "Conformance form").await?;
    c.expect_url("/form.html", "the guarded navigation").await
}

/// A dialog the tab's first page raises while it loads reaches the host,
/// which accepts an alert at once.
pub async fn dialog_on_load(c: &Ctx<'_>) -> CaseResult {
    let reply = c.navigate("/dialogs.html?alert-on-load").await?;
    let waited = c
        .call("wait", json!({ "text": "Result: load alert closed" }))
        .await?;
    let after = c.call("snapshot", json!({})).await?;
    let reported = [&reply, &waited, &after].iter().any(|r| {
        r["page"]["dialog"]["kind"] == "alert"
            && r["page"]["dialog"]["message"] == "Load alert"
            && r["page"]["dialog"]["state"] == "accepted"
    });
    if reported {
        Ok(())
    } else {
        Err(mismatch(format!(
            "the alert of the first page load was never reported: {reply} then {waited} then {after}"
        )))
    }
}

pub async fn popup(c: &Ctx<'_>) -> CaseResult {
    c.open("/popup.html", POPUP_READY).await?;
    let opener = c.tab().await?;
    c.click_reply("button", "Open popup").await?;
    let first = c.popup_of(&opener, &[]).await?;
    c.call("wait", json!({ "text": "Opener: none", "tabId": first }))
        .await?;
    let text = c.page_text(&first).await?;
    if !text.contains("Popup target") {
        return Err(mismatch(format!("the popup tab shows {text}")));
    }
    c.click_reply("link", "Open in new tab").await?;
    let second = c.popup_of(&opener, std::slice::from_ref(&first)).await?;
    c.call("wait", json!({ "text": "Opener: none", "tabId": second }))
        .await?;
    if c.tab().await? != opener {
        return Err(mismatch("a popup became the session's tab"));
    }
    Ok(())
}

pub async fn external_protocol(c: &Ctx<'_>) -> CaseResult {
    c.open("/external.html", EXTERNAL_READY).await?;
    for (role, name) in [
        ("link", "Mail link"),
        ("link", "Custom scheme link"),
        ("button", "Scripted launch"),
    ] {
        c.click_reply(role, name).await?;
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    c.expect_url("/external.html", "an external-app link")
        .await?;
    c.expect_text("Result: still here").await
}

pub async fn permissions(c: &Ctx<'_>) -> CaseResult {
    c.open("/permissions.html", PERMISSIONS_READY).await?;
    c.call("wait", json!({ "text": "Permissions settled" }))
        .await?;
    let text = c.page_text(&c.tab().await?).await?;
    // The host's deny handler logs every answer it gives. `NotAllowedError`
    // is that refusal reaching the page. A runner with no capture device
    // (GitHub's Windows image has none) fails camera and microphone with
    // `NotFoundError` before any permission check, so on WebView2 that
    // error says nothing about the handler; the geolocation request does
    // reach it, and its logged denial proves the handler is wired on the
    // agent tab. Geolocation must come back PERMISSION_DENIED (code 1).
    let media_errors: &[&str] = if cfg!(windows) {
        &["NotAllowedError", "NotFoundError"]
    } else {
        &[""]
    };
    for id in ["camera", "microphone"] {
        let line = media_errors
            .iter()
            .map(|error| format!("{id}: denied {error}").trim_end().to_string())
            .find(|line| text.contains(line.as_str()));
        let Some(line) = line else {
            return Err(mismatch(format!("{id} was not refused: {text}")));
        };
        let reached_handler = line.ends_with("NotAllowedError");
        if reached_handler && crate::host_log::permission_response(id).as_deref() != Some("deny") {
            return Err(mismatch(format!(
                "{id} reads as refused by the host but the handler logged no denial: {text}"
            )));
        }
    }
    if !text.contains("geolocation: denied code 1") {
        return Err(mismatch(format!("expected a geolocation refusal: {text}")));
    }
    let geolocation_denied =
        crate::host_log::permission_response("geolocation").as_deref() == Some("deny");
    if cfg!(windows) && !geolocation_denied {
        return Err(mismatch(format!(
            "the host's deny handler logged no geolocation denial: {text}"
        )));
    }
    Ok(())
}

pub async fn select_option(c: &Ctx<'_>) -> CaseResult {
    c.open("/controls.html", CONTROLS_READY).await?;
    let color = c.ref_of("combobox", "Color").await?;
    let reply = c
        .call("select_option", json!({ "ref": color, "value": "green" }))
        .await?;
    expect_fidelity(&reply, Support::Synthetic, "select_option")?;
    c.call("wait", json!({ "text": "color=green" })).await?;
    let color = c.ref_of("combobox", "Color").await?;
    c.call(
        "select_option",
        json!({ "ref": color, "value": "Deep blue" }),
    )
    .await?;
    c.call("wait", json!({ "text": "color=blue" })).await?;
    let color = c.ref_of("combobox", "Color").await?;
    expect_code(
        c.call("select_option", json!({ "ref": color, "value": "purple" }))
            .await,
        "invalid_params",
        "an option the select does not have",
    )
}

pub async fn check(c: &Ctx<'_>) -> CaseResult {
    c.open("/controls.html", CONTROLS_READY).await?;
    let snap = c.snapshot().await?;
    let find = |role: &str, name: &str| {
        find_ref(&snap.text, role, name)
            .ok_or_else(|| mismatch(format!("no {role} \"{name}\" in {}", snap.text)))
    };
    let (news, terms, large, small) = (
        find("checkbox", "Newsletter")?,
        find("checkbox", "Terms")?,
        find("radio", "Large")?,
        find("radio", "Small")?,
    );
    for (verb, target, changed) in [
        ("check", &news, true),
        ("check", &news, false),
        ("uncheck", &terms, true),
        ("check", &large, true),
    ] {
        let reply = c.call(verb, json!({ "ref": target })).await?;
        expect_fidelity(&reply, c.engine.tiers().pointer_click, verb)?;
        if reply["data"]["changed"] != changed {
            return Err(mismatch(format!("{verb} {target}: {reply}")));
        }
    }
    expect_code(
        c.call("uncheck", json!({ "ref": small })).await,
        "invalid_params",
        "unchecking a radio button",
    )?;
    c.call(
        "wait",
        json!({ "text": "news=true terms=false size=large" }),
    )
    .await?;
    Ok(())
}

pub async fn wait_semantic(c: &Ctx<'_>) -> CaseResult {
    c.navigate("/dynamic.html").await?;
    for args in [
        json!({ "loadState": "load" }),
        json!({ "textGone": "Loading the dashboard" }),
        json!({ "urlContains": "step=2" }),
        json!({ "text": "Step two ready" }),
    ] {
        c.call("wait", args).await?;
    }
    expect_code(
        c.call("wait", json!({ "loadState": "networkidle" })).await,
        "invalid_params",
        "an unknown load state",
    )
}

pub async fn switch_tab(c: &Ctx<'_>) -> CaseResult {
    let first = tab_id(
        &c.call("new_tab", json!({ "url": c.fixtures.url("/form.html") }))
            .await?,
    )?;
    let second = tab_id(
        &c.call("new_tab", json!({ "url": c.fixtures.url("/delayed.html") }))
            .await?,
    )?;
    if c.tab().await? != first {
        return Err(mismatch("new_tab moved the session's tab"));
    }
    let switched = c.call("switch_tab", json!({ "tabId": second })).await?;
    if tab_id(&switched)? != second || c.tab().await? != second {
        return Err(mismatch(format!("switch_tab did not retarget: {switched}")));
    }
    Ok(())
}
