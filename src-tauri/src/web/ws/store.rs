//! `store_*` WS handlers (Issue #613): server-side generic key-value store
//! read/write/delete behind the degraded-mode `Option<Arc<WebStore>>`.

use super::*;

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

/// `store_write` WS request payload. `value` is any JSON value.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StoreWritePayload {
    key: String,
    value: Value,
    #[serde(default)]
    expected: Option<Value>,
}

/// `store_delete` WS request payload.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StoreDeletePayload {
    key: String,
}

/// `store_read` → `WebStore::read`. Reply = `{ value: <json | null> }`.
/// Degrade-mode (`store: None`) returns `STORE_UNAVAILABLE`.
pub(super) async fn handle_store_read(
    id: String,
    payload: &Value,
    store: Option<&Arc<WebStore>>,
) -> WsReply {
    let parsed: StoreReadPayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err_with_code(
                id,
                "VALIDATION_ERROR",
                format!("malformed store_read payload (want key): {e}"),
            )
        }
    };
    let Some(store) = store.cloned() else {
        return WsReply::err_with_code(id, "STORE_UNAVAILABLE", "server store is unavailable");
    };
    if let Some(reply) = validate_store_key(&id, &parsed.key) {
        return reply;
    }
    let result = tokio::task::spawn_blocking(move || store.read(&parsed.key)).await;
    match result {
        Ok(Ok(value)) => WsReply::ok(id, Some(json!({ "value": value }))),
        Ok(Err(e)) => WsReply::err_with_code(id, "STORE_UNAVAILABLE", e.to_string()),
        Err(join_err) => {
            tracing::warn!("store_read task failed: {join_err}");
            WsReply::err_with_code(
                id,
                "STORE_UNAVAILABLE",
                format!("store read task failed: {join_err}"),
            )
        }
    }
}

/// `store_write` → `WebStore::write` (atomic replace). Reply = `{}`.
pub(super) async fn handle_store_write(
    id: String,
    payload: &Value,
    store: Option<&Arc<WebStore>>,
) -> WsReply {
    let parsed: StoreWritePayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err_with_code(
                id,
                "VALIDATION_ERROR",
                format!("malformed store_write payload (want key + value): {e}"),
            )
        }
    };
    let Some(store) = store.cloned() else {
        return WsReply::err_with_code(id, "STORE_UNAVAILABLE", "server store is unavailable");
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
    let store_clone = store.clone();
    let result = tokio::task::spawn_blocking(move || {
        store_clone.write(&parsed.key, parsed.value, parsed.expected)
    })
    .await;
    match result {
        Ok(Ok(true)) => WsReply::ok(id, Some(json!({}))),
        Ok(Ok(false)) => WsReply::err_with_code(
            id,
            "STORE_CAS_FAILED",
            "store write rejected: value changed concurrently",
        ),
        Ok(Err(error)) => {
            tracing::warn!("store_write failed: {error}");
            WsReply::err_with_code(
                id,
                "STORE_WRITE_FAILED",
                format!("store write failed: {error}"),
            )
        }
        Err(join_err) => {
            tracing::warn!("store_write task failed: {join_err}");
            WsReply::err_with_code(id, "STORE_WRITE_FAILED", format!("task failed: {join_err}"))
        }
    }
}

/// `store_delete` → `WebStore::delete`. Reply = `{ existed: bool }`.
pub(super) async fn handle_store_delete(
    id: String,
    payload: &Value,
    store: Option<&Arc<WebStore>>,
) -> WsReply {
    let parsed: StoreDeletePayload = match serde_json::from_value(payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            return WsReply::err_with_code(
                id,
                "VALIDATION_ERROR",
                format!("malformed store_delete payload (want key): {e}"),
            )
        }
    };
    let Some(store) = store.cloned() else {
        return WsReply::err_with_code(id, "STORE_UNAVAILABLE", "server store is unavailable");
    };
    if let Some(reply) = validate_store_key(&id, &parsed.key) {
        return reply;
    }
    let store_clone = store.clone();
    let result = tokio::task::spawn_blocking(move || store_clone.delete(&parsed.key)).await;
    match result {
        Ok(Ok(existed)) => WsReply::ok(id, Some(json!({ "existed": existed }))),
        Ok(Err(error)) => {
            tracing::warn!("store_delete failed: {error}");
            WsReply::err_with_code(
                id,
                "STORE_DELETE_FAILED",
                format!("store delete failed: {error}"),
            )
        }
        Err(join_err) => {
            tracing::warn!("store_delete task failed: {join_err}");
            WsReply::err_with_code(
                id,
                "STORE_DELETE_FAILED",
                format!("task failed: {join_err}"),
            )
        }
    }
}
