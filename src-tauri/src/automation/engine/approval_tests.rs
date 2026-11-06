//! `approval` parks a run like `wait`, and a person or its deadline ends the
//! park, against the local server of `tests.rs`.

use std::sync::Arc;

use serde_json::{json, Value};

use super::control_tests::{parked, post, row, rows};
use super::tests::{
    edge, fixture, http_get, manual, node, output, serve, settled, transform, url, Fixture,
};
use super::OVERLAP_REASON;
use crate::automation::model::{Parked, RunStatus, RunTrigger, StepStatus};
use crate::automation::store::AutomationStore;
use crate::automation::test_support::{node_id, test_engine_on, MemoryVault};

fn approval(message: &str) -> Value {
    json!({ "kind": "approval", "message": message, "timeout_ms": 60_000 })
}

/// fetch -> gate -out-> send, and with `on_error` gate -error-> note.
fn gated_graph(f: &Fixture, on_error: bool) -> Value {
    let mut nodes = vec![
        node("fetch", http_get(&url("/items", &f.http))),
        node("gate", approval("Post {{nodes.fetch.output.body.source}}?")),
        node("send", post(f, "{{nodes.fetch.output.body}}")),
    ];
    let mut edges = vec![
        edge("trigger", "out", "fetch"),
        edge("fetch", "out", "gate"),
        edge("gate", "out", "send"),
    ];
    if on_error {
        nodes.push(node(
            "note",
            transform(json!([{ "name": "decision", "value": "{{nodes.gate.output.decision}}" }])),
        ));
        edges.push(edge("gate", "error", "note"));
    }
    json!({ "nodes": nodes, "edges": edges })
}

fn failed(node: &str, error: &str) -> (String, Option<u32>, StepStatus, Option<String>) {
    (
        node.to_string(),
        None,
        StepStatus::Failed,
        Some(error.to_string()),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn approving_resumes_through_out_without_rerunning_earlier_steps() {
    let f = fixture().await;
    let a = manual(&f.te, gated_graph(&f, true));
    let run = f.te.engine.start_run(&a, RunTrigger::Manual, 1_000).unwrap();

    assert_eq!(
        parked(&f.te, &a, &run.id).await,
        ("gate".to_string(), None, 61_000)
    );
    let waiting = f.te.store.get_run(&run.id).unwrap().unwrap();
    assert_eq!(
        (waiting.status, waiting.parked),
        (
            RunStatus::Running,
            Some(Parked {
                node_id: node_id("gate"),
                iteration: None,
                until: 61_000
            })
        )
    );
    assert_eq!(
        output(&f.te.store, &run.id, "gate"),
        Some(json!({ "message": "Post feed?" }))
    );

    f.te.clock.set(30_000);
    assert!(f.te.engine.decide(&run.id, &node_id("gate"), true).unwrap());
    let run = settled(&f.te.store, &run.id).await;

    assert_eq!(
        (run.status, run.stop_reason.as_deref(), run.parked),
        (RunStatus::Succeeded, None, None)
    );
    assert_eq!(*f.seen.fetches.lock(), 1);
    assert_eq!(f.seen.posts.lock().len(), 1);
    assert_eq!(
        output(&f.te.store, &run.id, "gate"),
        Some(json!({ "message": "Post feed?", "decision": "approved", "decided_at": 30_000 }))
    );
    assert_eq!(
        rows(&f.te.store, &run.id),
        vec![
            row("fetch", None, StepStatus::Succeeded),
            row("gate", None, StepStatus::Succeeded),
            row("send", None, StepStatus::Succeeded),
            row("note", None, StepStatus::Skipped),
        ]
    );
    assert!(!f.te.engine.decide(&run.id, &node_id("gate"), false).unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rejecting_fails_the_approval_and_routes_its_error_edge() {
    let f = fixture().await;
    let a = manual(&f.te, gated_graph(&f, true));
    let run = f.te.engine.start_run(&a, RunTrigger::Manual, 1_000).unwrap();
    parked(&f.te, &a, &run.id).await;

    assert!(f.te.engine.decide(&run.id, &node_id("gate"), false).unwrap());
    let run = settled(&f.te.store, &run.id).await;

    assert_eq!(run.status, RunStatus::Succeeded);
    assert!(f.seen.posts.lock().is_empty());
    assert_eq!(
        rows(&f.te.store, &run.id),
        vec![
            row("fetch", None, StepStatus::Succeeded),
            failed("gate", "rejected"),
            row("send", None, StepStatus::Skipped),
            row("note", None, StepStatus::Succeeded),
        ]
    );
    assert_eq!(
        output(&f.te.store, &run.id, "note"),
        Some(json!({ "decision": "rejected" }))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rejecting_without_an_error_edge_fails_the_run() {
    let f = fixture().await;
    let a = manual(&f.te, gated_graph(&f, false));
    let run = f.te.engine.start_run(&a, RunTrigger::Manual, 1_000).unwrap();
    parked(&f.te, &a, &run.id).await;

    assert!(f.te.engine.decide(&run.id, &node_id("gate"), false).unwrap());
    let run = settled(&f.te.store, &run.id).await;

    assert_eq!(
        (run.status, run.stop_reason.as_deref()),
        (RunStatus::Failed, Some("gate: rejected"))
    );
    assert!(f.seen.posts.lock().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_undecided_approval_times_out_at_its_deadline_through_error() {
    let f = fixture().await;
    let a = manual(&f.te, gated_graph(&f, true));
    let run = f.te.engine.start_run(&a, RunTrigger::Manual, 1_000).unwrap();
    parked(&f.te, &a, &run.id).await;

    f.te.clock.set(61_000);
    assert!(
        !f.te.engine.decide(&run.id, &node_id("gate"), true).unwrap(),
        "a decision at the deadline is too late"
    );
    f.te.engine.resume_due();
    let run = settled(&f.te.store, &run.id).await;

    assert_eq!(run.status, RunStatus::Succeeded);
    assert!(f.seen.posts.lock().is_empty());
    assert_eq!(
        rows(&f.te.store, &run.id)[1],
        failed("gate", "approval_timed_out")
    );
    assert_eq!(
        output(&f.te.store, &run.id, "gate"),
        Some(json!({ "message": "Post feed?", "decision": "timed_out", "decided_at": 61_000 }))
    );
    assert_eq!(
        output(&f.te.store, &run.id, "note"),
        Some(json!({ "decision": "timed_out" }))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_a_waiting_approval_keeps_its_message() {
    let f = fixture().await;
    let a = manual(&f.te, gated_graph(&f, true));
    let run = f.te.engine.start_run(&a, RunTrigger::Manual, 1_000).unwrap();
    parked(&f.te, &a, &run.id).await;

    assert!(f.te.engine.cancel_run(&run.id));

    let cancelled = f.te.store.get_run(&run.id).unwrap().unwrap();
    assert_eq!(
        (cancelled.status, cancelled.parked),
        (RunStatus::Cancelled, None)
    );
    assert_eq!(rows(&f.te.store, &run.id)[1], failed("gate", "cancelled"));
    assert_eq!(
        output(&f.te.store, &run.id, "gate"),
        Some(json!({ "message": "Post feed?" }))
    );
    assert!(!f.te.engine.decide(&run.id, &node_id("gate"), true).unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restarted_host_keeps_the_park_and_a_later_approval_resumes_it() {
    let (http, seen) = serve().await;
    let root = tempfile::tempdir().unwrap();
    let db = root.path().join("automations.sqlite");
    let first = test_engine_on(
        Arc::new(AutomationStore::open(&db).unwrap()),
        root.path().to_path_buf(),
        Arc::new(MemoryVault::default()),
        http.clone(),
    );
    first.secrets.set("p1", "API_KEY", "sk-live-123").unwrap();
    let f = Fixture {
        te: first,
        http,
        seen,
        root,
    };
    let a = manual(&f.te, gated_graph(&f, true));
    let run = f.te.engine.start_run(&a, RunTrigger::Manual, 1_000).unwrap();
    parked(&f.te, &a, &run.id).await;

    let second = test_engine_on(
        Arc::new(AutomationStore::open(&db).unwrap()),
        f.root.path().to_path_buf(),
        Arc::new(MemoryVault::default()),
        f.http.clone(),
    );
    second.clock.set(30_000);
    second.engine.boot();
    let still = second.store.get_run(&run.id).unwrap().unwrap();
    assert_eq!(
        (still.status, still.parked.map(|p| p.until)),
        (RunStatus::Running, Some(61_000))
    );

    assert!(second.engine.decide(&run.id, &node_id("gate"), true).unwrap());
    let run = settled(&second.store, &run.id).await;

    assert_eq!(run.status, RunStatus::Succeeded);
    assert_eq!(*f.seen.fetches.lock(), 1);
    assert_eq!(f.seen.posts.lock().len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_approval_inside_a_loop_body_parks_each_iteration() {
    let f = fixture().await;
    let graph = json!({
        "nodes": [
            node("fetch", http_get(&url("/items", &f.http))),
            node("each", json!({ "kind": "for_each",
                "items": "{{nodes.fetch.output.body.items}}", "max_iterations": 10 })),
            node("gate", approval("Send {{nodes.each.item}}?")),
            node("send", post(&f, "{{nodes.gate.output}}")),
        ],
        "edges": [
            edge("trigger", "out", "fetch"),
            edge("fetch", "out", "each"),
            edge("each", "item", "gate"),
            edge("gate", "out", "send"),
        ]
    });
    let a = manual(&f.te, graph);
    let run = f.te.engine.start_run(&a, RunTrigger::Manual, 1_000).unwrap();

    assert_eq!(
        parked(&f.te, &a, &run.id).await,
        ("gate".to_string(), Some(0), 61_000)
    );
    assert_eq!(
        f.te.store
            .get_run(&run.id)
            .unwrap()
            .unwrap()
            .parked
            .and_then(|p| p.iteration),
        Some(0)
    );
    assert!(f.te.engine.decide(&run.id, &node_id("gate"), true).unwrap());
    assert_eq!(
        parked(&f.te, &a, &run.id).await,
        ("gate".to_string(), Some(1), 61_000)
    );
    assert!(f.te.engine.decide(&run.id, &node_id("gate"), false).unwrap());
    let run = settled(&f.te.store, &run.id).await;

    assert_eq!(
        (run.status, run.stop_reason.as_deref()),
        (RunStatus::Failed, Some("each: iteration 1: gate: rejected"))
    );
    assert_eq!(
        *f.seen.posts.lock(),
        vec![(
            format!("{}:send:0", run.id),
            json!({ "message": "Send a?", "decision": "approved", "decided_at": 1_000 })
        )]
    );
    let steps = f.te.store.get_steps(&run.id).unwrap();
    let messages: Vec<(Option<u32>, Value)> = steps
        .iter()
        .filter(|s| s.node_id.as_str() == "gate")
        .map(|s| (s.iteration, s.output.clone().unwrap()["message"].clone()))
        .collect();
    assert_eq!(
        messages,
        vec![(Some(0), json!("Send a?")), (Some(1), json!("Send b?"))]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_run_while_an_approval_waits_is_skipped() {
    let f = fixture().await;
    let a = manual(&f.te, gated_graph(&f, true));
    let run = f.te.engine.start_run(&a, RunTrigger::Manual, 1_000).unwrap();
    parked(&f.te, &a, &run.id).await;

    let second = f.te.engine.start_run(&a, RunTrigger::Manual, 2_000).unwrap();

    assert_eq!(
        (second.status, second.stop_reason.as_deref()),
        (RunStatus::Skipped, Some(OVERLAP_REASON))
    );
    assert!(f.te.engine.decide(&run.id, &node_id("gate"), true).unwrap());
    assert_eq!(
        settled(&f.te.store, &run.id).await.status,
        RunStatus::Succeeded
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_step_result_the_store_refuses_stops_the_run_before_the_approval_parks() {
    let f = fixture().await;
    let a = manual(&f.te, gated_graph(&f, true));
    f.te.store.fail_step_writes("fetch", "succeeded");

    let run = f.te.engine.start_run(&a, RunTrigger::Manual, 1_000).unwrap();
    let run = settled(&f.te.store, &run.id).await;

    assert_eq!((run.status, run.parked), (RunStatus::Failed, None));
    assert!(
        run.stop_reason
            .as_deref()
            .is_some_and(|r| r.starts_with("fetch: step_not_recorded: ")),
        "{:?}",
        run.stop_reason
    );
    assert_eq!(output(&f.te.store, &run.id, "gate"), None);
    assert!(!f.te.engine.decide(&run.id, &node_id("gate"), true).unwrap());
    assert!(f.seen.posts.lock().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_approval_the_store_cannot_park_fails_with_a_park_code() {
    let f = fixture().await;
    let a = manual(&f.te, gated_graph(&f, false));
    f.te.store.fail_step_writes("gate", "waiting");

    let run = f.te.engine.start_run(&a, RunTrigger::Manual, 1_000).unwrap();
    let run = settled(&f.te.store, &run.id).await;

    assert_eq!((run.status, run.parked), (RunStatus::Failed, None));
    assert!(
        run.stop_reason
            .as_deref()
            .is_some_and(|r| r.starts_with("gate: park_not_recorded: ")),
        "{:?}",
        run.stop_reason
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn approving_a_run_of_a_deleted_automation_cancels_it_instead() {
    let f = fixture().await;
    let a = manual(&f.te, gated_graph(&f, true));
    let run = f.te.engine.start_run(&a, RunTrigger::Manual, 1_000).unwrap();
    parked(&f.te, &a, &run.id).await;
    // Deleted without the engine's cancel, as when that cancel fails.
    assert!(f.te.store.soft_delete(&a.id, 2_000).unwrap());

    assert!(!f.te.engine.decide(&run.id, &node_id("gate"), true).unwrap());
    let run = settled(&f.te.store, &run.id).await;

    assert_eq!(run.status, RunStatus::Cancelled);
    assert!(f.seen.posts.lock().is_empty());
    assert_eq!(
        rows(&f.te.store, &run.id),
        vec![
            row("fetch", None, StepStatus::Succeeded),
            failed("gate", "cancelled"),
        ]
    );
}
