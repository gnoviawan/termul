//! On-disk model of the v2 store: records, the host-internal envelope object
//! and the (de)serialization of the whole file.

use std::collections::BTreeMap;
use std::io::{self, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::legacy;
use crate::acp::atomic_file::NewerSchema;

/// Current on-disk schema version of the web store envelope.
pub const STORE_SCHEMA_VERSION: u32 = 2;

/// Top-level envelope keys other than `schemaVersion`, `data` and `host`,
/// preserved verbatim.
pub type ExtraKeys = serde_json::Map<String, Value>;

/// One stored key: the value, its revision and who wrote it last.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Record {
    /// The stored value, exactly as the client wrote it.
    pub v: Value,
    /// Monotonic per key, starting at 1; bumped by every change.
    pub rev: u64,
    /// `clientInstanceId` of the last writer.
    pub cid: String,
    /// `commandId` of the last writer (`shared/cas/` keys).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cmd: Option<String>,
    /// Per-field revisions (`shared/lww/` keys), tombstones included.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fields: Option<BTreeMap<String, u64>>,
}

/// Who adopted the parked pre-v2 device keys.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Adopted {
    pub device_id: String,
    pub at_ms: u64,
}

/// The host-internal `host` envelope object (never reachable through a key).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostMeta {
    /// Last time each device was seen, in unix milliseconds.
    #[serde(default)]
    pub last_seen: BTreeMap<String, u64>,
    /// Pre-v2 device keys, parked until the first device adopts them.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub legacy: BTreeMap<String, Value>,
    /// Set once the parked keys were adopted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adopted: Option<Adopted>,
    /// Last revision of each deleted shared key. A key written again starts
    /// above this floor, so a stale writer cannot overwrite the new value.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub deleted_revs: BTreeMap<String, u64>,
}

/// Borrowed envelope for serialization (no clone of the map per write).
#[derive(Serialize)]
struct EnvelopeRef<'a> {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    data: &'a BTreeMap<String, Record>,
    host: &'a HostMeta,
    #[serde(flatten)]
    extra: &'a ExtraKeys,
}

pub fn encode(
    data: &BTreeMap<String, Record>,
    host: &HostMeta,
    extra: &ExtraKeys,
) -> io::Result<Vec<u8>> {
    serde_json::to_vec(&EnvelopeRef {
        schema_version: STORE_SCHEMA_VERSION,
        data,
        host,
        extra,
    })
    .map_err(|e| io::Error::other(e.to_string()))
}

/// Bytes the envelope adds around the `data` payload (everything but the
/// payload itself), so the file limit can be checked on one serialization.
pub fn envelope_overhead(host: &HostMeta, extra: &ExtraKeys) -> io::Result<usize> {
    // An empty `data` serializes as `{}` (2 bytes), which the payload replaces.
    Ok(encode(&BTreeMap::new(), host, extra)?.len() - 2)
}

/// Serialized size of `record` under `key` (what a partition budget counts).
#[must_use]
pub fn record_bytes(key: &str, record: &Record) -> usize {
    struct Counter(usize);
    impl Write for Counter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0 += buf.len();
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter(0);
    // Serializing into a counter cannot fail for a `Value`-backed record.
    let _ = serde_json::to_writer(&mut counter, record);
    key.len() + counter.0
}

/// The parsed file.
pub struct Loaded {
    pub data: BTreeMap<String, Record>,
    pub host: HostMeta,
    pub extra: ExtraKeys,
    /// The file was an older schema (or an unversioned map): the caller backs
    /// it up and rewrites it as v2.
    pub migrated: bool,
}

pub enum DecodeFailure {
    Newer(NewerSchema),
    Corrupt(String),
}

/// What a store file's bytes mean to this build.
pub fn decode(path: &Path, bytes: &[u8]) -> Result<Loaded, DecodeFailure> {
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|e| DecodeFailure::Corrupt(format!("invalid JSON: {e}")))?;
    let Value::Object(mut object) = value else {
        return Err(DecodeFailure::Corrupt(
            "top-level value is not a JSON object".to_string(),
        ));
    };
    let version = object.get("schemaVersion").and_then(Value::as_u64);
    match (version, object.get("data")) {
        // Newer envelope (a `data` key beside a numeric version): refuse,
        // whatever shape `data` has in that future version.
        (Some(found), Some(_)) if found > u64::from(STORE_SCHEMA_VERSION) => {
            Err(DecodeFailure::Newer(NewerSchema {
                path: path.to_path_buf(),
                found: u32::try_from(found).unwrap_or(u32::MAX),
                supported: STORE_SCHEMA_VERSION,
            }))
        }
        (Some(2), Some(Value::Object(_))) => decode_v2(object),
        (Some(1), Some(Value::Object(_))) => {
            let Some(Value::Object(data)) = object.remove("data") else {
                unreachable!("matched an object `data` above");
            };
            object.remove("schemaVersion");
            Ok(legacy::from_flat(data.into_iter().collect(), object))
        }
        // Anything else — including a bare map with a user key named
        // `schemaVersion` — is an unversioned map, the same flat shape as v1.
        _ => Ok(legacy::from_flat(object.into_iter().collect(), ExtraKeys::new())),
    }
}

fn decode_v2(mut object: serde_json::Map<String, Value>) -> Result<Loaded, DecodeFailure> {
    let Some(Value::Object(data)) = object.remove("data") else {
        unreachable!("matched an object `data` by the caller");
    };
    object.remove("schemaVersion");
    let host = match object.remove("host") {
        Some(value) => serde_json::from_value(value)
            .map_err(|e| DecodeFailure::Corrupt(format!("invalid host object: {e}")))?,
        None => HostMeta::default(),
    };
    let mut records = BTreeMap::new();
    for (key, value) in data {
        let record: Record = serde_json::from_value(value)
            .map_err(|e| DecodeFailure::Corrupt(format!("invalid record for a key: {e}")))?;
        records.insert(key, record);
    }
    Ok(Loaded {
        data: records,
        host,
        extra: object,
        migrated: false,
    })
}
