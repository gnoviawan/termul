use serde_json::{json, Value};

use super::*;

fn trusted_drag() -> CapabilityTable {
    webview2_like().with(CapabilityId::Drag, Support::Trusted)
}

async fn two_buttons(table: CapabilityTable) -> Harness {
    let mut engine = FakeEngine::new(table);
    engine.snapshot_buttons = vec!["Sign in", "Register"];
    let h = harness_with(engine);
    h.call("navigate", json!({ "url": "https://example.com" })).await;
    h.call("snapshot", json!({})).await;
    h
}

fn failure(reply: &Value) -> (Option<&str>, Option<&str>) {
    (reply["code"].as_str(), reply["reason"].as_str())
}

#[tokio::test]
async fn a_trusted_drag_presses_on_the_source_and_releases_on_the_target() {
    let h = two_buttons(trusted_drag()).await;
    let reply = h.call("drag", json!({ "ref": "@e1", "toRef": "@e2" })).await;
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(reply["fidelity"], "trusted", "{reply}");
    assert_eq!(h.engine.drags.lock().as_slice(), ["(12, 34) -> (112, 34)"]);
    assert!(h.engine.clicks.lock().is_empty());
}

#[tokio::test]
async fn a_synthetic_drag_runs_the_page_helper_and_says_synthetic() {
    let h = two_buttons(webview2_like().with(CapabilityId::Drag, Support::Synthetic)).await;
    let reply = h.call("drag", json!({ "ref": "@e2", "toRef": "@e1" })).await;
    assert_eq!(reply["fidelity"], "synthetic", "{reply}");
    assert_eq!(
        h.engine.drags.lock().as_slice(),
        ["script \"html>body>button:nth-of-type(2)\" -> \"html>body>button:nth-of-type(1)\""]
    );
}

#[tokio::test]
async fn an_engine_without_drag_refuses_it_and_does_not_list_it() {
    let h = two_buttons(webview2_like()).await;
    let reply = h.call("drag", json!({ "ref": "@e1", "toRef": "@e2" })).await;
    assert_eq!(failure(&reply), (Some("capability_unavailable"), Some("drag")), "{reply}");
    assert!(h.engine.drags.lock().is_empty());
    let schema = dispatch::schema(Some(h.engine.facts()));
    assert!(schema.description.contains("Not available on this host:"));
    assert!(!schema.description.contains("- drag"));
}

#[tokio::test(start_paused = true)]
async fn a_covered_or_disabled_source_times_out_and_nothing_is_dragged() {
    for (patch, reason) in [(json!({ "hit": false }), "covered"), (json!({ "enabled": false }), "disabled")] {
        let mut engine = FakeEngine::new(trusted_drag());
        engine.snapshot_buttons = vec!["Sign in", "Register"];
        engine.facts_patch = patch;
        let h = harness_with(engine);
        h.call("navigate", json!({ "url": "https://example.com" })).await;
        h.call("snapshot", json!({})).await;
        let reply = h.call("drag", json!({ "ref": "@e1", "toRef": "@e2" })).await;
        assert_eq!(failure(&reply), (Some("timeout"), Some(reason)), "{reply}");
        assert!(h.engine.drags.lock().is_empty());
    }
}

#[tokio::test]
async fn drag_needs_two_different_well_formed_refs() {
    let h = two_buttons(trusted_drag()).await;
    for (args, reason) in [
        (json!({ "ref": "@e1" }), None),
        (json!({ "ref": "@e1", "toRef": "e2" }), None),
        (json!({ "ref": "@e1", "toRef": "@e1" }), Some("same_ref")),
    ] {
        let reply = h.call("drag", args.clone()).await;
        assert_eq!(failure(&reply), (Some("invalid_params"), reason), "{args}: {reply}");
    }
    let stale = h.call("drag", json!({ "ref": "@e1", "toRef": "@e9" })).await;
    assert_eq!(stale["code"], "stale_ref", "{stale}");
    assert!(h.engine.drags.lock().is_empty());
}
