//! `mcp_tool` steps against a fake MCP client, through the real engine.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Map, Value};

use super::HttpConfig;
use crate::automation::mcp::test_support::{
    registry, search_tool, server, tool, FakeMcp, SeenCall,
};
use crate::automation::mcp::{McpFailure, ToolResponse};
use crate::automation::model::{Automation, Graph, Run, RunStatus, RunTrigger, StepStatus};
use crate::automation::test_support::{test_engine_with_mcp, MemoryVault, TestEngine};

struct Fixture {
    te: TestEngine,
    fake: Arc<FakeMcp>,
    root: tempfile::TempDir,
}

fn fixture() -> Fixture {
    fixture_with(HttpConfig::default())
}

fn fixture_with(http: HttpConfig) -> Fixture {
    let fake = FakeMcp::new();
    let root = tempfile::tempdir().unwrap();
    let te = test_engine_with_mcp(
        root.path().to_path_buf(),
        Arc::new(MemoryVault::default()),
        http,
        registry(vec![server("srv-1", "files")]),
        fake.clone(),
    );
    Fixture { te, fake, root }
}

fn weather_tool() -> crate::automation::mcp::ToolSchema {
    tool(
        "weather",
        json!({ "type": "object" }),
        Some(
            json!({ "type": "object", "properties": { "temp": { "type": "number" } }, "required": ["temp"] }),
        ),
    )
}

fn call_node(tool: &str, arguments: Value, timeout_ms: u64) -> Value {
    json!({ "id": "call", "label": "Call", "spec": {
        "kind": "mcp_tool", "server_id": "srv-1", "tool": tool,
        "arguments": arguments, "timeout_ms": timeout_ms } })
}

/// trigger -> seed (a transform) -> call, plus `extra` nodes and edges.
fn graph(call: Value, extra_nodes: Value, extra_edges: Value) -> Value {
    let mut nodes = vec![
        json!({ "id": "seed", "label": "Seed", "spec": { "kind": "transform", "fields": [
            { "name": "n", "value": "{{trigger.scheduled_for}}" }] } }),
        call,
    ];
    nodes.extend(extra_nodes.as_array().cloned().unwrap_or_default());
    let mut edges = vec![
        json!({ "from": "trigger", "port": "out", "to": "seed" }),
        json!({ "from": "seed", "port": "out", "to": "call" }),
    ];
    edges.extend(extra_edges.as_array().cloned().unwrap_or_default());
    json!({ "nodes": nodes, "edges": edges })
}

fn manual(te: &TestEngine, graph: Value) -> Automation {
    let mut a = Automation::new("p1".into(), "test".into(), te.engine.now_ms());
    a.graph = serde_json::from_value::<Graph>(graph).unwrap();
    a.approved_revision = Some(a.revision);
    te.store.create(&a, te.engine.now_ms()).unwrap()
}

async fn settled(te: &TestEngine, run: &Run) -> Run {
    for _ in 0..500 {
        let current = te.store.get_run(&run.id).unwrap().unwrap();
        if current.status != RunStatus::Running {
            return current;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("run never settled");
}

async fn run_to_end(te: &TestEngine, a: &Automation) -> Run {
    let run = te.engine.start_run(a, RunTrigger::Manual, 1_000).unwrap();
    settled(te, &run).await
}

/// `(status, output, error)` of one step.
fn step(te: &TestEngine, run: &Run, node: &str) -> (StepStatus, Option<Value>, Option<String>) {
    let step = te
        .store
        .get_steps(&run.id)
        .unwrap()
        .into_iter()
        .find(|s| s.node_id.as_str() == node)
        .unwrap();
    (step.status, step.output, step.error)
}

fn failed(error: &str) -> (StepStatus, Option<Value>, Option<String>) {
    (StepStatus::Failed, None, Some(error.to_string()))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn structured_content_is_the_output_and_arguments_keep_their_json_type() {
    let f = fixture();
    f.fake.lists("files", Ok(vec![weather_tool()]));
    f.fake.answers(
        "weather",
        ToolResponse::Complete {
            structured: Some(json!({ "temp": 21.5 })),
            text: "21.5 C".into(),
            is_error: false,
        },
    );
    let a = manual(
        &f.te,
        graph(
            call_node(
                "weather",
                json!([{ "name": "seed", "value": "{{nodes.seed.output}}" },
                       { "name": "city", "value": "Berlin {{trigger.kind}}" }]),
                5_000,
            ),
            json!([]),
            json!([]),
        ),
    );
    let run = run_to_end(&f.te, &a).await;
    assert_eq!(run.status, RunStatus::Succeeded);
    assert_eq!(
        step(&f.te, &run, "call"),
        (StepStatus::Succeeded, Some(json!({ "temp": 21.5 })), None)
    );
    let mut arguments = Map::new();
    arguments.insert("seed".into(), json!({ "n": 1_000 }));
    arguments.insert("city".into(), json!("Berlin manual"));
    assert_eq!(
        *f.fake.calls.lock(),
        vec![SeenCall {
            server: "files".into(),
            cwd: Some(f.root.path().to_path_buf()),
            tool: "weather".into(),
            arguments,
        }]
    );
}

/// `label(draft: boolean, title: string)`.
fn label_tool() -> crate::automation::mcp::ToolSchema {
    tool(
        "label",
        json!({ "type": "object",
                "properties": { "draft": { "type": "boolean" }, "title": { "type": "string" } } }),
        None,
    )
}

fn label_call(draft: &str) -> Value {
    call_node(
        "label",
        json!([{ "name": "draft", "value": draft }, { "name": "title", "value": "true" }]),
        5_000,
    )
}

fn sent_arguments(fake: &FakeMcp) -> Vec<Value> {
    fake.calls
        .lock()
        .iter()
        .map(|call| Value::Object(call.arguments.clone()))
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_literal_argument_takes_the_type_its_kept_input_schema_declares() {
    let f = fixture();
    f.fake.lists("files", Ok(vec![label_tool()]));
    f.te.engine.mcp().refresh("p1").await;
    let a = manual(&f.te, graph(label_call("true"), json!([]), json!([])));
    let run = run_to_end(&f.te, &a).await;
    assert_eq!(run.status, RunStatus::Succeeded);
    assert_eq!(
        f.fake.list_count(),
        1,
        "the kept listing answers; no second listing"
    );
    assert_eq!(
        sent_arguments(&f.fake),
        vec![json!({ "draft": true, "title": "true" })]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_literal_argument_with_no_kept_listing_is_typed_after_one_listing() {
    let f = fixture();
    f.fake.lists("files", Ok(vec![label_tool()]));
    let a = manual(&f.te, graph(label_call("true"), json!([]), json!([])));
    let run = run_to_end(&f.te, &a).await;
    assert_eq!(run.status, RunStatus::Succeeded);
    assert_eq!(f.fake.list_count(), 1);
    assert_eq!(
        sent_arguments(&f.fake),
        vec![json!({ "draft": true, "title": "true" })]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn arguments_that_all_have_holes_never_list_the_server() {
    let f = fixture();
    f.fake.lists("files", Ok(vec![label_tool()]));
    let a = manual(
        &f.te,
        graph(
            call_node(
                "label",
                json!([{ "name": "draft", "value": "{{nodes.seed.output}}" }]),
                5_000,
            ),
            json!([]),
            json!([]),
        ),
    );
    let run = run_to_end(&f.te, &a).await;
    assert_eq!(run.status, RunStatus::Succeeded);
    assert_eq!(f.fake.list_count(), 0);
    assert_eq!(
        sent_arguments(&f.fake),
        vec![json!({ "draft": { "n": 1_000 } })]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_listing_sends_literal_arguments_as_text_and_the_step_still_runs() {
    let f = fixture();
    f.fake.lists("files", Ok(vec![label_tool()]));
    *f.fake.list_failure.lock() = Some(McpFailure::Unavailable("down".into()));
    let a = manual(&f.te, graph(label_call("true"), json!([]), json!([])));
    let run = run_to_end(&f.te, &a).await;
    assert_eq!(run.status, RunStatus::Succeeded);
    assert_eq!(f.fake.list_count(), 1);
    assert_eq!(
        sent_arguments(&f.fake),
        vec![json!({ "draft": "true", "title": "true" })]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_literal_that_fits_no_declared_type_fails_the_step_before_the_call() {
    let f = fixture();
    f.fake.lists("files", Ok(vec![label_tool()]));
    f.te.engine.mcp().refresh("p1").await;
    let a = manual(&f.te, graph(label_call("maybe"), json!([]), json!([])));
    let run = run_to_end(&f.te, &a).await;
    assert_eq!(run.status, RunStatus::Failed);
    assert_eq!(
        step(&f.te, &run, "call"),
        failed("mcp_argument_invalid: argument draft is not a valid boolean")
    );
    assert_eq!(sent_arguments(&f.fake), Vec::<Value>::new());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_declared_output_schema_requires_matching_structured_content() {
    let f = fixture();
    f.fake.lists("files", Ok(vec![weather_tool()]));
    let a = manual(
        &f.te,
        graph(call_node("weather", json!([]), 5_000), json!([]), json!([])),
    );
    f.fake.answers(
        "weather",
        ToolResponse::Complete {
            structured: None,
            text: "21.5 C".into(),
            is_error: false,
        },
    );
    let missing = run_to_end(&f.te, &a).await;
    assert_eq!(
        step(&f.te, &missing, "call"),
        failed("mcp_structured_content_missing")
    );
    f.fake.answers(
        "weather",
        ToolResponse::Complete {
            structured: Some(json!({ "temp": "warm" })),
            text: String::new(),
            is_error: false,
        },
    );
    let invalid = run_to_end(&f.te, &a).await;
    assert_eq!(
        step(&f.te, &invalid, "call"),
        failed("mcp_output_invalid: $.temp: expected number, got string")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tool_without_structured_content_outputs_its_text() {
    let f = fixture();
    f.fake.lists("files", Ok(vec![search_tool()]));
    f.fake.answers(
        "search",
        ToolResponse::Complete {
            structured: None,
            text: "3 results".into(),
            is_error: false,
        },
    );
    let a = manual(
        &f.te,
        graph(
            call_node("search", json!([{ "name": "query", "value": "x" }]), 5_000),
            json!([]),
            json!([]),
        ),
    );
    let run = run_to_end(&f.te, &a).await;
    assert_eq!(
        step(&f.te, &run, "call"),
        (
            StepStatus::Succeeded,
            Some(json!({ "text": "3 results" })),
            None
        )
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tool_error_follows_the_error_edge_with_its_text() {
    let f = fixture();
    f.fake.lists("files", Ok(vec![search_tool()]));
    f.fake.answers(
        "search",
        ToolResponse::Complete {
            structured: None,
            text: "disk full".into(),
            is_error: true,
        },
    );
    let a = manual(
        &f.te,
        graph(
            call_node("search", json!([]), 5_000),
            json!([{ "id": "handle", "label": "Handle", "spec": { "kind": "transform", "fields": [
                { "name": "why", "value": "{{nodes.call.output.text}}" }] } }]),
            json!([{ "from": "call", "port": "error", "to": "handle" }]),
        ),
    );
    let run = run_to_end(&f.te, &a).await;
    assert_eq!(run.status, RunStatus::Succeeded);
    assert_eq!(
        step(&f.te, &run, "call"),
        (
            StepStatus::Failed,
            Some(json!({ "text": "disk full" })),
            Some("mcp_tool_error: disk full".into())
        )
    );
    assert_eq!(
        step(&f.te, &run, "handle"),
        (
            StepStatus::Succeeded,
            Some(json!({ "why": "disk full" })),
            None
        )
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn input_required_tasks_and_server_failures_fail_the_step_with_their_codes() {
    let f = fixture();
    f.fake.lists(
        "files",
        Ok(vec![
            search_tool(),
            tool("confirm", json!({}), None),
            tool("slow", json!({}), None),
        ]),
    );
    f.fake.answers("confirm", ToolResponse::InputRequired);
    f.fake.answers("slow", ToolResponse::Task);
    let cases = [
        (
            "confirm",
            "mcp_input_required: the tool asked for user input; automation runs cannot answer it",
        ),
        ("slow", "mcp_task_unsupported"),
        ("gone", "mcp_tool_unknown:gone"),
    ];
    for (name, error) in cases {
        let a = manual(
            &f.te,
            graph(call_node(name, json!([]), 5_000), json!([]), json!([])),
        );
        let run = run_to_end(&f.te, &a).await;
        assert_eq!(run.status, RunStatus::Failed, "{name}");
        assert_eq!(run.stop_reason, Some(format!("call: {error}")));
        assert_eq!(step(&f.te, &run, "call"), failed(error));
    }
    f.fake.lists("files", Err(McpFailure::AuthRequired));
    let a = manual(
        &f.te,
        graph(call_node("search", json!([]), 5_000), json!([]), json!([])),
    );
    assert_eq!(
        step(&f.te, &run_to_end(&f.te, &a).await, "call"),
        failed("mcp_auth_required")
    );
    let mut unknown = call_node("search", json!([]), 5_000);
    unknown["spec"]["server_id"] = json!("srv-9");
    let a = manual(&f.te, graph(unknown, json!([]), json!([])));
    assert_eq!(
        step(&f.te, &run_to_end(&f.te, &a).await, "call"),
        failed("mcp_server_unknown:srv-9")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_slow_tool_times_out_and_a_cancel_stops_the_call() {
    let f = fixture();
    f.fake.lists("files", Ok(vec![search_tool()]));
    *f.fake.call_delay.lock() = Some(Duration::from_secs(30));
    let quick = manual(
        &f.te,
        graph(call_node("search", json!([]), 50), json!([]), json!([])),
    );
    let timed_out = run_to_end(&f.te, &quick).await;
    assert_eq!(step(&f.te, &timed_out, "call"), failed("mcp_timeout"));

    let patient = manual(
        &f.te,
        graph(call_node("search", json!([]), 60_000), json!([]), json!([])),
    );
    let run =
        f.te.engine
            .start_run(&patient, RunTrigger::Manual, 1_000)
            .unwrap();
    for _ in 0..200 {
        if f.fake.calls.lock().len() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(f.te.engine.cancel_run(&run.id));
    let cancelled = settled(&f.te, &run).await;
    assert_eq!(cancelled.status, RunStatus::Cancelled);
    assert_eq!(step(&f.te, &cancelled, "call"), failed("cancelled"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn structured_output_over_the_cap_fails_the_step() {
    let f = fixture_with(HttpConfig {
        body_cap: 16,
        ..HttpConfig::default()
    });
    f.fake
        .lists("files", Ok(vec![tool("dump", json!({ "type": "object" }), None)]));
    f.fake.answers(
        "dump",
        ToolResponse::Complete {
            structured: Some(json!({ "note": "0123456789abcdef" })),
            text: String::new(),
            is_error: false,
        },
    );
    let a = manual(&f.te, graph(call_node("dump", json!([]), 5_000), json!([]), json!([])));
    let run = run_to_end(&f.te, &a).await;
    assert_eq!(run.status, RunStatus::Failed);
    assert_eq!(
        step(&f.te, &run, "call"),
        failed("mcp_output_too_large: structured output is 27 bytes, over the 16 byte cap")
    );
}
