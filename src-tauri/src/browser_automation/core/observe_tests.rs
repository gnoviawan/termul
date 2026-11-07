use serde_json::json;

use super::*;
use crate::browser_automation::core::tests::{harness_with, tab_of, webview2_like, FakeEngine};
use crate::browser_automation::engine::events::TabEvent;
use crate::browser_automation::engine::observe::ConsoleLevel;

fn console(text: &str) -> ConsoleEntry {
    ConsoleEntry::new(ConsoleLevel::Warn, text, None)
}

fn texts(page: &LogPage) -> Vec<&str> {
    page.entries.iter().map(|e| e["text"].as_str().unwrap()).collect()
}

#[test]
fn pages_follow_the_cursor_and_report_eviction() {
    let mut log = ObservedLog::default();
    for i in 1..=3 {
        log.push(7, console(&format!("m{i}")));
    }
    let first = log.page(0, 2);
    assert_eq!((texts(&first), first.cursor, first.more, first.dropped), (vec!["m1", "m2"], 2, true, 0));
    assert_eq!(first.entries[0], json!({ "seq": 1, "epoch": 7, "level": "warn", "text": "m1" }));
    let rest = log.page(first.cursor, 50);
    assert_eq!((texts(&rest), rest.cursor, rest.more), (vec!["m3"], 3, false));
    let none = log.page(3, 50);
    assert_eq!((none.entries.len(), none.cursor, none.more), (0, 3, false));

    for i in 4..=(KEEP as u64 + 5) {
        log.push(8, console(&format!("m{i}")));
    }
    let late = log.page(3, 1);
    assert_eq!((texts(&late), late.cursor, late.dropped), (vec!["m6"], 6, 2));
    let past_end = log.page(10_000, 50);
    assert_eq!((past_end.entries.len(), past_end.cursor), (0, KEEP as u64 + 5));
}

#[test]
fn a_page_stops_at_its_byte_cap_but_always_carries_one_entry() {
    let mut log = ObservedLog::default();
    let big = "x".repeat(crate::browser_automation::engine::observe::TEXT_MAX);
    for _ in 0..40 {
        log.push(1, console(&big));
    }
    let page = log.page(0, LIMIT_MAX);
    let bytes: usize = page.entries.iter().map(|e| e.to_string().len()).sum();
    assert!(page.more && bytes <= PAGE_MAX_BYTES && page.entries.len() > 1, "{} entries", page.entries.len());
    assert_eq!(page.cursor, page.entries.len() as u64);
}

#[tokio::test]
async fn console_and_network_read_what_the_engine_published() {
    let h = harness_with(FakeEngine::new(webview2_like()));
    let tab = tab_of(&h.call_as("s1", "navigate", json!({ "url": "https://example.com/a" })).await);
    let events = h.pane.events(&tab);
    events.publish(TabEvent::Console(console("careful")));
    events.publish(TabEvent::Network(NetworkEntry {
        method: "GET".into(),
        url: "https://example.com/api".into(),
        status: Some(404),
        resource: Some("fetch".into()),
        duration_ms: Some(12),
        failed: false,
    }));
    h.settle_events().await;

    let reply = h.call_as("s1", "console", json!({})).await;
    assert_eq!(reply["page"]["console"], json!([{ "seq": 1, "epoch": 1, "level": "warn", "text": "careful" }]), "{reply}");
    assert_eq!(reply["data"], json!({ "cursor": 1, "more": false, "dropped": 0, "fidelity": "trusted" }));
    assert_eq!(reply["page"]["url"], "https://example.com/a");
    assert_eq!(reply.get("fidelity"), None);

    let again = h.call_as("s1", "console", json!({ "cursor": 1 })).await;
    assert_eq!(again["page"]["console"], json!([]));

    let net = h.call_as("s1", "network", json!({ "limit": "10" })).await;
    assert_eq!(
        net["page"]["network"],
        json!([{ "seq": 1, "epoch": 1, "method": "GET", "url": "https://example.com/api", "status": 404, "type": "fetch", "duration_ms": 12 }])
    );
    let bad = h.call_as("s1", "network", json!({ "limit": 0 })).await;
    assert_eq!((bad["code"].as_str(), bad["message"].as_str()), (Some("invalid_params"), Some("'limit' must be at least 1")));
}

#[tokio::test]
async fn a_page_shim_console_is_pulled_on_read_and_reported_synthetic() {
    let engine = FakeEngine::new(webview2_like().with(CapabilityId::ConsoleObserve, Support::Synthetic));
    engine.console_shim.lock().push(console("from the shim"));
    let h = harness_with(engine);
    h.call_as("s1", "navigate", json!({ "url": "https://example.com/a" })).await;
    let reply = h.call_as("s1", "console", json!({})).await;
    assert_eq!(reply["page"]["console"][0]["text"], "from the shim", "{reply}");
    assert_eq!(reply["data"]["fidelity"], "synthetic");
    let again = h.call_as("s1", "console", json!({ "cursor": 1 })).await;
    assert_eq!(again["page"]["console"], json!([]));
}

#[tokio::test]
async fn an_engine_without_the_capability_withdraws_the_verb() {
    let table = webview2_like().with(CapabilityId::NetworkObserve, Support::Unavailable("no network hook here"));
    let h = harness_with(FakeEngine::new(table));
    h.call_as("s1", "navigate", json!({ "url": "https://example.com/a" })).await;
    let reply = h.call_as("s1", "network", json!({})).await;
    assert_eq!(
        (reply["code"].as_str(), reply["reason"].as_str()),
        (Some("capability_unavailable"), Some("network_observe"))
    );
}

#[tokio::test]
async fn entries_belong_to_their_tab() {
    let h = harness_with(FakeEngine::new(webview2_like()));
    let a = tab_of(&h.call_as("s1", "navigate", json!({ "url": "https://example.com/a" })).await);
    let b = tab_of(&h.call_as("s1", "new_tab", json!({ "url": "https://example.com/b" })).await);
    h.pane.events(&a).publish(TabEvent::Console(console("only in a")));
    h.settle_events().await;
    let on_b = h.call_as("s1", "console", json!({ "tabId": b })).await;
    assert_eq!(on_b["page"]["console"], json!([]));
    let other = h.call_as("s2", "console", json!({ "tabId": a })).await;
    assert_eq!(other["code"], "tab_not_found");
}
