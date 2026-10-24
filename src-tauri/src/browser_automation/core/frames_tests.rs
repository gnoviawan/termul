use std::sync::Arc;

use serde_json::{json, Value};

use crate::acp::browser_policy::OriginPattern;
use crate::browser_automation::core::ports::{
    ActionClass, PolicyStore, ProjectPolicyOp, TicketOutcome,
};
use crate::browser_automation::core::test_support::{InMemoryPolicyStore, ScriptedPermissions};
use crate::browser_automation::core::tests::{
    harness_parts, harness_with, webview2_like, FakeEngine, Harness,
};
use crate::browser_automation::core::HostServices;
use crate::browser_automation::engine::Support;
use crate::browser_automation::engine::assets::Script;
use crate::browser_automation::engine::{ChildFrame, EngineError, EngineErrorKind, InputMode, Point};

const PAYMENTS: &str = "html>body>iframe:nth-of-type(1)";
const PAY_URL: &str = "https://pay.example/widget";

/// The fake main outline, plus a reachable and an unreachable frame item
/// when the fake engine reaches frames.
pub(crate) fn with_frame_items(mut items: Vec<Value>, frames: bool) -> Vec<Value> {
    if frames {
        items.push(json!({ "kind": "frame", "depth": 0, "name": "Payments", "path": PAYMENTS }));
        items.push(json!({ "kind": "frame", "depth": 0, "name": "Ads", "path": "html>body>iframe:nth-of-type(2)" }));
    }
    items
}

/// What the fake engine answers inside a child frame.
pub(crate) fn answer_in_frame(known: bool, script: &Script) -> Result<Value, EngineError> {
    if !known {
        return Err(EngineError::new(EngineErrorKind::FrameGone));
    }
    Ok(match script.helper.name {
        "snapshot" => {
            assert_eq!(script.params["inFrame"], true, "frame paths must pin the frame's document");
            json!({
                "url": PAY_URL,
                "title": "Pay",
                "items": [
                    { "kind": "landmark", "depth": 0, "role": "form", "name": "" },
                    { "kind": "node", "depth": 1, "role": "button", "name": "Pay now", "path": "frame:1.5|html>body>button:nth-of-type(1)" }
                ],
                "capped": false
            })
        }
        "location" => json!(PAY_URL),
        "resolve" => json!({ "rect": { "cx": 5.0, "cy": 6.0 }, "role": "button", "name": "Pay now" }),
        "facts" => json!({
            "state": "present", "role": "button", "name": "Pay now", "x": 5.0, "y": 6.0,
            "visible": true, "stable": true, "hit": true, "enabled": true, "kind": "text",
            "focusOnClick": true
        }),
        _ => json!({ "ok": true }),
    })
}

fn payments_frame() -> ChildFrame {
    ChildFrame {
        id: "F-pay".into(),
        parent: None,
        owner_path: PAYMENTS.into(),
    }
}

/// The user allows the frame's origin for the session, as opening it in
/// a tab would ask.
async fn grant_pay(h: &Harness) {
    let reply = h.call_as("s1", "navigate", json!({ "url": "https://pay.example/" })).await;
    assert_eq!(reply["ok"], true, "{reply}");
}

fn ref_of(outline: &str, line_start: &str) -> String {
    let line = outline.lines().find(|l| l.trim_start().starts_with(line_start)).unwrap_or_else(|| panic!("{outline}"));
    line.split_whitespace().find(|w| w.starts_with("@e")).unwrap().to_string()
}

#[tokio::test]
async fn a_reachable_cross_origin_frame_is_spliced_in_and_its_refs_act_inside_it() {
    let engine = FakeEngine::new(webview2_like());
    engine.frames.lock().push(payments_frame());
    let h = harness_with(engine);
    grant_pay(&h).await;
    h.call_as("s1", "navigate", json!({ "url": "https://example.com/shop" })).await;
    let snap = h.call_as("s1", "snapshot", json!({})).await;
    let outline = snap["page"]["snapshot"].as_str().unwrap().to_string();
    assert_eq!(
        outline,
        [
            "- button \"Sign in\" @e1",
            "- iframe \"Payments\"",
            "  - form",
            "    - button \"Pay now\" @e2",
            "- iframe \"Ads\" (cross-origin frame, not readable on this engine)",
        ]
        .join("\n")
    );
    assert_eq!(snap["data"]["refs"], 2);

    let pay = ref_of(&outline, "- button \"Pay now\"");
    let click = h.call_as("s1", "click", json!({ "ref": pay })).await;
    assert_eq!((click["ok"].as_bool(), click["fidelity"].as_str()), (Some(true), Some("trusted")), "{click}");
    assert_eq!(*h.engine.clicks.lock(), [(Point { x: 105.0, y: 206.0 }, InputMode::Trusted)]);
    let fill = h.call_as("s1", "fill", json!({ "ref": pay, "value": "4111" })).await;
    assert_eq!(fill["ok"], true, "{fill}");
}

#[tokio::test]
async fn a_ref_into_a_frame_that_is_gone_is_stale() {
    let engine = FakeEngine::new(webview2_like());
    engine.frames.lock().push(payments_frame());
    let h = harness_with(engine);
    grant_pay(&h).await;
    h.call_as("s1", "navigate", json!({ "url": "https://example.com/shop" })).await;
    let snap = h.call_as("s1", "snapshot", json!({})).await;
    let pay = ref_of(snap["page"]["snapshot"].as_str().unwrap(), "- button \"Pay now\"");
    h.engine.frames.lock().clear();
    let click = h.call_as("s1", "click", json!({ "ref": pay })).await;
    assert_eq!((click["code"].as_str(), click["reason"].as_str()), (Some("stale_ref"), Some("frame_gone")), "{click}");
    assert!(h.engine.clicks.lock().is_empty(), "nothing may be clicked through a stale frame ref");
}

struct Gated {
    h: Harness,
    tickets: Arc<ScriptedPermissions>,
    policy: Arc<InMemoryPolicyStore>,
    _project: tempfile::TempDir,
}

/// A page with the payments frame whose user allowed only the page's own
/// origin and then left.
async fn gated() -> Gated {
    let engine = FakeEngine::new(webview2_like());
    engine.frames.lock().push(payments_frame());
    let tickets = Arc::new(ScriptedPermissions::answering([TicketOutcome::Answered(
        crate::browser_automation::core::ports::ConsentOption::AllowSession,
    )]));
    let policy = Arc::new(InMemoryPolicyStore::default());
    let project = tempfile::tempdir().unwrap();
    let root = project.path().to_path_buf();
    let services = HostServices {
        permissions: tickets.clone(),
        policy: policy.clone(),
        project_of: Arc::new(|_| "p1".to_string()),
        root_of: Arc::new(move |_| Some(root.clone())),
    };
    let h = harness_parts(engine, false, services, Support::Trusted);
    let opened = h.call_as("s1", "navigate", json!({ "url": "https://example.com/shop" })).await;
    assert_eq!(opened["ok"], true, "{opened}");
    Gated {
        h,
        tickets,
        policy,
        _project: project,
    }
}

impl Gated {
    async fn list(&self, op: fn(OriginPattern) -> ProjectPolicyOp) {
        let revision = self.policy.project("p1").await.unwrap().revision;
        let pattern = OriginPattern::parse("https://pay.example").unwrap();
        self.policy.apply_project("p1", revision, op(pattern)).await.unwrap();
    }

    fn tickets(&self) -> Vec<(ActionClass, String)> {
        let requests = self.tickets.requests.lock();
        requests.iter().map(|(t, _)| (t.action, t.origin.as_str().to_string())).collect()
    }
}

#[tokio::test]
async fn a_cross_origin_frame_the_session_may_not_reach_stays_unread_and_names_its_origin() {
    let g = gated().await;
    let snap = g.h.call_as("s1", "snapshot", json!({})).await;
    assert_eq!(
        snap["page"]["snapshot"],
        [
            "- button \"Sign in\" @e1",
            "- iframe \"Payments\" (cross-origin frame on https://pay.example, not authorized for this session)",
            "- iframe \"Ads\" (cross-origin frame, not readable on this engine)",
        ]
        .join("\n")
    );
    assert_eq!(snap["data"]["refs"], 1);
    assert_eq!(g.tickets().len(), 1, "reading a page never asks about its frames");
}

#[tokio::test]
async fn a_frame_ref_acts_only_while_its_frames_origin_is_authorized() {
    let g = gated().await;
    g.list(ProjectPolicyOp::AddOrigin).await;
    let snap = g.h.call_as("s1", "snapshot", json!({})).await;
    let pay = ref_of(snap["page"]["snapshot"].as_str().unwrap(), "- button \"Pay now\"");
    let click = g.h.call_as("s1", "click", json!({ "ref": pay })).await;
    assert_eq!(click["ok"], true, "{click}");

    g.list(ProjectPolicyOp::RemoveOrigin).await;
    let click = g.h.call_as("s1", "click", json!({ "ref": pay })).await;
    assert_eq!((click["code"].as_str(), click["reason"].as_str()), (Some("confirmation_required"), Some("unattended")), "{click}");
    assert_eq!(
        g.tickets().last().cloned(),
        Some((ActionClass::Navigate, "https://pay.example".to_string())),
        "the frame's origin is asked about like a navigation there"
    );
    assert_eq!(g.h.engine.clicks.lock().len(), 1, "the refused click never ran");
}

/// Keys without a ref go to whatever has focus. Inside a cross-origin
/// frame that is the frame's page, so its origin is authorized as a ref
/// minted there would be.
#[tokio::test]
async fn keys_to_a_focused_cross_origin_frame_need_the_frames_origin() {
    let g = gated().await;
    *g.h.engine.focused_frame.lock() = json!(PAYMENTS);
    let press = g.h.call_as("s1", "press", json!({ "key": "x" })).await;
    assert_eq!((press["code"].as_str(), press["reason"].as_str()), (Some("confirmation_required"), Some("unattended")), "{press}");
    assert_eq!(
        g.tickets().last().cloned(),
        Some((ActionClass::Navigate, "https://pay.example".to_string())),
        "the focused frame's origin is asked about like a navigation there"
    );

    g.list(ProjectPolicyOp::AddOrigin).await;
    let press = g.h.call_as("s1", "press", json!({ "key": "x" })).await;
    assert_eq!(press["ok"], true, "{press}");
}

#[tokio::test]
async fn keys_to_a_focused_frame_the_engine_cannot_reach_are_refused() {
    let engine = FakeEngine::new(webview2_like());
    *engine.focused_frame.lock() = json!("html>body>iframe:nth-of-type(2)");
    let h = harness_with(engine);
    h.call_as("s1", "navigate", json!({ "url": "https://example.com/shop" })).await;
    for (verb, args) in [("press", json!({ "key": "x" })), ("type", json!({ "text": "x" }))] {
        let reply = h.call_as("s1", verb, args).await;
        assert_eq!(
            (reply["code"].as_str(), reply["reason"].as_str()),
            (Some("capability_unavailable"), Some("focused_frame_unreachable")),
            "{verb}: {reply}"
        );
    }
}
