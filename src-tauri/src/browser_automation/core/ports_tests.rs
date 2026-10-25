use std::sync::Arc;

use super::*;
use crate::acp::browser_policy::test_support::fixture;
use crate::acp::browser_policy::OriginPattern;
use crate::browser_automation::core::test_support::InMemoryPolicyStore;

#[test]
fn consent_options_map_to_acp_kinds_and_scope_markers() {
    let mapped: Vec<_> = ConsentOption::ALL
        .iter()
        .map(|o| (o.acp_kind(), o.scope()))
        .collect();
    assert_eq!(
        mapped,
        [
            ("allow_once", Some("session")),
            ("allow_always", Some("project")),
            ("reject_once", None),
        ]
    );
}

#[test]
fn ticket_ids_are_host_namespaced_uuids() {
    let id = TicketId::mint();
    assert!(id.as_str().starts_with("host:"));
    assert_eq!(TicketId::parse(id.as_str()), Some(id));
    for bad in ["host:", "host:nope", "q-123", "8f1c0f3e-8a51-4c4e-9a52-0d0f3b1f6a10"] {
        assert_eq!(TicketId::parse(bad), None, "{bad}");
    }
}

fn pattern(text: &str) -> OriginPattern {
    OriginPattern::parse(text).unwrap_or_else(|e| panic!("{text}: {e:?}"))
}

/// What the core relies on from any policy store: a fresh scope reads as
/// the defaults, an edit lands with a revision bump, a re-applied edit
/// changes nothing, and a stale revision loses with the current one.
async fn policy_store_contract(store: &dyn PolicyStore) {
    let add = || ProjectPolicyOp::AddOrigin(pattern("https://*.example.com"));
    assert_eq!(store.project("p1").await.unwrap(), ProjectPolicy::default());

    let first = store.apply_project("p1", 0, add()).await.expect("fresh write");
    assert_eq!((first.revision, first.allow_list.len()), (1, 1));
    assert_eq!(store.project("p1").await.unwrap(), first);
    assert_eq!(store.project("p2").await.unwrap(), ProjectPolicy::default());

    let again = store.apply_project("p1", 1, add()).await.expect("idempotent re-apply");
    assert_eq!(again, first, "no content change means no revision bump");
    assert_eq!(
        store.apply_project("p1", 0, add()).await,
        Err(PolicyRefusal::RevisionConflict { current: 1 }),
        "a stale revision loses instead of overwriting"
    );

    let app = store
        .apply_app(0, AppPolicyOp::SetGlobalProfile(false))
        .await
        .expect("app write");
    assert_eq!((app.revision, app.global_profile_enabled), (1, false));
    assert_eq!(store.app().await.unwrap(), app);
    assert_eq!(
        store.apply_app(0, AppPolicyOp::SetGlobalProfile(true)).await,
        Err(PolicyRefusal::RevisionConflict { current: 1 })
    );
}

#[tokio::test]
async fn the_policy_service_honours_the_policy_store_contract() {
    let root = tempfile::tempdir().expect("temp dir");
    let service = fixture(root.path(), Vec::new()).service;
    let store: Arc<dyn PolicyStore> = service;
    policy_store_contract(store.as_ref()).await;
}

#[tokio::test]
async fn the_in_memory_test_store_honours_the_same_contract() {
    policy_store_contract(&InMemoryPolicyStore::default()).await;
}
