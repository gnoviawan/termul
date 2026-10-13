//! `store_*` WS handlers (Issue #613, scoped in #1073): server-side generic
//! key-value store read/write/delete behind the degraded-mode
//! `Option<Arc<WebStore>>`, acting for the connection's authenticated
//! identity (the store enforces the key scopes against its `deviceId`).

use serde::Deserializer;

use super::*;
use crate::web::store::{unix_ms, Precondition, StoreError, WriteOutcome};
use crate::web::watch::publish_store;

// --- Issue #613: server-side generic key-value store -------------------------

/// Per-value serialized size cap for `store_write` (CAP-11). The whole-file
/// 10 MiB cap inside `WebStore::write` still applies; this bound rejects a
/// single oversized value BEFORE it reaches the store so the on-disk file
/// stays untouched.
pub(super) const STORE_VALUE_MAX_BYTES: usize = 256 * 1024;

/// Shared `store_*` key validation (CAP-11): an empty or whitespace-only key
/// is a `VALIDATION_ERROR`; the connection stays open and the store is never
/// touched. Returns the error reply to send, or `None` when the key is valid.
pub(super) fn validate_store_key(id: &str, key: &str) -> Option<WsReply> {
    if key.trim().is_empty() {
        return Some(WsReply::err_with_code(
            id,
            "VALIDATION_ERROR",
            "key must be non-empty",
        ));
    }
    if key.len() > 1024 {
        return Some(WsReply::err_with_code(
            id,
            "VALIDATION_ERROR",
            "key too long",
        ));
    }
    None
}

/// `store_read` WS request payload. `deny_unknown_fields` rejects an
/// over-serialized payload loudly at the host boundary.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StoreReadPayload {
    key: String,
}

/// `expected` is "present" even when JSON `null` (the key must be absent), so
/// `null` is told apart from a missing field.
fn present<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

/// `store_write` WS request payload. `value` is any JSON value.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StoreWritePayload {
    key: String,
    value: Value,
    #[serde(default)]
    base_revision: Option<u64>,
    #[serde(default, deserialize_with = "present")]
    expected: Option<Value>,
    #[serde(default)]
    command_id: Option<String>,
}

/// `store_delete` WS request payload.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StoreDeletePayload {
    key: String,
    #[serde(default)]
    base_revision: Option<u64>,
    #[serde(default, deserialize_with = "present")]
    expected: Option<Value>,
    #[serde(default)]
    command_id: Option<String>,
}

fn malformed(id: String, request: &str, wants: &str, error: serde_json::Error) -> WsReply {
    WsReply::err_with_code(
        id,
        "VALIDATION_ERROR",
        format!("malformed {request} payload (want {wants}): {error}"),
    )
}

/// The store and the caller's identity, or the error reply when either is
/// missing (degraded store; a request that somehow ran before `authenticate`).
fn store_and_identity(
    id: &str,
    store: Option<&Arc<WebStore>>,
    identity: Option<&ClientIdentity>,
) -> Result<(Arc<WebStore>, ClientIdentity), Box<WsReply>> {
    let Some(store) = store.cloned() else {
        return Err(Box::new(WsReply::err_with_code(
            id,
            "STORE_UNAVAILABLE",
            "server store is unavailable",
        )));
    };
    let Some(identity) = identity.cloned() else {
        return Err(Box::new(WsReply::err(
            id,
            WsErrorCode::Unauthorized,
            "store requests need an authenticated connection",
        )));
    };
    Ok((store, identity))
}

/// Map a store failure to its stable code. `io_code` names an IO failure of
/// the calling operation.
fn store_error_reply(id: String, error: StoreError, io_code: &str) -> WsReply {
    let code = match &error {
        StoreError::Unavailable => "STORE_UNAVAILABLE",
        StoreError::Scope(_) => "STORE_KEY_SCOPE",
        StoreError::BaseRequired => "STORE_BASE_REQUIRED",
        StoreError::CasFailed(_) => "STORE_CAS_FAILED",
        StoreError::PartitionFull { .. } => "STORE_PARTITION_FULL",
        StoreError::Invalid(_) => "VALIDATION_ERROR",
        StoreError::Io(io) => {
            tracing::warn!("store operation failed ({io_code}): {io}");
            return WsReply::err_with_code(id, io_code, format!("store operation failed: {error}"));
        }
    };
    WsReply::err_with_code(id, code, error.to_string())
}

fn task_failed(id: String, code: &str, error: tokio::task::JoinError) -> WsReply {
    tracing::warn!("store task failed: {error}");
    WsReply::err_with_code(id, code, format!("store task failed: {error}"))
}

/// `store_read` → `WebStore::read`. Reply = `{ value: <json | null>,
/// revision, clientInstanceId }` (`revision` 0 = absent). Degrade-mode
/// (`store: None`) returns `STORE_UNAVAILABLE`.
pub(super) async fn handle_store_read(
    id: String,
    payload: &Value,
    store: Option<&Arc<WebStore>>,
    identity: Option<&ClientIdentity>,
) -> WsReply {
    let parsed: StoreReadPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => return malformed(id, "store_read", "key", e),
    };
    let (store, identity) = match store_and_identity(&id, store, identity) {
        Ok(pair) => pair,
        Err(reply) => return *reply,
    };
    if let Some(reply) = validate_store_key(&id, &parsed.key) {
        return reply;
    }
    let result =
        tokio::task::spawn_blocking(move || store.read(&parsed.key, &identity, unix_ms())).await;
    match result {
        Ok(Ok(stamped)) => WsReply::ok(
            id,
            Some(json!({
                "value": stamped.value,
                "revision": stamped.revision,
                "clientInstanceId": stamped.client_instance_id,
            })),
        ),
        Ok(Err(error)) => store_error_reply(id, error, "STORE_UNAVAILABLE"),
        Err(join_err) => task_failed(id, "STORE_UNAVAILABLE", join_err),
    }
}

/// `store_write` → `WebStore::write` (atomic replace). Reply = `{ revision }`
/// for a device key, `{ value, revision, merged }` for a shared key.
pub(super) async fn handle_store_write(
    id: String,
    payload: &Value,
    store: Option<&Arc<WebStore>>,
    identity: Option<&ClientIdentity>,
    relay: &Arc<WsRelaySink>,
) -> WsReply {
    let parsed: StoreWritePayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => return malformed(id, "store_write", "key + value", e),
    };
    let (store, identity) = match store_and_identity(&id, store, identity) {
        Ok(pair) => pair,
        Err(reply) => return *reply,
    };
    if let Some(reply) = validate_store_key(&id, &parsed.key) {
        return reply;
    }
    // CAP-11: reject an oversized value before it reaches the store — the
    // on-disk file stays untouched. Measured on the serialized JSON bytes.
    let value_len = match serde_json::to_vec(&parsed.value) {
        Ok(bytes) => bytes.len(),
        Err(e) => {
            return WsReply::err_with_code(
                id,
                "VALIDATION_ERROR",
                format!("unserializable store value: {e}"),
            )
        }
    };
    if value_len > STORE_VALUE_MAX_BYTES {
        return WsReply::err_with_code(
            id,
            "STORE_VALUE_TOO_LARGE",
            format!("value is {value_len} bytes (max {STORE_VALUE_MAX_BYTES})"),
        );
    }
    let precondition = Precondition {
        base_revision: parsed.base_revision,
        expected: parsed.expected,
        command_id: parsed.command_id,
    };
    let watched = (store.clone(), parsed.key.clone(), identity.clone());
    let result = tokio::task::spawn_blocking(move || {
        store.write(&parsed.key, parsed.value, precondition, &identity, unix_ms())
    })
    .await;
    match result {
        Ok(Ok(WriteOutcome::Device { revision })) => {
            publish_store(relay, &watched.0, &watched.1, &watched.2);
            WsReply::ok(id, Some(json!({ "revision": revision })))
        }
        Ok(Ok(WriteOutcome::Shared {
            value,
            revision,
            merged,
        })) => {
            publish_store(relay, &watched.0, &watched.1, &watched.2);
            WsReply::ok(
                id,
                Some(json!({ "value": value, "revision": revision, "merged": merged })),
            )
        }
        Ok(Err(error)) => store_error_reply(id, error, "STORE_WRITE_FAILED"),
        Err(join_err) => task_failed(id, "STORE_WRITE_FAILED", join_err),
    }
}

/// `store_delete` → `WebStore::delete`. Reply = `{ existed: bool }`.
pub(super) async fn handle_store_delete(
    id: String,
    payload: &Value,
    store: Option<&Arc<WebStore>>,
    identity: Option<&ClientIdentity>,
    relay: &Arc<WsRelaySink>,
) -> WsReply {
    let parsed: StoreDeletePayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => return malformed(id, "store_delete", "key", e),
    };
    let (store, identity) = match store_and_identity(&id, store, identity) {
        Ok(pair) => pair,
        Err(reply) => return *reply,
    };
    if let Some(reply) = validate_store_key(&id, &parsed.key) {
        return reply;
    }
    let precondition = Precondition {
        base_revision: parsed.base_revision,
        expected: parsed.expected,
        command_id: parsed.command_id,
    };
    let watched = (store.clone(), parsed.key.clone(), identity.clone());
    let result = tokio::task::spawn_blocking(move || {
        store.delete(&parsed.key, precondition, &identity, unix_ms())
    })
    .await;
    match result {
        Ok(Ok(existed)) => {
            if existed {
                publish_store(relay, &watched.0, &watched.1, &watched.2);
            }
            WsReply::ok(id, Some(json!({ "existed": existed })))
        }
        Ok(Err(error)) => store_error_reply(id, error, "STORE_DELETE_FAILED"),
        Err(join_err) => task_failed(id, "STORE_DELETE_FAILED", join_err),
    }
}
