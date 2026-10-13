#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;
use serde_json::json;

/// Drive an async block on a single-threaded tokio runtime.
fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(future)
}

/// A question rendezvous bound to a no-op `AcpManager` (issue #411).
fn test_question_rendezvous() -> Arc<QuestionRendezvous> {
    Arc::new(QuestionRendezvous::new(Arc::new(AcpManager::new(vec![]))))
}

/// Build `options` JSON matching the `AskUserQuestionEvent` wire shape
/// (issue #411) — single-select options (no `cardinality` → single).
fn question_options_value(values: &[&str]) -> Value {
    json!(values
        .iter()
        .map(|v| json!({ "value": v, "label": v }))
        .collect::<Vec<_>>())
}

/// Issue #411: first-response-wins for questions — the second answer is
/// rejected `already_resolved` (the resolved ticket is tombstoned).
#[test]
fn question_first_response_wins_second_is_rejected_already_resolved() {
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
        assert_eq!(second, Err(QuestionRespondError::AlreadyResolved));
        assert_eq!(second.unwrap_err().wire_code(), "already_resolved");
        let unknown = rdz.try_respond(client, "q-never", None).await;
        assert_eq!(unknown, Err(QuestionRespondError::NotFound));
        assert_eq!(QuestionRespondError::NotFound.wire_code(), "stale");
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
        assert_eq!(stale, Err(QuestionRespondError::AlreadyResolved));
    });
}

/// Issue #411: same-client double-respond — exactly one wins; the loser is
/// `already_resolved`-coded.
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
        assert_eq!(loser.unwrap_err().wire_code(), "already_resolved");
    });
}

/// The agent reports no outstanding responder: THIS answer is `stale`, but the
/// ticket is remembered so any later answer reads `already_resolved`.
#[test]
fn agent_reported_unknown_question_leaves_a_tombstone() {
    block_on(async {
        let acp = Arc::new(AcpManager::new(vec![]));
        acp.install_test_agent_without_responders(AgentId("a1".to_string()));

        let questions = Arc::new(QuestionRendezvous::new(Arc::clone(&acp)));
        questions.register(
            "q-gone".to_string(),
            AgentId("a1".to_string()),
            "sess-1".to_string(),
            question_options_value(&["plan-a"]),
        );
        let answer = vec!["plan-a".to_string()];
        assert_eq!(
            questions.try_respond(ClientId::new(), "q-gone", Some(&answer)).await,
            Err(QuestionRespondError::NotFound)
        );
        assert_eq!(
            questions.try_respond(ClientId::new(), "q-gone", Some(&answer)).await,
            Err(QuestionRespondError::AlreadyResolved)
        );
    });
}
