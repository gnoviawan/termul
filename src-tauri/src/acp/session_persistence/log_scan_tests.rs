use super::*;
use serde_json::json;

fn temp_dir(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "termul-log-scan-{label}-{}-{}",
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

fn event(seq: u64, type_: &str, payload: Value) -> PersistedEventRecord {
    PersistedEventRecord {
        schema_version: SESSION_SCHEMA_VERSION,
        session_id: "session-1".to_string(),
        seq,
        type_: type_.to_string(),
        recorded_at: 1_000 + seq,
        payload,
    }
}

fn prompt(seq: u64, turn_id: &str) -> PersistedEventRecord {
    event(
        seq,
        "user_prompt",
        json!({"sessionId": "session-1", "turnId": turn_id, "content": []}),
    )
}

fn agent_chunk(seq: u64) -> PersistedEventRecord {
    event(
        seq,
        "message_chunk",
        json!({"sessionId": "session-1", "role": "agent", "content": {"type": "text", "text": "hi"}}),
    )
}

fn complete(seq: u64, turn_id: &str) -> PersistedEventRecord {
    event(
        seq,
        "prompt_complete",
        json!({"sessionId": "session-1", "turnId": turn_id, "stopReason": "end_turn"}),
    )
}

fn commands_update(seq: u64) -> PersistedEventRecord {
    event(
        seq,
        "commands_update",
        json!({"sessionId": "session-1", "availableCommands": [{"name": format!("cmd-{seq}")}]}),
    )
}

fn enqueue(persistence: &SessionPersistence, records: Vec<PersistedEventRecord>) {
    for record in records {
        persistence.enqueue_event(record).unwrap();
    }
}

fn session_file(persistence: &SessionPersistence, name: &str) -> PathBuf {
    let metadata = persistence.metadata("session-1").unwrap();
    persistence.inner.root.join(metadata.storage_key).join(name)
}

fn edit_metadata(path: &Path, edit: impl FnOnce(&mut serde_json::Map<String, Value>)) {
    let mut value: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    edit(value.as_object_mut().unwrap());
    fs::write(path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
}

fn log_records(path: &Path) -> Vec<(u64, String)> {
    fs::read(path)
        .unwrap()
        .split(|byte| *byte == b'\n')
        .filter_map(|line| serde_json::from_slice::<PersistedEventRecord>(line).ok())
        .map(|record| (record.seq, record.type_))
        .collect()
}

#[test]
fn fold_counts_count_bubbles_not_meta_records() {
    let mut records = vec![
        prompt(1, "turn-1"),
        commands_update(2),
        agent_chunk(3),
        event(4, "usage_update", json!({})),
        event(5, "tool_call_update", json!({})),
        agent_chunk(6),
        event(7, "tool_call", json!({})),
        agent_chunk(8),
    ];
    assert_eq!(
        fold_counts(&mut records),
        FoldCounts {
            message_count: 3,
            tool_count: 2,
            state: FoldState {
                open_role: Some("agent"),
            },
        }
    );
}

#[tokio::test]
async fn reopen_recounts_a_legacy_session_once() {
    let root = temp_dir("recount-once");
    let persistence = registered(&root).await;
    enqueue(
        &persistence,
        vec![
            prompt(1, "turn-1"),
            commands_update(2),
            agent_chunk(3),
            agent_chunk(4),
            complete(5, "turn-1"),
        ],
    );
    persistence.shutdown().await.unwrap();
    let metadata_path = session_file(&persistence, METADATA_FILE);
    drop(persistence);
    edit_metadata(&metadata_path, |fields| {
        fields.remove("foldCounted");
        fields.insert("messageCount".to_string(), json!(5));
    });

    let first = SessionPersistence::open(root.join("store")).await.unwrap();
    first.reopen_writer("session-1").await.unwrap();
    let healed = first.metadata("session-1").unwrap();
    assert_eq!(
        (
            healed.message_count,
            healed.fold_open_role,
            healed.fold_counted
        ),
        (2, None, true)
    );
    first.shutdown().await.unwrap();
    drop(first);

    edit_metadata(&metadata_path, |fields| {
        fields.insert("messageCount".to_string(), json!(9));
    });
    let second = SessionPersistence::open(root.join("store")).await.unwrap();
    second.reopen_writer("session-1").await.unwrap();
    assert_eq!(
        second.metadata("session-1").unwrap().message_count,
        9,
        "a counted session is not rescanned on resume"
    );
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn recover_recounts_counts_that_lag_the_log_after_a_crash() {
    let root = temp_dir("recount-crash-lag");
    let persistence = registered(&root).await;
    let turn = |first: u64| {
        let turn_id = format!("turn-{first}");
        vec![
            prompt(first, &turn_id),
            commands_update(first + 1),
            agent_chunk(first + 2),
            agent_chunk(first + 3),
            complete(first + 4, &turn_id),
        ]
    };
    let mut second_turn = turn(6);
    let second_turn_end = second_turn.pop().unwrap();
    enqueue(&persistence, [turn(1), second_turn].concat());
    persistence.flush_session("session-1").await.unwrap();
    let metadata_path = session_file(&persistence, METADATA_FILE);
    let flushed_mid_turn = fs::read(&metadata_path).unwrap();
    enqueue(&persistence, vec![second_turn_end]);
    enqueue(&persistence, (11..=46).step_by(5).flat_map(turn).collect());
    persistence.shutdown().await.unwrap();
    drop(persistence);
    fs::write(&metadata_path, flushed_mid_turn).unwrap();

    let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
    reopened.reopen_writer("session-1").await.unwrap();
    let healed = reopened.metadata("session-1").unwrap();
    assert_eq!(
        (
            healed.last_seq,
            healed.message_count,
            healed.fold_open_role,
            healed.fold_counted
        ),
        (50, 20, None, true)
    );
    reopened.shutdown().await.unwrap();
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn shutdown_marker_reads_only_back_to_the_open_turn() {
    let root = temp_dir("marker-tail");
    let persistence = registered(&root).await;
    persistence.set_seq_authority(Arc::new(NextSeq));
    enqueue(
        &persistence,
        vec![
            prompt(1, "turn-1"),
            complete(2, "turn-1"),
            prompt(3, "turn-2"),
            agent_chunk(4),
        ],
    );
    persistence.flush_session("session-1").await.unwrap();
    let log = session_file(&persistence, MESSAGES_FILE);
    let bytes = fs::read(&log).unwrap();
    let second_line_end = bytes
        .iter()
        .enumerate()
        .filter(|(_, byte)| **byte == b'\n')
        .nth(1)
        .unwrap()
        .0
        + 1;
    let mut spliced = bytes[..second_line_end].to_vec();
    spliced.extend_from_slice(b"not a record\n");
    spliced.extend_from_slice(&bytes[second_line_end..]);
    fs::write(&log, spliced).unwrap();

    persistence.shutdown().await.unwrap();
    assert_eq!(
        log_records(&log),
        vec![
            (1, "user_prompt".to_string()),
            (2, "prompt_complete".to_string()),
            (3, "user_prompt".to_string()),
            (4, "message_chunk".to_string()),
            (5, "prompt_complete".to_string()),
        ]
    );
    let _ = fs::remove_dir_all(root);
}

struct NextSeq;

impl SeqAuthority for NextSeq {
    fn allocate_after(&self, _session_id: &str, floor: u64) -> u64 {
        floor + 1
    }
}
