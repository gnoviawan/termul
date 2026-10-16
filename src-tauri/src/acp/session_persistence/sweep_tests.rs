use super::*;
use serde_json::json;

fn temp_dir(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "termul-sweep-{label}-{}-{}",
        std::process::id(),
        now_millis()
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

async fn registered(root: &Path, session_id: &str) -> Arc<SessionPersistence> {
    let cwd = root.join("cwd");
    fs::create_dir_all(&cwd).unwrap();
    let persistence = SessionPersistence::open(root.join("store")).await.unwrap();
    register(&persistence, session_id, &cwd).await;
    persistence
}

async fn register(persistence: &SessionPersistence, session_id: &str, cwd: &Path) {
    persistence
        .register_session(SessionRegistration {
            session_id: session_id.to_string(),
            stable_agent_namespace: Some("config:one".to_string()),
            runtime_agent_id: Some("runtime-1".to_string()),
            project_id: Some("project-1".to_string()),
            cwd: cwd.to_path_buf(),
            ..Default::default()
        })
        .await
        .unwrap();
}

fn event(session_id: &str, seq: u64, type_: &str, payload: Value) -> PersistedEventRecord {
    PersistedEventRecord {
        schema_version: SESSION_SCHEMA_VERSION,
        session_id: session_id.to_string(),
        seq,
        type_: type_.to_string(),
        recorded_at: 1_000 + seq,
        payload,
    }
}

fn user_prompt(persistence: &SessionPersistence, session_id: &str, seq: u64, turn_id: &str) {
    persistence
        .enqueue_event(event(
            session_id,
            seq,
            "user_prompt",
            json!({"sessionId": session_id, "turnId": turn_id, "content": []}),
        ))
        .unwrap();
}

fn chunk(persistence: &SessionPersistence, session_id: &str, seq: u64) {
    persistence
        .enqueue_event(event(
            session_id,
            seq,
            "message_chunk",
            json!({
                "sessionId": session_id,
                "role": "agent",
                "content": {"type": "text", "text": "partial"},
            }),
        ))
        .unwrap();
}

fn complete(persistence: &SessionPersistence, session_id: &str, seq: u64, turn_id: &str) {
    persistence
        .enqueue_event(event(
            session_id,
            seq,
            "prompt_complete",
            json!({"sessionId": session_id, "turnId": turn_id, "stopReason": "end_turn"}),
        ))
        .unwrap();
}

fn messages_path(persistence: &SessionPersistence, session_id: &str) -> PathBuf {
    let metadata = persistence.metadata(session_id).unwrap();
    persistence
        .inner
        .root
        .join(metadata.storage_key)
        .join(MESSAGES_FILE)
}

fn terminators(persistence: &SessionPersistence, session_id: &str) -> Vec<PersistedEventRecord> {
    persistence
        .replay_after(session_id, 0)
        .unwrap()
        .into_iter()
        .filter(|record| record.type_ == "prompt_complete")
        .collect()
}

async fn crash_and_reopen(persistence: Arc<SessionPersistence>, root: &Path) -> Arc<SessionPersistence> {
    persistence.flush_session("session-1").await.ok();
    drop(persistence);
    SessionPersistence::open(root.join("store")).await.unwrap()
}

/// A host crash mid-turn leaves the open turn terminated by exactly one
/// `interrupted` record at the next seq; a second host start adds nothing.
#[tokio::test]
async fn sweep_terminates_open_turn_once_and_is_idempotent() {
    let root = temp_dir("open-turn");
    let persistence = registered(&root, "session-1").await;
    user_prompt(&persistence, "session-1", 1, "turn-1");
    chunk(&persistence, "session-1", 2);
    complete(&persistence, "session-1", 3, "turn-1");
    user_prompt(&persistence, "session-1", 4, "turn-2");
    chunk(&persistence, "session-1", 5);
    persistence.flush_session("session-1").await.unwrap();
    let activity_before = persistence.metadata("session-1").unwrap().last_activity_at;

    let reopened = crash_and_reopen(persistence, &root).await;
    let markers = terminators(&reopened, "session-1");
    assert_eq!(markers.len(), 2, "one real + one interrupted terminator");
    let marker = markers.last().unwrap();
    assert_eq!(marker.payload["stopReason"], "interrupted");
    assert_eq!(marker.payload["turnId"], "turn-2");
    assert_eq!(marker.seq, 6);
    let metadata = reopened.metadata("session-1").unwrap();
    assert_eq!(metadata.last_seq, 6);
    assert_eq!(metadata.status, PersistedSessionStatus::Closed);
    assert_eq!(
        metadata.last_activity_at, activity_before,
        "the sweep must not reorder the history list"
    );
    assert!(reopened
        .completed_turn_ids("session-1")
        .unwrap()
        .contains("turn-2"));
    let bytes_after_first = fs::read(messages_path(&reopened, "session-1")).unwrap();

    drop(reopened);
    let again = SessionPersistence::open(root.join("store")).await.unwrap();
    assert_eq!(terminators(&again, "session-1").len(), 2);
    assert_eq!(
        fs::read(messages_path(&again, "session-1")).unwrap(),
        bytes_after_first,
        "a second host start must add nothing"
    );
    let _ = fs::remove_dir_all(root);
}

/// Closed turns, empty sessions and prompt-less logs are left byte-for-byte
/// alone; only the crashed session gains a terminator.
#[tokio::test]
async fn sweep_leaves_clean_and_empty_sessions_untouched() {
    let root = temp_dir("clean");
    let persistence = registered(&root, "session-1").await;
    let cwd = root.join("cwd");
    register(&persistence, "session-empty", &cwd).await;
    register(&persistence, "session-chatter", &cwd).await;
    user_prompt(&persistence, "session-1", 1, "turn-1");
    complete(&persistence, "session-1", 2, "turn-1");
    for seq in 1..=100 {
        chunk(&persistence, "session-chatter", seq);
    }
    persistence.flush_session("session-1").await.unwrap();
    persistence.flush_session("session-chatter").await.unwrap();
    let before: Vec<Vec<u8>> = ["session-1", "session-empty", "session-chatter"]
        .iter()
        .map(|id| fs::read(messages_path(&persistence, id)).unwrap())
        .collect();

    drop(persistence);
    let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
    let after: Vec<Vec<u8>> = ["session-1", "session-empty", "session-chatter"]
        .iter()
        .map(|id| fs::read(messages_path(&reopened, id)).unwrap())
        .collect();
    assert_eq!(before, after);
    assert_eq!(reopened.metadata("session-1").unwrap().last_seq, 2);
    let _ = fs::remove_dir_all(root);
}

/// A crash can tear the final write; the repair runs before the sweep, so the
/// terminator lands after the last intact record and the log parses.
#[tokio::test]
async fn sweep_runs_after_torn_tail_repair() {
    let root = temp_dir("torn");
    let persistence = registered(&root, "session-1").await;
    user_prompt(&persistence, "session-1", 1, "turn-1");
    chunk(&persistence, "session-1", 2);
    persistence.flush_session("session-1").await.unwrap();
    let log = messages_path(&persistence, "session-1");
    drop(persistence);
    fs::OpenOptions::new()
        .append(true)
        .open(&log)
        .unwrap()
        .write_all(b"{\"schemaVersion\":1,\"sessionId\":\"sess")
        .unwrap();

    let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
    let records = reopened.replay_after("session-1", 0).unwrap();
    let seqs: Vec<u64> = records.iter().map(|record| record.seq).collect();
    assert_eq!(seqs, vec![1, 2, 3]);
    let marker = records.last().unwrap();
    assert_eq!(marker.type_, "prompt_complete");
    assert_eq!(marker.payload["stopReason"], "interrupted");
    assert_eq!(marker.payload["turnId"], "turn-1");
    let _ = fs::remove_dir_all(root);
}

/// An open turn whose run of chunks is longer than the first tail window is
/// still found, and a stale-low metadata `last_seq` cannot make the marker
/// reuse a seq.
#[tokio::test]
async fn sweep_finds_open_turn_behind_a_long_chunk_run() {
    let root = temp_dir("long-run");
    let persistence = registered(&root, "session-1").await;
    user_prompt(&persistence, "session-1", 1, "turn-1");
    for seq in 2..=200 {
        chunk(&persistence, "session-1", seq);
    }
    persistence.flush_session("session-1").await.unwrap();
    drop(persistence);
    // Metadata lagging the log frontier, as after a crash between flushes.
    let metadata_path = fs::read_dir(root.join("store"))
        .unwrap()
        .flatten()
        .map(|entry| entry.path().join(METADATA_FILE))
        .find(|path| path.is_file())
        .unwrap();
    let mut metadata: SessionMetadata =
        serde_json::from_slice(&fs::read(&metadata_path).unwrap()).unwrap();
    metadata.last_seq = 150;
    fs::write(&metadata_path, serde_json::to_vec(&metadata).unwrap()).unwrap();

    let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
    let markers = terminators(&reopened, "session-1");
    assert_eq!(markers.len(), 1);
    assert_eq!(markers[0].seq, 201);
    assert_eq!(markers[0].payload["turnId"], "turn-1");
    assert_eq!(reopened.metadata("session-1").unwrap().last_seq, 201);
    let _ = fs::remove_dir_all(root);
}

/// After the sweep the session accepts the next turn on its normal writer
/// path: the swept seq is below the next one and the log stays valid.
#[tokio::test]
async fn swept_session_accepts_next_turn() {
    let root = temp_dir("next-turn");
    let persistence = registered(&root, "session-1").await;
    user_prompt(&persistence, "session-1", 1, "turn-1");
    persistence.flush_session("session-1").await.unwrap();

    let reopened = crash_and_reopen(persistence, &root).await;
    reopened.reopen_writer("session-1").await.unwrap();
    user_prompt(&reopened, "session-1", 3, "turn-2");
    complete(&reopened, "session-1", 4, "turn-2");
    reopened.flush_session("session-1").await.unwrap();
    let ids = reopened.completed_turn_ids("session-1").unwrap();
    assert!(ids.contains("turn-1") && ids.contains("turn-2"));
    assert_eq!(terminators(&reopened, "session-1").len(), 2);
    let _ = fs::remove_dir_all(root);
}

fn complete_with(
    persistence: &SessionPersistence,
    seq: u64,
    payload: Value,
) {
    persistence
        .enqueue_event(event("session-1", seq, "prompt_complete", payload))
        .unwrap();
}

/// A completion naming ANOTHER turn (or none) does not close the open prompt:
/// the gate must agree with `last_unmatched_user_prompt` and still sweep it.
#[tokio::test]
async fn sweep_treats_mismatched_or_turnless_completion_as_still_open() {
    for (label, payload) in [
        (
            "other-turn",
            json!({"sessionId": "session-1", "turnId": "turn-other", "stopReason": "end_turn"}),
        ),
        (
            "no-turn",
            json!({"sessionId": "session-1", "stopReason": "end_turn"}),
        ),
    ] {
        let root = temp_dir(label);
        let persistence = registered(&root, "session-1").await;
        user_prompt(&persistence, "session-1", 1, "turn-1");
        complete_with(&persistence, 2, payload);
        persistence.flush_session("session-1").await.unwrap();

        let reopened = crash_and_reopen(persistence, &root).await;
        let markers = terminators(&reopened, "session-1");
        assert_eq!(markers.len(), 2, "{label}: the open turn gains a terminator");
        assert_eq!(markers[1].payload["stopReason"], "interrupted", "{label}");
        assert_eq!(markers[1].payload["turnId"], "turn-1", "{label}");
        let _ = fs::remove_dir_all(root);
    }
}

/// A legacy turnless `user_prompt` is closed by any later completion and is
/// left alone; an open one is swept without a `turnId`.
#[tokio::test]
async fn sweep_handles_legacy_turnless_prompts() {
    let root = temp_dir("turnless");
    let persistence = registered(&root, "session-1").await;
    let turnless = |seq: u64| {
        event(
            "session-1",
            seq,
            "user_prompt",
            json!({"sessionId": "session-1", "turnId": null, "content": []}),
        )
    };
    persistence.enqueue_event(turnless(1)).unwrap();
    complete_with(
        &persistence,
        2,
        json!({"sessionId": "session-1", "stopReason": "end_turn"}),
    );
    persistence.enqueue_event(turnless(3)).unwrap();
    persistence.flush_session("session-1").await.unwrap();

    let reopened = crash_and_reopen(persistence, &root).await;
    let markers = terminators(&reopened, "session-1");
    assert_eq!(markers.len(), 2, "only the open turnless prompt is swept");
    assert_eq!(markers[1].seq, 4);
    assert!(markers[1].payload.get("turnId").is_none());
    let _ = fs::remove_dir_all(root);
}

// --- sweep checkpoint (memoized "no open turn" verdict) ---

fn metadata_path(persistence: &SessionPersistence, session_id: &str) -> PathBuf {
    let metadata = persistence.metadata(session_id).unwrap();
    persistence
        .inner
        .root
        .join(metadata.storage_key)
        .join(METADATA_FILE)
}

/// Hand-edit the checkpoint in a closed session's `metadata.json`.
fn plant_checkpoint(path: &Path, checkpoint: Option<SweepCheckpoint>) {
    let mut metadata: SessionMetadata = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    metadata.sweep_checkpoint = checkpoint;
    fs::write(path, serde_json::to_vec_pretty(&metadata).unwrap()).unwrap();
}

fn checkpoint_of(persistence: &SessionPersistence) -> Option<SweepCheckpoint> {
    persistence.metadata("session-1").unwrap().sweep_checkpoint
}

/// Append records to a log behind the writer's back, as a crash leaves them.
fn append_raw(path: &Path, records: &[PersistedEventRecord]) {
    let mut bytes = Vec::new();
    for record in records {
        serde_json::to_writer(&mut bytes, record).unwrap();
        bytes.push(b'\n');
    }
    fs::OpenOptions::new()
        .append(true)
        .open(path)
        .unwrap()
        .write_all(&bytes)
        .unwrap();
}

fn agent_chunk(seq: u64, text: &str) -> PersistedEventRecord {
    event(
        "session-1",
        seq,
        "message_chunk",
        json!({
            "sessionId": "session-1",
            "role": "agent",
            "content": {"type": "text", "text": text},
        }),
    )
}

/// Byte offset just past each line's `\n`.
fn line_ends(path: &Path) -> Vec<u64> {
    fs::read(path)
        .unwrap()
        .iter()
        .enumerate()
        .filter(|(_, byte)| **byte == b'\n')
        .map(|(index, _)| index as u64 + 1)
        .collect()
}

/// Retype the log's `prompt_complete` in place (same length): the prefix now
/// folds to an open turn, which only a scan of that prefix can notice.
fn hide_completion(path: &Path) {
    let mut bytes = fs::read(path).unwrap();
    let needle = b"\"type\":\"prompt_complete\"";
    let at = memchr::memmem::find(&bytes, needle).unwrap();
    bytes[at..at + needle.len()].copy_from_slice(b"\"type\":\"prompt_c0mplete\"");
    fs::write(path, bytes).unwrap();
}

/// A closed turn followed by a chunk, reopened once over a stale checkpoint
/// so the sweep stamps a fresh one. Returns (log, metadata.json, checkpoint).
async fn stamped_closed_session(root: &Path) -> (PathBuf, PathBuf, SweepCheckpoint) {
    let persistence = registered(root, "session-1").await;
    user_prompt(&persistence, "session-1", 1, "turn-1");
    chunk(&persistence, "session-1", 2);
    complete(&persistence, "session-1", 3, "turn-1");
    chunk(&persistence, "session-1", 4);
    persistence.flush_session("session-1").await.unwrap();
    let log = messages_path(&persistence, "session-1");
    let metadata = metadata_path(&persistence, "session-1");
    drop(persistence);
    plant_checkpoint(&metadata, Some(SweepCheckpoint { len: 1, seq: 99 }));

    let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
    let checkpoint = checkpoint_of(&reopened).expect("a stale checkpoint is restamped");
    assert_eq!(
        checkpoint,
        SweepCheckpoint {
            len: fs::metadata(&log).unwrap().len(),
            seq: 4,
        }
    );
    assert_eq!(terminators(&reopened, "session-1").len(), 1);
    (log, metadata, checkpoint)
}

/// An unchanged log behind a valid checkpoint is not scanned at all (an open
/// turn hidden in the vouched-for prefix stays unseen) and the launch writes
/// nothing: `metadata.json` and the log stay byte-identical.
#[tokio::test]
async fn checkpoint_skips_an_unchanged_log() {
    let root = temp_dir("cp-unchanged");
    let (log, metadata, _) = stamped_closed_session(&root).await;
    hide_completion(&log);
    let log_before = fs::read(&log).unwrap();
    let metadata_before = fs::read(&metadata).unwrap();

    let again = SessionPersistence::open(root.join("store")).await.unwrap();
    assert_eq!(fs::read(&log).unwrap(), log_before, "no marker appended");
    assert_eq!(fs::read(&metadata).unwrap(), metadata_before);
    drop(again);
    let _ = fs::remove_dir_all(root);
}

/// A log that grew without a new prompt is scanned only past the checkpoint:
/// no marker, and the short scan keeps the old checkpoint.
#[tokio::test]
async fn checkpoint_scans_only_the_growth_of_a_grown_log() {
    let root = temp_dir("cp-grew");
    let (log, _, checkpoint) = stamped_closed_session(&root).await;
    hide_completion(&log);
    let late: Vec<_> = (5..=7).map(|seq| agent_chunk(seq, "late")).collect();
    append_raw(&log, &late);
    let log_before = fs::read(&log).unwrap();

    let again = SessionPersistence::open(root.join("store")).await.unwrap();
    assert_eq!(fs::read(&log).unwrap(), log_before, "no marker appended");
    assert_eq!(checkpoint_of(&again), Some(checkpoint));
    assert_eq!(again.metadata("session-1").unwrap().last_seq, 7);
    let _ = fs::remove_dir_all(root);
}

/// A prompt raw-appended after the checkpoint is still swept, exactly as
/// without one.
#[tokio::test]
async fn checkpoint_still_sweeps_a_prompt_appended_after_it() {
    let root = temp_dir("cp-open");
    let (log, _, _) = stamped_closed_session(&root).await;
    append_raw(
        &log,
        &[
            event(
                "session-1",
                5,
                "user_prompt",
                json!({"sessionId": "session-1", "turnId": "turn-2", "content": []}),
            ),
            agent_chunk(6, "partial"),
        ],
    );

    let again = SessionPersistence::open(root.join("store")).await.unwrap();
    let markers = terminators(&again, "session-1");
    assert_eq!(markers.len(), 2, "the real completion plus one marker");
    assert_eq!(markers[1].seq, 7);
    assert_eq!(markers[1].payload["stopReason"], "interrupted");
    assert_eq!(markers[1].payload["turnId"], "turn-2");
    assert_eq!(again.metadata("session-1").unwrap().last_seq, 7);
    let _ = fs::remove_dir_all(root);
}

/// A checkpoint that no longer describes the log (its `len` is mid-line, its
/// line carries another seq, or the file is shorter) is ignored: the full
/// scan finds the open turn, and the checkpoint is restamped at the marker.
#[tokio::test]
async fn stale_checkpoint_is_ignored_and_restamped() {
    for label in ["mid-line", "seq-mismatch", "past-end"] {
        let root = temp_dir(label);
        let persistence = registered(&root, "session-1").await;
        user_prompt(&persistence, "session-1", 1, "turn-1");
        chunk(&persistence, "session-1", 2);
        persistence.flush_session("session-1").await.unwrap();
        let log = messages_path(&persistence, "session-1");
        let metadata = metadata_path(&persistence, "session-1");
        drop(persistence);
        let ends = line_ends(&log);
        let stale = match label {
            "mid-line" => SweepCheckpoint {
                len: ends[0] - 5,
                seq: 1,
            },
            "seq-mismatch" => SweepCheckpoint {
                len: ends[0],
                seq: 2,
            },
            _ => SweepCheckpoint {
                len: ends[1] + 10,
                seq: 2,
            },
        };
        plant_checkpoint(&metadata, Some(stale));

        let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
        let markers = terminators(&reopened, "session-1");
        assert_eq!(markers.len(), 1, "{label}: the open turn is swept");
        assert_eq!(markers[0].seq, 3, "{label}");
        assert_eq!(markers[0].payload["turnId"], "turn-1", "{label}");
        assert_eq!(
            checkpoint_of(&reopened),
            Some(SweepCheckpoint {
                len: fs::metadata(&log).unwrap().len(),
                seq: 3,
            }),
            "{label}: restamped at the marker"
        );
        let _ = fs::remove_dir_all(root);
    }
}

/// A prompt-less log longer than the old 16k-line gate cap is decided by the
/// single backward pass (no fall-through to the marker routine's full load,
/// which never stamps) and its megabytes of scan are memoized.
#[tokio::test]
async fn prompt_less_log_past_the_old_gate_cap_is_stamped() {
    let root = temp_dir("cp-chunks");
    let persistence = registered(&root, "session-1").await;
    let log = messages_path(&persistence, "session-1");
    drop(persistence);
    let lines = TAIL_DEEPEN_MAX_LINES as u64 + 100;
    let text = "x".repeat(64);
    let chunks: Vec<_> = (1..=lines).map(|seq| agent_chunk(seq, &text)).collect();
    append_raw(&log, &chunks);
    let log_before = fs::read(&log).unwrap();
    assert!(log_before.len() > 2 * 1024 * 1024, "a multi-megabyte scan");

    let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
    assert_eq!(fs::read(&log).unwrap(), log_before, "nothing to sweep");
    assert_eq!(
        checkpoint_of(&reopened),
        Some(SweepCheckpoint {
            len: log_before.len() as u64,
            seq: lines,
        })
    );
    let _ = fs::remove_dir_all(root);
}

/// An open turn behind a long run of `commands_update` records is swept once;
/// the next launch changes nothing on disk.
#[tokio::test]
async fn open_turn_behind_a_long_commands_run_is_swept_once() {
    let root = temp_dir("cp-commands");
    let persistence = registered(&root, "session-1").await;
    user_prompt(&persistence, "session-1", 1, "turn-1");
    let description = "d".repeat(4096);
    for seq in 2..=301 {
        persistence
            .enqueue_event(event(
                "session-1",
                seq,
                "commands_update",
                json!({"sessionId": "session-1", "availableCommands": [
                    {"name": format!("cmd-{seq}"), "description": description}
                ]}),
            ))
            .unwrap();
    }
    let reopened = crash_and_reopen(persistence, &root).await;
    let markers = terminators(&reopened, "session-1");
    assert_eq!(markers.len(), 1);
    assert_eq!(markers[0].seq, 302);
    assert_eq!(markers[0].payload["turnId"], "turn-1");
    let log = messages_path(&reopened, "session-1");
    let metadata = metadata_path(&reopened, "session-1");
    assert_eq!(
        checkpoint_of(&reopened),
        Some(SweepCheckpoint {
            len: fs::metadata(&log).unwrap().len(),
            seq: 302,
        }),
        "the megabyte scan is memoized at the marker"
    );
    let log_before = fs::read(&log).unwrap();
    let metadata_before = fs::read(&metadata).unwrap();
    drop(reopened);

    let again = SessionPersistence::open(root.join("store")).await.unwrap();
    assert_eq!(fs::read(&log).unwrap(), log_before);
    assert_eq!(fs::read(&metadata).unwrap(), metadata_before);
    assert_eq!(terminators(&again, "session-1").len(), 1);
    let _ = fs::remove_dir_all(root);
}

/// A fold line the probe cannot read fails open: the marker routine runs (and
/// itself refuses the corrupt log), and no checkpoint is stamped, not even
/// over a stale one that would otherwise force a restamp.
#[tokio::test]
async fn corrupt_candidate_line_fails_open_without_a_stamp() {
    let root = temp_dir("cp-corrupt");
    let persistence = registered(&root, "session-1").await;
    user_prompt(&persistence, "session-1", 1, "turn-1");
    complete(&persistence, "session-1", 2, "turn-1");
    chunk(&persistence, "session-1", 3);
    persistence.flush_session("session-1").await.unwrap();
    let log = messages_path(&persistence, "session-1");
    let metadata = metadata_path(&persistence, "session-1");
    drop(persistence);
    // A broken `user_prompt` line between the prompt and its completion.
    let bytes = fs::read(&log).unwrap();
    let first_end = line_ends(&log)[0] as usize;
    let mut spliced = bytes[..first_end].to_vec();
    spliced.extend_from_slice(
        b"{\"schemaVersion\":1,\"sessionId\":\"session-1\",\"seq\":9,\"type\":\"user_prompt\",BROKEN}\n",
    );
    spliced.extend_from_slice(&bytes[first_end..]);
    fs::write(&log, &spliced).unwrap();
    plant_checkpoint(&metadata, Some(SweepCheckpoint { len: 1, seq: 99 }));

    let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
    assert_eq!(fs::read(&log).unwrap(), spliced, "no marker appended");
    assert_eq!(checkpoint_of(&reopened), None);
    let _ = fs::remove_dir_all(root);
}

/// A session a previous launch already closed needs no other healing, so the
/// checkpoint-only metadata write is what persists its stamp: the restamp
/// reaches `metadata.json`, and the next launch honors it without rescanning
/// (an open turn hidden in the vouched-for prefix stays unseen).
#[tokio::test]
async fn checkpoint_restamped_on_a_closed_session_reaches_disk() {
    let root = temp_dir("cp-closed");
    let persistence = registered(&root, "session-1").await;
    user_prompt(&persistence, "session-1", 1, "turn-1");
    complete(&persistence, "session-1", 2, "turn-1");
    let text = "x".repeat(1024);
    for seq in 3..=1200 {
        persistence.enqueue_event(agent_chunk(seq, &text)).unwrap();
    }
    persistence.flush_session("session-1").await.unwrap();
    let log = messages_path(&persistence, "session-1");
    let metadata = metadata_path(&persistence, "session-1");
    drop(persistence);
    let closed = SessionPersistence::open(root.join("store")).await.unwrap();
    assert_eq!(
        closed.metadata("session-1").unwrap().status,
        PersistedSessionStatus::Closed
    );
    drop(closed);
    plant_checkpoint(&metadata, Some(SweepCheckpoint { len: 1, seq: 99 }));

    let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
    drop(reopened);
    let on_disk: SessionMetadata = serde_json::from_slice(&fs::read(&metadata).unwrap()).unwrap();
    assert_eq!(
        on_disk.sweep_checkpoint,
        Some(SweepCheckpoint {
            len: fs::metadata(&log).unwrap().len(),
            seq: 1200,
        })
    );

    hide_completion(&log);
    let log_before = fs::read(&log).unwrap();
    let again = SessionPersistence::open(root.join("store")).await.unwrap();
    assert_eq!(fs::read(&log).unwrap(), log_before, "no rescan, no marker");
    drop(again);
    let _ = fs::remove_dir_all(root);
}

fn big_commands_update(seq: u64, description: &str) -> PersistedEventRecord {
    event(
        "session-1",
        seq,
        "commands_update",
        json!({"sessionId": "session-1", "availableCommands": [
            {"name": format!("cmd-{seq}"), "description": description}
        ]}),
    )
}

/// Lines far longer than the backward reader's first 16 KiB read, spanning
/// several of its doubling reads, are probed whole: a 40 KB prompt behind
/// 100 KB `commands_update` lines is found and swept, and a closed log ending
/// in such a line is stamped with that line's seq.
#[tokio::test]
async fn long_lines_across_read_boundaries_are_probed_whole() {
    let description = "d".repeat(100 * 1024);
    let prompt_text = "p".repeat(40 * 1024);
    for closed in [false, true] {
        let root = temp_dir(if closed { "long-closed" } else { "long-open" });
        let persistence = registered(&root, "session-1").await;
        persistence
            .enqueue_event(event(
                "session-1",
                1,
                "user_prompt",
                json!({"sessionId": "session-1", "turnId": "turn-1",
                       "content": [{"type": "text", "text": prompt_text}]}),
            ))
            .unwrap();
        let mut seq = 2;
        if closed {
            complete(&persistence, "session-1", seq, "turn-1");
            seq += 1;
        }
        let last_command = seq + 10;
        for seq in seq..=last_command {
            persistence
                .enqueue_event(big_commands_update(seq, &description))
                .unwrap();
        }
        let reopened = crash_and_reopen(persistence, &root).await;
        let log = messages_path(&reopened, "session-1");
        let markers = terminators(&reopened, "session-1");
        let stamped_seq = if closed {
            assert_eq!(markers.len(), 1, "only the real completion");
            last_command
        } else {
            assert_eq!(markers.len(), 1, "the open turn is swept");
            assert_eq!(markers[0].payload["turnId"], "turn-1");
            assert_eq!(markers[0].seq, last_command + 1);
            last_command + 1
        };
        assert_eq!(
            checkpoint_of(&reopened),
            Some(SweepCheckpoint {
                len: fs::metadata(&log).unwrap().len(),
                seq: stamped_seq,
            }),
            "closed={closed}"
        );
        drop(reopened);
        let _ = fs::remove_dir_all(root);
    }
}
