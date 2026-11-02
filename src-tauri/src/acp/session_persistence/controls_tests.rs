use super::*;
use serde_json::json;

fn temp_dir(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "termul-controls-{label}-{}-{}",
        std::process::id(),
        now_millis()
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

async fn registered(root: &Path) -> Arc<SessionPersistence> {
    let cwd = root.join("cwd");
    fs::create_dir_all(&cwd).unwrap();
    let persistence = SessionPersistence::open(root.join("store")).await.unwrap();
    persistence
        .register_session(SessionRegistration {
            session_id: "session-1".to_string(),
            stable_agent_namespace: Some("config:one".to_string()),
            runtime_agent_id: Some("runtime-1".to_string()),
            project_id: Some("project-1".to_string()),
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    persistence
}

fn enqueue(persistence: &SessionPersistence, seq: u64, type_: &str, payload: Value) {
    let mut payload = payload;
    payload["agentId"] = json!("runtime-1");
    payload["sessionId"] = json!("session-1");
    persistence
        .enqueue_event(PersistedEventRecord {
            schema_version: SESSION_SCHEMA_VERSION,
            session_id: "session-1".to_string(),
            seq,
            type_: type_.to_string(),
            recorded_at: 1_000 + seq,
            payload,
        })
        .unwrap();
}

/// Three records, two bubbles: `seq` prompt, `seq + 1` reply, `seq + 2` end.
fn enqueue_turns(persistence: &SessionPersistence, first_seq: u64, turns: u64) {
    for turn in 0..turns {
        let seq = first_seq + turn * 3;
        let turn_id = format!("turn-{seq}");
        enqueue(
            persistence,
            seq,
            "user_prompt",
            json!({"turnId": turn_id, "content": [{"type": "text", "text": "prompt"}]}),
        );
        enqueue(
            persistence,
            seq + 1,
            "message_chunk",
            json!({"role": "agent", "content": {"type": "text", "text": "reply"}}),
        );
        enqueue(
            persistence,
            seq + 2,
            "prompt_complete",
            json!({"turnId": turn_id, "stopReason": "end_turn"}),
        );
    }
}

fn model_select(current: &str) -> Value {
    json!({
        "id": "model",
        "name": "Model",
        "category": "model",
        "type": "select",
        "currentValue": current,
        "options": [
            {"value": "sonnet", "name": "Sonnet"},
            {"value": "opus", "name": "Opus"},
        ],
    })
}

fn models(current: &str) -> Value {
    json!({
        "currentModelId": current,
        "availableModels": [
            {"modelId": "sonnet", "name": "Sonnet"},
            {"modelId": "opus", "name": "Opus"},
        ],
    })
}

fn modes(current: &str) -> Value {
    json!({
        "currentModeId": current,
        "availableModes": [
            {"id": "default", "name": "Default"},
            {"id": "plan", "name": "Plan"},
        ],
    })
}

/// `session_created` at 1, a model switch at 2, then ten turns from 3.
fn enqueue_controls_then_turns(persistence: &SessionPersistence) {
    enqueue(
        persistence,
        1,
        "session_created",
        json!({
            "modes": modes("default"),
            "models": models("sonnet"),
            "configOptions": [model_select("sonnet")],
        }),
    );
    enqueue(
        persistence,
        2,
        "config_options_update",
        json!({"configOptions": [model_select("opus")]}),
    );
    enqueue_turns(persistence, 3, 10);
}

async fn tail_controls(persistence: &Arc<SessionPersistence>) -> (u64, Value) {
    let tail = persistence
        .session_payload_tail_async("session-1", 4)
        .await
        .unwrap();
    let first_seq = tail.messages.first().map_or(0, |message| message.seq);
    let wire = serde_json::to_value(&tail).unwrap();
    let controls = json!({
        "configOptions": wire.get("configOptions"),
        "modes": wire.get("modes"),
        "models": wire.get("models"),
        "controlsSeq": wire.get("controlsSeq"),
    });
    (first_seq, controls)
}

#[tokio::test]
async fn a_tail_payload_carries_controls_recorded_before_its_window() {
    let root = temp_dir("tail-live");
    let persistence = registered(&root).await;
    enqueue_controls_then_turns(&persistence);

    let (first_seq, controls) = tail_controls(&persistence).await;
    assert!(
        first_seq > 2,
        "the window starts after the controls records"
    );
    assert_eq!(
        controls,
        json!({
            "configOptions": [model_select("opus")],
            "modes": modes("default"),
            "models": models("opus"),
            "controlsSeq": 2,
        })
    );
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn a_tail_payload_after_restart_reads_controls_from_the_log() {
    let root = temp_dir("tail-restart");
    let persistence = registered(&root).await;
    enqueue_controls_then_turns(&persistence);
    persistence.shutdown().await.unwrap();
    drop(persistence);

    let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
    let (first_seq, controls) = tail_controls(&reopened).await;
    assert!(
        first_seq > 2,
        "the window starts after the controls records"
    );
    assert_eq!(
        controls,
        json!({
            "configOptions": [model_select("opus")],
            "modes": modes("default"),
            "models": models("opus"),
            "controlsSeq": 2,
        })
    );
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn an_update_appended_after_restart_merges_with_the_logged_controls() {
    let root = temp_dir("restart-append");
    let persistence = registered(&root).await;
    enqueue_controls_then_turns(&persistence);
    persistence.shutdown().await.unwrap();
    drop(persistence);

    let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
    reopened.reopen_writer("session-1").await.unwrap();
    enqueue(
        &reopened,
        33,
        "mode_update",
        json!({"currentModeId": "plan"}),
    );

    let (_, controls) = tail_controls(&reopened).await;
    assert_eq!(
        controls,
        json!({
            "configOptions": [model_select("opus")],
            "modes": modes("plan"),
            "models": models("opus"),
            "controlsSeq": 33,
        }),
        "the live mode change keeps the logged options, models and mode list"
    );
    enqueue(
        &reopened,
        34,
        "config_options_update",
        json!({"configOptions": [model_select("sonnet")]}),
    );
    let (_, controls) = tail_controls(&reopened).await;
    assert_eq!(controls["models"], models("sonnet"));
    assert_eq!(controls["controlsSeq"], json!(34));
    reopened.shutdown().await.unwrap();
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn a_session_without_controls_records_has_no_controls_in_either_payload() {
    let root = temp_dir("legacy");
    let persistence = registered(&root).await;
    enqueue_turns(&persistence, 1, 10);

    let (_, controls) = tail_controls(&persistence).await;
    assert_eq!(
        controls,
        json!({"configOptions": null, "modes": null, "models": null, "controlsSeq": null})
    );
    let full = serde_json::to_value(
        persistence
            .session_payload_async("session-1")
            .await
            .unwrap(),
    )
    .unwrap();
    for key in ["configOptions", "modes", "models", "controlsSeq"] {
        assert!(full.get(key).is_none(), "full payload must not carry {key}");
    }
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn the_log_scan_stops_at_session_created() {
    let root = temp_dir("scan-stops");
    let persistence = registered(&root).await;
    enqueue(
        &persistence,
        1,
        "mode_update",
        json!({"currentModeId": "plan"}),
    );
    enqueue(
        &persistence,
        2,
        "session_created",
        json!({"models": models("sonnet"), "configOptions": [model_select("sonnet")]}),
    );
    enqueue_turns(&persistence, 3, 10);
    persistence.shutdown().await.unwrap();
    drop(persistence);

    let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
    let (_, controls) = tail_controls(&reopened).await;
    assert_eq!(
        controls,
        json!({
            "configOptions": [model_select("sonnet")],
            "modes": null,
            "models": models("sonnet"),
            "controlsSeq": 2,
        }),
        "a record older than session_created is not read"
    );
    let full =
        serde_json::to_value(reopened.session_payload_async("session-1").await.unwrap()).unwrap();
    assert!(
        full.get("modes").is_none(),
        "the full payload agrees with the tail"
    );
    let _ = fs::remove_dir_all(root);
}

fn controls_record(seq: u64, type_: &str, payload: Value) -> PersistedEventRecord {
    PersistedEventRecord {
        schema_version: SESSION_SCHEMA_VERSION,
        session_id: "session-1".to_string(),
        seq,
        type_: type_.to_string(),
        recorded_at: 1_000 + seq,
        payload,
    }
}

fn created_at_1() -> ControlsFold {
    ControlsFold::of_records([&controls_record(
        1,
        "session_created",
        json!({
            "modes": modes("default"),
            "models": models("sonnet"),
            "configOptions": [model_select("sonnet")],
        }),
    )])
}

fn switched_at_40() -> ControlsFold {
    ControlsFold::of_records([&controls_record(
        40,
        "config_options_update",
        json!({"configOptions": [model_select("opus")]}),
    )])
}

fn assert_merged(controls: Option<SessionControls>) {
    let controls = serde_json::to_value(controls.expect("controls present")).unwrap();
    assert_eq!(
        controls,
        json!({
            "configOptions": [model_select("opus")],
            "modes": modes("default"),
            "models": models("opus"),
            "controlsSeq": 40,
        })
    );
}

#[test]
fn a_seed_of_an_older_scan_keeps_a_newer_noted_update() {
    let cache = ControlsCache::default();
    let ticket = cache.lookup("session-1").unwrap_err();
    cache.note("session-1", switched_at_40());
    assert_merged(cache.seed("session-1", ticket, created_at_1()).flatten());
    assert_merged(cache.lookup("session-1").ok().flatten());
}

#[test]
fn an_update_noted_after_the_seed_wins_over_the_scan() {
    let cache = ControlsCache::default();
    let Err(ticket) = cache.lookup("session-1") else {
        panic!("an unseeded session is not served from the cache");
    };
    cache.seed("session-1", ticket, created_at_1());
    cache.note("session-1", switched_at_40());
    assert_merged(cache.lookup("session-1").ok().flatten());
}
