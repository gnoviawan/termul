//! Terminal claim registry — CAP-3 reclaimable terminal leases.
//!
//! Every spawned terminal is issued an unguessable claim credential (32 random
//! bytes from `getrandom`, hex-encoded to 64 chars). The host stores ONLY the
//! SHA-256 digest of the credential — never the raw credential — and verifies
//! presented credentials in constant time against that digest. Credentials are
//! never logged and never returned except by the issuance (spawn) and rotation
//! responses.
//!
//! All verification failures (unknown terminal, oversized probe, wrong
//! credential, revoked credential, project-binding mismatch) collapse into the
//! single [`ClaimError`] value so no caller — and therefore no response shape —
//! can distinguish them. This keeps terminal existence from leaking through the
//! attach/rotate/revoke surfaces.
//!
//! Timing notes (honest scope): credential comparison itself is constant-time
//! (`subtle::ConstantTimeEq`), and unknown terminals burn a dummy digest
//! comparison so the comparison path runs either way — however the dummy path
//! skips the binding/revoked arithmetic, and oversized probes return before
//! hashing, so a determined local attacker may still distinguish existence or
//! probe length through timing. The registry is an in-process store; the wire
//! surface's generic-error policy is the primary leak defense.
//!
//! Per-terminal monotonically increasing GENERATION counters are bumped on
//! rotate/revoke so derived access (e.g. desktop attach output forwarders) can
//! observe invalidation and terminate.

use parking_lot::Mutex;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use subtle::ConstantTimeEq;

/// Length of an issued credential: 32 random bytes hex-encoded.
pub const CLAIM_CREDENTIAL_LEN: usize = 64;

/// A DUMMY pre-computed digest compared against when a terminal has no claim
/// record, so the timing profile of an unknown-terminal probe matches the
/// known-terminal path (no existence signal through timing).
const DUMMY_DIGEST: [u8; 32] = [0xA5; 32];

/// Wire shape of the rotate response — byte-identical on both transports
/// (desktop `terminal_rotate_claim` IpcResult data; web `rotate_claim` reply
/// data). Issuance-on-rotation is the only time a credential leaves the host
/// besides spawn.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RotatedClaim {
    pub claim: String,
}

/// Single collapsed failure type for every claim operation.
///
/// Deliberately carries no data: no response shape or message may distinguish
/// unknown terminal from wrong credential from revoked credential from binding
/// mismatch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClaimError;

impl std::fmt::Display for ClaimError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Generic on purpose — see struct docs.
        write!(f, "Unauthorized")
    }
}

/// One terminal's claim state. Debug is safe: only the digest (a one-way
/// hash) is printable, never credential material.
#[derive(Debug)]
struct ClaimRecord {
    /// SHA-256 digests of every currently valid credential (never the raw
    /// forms). The FIRST entry is the primary credential (issued by
    /// `issue` at spawn / reload re-issue, which replaces the record);
    /// additional entries are co-attacher credentials appended by
    /// `issue_shared` so a second web client can attach read/write to the
    /// same PTY without invalidating the first holder's lease (#851).
    digests: Vec<[u8; 32]>,
    /// Project binding captured at issuance; verified as part of every check.
    project_id: Option<String>,
    /// Monotonically increasing invalidation counter. Bumped on rotate/revoke
    /// so live access derived from the old credential can be torn down.
    generation: u64,
    /// Revoked credentials stay on record (digests retained, unrecoverable)
    /// so the generation counter remains observable for teardown; [`remove`]
    /// drops the record entirely (kill/reap).
    revoked: bool,
}

/// Host-side registry of terminal claim credentials.
///
/// In-memory only — claims never survive host restart and are never persisted.
#[derive(Default)]
pub struct TerminalClaimRegistry {
    records: Mutex<HashMap<String, ClaimRecord>>,
}

fn sha256_digest(bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().into()
}

const fn hex_digit(byte: u8) -> [u8; 2] {
    const ALPHABET: &[u8; 16] = b"0123456789abcdef";
    [
        ALPHABET[(byte >> 4) as usize],
        ALPHABET[(byte & 0x0F) as usize],
    ]
}

fn hex_encode(bytes: &[u8; 32]) -> String {
    let mut out = Vec::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let digits = hex_digit(*byte);
        out.push(digits[0]);
        out.push(digits[1]);
    }
    // SAFETY: hex_digit only emits ASCII hex characters.
    String::from_utf8(out).expect("hex encoding is valid UTF-8")
}

impl TerminalClaimRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Issue a fresh credential for `terminal_id`, bound to `project_id`.
    ///
    /// The host retains only the SHA-256 digest; the returned credential string
    /// exists nowhere else in the process. Any previous record for the terminal
    /// is replaced (spawn path issues exactly once per terminal).
    pub fn issue(&self, terminal_id: &str, project_id: Option<&str>) -> String {
        let mut raw = [0u8; 32];
        getrandom::getrandom(&mut raw).expect("OS CSPRNG is available");
        let credential = hex_encode(&raw);
        let digest = sha256_digest(credential.as_bytes());
        // The random bytes are no longer needed — overwrite before drop.
        for byte in raw.iter_mut() {
            *byte = 0;
        }

        let mut records = self.records.lock();
        records.insert(
            terminal_id.to_string(),
            ClaimRecord {
                digests: vec![digest],
                project_id: project_id.map(|p| p.to_string()),
                generation: 0,
                revoked: false,
            },
        );

        log::info!(
            "[claims] issued terminal_id={} project_id={}",
            terminal_id,
            project_id.unwrap_or("<none>")
        );
        credential
    }

    /// Issue an ADDITIONAL credential for `terminal_id` bound to
    /// `project_id`, WITHOUT invalidating any existing holder (#851: a
    /// second web client attaching read/write to the same claimed PTY).
    ///
    /// Unlike [`issue`], this APPENDS a digest to the live record and leaves
    /// the generation UNCHANGED — the first device's forwarder keeps its
    /// stream and its credential keeps verifying. Unknown terminals and
    /// revoked records fail with the same generic [`ClaimError`] (no
    /// existence signal, no resurrecting dead leases). The primary (spawn)
    /// credential stays the first entry; this only ever appends.
    pub fn issue_shared(
        &self,
        terminal_id: &str,
        project_id: Option<&str>,
    ) -> Result<String, ClaimError> {
        let mut raw = [0u8; 32];
        getrandom::getrandom(&mut raw).expect("OS CSPRNG is available");
        let credential = hex_encode(&raw);
        let digest = sha256_digest(credential.as_bytes());
        // The random bytes are no longer needed — overwrite before drop.
        for byte in raw.iter_mut() {
            *byte = 0;
        }

        let mut records = self.records.lock();
        // The record's OWN binding is the gate: a shared issuance scoped to
        // a different project cannot mint a credential against a terminal
        // bound elsewhere.
        let Some(record) = records.get_mut(terminal_id) else {
            return Err(ClaimError);
        };
        let binding_matches = match (&record.project_id, project_id) {
            (Some(bound), Some(presented)) => bound == presented,
            (None, None) => true,
            _ => false,
        };
        if record.revoked || !binding_matches {
            return Err(ClaimError);
        }
        record.digests.push(digest);
        let holders = record.digests.len();
        log::info!(
            "[claims] issued shared terminal_id={} project_id={} holders={}",
            terminal_id,
            project_id.unwrap_or("<none>"),
            holders
        );
        Ok(credential)
    }

    /// Verify a presented credential in constant time.
    ///
    /// Fails identically (same error value, same comparison work) for:
    /// oversized probes, unknown terminals, wrong credentials, revoked
    /// credentials, and project-binding mismatches. Never logs the credential.
    pub fn verify(
        &self,
        terminal_id: &str,
        claim: &str,
        project_id: Option<&str>,
    ) -> Result<(), ClaimError> {
        // Amplification guard (amendment R3): probes longer than the issued
        // credential form are rejected BEFORE hashing so unbounded probe
        // strings cost constant work.
        if claim.len() > CLAIM_CREDENTIAL_LEN {
            log::warn!(
                "[claims] verify failed (oversized credential) terminal_id={} project_id={}",
                terminal_id,
                project_id.unwrap_or("<none>")
            );
            return Err(ClaimError);
        }

        let presented = sha256_digest(claim.as_bytes());

        let records = self.records.lock();
        let outcome = Self::verify_locked(&records, terminal_id, &presented, project_id);
        drop(records);

        if outcome {
            log::info!(
                "[claims] verify ok terminal_id={} project_id={}",
                terminal_id,
                project_id.unwrap_or("<none>")
            );
            Ok(())
        } else {
            log::warn!(
                "[claims] verify failed terminal_id={} project_id={}",
                terminal_id,
                project_id.unwrap_or("<none>")
            );
            Err(ClaimError)
        }
    }

    /// Comparison core shared by [`verify`], [`rotate`], and [`revoke`].
    ///
    /// Runs the constant-time digest comparison, the project-binding check,
    /// and the revoked flag against the record set. Rotate/revoke call this
    /// UNDER THE SAME LOCK that performs their mutation so possession-based
    /// invalidation is atomic (a concurrent rotate/revoke cannot slip between
    /// verification and mutation).
    fn verify_locked(
        records: &HashMap<String, ClaimRecord>,
        terminal_id: &str,
        presented: &[u8; 32],
        project_id: Option<&str>,
    ) -> bool {
        match records.get(terminal_id) {
            Some(record) => {
                // Constant-time digest comparison — a credential matches if
                // its digest equals ANY live holder digest (the primary
                // spawn/reload credential or a shared co-attacher one). The
                // OR folds into the same Choice arithmetic so the failure
                // path stays singular and each comparison stays timing-
                // uniform.
                let mut digest_ok = subtle::Choice::from(0u8);
                for holder_digest in &record.digests {
                    digest_ok = digest_ok | presented.ct_eq(holder_digest);
                }
                // Binding integrity: the presented context must match the
                // issuance-time project binding. `ct_eq` on the byte slices
                // keeps the comparison length-timing uniform; a None/Some
                // mismatch is folded into the same Choice arithmetic so the
                // failure path stays singular.
                let binding_ok = match (&record.project_id, project_id) {
                    (Some(bound), Some(presented_id)) => {
                        bound.as_bytes().ct_eq(presented_id.as_bytes())
                    }
                    (None, None) => subtle::Choice::from(1u8),
                    _ => subtle::Choice::from(0u8),
                };
                let active = subtle::Choice::from(if record.revoked { 0u8 } else { 1u8 });
                bool::from(digest_ok & binding_ok & active)
            }
            // Dummy-digest path: burn the digest comparison work for unknown
            // terminals so timing does not distinguish existence.
            None => {
                let _dummy = presented.ct_eq(&DUMMY_DIGEST);
                false
            }
        }
    }

    /// Rotate: possession of the current credential yields a fresh credential
    /// and atomically invalidates the old one (generation bump).
    ///
    /// Verification and mutation happen under ONE lock hold: a concurrent
    /// rotation presenting the same (then-still-valid) credential cannot win
    /// the race — exactly one caller obtains the successor credential.
    pub fn rotate(
        &self,
        terminal_id: &str,
        current_claim: &str,
        project_id: Option<&str>,
    ) -> Result<String, ClaimError> {
        if current_claim.len() > CLAIM_CREDENTIAL_LEN {
            log::warn!(
                "[claims] rotate failed (oversized credential) terminal_id={} project_id={}",
                terminal_id,
                project_id.unwrap_or("<none>")
            );
            return Err(ClaimError);
        }
        let presented = sha256_digest(current_claim.as_bytes());

        let mut raw = [0u8; 32];
        getrandom::getrandom(&mut raw).expect("OS CSPRNG is available");
        let credential = hex_encode(&raw);
        let digest = sha256_digest(credential.as_bytes());
        for byte in raw.iter_mut() {
            *byte = 0;
        }

        let mut records = self.records.lock();
        let verified = Self::verify_locked(&records, terminal_id, &presented, project_id);
        if !verified {
            drop(records);
            log::warn!(
                "[claims] rotate failed terminal_id={} project_id={}",
                terminal_id,
                project_id.unwrap_or("<none>")
            );
            return Err(ClaimError);
        }
        // Verified under the same lock — the record cannot have changed since.
        let record = records
            .get_mut(terminal_id)
            .expect("record verified under the same lock hold");
        // Whole-record replacement (#851): the successor credential becomes
        // the ONLY valid one — every co-attacher holder is severed via the
        // generation bump below (rotation is an ownership hand-off, not a
        // fan-out).
        record.digests = vec![digest];
        record.revoked = false;
        record.generation = record.generation.wrapping_add(1);
        let generation = record.generation;
        drop(records);

        log::info!(
            "[claims] rotated terminal_id={} project_id={} generation={}",
            terminal_id,
            project_id.unwrap_or("<none>"),
            generation
        );
        Ok(credential)
    }

    /// Revoke: invalidate the presented credential. The PTY is untouched —
    /// revocation only severs credential-derived access.
    ///
    /// Verification and mutation happen under ONE lock hold (same atomicity
    /// guarantee as [`rotate`]).
    pub fn revoke(
        &self,
        terminal_id: &str,
        claim: &str,
        project_id: Option<&str>,
    ) -> Result<(), ClaimError> {
        if claim.len() > CLAIM_CREDENTIAL_LEN {
            log::warn!(
                "[claims] revoke failed (oversized credential) terminal_id={} project_id={}",
                terminal_id,
                project_id.unwrap_or("<none>")
            );
            return Err(ClaimError);
        }
        let presented = sha256_digest(claim.as_bytes());

        let mut records = self.records.lock();
        let verified = Self::verify_locked(&records, terminal_id, &presented, project_id);
        if !verified {
            drop(records);
            log::warn!(
                "[claims] revoke failed terminal_id={} project_id={}",
                terminal_id,
                project_id.unwrap_or("<none>")
            );
            return Err(ClaimError);
        }
        let record = records
            .get_mut(terminal_id)
            .expect("record verified under the same lock hold");
        record.revoked = true;
        record.generation = record.generation.wrapping_add(1);
        let generation = record.generation;
        drop(records);

        log::info!(
            "[claims] revoked terminal_id={} project_id={} generation={}",
            terminal_id,
            project_id.unwrap_or("<none>"),
            generation
        );
        Ok(())
    }

    /// Remove the claim record entirely (terminal killed/reaped).
    pub fn remove(&self, terminal_id: &str) {
        let mut records = self.records.lock();
        if records.remove(terminal_id).is_some() {
            log::info!("[claims] removed terminal_id={}", terminal_id);
        }
    }

    /// Current generation for a terminal, if a claim record exists.
    ///
    /// Consumers (desktop attach forwarders) capture this at attach time and
    /// terminate when it changes (rotate/revoke) or disappears (kill/reap).
    pub fn generation(&self, terminal_id: &str) -> Option<u64> {
        self.records.lock().get(terminal_id).map(|r| r.generation)
    }

    /// Number of live credential holders for a terminal (primary + shared
    /// co-attachers). `0` when no record exists. Feeds `list_preserved`
    /// ownership info (#851) so clients can tell a solo terminal from one
    /// another device is already attached to.
    #[must_use]
    #[cfg(test)]
    pub fn holder_count(&self, terminal_id: &str) -> usize {
        self.records
            .lock()
            .get(terminal_id)
            .map(|r| r.digests.len())
            .unwrap_or(0)
    }

    /// Test-only accessor: the stored digest for a terminal. Lets unit tests
    /// assert digest-only storage honestly (compare against a recomputed
    /// SHA-256 of the credential) without fake drop theater.
    #[cfg(test)]
    fn stored_digest_for_test(&self, terminal_id: &str) -> Option<[u8; 32]> {
        self.records.lock().get(terminal_id).map(|r| r.digests[0])
    }
}

#[cfg(test)]
mod tests;
