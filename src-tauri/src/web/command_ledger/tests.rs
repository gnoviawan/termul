//! Ledger core behavior: record-before-execute, replay, conflict, eviction
//! tiers, bounds and the no-secrets-stored rule.

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use super::test_clock::ManualClock;
use super::*;

const RETENTION: Duration = Duration::from_secs(600);

fn ledger() -> (Arc<CommandLedger>, Arc<ManualClock>) {
    let clock = Arc::new(ManualClock::default());
    let ledger = Arc::new(CommandLedger::with_clock(RETENTION, clock.clone()));
    (ledger, clock)
}

fn class() -> CommandClass {
    class_of("close_session").unwrap().1
}

fn fp(tag: &str) -> Fingerprint {
    Fingerprint::of("close_session", &json!({ "sessionId": tag }))
}

fn accepted(payload: serde_json::Value) -> Settled {
    Settled::Accepted {
        payload: Some(payload),
        visible_at: Some(7),
    }
}

fn fresh(ledger: &Arc<CommandLedger>, id: &str, print: Fingerprint) -> CommandGuard {
    match ledger.begin(id, print) {
        Begin::Fresh(guard) => guard,
        _ => panic!("expected a first sight for {id}"),
    }
}

#[test]
fn a_resend_of_a_settled_command_gets_the_original_outcome() {
    let (ledger, _) = ledger();
    fresh(&ledger, "c1", fp("s")).complete(&accepted(json!({"ok": 1})), class());

    match ledger.begin("c1", fp("s")) {
        Begin::Settled(settled) => assert_eq!(settled, accepted(json!({"ok": 1}))),
        _ => panic!("a settled command must replay"),
    }
}

#[test]
fn a_rejection_replays_with_its_original_code() {
    let (ledger, _) = ledger();
    let rejected = Settled::Rejected {
        code: "destructive_op_blocked".to_string(),
        message: "a turn is active".to_string(),
    };
    fresh(&ledger, "c1", fp("s")).complete(&rejected, class());

    match ledger.begin("c1", fp("s")) {
        Begin::Settled(settled) => assert_eq!(settled, rejected),
        _ => panic!("a rejection must replay, not re-execute"),
    }
}

#[test]
fn the_same_id_with_a_different_request_is_a_conflict() {
    let (ledger, _) = ledger();
    fresh(&ledger, "c1", fp("one")).complete(&accepted(json!({})), class());

    assert!(matches!(ledger.begin("c1", fp("two")), Begin::Conflict));
}

#[test]
fn a_command_in_flight_is_recorded_and_waiters_wake_on_settle() {
    let (ledger, _) = ledger();
    let guard = fresh(&ledger, "c1", fp("s"));

    let Begin::InFlight(waiter) = ledger.begin("c1", fp("s")) else {
        panic!("a second sight while running must be in flight");
    };
    assert_eq!(ledger.counts(), (1, 0, 0));
    guard.complete(&accepted(json!({})), class());

    assert!(waiter.has_changed().is_err(), "the waiter must be woken");
    assert!(matches!(ledger.begin("c1", fp("s")), Begin::Settled(_)));
}

#[test]
fn a_guard_dropped_without_an_outcome_records_unknown_and_never_re_executes() {
    let (ledger, _) = ledger();
    let guard = fresh(&ledger, "c1", fp("s"));
    let Begin::InFlight(waiter) = ledger.begin("c1", fp("s")) else {
        panic!("expected in flight");
    };

    drop(guard);

    assert!(waiter.has_changed().is_err(), "dropping must wake waiters");
    assert!(matches!(ledger.begin("c1", fp("s")), Begin::Unknown));
    assert!(matches!(ledger.begin("c1", fp("s")), Begin::Unknown));
}

#[test]
fn outcomes_age_into_bare_ids_then_are_forgotten() {
    let (ledger, clock) = ledger();
    fresh(&ledger, "c1", fp("s")).complete(&accepted(json!({})), class());

    clock.advance(RETENTION - Duration::from_secs(1));
    assert!(matches!(ledger.begin("c1", fp("s")), Begin::Settled(_)));

    clock.advance(Duration::from_secs(2));
    assert!(
        matches!(ledger.begin("c1", fp("s")), Begin::Unknown),
        "an evicted outcome keeps the bare id: unknown, not re-executed"
    );
    assert!(
        matches!(ledger.begin("c1", fp("other")), Begin::Conflict),
        "the bare id still remembers what it was"
    );
    assert_eq!(ledger.counts(), (0, 0, 1));

    clock.advance(RETENTION * (BARE_HORIZON_FACTOR - 1));
    assert!(
        matches!(ledger.begin("c1", fp("s")), Begin::Fresh(_)),
        "past the bare-id horizon the id is forgotten"
    );
}

#[test]
fn capacity_downgrades_the_oldest_outcomes_and_forgets_the_oldest_bare_ids() {
    let clock = Arc::new(ManualClock::default());
    let ledger = Arc::new(CommandLedger::with_clock(RETENTION, clock.clone()).with_limits(2, 2));
    for id in ["a", "b", "c", "d", "e"] {
        fresh(&ledger, id, fp(id)).complete(&accepted(json!({})), class());
        clock.advance(Duration::from_millis(1));
    }

    assert_eq!(ledger.counts(), (0, 2, 2), "bounded at 2 outcomes + 2 bare");
    assert!(matches!(ledger.begin("e", fp("e")), Begin::Settled(_)));
    assert!(matches!(ledger.begin("c", fp("c")), Begin::Unknown));
    assert!(
        matches!(ledger.begin("a", fp("a")), Begin::Fresh(_)),
        "the oldest bare id fell off"
    );
}

#[test]
fn a_receipt_only_class_stores_no_payload_and_a_large_payload_is_dropped() {
    let (ledger, _) = ledger();
    let receipt_only = class_of("authenticate_agent").unwrap().1;
    let secret = json!({"authUrl": "https://login.example/?code=SECRET"});

    fresh(&ledger, "c1", fp("s")).complete(&accepted(secret), receipt_only);
    match ledger.begin("c1", fp("s")) {
        Begin::Settled(Settled::Accepted { payload, visible_at }) => {
            assert_eq!(payload, None, "a receipt-only kind stores no payload");
            assert_eq!(visible_at, Some(7));
        }
        _ => panic!("expected the stored receipt"),
    }

    let large = json!({"blob": "x".repeat(MAX_STORED_PAYLOAD_BYTES + 1)});
    fresh(&ledger, "c2", fp("t")).complete(&accepted(large), class());
    match ledger.begin("c2", fp("t")) {
        Begin::Settled(Settled::Accepted { payload, .. }) => assert_eq!(payload, None),
        _ => panic!("expected the stored receipt"),
    }
}

#[test]
fn a_stored_rejection_message_is_bounded() {
    let (ledger, _) = ledger();
    let rejected = Settled::Rejected {
        code: "unsupported".to_string(),
        message: "m".repeat(5_000),
    };
    fresh(&ledger, "c1", fp("s")).complete(&rejected, class());

    match ledger.begin("c1", fp("s")) {
        Begin::Settled(Settled::Rejected { message, .. }) => assert_eq!(message.len(), 512),
        _ => panic!("expected the stored rejection"),
    }
}

#[test]
fn command_ids_are_one_to_128_chars_of_the_safe_alphabet() {
    assert!(is_valid_command_id("3f2b9c0e-1d4a-4b7e-9a10-aabbccddeeff"));
    assert!(is_valid_command_id("a_B-9"));
    assert!(is_valid_command_id(&"a".repeat(128)));
    assert!(!is_valid_command_id(""));
    assert!(!is_valid_command_id(&"a".repeat(129)));
    assert!(!is_valid_command_id("has space"));
    assert!(!is_valid_command_id("new\nline"));
    assert!(!is_valid_command_id("dot.dot"));
}

#[test]
fn a_receipt_only_rejection_keeps_its_code_and_drops_the_error_text() {
    let (ledger, _) = ledger();
    let receipt_only = class_of("authenticate_agent").unwrap().1;
    let rejected = Settled::Rejected {
        code: "agent_auth_required".to_string(),
        message: "login failed for https://x/?code=SECRET".to_string(),
    };
    fresh(&ledger, "c1", fp("s")).complete(&rejected, receipt_only);

    match ledger.begin("c1", fp("s")) {
        Begin::Settled(Settled::Rejected { code, message }) => {
            assert_eq!(code, "agent_auth_required");
            assert_eq!(message, RECEIPT_ONLY_REJECTION_MESSAGE);
        }
        _ => panic!("expected the stored rejection"),
    }
}

#[test]
fn a_huge_retention_is_clamped_and_keeps_capacity_downgraded_bare_ids() {
    let clock = Arc::new(ManualClock::default());
    let ledger = Arc::new(
        CommandLedger::with_clock(Duration::from_secs(u64::MAX), clock.clone()).with_limits(1, 8),
    );
    assert_eq!(
        ledger.retention(),
        Duration::from_secs(crate::web::config::MAX_RECEIPT_RETENTION_SECS)
    );

    fresh(&ledger, "c1", fp("a")).complete(&accepted(json!({})), class());
    fresh(&ledger, "c2", fp("b")).complete(&accepted(json!({})), class());
    clock.advance(Duration::from_secs(3600));

    assert!(matches!(ledger.begin("c2", fp("b")), Begin::Settled(_)));
    assert!(
        matches!(ledger.begin("c1", fp("a")), Begin::Unknown),
        "the capacity-downgraded id is still a bare id, not forgotten"
    );
}
