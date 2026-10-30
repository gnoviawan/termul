use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::graph::validate;
use super::model::{
    ApplyOpsResult, Automation, Edge, EdgeSource, Isolation, LastRun, NodeId, Op, Port, Run,
    RunPolicy, RunStatus, RunTrigger, Step, StepStatus, Trigger,
};
use super::policy::run_policy;
use super::suggest::{Cadence, Suggestion};
use super::test_support::{node_id, ops, sample_automation};

/// Every wire type in one document. The TypeScript mirror types the same
/// file, so a rename on either side fails a test.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct WireFixture {
    automation: Automation,
    triggers: Vec<Trigger>,
    ops: Vec<Op>,
    apply_ops_result: ApplyOpsResult,
    runs: Vec<Run>,
    steps: Vec<Step>,
    run_policy: RunPolicy,
    suggestion: Suggestion,
}

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../src/shared/types/__fixtures__/automation.json")
}

fn build_fixture() -> WireFixture {
    let mut automation = sample_automation();
    automation.approved_revision = Some(1);
    automation.next_run_at = Some(1_773_046_800_000);
    automation.consecutive_errors = 1;
    automation.unseen_failures = 2;
    automation.last_run = Some(LastRun {
        run_id: "run-1".to_string().into(),
        status: RunStatus::Failed,
        finished_at: 1_773_046_860_000,
    });
    let mut fresh = Automation::new("project-1".into(), "Draft".into(), 1_000);
    fresh.id = "auto-2".to_string().into();
    fresh.isolation = Isolation::WorktreePerRun;
    let triggers = serde_json::from_value(json!([
        { "kind": "manual" },
        { "kind": "schedule", "schedule": { "kind": "cron", "expr": "0 5 * * 1-5", "timezone": "America/New_York" } },
        { "kind": "schedule", "schedule": { "kind": "every", "every_ms": 900000, "anchor_ms": 0 } },
        { "kind": "schedule", "schedule": { "kind": "at", "at": 1_773_046_800_000_i64 } }
    ]))
    .unwrap();
    let run = Run {
        id: "run-1".to_string().into(),
        automation_id: automation.id.clone(),
        revision: 1,
        graph: serde_json::from_value(json!({
            "nodes": [{ "id": "stop", "label": "Stop", "spec": { "kind": "fail", "message": "{{trigger.kind}}" } }],
            "edges": [{ "from": "trigger", "port": "out", "to": "stop" }]
        }))
        .unwrap(),
        trigger: RunTrigger::Scheduled,
        scheduled_for: 1_773_046_800_000,
        status: RunStatus::Failed,
        started_at: 1_773_046_800_100,
        finished_at: Some(1_773_046_860_000),
        stop_reason: Some("node post failed".into()),
        summary: None,
        conversation_id: None,
        worktree_id: Some("wt-1".into()),
    };
    let running = Run {
        id: "run-2".to_string().into(),
        trigger: RunTrigger::CatchUp,
        status: RunStatus::Running,
        finished_at: None,
        stop_reason: None,
        worktree_id: None,
        ..run.clone()
    };
    let steps = vec![
        Step {
            run_id: run.id.clone(),
            node_id: node_id("fetch"),
            status: StepStatus::Succeeded,
            output: Some(json!({ "items": [{ "title": "first" }] })),
            error: None,
            started_at: Some(1_773_046_800_200),
            finished_at: Some(1_773_046_801_000),
        },
        Step {
            run_id: run.id.clone(),
            node_id: node_id("post"),
            status: StepStatus::Failed,
            output: None,
            error: Some("secret_missing:HOOK_KEY".into()),
            started_at: Some(1_773_046_859_000),
            finished_at: Some(1_773_046_860_000),
        },
        Step {
            run_id: run.id.clone(),
            node_id: node_id("alert"),
            status: StepStatus::Skipped,
            output: None,
            error: None,
            started_at: None,
            finished_at: None,
        },
    ];
    WireFixture {
        run_policy: run_policy(&automation, 1_772_798_400_000),
        apply_ops_result: ApplyOpsResult {
            issues: validate(&fresh),
            automation: fresh,
        },
        automation,
        triggers,
        ops: ops(json!([
            { "op": "add_node", "node": { "id": "note", "label": "Note", "spec": { "kind": "transform", "fields": [{ "name": "text", "value": "hi" }] } } },
            { "op": "update_node", "id": "note", "label": "Renamed" },
            { "op": "update_node", "id": "check", "spec": { "kind": "condition", "left": "{{nodes.extract.output.urgent}}", "op": "exists", "right": null } },
            { "op": "remove_node", "id": "note" },
            { "op": "connect", "edge": { "from": "check", "port": "false", "to": "alert" } },
            { "op": "disconnect", "edge": { "from": "check", "port": "false", "to": "alert" } },
            { "op": "set_trigger", "trigger": { "kind": "manual" } },
            { "op": "rename", "name": "Digest" },
            { "op": "set_isolation", "isolation": "worktree_per_run" }
        ])),
        runs: vec![run, running],
        steps,
        suggestion: Suggestion {
            fingerprint: "3f1c9a0d5b7e2468".to_string(),
            representative: "summarize the open PRs in termul".to_string(),
            occurrences: 4,
            days: 4,
            last_at: 1_793_264_700_000,
            cadence: Cadence {
                schedule: super::model::Schedule::Cron {
                    expr: "0 9 * * 1-5".to_string(),
                    timezone: "Europe/Berlin".to_string(),
                },
                label: "weekdays at 09:00".to_string(),
            },
        },
    }
}

#[test]
fn wire_fixture_matches_the_shared_typescript_fixture() {
    let built = serde_json::to_value(build_fixture()).unwrap();
    let path = fixture_path();
    if std::env::var_os("UPDATE_AUTOMATION_FIXTURE").is_some() {
        let text = serde_json::to_string_pretty(&built).unwrap() + "\n";
        std::fs::write(&path, text).unwrap();
    }
    let on_disk: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(
        on_disk, built,
        "rerun with UPDATE_AUTOMATION_FIXTURE=1 and update automation.types.ts to match"
    );
    let parsed: WireFixture = serde_json::from_value(on_disk).unwrap();
    assert_eq!(parsed, build_fixture());
}

#[test]
fn node_ids_are_validated_when_parsed() {
    for ok in ["a", "fetch_2", "abcdefghijklmnopqrstuvwxyz012345"] {
        assert_eq!(NodeId::parse(ok).map(|n| n.to_string()), Ok(ok.to_string()));
    }
    for bad in [
        "",
        "Fetch",
        "2fetch",
        "fe-tch",
        "trigger",
        "abcdefghijklmnopqrstuvwxyz0123456",
    ] {
        assert!(NodeId::parse(bad).is_err(), "{bad}");
        assert!(
            serde_json::from_value::<NodeId>(json!(bad)).is_err(),
            "{bad}"
        );
    }
}

#[test]
fn edge_sources_parse_trigger_and_node_ids() {
    let edge: Edge =
        serde_json::from_value(json!({ "from": "trigger", "port": "out", "to": "fetch" })).unwrap();
    assert_eq!(
        edge,
        Edge {
            from: EdgeSource::Trigger,
            port: Port::Out,
            to: node_id("fetch"),
        }
    );
    let edge: Edge =
        serde_json::from_value(json!({ "from": "check", "port": "true", "to": "post" })).unwrap();
    assert_eq!(edge.from, EdgeSource::Node(node_id("check")));
    assert!(
        serde_json::from_value::<Edge>(json!({ "from": "Trigger", "port": "out", "to": "x" }))
            .is_err()
    );
}

#[test]
fn armed_needs_enabled_live_and_the_current_revision_approved() {
    let mut a = sample_automation();
    assert!(!a.armed());
    a.approved_revision = Some(1);
    assert!(a.armed());
    a.revision = 2;
    assert!(!a.armed());
    a.approved_revision = Some(2);
    a.enabled = false;
    assert!(!a.armed());
    a.enabled = true;
    a.deleted_at = Some(5);
    assert!(!a.armed());
}
