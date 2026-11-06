use std::time::Duration;

use serde_json::{json, Value};

use super::*;
use crate::browser_automation::core::tests::{harness_with, webview2_like, FakeEngine, Harness};
use crate::browser_automation::engine::events::TabEvent;
use crate::browser_automation::engine::BrowserEngine;
use crate::browser_automation::BrowserHost;

async fn agent_tab(h: &Harness) -> String {
    let reply = h
        .call_as(
            "s1",
            "navigate",
            json!({ "url": "https://example.com/start" }),
        )
        .await;
    reply["tab"]["id"]
        .as_str()
        .expect("navigate opens a tab")
        .to_string()
}

async fn open_dialog(h: &Harness, tab: &str, kind: DialogKind, default_text: Option<&str>) {
    h.pane
        .events(tab)
        .dialog_opened(kind, "Proceed?".into(), default_text.map(str::to_string));
    h.settle_events().await;
}

#[tokio::test]
async fn a_held_confirm_blocks_page_verbs_until_handle_dialog_answers_it() {
    let h = harness_with(FakeEngine::new(webview2_like()));
    let tab = agent_tab(&h).await;
    open_dialog(&h, &tab, DialogKind::Confirm, None).await;

    let refused = h.call_as("s1", "snapshot", json!({})).await;
    assert_eq!(
        (refused["code"].clone(), refused["reason"].clone()),
        (json!("confirmation_required"), json!("tab_blocked")),
        "{refused}"
    );
    let listed = h.call_as("s1", "list_tabs", json!({})).await;
    assert_eq!(
        listed["data"]["tabs"][0]["page"]["dialog"],
        json!({ "kind": "confirm", "message": "Proceed?", "state": "open" }),
        "{listed}"
    );

    let answered = h
        .call_as("s1", "handle_dialog", json!({ "accept": false }))
        .await;
    assert_eq!(
        answered["page"]["dialog"]["state"], "dismissed",
        "{answered}"
    );
    assert_eq!(*h.engine.answers.lock(), [(1, DialogAnswer::Dismiss)]);
    let snap = h.call_as("s1", "snapshot", json!({})).await;
    assert_eq!(snap["ok"], true, "{snap}");
    assert!(
        snap["page"].get("dialog").is_none(),
        "an answered dialog is not reported again: {snap}"
    );

    let none = h
        .call_as("s1", "handle_dialog", json!({ "accept": true }))
        .await;
    assert_eq!(none["reason"], "no_dialog", "{none}");
}

#[tokio::test]
async fn a_dialog_that_opens_mid_call_ends_the_call_with_the_dialog_in_the_reply() {
    let h = harness_with(FakeEngine::new(webview2_like()));
    let tab = agent_tab(&h).await;
    let events = h.pane.events(&tab);
    let call = h.call_as("s1", "wait", json!({ "textGone": "Sign in" }));
    let opener = async {
        tokio::time::sleep(Duration::from_millis(50)).await;
        events.dialog_opened(DialogKind::Prompt, "Name?".into(), Some("Ada".into()));
    };
    let (reply, ()) =
        tokio::time::timeout(Duration::from_secs(5), async { tokio::join!(call, opener) })
            .await
            .expect("the wait ends when the dialog opens, not after 30s");
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(
        reply["page"]["dialog"],
        json!({ "kind": "prompt", "message": "Name?", "default_text": "Ada", "state": "open" }),
        "{reply}"
    );

    h.call_as("s1", "handle_dialog", json!({ "accept": true }))
        .await;
    assert_eq!(
        *h.engine.answers.lock(),
        [(
            1,
            DialogAnswer::Accept {
                text: Some("Ada".into())
            }
        )],
        "a prompt accepted without text returns its default"
    );
}

#[tokio::test]
async fn an_alert_is_accepted_at_once_and_reported_on_the_next_reply_only() {
    let h = harness_with(FakeEngine::new(webview2_like()));
    let tab = agent_tab(&h).await;
    open_dialog(&h, &tab, DialogKind::Alert, None).await;
    assert_eq!(
        *h.engine.answers.lock(),
        [(1, DialogAnswer::Accept { text: None })]
    );

    let snap = h.call_as("s1", "snapshot", json!({})).await;
    assert_eq!(snap["page"]["dialog"]["state"], "accepted", "{snap}");
    let again = h.call_as("s1", "snapshot", json!({})).await;
    assert!(again["page"].get("dialog").is_none(), "{again}");
}

fn popups(reply: &Value) -> Vec<Value> {
    reply["data"]["popups"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

#[tokio::test]
async fn popups_open_as_owned_tabs_up_to_the_cap_and_the_opener_hears_each_outcome() {
    let h = harness_with(FakeEngine::new(webview2_like()));
    let opener = agent_tab(&h).await;
    let events = h.pane.events(&opener);
    for n in 1..=MAX_POPUPS_PLUS_ONE {
        events.publish(TabEvent::NewWindowRequested {
            url: format!("https://example.com/popup-{n}"),
        });
    }
    events.publish(TabEvent::NewWindowRequested {
        url: "mailto:someone@example.com".into(),
    });
    for _ in 0..8 {
        h.settle_events().await;
    }

    let snap = h.call_as("s1", "snapshot", json!({})).await;
    let notes = popups(&snap);
    assert_eq!(notes.len(), 5, "{snap}");
    assert!(notes[..3].iter().all(|n| n["opened"].is_string()), "{snap}");
    assert_eq!(notes[3], json!({ "blocked": "popup_cap" }));
    assert_eq!(notes[4], json!({ "blocked": "popup_url_not_http" }));
    assert_eq!(
        snap["tab"]["id"],
        opener.as_str(),
        "popups never take over the session's tab"
    );

    let listed = h.call_as("s1", "list_tabs", json!({})).await;
    let tabs = listed["data"]["tabs"].as_array().unwrap();
    assert_eq!(tabs.len(), 4, "{listed}");
    let popup_tabs: Vec<&Value> = tabs
        .iter()
        .filter(|t| t["tab"]["opener"] == opener.as_str())
        .collect();
    assert_eq!(popup_tabs.len(), 3, "{listed}");

    assert!(h.host.stop("s1"));
    for _ in 0..8 {
        h.settle_events().await;
    }
    h.host.user_turn("s1");
    let listed = h.call_as("s1", "list_tabs", json!({})).await;
    assert_eq!(
        listed["data"]["tabs"].as_array().unwrap().len(),
        1,
        "Stop closes popups: {listed}"
    );
}

const MAX_POPUPS_PLUS_ONE: usize = crate::browser_automation::core::tabs::MAX_OPEN_POPUPS + 1;

#[tokio::test]
async fn external_app_schemes_are_denied_on_every_tab() {
    let h = harness_with(FakeEngine::new(webview2_like()));
    let tab = agent_tab(&h).await;
    let events = h.pane.events(&tab);
    for url in [
        "mailto:a@example.com",
        "ms-settings:privacy",
        "zoommtg://join",
        "slack://open",
    ] {
        assert!(!events.nav_starting(&url.parse().unwrap()), "{url}");
    }
    assert!(events.nav_starting(&"https://example.com/next".parse().unwrap()));
    for url in [
        "https://example.com/",
        "about:blank",
        "data:text/plain,x",
        "tauri://localhost",
    ] {
        assert!(!launches_external_app(&url.parse().unwrap()), "{url}");
    }
}

#[tokio::test]
async fn no_agent_tab_opens_on_an_engine_missing_a_floor_hook() {
    let engine =
        FakeEngine::new(webview2_like().with(CapabilityId::DialogIntercept, Support::Synthetic));
    let h = harness_with(engine);
    let reply = h
        .call_as("s1", "navigate", json!({ "url": "https://example.com/" }))
        .await;
    assert_eq!(
        (reply["code"].clone(), reply["reason"].clone()),
        (json!("capability_unavailable"), json!("engine_floor")),
        "{reply}"
    );
    assert!(
        h.engine
            .facts()
            .capabilities
            .get(CapabilityId::DialogIntercept)
            != Support::Trusted
    );
}
