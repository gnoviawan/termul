use super::*;
use serde_json::json;
use std::time::Duration;

fn temp_dir(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "termul-store-hygiene-{label}-{}-{}",
        std::process::id(),
        now_millis()
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

fn event(seq: u64, type_: &str) -> PersistedEventRecord {
    PersistedEventRecord {
        schema_version: SESSION_SCHEMA_VERSION,
        session_id: "session-1".to_string(),
        seq,
        type_: type_.to_string(),
        recorded_at: 1_000 + seq,
        payload: json!({"sessionId": "session-1", "turnId": "turn-1"}),
    }
}

fn set_mtime(path: &Path, mtime: SystemTime) {
    fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(mtime)
        .unwrap();
}

#[tokio::test]
async fn failed_reads_of_an_unchanged_unsalvageable_log_skip_the_salvage_scan() {
    let root = temp_dir("salvage-memo");
    let cwd = root.join("cwd");
    fs::create_dir_all(&cwd).unwrap();
    let persistence = SessionPersistence::open(root.join("store")).await.unwrap();
    let metadata = persistence
        .register_session(SessionRegistration {
            session_id: "session-1".to_string(),
            stable_agent_namespace: Some("config:one".to_string()),
            cwd,
            ..Default::default()
        })
        .await
        .unwrap();
    for (seq, type_) in [(1, "user_prompt"), (2, "prompt_complete")] {
        persistence.enqueue_event(event(seq, type_)).unwrap();
    }
    persistence.shutdown().await.unwrap();
    let log = root
        .join("store")
        .join(&metadata.storage_key)
        .join(MESSAGES_FILE);
    let clean = fs::read(&log).unwrap();
    let mut intruder = serde_json::to_vec(&event(1, "user_prompt")).unwrap();
    intruder.push(b'\n');
    let mut same_len_garbage = intruder.clone();
    same_len_garbage[0] = b'x';
    fs::write(&log, [clean.as_slice(), &same_len_garbage].concat()).unwrap();
    let mtime = fs::metadata(&log).unwrap().modified().unwrap();

    assert!(matches!(
        persistence.replay_after("session-1", 0),
        Err(SessionPersistenceError::CorruptSession)
    ));

    let healable = [clean.as_slice(), &intruder].concat();
    fs::write(&log, &healable).unwrap();
    set_mtime(&log, mtime);
    assert!(matches!(
        persistence.replay_after("session-1", 0),
        Err(SessionPersistenceError::CorruptSession)
    ));
    assert_eq!(fs::read(&log).unwrap(), healable, "not salvaged");

    set_mtime(&log, mtime + Duration::from_secs(2));
    let seqs: Vec<u64> = persistence
        .replay_after("session-1", 0)
        .unwrap()
        .iter()
        .map(|record| record.seq)
        .collect();
    assert_eq!(seqs, vec![1, 2]);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn recover_removes_index_temps_left_by_an_interrupted_write() {
    let root = temp_dir("stale-temps");
    let store = root.join("store");
    fs::create_dir_all(&store).unwrap();
    let stale = store.join("sessions.json.4242.1700000000000000000.tmp");
    let fresh = store.join("sessions.json.4242.1800000000000000000.tmp");
    let backup = store.join("sessions.json.corrupt-1-0.bak");
    for path in [&stale, &fresh, &backup] {
        fs::write(path, b"{}").unwrap();
    }
    let two_hours_ago = SystemTime::now() - Duration::from_secs(2 * 60 * 60);
    set_mtime(&stale, two_hours_ago);
    set_mtime(&backup, two_hours_ago);

    let _persistence = SessionPersistence::open(store.clone()).await.unwrap();
    assert_eq!(
        [&stale, &fresh, &backup].map(|path| path.exists()),
        [false, true, true]
    );
    let _ = fs::remove_dir_all(root);
}
