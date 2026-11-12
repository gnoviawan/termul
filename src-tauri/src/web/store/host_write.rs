//! Writes the host itself makes to `shared/lww/` keys: no client identity, so
//! no presence touch or adoption, and no per-field merge.

use serde_json::Value;

use super::{Record, StoreError, WebStore, HOST_CLIENT_INSTANCE};

impl WebStore {
    /// Store `value` under the `shared/lww/` `key` unless the key already
    /// holds a value, as a host-side writer: no client identity, so no
    /// presence touch or adoption. Returns whether it wrote.
    pub fn insert_if_absent(
        &self,
        key: &str,
        value: Value,
        now_ms: u64,
    ) -> Result<bool, StoreError> {
        self.host_write(key, value, now_ms, false)
    }

    /// Store `value` under the `shared/lww/` `key`, replacing any value it
    /// holds, as a host-side writer. For a key only the host writes.
    pub fn replace_as_host(&self, key: &str, value: Value, now_ms: u64) -> Result<(), StoreError> {
        self.host_write(key, value, now_ms, true).map(|_| ())
    }

    fn host_write(
        &self,
        key: &str,
        value: Value,
        now_ms: u64,
        replace: bool,
    ) -> Result<bool, StoreError> {
        if !key.starts_with("shared/lww/") {
            return Err(StoreError::Invalid(format!(
                "'{key}' is not a shared/lww key"
            )));
        }
        self.with_state(|state| {
            let current_rev = state.data.get(key).map(|record| record.rev);
            if current_rev.is_some() && !replace {
                return Ok(false);
            }
            let rev = current_rev
                .unwrap_or_else(|| state.host.deleted_revs.get(key).copied().unwrap_or(0))
                + 1;
            let record = Record {
                v: value,
                rev,
                cid: HOST_CLIENT_INSTANCE.to_string(),
                cmd: None,
                fields: None,
            };
            self.put(state, key, record, now_ms)?;
            state.host.deleted_revs.remove(key);
            Ok(true)
        })
    }
}
