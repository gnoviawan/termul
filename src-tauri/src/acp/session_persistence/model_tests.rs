use agent_client_protocol::schema::v1::{
    SessionConfigOption, SessionConfigOptionCategory, SessionConfigSelectOption,
};
use serde_json::json;

use super::model::snapshot_from_record;
use super::*;
use crate::acp::events::{SessionModel, SessionModelState};

fn temp_dir(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "termul-sessions-model-{label}-{}-{}",
        std::process::id(),
        now_millis()
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

fn state(current: &str, models: &[(&str, &str)]) -> SessionModelState {
    SessionModelState {
        current_model_id: current.to_string(),
        available_models: models
            .iter()
            .map(|(id, name)| SessionModel {
                model_id: (*id).to_string(),
                name: (*name).to_string(),
                description: None,
            })
            .collect(),
    }
}

fn snapshot(id: &str, name: &str) -> SessionModelSnapshot {
    SessionModelSnapshot {
        model_id: id.to_string(),
        model_name: name.to_string(),
    }
}

fn model_option(current: &str) -> SessionConfigOption {
    SessionConfigOption::select(
        "model",
        "Model",
        current.to_string(),
        vec![
            SessionConfigSelectOption::new("m1", "Model One"),
            SessionConfigSelectOption::new("m2", "Model Two"),
        ],
    )
    .category(SessionConfigOptionCategory::Model)
}

fn config_update(seq: u64, options: Value) -> PersistedEventRecord {
    PersistedEventRecord {
        schema_version: SESSION_SCHEMA_VERSION,
        session_id: "session-1".to_string(),
        seq,
        type_: "config_options_update".to_string(),
        recorded_at: now_millis(),
        payload: json!({"agentId": "a", "sessionId": "session-1", "configOptions": options}),
    }
}

async fn open(root: &Path) -> Arc<SessionPersistence> {
    SessionPersistence::open(root.join("store")).await.unwrap()
}

async fn register(
    persistence: &SessionPersistence,
    root: &Path,
    model: Option<SessionModelSnapshot>,
) -> SessionMetadata {
    let cwd = root.join("cwd");
    fs::create_dir_all(&cwd).unwrap();
    persistence
        .register_session(SessionRegistration {
            session_id: "session-1".to_string(),
            stable_agent_namespace: Some("config:one".to_string()),
            runtime_agent_id: Some("runtime-1".to_string()),
            project_id: Some("project-1".to_string()),
            cwd,
            model,
            ..Default::default()
        })
        .await
        .unwrap()
}

fn listed(persistence: &SessionPersistence) -> (Option<String>, Option<String>) {
    let entry = persistence.list_sessions().remove(0);
    (entry.model_id, entry.model_name)
}

fn some_model(id: &str, name: &str) -> (Option<String>, Option<String>) {
    (Some(id.to_string()), Some(name.to_string()))
}

#[test]
fn snapshot_from_model_state_uses_matching_name_with_id_fallback() {
    let named = state("m2", &[("m1", "One"), ("m2", "Two")]);
    assert_eq!(
        model::snapshot_from_model_state(&named),
        snapshot("m2", "Two")
    );
    let unlisted = state("ghost", &[("m1", "One")]);
    assert_eq!(
        model::snapshot_from_model_state(&unlisted),
        snapshot("ghost", "ghost")
    );
    let blank = state("m1", &[("m1", "  ")]);
    assert_eq!(
        model::snapshot_from_model_state(&blank),
        snapshot("m1", "m1")
    );
}

#[tokio::test]
async fn create_records_model_and_no_models_leaves_fields_absent() {
    let root = temp_dir("create");
    let persistence = open(&root).await;
    let metadata = register(&persistence, &root, Some(snapshot("m1", "Model One"))).await;
    assert_eq!(metadata.model_id.as_deref(), Some("m1"));
    assert_eq!(metadata.model_name.as_deref(), Some("Model One"));
    assert_eq!(listed(&persistence), some_model("m1", "Model One"));

    let root = temp_dir("create-none");
    let persistence = open(&root).await;
    register(&persistence, &root, None).await;
    assert_eq!(listed(&persistence), (None, None));
    let json = serde_json::to_value(persistence.list_sessions().remove(0)).unwrap();
    assert!(json.get("modelId").is_none() && json.get("modelName").is_none());
}

#[tokio::test]
async fn ephemeral_stashed_registration_promotes_with_creation_model() {
    // The manager stashes the full registration (model included) on the driver
    // state; promotion later registers that same value.
    let root = temp_dir("promote");
    let persistence = open(&root).await;
    let stashed = SessionRegistration {
        session_id: "session-1".to_string(),
        cwd: root.join("cwd"),
        model: Some(snapshot("m2", "Model Two")),
        ..Default::default()
    };
    fs::create_dir_all(&stashed.cwd).unwrap();
    let promoted = persistence.register_session(stashed).await.unwrap();
    assert_eq!(promoted.model_id.as_deref(), Some("m2"));
    assert_eq!(promoted.model_name.as_deref(), Some("Model Two"));
}

#[tokio::test]
async fn durable_config_options_update_changes_model_and_survives_restart() {
    let root = temp_dir("change");
    let persistence = open(&root).await;
    register(&persistence, &root, Some(snapshot("m1", "Model One"))).await;
    persistence
        .enqueue_event(config_update(
            1,
            json!([serde_json::to_value(model_option("m2")).unwrap()]),
        ))
        .unwrap();
    persistence.flush_session("session-1").await.unwrap();
    assert_eq!(listed(&persistence), some_model("m2", "Model Two"));

    persistence.shutdown().await.unwrap();
    let reloaded = open(&root).await;
    assert_eq!(listed(&reloaded), some_model("m2", "Model Two"));
    let index: SessionIndexFile =
        serde_json::from_slice(&fs::read(root.join("store").join(INDEX_FILE)).unwrap()).unwrap();
    assert_eq!(index.sessions[0].model_id.as_deref(), Some("m2"));
    assert_eq!(index.sessions[0].model_name.as_deref(), Some("Model Two"));
}

#[tokio::test]
async fn config_options_update_without_usable_model_keeps_previous_value() {
    let root = temp_dir("keep");
    let persistence = open(&root).await;
    register(&persistence, &root, Some(snapshot("m1", "Model One"))).await;
    // Unparseable options.
    persistence
        .enqueue_event(config_update(1, json!("not-an-options-array")))
        .unwrap();
    // Parseable, but no Model-category option.
    let mode = SessionConfigOption::select(
        "mode",
        "Mode",
        "build".to_string(),
        vec![SessionConfigSelectOption::new("build", "Build")],
    )
    .category(SessionConfigOptionCategory::Mode);
    persistence
        .enqueue_event(config_update(
            2,
            json!([serde_json::to_value(mode).unwrap()]),
        ))
        .unwrap();
    persistence.flush_session("session-1").await.unwrap();
    assert_eq!(listed(&persistence), some_model("m1", "Model One"));
    assert_eq!(persistence.metadata("session-1").unwrap().last_seq, 2);
}

#[test]
fn snapshot_from_record_ignores_other_record_types() {
    let mut record = config_update(
        1,
        json!([serde_json::to_value(model_option("m1")).unwrap()]),
    );
    assert_eq!(
        snapshot_from_record(&record),
        Some(snapshot("m1", "Model One"))
    );
    record.type_ = "session_info_update".to_string();
    assert_eq!(snapshot_from_record(&record), None);
}

#[tokio::test]
async fn reopen_records_returned_model_and_keeps_previous_when_absent() {
    let root = temp_dir("reopen");
    let persistence = open(&root).await;
    register(&persistence, &root, Some(snapshot("m1", "Model One"))).await;

    persistence
        .record_session_model("session-1", Some(&state("m2", &[("m2", "Model Two")])))
        .await;
    assert_eq!(listed(&persistence), some_model("m2", "Model Two"));

    persistence.record_session_model("session-1", None).await;
    persistence
        .record_session_model("unknown", Some(&state("m9", &[("m9", "Nine")])))
        .await;
    assert_eq!(listed(&persistence), some_model("m2", "Model Two"));

    // Persisted to disk through the writer flush (restart survives).
    persistence.shutdown().await.unwrap();
    let reloaded = open(&root).await;
    assert_eq!(listed(&reloaded), some_model("m2", "Model Two"));
}

#[test]
fn old_metadata_and_index_json_load_without_model_keys() {
    let entry: SessionIndexEntry = serde_json::from_value(json!({
        "storageKey": "k", "sessionId": "s",
        "stableAgentNamespace": null, "cwd": "/w", "title": null,
        "createdAt": 1, "lastActivityAt": 2, "status": "closed",
        "messageCount": 0, "toolCount": 0, "lastSeq": 0, "resumeEligible": false
    }))
    .unwrap();
    assert_eq!((&entry.model_id, &entry.model_name), (&None, &None));
    let json = serde_json::to_value(&entry).unwrap();
    assert!(json.get("modelId").is_none() && json.get("modelName").is_none());

    let metadata: SessionMetadata = serde_json::from_value(json!({
        "schemaVersion": 1, "storageKey": "k", "sessionId": "s",
        "stableAgentNamespace": null, "cwd": "/w", "title": null,
        "createdAt": 1, "lastActivityAt": 2, "status": "closed",
        "messageCount": 0, "toolCount": 0, "lastSeq": 0
    }))
    .unwrap();
    assert_eq!((&metadata.model_id, &metadata.model_name), (&None, &None));
    let json = serde_json::to_value(&metadata).unwrap();
    assert!(json.get("modelId").is_none() && json.get("modelName").is_none());
}

#[test]
fn model_fields_serialize_camel_case_when_set() {
    let json = serde_json::to_value(SessionIndexEntry {
        storage_key: "k".into(),
        session_id: "s".into(),
        stable_agent_namespace: None,
        runtime_agent_id: None,
        project_id: None,
        cwd: "/w".into(),
        title: None,
        title_source: None,
        created_at: 1,
        last_activity_at: 2,
        status: PersistedSessionStatus::Closed,
        message_count: 0,
        tool_count: 0,
        last_seq: 0,
        discovered: false,
        resume_eligible: false,
        worktree_path: None,
        worktree_branch: None,
        model_id: Some("m1".into()),
        model_name: Some("Model One".into()),
        log_epoch: None,
    })
    .unwrap();
    assert_eq!(json["modelId"], "m1");
    assert_eq!(json["modelName"], "Model One");
}

#[tokio::test]
async fn discovered_and_imported_sessions_have_no_model() {
    let root = temp_dir("discovered-imported");
    let persistence = open(&root).await;
    let cwd = root.join("cwd");
    fs::create_dir_all(&cwd).unwrap();
    // Even a registration that carries a model must not stamp these paths.
    let registration = |id: &str| SessionRegistration {
        session_id: id.to_string(),
        cwd: cwd.clone(),
        model: Some(snapshot("m1", "Model One")),
        ..Default::default()
    };
    let discovered = persistence
        .register_discovered_session(registration("disc-1"), Some("T".into()), Some(10))
        .await
        .unwrap();
    let imported = persistence
        .register_imported_session(registration("imp-1"), 10, Some("T".into()))
        .await
        .unwrap();
    for metadata in [discovered, imported] {
        assert_eq!((metadata.model_id, metadata.model_name), (None, None));
    }
    assert!(persistence
        .list_sessions()
        .iter()
        .all(|entry| entry.model_id.is_none() && entry.model_name.is_none()));
}
