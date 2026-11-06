//! `for_each`, `merge` and `wait` against the local server of `tests.rs`.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use super::tests::{
    edge, fixture, http_get, manual, node, output, run_to_end, serve, settled, transform, url,
    Fixture,
};
use super::OVERLAP_REASON;
use crate::automation::model::{Automation, RunId, RunStatus, RunTrigger, StepStatus};
use crate::automation::store::AutomationStore;
use crate::automation::test_support::{test_engine_on, MemoryVault, TestEngine};

/// Every step row as `(node, iteration, status, error)`, in write order.
pub(super) fn rows(
    store: &AutomationStore,
    id: &RunId,
) -> Vec<(String, Option<u32>, StepStatus, Option<String>)> {
    store
        .get_steps(id)
        .unwrap()
        .into_iter()
        .map(|s| (s.node_id.to_string(), s.iteration, s.status, s.error))
        .collect()
}

pub(super) fn row(
    node: &str,
    iteration: Option<u32>,
    status: StepStatus,
) -> (String, Option<u32>, StepStatus, Option<String>) {
    (node.to_string(), iteration, status, None)
}

pub(super) fn post(f: &Fixture, body: &str) -> Value {
    json!({ "kind": "http", "method": "POST", "url": url("/collect", &f.http),
            "body": body, "allowed_hosts": ["api.test"] })
}

fn for_each(items: &str, max_iterations: u32) -> Value {
    json!({ "kind": "for_each", "items": items, "max_iterations": max_iterations })
}

fn wait(duration_ms: u64) -> Value {
    json!({ "kind": "wait", "duration_ms": duration_ms })
}

const ITEMS: &str = "{{nodes.fetch.output.body.items}}";

fn shape() -> Value {
    transform(json!([
        { "name": "item", "value": "{{nodes.each.item}}" },
        { "name": "index", "value": "{{nodes.each.index}}" }
    ]))
}

/// fetch (["a", "b"]) -> each -item-> shape -> [pause ->] send; each -out-> done.
fn loop_graph(f: &Fixture, max_iterations: u32, pause_ms: Option<u64>) -> Value {
    let mut nodes = vec![
        node("fetch", http_get(&url("/items", &f.http))),
        node("each", for_each(ITEMS, max_iterations)),
        node("shape", shape()),
        node("send", post(f, "{{nodes.shape.output}}")),
        node(
            "done",
            transform(json!([{ "name": "all", "value": "{{nodes.each.output}}" }])),
        ),
    ];
    let mut edges = vec![
        edge("trigger", "out", "fetch"),
        edge("fetch", "out", "each"),
        edge("each", "item", "shape"),
        edge("each", "out", "done"),
    ];
    match pause_ms {
        Some(ms) => {
            nodes.push(node("pause", wait(ms)));
            edges.push(edge("shape", "out", "pause"));
            edges.push(edge("pause", "out", "send"));
        }
        None => edges.push(edge("shape", "out", "send")),
    }
    json!({ "nodes": nodes, "edges": edges })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn for_each_runs_its_body_once_per_item_and_collects_the_outputs() {
    let f = fixture().await;
    let a = manual(&f.te, loop_graph(&f, 10, None));

    let run = run_to_end(&f.te, &a).await;

    assert_eq!(
        (run.status, run.stop_reason.as_deref()),
        (RunStatus::Succeeded, None)
    );
    assert_eq!(
        *f.seen.posts.lock(),
        vec![
            (
                format!("{}:send:0", run.id),
                json!({ "item": "a", "index": 0 })
            ),
            (
                format!("{}:send:1", run.id),
                json!({ "item": "b", "index": 1 })
            ),
        ]
    );
    assert_eq!(
        rows(&f.te.store, &run.id),
        vec![
            row("fetch", None, StepStatus::Succeeded),
            row("each", None, StepStatus::Succeeded),
            row("shape", Some(0), StepStatus::Succeeded),
            row("send", Some(0), StepStatus::Succeeded),
            row("shape", Some(1), StepStatus::Succeeded),
            row("send", Some(1), StepStatus::Succeeded),
            row("done", None, StepStatus::Succeeded),
        ]
    );
    let each = output(&f.te.store, &run.id, "each").unwrap();
    let shapes: Vec<&Value> = each.as_array().unwrap().iter().map(|i| &i["shape"]).collect();
    assert_eq!(
        shapes,
        vec![
            &json!({ "item": "a", "index": 0 }),
            &json!({ "item": "b", "index": 1 })
        ]
    );
    assert_eq!(each[1]["send"]["status"], json!(201));
    assert_eq!(
        output(&f.te.store, &run.id, "done").unwrap()["all"],
        each
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn more_items_than_max_iterations_fails_without_running_the_body() {
    let f = fixture().await;
    let a = manual(&f.te, loop_graph(&f, 1, None));

    let run = run_to_end(&f.te, &a).await;

    assert_eq!(
        (run.status, run.stop_reason.as_deref()),
        (
            RunStatus::Failed,
            Some("each: for_each_too_many_items: 2 items, max_iterations is 1")
        )
    );
    assert_eq!(
        rows(&f.te.store, &run.id),
        vec![
            row("fetch", None, StepStatus::Succeeded),
            (
                "each".to_string(),
                None,
                StepStatus::Failed,
                Some("for_each_too_many_items: 2 items, max_iterations is 1".to_string())
            ),
            row("shape", None, StepStatus::Skipped),
            row("send", None, StepStatus::Skipped),
            row("done", None, StepStatus::Skipped),
        ]
    );
    assert!(f.seen.posts.lock().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn items_that_are_not_an_array_fail_the_loop() {
    let f = fixture().await;
    let a = manual(
        &f.te,
        json!({
            "nodes": [
                node("fetch", http_get(&url("/items", &f.http))),
                node("each", for_each("{{nodes.fetch.output.body.source}}", 10)),
                node("shape", shape())
            ],
            "edges": [edge("trigger", "out", "fetch"), edge("fetch", "out", "each"),
                      edge("each", "item", "shape")]
        }),
    );

    let run = run_to_end(&f.te, &a).await;

    assert_eq!(
        (run.status, run.stop_reason.as_deref()),
        (
            RunStatus::Failed,
            Some("each: for_each_not_array: items rendered to a string")
        )
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_body_failure_fails_the_loop_through_its_error_port() {
    let f = fixture().await;
    let a = manual(
        &f.te,
        json!({
            "nodes": [
                node("fetch", http_get(&url("/items", &f.http))),
                node("each", for_each(ITEMS, 10)),
                node("bad", http_get(&url("/fail", &f.http))),
                node("after", transform(json!([]))),
                node("handled", transform(json!([])))
            ],
            "edges": [edge("trigger", "out", "fetch"), edge("fetch", "out", "each"),
                      edge("each", "item", "bad"), edge("bad", "out", "after"),
                      edge("each", "error", "handled")]
        }),
    );

    let run = run_to_end(&f.te, &a).await;

    assert_eq!(run.status, RunStatus::Succeeded);
    assert_eq!(
        rows(&f.te.store, &run.id),
        vec![
            row("fetch", None, StepStatus::Succeeded),
            (
                "each".to_string(),
                None,
                StepStatus::Failed,
                Some("iteration 0: bad: http_status:500".to_string())
            ),
            (
                "bad".to_string(),
                Some(0),
                StepStatus::Failed,
                Some("http_status:500".to_string())
            ),
            row("after", Some(0), StepStatus::Skipped),
            row("handled", None, StepStatus::Succeeded),
        ]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn merge_any_after_a_condition_carries_the_branch_that_ran() {
    let f = fixture().await;
    for (n, ran) in [("5", "big"), ("1", "small")] {
        let a = manual(
            &f.te,
            json!({
                "nodes": [
                    node("src", transform(json!([{ "name": "n", "value": n }]))),
                    node("check", json!({ "kind": "condition", "left": "{{nodes.src.output.n}}", "op": "gt", "right": "3" })),
                    node("big", transform(json!([{ "name": "size", "value": "big" }]))),
                    node("small", transform(json!([{ "name": "size", "value": "small" }]))),
                    node("join", json!({ "kind": "merge", "mode": "any" })),
                    node("after", transform(json!([{ "name": "size", "value": "{{nodes.join.output.value.size}}" }])))
                ],
                "edges": [edge("trigger", "out", "src"), edge("src", "out", "check"),
                          edge("check", "true", "big"), edge("check", "false", "small"),
                          edge("big", "out", "join"), edge("small", "out", "join"),
                          edge("join", "out", "after")]
            }),
        );

        let run = run_to_end(&f.te, &a).await;

        assert_eq!(run.status, RunStatus::Succeeded, "n={n}");
        assert_eq!(
            output(&f.te.store, &run.id, "join"),
            Some(json!({ "from": ran, "value": { "size": ran }, "inputs": { ran: { "size": ran } } })),
            "n={n}"
        );
        assert_eq!(
            output(&f.te.store, &run.id, "after"),
            Some(json!({ "size": ran }))
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn merge_all_runs_only_when_every_branch_fired() {
    let f = fixture().await;
    for (n, joined) in [("5", true), ("1", false)] {
        let a = manual(
            &f.te,
            json!({
                "nodes": [
                    node("src", transform(json!([{ "name": "n", "value": n }]))),
                    node("left", transform(json!([{ "name": "side", "value": "left" }]))),
                    node("check", json!({ "kind": "condition", "left": "{{nodes.src.output.n}}", "op": "gt", "right": "3" })),
                    node("right", transform(json!([{ "name": "side", "value": "right" }]))),
                    node("join", json!({ "kind": "merge", "mode": "all" })),
                    node("after", transform(json!([])))
                ],
                "edges": [edge("trigger", "out", "src"), edge("src", "out", "left"),
                          edge("src", "out", "check"), edge("check", "true", "right"),
                          edge("left", "out", "join"), edge("right", "out", "join"),
                          edge("join", "out", "after")]
            }),
        );

        let run = run_to_end(&f.te, &a).await;

        assert_eq!(run.status, RunStatus::Succeeded, "n={n}");
        let statuses: Vec<(String, StepStatus)> = rows(&f.te.store, &run.id)
            .into_iter()
            .filter(|r| r.0 == "join" || r.0 == "after")
            .map(|r| (r.0, r.2))
            .collect();
        let expected = if joined {
            StepStatus::Succeeded
        } else {
            StepStatus::Skipped
        };
        assert_eq!(
            statuses,
            vec![("join".to_string(), expected), ("after".to_string(), expected)],
            "n={n}"
        );
        if joined {
            assert_eq!(
                output(&f.te.store, &run.id, "join"),
                Some(json!({ "from": "left", "value": { "side": "left" },
                             "inputs": { "left": { "side": "left" }, "right": { "side": "right" } } }))
            );
        }
    }
}

/// fetch -> pause (60 s) -> send.
fn paused_graph(f: &Fixture) -> Value {
    json!({
        "nodes": [
            node("fetch", http_get(&url("/items", &f.http))),
            node("pause", wait(60_000)),
            node("send", post(f, "{{nodes.fetch.output.body}}"))
        ],
        "edges": [edge("trigger", "out", "fetch"), edge("fetch", "out", "pause"),
                  edge("pause", "out", "send")]
    })
}

/// Waits until the run has a `waiting` step and its task has let go of it.
pub(super) async fn parked(
    te: &TestEngine,
    a: &Automation,
    id: &RunId,
) -> (String, Option<u32>, i64) {
    for _ in 0..1500 {
        let waiting = te
            .store
            .get_steps(id)
            .unwrap()
            .into_iter()
            .find(|s| s.status == StepStatus::Waiting);
        if let Some(step) = waiting {
            if !te.engine.active.lock().contains_key(&a.id) {
                return (
                    step.node_id.to_string(),
                    step.iteration,
                    step.wait_until.unwrap(),
                );
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("run {id} never parked");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_wait_parks_the_run_and_resumes_without_rerunning_earlier_steps() {
    let f = fixture().await;
    let a = manual(&f.te, paused_graph(&f));
    let run = f.te.engine.start_run(&a, RunTrigger::Manual, 1_000).unwrap();

    assert_eq!(
        parked(&f.te, &a, &run.id).await,
        ("pause".to_string(), None, 61_000)
    );
    assert_eq!(
        f.te.store.get_run(&run.id).unwrap().unwrap().status,
        RunStatus::Running
    );
    f.te.engine.resume_due();
    assert_eq!(
        rows(&f.te.store, &run.id),
        vec![
            row("fetch", None, StepStatus::Succeeded),
            row("pause", None, StepStatus::Waiting),
        ]
    );

    f.te.clock.set(61_000);
    f.te.engine.resume_due();
    let run = settled(&f.te.store, &run.id).await;

    assert_eq!(
        (run.status, run.stop_reason.as_deref()),
        (RunStatus::Succeeded, None)
    );
    assert_eq!(*f.seen.fetches.lock(), 1);
    assert_eq!(
        *f.seen.posts.lock(),
        vec![(
            format!("{}:send", run.id),
            json!({ "source": "feed", "items": ["a", "b"] })
        )]
    );
    assert_eq!(
        output(&f.te.store, &run.id, "pause"),
        Some(json!({ "resumed_at": 61_000 }))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_wait_inside_a_loop_body_resumes_mid_loop() {
    let f = fixture().await;
    let a = manual(&f.te, loop_graph(&f, 10, Some(1_000)));
    let run = f.te.engine.start_run(&a, RunTrigger::Manual, 1_000).unwrap();

    assert_eq!(
        parked(&f.te, &a, &run.id).await,
        ("pause".to_string(), Some(0), 2_000)
    );
    f.te.clock.set(2_000);
    f.te.engine.resume_due();
    assert_eq!(
        parked(&f.te, &a, &run.id).await,
        ("pause".to_string(), Some(1), 3_000)
    );
    assert_eq!(f.seen.posts.lock().len(), 1);
    f.te.clock.set(3_000);
    f.te.engine.resume_due();
    let run = settled(&f.te.store, &run.id).await;

    assert_eq!(run.status, RunStatus::Succeeded);
    assert_eq!(*f.seen.fetches.lock(), 1);
    assert_eq!(
        *f.seen.posts.lock(),
        vec![
            (
                format!("{}:send:0", run.id),
                json!({ "item": "a", "index": 0 })
            ),
            (
                format!("{}:send:1", run.id),
                json!({ "item": "b", "index": 1 })
            ),
        ]
    );
    assert_eq!(
        rows(&f.te.store, &run.id),
        vec![
            row("fetch", None, StepStatus::Succeeded),
            row("each", None, StepStatus::Succeeded),
            row("shape", Some(0), StepStatus::Succeeded),
            row("pause", Some(0), StepStatus::Succeeded),
            row("send", Some(0), StepStatus::Succeeded),
            row("shape", Some(1), StepStatus::Succeeded),
            row("pause", Some(1), StepStatus::Succeeded),
            row("send", Some(1), StepStatus::Succeeded),
            row("done", None, StepStatus::Succeeded),
        ]
    );
    let each = output(&f.te.store, &run.id, "each").unwrap();
    assert_eq!(
        each.as_array()
            .unwrap()
            .iter()
            .map(|i| (i["shape"].clone(), i["pause"].clone()))
            .collect::<Vec<_>>(),
        vec![
            (json!({ "item": "a", "index": 0 }), json!({ "resumed_at": 2_000 })),
            (json!({ "item": "b", "index": 1 }), json!({ "resumed_at": 3_000 })),
        ]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_parked_run_survives_a_restart_and_resumes_at_boot() {
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
    let a = manual(&f.te, paused_graph(&f));
    let run = f.te.engine.start_run(&a, RunTrigger::Manual, 1_000).unwrap();
    parked(&f.te, &a, &run.id).await;

    let second = test_engine_on(
        Arc::new(AutomationStore::open(&db).unwrap()),
        f.root.path().to_path_buf(),
        Arc::new(MemoryVault::default()),
        f.http.clone(),
    );
    second.clock.set(61_000);
    second.engine.boot();
    let run = settled(&second.store, &run.id).await;

    assert_eq!(
        (run.status, run.stop_reason.as_deref()),
        (RunStatus::Succeeded, None)
    );
    assert_eq!(*f.seen.fetches.lock(), 1);
    assert_eq!(f.seen.posts.lock().len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn boot_before_the_wait_is_due_keeps_the_run_parked() {
    let f = fixture().await;
    let a = manual(&f.te, paused_graph(&f));
    let run = f.te.engine.start_run(&a, RunTrigger::Manual, 1_000).unwrap();
    parked(&f.te, &a, &run.id).await;

    f.te.engine.boot();

    assert_eq!(
        f.te.store.get_run(&run.id).unwrap().unwrap().status,
        RunStatus::Running
    );
    assert_eq!(
        rows(&f.te.store, &run.id)[1],
        row("pause", None, StepStatus::Waiting)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_a_parked_run_settles_it_cancelled() {
    let f = fixture().await;
    let a = manual(&f.te, paused_graph(&f));
    let run = f.te.engine.start_run(&a, RunTrigger::Manual, 1_000).unwrap();
    parked(&f.te, &a, &run.id).await;

    assert!(f.te.engine.cancel_run(&run.id));

    let settled = f.te.store.get_run(&run.id).unwrap().unwrap();
    assert_eq!(
        (settled.status, settled.stop_reason.as_deref()),
        (RunStatus::Cancelled, Some("cancelled"))
    );
    assert_eq!(
        rows(&f.te.store, &run.id)[1],
        (
            "pause".to_string(),
            None,
            StepStatus::Failed,
            Some("cancelled".to_string())
        )
    );
    f.te.clock.set(61_000);
    f.te.engine.resume_due();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(f.seen.posts.lock().is_empty());
    assert!(!f.te.engine.cancel_run(&run.id));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_a_run_parked_inside_a_loop_fails_the_loop_too() {
    let f = fixture().await;
    let a = manual(&f.te, loop_graph(&f, 10, Some(1_000)));
    let run = f.te.engine.start_run(&a, RunTrigger::Manual, 1_000).unwrap();
    parked(&f.te, &a, &run.id).await;

    assert!(f.te.engine.cancel_run(&run.id));

    let cancelled = |node: &str, iteration| {
        (
            node.to_string(),
            iteration,
            StepStatus::Failed,
            Some("cancelled".to_string()),
        )
    };
    assert_eq!(
        rows(&f.te.store, &run.id),
        vec![
            row("fetch", None, StepStatus::Succeeded),
            cancelled("each", None),
            row("shape", Some(0), StepStatus::Succeeded),
            cancelled("pause", Some(0)),
        ]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deleting_the_automation_cancels_its_parked_run() {
    let f = fixture().await;
    let a = manual(&f.te, paused_graph(&f));
    let run = f.te.engine.start_run(&a, RunTrigger::Manual, 1_000).unwrap();
    parked(&f.te, &a, &run.id).await;

    f.te.store.soft_delete(&a.id, 2_000).unwrap();
    f.te.engine.cancel_automation(&a.id);

    assert_eq!(
        f.te.store.get_run(&run.id).unwrap().unwrap().status,
        RunStatus::Cancelled
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_run_while_one_is_parked_is_skipped() {
    let f = fixture().await;
    let a = manual(&f.te, paused_graph(&f));
    let run = f.te.engine.start_run(&a, RunTrigger::Manual, 1_000).unwrap();
    parked(&f.te, &a, &run.id).await;

    let second = f.te.engine.start_run(&a, RunTrigger::Manual, 2_000).unwrap();

    assert_eq!(
        (second.status, second.stop_reason.as_deref()),
        (RunStatus::Skipped, Some(OVERLAP_REASON))
    );
}
