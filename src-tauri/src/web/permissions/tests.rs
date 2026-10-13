#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;
use serde_json::json;


/// Build `options` JSON matching the ACP `PermissionOption` wire shape.
fn options_value(ids: &[&str]) -> Value {
    json!(ids
        .iter()
        .map(|id| json!({ "optionId": id, "name": id, "kind": "auto" }))
        .collect::<Vec<_>>())
}

#[test]
fn option_id_validation_matches_known_option() {
    let opts = options_value(&["allow", "deny"]);
    assert!(option_id_is_valid(&opts, "allow"));
    assert!(option_id_is_valid(&opts, "deny"));
    // TOCTOU: an option not in the original request is rejected.
    assert!(!option_id_is_valid(&opts, "escalate"));
    assert!(!option_id_is_valid(&opts, ""));
}

#[test]
fn option_id_validation_rejects_non_array_or_missing_field() {
    assert!(!option_id_is_valid(&json!("not-an-array"), "allow"));
    assert!(!option_id_is_valid(&json!([{}]), "allow")); // no optionId field
    assert!(!option_id_is_valid(&json!(null), "allow"));
}

#[test]
fn turn_claim_release_releases_exact_claim_when_cancelled() {
    let watermark = TurnWatermark::new();
    assert_eq!(
        watermark.claim_turn("session-1", Some("turn-1")),
        TurnClaim::Claimed
    );
    assert_eq!(
        watermark.claim_turn("session-1", Some("turn-2")),
        TurnClaim::Busy
    );
    watermark.release_claim("session-1", Some("turn-1"));
    assert_eq!(
        watermark.claim_turn("session-1", Some("turn-2")),
        TurnClaim::Claimed
    );
}

#[test]
fn turn_claim_completion_records_stale_watermark() {
    let watermark = TurnWatermark::new();
    assert_eq!(
        watermark.claim_turn("session-1", Some("turn-1")),
        TurnClaim::Claimed
    );
    watermark.record_completed("session-1", "turn-1");
    assert_eq!(
        watermark.claim_turn("session-1", Some("turn-1")),
        TurnClaim::Completed
    );
    assert_eq!(
        watermark.claim_turn("session-1", Some("turn-2")),
        TurnClaim::Claimed
    );
}

// --- Rendezvous bookkeeping tests -----------------------------------------
//
// These exercise the relay-side ticket table + the rendezvous policy
// (at-most-one, first-wins, stale/duplicate, TOCTOU) WITHOUT a real agent. The
// `AcpManager` is a no-op (`AcpManager::new(vec![])` — `respond_permission`
// returns an "unknown agent" `Err` which the rendezvous logs-and-continues).
// Assertions target the ticket state (outstanding/queued/resolved/evicted) + the
// `try_respond` outcome/error — the agent-side `Responder` resolution is
// covered by the `#[ignore]` e2e test in `acp/tests.rs`. Lifecycle release and
// the no-timer rule are in `durable_tests.rs`.

/// Drive an async block on a single-threaded tokio runtime (mirrors the
/// `handle_sync` helper in `web/ws.rs`).
fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(future)
}

/// A rendezvous bound to a no-op `AcpManager` (agent calls log-and-continue).
fn test_rendezvous() -> Arc<PermissionRendezvous> {
    Arc::new(PermissionRendezvous::new(Arc::new(AcpManager::new(vec![]))))
}

/// Story 1.7 AC3: first-response-wins — a second client's `try_respond` is
/// rejected. The first response resolves + evicts the ticket but leaves a
/// tombstone, so the second (and any later) answer sees `AlreadyResolved`
/// (wire `err.code: "already_resolved"`); a ticket that never existed stays
/// `NotFound` (`stale`).
#[test]
fn first_response_wins_second_is_rejected_already_resolved() {
    let rdz = test_rendezvous();
    let client_a = ClientId::new();
    let client_b = ClientId::new();
    block_on(async {
        // Construct-time handle capture + register inside the runtime.
        rdz.register(
            "perm-1".to_string(),
            AgentId("a1".to_string()),
            "sess-1".to_string(),
            options_value(&["allow", "deny"]),
        );
        let a = rdz.try_respond(client_a, "perm-1", Some("allow")).await;
        let b = rdz.try_respond(client_b, "perm-1", Some("deny")).await;
        assert_eq!(a, Ok(RespondOutcome::Resolved), "first response wins");
        assert_eq!(b, Err(RespondError::AlreadyResolved));
        assert_eq!(b.unwrap_err().wire_code(), "already_resolved");
        // A third call is still `AlreadyResolved`; an unknown ticket is `stale`.
        let c = rdz
            .try_respond(ClientId::new(), "perm-1", Some("allow"))
            .await;
        assert_eq!(c, Err(RespondError::AlreadyResolved));
        let unknown = rdz
            .try_respond(ClientId::new(), "perm-never", Some("allow"))
            .await;
        assert_eq!(unknown, Err(RespondError::NotFound));
        assert_eq!(RespondError::NotFound.wire_code(), "stale");
    });
}

/// Tombstones are bounded: past `RESOLVED_TOMBSTONE_CAPACITY` newer
/// resolutions the oldest id falls back to `NotFound` (`stale`).
#[test]
fn resolved_tombstones_are_bounded() {
    let rdz = test_rendezvous();
    block_on(async {
        let client = ClientId::new();
        for n in 0..=RESOLVED_TOMBSTONE_CAPACITY {
            let id = format!("perm-{n}");
            rdz.register(
                id.clone(),
                AgentId("a1".to_string()),
                format!("sess-{n}"),
                options_value(&["allow"]),
            );
            assert_eq!(
                rdz.try_respond(client, &id, Some("allow")).await,
                Ok(RespondOutcome::Resolved)
            );
        }
        assert_eq!(
            rdz.try_respond(ClientId::new(), "perm-0", Some("allow")).await,
            Err(RespondError::NotFound),
            "the oldest tombstone aged out"
        );
        assert_eq!(
            rdz.try_respond(
                ClientId::new(),
                &format!("perm-{RESOLVED_TOMBSTONE_CAPACITY}"),
                Some("allow")
            )
            .await,
            Err(RespondError::AlreadyResolved),
            "the newest is still remembered"
        );
    });
}

/// Story 1.7 AC3: TOCTOU — an `option_id` not in the original immutable
/// `options` is rejected as `InvalidOption` (→ `permission_denied`).
#[test]
fn toctou_invalid_option_is_rejected() {
    let rdz = test_rendezvous();
    let client = ClientId::new();
    block_on(async {
        rdz.register(
            "perm-toctou".to_string(),
            AgentId("a1".to_string()),
            "sess-1".to_string(),
            options_value(&["allow", "deny"]),
        );
        let outcome = rdz
            .try_respond(client, "perm-toctou", Some("escalate"))
            .await;
        assert_eq!(outcome, Err(RespondError::InvalidOption));
        assert_eq!(RespondError::InvalidOption.wire_code(), "permission_denied");
        // The ticket is still outstanding (rejected, not resolved) — a valid
        // option can still win.
        assert!(rdz.is_outstanding("perm-toctou"));
        let ok = rdz.try_respond(client, "perm-toctou", Some("allow")).await;
        assert_eq!(ok, Ok(RespondOutcome::Resolved));
    });
}

/// Story 1.7 AC3: cancel (option_id=None) is always allowed — resolves the
/// ticket as deny (`Cancelled`) without TOCTOU option validation.
#[test]
fn cancel_option_none_resolves_and_evicts() {
    let rdz = test_rendezvous();
    let client = ClientId::new();
    block_on(async {
        rdz.register(
            "perm-cancel".to_string(),
            AgentId("a1".to_string()),
            "sess-1".to_string(),
            options_value(&["allow", "deny"]),
        );
        let outcome = rdz.try_respond(client, "perm-cancel", None).await;
        assert_eq!(outcome, Ok(RespondOutcome::Resolved));
        assert!(
            !rdz.is_outstanding("perm-cancel"),
            "resolved ticket is evicted"
        );
    });
}

/// Story 1.7 AC3: at-most-one outstanding per session — a second
/// `permission_request` on the same session while one is outstanding is
/// QUEUED (not surfaced/armed), and is promoted only after the first resolves.
#[test]
fn at_most_one_outstanding_per_session_queues_the_rest() {
    let rdz = test_rendezvous();
    let client = ClientId::new();
    block_on(async {
        // First permission → outstanding.
        rdz.register(
            "perm-q1".to_string(),
            AgentId("a1".to_string()),
            "sess-q".to_string(),
            options_value(&["allow"]),
        );
        assert!(rdz.is_outstanding("perm-q1"));
        // Second permission on the SAME session → queued, NOT outstanding.
        rdz.register(
            "perm-q2".to_string(),
            AgentId("a1".to_string()),
            "sess-q".to_string(),
            options_value(&["allow"]),
        );
        assert!(
            !rdz.is_outstanding("perm-q2"),
            "second permission is queued, not outstanding"
        );
        assert_eq!(rdz.queued_count_for_session("sess-q"), 1);
        // Resolving the first promotes the second.
        let _ = rdz.try_respond(client, "perm-q1", Some("allow")).await;
        assert!(
            rdz.is_outstanding("perm-q2"),
            "queued permission promoted after the first resolves"
        );
        assert_eq!(rdz.queued_count_for_session("sess-q"), 0);
    });
}

/// Story 1.7: `session_for_request` / `agent_for_request` resolve the
/// ticket's session/agent for the `/ws` handler's ownership + defense-in-depth
/// checks. `None` once the ticket is evicted (resolved/timed-out).
#[test]
fn session_and_agent_for_request_resolve_and_evict() {
    let rdz = test_rendezvous();
    let client = ClientId::new();
    block_on(async {
        rdz.register(
            "perm-lookup".to_string(),
            AgentId("a-lookup".to_string()),
            "sess-lookup".to_string(),
            options_value(&["allow"]),
        );
        assert_eq!(
            rdz.session_for_request("perm-lookup").as_deref(),
            Some("sess-lookup")
        );
        assert_eq!(
            rdz.agent_for_request("perm-lookup"),
            Some(AgentId("a-lookup".to_string()))
        );
        let _ = rdz.try_respond(client, "perm-lookup", Some("allow")).await;
        // Evicted after resolution.
        assert!(rdz.session_for_request("perm-lookup").is_none());
        assert!(rdz.agent_for_request("perm-lookup").is_none());
    });
}

// --- Turn-id watermark (Story 1.7 T7.2 — FR13/FR11 plumbing) ------------

#[test]
fn turn_watermark_dedups_seen_turn_ids() {
    let wm = TurnWatermark::new();
    // First sight of a turn-id → new (process it).
    assert!(wm.mark_seen("sess-1", "turn-a"), "first sight is new");
    // Same turn-id again → duplicate (drop it — prompt_complete is idempotent).
    assert!(
        !wm.mark_seen("sess-1", "turn-a"),
        "second sight is a duplicate"
    );
    assert!(wm.is_seen("sess-1", "turn-a"));
    assert!(!wm.is_seen("sess-1", "turn-b"));
    // Different session is independent.
    assert!(wm.mark_seen("sess-2", "turn-a"));
}

#[test]
fn turn_watermark_claims_and_releases_atomically() {
    let wm = TurnWatermark::new();
    assert_eq!(wm.claim_turn("sess", Some("turn-a")), TurnClaim::Claimed);
    assert_eq!(
        wm.claim_turn("sess", Some("turn-a")),
        TurnClaim::DuplicateInFlight
    );
    assert_eq!(wm.claim_turn("sess", Some("turn-b")), TurnClaim::Busy);
    wm.release_claim("sess", Some("turn-a"));
    assert_eq!(wm.claim_turn("sess", Some("turn-b")), TurnClaim::Claimed);
    wm.record_completed("sess", "turn-b");
    assert_eq!(wm.claim_turn("sess", Some("turn-b")), TurnClaim::Completed);
}

#[test]
fn turn_watermark_records_and_queries_last_completed() {
    let wm = TurnWatermark::new();
    assert!(wm.last_completed("sess-1").is_none());
    wm.record_completed("sess-1", "turn-1");
    assert_eq!(wm.last_completed("sess-1").as_deref(), Some("turn-1"));
    // `is_completed` is true only for the exact watermark turn-id.
    assert!(wm.is_completed("sess-1", "turn-1"));
    assert!(
        !wm.is_completed("sess-1", "turn-0"),
        "an older turn-id is not the watermark"
    );
    assert!(
        !wm.is_completed("sess-1", "turn-2"),
        "a newer turn-id is not yet completed"
    );
    assert!(
        !wm.is_completed("sess-2", "turn-1"),
        "a different session is not completed"
    );
}

#[test]
fn turn_watermark_forgets_session_state() {
    let wm = TurnWatermark::new();
    wm.mark_seen("sess-1", "turn-a");
    wm.record_completed("sess-1", "turn-a");
    wm.forget_session("sess-1");
    assert!(wm.last_completed("sess-1").is_none());
    assert!(!wm.is_seen("sess-1", "turn-a"));
    // Forgetting a non-existent session is a no-op.
    wm.forget_session("never-existed");
}

/// Story 1.7 AC3: duplicate — the SAME client responding twice is `Duplicate`
/// (→ wire `err.code: "duplicate"`). The first response resolves (evicts)
/// the ticket; the same-client second call sees `NotFound` first. The
/// `Duplicate` path is the race where the ticket is still outstanding when
/// the same client retries — here we assert the wire-code mapping directly.
#[test]
fn duplicate_wire_code_is_duplicate() {
    assert_eq!(RespondError::Duplicate.wire_code(), "duplicate");
}

/// Story 1.7 AC3 (same-client double-respond): the SAME client responding
/// twice to the same ticket. The first resolves (evicts the ticket); the
/// second is rejected. On a single-threaded runtime the no-op
/// `AcpManager::respond_permission` returns `Err` synchronously (no yield at
/// the claim→await gap), so the first `try_respond` completes before the
/// second's read-check → the second sees `NotFound` (the ticket is evicted),
/// NOT `Duplicate`. `Duplicate` is the genuine multi-threaded race window
/// (same client, ticket claimed-but-not-evicted) — structurally guarded by
/// the claim re-check at `try_respond`'s write-lock; its wire code
/// (`"duplicate"`) is asserted by `duplicate_wire_code_is_duplicate`. This
/// test exercises the same-client double-respond path end-to-end (the
/// rejection is `stale`-coded regardless of which rejection variant fires).
#[test]
fn same_client_double_respond_is_rejected() {
    let rdz = test_rendezvous();
    let client = ClientId::new();
    block_on(async {
        rdz.register(
            "perm-dup".to_string(),
            AgentId("a1".to_string()),
            "sess-dup".to_string(),
            options_value(&["allow"]),
        );
        let (a, b) = tokio::join!(
            rdz.try_respond(client, "perm-dup", Some("allow")),
            rdz.try_respond(client, "perm-dup", Some("allow")),
        );
        // Exactly one wins. On this single-threaded runtime the winner's
        // eviction completes before the loser's recheck, so the loser always
        // reads the tombstone (`AlreadyResolved`); `Duplicate` needs a real
        // multi-threaded race and is asserted by its own wire-code test.
        let loser = if a.is_ok() { b } else { a };
        let winner = if a.is_ok() { a } else { b };
        assert!(winner.is_ok(), "one response must win: ({a:?}, {b:?})");
        assert!(loser.is_err(), "the other must be rejected");
        assert_eq!(
            loser.unwrap_err().wire_code(),
            "already_resolved",
            "same-client double-respond rejection wires as already_resolved"
        );
    });
}

/// The agent reports no outstanding responder (it resolved the request
/// elsewhere, e.g. at turn completion): THIS answer is `stale`, but the ticket
/// is remembered so any later answer reads `already_resolved`.
#[test]
fn agent_reported_unknown_request_leaves_a_tombstone() {
    block_on(async {
        let acp = Arc::new(AcpManager::new(vec![]));
        acp.install_test_agent_without_responders(AgentId("a1".to_string()));

        let permissions = Arc::new(PermissionRendezvous::new(Arc::clone(&acp)));
        permissions.register(
            "perm-gone".to_string(),
            AgentId("a1".to_string()),
            "sess-1".to_string(),
            options_value(&["allow"]),
        );
        assert_eq!(
            permissions.try_respond(ClientId::new(), "perm-gone", Some("allow")).await,
            Err(RespondError::NotFound)
        );
        assert_eq!(
            permissions.try_respond(ClientId::new(), "perm-gone", Some("allow")).await,
            Err(RespondError::AlreadyResolved)
        );
    });
}
