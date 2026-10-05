use super::*;

pub(super) async fn writer_loop(
    inner: Arc<Inner>,
    metadata: Arc<Mutex<SessionMetadata>>,
    unhealthy: Arc<Mutex<Option<String>>>,
    mut rx: mpsc::Receiver<WriterCommand>,
) {
    while let Some(command) = rx.recv().await {
        #[cfg(test)]
        {
            let gate = inner.writer_gate.lock().clone();
            if let Some(gate) = gate {
                gate.wait().await;
            }
        }
        let result = match command {
            WriterCommand::Append(record) => append_record(&inner.root, &metadata, record),
            WriterCommand::AppendLocalTitle(title, reply) => {
                let seq = metadata.lock().last_seq + 1;
                let session_id = metadata.lock().session_id.clone();
                let result = append_record(
                    &inner.root,
                    &metadata,
                    PersistedEventRecord {
                        schema_version: SESSION_SCHEMA_VERSION,
                        session_id: session_id.clone(),
                        seq,
                        type_: "local_title_generated".to_string(),
                        recorded_at: now_millis(),
                        payload: serde_json::json!({
                            "sessionId": session_id,
                            "title": title,
                        }),
                    },
                );
                let reply_result = result.as_ref().map(|()| seq).map_err(|error| {
                    SessionPersistenceError::PersistenceUnhealthy(error.to_string())
                });
                let _ = reply.send(reply_result);
                result
            }
            WriterCommand::AppendAgentSwitch(switch, reply) => {
                let seq = metadata.lock().last_seq + 1;
                let session_id = metadata.lock().session_id.clone();
                let result = append_record(
                    &inner.root,
                    &metadata,
                    PersistedEventRecord {
                        schema_version: SESSION_SCHEMA_VERSION,
                        session_id: session_id.clone(),
                        seq,
                        type_: "agent_switch".to_string(),
                        recorded_at: now_millis(),
                        payload: serde_json::to_value(&switch)
                            .unwrap_or_else(|_| serde_json::json!({ "sessionId": session_id })),
                    },
                );
                let reply_result = result.as_ref().map(|()| seq).map_err(|error| {
                    SessionPersistenceError::PersistenceUnhealthy(error.to_string())
                });
                let _ = reply.send(reply_result);
                result
            }
            WriterCommand::Flush(reply) => {
                let result = sync_session_files(&inner.root, &metadata);
                let _ = reply.send(result.clone_for_reply());
                result
            }
            WriterCommand::Finalize(status, reply) => {
                close_writer(&inner, &metadata, &unhealthy, Some(status), false, reply);
                return;
            }
            WriterCommand::Shutdown(reply) => {
                close_writer(&inner, &metadata, &unhealthy, None, false, reply);
                break;
            }
            // Process shutdown: marker (if the turn is open) then status
            // Closed. The command is behind queued appends, so those chunks
            // are already on disk when the scan runs.
            WriterCommand::ShutdownInterrupted(reply) => {
                close_writer(
                    &inner,
                    &metadata,
                    &unhealthy,
                    Some(PersistedSessionStatus::Closed),
                    true,
                    reply,
                );
                break;
            }
        };
        if let Err(error) = result {
            *unhealthy.lock() = Some(error.to_string());
        }
    }
}

/// Stop the writer after optionally appending the #842 interrupted marker.
///
/// `mark_interrupted` runs only once every `Append` queued ahead of this
/// command has been written, so the marker follows the final persisted
/// chunks. A scan failure is warn-logged and does not fail the close —
/// one unreadable transcript must not block shutdown of the rest.
fn close_writer(
    inner: &Inner,
    metadata: &Arc<Mutex<SessionMetadata>>,
    unhealthy: &Arc<Mutex<Option<String>>>,
    status: Option<PersistedSessionStatus>,
    mark_interrupted: bool,
    reply: oneshot::Sender<Result<()>>,
) {
    if mark_interrupted {
        append_interrupted_marker_if_open(&inner.root, metadata);
    }
    let snapshot = {
        let mut current = metadata.lock();
        if let Some(status) = status {
            current.status = status;
        }
        current.clone()
    };
    let result = persist_metadata_at_root(&inner.root, &snapshot)
        .and_then(|()| sync_session_files(&inner.root, metadata));
    let _ = reply.send(result.clone_for_reply());
    if let Err(error) = result {
        *unhealthy.lock() = Some(error.to_string());
    }
}

/// Issue #842: append `prompt_complete { stopReason: "interrupted" }` when
/// the last `user_prompt` has no matching completion. Sequence is assigned
/// here, after the queue drain, so it cannot collide with a chunk that was
/// still queued when shutdown began. Marker failures are logged and skipped.
fn append_interrupted_marker_if_open(root: &Path, metadata: &Arc<Mutex<SessionMetadata>>) {
    let (session_id, storage_key) = {
        let current = metadata.lock();
        (current.session_id.clone(), current.storage_key.clone())
    };
    let path = root.join(&storage_key).join(MESSAGES_FILE);
    let records = match load_jsonl(&path, &session_id, false) {
        Ok(records) => records,
        Err(error) => {
            log::warn!(
                "[acp-history] interrupted-marker scan failed for session {}: {error} \
                 (leaving history as-is)",
                crate::logging::redact_session_id(&session_id)
            );
            return;
        }
    };
    let Some(turn_id) = last_unmatched_user_prompt(&records) else {
        return;
    };
    let turn_id = turn_id.and_then(Value::as_str).map(str::to_owned);
    let seq = metadata.lock().last_seq + 1;
    let mut payload = serde_json::json!({
        "sessionId": session_id,
        "stopReason": "interrupted",
    });
    if let Some(turn_id) = turn_id {
        payload["turnId"] = serde_json::Value::String(turn_id);
    }
    let payload = normalize_durable_payload("prompt_complete", &payload);
    let record = PersistedEventRecord {
        schema_version: SESSION_SCHEMA_VERSION,
        session_id: session_id.clone(),
        seq,
        type_: "prompt_complete".to_string(),
        recorded_at: now_millis(),
        payload,
    };
    if let Err(error) = append_record(root, metadata, record) {
        log::warn!(
            "[acp-history] failed to append interrupted marker for session {}: {error}",
            crate::logging::redact_session_id(&session_id)
        );
    } else {
        log::info!(
            "[acp-history] appended interrupted prompt_complete marker session={} seq={}",
            crate::logging::redact_session_id(&session_id),
            seq
        );
    }
}

pub(super) trait CloneForReply<T> {
    fn clone_for_reply(&self) -> Result<T>;
}
impl CloneForReply<()> for Result<()> {
    fn clone_for_reply(&self) -> Result<()> {
        match self {
            Ok(()) => Ok(()),
            Err(error) => Err(SessionPersistenceError::PersistenceUnhealthy(
                error.to_string(),
            )),
        }
    }
}

pub(super) fn append_record(
    root: &Path,
    metadata: &Arc<Mutex<SessionMetadata>>,
    record: PersistedEventRecord,
) -> Result<()> {
    let mut current = metadata.lock();
    if record.session_id != current.session_id
        || record.schema_version != SESSION_SCHEMA_VERSION
        || record.seq <= current.last_seq
    {
        return Err(SessionPersistenceError::CorruptSession);
    }
    let dir = root.join(&current.storage_key);
    let path = dir.join(if is_tool_event(&record.type_) {
        TOOL_CALLS_FILE
    } else {
        MESSAGES_FILE
    });
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    let bytes = serde_json::to_vec(&record)?;
    file.write_all(&bytes)?;
    file.write_all(b"\n")?;
    file.flush()?;
    current.last_seq = record.seq;
    current.last_activity_at = record.recorded_at;
    if is_tool_event(&record.type_) {
        current.tool_count += 1;
        // A tool call is a fold boundary: it closes the open chunk run (the
        // next chunk opens a fresh bubble). `tool_call_update` is NOT — it
        // never splits a run in the materializer.
        if record.type_ == "tool_call" {
            current.fold_open_role = None;
        }
    } else {
        // Issue #844c: `message_count` mirrors the payload materializer's
        // fold EXACTLY — a record counts iff `fold_step` says it opens a
        // bubble. The old rule (any non-tool non-switch record) counted
        // usage/plan/mode updates too, so the index drifted above the
        // materialized `messages.len()` for every session with metadata
        // events. `fold_open_role` tracks the open chunk run so coalesced
        // `message_chunk`s do not double-count.
        // Map the persisted open-role string to its static fold-bucket
        // label before the mutable mutations below (a `&str` borrowed from
        // `current` cannot live past them).
        let open_role: Option<&'static str> = match current.fold_open_role.as_deref() {
            Some("thought") => Some("thought"),
            Some("agent") => Some("agent"),
            _ => None,
        };
        let state = FoldState { open_role };
        let (next, opens_message) = fold_step(state, &record.type_, &record.payload);
        if opens_message {
            current.message_count += 1;
        }
        current.fold_open_role = next.open_role.map(str::to_string);
    }
    if record.type_ == "user_prompt" && current.title.is_none() {
        current.title = Some(derive_title(&record.payload));
        current.title_source = Some(TitleSource::DerivedFirstMessage);
    }
    if record.type_ == "local_title_generated" {
        // AD-1: BackgroundGenerated wins over AgentSupplied and
        // DerivedFirstMessage. The host's background title-gen flow is the
        // sole emitter of this durable event (the manager enqueues it after a
        // successful background turn). A non-empty title here always wins
        // because the manager skips persistence when normalize_title returns
        // the "Untitled Chat" fallback floor (AD-6).
        let bg_title = record
            .payload
            .get("title")
            .and_then(Value::as_str)
            .map(normalize_title);
        if let Some(title) = bg_title {
            current.title = Some(title);
            current.title_source = Some(TitleSource::BackgroundGenerated);
        }
    }
    if record.type_ == "session_info_update" {
        // AD-1: once BackgroundGenerated/LocalAlias owns the title, a later
        // agent-supplied session_info_update must NOT overwrite it. Also set
        // the provenance to AgentSupplied on the non-protected path so a
        // subsequent background title (which DOES overwrite AgentSupplied)
        // still wins over the agent's pick.
        let agent_title = record
            .payload
            .get("title")
            .and_then(Value::as_str)
            .map(normalize_title);
        if !is_protected_title_source(current.title_source.as_ref()) {
            current.title = agent_title;
            current.title_source = Some(TitleSource::AgentSupplied);
        }
    }
    Ok(())
}

pub(super) fn sync_session_files(
    root: &Path,
    metadata: &Arc<Mutex<SessionMetadata>>,
) -> Result<()> {
    let current = metadata.lock().clone();
    let dir = root.join(&current.storage_key);
    for name in [MESSAGES_FILE, TOOL_CALLS_FILE] {
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join(name))?
            .sync_all()?;
    }
    persist_metadata_at_root(root, &current)
}

pub(super) fn persist_metadata_at_root(root: &Path, metadata: &SessionMetadata) -> Result<()> {
    let path = root.join(&metadata.storage_key).join(METADATA_FILE);
    atomic_file::replace(&path, &serde_json::to_vec_pretty(metadata)?)?;
    Ok(())
}

pub(super) fn ensure_log_exists(path: &Path) -> Result<()> {
    if !path.exists() {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)?;
        file.sync_all()?;
    }
    Ok(())
}
