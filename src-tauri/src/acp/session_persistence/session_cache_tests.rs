use super::*;
use serde_json::json;

fn temp_dir(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "termul-session-cache-{label}-{}-{}",
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
    let mut payload = payload;
    payload["agentId"] = json!("runtime-1");
    payload["sessionId"] = json!("session-1");
    PersistedEventRecord {
        schema_version: SESSION_SCHEMA_VERSION,
        session_id: "session-1".to_string(),
        seq,
        type_: type_.to_string(),
        recorded_at: 1_000 + seq,
        payload,
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
            {"value": "haiku", "name": "Haiku"},
        ],
    })
}

fn config_update(seq: u64, current: &str) -> PersistedEventRecord {
    event(
        seq,
        "config_options_update",
        json!({"configOptions": [model_select(current)]}),
    )
}

fn commands_update(seq: u64, name: &str) -> PersistedEventRecord {
    event(
        seq,
        "commands_update",
        json!({"availableCommands": [{"name": name, "description": "command"}]}),
    )
}

/// `session_created` at 1, the kept model switch at 2, the kept command list
/// at 3, then ten turns (seq 4..=33).
fn enqueue_kept_log(persistence: &SessionPersistence) {
    persistence
        .enqueue_event(event(
            1,
            "session_created",
            json!({"configOptions": [model_select("sonnet")]}),
        ))
        .unwrap();
    persistence.enqueue_event(config_update(2, "opus")).unwrap();
    persistence
        .enqueue_event(commands_update(3, "kept"))
        .unwrap();
    for turn in 0..10u64 {
        let seq = 4 + turn * 3;
        let turn_id = format!("turn-{seq}");
        for (seq, type_, payload) in [
            (
                seq,
                "user_prompt",
                json!({"turnId": turn_id, "content": [{"type": "text", "text": "prompt"}]}),
            ),
            (
                seq + 1,
                "message_chunk",
                json!({"role": "agent", "content": {"type": "text", "text": "reply"}}),
            ),
            (
                seq + 2,
                "prompt_complete",
                json!({"turnId": turn_id, "stopReason": "end_turn"}),
            ),
        ] {
            persistence
                .enqueue_event(event(seq, type_, payload))
                .unwrap();
        }
    }
}

/// Splice seq-intruder controls and commands records (seq <= the running
/// max) into the log far before the tail window, so a tail read scans them
/// into both caches without tripping the salvage itself.
fn splice_intruders(messages_path: &Path) {
    let original = fs::read(messages_path).unwrap();
    let offset = original
        .iter()
        .enumerate()
        .filter(|(_, byte)| **byte == b'\n')
        .nth(5)
        .map(|(index, _)| index + 1)
        .unwrap();
    let mut spliced = original[..offset].to_vec();
    for record in [config_update(5, "haiku"), commands_update(6, "intruder")] {
        spliced.extend(serde_json::to_vec(&record).unwrap());
        spliced.push(b'\n');
    }
    spliced.extend_from_slice(&original[offset..]);
    fs::write(messages_path, spliced).unwrap();
}

/// A store whose log carries both intruders, reopened so both caches start
/// unseeded. Returns the store and the session directory.
async fn reopened_with_intruders(root: &Path) -> (Arc<SessionPersistence>, PathBuf) {
    reopened(root, true).await
}

/// The kept log, spliced with intruders when `intruders`, in a store
/// reopened so both caches start unseeded.
async fn reopened(root: &Path, intruders: bool) -> (Arc<SessionPersistence>, PathBuf) {
    let persistence = registered(root).await;
    enqueue_kept_log(&persistence);
    persistence.flush_session("session-1").await.unwrap();
    persistence.shutdown().await.unwrap();
    let metadata = persistence.metadata("session-1").unwrap();
    let dir = persistence.session_dir(&metadata.storage_key).unwrap();
    drop(persistence);
    if intruders {
        splice_intruders(&dir.join(MESSAGES_FILE));
    }
    let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
    (reopened, dir)
}

/// The model and command list a tail payload restores, as `(model, command)`.
async fn tail_values(persistence: &Arc<SessionPersistence>) -> (Value, Value) {
    let tail = persistence
        .session_payload_tail_async("session-1", 4)
        .await
        .unwrap();
    let wire = serde_json::to_value(&tail).unwrap();
    (
        wire["configOptions"][0]["currentValue"].clone(),
        wire["commands"][0]["name"].clone(),
    )
}

#[tokio::test]
async fn a_tail_read_after_salvage_drops_the_removed_controls_and_commands() {
    let root = temp_dir("salvage-success");
    let (persistence, dir) = reopened_with_intruders(&root).await;
    assert_eq!(
        tail_values(&persistence).await,
        (json!("haiku"), json!("intruder")),
        "the pre-repair tail read caches the intruder values"
    );

    // The full read trips over the intruders and salvages the log.
    persistence
        .session_payload_async("session-1")
        .await
        .unwrap();
    assert_eq!(corrupt_backups(&dir), 1, "the salvage rewrote the log");

    assert_eq!(
        tail_values(&persistence).await,
        (json!("opus"), json!("kept")),
        "neither cache may serve a value the salvage removed"
    );
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn a_salvage_that_fails_after_rewriting_still_invalidates_both_caches() {
    let root = temp_dir("salvage-error");
    let (persistence, dir) = reopened_with_intruders(&root).await;
    assert_eq!(
        tail_values(&persistence).await,
        (json!("haiku"), json!("intruder"))
    );

    // A non-empty directory where `metadata.json` belongs makes the
    // post-rewrite metadata write fail: the log has changed, the heal errors.
    let metadata_path = dir.join(METADATA_FILE);
    let metadata_bytes = fs::read(&metadata_path).unwrap();
    fs::remove_file(&metadata_path).unwrap();
    fs::create_dir_all(metadata_path.join("blocker")).unwrap();
    assert!(persistence
        .session_payload_async("session-1")
        .await
        .is_err());
    assert_eq!(
        corrupt_backups(&dir),
        1,
        "the rewrite landed before the error"
    );
    fs::remove_dir_all(&metadata_path).unwrap();
    fs::write(&metadata_path, metadata_bytes).unwrap();

    assert_eq!(
        tail_values(&persistence).await,
        (json!("opus"), json!("kept")),
        "a failed heal that changed the log must not leave stale cache entries"
    );
    let _ = fs::remove_dir_all(root);
}

fn corrupt_backups(dir: &Path) -> usize {
    fs::read_dir(dir)
        .unwrap()
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().contains("corrupt-"))
        .count()
}

#[derive(Debug, Clone, Copy)]
enum Cached {
    Commands,
    Controls,
}

/// The value one cache serves: the command name or the model selection.
async fn read(persistence: &Arc<SessionPersistence>, cached: Cached) -> Value {
    match cached {
        Cached::Commands => persistence
            .last_commands_async("session-1")
            .await
            .unwrap()
            .map_or(Value::Null, |list| list.commands[0]["name"].clone()),
        Cached::Controls => persistence
            .last_controls_async("session-1")
            .await
            .unwrap()
            .and_then(|controls| controls.config_options)
            .map_or(Value::Null, |options| options[0]["currentValue"].clone()),
    }
}

fn kept(cached: Cached) -> Value {
    match cached {
        Cached::Commands => json!("kept"),
        Cached::Controls => json!("opus"),
    }
}

/// Start a read of `cached` and return once its scan has read the
/// pre-repair log and paused before seeding.
async fn paused_read(
    persistence: &Arc<SessionPersistence>,
    cached: Cached,
) -> (Arc<ReplayTestHook>, tokio::task::JoinHandle<Value>) {
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let hook = ReplayTestHook::new(entered_tx);
    persistence.set_cache_scan_test_hook(Arc::clone(&hook));
    let reader = {
        let persistence = Arc::clone(persistence);
        tokio::spawn(async move { read(&persistence, cached).await })
    };
    tokio::task::spawn_blocking(move || entered_rx.recv())
        .await
        .unwrap()
        .expect("the scan paused before seeding");
    (hook, reader)
}

async fn assert_an_overtaken_scan_rescans_the_repaired_log(cached: Cached) {
    let root = temp_dir(&format!("overtaken-{cached:?}"));
    let (persistence, dir) = reopened_with_intruders(&root).await;
    let (hook, reader) = paused_read(&persistence, cached).await;

    // Salvage while the scan of the pre-repair log is paused.
    persistence.replay_after("session-1", 0).unwrap();
    assert_eq!(corrupt_backups(&dir), 1, "the salvage rewrote the log");
    hook.release();

    assert_eq!(
        reader.await.unwrap(),
        kept(cached),
        "{cached:?}: the overtaken scan must not seed the removed value"
    );
    assert_eq!(hook.waits(), 2, "{cached:?}: the rejected scan ran again");
    assert_eq!(read(&persistence, cached).await, kept(cached));
    assert_eq!(hook.waits(), 2, "{cached:?}: the rescan seeded the cache");
    let _ = fs::remove_dir_all(root);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_controls_scan_overtaken_by_salvage_rescans_the_repaired_log() {
    assert_an_overtaken_scan_rescans_the_repaired_log(Cached::Controls).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_commands_scan_overtaken_by_salvage_rescans_the_repaired_log() {
    assert_an_overtaken_scan_rescans_the_repaired_log(Cached::Commands).await;
}

async fn assert_an_append_after_salvage_beats_the_overtaken_scan(cached: Cached) {
    let root = temp_dir(&format!("append-{cached:?}"));
    let (persistence, _) = reopened_with_intruders(&root).await;
    persistence.reopen_writer("session-1").await.unwrap();
    let (hook, reader) = paused_read(&persistence, cached).await;

    persistence.replay_after("session-1", 0).unwrap();
    let (record, expected) = appended(cached);
    persistence.enqueue_event(record).unwrap();
    // The writer applies the append to the cache once it is on disk.
    persistence.flush_session("session-1").await.unwrap();
    hook.release();

    assert_eq!(
        reader.await.unwrap(),
        expected,
        "{cached:?}: the append outranks the scans"
    );
    persistence.flush_session("session-1").await.unwrap();
    assert_eq!(read(&persistence, cached).await, expected);
    persistence.shutdown().await.unwrap();
    let _ = fs::remove_dir_all(root);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_controls_append_after_salvage_beats_the_overtaken_scan() {
    assert_an_append_after_salvage_beats_the_overtaken_scan(Cached::Controls).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_commands_append_after_salvage_beats_the_overtaken_scan() {
    assert_an_append_after_salvage_beats_the_overtaken_scan(Cached::Commands).await;
}

fn appended(cached: Cached) -> (PersistedEventRecord, Value) {
    match cached {
        Cached::Commands => (commands_update(40, "appended"), json!("appended")),
        Cached::Controls => (config_update(40, "sonnet"), json!("sonnet")),
    }
}

/// An append queued before a salvage but written after it: the salvage's
/// forget must not erase it, even when a scan of the rewritten log (which
/// lacks it) seeds the cache in between.
async fn assert_an_append_queued_across_a_salvage_survives_its_forget(cached: Cached) {
    let root = temp_dir(&format!("queued-{cached:?}"));
    let (persistence, dir) = reopened_with_intruders(&root).await;
    persistence.reopen_writer("session-1").await.unwrap();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let writer_gate = ReplayTestHook::new(entered_tx);
    persistence.set_writer_gate_test_hook(Arc::clone(&writer_gate));

    let (record, expected) = appended(cached);
    persistence.enqueue_event(record).unwrap();
    tokio::task::spawn_blocking(move || entered_rx.recv())
        .await
        .unwrap()
        .expect("the writer paused before writing the append");
    persistence.replay_after("session-1", 0).unwrap();
    assert_eq!(corrupt_backups(&dir), 1, "the salvage rewrote the log");
    assert_eq!(
        read(&persistence, cached).await,
        kept(cached),
        "{cached:?}: a read before the write scans the rewritten log"
    );

    writer_gate.release();
    persistence.flush_session("session-1").await.unwrap();
    assert_eq!(
        read(&persistence, cached).await,
        expected,
        "{cached:?}: the written append replaces the older scan"
    );
    persistence.shutdown().await.unwrap();
    let _ = fs::remove_dir_all(root);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_controls_append_queued_across_a_salvage_survives_its_forget() {
    assert_an_append_queued_across_a_salvage_survives_its_forget(Cached::Controls).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_commands_append_queued_across_a_salvage_survives_its_forget() {
    assert_an_append_queued_across_a_salvage_survives_its_forget(Cached::Commands).await;
}

async fn assert_a_forget_of_another_session_keeps_the_scan(cached: Cached) {
    let root = temp_dir(&format!("other-{cached:?}"));
    let (persistence, _) = reopened(&root, false).await;
    let (hook, reader) = paused_read(&persistence, cached).await;

    persistence.forget_log_derived("session-2");
    hook.release();

    assert_eq!(reader.await.unwrap(), kept(cached));
    assert_eq!(
        hook.waits(),
        1,
        "{cached:?}: another session's forget must not reject the scan"
    );
    let _ = fs::remove_dir_all(root);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_controls_scan_survives_a_forget_of_another_session() {
    assert_a_forget_of_another_session_keeps_the_scan(Cached::Controls).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_commands_scan_survives_a_forget_of_another_session() {
    assert_a_forget_of_another_session_keeps_the_scan(Cached::Commands).await;
}

/// Every lock-free scan loses to a forget of its session: the read neither
/// fails nor returns an unseeded scan, it scans once more under the session
/// lock and seeds that.
async fn assert_a_read_that_keeps_losing_scans_under_the_session_lock(cached: Cached) {
    let root = temp_dir(&format!("locked-{cached:?}"));
    let (persistence, _) = reopened(&root, false).await;
    let forgets = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let callback = {
        let persistence = Arc::downgrade(&persistence);
        let forgets = Arc::clone(&forgets);
        Arc::new(move || {
            forgets.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if let Some(persistence) = persistence.upgrade() {
                persistence.forget_log_derived("session-1");
            }
        })
    };
    persistence.set_cache_scan_test_callback(callback);

    assert_eq!(read(&persistence, cached).await, kept(cached));
    assert_eq!(
        forgets.load(std::sync::atomic::Ordering::SeqCst),
        UNLOCKED_SCAN_ATTEMPTS,
        "{cached:?}: every lock-free scan was overtaken"
    );
    assert_eq!(read(&persistence, cached).await, kept(cached));
    assert_eq!(
        forgets.load(std::sync::atomic::Ordering::SeqCst),
        UNLOCKED_SCAN_ATTEMPTS,
        "{cached:?}: the locked scan seeded the cache"
    );
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn a_controls_read_that_keeps_losing_scans_under_the_session_lock() {
    assert_a_read_that_keeps_losing_scans_under_the_session_lock(Cached::Controls).await;
}

#[tokio::test]
async fn a_commands_read_that_keeps_losing_scans_under_the_session_lock() {
    assert_a_read_that_keeps_losing_scans_under_the_session_lock(Cached::Commands).await;
}

/// Whether `cached` holds an entry that serves the session.
fn is_cached(persistence: &SessionPersistence, cached: Cached) -> bool {
    match cached {
        Cached::Commands => persistence.inner.last_commands.lookup("session-1").is_ok(),
        Cached::Controls => persistence.inner.last_controls.lookup("session-1").is_ok(),
    }
}

/// The locked last resort clones the catalog entry, then a delete removes
/// the session and forgets it before the scan takes its ticket. The log is
/// still on disk (the delete removes it last), so the scan reads it: the
/// read must report the session gone and leave nothing cached.
async fn assert_a_locked_scan_overtaken_by_a_delete_leaves_nothing_cached(cached: Cached) {
    let root = temp_dir(&format!("locked-delete-{cached:?}"));
    let (persistence, _) = reopened(&root, false).await;
    let forget = {
        let persistence = Arc::downgrade(&persistence);
        Arc::new(move || {
            if let Some(persistence) = persistence.upgrade() {
                persistence.forget_log_derived("session-1");
            }
        })
    };
    persistence.set_cache_scan_test_callback(forget);
    let delete = {
        let persistence = Arc::downgrade(&persistence);
        Arc::new(move || {
            if let Some(persistence) = persistence.upgrade() {
                // `delete_session`'s order: the catalog entry, then the caches.
                persistence.remove_catalog_entry("session-1");
                persistence.forget_log_derived("session-1");
            }
        })
    };
    persistence.set_locked_scan_test_callback(delete);

    let result = match cached {
        Cached::Commands => persistence.last_commands_async("session-1").await.map(drop),
        Cached::Controls => persistence.last_controls_async("session-1").await.map(drop),
    };
    assert!(
        matches!(result, Err(SessionPersistenceError::SessionNotFound)),
        "{cached:?}: the read must report the deleted session gone, got {result:?}"
    );
    assert!(
        !is_cached(&persistence, cached),
        "{cached:?}: the deleted session's log must not stay cached"
    );
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn a_controls_locked_scan_overtaken_by_a_delete_leaves_nothing_cached() {
    assert_a_locked_scan_overtaken_by_a_delete_leaves_nothing_cached(Cached::Controls).await;
}

#[tokio::test]
async fn a_commands_locked_scan_overtaken_by_a_delete_leaves_nothing_cached() {
    assert_a_locked_scan_overtaken_by_a_delete_leaves_nothing_cached(Cached::Commands).await;
}

/// The writer applies an append to the caches before it releases the
/// session's entry lock, so a salvage cannot rewrite the log and forget the
/// session between the write and the apply.
async fn assert_the_writer_applies_an_append_under_the_entry_lock(cached: Cached) {
    let root = temp_dir(&format!("apply-locked-{cached:?}"));
    let (persistence, _) = reopened(&root, false).await;
    persistence.reopen_writer("session-1").await.unwrap();
    let entry = persistence
        .inner
        .catalog
        .lock()
        .get("session-1")
        .cloned()
        .unwrap();
    let observed = Arc::new(Mutex::new(Vec::new()));
    let callback = {
        let observed = Arc::clone(&observed);
        Arc::new(move || observed.lock().push(entry.is_locked()))
    };
    persistence.set_cache_apply_test_callback(callback);

    let (record, expected) = appended(cached);
    persistence.enqueue_event(record).unwrap();
    persistence.flush_session("session-1").await.unwrap();

    assert_eq!(
        *observed.lock(),
        vec![true],
        "{cached:?}: the append was applied once, under the entry lock"
    );
    assert_eq!(read(&persistence, cached).await, expected);
    persistence.shutdown().await.unwrap();
    let _ = fs::remove_dir_all(root);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_writer_applies_a_controls_append_under_the_entry_lock() {
    assert_the_writer_applies_an_append_under_the_entry_lock(Cached::Controls).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_writer_applies_a_commands_append_under_the_entry_lock() {
    assert_the_writer_applies_an_append_under_the_entry_lock(Cached::Commands).await;
}

fn command_list(name: &str, seq: u64) -> Option<CommandList> {
    CommandList::of_record(&commands_update(seq, name))
}

#[test]
fn a_seed_from_before_a_forget_is_rejected() {
    let cache = SessionCache::<Option<CommandList>>::default();
    let ticket = cache.lookup("session-1").unwrap_err();
    cache.forget("session-1");
    assert_eq!(
        cache.seed("session-1", ticket, command_list("stale", 3)),
        None
    );
    let fresh = cache.lookup("session-1").unwrap_err();
    assert_ne!(fresh, ticket, "a forget moves the generation on");
    assert_eq!(
        cache.seed("session-1", fresh, command_list("kept", 3)),
        Some(command_list("kept", 3))
    );
}

#[test]
fn a_seed_keeps_a_list_appended_while_it_scanned() {
    let cache = SessionCache::<Option<CommandList>>::default();
    cache.forget("session-1");
    let ticket = cache.lookup("session-1").unwrap_err();
    cache.update("session-1", |entry| *entry = command_list("appended", 40));
    assert_eq!(
        cache.seed("session-1", ticket, command_list("kept", 3)),
        Some(command_list("appended", 40))
    );
}

#[test]
fn a_forget_rejects_only_its_own_sessions_scans() {
    let cache = SessionCache::<Option<CommandList>>::default();
    let ticket = cache.lookup("session-1").unwrap_err();
    let other = cache.lookup("session-2").unwrap_err();
    cache.forget("session-2");
    assert_eq!(
        cache.seed("session-1", ticket, command_list("kept", 3)),
        Some(command_list("kept", 3)),
        "another session's forget leaves the ticket valid"
    );
    assert_eq!(
        cache.seed("session-2", other, command_list("stale", 3)),
        None
    );
}
