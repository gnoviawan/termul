use std::sync::Arc;

use super::*;
use crate::acp::browser_policy::model::{AppPolicyOp, ProjectPolicyOp};

fn files() -> (tempfile::TempDir, Arc<PolicyFiles>) {
    let dir = tempfile::tempdir().expect("temp dir");
    let files = Arc::new(PolicyFiles::new(dir.path().to_path_buf()));
    (dir, files)
}

fn add_origin(input: &str) -> ProjectPolicyOp {
    ProjectPolicyOp::AddOrigin(OriginPattern::parse(input).expect("valid pattern"))
}

#[tokio::test]
async fn a_missing_file_reads_as_the_default_policy() {
    let (_dir, files) = files();
    let project = files.read_project("p1").await.unwrap();
    assert_eq!(project, ProjectPolicy::default());
    assert_eq!(files.read_app().await.unwrap(), AppPolicy::default());
    assert!(AppPolicy::default().global_profile_enabled);
}

#[tokio::test]
async fn an_edit_persists_bumps_the_revision_and_stores_the_schema_version() {
    let (dir, files) = files();
    let (policy, changed) = files
        .edit_project("p1", 0, |p| p.apply(add_origin("https://Example.com:443")))
        .await
        .unwrap();
    assert!(changed);
    assert_eq!(policy.revision, 1);

    let reread = files.read_project("p1").await.unwrap();
    assert_eq!(reread.revision, 1);
    assert_eq!(reread.allow_list.len(), 1);
    assert_eq!(
        reread.allow_list[0].to_canonical_string(),
        "https://example.com"
    );

    let raw: serde_json::Value = serde_json::from_slice(
        &std::fs::read(dir.path().join("projects").join("p1.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(raw["version"], 1);
    assert_eq!(raw["allowList"][0], "https://example.com");
}

#[tokio::test]
async fn a_stale_revision_is_refused_with_the_current_one_and_changes_nothing() {
    let (_dir, files) = files();
    files
        .edit_project("p1", 0, |p| p.apply(add_origin("https://a.example")))
        .await
        .unwrap();
    let refusal = files
        .edit_project("p1", 0, |p| p.apply(add_origin("https://b.example")))
        .await
        .unwrap_err();
    assert_eq!(refusal, PolicyRefusal::RevisionConflict { current: 1 });
    assert_eq!(files.read_project("p1").await.unwrap().allow_list.len(), 1);
}

#[tokio::test]
async fn an_operation_that_changes_nothing_keeps_the_revision() {
    let (_dir, files) = files();
    files
        .edit_project("p1", 0, |p| p.apply(add_origin("https://a.example")))
        .await
        .unwrap();
    let (policy, changed) = files
        .edit_project("p1", 1, |p| p.apply(add_origin("https://a.example")))
        .await
        .unwrap();
    assert!(!changed);
    assert_eq!(policy.revision, 1);
    let (policy, changed) = files
        .edit_project("p1", 1, |p| p.apply(ProjectPolicyOp::SetEphemeral(false)))
        .await
        .unwrap();
    assert!(!changed);
    assert_eq!(policy.revision, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_edits_never_lose_an_update() {
    let (_dir, files) = files();
    let mut tasks = Vec::new();
    for n in 0..16 {
        let files = files.clone();
        tasks.push(tokio::spawn(async move {
            let origin = format!("https://site{n}.example");
            loop {
                let current = files.read_project("p1").await.unwrap();
                let edit = files
                    .edit_project("p1", current.revision, |p| p.apply(add_origin(&origin)))
                    .await;
                match edit {
                    Ok(_) => break,
                    Err(PolicyRefusal::RevisionConflict { .. }) => continue,
                    Err(other) => panic!("unexpected refusal {other:?}"),
                }
            }
        }));
    }
    for task in tasks {
        task.await.unwrap();
    }
    let policy = files.read_project("p1").await.unwrap();
    assert_eq!(policy.allow_list.len(), 16);
    assert_eq!(policy.revision, 16);
}

#[tokio::test]
async fn a_newer_schema_version_is_read_only_and_never_overwritten() {
    let (dir, files) = files();
    let path = dir.path().join("projects").join("p1.json");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let newer = br#"{"version":99,"revision":7,"allowList":["https://kept.example"],"profileMode":"ephemeral","futureField":{"x":1}}"#;
    std::fs::write(&path, newer).unwrap();

    let policy = files.read_project("p1").await.unwrap();
    assert!(policy.read_only);
    assert_eq!(policy.revision, 7);
    assert_eq!(policy.profile_mode, ProfileMode::Ephemeral);
    assert_eq!(policy.allow_list.len(), 1);

    let refusal = files
        .edit_project("p1", 7, |p| p.apply(add_origin("https://new.example")))
        .await
        .unwrap_err();
    assert_eq!(refusal, PolicyRefusal::ReadOnly);
    assert_eq!(std::fs::read(&path).unwrap(), newer);
}

#[tokio::test]
async fn a_newer_app_file_that_does_not_fit_is_read_only_without_the_global_profile() {
    let (dir, files) = files();
    let path = dir.path().join("app.json");
    let newer = br#"{"version":2,"globalProfileEnabled":"sometimes"}"#;
    std::fs::write(&path, newer).unwrap();

    let policy = files.read_app().await.unwrap();
    assert_eq!((policy.read_only, policy.global_profile_enabled), (true, false));
    assert_eq!(
        files
            .edit_app(0, |p| p.apply(AppPolicyOp::SetGlobalProfile(false)))
            .await
            .unwrap_err(),
        PolicyRefusal::ReadOnly
    );
    assert_eq!(std::fs::read(&path).unwrap(), newer);
}

#[tokio::test]
async fn an_unparseable_file_fails_closed_and_is_left_as_it_is() {
    let (dir, files) = files();
    let app_path = dir.path().join("app.json");
    let project_path = dir.path().join("projects").join("p1.json");
    std::fs::create_dir_all(project_path.parent().unwrap()).unwrap();
    std::fs::write(&app_path, b"{ not json").unwrap();
    std::fs::write(&project_path, br#"{"version":1,"profileMode":"ephemeral",}"#).unwrap();

    let app = files.read_app().await.unwrap();
    let project = files.read_project("p1").await.unwrap();
    assert_eq!(
        (
            app.read_only,
            app.global_profile_enabled,
            app.ask_before_password_submit,
            app.preapprovals.len()
        ),
        (true, false, true, 0)
    );
    assert_eq!(
        (project.read_only, project.profile_mode, project.allow_list.len()),
        (true, ProfileMode::Ephemeral, 0)
    );
    assert_eq!(
        files
            .edit_app(0, |p| p.apply(AppPolicyOp::SetGlobalProfile(true)))
            .await
            .unwrap_err(),
        PolicyRefusal::ReadOnly
    );
    assert_eq!(
        files
            .edit_project("p1", 0, |p| p.apply(ProjectPolicyOp::SetEphemeral(false)))
            .await
            .unwrap_err(),
        PolicyRefusal::ReadOnly
    );
    assert_eq!(std::fs::read(&app_path).unwrap(), b"{ not json");
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2, "no copies are written");
}

#[tokio::test]
async fn entries_a_scope_cannot_hold_are_dropped_on_load() {
    let (dir, files) = files();
    std::fs::write(
        dir.path().join("app.json"),
        br#"{"version":1,"revision":3,"globalProfileEnabled":false,"preapprovals":[
            {"action":"password_submit","origin":"https://bank.example"},
            {"action":"payment_submit","origin":"https://shop.example"},
            {"action":"navigate","origin":"https://nav.example"},
            {"action":"upload","origin":"https://ok.example"}]}"#,
    )
    .unwrap();

    let policy = files.read_app().await.unwrap();
    assert!(!policy.global_profile_enabled);
    let kept: Vec<ActionClass> = policy.preapprovals.iter().map(|p| p.action).collect();
    assert_eq!(kept, [ActionClass::PasswordSubmit, ActionClass::Upload]);
}

#[tokio::test]
async fn project_ids_that_could_escape_the_policy_directory_are_refused() {
    let (_dir, files) = files();
    for id in [
        "",
        "..",
        "../x",
        "a/b",
        "a\\b",
        "a.b",
        "p 1",
        &"x".repeat(129),
    ] {
        assert_eq!(
            files.read_project(id).await.unwrap_err(),
            PolicyRefusal::InvalidProjectId,
            "{id:?}"
        );
    }
    assert!(files.read_project("0b1f-4c_ID").await.is_ok());
}
