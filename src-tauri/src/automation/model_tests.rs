use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::graph::validate;
use super::model::{
    ApplyOpsResult, Automation, Edge, EdgeSource, Isolation, LastRun, NamedTemplate, NodeId,
    NodeSpec, Op, Parked, Port, Run, RunPolicy, RunStatus, RunTrigger, Step, StepStatus, Template,
    Trigger,
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
            "nodes": [
                { "id": "each", "label": "Each item", "spec": { "kind": "for_each", "items": "{{trigger.kind}}", "max_iterations": 5 } },
                { "id": "body", "label": "Body", "spec": { "kind": "transform", "fields": [
                    { "name": "item", "value": "{{nodes.each.item.name}}" },
                    { "name": "index", "value": "{{nodes.each.index}}" }] } },
                { "id": "join", "label": "Join", "spec": { "kind": "merge", "mode": "any" } },
                { "id": "pause", "label": "Pause", "spec": { "kind": "wait", "duration_ms": 3_600_000 } },
                { "id": "gate", "label": "Ship it?", "spec": { "kind": "approval", "message": "Ship {{nodes.body.output.item}}?", "timeout_ms": 86_400_000 } },
                { "id": "stop", "label": "Stop", "spec": { "kind": "fail", "message": "{{trigger.kind}}" } }
            ],
            "edges": [
                { "from": "trigger", "port": "out", "to": "each" },
                { "from": "each", "port": "item", "to": "body" },
                { "from": "each", "port": "out", "to": "join" },
                { "from": "each", "port": "error", "to": "join" },
                { "from": "join", "port": "out", "to": "pause" },
                { "from": "pause", "port": "out", "to": "gate" },
                { "from": "gate", "port": "out", "to": "stop" },
                { "from": "gate", "port": "error", "to": "stop" }
            ]
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
        parked: None,
    };
    let running = Run {
        id: "run-2".to_string().into(),
        trigger: RunTrigger::CatchUp,
        status: RunStatus::Running,
        finished_at: None,
        stop_reason: None,
        worktree_id: None,
        parked: Some(Parked {
            node_id: node_id("pause"),
            iteration: None,
            until: 1_773_050_461_000,
        }),
        ..run.clone()
    };
    let awaiting_approval = Run {
        id: "run-3".to_string().into(),
        parked: Some(Parked {
            node_id: node_id("gate"),
            iteration: Some(1),
            until: 1_773_133_261_000,
        }),
        ..running.clone()
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
            iteration: None,
            wait_until: None,
        },
        Step {
            run_id: run.id.clone(),
            node_id: node_id("post"),
            status: StepStatus::Failed,
            output: None,
            error: Some("secret_missing:HOOK_KEY".into()),
            started_at: Some(1_773_046_859_000),
            finished_at: Some(1_773_046_860_000),
            iteration: None,
            wait_until: None,
        },
        Step {
            run_id: run.id.clone(),
            node_id: node_id("body"),
            status: StepStatus::Succeeded,
            output: Some(json!({ "item": "b", "index": 1 })),
            error: None,
            started_at: Some(1_773_046_860_100),
            finished_at: Some(1_773_046_860_200),
            iteration: Some(1),
            wait_until: None,
        },
        Step {
            run_id: run.id.clone(),
            node_id: node_id("alert"),
            status: StepStatus::Skipped,
            output: None,
            error: None,
            started_at: None,
            finished_at: None,
            iteration: None,
            wait_until: None,
        },
        Step {
            run_id: run.id.clone(),
            node_id: node_id("pause"),
            status: StepStatus::Waiting,
            output: None,
            error: None,
            started_at: Some(1_773_046_861_000),
            finished_at: None,
            iteration: None,
            wait_until: Some(1_773_050_461_000),
        },
        Step {
            run_id: awaiting_approval.id.clone(),
            node_id: node_id("gate"),
            status: StepStatus::Waiting,
            output: Some(json!({ "message": "Ship b?" })),
            error: None,
            started_at: Some(1_773_046_861_000),
            finished_at: None,
            iteration: Some(1),
            wait_until: Some(1_773_133_261_000),
        },
        Step {
            run_id: run.id.clone(),
            node_id: node_id("gate"),
            status: StepStatus::Failed,
            output: Some(json!({ "message": "Ship a?", "decision": "rejected", "decided_at": 1_773_046_900_000_i64 })),
            error: Some("rejected".into()),
            started_at: Some(1_773_046_861_000),
            finished_at: Some(1_773_046_900_000),
            iteration: Some(0),
            wait_until: Some(1_773_133_261_000),
        },
    ];
    let with_tools = super::test_support::apply(
        &automation,
        json!([
            { "op": "add_node", "node": { "id": "issues", "label": "Open issues", "spec": {
                "kind": "mcp_tool", "server_id": "srv-github", "tool": "list_issues",
                "arguments": [{ "name": "state", "value": "open" }], "timeout_ms": 30000 } } },
            { "op": "add_node", "node": { "id": "ping", "label": "Ping", "spec": {
                "kind": "mcp_tool", "server_id": "srv-removed", "tool": "ping" } } }
        ]),
    );
    let server_name = |id: &str| (id == "srv-github").then(|| "GitHub".to_string());
    WireFixture {
        run_policy: run_policy(&with_tools, 1_772_798_400_000, &server_name),
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
            { "op": "add_node", "node": { "id": "lookup", "label": "Lookup", "spec": { "kind": "mcp_tool", "server_id": "srv-github", "tool": "search" } } },
            { "op": "remove_node", "id": "note" },
            { "op": "add_node", "node": { "id": "gate", "label": "Gate", "spec": { "kind": "merge", "mode": "all" } } },
            { "op": "connect", "edge": { "from": "check", "port": "false", "to": "alert" } },
            { "op": "disconnect", "edge": { "from": "check", "port": "false", "to": "alert" } },
            { "op": "set_trigger", "trigger": { "kind": "manual" } },
            { "op": "rename", "name": "Digest" },
            { "op": "set_isolation", "isolation": "worktree_per_run" }
        ])),
        runs: vec![run, running, awaiting_approval],
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
fn an_mcp_tool_node_defaults_its_arguments_and_timeout_and_round_trips() {
    let wire = json!({ "kind": "mcp_tool", "server_id": "srv-1", "tool": "search" });
    let spec: NodeSpec = serde_json::from_value(wire).unwrap();
    assert_eq!(
        spec,
        NodeSpec::McpTool {
            server_id: "srv-1".into(),
            tool: "search".into(),
            arguments: vec![],
            timeout_ms: 60_000,
        }
    );
    let full = NodeSpec::McpTool {
        server_id: "srv-1".into(),
        tool: "search".into(),
        arguments: vec![NamedTemplate {
            name: "query".into(),
            value: Template("{{nodes.fetch.output}}".into()),
        }],
        timeout_ms: 5_000,
    };
    let encoded = serde_json::to_value(&full).unwrap();
    assert_eq!(
        encoded,
        json!({ "kind": "mcp_tool", "server_id": "srv-1", "tool": "search",
                "arguments": [{ "name": "query", "value": "{{nodes.fetch.output}}" }],
                "timeout_ms": 5000 })
    );
    assert_eq!(serde_json::from_value::<NodeSpec>(encoded).unwrap(), full);
    assert_eq!(
        full.templates()
            .into_iter()
            .map(|(field, t)| (field, t.0.clone()))
            .collect::<Vec<_>>(),
        vec![(
            "arguments.query".to_string(),
            "{{nodes.fetch.output}}".to_string()
        )]
    );
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
