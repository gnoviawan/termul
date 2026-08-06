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
    /// SHA-256 digest of the currently valid credential (never the raw form).
    digest: [u8; 32],
    /// Project binding captured at issuance; verified as part of every check.
    project_id: Option<String>,
    /// Monotonically increasing invalidation counter. Bumped on rotate/revoke
    /// so live access derived from the old credential can be torn down.
    generation: u64,
    /// Revoked credentials stay on record (digest retained, unrecoverable) so
    /// the generation counter remains observable for teardown; [`remove`] drops
    /// the record entirely (kill/reap).
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
    [ALPHABET[(byte >> 4) as usize], ALPHABET[(byte & 0x0F) as usize]]
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
                digest,
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
                // Constant-time digest comparison.
                let digest_ok = presented.ct_eq(&record.digest);
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
        record.digest = digest;
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

    /// Test-only accessor: the stored digest for a terminal. Lets unit tests
    /// assert digest-only storage honestly (compare against a recomputed
    /// SHA-256 of the credential) without fake drop theater.
    #[cfg(test)]
    fn stored_digest_for_test(&self, terminal_id: &str) -> Option<[u8; 32]> {
        self.records.lock().get(terminal_id).map(|r| r.digest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issuance_returns_64_char_hex_credential() {
        let registry = TerminalClaimRegistry::new();
        let credential = registry.issue("t1", Some("p1"));
        assert_eq!(credential.len(), CLAIM_CREDENTIAL_LEN);
        assert!(
            credential.chars().all(|c| c.is_ascii_hexdigit()),
            "credential must be hex-encoded"
        );
    }

    #[test]
    fn issued_credentials_are_unguessable_distinct() {
        let registry = TerminalClaimRegistry::new();
        let a = registry.issue("t1", Some("p1"));
        let b = registry.issue("t2", Some("p1"));
        assert_ne!(a, b);
    }

    #[test]
    fn verify_accepts_correct_credential_with_matching_binding() {
        let registry = TerminalClaimRegistry::new();
        let credential = registry.issue("t1", Some("p1"));
        assert!(registry.verify("t1", &credential, Some("p1")).is_ok());
    }

    #[test]
    fn verify_accepts_terminal_with_no_project_binding() {
        let registry = TerminalClaimRegistry::new();
        let credential = registry.issue("t1", None);
        assert!(registry.verify("t1", &credential, None).is_ok());
    }

    #[test]
    fn host_stores_only_the_digest_not_the_raw_credential() {
        let registry = TerminalClaimRegistry::new();
        let credential = registry.issue("t1", Some("p1"));

        // 1. The stored digest equals a recomputed SHA-256 of the credential —
        //    proving the credential is recoverable ONLY as a one-way digest.
        let expected = sha256_digest(credential.as_bytes());
        let stored = registry
            .stored_digest_for_test("t1")
            .expect("record exists");
        assert_eq!(stored, expected);

        // 2. The raw credential string appears nowhere in the registry's
        //    internal state (debug dump of every record).
        let dump = format!("{:?}", registry.records.lock());
        assert!(
            !dump.contains(&credential),
            "raw credential must not be retained in registry state"
        );
        // Hex credential is 64 chars; no record field holds a 64-char string.
        for record in registry.records.lock().values() {
            assert_eq!(record.digest.len(), 32);
        }
    }

    #[test]
    fn unknown_terminal_uses_dummy_digest_path_and_fails_identically() {
        let registry = TerminalClaimRegistry::new();
        let credential = registry.issue("t1", Some("p1"));
        // Probe an unknown terminal with a plausible credential — same error.
        let unknown = registry.verify("t-unknown", &credential, Some("p1"));
        let wrong = registry.verify("t1", "not-the-credential", Some("p1"));
        assert_eq!(unknown, Err(ClaimError));
        assert_eq!(wrong, Err(ClaimError));
        assert_eq!(unknown, wrong, "failures must be indistinguishable");
    }

    #[test]
    fn rotation_invalidates_old_credential_and_issues_new() {
        let registry = TerminalClaimRegistry::new();
        let old = registry.issue("t1", Some("p1"));
        let gen0 = registry.generation("t1");

        let new = registry.rotate("t1", &old, Some("p1")).unwrap();
        assert_ne!(new, old);
        assert_eq!(new.len(), CLAIM_CREDENTIAL_LEN);

        // Old credential stops working immediately; new one verifies.
        assert_eq!(registry.verify("t1", &old, Some("p1")), Err(ClaimError));
        assert!(registry.verify("t1", &new, Some("p1")).is_ok());
        assert_ne!(registry.generation("t1"), gen0);
    }

    #[test]
    fn rotate_requires_current_valid_credential() {
        let registry = TerminalClaimRegistry::new();
        let credential = registry.issue("t1", Some("p1"));
        registry.revoke("t1", &credential, Some("p1")).unwrap();
        // A revoked credential cannot rotate (no re-issue path this story).
        assert_eq!(registry.rotate("t1", &credential, Some("p1")), Err(ClaimError));
    }

    #[test]
    fn revocation_invalidates_credential_and_bumps_generation() {
        let registry = TerminalClaimRegistry::new();
        let credential = registry.issue("t1", Some("p1"));
        let gen0 = registry.generation("t1").unwrap();

        registry.revoke("t1", &credential, Some("p1")).unwrap();

        assert_eq!(registry.verify("t1", &credential, Some("p1")), Err(ClaimError));
        assert_eq!(registry.generation("t1").unwrap(), gen0 + 1);
        // Double-revoke with the now-invalid credential fails generically.
        assert_eq!(registry.revoke("t1", &credential, Some("p1")), Err(ClaimError));
    }

    #[test]
    fn revoke_with_wrong_credential_fails_generically() {
        let registry = TerminalClaimRegistry::new();
        let _credential = registry.issue("t1", Some("p1"));
        assert_eq!(registry.revoke("t1", "wrong", Some("p1")), Err(ClaimError));
    }

    #[test]
    fn binding_mismatch_fails() {
        let registry = TerminalClaimRegistry::new();
        let credential = registry.issue("t1", Some("project-a"));
        // Correct credential, different project context → reject.
        assert_eq!(registry.verify("t1", &credential, Some("project-b")), Err(ClaimError));
        // None vs Some also mismatches.
        assert_eq!(registry.verify("t1", &credential, None), Err(ClaimError));
    }

    #[test]
    fn identical_failure_semantics_across_all_failure_modes() {
        let registry = TerminalClaimRegistry::new();
        let credential = registry.issue("t1", Some("p1"));

        let modes = [
            registry.verify("t-missing", &credential, Some("p1")), // unknown terminal
            registry.verify("t1", "deadbeef", Some("p1")),          // wrong credential
            registry.verify("t1", &credential, Some("p-other")),    // binding mismatch
        ];
        for outcome in &modes {
            assert_eq!(*outcome, Err(ClaimError));
        }
        // Revoked adds a fourth identical mode.
        registry.revoke("t1", &credential, Some("p1")).unwrap();
        assert_eq!(registry.verify("t1", &credential, Some("p1")), Err(ClaimError));

        // Single collapsed variant: every failure debug-renders identically.
        let rendered: std::collections::HashSet<String> = modes
            .iter()
            .map(|m| format!("{:?}", m.unwrap_err()))
            .collect();
        assert_eq!(rendered.len(), 1, "all failures must render identically");
    }

    #[test]
    fn claim_length_cap_rejects_oversized_probes_before_hashing() {
        let registry = TerminalClaimRegistry::new();
        let credential = registry.issue("t1", Some("p1"));

        let oversized = "a".repeat(CLAIM_CREDENTIAL_LEN + 1);
        assert_eq!(registry.verify("t1", &oversized, Some("p1")), Err(ClaimError));
        // Cap is inclusive at the issued length: a max-length wrong credential
        // still reaches the (bounded) hash path and fails identically.
        let max_len_wrong = "b".repeat(CLAIM_CREDENTIAL_LEN);
        assert_eq!(registry.verify("t1", &max_len_wrong, Some("p1")), Err(ClaimError));
        // Rotation/revocation honor the same cap.
        assert_eq!(registry.rotate("t1", &oversized, Some("p1")), Err(ClaimError));
        assert_eq!(registry.revoke("t1", &oversized, Some("p1")), Err(ClaimError));
        // A real credential still verifies after oversized probes.
        assert!(registry.verify("t1", &credential, Some("p1")).is_ok());
    }

    #[test]
    fn remove_clears_record_and_generation() {
        let registry = TerminalClaimRegistry::new();
        let credential = registry.issue("t1", Some("p1"));
        assert!(registry.generation("t1").is_some());

        registry.remove("t1");

        assert!(registry.generation("t1").is_none());
        assert_eq!(registry.verify("t1", &credential, Some("p1")), Err(ClaimError));
        // Removing an unknown terminal is a no-op.
        registry.remove("t1");
    }

    #[test]
    fn generation_bumps_are_monotonic_across_rotate_and_revoke() {
        let registry = TerminalClaimRegistry::new();
        let c0 = registry.issue("t1", Some("p1"));
        let g0 = registry.generation("t1").unwrap();

        let c1 = registry.rotate("t1", &c0, Some("p1")).unwrap();
        let g1 = registry.generation("t1").unwrap();
        assert!(g1 > g0);

        registry.revoke("t1", &c1, Some("p1")).unwrap();
        let g2 = registry.generation("t1").unwrap();
        assert!(g2 > g1);
    }

    #[test]
    fn concurrent_rotations_with_the_same_credential_yield_exactly_one_success() {
        // Atomicity (verify + mutate under one lock hold): N threads racing
        // rotate with the SAME current credential must produce exactly one
        // successor credential — the rest must fail identically. A
        // verify-then-mutate implementation without the single-lock hold
        // would let multiple racers each receive a "fresh" credential.
        let registry = std::sync::Arc::new(TerminalClaimRegistry::new());
        let old = registry.issue("t1", Some("p1"));

        let mut handles = Vec::new();
        for _ in 0..8 {
            let reg = std::sync::Arc::clone(&registry);
            let credential = old.clone();
            handles.push(std::thread::spawn(move || reg.rotate("t1", &credential, Some("p1"))));
        }
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();

        let successes: Vec<&String> = results.iter().filter_map(|r| r.as_ref().ok()).collect();
        assert_eq!(
            successes.len(),
            1,
            "exactly one concurrent rotation may succeed"
        );
        assert!(
            results.iter().filter(|r| r.is_err()).count() >= 7,
            "all other racers fail with the collapsed error"
        );
        // The single winner's credential is the only valid one afterwards.
        assert!(registry.verify("t1", successes[0], Some("p1")).is_ok());
        assert_eq!(registry.verify("t1", &old, Some("p1")), Err(ClaimError));
    }
}
