use serde_json::{json, Value};

use super::*;
use crate::browser_automation::core::tests::{harness_with, webview2_like, FakeEngine};

#[test]
fn wait_takes_exactly_one_condition() {
    let table = [
        (
            json!({ "ms": 50 }),
            WaitFor::Sleep(Duration::from_millis(50)),
        ),
        (json!({ "ms": 90_000 }), WaitFor::Sleep(budgets::WAIT_MAX)),
        (json!({ "text": "Done" }), WaitFor::Text("Done".into())),
        (
            json!({ "textGone": "Loading" }),
            WaitFor::TextGone("Loading".into()),
        ),
        (
            json!({ "urlContains": "/step-2" }),
            WaitFor::UrlContains("/step-2".into()),
        ),
        (
            json!({ "loadState": "load" }),
            WaitFor::Load(LoadState::Load),
        ),
        (
            json!({ "loadState": "domcontentloaded", "tabId": null }),
            WaitFor::Load(LoadState::DomContentLoaded),
        ),
    ];
    for (args, want) in table {
        assert_eq!(WaitFor::parse(&args).unwrap(), want, "{args}");
    }
    for (args, keys) in [
        (
            json!({}),
            vec!["ms", "text", "textGone", "urlContains", "loadState"],
        ),
        (json!({ "ms": 1, "text": "Done" }), vec!["ms", "text"]),
        (json!({ "loadState": "networkidle" }), vec!["loadState"]),
    ] {
        let err = WaitFor::parse(&args).unwrap_err();
        assert_eq!(err.code, "invalid_params", "{args}");
        assert_eq!(err.arg_keys, keys, "{args}");
    }
}

#[test]
fn each_condition_reads_its_own_probe() {
    let table: [(WaitFor, Value, bool); 9] = [
        (WaitFor::Text("a".into()), json!(true), true),
        (WaitFor::Text("a".into()), json!(false), false),
        (WaitFor::TextGone("a".into()), json!(false), true),
        (WaitFor::TextGone("a".into()), json!(true), false),
        (
            WaitFor::UrlContains("/b".into()),
            json!("https://x.test/a/b?c"),
            true,
        ),
        (
            WaitFor::UrlContains("/b".into()),
            json!("https://x.test/a"),
            false,
        ),
        (WaitFor::Load(LoadState::Load), json!("interactive"), false),
        (WaitFor::Load(LoadState::Load), json!("complete"), true),
        (
            WaitFor::Load(LoadState::DomContentLoaded),
            json!("interactive"),
            true,
        ),
    ];
    for (condition, probe, met) in table {
        assert_eq!(condition.met(&probe), met, "{condition:?} on {probe}");
    }
}

#[test]
fn form_helper_refusals_are_invalid_params_with_their_reason() {
    for (error, reason) in [
        ("not_checkable", "not_checkable"),
        ("not_a_select", "not_a_select"),
        ("no_such_option", "no_such_option"),
        ("option_disabled", "option_disabled"),
    ] {
        let err = form_refusal(&json!({ "error": error }), "@e3").unwrap_err();
        assert_eq!((err.code, err.reason), ("invalid_params", Some(reason)));
        assert_eq!(err.arg_keys, vec!["ref"]);
    }
    // Page failures are left to the result parsers.
    assert!(form_refusal(&json!({ "error": "stale_ref" }), "@e3").is_ok());
    assert!(form_refusal(&json!({ "ok": true }), "@e3").is_ok());
}

#[tokio::test]
async fn check_clicks_only_when_the_state_differs() {
    let h = harness_with(FakeEngine::new(webview2_like()));
    h.call_as(
        "s1",
        "navigate",
        json!({ "url": "https://example.com/form" }),
    )
    .await;
    h.call_as("s1", "snapshot", json!({})).await;

    let first = h.call_as("s1", "check", json!({ "ref": "@e1" })).await;
    assert_eq!(
        (first["ok"].clone(), first["data"].clone()),
        (json!(true), json!({ "changed": true })),
        "{first}"
    );
    let again = h.call_as("s1", "check", json!({ "ref": "@e1" })).await;
    assert_eq!(again["data"], json!({ "changed": false }), "{again}");
    assert_eq!(
        h.engine.clicks.lock().len(),
        1,
        "an already-checked box gets no click"
    );

    let off = h.call_as("s1", "uncheck", json!({ "ref": "@e1" })).await;
    assert_eq!(
        (off["data"].clone(), off["fidelity"].clone()),
        (json!({ "changed": true }), json!("trusted")),
        "{off}"
    );
    assert!(!*h.engine.checked.lock());
}

#[tokio::test]
async fn switch_tab_retargets_calls_without_a_tab_id() {
    let h = harness_with(FakeEngine::new(webview2_like()));
    let first = h
        .call_as("s1", "navigate", json!({ "url": "https://example.com/a" }))
        .await;
    let second = h
        .call_as("s1", "new_tab", json!({ "url": "https://example.com/b" }))
        .await;
    let (first, second) = (first["tab"]["id"].clone(), second["tab"]["id"].clone());

    let snap = h.call_as("s1", "snapshot", json!({})).await;
    assert_eq!(
        snap["tab"]["id"], first,
        "new_tab leaves the session's tab alone"
    );
    let switched = h
        .call_as("s1", "switch_tab", json!({ "tabId": second }))
        .await;
    assert_eq!(switched["tab"]["id"], second, "{switched}");
    let snap = h.call_as("s1", "snapshot", json!({})).await;
    assert_eq!(snap["tab"]["id"], second);

    let foreign = h
        .call_as("s2", "switch_tab", json!({ "tabId": first }))
        .await;
    assert_eq!(foreign["code"], "tab_not_found", "{foreign}");
}
