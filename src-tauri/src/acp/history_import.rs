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
    atomic_file, ChatHistoryIndexEntry, ChatHistoryStore, PersistedEventRecord,
    PersistedSessionStatus, SessionPersistence, SessionRegistration,
};

/// Records every session id ever imported from the legacy store. Needed so a
/// user `delete_session` on an imported session STICKS: without it the next
/// startup import would see the id missing from the catalog and resurrect it
/// from the (read-only) legacy archive.
const IMPORTED_LEDGER_FILE: &str = "legacy-imported.json";

/// One-time backfill marker: legacy payloads carry `switches` records that
/// `synthesize_records` never writes into the durable log, so sessions
/// imported before the `continuedFrom` feature have no chain edge anywhere.
const CHAIN_EDGE_BACKFILL_FILE: &str = "legacy-chain-edges-v1";

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
    for entry in &entries {
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
    backfill_continued_from(persistence, chat_history, &entries, &ledger).await;
    imported
}

/// One-time pass (marker-protected): stamp `continued_from` on chain targets
/// from the legacy `switches` arrays and `metadata.continuedFrom` fields that
/// the import's record synthesis does not carry. Targets that are not
/// importable yet (a legacy payload still awaiting its own import) leave the
/// marker unwritten so the next startup retries; a target already imported
/// and deleted, or a native session gone for good, counts as resolved.
async fn backfill_continued_from(
    persistence: &Arc<SessionPersistence>,
    chat_history: &Arc<ChatHistoryStore>,
    entries: &[ChatHistoryIndexEntry],
    ledger: &HashSet<String>,
) {
    let marker = persistence.root().join(CHAIN_EDGE_BACKFILL_FILE);
    if marker.exists() {
        return;
    }
    let legacy_ids: HashSet<&str> = entries.iter().map(|entry| entry.id.as_str()).collect();
    // (target, source) edges. A source has at most one switch: the newest
    // record by timestamp wins; `metadata.continuedFrom` supplies the edge
    // from the target side when a newer renderer wrote the payload.
    let mut edges: Vec<(String, String)> = Vec::new();
    for entry in entries {
        let Ok(payload) = chat_history.get(&entry.id) else {
            continue;
        };
        let mut newest_target: Option<(u64, &str)> = None;
        if let Some(switches) = payload.get("switches").and_then(Value::as_array) {
            for record in switches {
                let Some(target) = record
                    .get("newSessionId")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                else {
                    continue;
                };
                let timestamp = record
                    .get("timestamp")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                if newest_target.is_none_or(|(seen, _)| timestamp >= seen) {
                    newest_target = Some((timestamp, target));
                }
            }
        }
        if let Some((_, target)) = newest_target {
            edges.push((target.to_string(), entry.id.clone()));
        }
        if let Some(source) = payload
            .get("metadata")
            .and_then(|metadata| metadata.get("continuedFrom"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            edges.push((entry.id.clone(), source.to_string()));
        }
    }
    let mut stamped = 0usize;
    let mut incomplete = false;
    for (target, source) in edges {
        match persistence.note_continued_from(&target, &source).await {
            Ok(()) => stamped += 1,
            Err(crate::acp::session_persistence::SessionPersistenceError::SessionNotFound) => {
                // A legacy target not yet imported (or a native target gone
                // for good): only the importable one keeps the pass open.
                if legacy_ids.contains(target.as_str()) && !ledger.contains(&target) {
                    incomplete = true;
                }
            }
            Err(error) => {
                incomplete = true;
                log::warn!(
                    "[acp-history] chain-edge backfill failed session_id={}: {error}",
                    crate::logging::redact_session_id(&target)
                );
            }
        }
    }
    if incomplete {
        return;
    }
    if let Err(error) = atomic_file::replace(&marker, b"1") {
        log::warn!("[acp-history] could not write the chain-edge backfill marker: {error}");
        return;
    }
    log::info!("[acp-history] chain-edge backfill finished stamped={stamped}");
}

async fn import_session(
    persistence: &Arc<SessionPersistence>,
    chat_history: &Arc<ChatHistoryStore>,
    session_id: &str,
) -> Result<(), String> {
    let payload = chat_history
        .get(session_id)
        .map_err(|error| error.to_string())?;
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
    // A renderer-authored payload may already carry the switch-chain edge
    // (the `continuedFrom` index field); keep it through the migration so a
    // pre-import chain still folds into one row.
    let continued_from = metadata.get("continuedFrom").and_then(Value::as_str);

    let registration = SessionRegistration {
        session_id: session_id.to_string(),
        stable_agent_namespace: agent_config_id.map(|config_id| format!("config:{config_id}")),
        runtime_agent_id: (!agent_id.is_empty()).then(|| agent_id.clone()),
        project_id: project_id.map(str::to_string),
        cwd: PathBuf::from(cwd),
        ..Default::default()
    };
    persistence
        .register_imported_session(registration, created_at, title)
        .await
        .map_err(|error| error.to_string())?;
    if let Some(source) = continued_from {
        if let Err(error) = persistence
            .note_continued_from(session_id, source)
            .await
        {
            log::warn!(
                "[acp-history] legacy import could not stamp continued_from on session_id={}: {error}",
                crate::logging::redact_session_id(session_id)
            );
        }
    }

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
mod tests;
