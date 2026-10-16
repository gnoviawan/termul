//! Key scopes (issue #1073): every store key is `device/<deviceId>/<rest>`,
//! `shared/lww/<rest>` or `shared/cas/<rest>`. Anything else — `host/…`,
//! `legacy/…`, a bare key — is refused, and the `device/<id>/` segment must be
//! the connection's own authenticated `deviceId` for reads AND writes.

/// Which semantics a key follows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyScope {
    /// One device's partition: last host arrival wins.
    Device,
    /// Shared, merged per field against the writer's base revision.
    SharedLww,
    /// Shared, whole-value compare-and-set with a stored `commandId`.
    SharedCas,
}

const DEVICE_PREFIX: &str = "device/";
const SHARED_LWW_PREFIX: &str = "shared/lww/";
const SHARED_CAS_PREFIX: &str = "shared/cas/";

/// Why a key was refused; carried to the client as `STORE_KEY_SCOPE`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeViolation(pub String);

/// `device/<device_id>/`, or `None` when `device_id` has no namespace (empty,
/// or containing `/`).
#[must_use]
pub fn device_prefix(device_id: &str) -> Option<String> {
    (!device_id.is_empty() && !device_id.contains('/'))
        .then(|| format!("{DEVICE_PREFIX}{device_id}/"))
}

/// The `<id>` of a `device/<id>/<rest>` key (non-empty `rest` required).
#[must_use]
pub fn partition_of(key: &str) -> Option<&str> {
    let (id, rest) = key.strip_prefix(DEVICE_PREFIX)?.split_once('/')?;
    (!id.is_empty() && !rest.is_empty()).then_some(id)
}

/// Classify `key` for the connection authenticated as `device_id`.
pub fn classify(key: &str, device_id: &str) -> Result<KeyScope, ScopeViolation> {
    if let Some(rest) = key.strip_prefix(DEVICE_PREFIX) {
        let Some((id, logical)) = rest.split_once('/') else {
            return Err(violation(
                key,
                "a device key is device/<deviceId>/<key> with a non-empty key",
            ));
        };
        if id.is_empty() || logical.is_empty() {
            return Err(violation(
                key,
                "a device key is device/<deviceId>/<key> with a non-empty key",
            ));
        }
        if id != device_id || device_prefix(device_id).is_none() {
            return Err(violation(
                key,
                "a device key must be under this connection's own deviceId",
            ));
        }
        return Ok(KeyScope::Device);
    }
    for (prefix, scope) in [
        (SHARED_LWW_PREFIX, KeyScope::SharedLww),
        (SHARED_CAS_PREFIX, KeyScope::SharedCas),
    ] {
        if let Some(logical) = key.strip_prefix(prefix) {
            if logical.is_empty() {
                return Err(violation(key, "a shared key needs a non-empty key after its scope"));
            }
            return Ok(scope);
        }
    }
    Err(violation(
        key,
        "keys are device/<deviceId>/…, shared/lww/… or shared/cas/…",
    ))
}

fn violation(key: &str, why: &str) -> ScopeViolation {
    ScopeViolation(format!("store key '{}' refused: {why}", clip(key)))
}

/// Long keys are cut so an error message stays small.
fn clip(key: &str) -> String {
    key.chars().take(96).collect()
}
