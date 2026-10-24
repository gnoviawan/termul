use std::sync::atomic::Ordering;

use serde_json::{json, Value};

use crate::acp::browser_policy::test_support::{fixture, fixture_with_profile, ScriptedProfile};
use crate::acp::browser_policy::{
    ActionClass, AppPolicy, AppPolicyView, BrowserPolicyService, CallerScope, CanonicalOrigin,
    OriginPattern, PolicyRefusal, Preapproval, PreapprovalView, ProfileMode, ProjectPolicy,
    ProjectPolicyOp, ProjectPolicyView, UnwiredProfileControl,
};

const EVENT: &str = "acp:browser_policy_changed";

fn project_caller() -> CallerScope {
    CallerScope::Project("p1".to_string())
}

async fn project_op(service: &BrowserPolicyService, revision: u64, op: Value) -> ProjectPolicyView {
    service
        .apply_project(&CallerScope::App, "p1", revision, &op)
        .await
        .unwrap_or_else(|refusal| panic!("{op}: {refusal:?}"))
}

async fn app_op(service: &BrowserPolicyService, revision: u64, op: Value) -> AppPolicyView {
    service
        .apply_app(&CallerScope::App, revision, &op)
        .await
        .unwrap_or_else(|refusal| panic!("{op}: {refusal:?}"))
}

#[tokio::test]
async fn every_project_operation_edits_the_policy() {
    let dir = tempfile::tempdir().unwrap();
    let f = fixture(dir.path(), vec![]);
    let s = &f.service;

    let view = project_op(
        s,
        0,
        json!({"op": "add_origin", "origin": "https://example.com"}),
    )
    .await;
    assert_eq!(
        (view.revision, view.allow_list.clone()),
        (1, vec!["https://example.com".to_string()])
    );

    let view = project_op(
        s,
        1,
        json!({"op": "add_origin", "origin": "https://*.example.org"}),
    )
    .await;
    assert_eq!(
        view.allow_list,
        ["https://example.com", "https://*.example.org"]
    );

    let view = project_op(
        s,
        2,
        json!({"op": "add_preapproval", "action": "upload", "origin": "https://example.com"}),
    )
    .await;
    assert_eq!(
        view.preapprovals,
        [PreapprovalView {
            action: ActionClass::Upload,
            origin: "https://example.com".to_string()
        }]
    );

    let view = project_op(s, 3, json!({"op": "set_ephemeral", "ephemeral": true})).await;
    assert_eq!(view.profile_mode, ProfileMode::Ephemeral);

    let view = project_op(
        s,
        4,
        json!({"op": "remove_preapproval", "action": "upload", "origin": "https://example.com"}),
    )
    .await;
    assert!(view.preapprovals.is_empty());

    let view = project_op(
        s,
        5,
        json!({"op": "remove_origin", "origin": "https://example.com"}),
    )
    .await;
    assert_eq!(view.allow_list, ["https://*.example.org"]);

    let view = project_op(s, 6, json!({"op": "set_ephemeral", "ephemeral": false})).await;
    assert_eq!((view.revision, view.profile_mode), (7, ProfileMode::Global));
}

#[tokio::test]
async fn every_app_operation_edits_the_policy() {
    let dir = tempfile::tempdir().unwrap();
    let profile = ScriptedProfile::succeeding();
    let f = fixture_with_profile(dir.path(), vec![], profile.clone());
    let s = &f.service;

    assert!(
        s.app_view(&CallerScope::App)
            .await
            .unwrap()
            .global_profile_enabled
    );

    let view = app_op(s, 0, json!({"op": "set_global_profile", "enabled": false})).await;
    assert_eq!((view.revision, view.global_profile_enabled), (1, false));

    let view = app_op(
        s,
        1,
        json!({"op": "add_preapproval", "action": "download", "origin": "https://files.example"}),
    )
    .await;
    assert_eq!(view.preapprovals.len(), 1);

    let view = app_op(
        s,
        2,
        json!({"op": "remove_preapproval", "action": "download", "origin": "https://files.example"}),
    )
    .await;
    assert!(view.preapprovals.is_empty());

    let view = app_op(s, 3, json!({"op": "clear_global_profile"})).await;
    assert!(profile.cleared.load(Ordering::SeqCst));
    assert_eq!(
        view.revision, 3,
        "clearing the profile does not edit the policy file"
    );
    assert_eq!(
        (view.clear_impact.sessions, view.clear_impact.projects),
        (2, 1)
    );
}

#[tokio::test]
async fn clearing_the_profile_ignores_a_stale_revision() {
    let dir = tempfile::tempdir().unwrap();
    let f = fixture_with_profile(dir.path(), vec![], ScriptedProfile::succeeding());
    app_op(
        &f.service,
        0,
        json!({"op": "set_global_profile", "enabled": false}),
    )
    .await;
    app_op(&f.service, 99, json!({"op": "clear_global_profile"})).await;
}

#[tokio::test]
async fn clearing_without_an_engine_is_refused_honestly() {
    let dir = tempfile::tempdir().unwrap();
    let f = fixture(dir.path(), vec![]);
    let refusal = f
        .service
        .apply_app(&CallerScope::App, 0, &json!({"op": "clear_global_profile"}))
        .await
        .unwrap_err();
    assert_eq!(refusal, PolicyRefusal::ProfileEngineUnavailable);
    assert_eq!(refusal.code().as_str(), "capability_unavailable");
    assert!(f.sink.payloads_of(EVENT).is_empty());
}

#[tokio::test]
async fn a_failed_clear_is_an_internal_error() {
    let dir = tempfile::tempdir().unwrap();
    let f = fixture_with_profile(dir.path(), vec![], ScriptedProfile::failing());
    let refusal = f
        .service
        .apply_app(&CallerScope::App, 0, &json!({"op": "clear_global_profile"}))
        .await
        .unwrap_err();
    assert_eq!(refusal.code().as_str(), "internal");
    assert_eq!(refusal.reason(), "profile_clear_failed");
}

#[tokio::test]
async fn a_stale_revision_is_rejected_and_the_retry_on_fresh_state_succeeds() {
    let dir = tempfile::tempdir().unwrap();
    let f = fixture(dir.path(), vec![]);
    let s = &f.service;
    project_op(
        s,
        0,
        json!({"op": "add_origin", "origin": "https://a.example"}),
    )
    .await;

    let stale = s
        .apply_project(
            &CallerScope::App,
            "p1",
            0,
            &json!({"op": "add_origin", "origin": "https://b.example"}),
        )
        .await
        .unwrap_err();
    assert_eq!(stale, PolicyRefusal::RevisionConflict { current: 1 });
    assert_eq!(stale.code().as_str(), "invalid_params");
    assert_eq!(stale.reason(), "revision_conflict");

    let fresh = s.project_view(&CallerScope::App, "p1").await.unwrap();
    let view = project_op(
        s,
        fresh.revision,
        json!({"op": "add_origin", "origin": "https://b.example"}),
    )
    .await;
    assert_eq!(view.allow_list, ["https://a.example", "https://b.example"]);
}

#[tokio::test]
async fn invalid_origins_are_refused_with_invalid_params() {
    let dir = tempfile::tempdir().unwrap();
    let f = fixture(dir.path(), vec![]);
    for origin in [
        "",
        "example.com",
        "ftp://example.com",
        "https://u:p@example.com",
        "*",
        "https://*.com",
        "https://a.*.example.com",
    ] {
        let refusal = f
            .service
            .apply_project(
                &CallerScope::App,
                "p1",
                0,
                &json!({"op": "add_origin", "origin": origin}),
            )
            .await
            .unwrap_err();
        assert_eq!(refusal.code().as_str(), "invalid_params", "{origin:?}");
        assert!(
            matches!(refusal.reason(), "invalid_origin" | "invalid_wildcard"),
            "{origin:?}: {}",
            refusal.reason()
        );
    }
    assert_eq!(
        f.service
            .project_view(&CallerScope::App, "p1")
            .await
            .unwrap()
            .revision,
        0
    );
}

#[tokio::test]
async fn termul_owned_origins_are_refused_everywhere_an_origin_is_added() {
    let dir = tempfile::tempdir().unwrap();
    let f = fixture(dir.path(), vec![4000]);
    for origin in [
        "http://localhost:4000",
        "http://127.0.0.1:4000",
        "http://tauri.localhost",
        "https://tauri.localhost",
        "http://ipc.localhost",
        "http://0.0.0.0:3000",
        "http://169.254.169.254",
        "http://metadata.google.internal",
    ] {
        let allow = f
            .service
            .apply_project(
                &CallerScope::App,
                "p1",
                0,
                &json!({"op": "add_origin", "origin": origin}),
            )
            .await
            .unwrap_err();
        assert_eq!(
            (allow.code().as_str(), allow.reason()),
            ("invalid_params", "reserved_origin"),
            "{origin}"
        );

        let project_preapproval = f
            .service
            .apply_project(
                &CallerScope::App,
                "p1",
                0,
                &json!({"op": "add_preapproval", "action": "upload", "origin": origin}),
            )
            .await
            .unwrap_err();
        assert_eq!(project_preapproval.reason(), "reserved_origin", "{origin}");

        let app_preapproval = f
            .service
            .apply_app(
                &CallerScope::App,
                0,
                &json!({"op": "add_preapproval", "action": "upload", "origin": origin}),
            )
            .await
            .unwrap_err();
        assert_eq!(app_preapproval.reason(), "reserved_origin", "{origin}");
    }
}

#[tokio::test]
async fn a_port_termul_starts_listening_on_later_is_refused_at_the_next_edit() {
    let dir = tempfile::tempdir().unwrap();
    let ports = std::sync::Arc::new(parking_lot::Mutex::new(Vec::<u16>::new()));
    let live = ports.clone();
    let service = BrowserPolicyService::new(
        dir.path().to_path_buf(),
        std::sync::Arc::new(move || live.lock().clone()),
        vec![],
        std::sync::Arc::new(UnwiredProfileControl),
    );
    let op = json!({"op": "add_origin", "origin": "http://localhost:5555"});
    service
        .apply_project(&CallerScope::App, "p1", 0, &op)
        .await
        .unwrap();

    ports.lock().push(5555);
    let refusal = service
        .apply_project(
            &CallerScope::App,
            "p1",
            1,
            &json!({"op": "add_origin", "origin": "http://127.0.0.1:5555"}),
        )
        .await
        .unwrap_err();
    assert_eq!(refusal.reason(), "reserved_origin");
}

#[tokio::test]
async fn global_tabs_may_pre_approve_password_submits_but_never_payment_submits() {
    let dir = tempfile::tempdir().unwrap();
    let f = fixture(dir.path(), vec![]);
    let refusal = f
        .service
        .apply_app(
            &CallerScope::App,
            0,
            &json!({"op": "add_preapproval", "action": "payment_submit", "origin": "https://shop.example"}),
        )
        .await
        .unwrap_err();
    assert_eq!(
        (refusal.code().as_str(), refusal.reason()),
        ("invalid_params", "preapproval_not_allowed")
    );
    let app = f
        .service
        .apply_app(
            &CallerScope::App,
            0,
            &json!({"op": "add_preapproval", "action": "password_submit", "origin": "https://bank.example"}),
        )
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(&app.preapprovals).unwrap(),
        json!([{"action": "password_submit", "origin": "https://bank.example"}])
    );

    let mut policy = AppPolicy::default();
    let shop = CanonicalOrigin::parse("https://shop.example").unwrap();
    let bank = CanonicalOrigin::parse("https://bank.example").unwrap();
    for (action, origin) in [
        (ActionClass::PaymentSubmit, &shop),
        (ActionClass::PasswordSubmit, &bank),
    ] {
        policy.preapprovals.push(Preapproval {
            action,
            origin: origin.clone(),
        });
    }
    assert_eq!(
        (
            policy.preapproves(ActionClass::PaymentSubmit, &shop),
            policy.preapproves(ActionClass::PasswordSubmit, &bank)
        ),
        (false, true),
        "a stored payment entry never grants"
    );
}

#[tokio::test]
async fn asking_before_password_submits_is_an_app_switch_that_starts_off() {
    let dir = tempfile::tempdir().unwrap();
    let f = fixture(dir.path(), vec![]);
    let set = |revision: u64, enabled: bool| {
        let service = f.service.clone();
        async move {
            service
                .apply_app(
                    &CallerScope::App,
                    revision,
                    &json!({"op": "set_ask_before_password_submit", "enabled": enabled}),
                )
                .await
        }
    };
    let initial = f.service.app_view(&CallerScope::App).await.unwrap();
    let on = set(0, true).await.unwrap();
    let stale = set(0, false).await.unwrap_err();
    let off = set(1, false).await.unwrap();
    assert_eq!(
        (
            initial.ask_before_password_submit,
            on.ask_before_password_submit,
            on.revision,
            stale,
            off.ask_before_password_submit,
            off.revision,
        ),
        (false, true, 1, PolicyRefusal::RevisionConflict { current: 1 }, false, 2)
    );
    assert!(!f.service.app_policy().await.unwrap().ask_before_password_submit);
    assert_eq!(f.sink.payloads_of("acp:browser_policy_changed").len(), 2);
}

#[tokio::test]
async fn project_pre_approvals_cover_credential_submits_for_ephemeral_tabs_only() {
    let dir = tempfile::tempdir().unwrap();
    let f = fixture(dir.path(), vec![]);
    let view = project_op(
        &f.service,
        0,
        json!({"op": "add_preapproval", "action": "password_submit", "origin": "https://login.example"}),
    )
    .await;
    assert_eq!(view.preapprovals.len(), 1);

    for action in ["navigate", "local_network"] {
        let refusal = f
            .service
            .apply_project(
                &CallerScope::App,
                "p1",
                1,
                &json!({"op": "add_preapproval", "action": action, "origin": "https://x.example"}),
            )
            .await
            .unwrap_err();
        assert_eq!(refusal.reason(), "preapproval_not_allowed", "{action}");
    }
}

#[tokio::test]
async fn a_project_bound_client_is_refused_app_level_operations() {
    let dir = tempfile::tempdir().unwrap();
    let f = fixture_with_profile(dir.path(), vec![], ScriptedProfile::succeeding());
    let bound = project_caller();

    let ops = [
        json!({"op": "set_global_profile", "enabled": false}),
        json!({"op": "add_preapproval", "action": "upload", "origin": "https://x.example"}),
        json!({"op": "remove_preapproval", "action": "upload", "origin": "https://x.example"}),
        json!({"op": "clear_global_profile"}),
    ];
    for op in ops {
        let refusal = f.service.apply_app(&bound, 0, &op).await.unwrap_err();
        assert_eq!(
            (refusal.code().as_str(), refusal.reason()),
            ("invalid_params", "app_scope_required"),
            "{op}"
        );
    }
    let read = f.service.app_view(&bound).await.unwrap_err();
    assert_eq!(read.reason(), "app_scope_required");
    assert_eq!(
        f.service
            .app_view(&CallerScope::App)
            .await
            .unwrap()
            .revision,
        0
    );
}

#[tokio::test]
async fn a_project_bound_client_edits_only_its_own_project() {
    let dir = tempfile::tempdir().unwrap();
    let f = fixture(dir.path(), vec![]);
    let bound = project_caller();
    let op = json!({"op": "add_origin", "origin": "https://example.com"});

    let view = f.service.apply_project(&bound, "p1", 0, &op).await.unwrap();
    assert_eq!(view.revision, 1);
    assert_eq!(
        f.service
            .apply_project(&bound, "p2", 0, &op)
            .await
            .unwrap_err()
            .reason(),
        "project_scope_mismatch"
    );
    assert_eq!(
        f.service
            .project_view(&bound, "p2")
            .await
            .unwrap_err()
            .reason(),
        "project_scope_mismatch"
    );
}

#[tokio::test]
async fn unrecognized_operations_are_malformed() {
    let dir = tempfile::tempdir().unwrap();
    let f = fixture(dir.path(), vec![]);
    for op in [
        json!(null),
        json!({}),
        json!({"op": "drop_database"}),
        json!({"op": "add_origin"}),
        json!({"op": "add_origin", "origin": "https://a.example", "extra": 1}),
        json!({"op": "set_ephemeral", "ephemeral": "yes"}),
        json!({"op": "add_preapproval", "action": "teleport", "origin": "https://a.example"}),
        json!({"op": "set_global_profile", "enabled": true}),
    ] {
        let refusal = f
            .service
            .apply_project(&CallerScope::App, "p1", 0, &op)
            .await
            .unwrap_err();
        assert_eq!(refusal.reason(), "malformed_operation", "{op}");
    }
}

#[tokio::test]
async fn policy_lists_are_bounded() {
    let mut policy = ProjectPolicy::default();
    for n in 0..crate::acp::browser_policy::model::MAX_ALLOW_LIST {
        let pattern = OriginPattern::parse(&format!("https://site{n}.example")).unwrap();
        policy.apply(ProjectPolicyOp::AddOrigin(pattern)).unwrap();
    }
    let overflow = OriginPattern::parse("https://one-too-many.example").unwrap();
    assert_eq!(
        policy
            .apply(ProjectPolicyOp::AddOrigin(overflow))
            .unwrap_err(),
        PolicyRefusal::LimitExceeded
    );
}

#[tokio::test]
async fn a_change_is_announced_to_every_sink_and_a_no_op_is_not() {
    let dir = tempfile::tempdir().unwrap();
    let f = fixture(dir.path(), vec![]);
    let s = &f.service;

    project_op(
        s,
        0,
        json!({"op": "add_origin", "origin": "https://example.com"}),
    )
    .await;
    project_op(
        s,
        1,
        json!({"op": "add_origin", "origin": "https://example.com"}),
    )
    .await;
    app_op(s, 0, json!({"op": "set_global_profile", "enabled": false})).await;

    assert_eq!(
        f.sink.payloads_of(EVENT),
        [
            json!({"scope": "project", "projectId": "p1", "revision": 1}),
            json!({"scope": "app", "revision": 1}),
        ]
    );
}

#[tokio::test]
async fn a_refused_edit_is_not_announced() {
    let dir = tempfile::tempdir().unwrap();
    let f = fixture(dir.path(), vec![]);
    let _ = f
        .service
        .apply_project(
            &CallerScope::App,
            "p1",
            5,
            &json!({"op": "add_origin", "origin": "https://a.example"}),
        )
        .await;
    assert!(f.sink.payloads_of(EVENT).is_empty());
}

#[tokio::test]
async fn projects_are_independent_of_each_other_and_of_the_app_scope() {
    let dir = tempfile::tempdir().unwrap();
    let f = fixture(dir.path(), vec![]);
    let s = &f.service;
    project_op(
        s,
        0,
        json!({"op": "add_origin", "origin": "https://example.com"}),
    )
    .await;
    assert!(s
        .project_view(&CallerScope::App, "p2")
        .await
        .unwrap()
        .allow_list
        .is_empty());
    assert_eq!(s.app_view(&CallerScope::App).await.unwrap().revision, 0);
}

#[tokio::test]
async fn the_engine_reads_typed_policies_through_the_same_store() {
    let dir = tempfile::tempdir().unwrap();
    let f = fixture(dir.path(), vec![]);
    project_op(
        &f.service,
        0,
        json!({"op": "add_origin", "origin": "https://*.example.com"}),
    )
    .await;
    let policy = f.service.project_policy("p1").await.unwrap();
    assert!(policy.allows(&CanonicalOrigin::parse("https://api.example.com").unwrap()));
    assert!(!policy.allows(&CanonicalOrigin::parse("https://example.com").unwrap()));
}
