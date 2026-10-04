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
        assert!(record.digests.iter().all(|d| d.len() == 32));
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
    assert_eq!(
        registry.rotate("t1", &credential, Some("p1")),
        Err(ClaimError)
    );
}

#[test]
fn revocation_invalidates_credential_and_bumps_generation() {
    let registry = TerminalClaimRegistry::new();
    let credential = registry.issue("t1", Some("p1"));
    let gen0 = registry.generation("t1").unwrap();

    registry.revoke("t1", &credential, Some("p1")).unwrap();

    assert_eq!(
        registry.verify("t1", &credential, Some("p1")),
        Err(ClaimError)
    );
    assert_eq!(registry.generation("t1").unwrap(), gen0 + 1);
    // Double-revoke with the now-invalid credential fails generically.
    assert_eq!(
        registry.revoke("t1", &credential, Some("p1")),
        Err(ClaimError)
    );
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
    assert_eq!(
        registry.verify("t1", &credential, Some("project-b")),
        Err(ClaimError)
    );
    // None vs Some also mismatches.
    assert_eq!(registry.verify("t1", &credential, None), Err(ClaimError));
}

#[test]
fn identical_failure_semantics_across_all_failure_modes() {
    let registry = TerminalClaimRegistry::new();
    let credential = registry.issue("t1", Some("p1"));

    let modes = [
        registry.verify("t-missing", &credential, Some("p1")), // unknown terminal
        registry.verify("t1", "deadbeef", Some("p1")),         // wrong credential
        registry.verify("t1", &credential, Some("p-other")),   // binding mismatch
    ];
    for outcome in &modes {
        assert_eq!(*outcome, Err(ClaimError));
    }
    // Revoked adds a fourth identical mode.
    registry.revoke("t1", &credential, Some("p1")).unwrap();
    assert_eq!(
        registry.verify("t1", &credential, Some("p1")),
        Err(ClaimError)
    );

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
    assert_eq!(
        registry.verify("t1", &oversized, Some("p1")),
        Err(ClaimError)
    );
    // Cap is inclusive at the issued length: a max-length wrong credential
    // still reaches the (bounded) hash path and fails identically.
    let max_len_wrong = "b".repeat(CLAIM_CREDENTIAL_LEN);
    assert_eq!(
        registry.verify("t1", &max_len_wrong, Some("p1")),
        Err(ClaimError)
    );
    // Rotation/revocation honor the same cap.
    assert_eq!(
        registry.rotate("t1", &oversized, Some("p1")),
        Err(ClaimError)
    );
    assert_eq!(
        registry.revoke("t1", &oversized, Some("p1")),
        Err(ClaimError)
    );
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
    assert_eq!(
        registry.verify("t1", &credential, Some("p1")),
        Err(ClaimError)
    );
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
        handles.push(std::thread::spawn(move || {
            reg.rotate("t1", &credential, Some("p1"))
        }));
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

// ---------------------------------------------------------------------------
// #851: shared (multi-holder) credentials — a second web client attaching
// read/write to the same PTY must not invalidate the first holder's lease.
// ---------------------------------------------------------------------------

#[test]
fn issue_shared_appends_without_invalidating_primary() {
    let registry = TerminalClaimRegistry::new();
    let primary = registry.issue("t1", Some("p1"));
    let shared = registry
        .issue_shared("t1", Some("p1"))
        .expect("shared issuance on a live record succeeds");

    assert_ne!(primary, shared);
    // BOTH credentials verify — the first holder's stream + write access is
    // untouched (generation unchanged, no severance).
    assert!(registry.verify("t1", &primary, Some("p1")).is_ok());
    assert!(registry.verify("t1", &shared, Some("p1")).is_ok());
    assert_eq!(registry.holder_count("t1"), 2);
}

#[test]
fn issue_shared_unknown_or_revoked_record_fails_generically() {
    let registry = TerminalClaimRegistry::new();
    // Unknown terminal: the same collapsed error as any bad credential —
    // no existence signal.
    assert_eq!(registry.issue_shared("nope", Some("p1")), Err(ClaimError));
    // Revoked records never mint new holders (no lease resurrection).
    let credential = registry.issue("t1", Some("p1"));
    registry.revoke("t1", &credential, Some("p1")).unwrap();
    assert_eq!(registry.issue_shared("t1", Some("p1")), Err(ClaimError));
}

#[test]
fn issue_shared_binding_mismatch_fails() {
    let registry = TerminalClaimRegistry::new();
    let _primary = registry.issue("t1", Some("p1"));
    // A shared issuance scoped to a different project cannot mint a
    // credential against a terminal bound elsewhere.
    assert!(registry.issue_shared("t1", Some("p2")).is_err());
}

#[test]
fn rotate_severs_all_shared_holders() {
    // Rotation is an ownership hand-off: the successor becomes the ONLY
    // valid credential and every co-attacher is severed via the generation
    // bump (forwarders observe it and terminate).
    let registry = TerminalClaimRegistry::new();
    let primary = registry.issue("t1", Some("p1"));
    let shared = registry.issue_shared("t1", Some("p1")).unwrap();
    let g0 = registry.generation("t1").unwrap();

    let successor = registry.rotate("t1", &shared, Some("p1")).unwrap();
    let g1 = registry.generation("t1").unwrap();
    assert!(g1 > g0, "rotate bumps the generation even from a shared holder");
    assert!(registry.verify("t1", &successor, Some("p1")).is_ok());
    assert_eq!(registry.verify("t1", &primary, Some("p1")), Err(ClaimError));
    assert_eq!(registry.verify("t1", &shared, Some("p1")), Err(ClaimError));
    assert_eq!(registry.holder_count("t1"), 1);
}

#[test]
fn revoke_marks_every_shared_holder_dead() {
    let registry = TerminalClaimRegistry::new();
    let primary = registry.issue("t1", Some("p1"));
    let shared = registry.issue_shared("t1", Some("p1")).unwrap();

    // Either holder may revoke; the whole record dies.
    registry.revoke("t1", &shared, Some("p1")).unwrap();
    assert_eq!(registry.verify("t1", &primary, Some("p1")), Err(ClaimError));
    assert_eq!(registry.verify("t1", &shared, Some("p1")), Err(ClaimError));
}

#[test]
fn issue_replaces_shared_holders_entirely() {
    // `issue` (spawn / reload re-issue) replaces the record: all shared
    // holders are gone and only the fresh credential verifies. This is the
    // pre-existing reload semantics, preserved under the multi-holder model.
    let registry = TerminalClaimRegistry::new();
    let primary = registry.issue("t1", Some("p1"));
    let shared = registry.issue_shared("t1", Some("p1")).unwrap();

    let reissued = registry.issue("t1", Some("p1"));
    assert!(registry.verify("t1", &reissued, Some("p1")).is_ok());
    assert_eq!(registry.verify("t1", &primary, Some("p1")), Err(ClaimError));
    assert_eq!(registry.verify("t1", &shared, Some("p1")), Err(ClaimError));
    assert_eq!(registry.holder_count("t1"), 1);
}
