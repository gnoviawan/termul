use std::sync::Arc;

use serde_json::json;
use tauri::Url;

use super::*;
use crate::browser_automation::core::authz::HopVerdict;
use crate::browser_automation::core::ports::{ConsentOption, TicketOutcome};
use crate::acp::browser_policy::{BrowserPolicyService, CallerScope, LateProfileControl};
use crate::browser_automation::core::test_support::ScriptedPermissions;
use crate::browser_automation::core::tests::{
    harness_parts, tab_of, webview2_like, FakeEngine, Harness,
};
use crate::browser_automation::core::HostServices;

/// A host whose sessions are `<project>:<n>`, on a file-backed policy
/// service wired to the host's profile control as the app wires it.
struct ProfileHarness {
    h: Harness,
    permissions: Arc<ScriptedPermissions>,
    policy: Arc<BrowserPolicyService>,
    _policy_root: tempfile::TempDir,
}

fn profile_harness(engine_profile: Support) -> ProfileHarness {
    let policy_root = tempfile::tempdir().unwrap();
    let control = Arc::new(LateProfileControl::default());
    let policy = Arc::new(BrowserPolicyService::new(
        policy_root.path().to_path_buf(),
        Arc::new(Vec::new),
        Vec::new(),
        control.clone(),
    ));
    let permissions = Arc::new(ScriptedPermissions::answering([TicketOutcome::Answered(
        ConsentOption::AllowSession,
    )]));
    let services = HostServices {
        permissions: permissions.clone(),
        policy: policy.clone(),
        project_of: Arc::new(|session: &str| session.split(':').next().unwrap_or("").to_string()),
        root_of: Arc::new(|_| None),
    };
    let h = harness_parts(
        FakeEngine::new(webview2_like()),
        false,
        services,
        engine_profile,
    );
    control.attach(h.host.profile_control());
    ProfileHarness {
        h,
        permissions,
        policy,
        _policy_root: policy_root,
    }
}

impl ProfileHarness {
    /// Open an agent tab on a loopback page (no consent needed); returns
    /// its label and the profile the reply reports.
    async fn open(&self, session: &str) -> (String, String) {
        let reply = self
            .h
            .call_as(
                session,
                "new_tab",
                json!({ "url": "http://127.0.0.1:4321/" }),
            )
            .await;
        assert_eq!(reply["ok"], true, "{reply}");
        (
            tab_of(&reply),
            reply["tab"]["profile"].as_str().unwrap().to_string(),
        )
    }

    fn store_of(&self, label: &str) -> DataStore {
        self.h
            .pane
            .stores
            .lock()
            .get(label)
            .cloned()
            .expect("tab was built")
    }

    async fn project_op(&self, project: &str, op: serde_json::Value) {
        let revision = self
            .policy
            .project_view(&CallerScope::App, project)
            .await
            .unwrap()
            .revision;
        self.policy
            .apply_project(&CallerScope::App, project, revision, &op)
            .await
            .unwrap();
    }

    async fn app_op(&self, op: serde_json::Value) -> crate::acp::browser_policy::AppPolicyView {
        let revision = self
            .policy
            .app_view(&CallerScope::App)
            .await
            .unwrap()
            .revision;
        self.policy
            .apply_app(&CallerScope::App, revision, &op)
            .await
            .unwrap()
    }

    /// Wait for a reconcile the policy service started in the background.
    async fn settle(&self) {
        for _ in 0..8 {
            self.h.settle_events().await;
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    }
}

#[test]
fn a_session_binds_the_requested_profile_but_never_widens() {
    use TabProfile::{Ephemeral, Global};
    assert_eq!(bind(None, Global), Global);
    assert_eq!(bind(None, Ephemeral), Ephemeral);
    assert_eq!(bind(Some(Global), Global), Global);
    assert_eq!(
        bind(Some(Ephemeral), Global),
        Ephemeral,
        "opting back in waits for the next session"
    );
    assert_eq!(
        bind(Some(Global), Ephemeral),
        Ephemeral,
        "a narrowing applies to the next tab"
    );
}

#[tokio::test]
async fn sessions_of_every_project_share_the_global_profile_by_default() {
    let p = profile_harness(Support::Trusted);
    let (a, a_profile) = p.open("projA:1").await;
    let (b, b_profile) = p.open("projB:1").await;
    assert_eq!(
        (a_profile.as_str(), b_profile.as_str()),
        ("global", "global")
    );
    assert_eq!(p.store_of(&a), DataStore::Global);
    assert_eq!(p.store_of(&b), DataStore::Global);
}

#[tokio::test]
async fn an_opted_out_project_runs_ephemeral_in_its_session_directory_under_app_data() {
    let p = profile_harness(Support::Trusted);
    p.project_op("projA", json!({ "op": "set_ephemeral", "ephemeral": true }))
        .await;
    let (a, a_profile) = p.open("projA:../../escape").await;
    let (b, b_profile) = p.open("projB:1").await;
    assert_eq!(
        (a_profile.as_str(), b_profile.as_str()),
        ("ephemeral", "global")
    );
    let DataStore::Ephemeral { dir } = p.store_of(&a) else {
        panic!("opted-out tab built on {:?}", p.store_of(&a));
    };
    assert_eq!(
        dir,
        super::super::session_dir(&p.h.pane.sessions, "projA:../../escape").join("profile")
    );
    assert!(
        dir.starts_with(&p.h.pane.sessions),
        "never outside the app's session root"
    );
    assert_eq!(p.store_of(&b), DataStore::Global);

    let view = p
        .policy
        .project_view(&CallerScope::App, "projA")
        .await
        .unwrap();
    assert_eq!(
        (view.profile_mode, view.effective_profile_mode),
        (ProfileMode::Ephemeral, ProfileMode::Ephemeral)
    );
}

#[tokio::test]
async fn the_global_switch_off_makes_every_session_ephemeral() {
    let p = profile_harness(Support::Trusted);
    p.app_op(json!({ "op": "set_global_profile", "enabled": false }))
        .await;
    let (_, a) = p.open("projA:1").await;
    let (_, b) = p.open("projB:1").await;
    assert_eq!((a.as_str(), b.as_str()), ("ephemeral", "ephemeral"));
}

#[tokio::test]
async fn an_engine_without_named_profiles_runs_ephemeral_and_settings_say_so() {
    let p = profile_harness(Support::Unavailable("macos_version"));
    let (label, profile) = p.open("projA:1").await;
    assert_eq!(
        profile, "ephemeral",
        "no call fails because of the fallback"
    );
    assert!(matches!(p.store_of(&label), DataStore::Ephemeral { .. }));

    let app = p.policy.app_view(&CallerScope::App).await.unwrap();
    assert_eq!(
        (app.global_profile_enabled, app.effective_global_profile),
        (true, false)
    );
    let project = p
        .policy
        .project_view(&CallerScope::App, "projA")
        .await
        .unwrap();
    assert_eq!(
        (project.profile_mode, project.effective_profile_mode),
        (ProfileMode::Global, ProfileMode::Ephemeral)
    );
}

#[tokio::test]
async fn opting_out_closes_that_project_s_global_tabs_and_its_next_tab_is_ephemeral() {
    let p = profile_harness(Support::Trusted);
    let (a, _) = p.open("projA:1").await;
    let (b, _) = p.open("projB:1").await;

    p.project_op("projA", json!({ "op": "set_ephemeral", "ephemeral": true }))
        .await;
    p.settle().await;
    assert_eq!(*p.h.pane.closes.lock(), [format!("close {a} dir=false")]);
    assert!(
        p.h.host.registry.lock().get(&b).is_some(),
        "the other project keeps its tab"
    );

    let (_, next) = p.open("projA:1").await;
    assert_eq!(next, "ephemeral");
}

#[tokio::test]
async fn opting_out_revokes_the_session_s_origin_grants_and_withdraws_its_tickets() {
    let p = profile_harness(Support::Trusted);
    let reply = p
        .h
        .call_as(
            "projA:1",
            "new_tab",
            json!({ "url": "https://news.example.org/" }),
        )
        .await;
    assert_eq!(reply["ok"], true, "{reply}");
    let origin = Url::parse("https://news.example.org/").unwrap();
    assert!(matches!(
        p.h.host.gate.check_hop("projA:1", &origin),
        HopVerdict::Allow
    ));
    let (kept, _) = p.open("projB:1").await;

    p.project_op("projA", json!({ "op": "set_ephemeral", "ephemeral": true }))
        .await;
    p.settle().await;

    assert!(matches!(
        p.h.host.gate.check_hop("projA:1", &origin),
        HopVerdict::Ungranted(..)
    ));
    assert_eq!(*p.permissions.cancelled_sessions.lock(), ["projA:1"]);
    assert!(p.h.host.registry.lock().get(&kept).is_some());
}

#[tokio::test]
async fn clearing_tears_down_every_global_tab_then_wipes_and_reports_the_impact() {
    let p = profile_harness(Support::Trusted);
    p.project_op("projC", json!({ "op": "set_ephemeral", "ephemeral": true }))
        .await;
    let (a, _) = p.open("projA:1").await;
    let (b, _) = p.open("projB:1").await;
    let (c, _) = p.open("projC:1").await;
    let impact = p
        .policy
        .app_view(&CallerScope::App)
        .await
        .unwrap()
        .clear_impact;
    assert_eq!((impact.sessions, impact.projects), (2, 2));

    let view = p.app_op(json!({ "op": "clear_global_profile" })).await;
    assert_eq!(
        (view.clear_impact.sessions, view.clear_impact.projects),
        (0, 0)
    );
    let mut closes = p.h.pane.closes.lock().clone();
    let wipe = closes.pop();
    closes.sort();
    let mut expected = vec![
        format!("close {a} dir=false"),
        format!("close {b} dir=false"),
    ];
    expected.sort();
    assert_eq!(closes, expected, "both global tabs closed first");
    assert_eq!(
        wipe.as_deref(),
        Some("wipe open=1"),
        "then the wipe, with only the ephemeral tab open"
    );
    assert!(
        p.h.host.registry.lock().get(&c).is_some(),
        "the ephemeral tab stays"
    );

    let (_, again) = p.open("projA:1").await;
    assert_eq!(again, "global", "the cleared profile is in use again");
}

#[test]
fn while_clearing_no_tab_binds_global_and_waiting_global_tabs_are_withdrawn() {
    use crate::browser_automation::core::tabs::{BindRefusal, TabRegistry};
    const WAITING: &str = "agent-0b7c2d1e-5f60-4a1b-9c2d-3e4f5a6b7c8d";
    const LATE: &str = "agent-1c8d3e2f-6071-4b2c-8d3e-4f5a6b7c8d9e";
    let mut registry = TabRegistry::default();
    let mut waiting = registry
        .expect_agent_tab(WAITING, "s1", "https://example.com/", TabProfile::Global)
        .unwrap();
    assert_eq!(registry.global_lease(), 1);

    registry.set_global_clearing(true);
    assert_eq!(
        waiting.try_recv().unwrap().err().as_deref(),
        Some("the agent browser profile is being cleared")
    );
    assert_eq!(registry.global_lease(), 0);
    assert_eq!(
        registry
            .expect_agent_tab(LATE, "s2", "https://example.com/", TabProfile::Global)
            .err(),
        Some(BindRefusal::GlobalClearing)
    );
    assert!(registry
        .expect_agent_tab(LATE, "s3", "https://example.com/", TabProfile::Ephemeral)
        .is_ok());

    registry.set_global_clearing(false);
    assert!(registry
        .expect_agent_tab(WAITING, "s4", "https://example.com/", TabProfile::Global)
        .is_ok());
}
