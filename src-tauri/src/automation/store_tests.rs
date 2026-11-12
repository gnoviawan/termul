use serde_json::{json, Value};

use super::model::{
    Automation, IssueCode, LastRun, Layout, NodePosition, Parked, Run, RunId, RunStatus,
    RunTrigger, SettledStatus, Step, StepStatus,
};
use super::store::{AutomationStore, ClaimOutcome, ParkEnd, SettleOutcome, StoreError};
use super::test_support::{apply, node_id, sample_automation};

const NOW: i64 = 1_000_030;

/// The sample on an every-minute schedule anchored at 0, so slots are
/// multiples of 60_000.
fn every_minute() -> Automation {
    apply(
        &sample_automation(),
        json!([{ "op": "set_trigger", "trigger": { "kind": "schedule",
            "schedule": { "kind": "every", "every_ms": 60000, "anchor_ms": 0 } } }]),
    )
}

fn approved(store: &AutomationStore, a: &Automation) -> Automation {
    store.create(a, NOW).unwrap();
    store.approve(&a.id, a.revision, NOW).unwrap()
}

fn run(a: &Automation, id: &str, trigger: RunTrigger) -> Run {
    Run {
        id: RunId::from(id.to_string()),
        automation_id: a.id.clone(),
        revision: a.revision,
        graph: a.graph.clone(),
        trigger,
        scheduled_for: 1_020_000,
        status: RunStatus::Running,
        started_at: 1_020_001,
        finished_at: None,
        stop_reason: None,
        summary: None,
        conversation_id: None,
        worktree_id: None,
        parked: None,
    }
}

#[test]
fn migrates_once_and_reopens_with_data() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("automations.sqlite");
    let a = every_minute();
    AutomationStore::open(&path)
        .unwrap()
        .create(&a, NOW)
        .unwrap();
    let reopened = AutomationStore::open(&path).unwrap();
    assert_eq!(
        reopened.get(&a.id).unwrap().map(|r| r.name),
        Some("Morning digest".into())
    );
    let version: i64 = rusqlite::Connection::open(&path)
        .unwrap()
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, 5);
}

#[test]
fn create_derives_next_run_at_and_round_trips() {
    let store = AutomationStore::open_in_memory().unwrap();
    let mut a = every_minute();
    a.approved_revision = Some(a.revision);
    a.next_run_at = Some(5);
    a.last_run = Some(LastRun {
        run_id: RunId::from("r0".to_string()),
        status: RunStatus::Succeeded,
        finished_at: 7,
    });
    let created = store.create(&a, NOW).unwrap();
    assert_eq!(created.next_run_at, Some(1_020_000));
    let mut plain = every_minute();
    plain.id = "auto-2".to_string().into();
    plain.project_id = "project-2".into();
    store.create(&plain, NOW).unwrap();
    assert_eq!(store.get(&a.id).unwrap(), Some(created));
    assert_eq!(store.get(&plain.id).unwrap().unwrap().next_run_at, None);
    let in_p2: Vec<String> = store
        .list(Some("project-2"))
        .unwrap()
        .into_iter()
        .map(|r| r.id.to_string())
        .collect();
    assert_eq!(in_p2, vec!["auto-2"]);
    assert_eq!(store.list(None).unwrap().len(), 2);
}

#[test]
fn approve_requires_the_current_revision_and_no_issues() {
    let store = AutomationStore::open_in_memory().unwrap();
    let a = every_minute();
    store.create(&a, NOW).unwrap();
    assert!(matches!(
        store.approve(&a.id, 1, NOW),
        Err(StoreError::RevisionConflict { current: 2 })
    ));
    let broken = apply(&a, json!([{ "op": "remove_node", "id": "fetch" }]));
    store.save(&broken, a.revision, NOW).unwrap();
    match store.approve(&a.id, broken.revision, NOW) {
        Err(StoreError::HasIssues(issues)) => {
            assert_eq!(issues[0].code, IssueCode::TriggerEdgeCount)
        }
        other => panic!("expected HasIssues, got {other:?}"),
    }
    let fresh = AutomationStore::open_in_memory().unwrap();
    let ok = approved(&fresh, &every_minute());
    assert_eq!(
        (ok.approved_revision, ok.next_run_at),
        (Some(2), Some(1_020_000))
    );
}

#[test]
fn a_new_revision_unarms_and_a_stale_base_conflicts() {
    let store = AutomationStore::open_in_memory().unwrap();
    let a = approved(&store, &every_minute());
    let edited = apply(&a, json!([{ "op": "rename", "name": "Edited" }]));
    let saved = store.save(&edited, a.revision, NOW).unwrap();
    assert_eq!(
        (saved.revision, saved.approved_revision, saved.next_run_at),
        (3, Some(2), None)
    );
    assert_eq!(store.list_due(i64::MAX).unwrap(), vec![]);
    assert!(matches!(
        store.save(&edited, a.revision, NOW),
        Err(StoreError::RevisionConflict { current: 3 })
    ));
}

#[test]
fn enable_and_disable_maintain_next_run_at() {
    let store = AutomationStore::open_in_memory().unwrap();
    let a = approved(&store, &every_minute());
    assert_eq!(
        store.set_enabled(&a.id, false, NOW).unwrap().next_run_at,
        None
    );
    assert_eq!(
        store
            .set_enabled(&a.id, true, 1_500_000)
            .unwrap()
            .next_run_at,
        Some(1_560_000)
    );
    assert!(store.soft_delete(&a.id, NOW).unwrap());
    assert_eq!(store.get(&a.id).unwrap(), None);
    assert_eq!(store.list(None).unwrap(), vec![]);
}

#[test]
fn two_claims_of_the_same_slot_have_exactly_one_winner() {
    let store = AutomationStore::open_in_memory().unwrap();
    let a = approved(&store, &every_minute());
    let due = store.list_due(1_020_000).unwrap();
    assert_eq!(due.len(), 1);
    let seen = due[0].next_run_at.unwrap();
    let first = store.claim_due(&a.id, seen, 1_020_005).unwrap();
    let second = store.claim_due(&a.id, seen, 1_020_005).unwrap();
    match first {
        ClaimOutcome::Claimed {
            automation,
            scheduled_for,
        } => assert_eq!(
            (scheduled_for, automation.next_run_at),
            (1_020_000, Some(1_080_000))
        ),
        other => panic!("expected Claimed, got {other:?}"),
    }
    assert_eq!(second, ClaimOutcome::Lost);
    assert_eq!(store.list_due(1_079_999).unwrap(), vec![]);
}

#[test]
fn a_backlog_claims_once_and_moves_past_now() {
    let store = AutomationStore::open_in_memory().unwrap();
    let a = approved(&store, &every_minute());
    match store.claim_due(&a.id, 1_020_000, 1_500_000).unwrap() {
        ClaimOutcome::Claimed { automation, .. } => {
            assert_eq!(automation.next_run_at, Some(1_560_000))
        }
        other => panic!("expected Claimed, got {other:?}"),
    }
    assert_eq!(store.list_due(1_500_000).unwrap(), vec![]);
}

#[test]
fn claiming_an_at_schedule_disables_it() {
    let store = AutomationStore::open_in_memory().unwrap();
    let at = apply(
        &sample_automation(),
        json!([{ "op": "set_trigger", "trigger": { "kind": "schedule",
            "schedule": { "kind": "at", "at": 1_200_000 } } }]),
    );
    let a = approved(&store, &at);
    assert_eq!(a.next_run_at, Some(1_200_000));
    assert!(matches!(
        store.claim_due(&a.id, 1_200_000, 1_200_001).unwrap(),
        ClaimOutcome::Claimed { .. }
    ));
    let after = store.get(&a.id).unwrap().unwrap();
    assert_eq!((after.enabled, after.next_run_at), (false, None));
}

#[test]
fn settle_happens_exactly_once_and_drives_backoff() {
    let store = AutomationStore::open_in_memory().unwrap();
    let a = approved(&store, &every_minute());
    store.claim_due(&a.id, 1_020_000, 1_020_005).unwrap();
    store
        .insert_run(&run(&a, "r1", RunTrigger::Scheduled))
        .unwrap();
    assert!(store.has_active_run(&a.id).unwrap());
    let first = store
        .settle_run(
            &"r1".to_string().into(),
            SettledStatus::Failed,
            Some("http 500"),
            None,
            1_030_000,
        )
        .unwrap();
    let again = store
        .settle_run(
            &"r1".to_string().into(),
            SettledStatus::Succeeded,
            None,
            None,
            1_031_000,
        )
        .unwrap();
    match first {
        SettleOutcome::Settled(r) => assert_eq!(
            (r.status, r.finished_at, r.stop_reason.as_deref()),
            (RunStatus::Failed, Some(1_030_000), Some("http 500"))
        ),
        other => panic!("expected Settled, got {other:?}"),
    }
    assert_eq!(again, SettleOutcome::AlreadySettled);
    assert!(!store.has_active_run(&a.id).unwrap());
    let after = store.get(&a.id).unwrap().unwrap();
    assert_eq!(
        (
            after.consecutive_errors,
            after.unseen_failures,
            after.next_run_at
        ),
        (1, 1, Some(1_080_000))
    );
    assert_eq!(
        after.last_run,
        Some(LastRun {
            run_id: "r1".to_string().into(),
            status: RunStatus::Failed,
            finished_at: 1_030_000,
        })
    );

    store
        .insert_run(&run(&a, "r2", RunTrigger::CatchUp))
        .unwrap();
    store
        .settle_run(
            &"r2".to_string().into(),
            SettledStatus::Failed,
            None,
            None,
            1_030_000,
        )
        .unwrap();
    let after = store.get(&a.id).unwrap().unwrap();
    assert_eq!(
        (
            after.consecutive_errors,
            after.unseen_failures,
            after.next_run_at
        ),
        (2, 2, Some(1_090_000))
    );

    store
        .insert_run(&run(&a, "r3", RunTrigger::Manual))
        .unwrap();
    store
        .settle_run(
            &"r3".to_string().into(),
            SettledStatus::Failed,
            None,
            None,
            1_040_000,
        )
        .unwrap();
    let after = store.get(&a.id).unwrap().unwrap();
    assert_eq!(
        (
            after.consecutive_errors,
            after.unseen_failures,
            after.next_run_at
        ),
        (2, 3, Some(1_090_000))
    );

    store
        .insert_run(&run(&a, "r4", RunTrigger::Scheduled))
        .unwrap();
    store
        .settle_run(
            &"r4".to_string().into(),
            SettledStatus::Succeeded,
            None,
            Some("ok"),
            1_050_000,
        )
        .unwrap();
    store.mark_seen(&a.id).unwrap();
    let after = store.get(&a.id).unwrap().unwrap();
    assert_eq!((after.consecutive_errors, after.unseen_failures), (0, 0));
    let listed: Vec<String> = store
        .list_runs(&a.id, 2)
        .unwrap()
        .into_iter()
        .map(|r| r.id.to_string())
        .collect();
    assert_eq!(listed, vec!["r4", "r3"]);
    assert!(matches!(
        store.settle_run(
            &"nope".to_string().into(),
            SettledStatus::Failed,
            None,
            None,
            0
        ),
        Err(StoreError::NotFound(_))
    ));
}

fn step(run: &str, node: &str, status: StepStatus, finished_at: Option<i64>) -> Step {
    Step {
        run_id: run.to_string().into(),
        node_id: node_id(node),
        status,
        output: (status == StepStatus::Succeeded).then(|| json!({ "items": [1, 2] })),
        error: None,
        started_at: Some(10),
        finished_at,
        iteration: None,
        wait_until: None,
    }
}

#[test]
fn finished_steps_are_never_rewritten() {
    let store = AutomationStore::open_in_memory().unwrap();
    let a = approved(&store, &every_minute());
    store
        .insert_run(&run(&a, "r1", RunTrigger::Manual))
        .unwrap();
    assert!(store
        .upsert_step(&step("r1", "fetch", StepStatus::Running, None))
        .unwrap());
    assert!(store
        .upsert_step(&step("r1", "fetch", StepStatus::Succeeded, Some(20)))
        .unwrap());
    assert!(!store
        .upsert_step(&step("r1", "fetch", StepStatus::Failed, Some(30)))
        .unwrap());
    assert_eq!(
        store.get_steps(&"r1".to_string().into()).unwrap(),
        vec![step("r1", "fetch", StepStatus::Succeeded, Some(20))]
    );
}

#[test]
fn reconcile_fails_stranded_runs_and_steps_once() {
    let store = AutomationStore::open_in_memory().unwrap();
    let a = approved(&store, &every_minute());
    store
        .insert_run(&run(&a, "r1", RunTrigger::Scheduled))
        .unwrap();
    store
        .upsert_step(&step("r1", "fetch", StepStatus::Running, None))
        .unwrap();
    assert_eq!(store.reconcile_stranded(2_000_000).unwrap(), 1);
    assert_eq!(store.reconcile_stranded(2_000_001).unwrap(), 0);
    let r = store.get_run(&"r1".to_string().into()).unwrap().unwrap();
    assert_eq!(
        (r.status, r.stop_reason.as_deref(), r.finished_at),
        (RunStatus::Failed, Some("stranded"), Some(2_000_000))
    );
    let steps = store.get_steps(&"r1".to_string().into()).unwrap();
    assert_eq!(
        (steps[0].status, steps[0].error.as_deref()),
        (StepStatus::Failed, Some("stranded"))
    );
    let after = store.get(&a.id).unwrap().unwrap();
    assert_eq!(
        (after.unseen_failures, after.consecutive_errors, after.next_run_at),
        (1, 0, a.next_run_at)
    );
}

#[test]
fn prune_removes_only_old_finished_runs() {
    let store = AutomationStore::open_in_memory().unwrap();
    let a = approved(&store, &every_minute());
    store
        .insert_run(&run(&a, "old", RunTrigger::Manual))
        .unwrap();
    store
        .upsert_step(&step("old", "fetch", StepStatus::Running, None))
        .unwrap();
    store
        .settle_run(
            &"old".to_string().into(),
            SettledStatus::Succeeded,
            None,
            None,
            5_000,
        )
        .unwrap();
    store
        .insert_run(&run(&a, "live", RunTrigger::Manual))
        .unwrap();
    assert_eq!(store.prune_runs(6_000).unwrap(), 1);
    let left: Vec<String> = store
        .list_runs(&a.id, 10)
        .unwrap()
        .into_iter()
        .map(|r| r.id.to_string())
        .collect();
    assert_eq!(left, vec!["live"]);
    assert_eq!(store.get_steps(&"old".to_string().into()).unwrap(), vec![]);
}

#[test]
fn answered_suggestions_are_the_dismissed_and_accepted_ones_of_the_project() {
    let store = AutomationStore::open_in_memory().unwrap();
    store.dismiss_suggestion("p1", "aaaa", NOW).unwrap();
    store.dismiss_suggestion("p1", "aaaa", NOW + 1).unwrap();
    store.accept_suggestion("p1", "bbbb", NOW).unwrap();
    store.dismiss_suggestion("p2", "cccc", NOW).unwrap();

    let mut p1: Vec<String> = store.answered_suggestions("p1").unwrap().into_iter().collect();
    p1.sort();
    assert_eq!(p1, vec!["aaaa".to_string(), "bbbb".to_string()]);
    assert_eq!(
        store.answered_suggestions("p2").unwrap().into_iter().collect::<Vec<_>>(),
        vec!["cccc".to_string()]
    );
}

#[test]
fn schema_4_keeps_the_step_rows_of_a_schema_3_database() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("automations.sqlite");
    {
        let db = rusqlite::Connection::open(&path).unwrap();
        for sql in &super::store::MIGRATIONS[..3] {
            db.execute_batch(sql).unwrap();
        }
        db.pragma_update(None, "user_version", 3).unwrap();
        db.execute_batch(
            r#"INSERT INTO automation (id, project_id, name, revision, enabled, trigger_json,
                   graph_json, isolation, created_at, updated_at)
               VALUES ('auto-old', 'p1', 'Old', 1, 1, '{"kind":"manual"}',
                   '{"nodes":[],"edges":[]}', 'shared_in_root', 1, 1);
               INSERT INTO automation_run (id, automation_id, revision, graph_json, trigger,
                   scheduled_for, status, started_at, finished_at)
               VALUES ('run-old', 'auto-old', 1, '{"nodes":[],"edges":[]}', 'manual', 5,
                   'succeeded', 5, 9);
               INSERT INTO automation_step (run_id, node_id, status, output_json, error,
                   started_at, finished_at)
               VALUES ('run-old', 'fetch', 'succeeded', '{"items":[1,2]}', NULL, 6, 7),
                      ('run-old', 'post', 'failed', NULL, 'http_status:500', 7, 8);"#,
        )
        .unwrap();
    }

    let store = AutomationStore::open(&path).unwrap();
    let run_id = RunId::from("run-old".to_string());
    assert_eq!(
        store.get_steps(&run_id).unwrap(),
        vec![
            Step {
                run_id: run_id.clone(),
                node_id: node_id("fetch"),
                iteration: None,
                status: StepStatus::Succeeded,
                output: Some(json!({ "items": [1, 2] })),
                error: None,
                started_at: Some(6),
                finished_at: Some(7),
                wait_until: None,
            },
            Step {
                run_id: run_id.clone(),
                node_id: node_id("post"),
                iteration: None,
                status: StepStatus::Failed,
                output: None,
                error: Some("http_status:500".into()),
                started_at: Some(7),
                finished_at: Some(8),
                wait_until: None,
            },
        ]
    );
    let mut in_loop = step("run-old", "post", StepStatus::Succeeded, Some(9));
    in_loop.iteration = Some(0);
    assert!(store.upsert_step(&in_loop).unwrap());
    assert_eq!(
        store
            .get_steps(&run_id)
            .unwrap()
            .iter()
            .map(|s| (s.node_id.to_string(), s.iteration, s.status))
            .collect::<Vec<_>>(),
        vec![
            ("fetch".to_string(), None, StepStatus::Succeeded),
            ("post".to_string(), None, StepStatus::Failed),
            ("post".to_string(), Some(0), StepStatus::Succeeded),
        ]
    );
}

fn waiting(run: &str, node: &str, iteration: Option<u32>, output: Option<Value>) -> Step {
    Step {
        iteration,
        output,
        wait_until: Some(5_000),
        ..step(run, node, StepStatus::Waiting, None)
    }
}

fn run_id(id: &str) -> RunId {
    RunId::from(id.to_string())
}

#[test]
fn a_run_reads_where_it_is_parked_from_its_waiting_step() {
    let store = AutomationStore::open_in_memory().unwrap();
    let a = approved(&store, &every_minute());
    store.insert_run(&run(&a, "r1", RunTrigger::Manual)).unwrap();
    store.insert_run(&run(&a, "r2", RunTrigger::Manual)).unwrap();
    store
        .upsert_step(&waiting("r1", "gate", Some(2), None))
        .unwrap();
    let parked = Parked {
        node_id: node_id("gate"),
        iteration: Some(2),
        until: 5_000,
    };

    let r1 = store.get_run(&run_id("r1")).unwrap().unwrap();
    assert_eq!(r1.parked, Some(parked.clone()));
    assert_eq!(store.get_run(&run_id("r2")).unwrap().unwrap().parked, None);
    assert_eq!(store.list_parked().unwrap(), vec![(r1, parked)]);

    store
        .claim_park(&run_id("r1"), &node_id("gate"), Some(2), ParkEnd::Approved, 4_000)
        .unwrap();
    assert_eq!(store.get_run(&run_id("r1")).unwrap().unwrap().parked, None);
    assert_eq!(store.list_parked().unwrap(), vec![]);
}

#[test]
fn a_decision_claims_a_waiting_approval_once_and_only_before_its_deadline() {
    let store = AutomationStore::open_in_memory().unwrap();
    let a = approved(&store, &every_minute());
    store.insert_run(&run(&a, "r1", RunTrigger::Manual)).unwrap();
    store
        .upsert_step(&waiting("r1", "gate", None, Some(json!({ "message": "Ship?" }))))
        .unwrap();
    let claim = |end, now| {
        store
            .claim_park(&run_id("r1"), &node_id("gate"), None, end, now)
            .unwrap()
    };

    assert!(!claim(ParkEnd::Approved, 5_000), "the deadline passed");
    assert!(claim(ParkEnd::Rejected, 4_999));
    assert!(!claim(ParkEnd::Approved, 4_999), "already decided");
    assert!(!claim(ParkEnd::ApprovalTimedOut, 5_000), "already decided");

    let gate = &store.get_steps(&run_id("r1")).unwrap()[0];
    assert_eq!(
        (gate.status, gate.error.as_deref(), gate.output.clone(), gate.finished_at),
        (
            StepStatus::Failed,
            Some("rejected"),
            Some(json!({ "message": "Ship?", "decision": "rejected", "decided_at": 4_999 })),
            Some(4_999)
        )
    );
}

#[test]
fn the_deadline_claim_times_out_an_approval_but_resumes_a_wait() {
    let store = AutomationStore::open_in_memory().unwrap();
    let a = approved(&store, &every_minute());
    store.insert_run(&run(&a, "r1", RunTrigger::Manual)).unwrap();
    store.insert_run(&run(&a, "r2", RunTrigger::Manual)).unwrap();
    store
        .upsert_step(&waiting("r1", "gate", None, Some(json!({ "message": "Ship?" }))))
        .unwrap();
    store
        .upsert_step(&waiting("r2", "pause", Some(0), None))
        .unwrap();

    assert!(!store
        .claim_park(&run_id("r1"), &node_id("gate"), None, ParkEnd::ApprovalTimedOut, 4_999)
        .unwrap());
    assert!(store
        .claim_park(&run_id("r1"), &node_id("gate"), None, ParkEnd::ApprovalTimedOut, 5_000)
        .unwrap());
    assert!(store
        .claim_park(&run_id("r2"), &node_id("pause"), Some(0), ParkEnd::WaitDue, 5_001)
        .unwrap());

    let ended = |id: &str| {
        let s = store.get_steps(&run_id(id)).unwrap().remove(0);
        (s.status, s.error, s.output)
    };
    assert_eq!(
        ended("r1"),
        (
            StepStatus::Failed,
            Some("approval_timed_out".to_string()),
            Some(json!({ "message": "Ship?", "decision": "timed_out", "decided_at": 5_000 }))
        )
    );
    assert_eq!(
        ended("r2"),
        (
            StepStatus::Succeeded,
            None,
            Some(json!({ "resumed_at": 5_001 }))
        )
    );
}

#[test]
fn runs_list_the_one_in_flight_first_then_newest() {
    let store = AutomationStore::open_in_memory().unwrap();
    let a = approved(&store, &every_minute());
    for (id, status, started_at) in [
        ("parked", RunStatus::Running, 1_000),
        ("old", RunStatus::Succeeded, 500),
        ("skip1", RunStatus::Skipped, 2_000),
        ("skip2", RunStatus::Skipped, 3_000),
    ] {
        store
            .insert_run(&Run {
                status,
                started_at,
                ..run(&a, id, RunTrigger::Scheduled)
            })
            .unwrap();
    }

    let ids: Vec<String> = store
        .list_runs(&a.id, 3)
        .unwrap()
        .into_iter()
        .map(|r| r.id.to_string())
        .collect();
    assert_eq!(ids, vec!["parked", "skip2", "skip1"]);
}

fn layout(entries: &[(&str, f64, f64)]) -> Layout {
    Layout(
        entries
            .iter()
            .map(|(key, x, y)| (key.to_string(), NodePosition { x: *x, y: *y }))
            .collect(),
    )
}

#[test]
fn schema_5_keeps_the_rows_of_a_schema_4_database_with_an_empty_layout() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("automations.sqlite");
    {
        let db = rusqlite::Connection::open(&path).unwrap();
        for sql in &super::store::MIGRATIONS[..4] {
            db.execute_batch(sql).unwrap();
        }
        db.pragma_update(None, "user_version", 4).unwrap();
        db.execute_batch(
            r#"INSERT INTO automation (id, project_id, name, revision, approved_revision, enabled,
                   trigger_json, graph_json, isolation, created_at, updated_at)
               VALUES ('auto-old', 'p1', 'Old', 3, 3, 1, '{"kind":"manual"}',
                   '{"nodes":[],"edges":[]}', 'shared_in_root', 1, 2);"#,
        )
        .unwrap();
    }

    let store = AutomationStore::open(&path).unwrap();
    let old = store.get(&"auto-old".to_string().into()).unwrap().unwrap();
    assert_eq!(
        (
            old.name.as_str(),
            old.revision,
            old.approved_revision,
            old.layout
        ),
        ("Old", 3, Some(3), Layout::default())
    );
}

#[test]
fn set_layout_writes_only_the_layout_column() {
    let store = AutomationStore::open_in_memory().unwrap();
    let a = approved(&store, &every_minute());
    let before = store.get(&a.id).unwrap().unwrap();

    let saved = store
        .set_layout(
            &a.id,
            layout(&[("trigger", 10.0, 20.5), ("fetch", -4.0, 0.0)]),
        )
        .unwrap();

    let after = store.get(&a.id).unwrap().unwrap();
    assert_eq!(after, saved);
    assert_eq!(
        after.layout,
        layout(&[("trigger", 10.0, 20.5), ("fetch", -4.0, 0.0)])
    );
    assert_eq!(
        Automation {
            layout: Layout::default(),
            ..after
        },
        before,
        "every other field, updated_at and next_run_at included, is unchanged"
    );
}

#[test]
fn set_layout_drops_keys_that_are_not_the_trigger_or_a_stored_node() {
    let store = AutomationStore::open_in_memory().unwrap();
    let a = approved(&store, &every_minute());
    let saved = store
        .set_layout(
            &a.id,
            layout(&[
                ("trigger", 1.0, 2.0),
                ("extract", 3.0, 4.0),
                ("ghost", 5.0, 6.0),
                ("", 7.0, 8.0),
            ]),
        )
        .unwrap();
    assert_eq!(
        saved.layout,
        layout(&[("trigger", 1.0, 2.0), ("extract", 3.0, 4.0)])
    );
    assert_eq!(store.get(&a.id).unwrap().unwrap().layout, saved.layout);
}

#[test]
fn set_layout_of_a_missing_automation_is_not_found() {
    let store = AutomationStore::open_in_memory().unwrap();
    let missing = "nope".to_string().into();
    assert!(matches!(
        store.set_layout(&missing, Layout::default()),
        Err(StoreError::NotFound(id)) if id == "nope"
    ));
}

#[test]
fn save_keeps_the_stored_layout_and_prunes_the_nodes_it_removed() {
    let store = AutomationStore::open_in_memory().unwrap();
    let a = approved(&store, &every_minute());
    store
        .set_layout(
            &a.id,
            layout(&[
                ("trigger", 1.0, 2.0),
                ("post", 3.0, 4.0),
                ("alert", 5.0, 6.0),
            ]),
        )
        .unwrap();

    let without_post = apply(&a, json!([{ "op": "remove_node", "id": "post" }]));
    let mut stale = without_post.clone();
    stale.layout = Layout::default();
    let saved = store.save(&stale, a.revision, NOW).unwrap();

    let expected = layout(&[("trigger", 1.0, 2.0), ("alert", 5.0, 6.0)]);
    assert_eq!(
        saved.layout, expected,
        "the caller's copy is not the layout's source"
    );
    assert_eq!(store.get(&a.id).unwrap().unwrap().layout, expected);
}
