use serde_json::json;

use super::*;
use crate::acp::browser_policy::test_support::fixture;

#[test]
fn a_refusal_becomes_a_frozen_code_with_the_reason_leading_the_error() {
    let refused: IpcResult<()> = reply(Err(PolicyRefusal::RevisionConflict { current: 4 }));
    assert!(!refused.success);
    assert_eq!(refused.code.as_deref(), Some("invalid_params"));
    assert!(refused
        .error
        .as_deref()
        .is_some_and(|e| e.starts_with("revision_conflict: ") && e.contains("revision 4")));

    let unavailable: IpcResult<()> = reply(Err(PolicyRefusal::StoreUnavailable));
    assert_eq!(unavailable.code.as_deref(), Some("capability_unavailable"));

    let storage: IpcResult<()> = reply(Err(PolicyRefusal::Storage));
    assert_eq!(storage.code.as_deref(), Some("internal"));

    let ok = reply(Ok(7_u8));
    assert!(ok.success && ok.data == Some(7) && ok.error.is_none() && ok.code.is_none());
}

#[tokio::test]
async fn the_command_functions_edit_and_read_the_same_store() {
    let dir = tempfile::tempdir().unwrap();
    let f = fixture(dir.path(), vec![]);
    let op = json!({"op": "add_origin", "origin": "https://example.com"});

    let applied = apply_project_policy(&f.service, &CallerScope::App, "p1", 0, &op).await;
    assert_eq!(applied.data.as_ref().map(|v| v.revision), Some(1));

    let read = get_project_policy(&f.service, &CallerScope::App, "p1").await;
    assert_eq!(
        read.data.map(|v| v.allow_list),
        Some(vec!["https://example.com".to_string()])
    );

    let app = get_app_policy(&f.service, &CallerScope::App).await;
    assert_eq!(app.data.map(|v| v.global_profile_enabled), Some(true));
}
