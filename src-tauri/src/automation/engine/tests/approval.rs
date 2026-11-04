//! Approval nodes: a run parks durably at the node, and a decision, a
//! cancel or the deadline resumes it without re-running earlier nodes.

use super::*;
use crate::automation::engine::{Decision, Engine};
use crate::automation::model::{NodeId, Parked};

const HOUR_MS: i64 = 3_600_000;

fn gate_id() -> NodeId {
    NodeId::parse("gate").unwrap()
}

/// trigger -> src -> post (a real POST) -> gate -> done, and gate's error
/// edge to `handled` when `error_edge`.
fn gated(f: &Fixture, error_edge: bool) -> Automation {
    let mut edges = vec![
        edge("trigger", "out", "src"),
        edge("src", "out", "post"),
        edge("post", "out", "gate"),
        edge("gate", "out", "done"),
    ];
    let mut nodes = vec![
        node("src", transform(json!([{ "name": "n", "value": "5" }]))),
        node(
            "post",
            json!({ "kind": "http", "method": "POST", "url": url("/collect", &f.http),
            "body": "{{nodes.src.output}}", "allowed_hosts": ["api.test"] }),
        ),
        node(
            "gate",
            json!({ "kind": "approval", "message": "Ship {{nodes.src.output.n}}?",
            "timeout_ms": HOUR_MS }),
        ),
        node("done", transform(json!([]))),
    ];
    if error_edge {
        nodes.push(node("handled", transform(json!([]))));
        edges.push(edge("gate", "error", "handled"));
    }
    manual(&f.te, json!({ "nodes": nodes, "edges": edges }))
}

async fn until_waiting(store: &AutomationStore, id: &RunId) -> Run {
    for _ in 0..1500 {
        let run = store.get_run(id).unwrap().unwrap();
        if run.status == RunStatus::Waiting {
            return run;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("run {id} never parked");
}

async fn parked_run(f: &Fixture, a: &Automation) -> Run {
    let run = f.te.engine.start_run(a, RunTrigger::Manual, 1_000).unwrap();
    until_waiting(&f.te.store, &run.id).await
}

/// The settled run once `engine` resolved its park with `decision` at
/// `at_ms`.
async fn decide(
    f: &Fixture,
    engine: &Arc<Engine>,
    run: &Run,
    decision: Decision,
    at_ms: i64,
) -> Run {
    f.te.clock.set(at_ms);
    assert!(engine.resolve(&run.id, &gate_id(), decision).unwrap());
    settled(&f.te.store, &run.id).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_run_parks_at_the_gate_and_an_approval_routes_out() {
    let f = fixture().await;
    let a = gated(&f, true);

    let run = parked_run(&f, &a).await;

    assert_eq!(
        run.parked,
        Some(Parked {
            node_id: gate_id(),
            until: 1_000 + HOUR_MS
        })
    );
    assert_eq!(
        steps(&f.te.store, &run.id),
        BTreeMap::from([
            ("src".to_string(), ok(None)),
            ("post".to_string(), ok(None)),
            ("gate".to_string(), (StepStatus::Waiting, None)),
        ])
    );
    assert_eq!(
        output(&f.te.store, &run.id, "gate"),
        Some(json!({ "message": "Ship 5?" }))
    );

    let run = decide(&f, &f.te.engine, &run, Decision::Approved, 2_000).await;

    assert_eq!(
        (run.status, run.stop_reason.as_deref(), run.parked),
        (RunStatus::Succeeded, None, None)
    );
    assert_eq!(
        steps(&f.te.store, &run.id),
        BTreeMap::from([
            ("src".to_string(), ok(None)),
            ("post".to_string(), ok(None)),
            ("gate".to_string(), ok(None)),
            ("done".to_string(), ok(None)),
            ("handled".to_string(), SKIPPED),
        ])
    );
    assert_eq!(
        output(&f.te.store, &run.id, "gate"),
        Some(json!({ "message": "Ship 5?", "decision": "approved", "decided_at": 2_000 }))
    );
    assert_eq!(f.seen.posts.lock().len(), 1);
    assert!(!f
        .te
        .engine
        .resolve(&run.id, &gate_id(), Decision::Rejected)
        .unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rejection_routes_the_error_edge() {
    let f = fixture().await;
    let a = gated(&f, true);
    let run = parked_run(&f, &a).await;

    let run = decide(&f, &f.te.engine, &run, Decision::Rejected, 2_000).await;

    assert_eq!(run.status, RunStatus::Succeeded);
    assert_eq!(
        steps(&f.te.store, &run.id),
        BTreeMap::from([
            ("src".to_string(), ok(None)),
            ("post".to_string(), ok(None)),
            ("gate".to_string(), ok(Some("rejected"))),
            ("done".to_string(), SKIPPED),
            ("handled".to_string(), ok(None)),
        ])
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rejection_without_an_error_edge_fails_the_run() {
    let f = fixture().await;
    let a = gated(&f, false);
    let run = parked_run(&f, &a).await;

    let run = decide(&f, &f.te.engine, &run, Decision::Rejected, 2_000).await;

    assert_eq!(
        (run.status, run.stop_reason.as_deref()),
        (RunStatus::Failed, Some("gate: rejected"))
    );
    assert_eq!(steps(&f.te.store, &run.id)["done"], SKIPPED);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_tick_times_out_an_expired_park() {
    let f = fixture().await;
    let a = gated(&f, true);
    let run = parked_run(&f, &a).await;

    f.te.clock.set(1_000 + HOUR_MS - 1);
    f.te.engine.tick();
    assert_eq!(
        f.te.store.get_run(&run.id).unwrap().unwrap().status,
        RunStatus::Waiting
    );
    f.te.clock.set(1_000 + HOUR_MS);
    f.te.engine.tick();
    let run = settled(&f.te.store, &run.id).await;

    assert_eq!(run.status, RunStatus::Succeeded);
    assert_eq!(
        steps(&f.te.store, &run.id)["gate"],
        ok(Some("approval_timed_out"))
    );
    assert_eq!(steps(&f.te.store, &run.id)["handled"], ok(None));
    assert_eq!(
        output(&f.te.store, &run.id, "gate"),
        Some(
            json!({ "message": "Ship 5?", "decision": "timed_out", "decided_at": 1_000 + HOUR_MS })
        )
    );
    assert!(!f
        .te
        .engine
        .resolve(&run.id, &gate_id(), Decision::Approved)
        .unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_a_waiting_run_settles_it_cancelled() {
    let f = fixture().await;
    let a = gated(&f, true);
    let run = parked_run(&f, &a).await;

    assert!(f.te.engine.cancel_run(&run.id).unwrap());
    let run = settled(&f.te.store, &run.id).await;

    assert_eq!(
        (run.status, run.stop_reason.as_deref()),
        (RunStatus::Cancelled, Some("cancelled"))
    );
    assert_eq!(
        steps(&f.te.store, &run.id),
        BTreeMap::from([
            ("src".to_string(), ok(None)),
            ("post".to_string(), ok(None)),
            ("gate".to_string(), ok(Some("cancelled"))),
            ("done".to_string(), SKIPPED),
            ("handled".to_string(), SKIPPED),
        ])
    );
    assert!(!f.te.engine.cancel_run(&run.id).unwrap());
    assert!(!f
        .te
        .engine
        .resolve(&run.id, &gate_id(), Decision::Approved)
        .unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_the_automation_cancels_its_waiting_run() {
    let f = fixture().await;
    let a = gated(&f, true);
    let run = parked_run(&f, &a).await;

    f.te.engine.cancel_automation(&a.id);
    let run = settled(&f.te.store, &run.id).await;

    assert_eq!(run.status, RunStatus::Cancelled);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_parked_run_survives_a_restart_and_resumes_without_rerunning_earlier_nodes() {
    let f = fixture().await;
    let a = gated(&f, true);
    let run = parked_run(&f, &a).await;

    let restarted = f.te.restarted(f.root.path().to_path_buf(), f.http.clone());
    restarted.boot();
    assert_eq!(
        f.te.store.get_run(&run.id).unwrap().unwrap().status,
        RunStatus::Waiting
    );

    let run = decide(&f, &restarted, &run, Decision::Approved, 2_000).await;

    assert_eq!(run.status, RunStatus::Succeeded);
    assert_eq!(f.seen.posts.lock().len(), 1);
    assert_eq!(steps(&f.te.store, &run.id)["done"], ok(None));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_run_due_while_another_waits_is_skipped_as_overlap() {
    let f = fixture().await;
    let a = gated(&f, true);
    parked_run(&f, &a).await;

    let overlap =
        f.te.engine
            .start_run(&a, RunTrigger::Manual, 2_000)
            .unwrap();

    assert_eq!(
        (overlap.status, overlap.stop_reason.as_deref()),
        (RunStatus::Skipped, Some(OVERLAP_REASON))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_decision_after_the_deadline_loses_to_the_timeout() {
    let f = fixture().await;
    let a = gated(&f, true);
    let run = parked_run(&f, &a).await;

    f.te.clock.set(1_000 + HOUR_MS);
    assert!(!f
        .te
        .engine
        .resolve(&run.id, &gate_id(), Decision::Approved)
        .unwrap());
    f.te.engine.tick();
    let run = settled(&f.te.store, &run.id).await;

    assert_eq!(
        steps(&f.te.store, &run.id)["gate"],
        ok(Some("approval_timed_out"))
    );
    assert_eq!(steps(&f.te.store, &run.id)["done"], SKIPPED);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_expired_park_of_a_deleted_automation_settles_cancelled() {
    let f = fixture().await;
    let a = gated(&f, true);
    let run = parked_run(&f, &a).await;
    assert!(f.te.store.soft_delete(&a.id, 2_000).unwrap());

    f.te.clock.set(1_000 + HOUR_MS);
    f.te.engine.tick();
    let run = settled(&f.te.store, &run.id).await;

    assert_eq!(run.status, RunStatus::Cancelled);
    assert_eq!(steps(&f.te.store, &run.id)["gate"], ok(Some("cancelled")));
    assert_eq!(steps(&f.te.store, &run.id)["handled"], SKIPPED);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_parked_worktree_run_keeps_its_worktree_until_it_settles() {
    let f = fixture().await;
    let repo = f.root.path();
    let git = |args: &[&str]| {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(repo)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {out:?}");
        String::from_utf8(out.stdout).unwrap()
    };
    git(&["init", "-q"]);
    git(&[
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "init",
    ]);
    let mut a = gated(&f, true);
    a.isolation = crate::automation::model::Isolation::WorktreePerRun;
    let run = parked_run(&f, &a).await;
    let worktree = repo
        .join(".termul/worktrees")
        .join(run.worktree_id.clone().unwrap());
    assert!(worktree.exists(), "the parked run keeps its worktree");
    std::fs::write(worktree.join("edit.txt"), "kept").unwrap();

    f.te.clock.set(2_000);
    assert!(f
        .te
        .engine
        .resolve(&run.id, &gate_id(), Decision::Approved)
        .unwrap());
    let run = settled(&f.te.store, &run.id).await;

    assert_eq!(run.status, RunStatus::Succeeded);
    assert!(!worktree.exists(), "the settled run removes its worktree");
    assert_eq!(git(&["branch", "--list", "automation/*"]), "");
}
