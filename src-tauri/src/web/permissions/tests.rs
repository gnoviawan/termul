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

// --- Rendezvous bookkeeping tests (Story 1.7 AC3) -------------------------
//
// These exercise the relay-side ticket table + the rendezvous policy
// (at-most-one, first-wins, stale/duplicate, TOCTOU, disconnect-deny,
// timeout-deny) WITHOUT a real agent. The `AcpManager` is a no-op
// (`AcpManager::new(vec![])` — `respond_permission` returns an "unknown
// agent" `Err` which the rendezvous logs-and-continues). Assertions target
// the ticket state (outstanding/queued/resolved/evicted) + the
// `try_respond` outcome/error — the agent-side `Responder` resolution is
// covered by the `#[ignore]` e2e test in `acp/tests.rs`.
//
// The rendezvous captures the tokio runtime handle at construction (so the
// per-ticket timeout can be armed from the agent driver thread). The tests
// therefore construct the rendezvous + call `register`/`try_respond` INSIDE
// a single-threaded runtime (`block_on`) so the handle is captured and the
// `Err`-fallback `tokio::spawn` path (if any) has a runtime to spawn onto.

/// Drive an async block on a single-threaded tokio runtime (mirrors the
/// `handle_sync` helper in `web/ws.rs`).
fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(future)
}

/// A rendezvous bound to a no-op `AcpManager` with the default 60s timeout
/// (agent calls log-and-continue). Construct INSIDE a runtime context.
fn test_rendezvous() -> Arc<PermissionRendezvous> {
    Arc::new(PermissionRendezvous::with_timeout(
        Arc::new(AcpManager::new(vec![])),
        Duration::from_secs(60),
    ))
}

/// Build `options` JSON matching the `AskUserQuestionEvent` wire shape
/// (issue #411) — single-select options (no `cardinality` → single).
fn question_options_value(values: &[&str]) -> Value {
    json!(values
        .iter()
        .map(|v| json!({ "value": v, "label": v }))
        .collect::<Vec<_>>())
}

/// A question rendezvous bound to a no-op `AcpManager` with the default 60s
/// timeout (issue #411). Construct INSIDE a runtime context.
fn test_question_rendezvous() -> Arc<QuestionRendezvous> {
    Arc::new(QuestionRendezvous::with_timeout(
        Arc::new(AcpManager::new(vec![])),
        Duration::from_secs(60),
    ))
}

/// Story 1.7 AC3: first-response-wins — a second client's `try_respond` is
/// rejected. The first response resolves + evicts the ticket; the second
/// therefore sees `NotFound` (the ticket is gone) or `AlreadyResolved` (the
/// rare race where the ticket is resolved but not yet evicted). BOTH map to
/// wire `err.code: "stale"` — the assertion is on the stable wire code.
#[test]
fn first_response_wins_second_is_rejected_stale() {
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
        // Second is rejected — either NotFound (ticket evicted) or
        // AlreadyResolved (race window); both wire as `stale`.
        assert!(
            matches!(
                b,
                Err(RespondError::NotFound) | Err(RespondError::AlreadyResolved)
            ),
            "second response must be rejected (stale), got {b:?}"
        );
        let b_code = b.unwrap_err().wire_code();
        assert_eq!(b_code, "stale", "first-wins rejection wires as `stale`");
        // A third call is NotFound (also stale).
        let c = rdz
            .try_respond(ClientId::new(), "perm-1", Some("allow"))
            .await;
        assert_eq!(c, Err(RespondError::NotFound));
    });
}

/// Issue #411: first-response-wins for questions — the second answer is
/// rejected `stale` regardless of which rejection variant fires.
#[test]
fn question_first_response_wins_second_is_rejected_stale() {
    let rdz = test_question_rendezvous();
    let client = ClientId::new();
    block_on(async {
        rdz.register(
            "q-1".to_string(),
            AgentId("a1".to_string()),
            "sess-1".to_string(),
            question_options_value(&["plan-a", "plan-b"]),
        );
        let first = rdz
            .try_respond(client, "q-1", Some(&["plan-a".to_string()]))
            .await;
        assert_eq!(first, Ok(QuestionRespondOutcome::Resolved));
        let second = rdz
            .try_respond(client, "q-1", Some(&["plan-b".to_string()]))
            .await;
        assert!(
            matches!(
                second,
                Err(QuestionRespondError::NotFound) | Err(QuestionRespondError::AlreadyResolved)
            ),
            "second response must be rejected (stale), got {second:?}"
        );
        assert_eq!(
            second.unwrap_err().wire_code(),
            "stale",
            "first-wins rejection wires as `stale`"
        );
    });
}

/// Issue #411: TOCTOU — a value not among the original immutable options
/// is rejected as `InvalidOption` (→ `permission_denied`), and the ticket
/// stays outstanding so a valid answer can still win.
#[test]
fn question_toctou_invalid_value_is_rejected() {
    let rdz = test_question_rendezvous();
    let client = ClientId::new();
    block_on(async {
        rdz.register(
            "q-toctou".to_string(),
            AgentId("a1".to_string()),
            "sess-1".to_string(),
            question_options_value(&["plan-a", "plan-b"]),
        );
        let outcome = rdz
            .try_respond(client, "q-toctou", Some(&["escalate".to_string()]))
            .await;
        assert_eq!(outcome, Err(QuestionRespondError::InvalidOption));
        assert_eq!(
            QuestionRespondError::InvalidOption.wire_code(),
            "permission_denied"
        );
        assert!(rdz.is_outstanding("q-toctou"));
        let ok = rdz
            .try_respond(client, "q-toctou", Some(&["plan-a".to_string()]))
            .await;
        assert_eq!(ok, Ok(QuestionRespondOutcome::Resolved));
    });
}

/// Issue #411: single-select enforces at-most-one value; multi-select
/// allows several (as long as every value is a registered option).
#[test]
fn question_cardinality_single_rejects_multiple_values() {
    let rdz = test_question_rendezvous();
    let client = ClientId::new();
    block_on(async {
        rdz.register(
            "q-single".to_string(),
            AgentId("a1".to_string()),
            "sess-1".to_string(),
            question_options_value(&["plan-a", "plan-b"]),
        );
        let rejected = rdz
            .try_respond(
                client,
                "q-single",
                Some(&["plan-a".to_string(), "plan-b".to_string()]),
            )
            .await;
        assert_eq!(rejected, Err(QuestionRespondError::InvalidOption));
        // multi-select accepts several valid values
        rdz.register(
            "q-multi".to_string(),
            AgentId("a1".to_string()),
            "sess-1".to_string(),
            serde_json::json!([
                { "value": "a", "label": "A", "cardinality": "multi" },
                { "value": "b", "label": "B", "cardinality": "multi" },
            ]),
        );
        let ok = rdz
            .try_respond(client, "q-multi", Some(&["a".to_string(), "b".to_string()]))
            .await;
        assert_eq!(ok, Ok(QuestionRespondOutcome::Resolved));
    });
}

/// Issue #411: an EMPTY values array is neither a selection nor a cancel
/// — it must be rejected (clients send `None` to cancel). CodeRabbit.
#[test]
fn question_empty_values_array_is_rejected() {
    let rdz = test_question_rendezvous();
    let client = ClientId::new();
    block_on(async {
        rdz.register(
            "q-empty".to_string(),
            AgentId("a1".to_string()),
            "sess-1".to_string(),
            question_options_value(&["plan-a"]),
        );
        let rejected = rdz.try_respond(client, "q-empty", Some(&[])).await;
        assert_eq!(rejected, Err(QuestionRespondError::InvalidOption));
        // Ticket stays outstanding; a real answer still works.
        let ok = rdz
            .try_respond(client, "q-empty", Some(&["plan-a".to_string()]))
            .await;
        assert_eq!(ok, Ok(QuestionRespondOutcome::Resolved));
    });
}

/// Issue #411: cancel (values=None) is always allowed — resolves the
/// ticket as cancelled without TOCTOU option validation.
#[test]
fn question_cancel_none_resolves_and_evicts() {
    let rdz = test_question_rendezvous();
    let client = ClientId::new();
    block_on(async {
        rdz.register(
            "q-cancel".to_string(),
            AgentId("a1".to_string()),
            "sess-1".to_string(),
            question_options_value(&["plan-a"]),
        );
        let outcome = rdz.try_respond(client, "q-cancel", None).await;
        assert_eq!(outcome, Ok(QuestionRespondOutcome::Resolved));
        assert!(!rdz.is_outstanding("q-cancel"));
        let stale = rdz.try_respond(client, "q-cancel", None).await;
        assert_eq!(stale, Err(QuestionRespondError::NotFound));
    });
}

/// Issue #411: disconnect-deny — when the last subscriber leaves the
/// session, its outstanding questions are resolved cancelled.
#[test]
fn question_disconnect_denies_when_no_subscribers_remain() {
    let rdz = test_question_rendezvous();
    block_on(async {
        rdz.register(
            "q-disc".to_string(),
            AgentId("a1".to_string()),
            "sess-1".to_string(),
            question_options_value(&["plan-a"]),
        );
        // zero remaining subscribers → deny
        rdz.deny_all_for_client(|_| 0).await;
        assert!(!rdz.is_outstanding("q-disc"));
        // with a remaining subscriber → untouched
        rdz.register(
            "q-keep".to_string(),
            AgentId("a1".to_string()),
            "sess-1".to_string(),
            question_options_value(&["plan-a"]),
        );
        rdz.deny_all_for_client(|_| 1).await;
        assert!(rdz.is_outstanding("q-keep"));
    });
}

/// Issue #411: timeout resolves the ticket as cancelled (expiry promotes).
#[test]
fn question_timeout_deny_resolves_and_evicts() {
    let rdz = Arc::new(QuestionRendezvous::with_timeout(
        Arc::new(AcpManager::new(vec![])),
        Duration::from_millis(30),
    ));
    block_on(async {
        rdz.register(
            "q-timeout".to_string(),
            AgentId("a1".to_string()),
            "sess-1".to_string(),
            question_options_value(&["plan-a"]),
        );
        tokio::time::sleep(Duration::from_millis(120)).await;
        assert!(!rdz.is_outstanding("q-timeout"));
        let stale = rdz
            .try_respond(ClientId::new(), "q-timeout", Some(&["plan-a".to_string()]))
            .await;
        assert_eq!(stale, Err(QuestionRespondError::NotFound));
    });
}

/// Issue #411: same-client double-respond — exactly one wins; the loser is
/// `stale`-coded.
#[test]
fn question_same_client_double_respond_is_rejected() {
    let rdz = test_question_rendezvous();
    let client = ClientId::new();
    block_on(async {
        rdz.register(
            "q-dup".to_string(),
            AgentId("a1".to_string()),
            "sess-dup".to_string(),
            question_options_value(&["plan-a"]),
        );
        let answer = vec!["plan-a".to_string()];
        let (a, b) = tokio::join!(
            rdz.try_respond(client, "q-dup", Some(&answer)),
            rdz.try_respond(client, "q-dup", Some(&answer)),
        );
        let loser = if a.is_ok() { b } else { a };
        let winner = if a.is_ok() { a } else { b };
        assert!(winner.is_ok(), "one answer must win: ({a:?}, {b:?})");
        assert!(loser.is_err(), "the other must be rejected");
        assert_eq!(loser.unwrap_err().wire_code(), "stale");
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

/// Story 1.7 AC3: timeout → deny. A ticket whose bounded timeout elapses is
/// resolved as deny and evicted. Uses a tiny timeout + a generous poll loop
/// (the spawned deny task runs on this single-threaded runtime when the poll
/// yields). The 60-iteration × 25ms budget (1500ms for a 50ms timeout) gives
/// 30× headroom; a deterministic `tokio::time::pause`/`advance` driver would
/// require the `test-util` feature (deferred — the polling is robust enough
/// for the gate and the deny path is also unit-tested via `deny_after_*`).
#[test]
fn timeout_deny_resolves_and_evicts() {
    let rdz = Arc::new(PermissionRendezvous::with_timeout(
        Arc::new(AcpManager::new(vec![])),
        Duration::from_millis(50),
    ));
    block_on(async {
        rdz.register(
            "perm-tmo".to_string(),
            AgentId("a1".to_string()),
            "sess-tmo".to_string(),
            options_value(&["allow"]),
        );
        assert!(rdz.is_outstanding("perm-tmo"));
        let mut evicted = false;
        for _ in 0..60 {
            tokio::time::sleep(Duration::from_millis(25)).await;
            tokio::task::yield_now().await;
            if !rdz.is_outstanding("perm-tmo") {
                evicted = true;
                break;
            }
        }
        assert!(evicted, "timed-out ticket must be evicted");
        assert!(
            !rdz.is_outstanding("perm-tmo"),
            "timed-out ticket is evicted"
        );
    });
}

/// Story 1.7 AC3: expiry → deny is the same resolution path as timeout
/// (both reach `deny` with `DenyReason::Timeout`). This test asserts the
/// deny path also promotes the session queue. Same polling approach as
/// `timeout_deny_resolves_and_evicts` (60×25ms budget for a 50ms timeout).
#[test]
fn expiry_deny_promotes_the_queue() {
    let rdz = Arc::new(PermissionRendezvous::with_timeout(
        Arc::new(AcpManager::new(vec![])),
        Duration::from_millis(50),
    ));
    block_on(async {
        rdz.register(
            "perm-e1".to_string(),
            AgentId("a1".to_string()),
            "sess-e".to_string(),
            options_value(&["allow"]),
        );
        // Queue a second on the same session.
        rdz.register(
            "perm-e2".to_string(),
            AgentId("a1".to_string()),
            "sess-e".to_string(),
            options_value(&["allow"]),
        );
        assert!(!rdz.is_outstanding("perm-e2"));
        let mut promoted = false;
        for _ in 0..60 {
            tokio::time::sleep(Duration::from_millis(25)).await;
            tokio::task::yield_now().await;
            if rdz.is_outstanding("perm-e2") {
                promoted = true;
                break;
            }
        }
        assert!(
            !rdz.is_outstanding("perm-e1"),
            "perm-e1 evicted by timeout-deny"
        );
        assert!(promoted, "queue (perm-e2) promoted after expiry-deny");
    });
}

/// Story 1.7 AC3: disconnect → deny-all. When the last subscriber on a
/// session disconnects, the outstanding permission is resolved as deny.
/// When OTHER clients remain subscribed, the ticket is left outstanding.
#[test]
fn disconnect_denies_only_when_no_subscribers_remain() {
    let rdz = test_rendezvous();
    block_on(async {
        rdz.register(
            "perm-dc".to_string(),
            AgentId("a1".to_string()),
            "sess-dc".to_string(),
            options_value(&["allow"]),
        );
        assert!(rdz.is_outstanding("perm-dc"));
        // Simulate a disconnect where OTHER clients remain subscribed → ticket
        // stays outstanding (a remaining client can still respond).
        rdz.deny_all_for_client(|_sid| 1usize).await; // 1 remaining subscriber
        assert!(
            rdz.is_outstanding("perm-dc"),
            "ticket stays outstanding when other clients remain"
        );
        // Now the last subscriber disconnects → ticket denied + evicted.
        rdz.deny_all_for_client(|_sid| 0usize).await; // 0 remaining subscribers
        assert!(
            !rdz.is_outstanding("perm-dc"),
            "ticket denied on last-subscriber disconnect"
        );
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

/// Story 1.7 deny-race guard: a `deny` for a ticket that a concurrent
/// `try_respond` already claimed (set `resolved_by`) must NOT forward a
/// second resolution to the agent. We simulate the claim by having
/// `try_respond` succeed first (which sets `resolved_by` + evicts), then
/// call `deny` — `deny`'s `remove` returns `None` (evicted) → early return,
/// no double-forward. This is the post-claim-eviction case; the live race
/// window (claim-set, not-yet-evicted) is structurally guarded by the
/// `resolved_by.is_some()` check inside `deny`.
#[test]
fn deny_after_try_respond_eviction_is_a_noop() {
    let rdz = test_rendezvous();
    let client = ClientId::new();
    block_on(async {
        rdz.register(
            "perm-race".to_string(),
            AgentId("a1".to_string()),
            "sess-race".to_string(),
            options_value(&["allow"]),
        );
        // Claim + evict via try_respond.
        let outcome = rdz.try_respond(client, "perm-race", Some("allow")).await;
        assert_eq!(outcome, Ok(RespondOutcome::Resolved));
        assert!(!rdz.is_outstanding("perm-race"));
        // A subsequent deny (e.g. a late timeout) is a no-op — no panic, no
        // double-resolution (the agent-side responder was already resolved).
        rdz.deny("perm-race", &AgentId("a1".to_string()), DenyReason::Timeout)
            .await;
        assert!(!rdz.is_outstanding("perm-race"));
    });
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
        // Exactly one wins; the other is a `stale`-coded rejection
        // (`NotFound` on this runtime, `Duplicate` under a real race).
        let loser = if a.is_ok() { b } else { a };
        let winner = if a.is_ok() { a } else { b };
        assert!(winner.is_ok(), "one response must win: ({a:?}, {b:?})");
        assert!(loser.is_err(), "the other must be rejected");
        assert_eq!(
            loser.unwrap_err().wire_code(),
            "stale",
            "same-client double-respond rejection wires as stale"
        );
    });
}
