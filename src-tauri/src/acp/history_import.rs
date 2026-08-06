//! Idempotent import of legacy desktop `ChatHistoryStore` payloads into the
//! host-owned `SessionPersistence` (CAP-2 host-owned history).
//!
//! The legacy store stays read-only here: entries are synthesized into durable
//! records (`user_prompt` / `message_chunk` / `prompt_complete`) so the
//! Story-1 materializer can serve them with the exact renderer payload shape.
//! The import is incremental and idempotent — sessions already known to the
//! host store are skipped — so it can run at every startup and again after the
//! renderer's legacy wipe-migration completes.

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value};

use crate::acp::session_persistence::SESSION_SCHEMA_VERSION;
use crate::acp::{
    atomic_file, ChatHistoryStore, PersistedEventRecord, PersistedSessionStatus,
    SessionPersistence, SessionRegistration,
};

/// Records every session id ever imported from the legacy store. Needed so a
/// user `delete_session` on an imported session STICKS: without it the next
/// startup import would see the id missing from the catalog and resurrect it
/// from the (read-only) legacy archive.
const IMPORTED_LEDGER_FILE: &str = "legacy-imported.json";

fn load_imported(persistence: &SessionPersistence) -> HashSet<String> {
    let path = persistence.root().join(IMPORTED_LEDGER_FILE);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(_) => return HashSet::new(),
    };
    match serde_json::from_slice::<Vec<String>>(&bytes) {
        Ok(ids) => ids.into_iter().collect(),
        Err(error) => {
            // A corrupt/truncated ledger is indistinguishable from a missing
            // file (empty set), which loses deletion finality for imported
            // sessions (the next import resurrects deleted ones). Surface the
            // loss so it is visible rather than silent.
            log::warn!("[acp-history] legacy-import ledger unreadable: {error}");
            HashSet::new()
        }
    }
}

fn persist_imported(persistence: &SessionPersistence, imported: &HashSet<String>) {
    let mut ids: Vec<&String> = imported.iter().collect();
    ids.sort();
    let path = persistence.root().join(IMPORTED_LEDGER_FILE);
    let result = serde_json::to_vec_pretty(&ids)
        .map_err(|error| error.to_string())
        .and_then(|bytes| atomic_file::replace(&path, &bytes).map_err(|error| error.to_string()));
    if let Err(error) = result {
        // Non-fatal: a lost ledger only means a future startup could re-import
        // an already-deleted session; the import itself stays correct.
        log::warn!("[acp-history] failed to persist legacy-import ledger: {error}");
    }
}

/// Import every legacy session unknown to the host store. Returns the number
/// of newly imported sessions. Fail-open per entry: a corrupt or unreadable
/// payload is skipped with a warn and never blocks the remaining imports.
/// Sessions previously imported (even if since deleted) stay deleted via the
/// imported-id ledger.
pub async fn import_chat_history(
    persistence: &Arc<SessionPersistence>,
    chat_history: &Arc<ChatHistoryStore>,
) -> usize {
    let mut ledger = load_imported(persistence);
    let (entries, _) = chat_history.list();
    let mut imported = 0usize;
    for entry in entries {
        // Skip live catalog members AND anything imported before (deleted or
        // not) — the ledger keeps user deletions final across restarts.
        if persistence.metadata(&entry.id).is_ok() || ledger.contains(&entry.id) {
            continue;
        }
        match import_session(persistence, chat_history, &entry.id).await {
            Ok(()) => {
                imported += 1;
                ledger.insert(entry.id.clone());
            }
            Err(error) => {
                log::warn!(
                    "[acp-history] legacy import skipped session_id={:?} error={error}",
                    entry.id
                );
            }
        }
    }
    if imported > 0 {
        persist_imported(persistence, &ledger);
        log::info!("[acp-history] legacy import finished imported={imported}");
    }
    imported
}

async fn import_session(
    persistence: &Arc<SessionPersistence>,
    chat_history: &Arc<ChatHistoryStore>,
    session_id: &str,
) -> Result<(), String> {
    let payload = chat_history.get(session_id).map_err(|error| error.to_string())?;
    let metadata = payload
        .get("metadata")
        .and_then(Value::as_object)
        .ok_or("missing metadata")?;
    let cwd = metadata
        .get("cwd")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    // Degraded legacy entries (browser sessions mirrored with empty cwd) were
    // never visible in the project-scoped sidebar; skipping them preserves
    // exactly what the user could see before the ownership transfer.
    if cwd.is_empty() {
        return Err("empty cwd (degraded legacy entry)".to_string());
    }
    let messages = payload
        .get("messages")
        .and_then(Value::as_array)
        .ok_or("missing messages")?
        .clone();
    let agent_id = metadata
        .get("agentId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let agent_config_id = metadata.get("agentConfigId").and_then(Value::as_str);
    let project_id = metadata
        .get("projectId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    let created_at = metadata
        .get("createdAt")
        .and_then(Value::as_u64)
        .unwrap_or_else(crate::acp::session_persistence::now_millis);
    let title = metadata
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let status = metadata
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("closed")
        .to_string();

    let registration = SessionRegistration {
        session_id: session_id.to_string(),
        stable_agent_namespace: agent_config_id.map(|config_id| format!("config:{config_id}")),
        runtime_agent_id: (!agent_id.is_empty()).then(|| agent_id.clone()),
        project_id: project_id.map(str::to_string),
        cwd: PathBuf::from(cwd),
    };
    persistence
        .register_imported_session(registration, created_at, title)
        .await
        .map_err(|error| error.to_string())?;

    // Imported sessions are archives: the live agent (if any died with the old
    // renderer) is not attached. `Error` survives; every other historical
    // status settles to `Closed` (restart semantics).
    let final_status = if status == "error" {
        PersistedSessionStatus::Error
    } else {
        PersistedSessionStatus::Closed
    };
    let written = async {
        for record in synthesize_records(session_id, &agent_id, &messages) {
            persistence
                .enqueue_event(record)
                .map_err(|error| error.to_string())?;
        }
        persistence
            .flush_session(session_id)
            .await
            .map_err(|error| error.to_string())?;
        persistence
            .finalize_session(session_id, final_status)
            .await
            .map_err(|error| error.to_string())
    }
    .await;
    if written.is_err() {
        // Roll back the registration: a half-written session would otherwise
        // satisfy the catalog-membership guard (`persistence.metadata(&id)
        // .is_ok()`) on every later startup and be skipped forever, leaving a
        // truncated, never-finalized transcript that no retry can repair.
        // Dropping it lets the next startup retry the import cleanly.
        let _ = persistence.delete_session(session_id).await;
    }
    written
}

/// Fold a legacy renderer `ChatMessage[]` into synthetic durable records.
///
/// - `user` message → one `user_prompt` record carrying its blocks; the id's
///   `turn:` suffix (or the whole id) becomes the durable `turnId`.
/// - `agent` / `thought` message → one `message_chunk` record per content
///   block (the materializer coalesces consecutive text exactly like the
///   renderer's `appendBlocks` did when the bubble was originally built).
/// - `prompt_complete` closes a turn that received at least one response, so
///   the fold keeps the original turn boundaries and the relay watermark stays
///   consistent with the transcript.
fn synthesize_records(
    session_id: &str,
    agent_id: &str,
    messages: &[Value],
) -> Vec<PersistedEventRecord> {
    let mut records: Vec<PersistedEventRecord> = Vec::new();
    let mut seq: u64 = 0;
    // (turn_id, responded, last response timestamp) of the turn in flight.
    let mut open_turn: Option<(String, bool, u64)> = None;

    for message in messages {
        let role = message.get("role").and_then(Value::as_str).unwrap_or("");
        let timestamp = message
            .get("timestamp")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let blocks: Vec<Value> = message
            .get("blocks")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        match role {
            "user" => {
                close_turn(&mut records, &mut seq, &mut open_turn, session_id, agent_id);
                let id = message.get("id").and_then(Value::as_str).unwrap_or("");
                let turn_id = id.strip_prefix("turn:").unwrap_or(id).to_string();
                seq += 1;
                records.push(PersistedEventRecord {
                    schema_version: SESSION_SCHEMA_VERSION,
                    session_id: session_id.to_string(),
                    seq,
                    type_: "user_prompt".to_string(),
                    recorded_at: timestamp,
                    payload: json!({
                        "agentId": agent_id,
                        "sessionId": session_id,
                        "turnId": turn_id,
                        "content": blocks,
                    }),
                });
                open_turn = Some((turn_id, false, timestamp));
            }
            "agent" | "thought" => {
                for block in blocks {
                    seq += 1;
                    records.push(PersistedEventRecord {
                        schema_version: SESSION_SCHEMA_VERSION,
                        session_id: session_id.to_string(),
                        seq,
                        type_: "message_chunk".to_string(),
                        recorded_at: timestamp,
                        payload: json!({
                            "agentId": agent_id,
                            "sessionId": session_id,
                            "role": role,
                            "content": block,
                        }),
                    });
                }
                if let Some((_, responded, last_at)) = open_turn.as_mut() {
                    *responded = true;
                    *last_at = timestamp;
                }
            }
            // Unknown roles never reach history payloads; drop them.
            _ => {}
        }
    }
    close_turn(&mut records, &mut seq, &mut open_turn, session_id, agent_id);
    records
}

/// Emit `prompt_complete` for the turn in flight when it received at least one
/// response, so the fold keeps the original turn boundaries and the relay
/// watermark stays consistent with the transcript.
fn close_turn(
    records: &mut Vec<PersistedEventRecord>,
    seq: &mut u64,
    open_turn: &mut Option<(String, bool, u64)>,
    session_id: &str,
    agent_id: &str,
) {
    if let Some((turn_id, responded, completed_at)) = open_turn.take() {
        if responded {
            *seq += 1;
            records.push(PersistedEventRecord {
                schema_version: SESSION_SCHEMA_VERSION,
                session_id: session_id.to_string(),
                seq: *seq,
                type_: "prompt_complete".to_string(),
                recorded_at: completed_at,
                payload: json!({
                    "agentId": agent_id,
                    "sessionId": session_id,
                    "turnId": turn_id,
                }),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::session_persistence::SessionPersistenceError;

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "termul-history-import-{label}-{}-{}",
            std::process::id(),
            crate::acp::session_persistence::now_millis()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn legacy_payload(
        session_id: &str,
        cwd: &str,
        status: &str,
        messages: Value,
    ) -> Value {
        json!({
            "metadata": {
                "id": session_id,
                "agentId": "agent-1",
                "agentConfigId": "claude-1",
                "title": "Legacy title",
                "cwd": cwd,
                "projectId": "project-1",
                "createdAt": 1_700_000_000_000_u64,
                "lastActivityAt": 1_700_000_060_000_u64,
                "messageCount": 3,
                "lastSeq": 0,
                "status": status,
            },
            "messages": messages,
        })
    }

    fn turn_messages() -> Value {
        json!([
            {
                "id": "turn:turn-1",
                "role": "user",
                "blocks": [{"type": "text", "text": "hello"}],
                "streaming": false,
                "timestamp": 1_700_000_010_000_u64,
            },
            {
                "id": "snap-agent",
                "role": "agent",
                "blocks": [{"type": "text", "text": "world"}, {"type": "text", "text": " again"}],
                "streaming": false,
                "timestamp": 1_700_000_020_000_u64,
            },
        ])
    }

    async fn setup(
        label: &str,
    ) -> (
        PathBuf,
        Arc<SessionPersistence>,
        Arc<ChatHistoryStore>,
    ) {
        let root = temp_dir(label);
        std::fs::create_dir_all(root.join("cwd")).unwrap();
        let persistence = SessionPersistence::open(root.join("store"))
            .await
            .unwrap();
        let chat_history = ChatHistoryStore::open(root.join("legacy")).unwrap();
        (root, persistence, chat_history)
    }

    #[tokio::test]
    async fn imports_legacy_sessions_with_provenance_and_round_trip() {
        let (root, persistence, chat_history) = setup("roundtrip").await;
        let cwd = root.join("cwd").to_string_lossy().into_owned();
        chat_history
            .save("legacy-1", legacy_payload("legacy-1", &cwd, "closed", turn_messages()))
            .unwrap();

        assert_eq!(
            import_chat_history(&persistence, &chat_history).await,
            1
        );

        let metadata = persistence.metadata("legacy-1").unwrap();
        assert_eq!(metadata.created_at, 1_700_000_000_000_u64);
        assert_eq!(metadata.title.as_deref(), Some("Legacy title"));
        assert_eq!(
            metadata.stable_agent_namespace.as_deref(),
            Some("config:claude-1")
        );
        assert_eq!(metadata.project_id.as_deref(), Some("project-1"));
        assert_eq!(metadata.status, PersistedSessionStatus::Closed);

        let payload = persistence.session_payload_async("legacy-1").await.unwrap();
        assert_eq!(payload.metadata.id, "legacy-1");
        assert_eq!(payload.metadata.agent_config_id.as_deref(), Some("claude-1"));
        assert_eq!(payload.metadata.created_at, 1_700_000_000_000_u64);
        assert_eq!(payload.messages.len(), 2);
        assert_eq!(payload.messages[0].id, "turn:turn-1");
        assert_eq!(payload.messages[0].role, "user");
        // The two consecutive text blocks coalesce exactly like `appendBlocks`.
        assert_eq!(payload.messages[1].role, "agent");
        assert_eq!(payload.messages[1].blocks.len(), 1);
        assert_eq!(payload.messages[1].blocks[0]["text"], "world again");
        assert_eq!(payload.messages[1].id, "snapshot:agent:2");

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn import_is_idempotent_across_runs() {
        let (root, persistence, chat_history) = setup("idempotent").await;
        let cwd = root.join("cwd").to_string_lossy().into_owned();
        chat_history
            .save("legacy-1", legacy_payload("legacy-1", &cwd, "closed", turn_messages()))
            .unwrap();

        assert_eq!(import_chat_history(&persistence, &chat_history).await, 1);
        assert_eq!(import_chat_history(&persistence, &chat_history).await, 0);
        assert_eq!(persistence.list_sessions().len(), 1);

        // Also across a host restart (catalog rebuilt from disk).
        persistence.shutdown().await.unwrap();
        let reopened = SessionPersistence::open(root.join("store")).await.unwrap();
        assert_eq!(import_chat_history(&reopened, &chat_history).await, 0);
        assert_eq!(reopened.list_sessions().len(), 1);

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn import_skips_degraded_empty_cwd_entries() {
        let (root, persistence, chat_history) = setup("empty-cwd").await;
        chat_history
            .save("legacy-broken", legacy_payload("legacy-broken", "", "closed", turn_messages()))
            .unwrap();
        assert_eq!(import_chat_history(&persistence, &chat_history).await, 0);
        assert!(persistence.list_sessions().is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn import_is_fail_open_on_corrupt_payload() {
        let (root, persistence, chat_history) = setup("corrupt").await;
        let cwd = root.join("cwd").to_string_lossy().into_owned();
        chat_history
            .save("legacy-good", legacy_payload("legacy-good", &cwd, "closed", turn_messages()))
            .unwrap();
        chat_history
            .save("legacy-bad", legacy_payload("legacy-bad", &cwd, "closed", turn_messages()))
            .unwrap();
        // Corrupt the second payload on disk; the store index still lists it.
        let payloads_dir = root.join("legacy").join("payloads");
        let bad_path = payloads_dir
            .read_dir()
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .find(|path| {
                std::fs::read(path)
                    .map(|bytes| bytes.windows(10).any(|w| w == b"legacy-bad"))
                    .unwrap_or(false)
            })
            .unwrap();
        std::fs::write(&bad_path, b"{not valid json").unwrap();

        assert_eq!(
            import_chat_history(&persistence, &chat_history).await,
            1,
            "the corrupt entry is skipped; the good entry still imports"
        );
        assert_eq!(persistence.list_sessions().len(), 1);
        assert_eq!(persistence.list_sessions()[0].session_id, "legacy-good");

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn import_preserves_error_status_and_dangling_turns() {
        let (root, persistence, chat_history) = setup("error-status").await;
        let cwd = root.join("cwd").to_string_lossy().into_owned();
        // User prompt with no response: the turn never completed, so no
        // `prompt_complete` may be fabricated for it.
        let dangling = json!([{
            "id": "turn:turn-9",
            "role": "user",
            "blocks": [{"type": "text", "text": "anyone there?"}],
            "streaming": false,
            "timestamp": 1_700_000_030_000_u64,
        }]);
        chat_history
            .save("legacy-err", legacy_payload("legacy-err", &cwd, "error", dangling))
            .unwrap();
        assert_eq!(import_chat_history(&persistence, &chat_history).await, 1);

        let metadata = persistence.metadata("legacy-err").unwrap();
        assert_eq!(metadata.status, PersistedSessionStatus::Error);
        assert_eq!(
            persistence.completed_turn_ids("legacy-err").unwrap().len(),
            0,
            "an unanswered prompt must not count as a completed turn"
        );
        let enqueue = persistence.enqueue_event(PersistedEventRecord {
            schema_version: SESSION_SCHEMA_VERSION,
            session_id: "legacy-err".to_string(),
            seq: 99,
            type_: "message_chunk".to_string(),
            recorded_at: 0,
            payload: json!({}),
        });
        assert!(
            matches!(enqueue, Err(SessionPersistenceError::SessionNotFound)),
            "imported sessions are finalized archives without writers"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    /// A user deletion of an imported session must be FINAL: without the
    /// imported-id ledger the next startup import would resurrect the session
    /// from the read-only legacy archive.
    #[tokio::test]
    async fn import_keeps_user_deletions_final() {
        let (root, persistence, chat_history) = setup("delete-final").await;
        let cwd = root.join("cwd").to_string_lossy().into_owned();
        chat_history
            .save("legacy-del", legacy_payload("legacy-del", &cwd, "closed", turn_messages()))
            .unwrap();
        assert_eq!(import_chat_history(&persistence, &chat_history).await, 1);

        // The user deletes the imported session…
        persistence.delete_session("legacy-del").await.unwrap();
        assert!(persistence.metadata("legacy-del").is_err());

        // …and a re-import (same run) must not resurrect it.
        assert_eq!(import_chat_history(&persistence, &chat_history).await, 0);
        assert!(persistence.metadata("legacy-del").is_err());

        // The ledger survives a restart, so the deletion stays final.
        persistence.shutdown().await.unwrap();
        let reopened = crate::acp::SessionPersistence::open(root.join("store"))
            .await
            .unwrap();
        assert_eq!(import_chat_history(&reopened, &chat_history).await, 0);
        assert!(reopened.metadata("legacy-del").is_err());

        let _ = std::fs::remove_dir_all(root);
    }
}
