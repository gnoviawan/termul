//! Runs against a local axum server (reached through DNS overrides, so URLs
//! carry real-looking hosts) and a scripted python ACP agent spawned through
//! the real manager. Agent tests follow `acp/oneshot_tests.rs`: a missing
//! python fails loudly unless `TERMUL_SKIP_REAL_LOOP_TESTS=1`.

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use parking_lot::Mutex;
use serde_json::{json, Value};

use super::agent::extract_json;
use super::{HttpConfig, OVERLAP_REASON};
use crate::acp::config::AgentConfig;
use crate::acp::manager::real_loop_tests::{find_python, SKIP_ENV, TIMEOUT_TEST_LOCK};
use crate::automation::model::{
    Automation, AutomationId, Graph, Run, RunId, RunStatus, RunTrigger, StepStatus, Trigger,
};
use crate::automation::store::AutomationStore;
use crate::automation::test_support::{test_engine, MemoryVault, TestEngine};

const API_KEY: &str = "sk-live-123";

#[derive(Clone, Default)]
struct Seen {
    posts: Arc<Mutex<Vec<(String, Value)>>>,
    stolen: Arc<Mutex<u32>>,
}

async fn items(headers: HeaderMap) -> impl IntoResponse {
    let auth = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    if auth != Some("Bearer sk-live-123") {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "auth" })));
    }
    (
        StatusCode::OK,
        Json(json!({ "source": "feed", "items": ["a", "b"] })),
    )
}

async fn echo(headers: HeaderMap) -> Json<Value> {
    let auth = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    Json(json!({ "you_sent": auth }))
}

async fn collect(
    State(seen): State<Seen>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> StatusCode {
    let key = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    seen.posts.lock().push((key, body));
    StatusCode::CREATED
}

/// Serves `api.test` and `evil.test` from one local listener.
async fn serve() -> (HttpConfig, Seen) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr: SocketAddr = listener.local_addr().unwrap();
    let off_list = format!("http://evil.test:{}/steal", addr.port());
    let seen = Seen::default();
    let app = Router::new()
        .route("/items", get(items))
        .route("/echo", get(echo))
        .route(
            "/fail",
            get(|| async {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": "boom" })),
                )
            }),
        )
        .route(
            "/redirect-out",
            get(move || async move { (StatusCode::FOUND, [(header::LOCATION, off_list)]) }),
        )
        .route(
            "/redirect-in",
            get(|| async { (StatusCode::FOUND, [(header::LOCATION, "/items")]) }),
        )
        .route(
            "/steal",
            get(|State(seen): State<Seen>| async move {
                *seen.stolen.lock() += 1;
                "gotcha"
            }),
        )
        .route("/collect", post(collect))
        .with_state(seen.clone());
    tokio::spawn(async move { axum::serve(listener, app).await });
    let config = HttpConfig {
        resolve: vec![
            ("api.test".to_string(), addr),
            ("evil.test".to_string(), addr),
        ],
        ..HttpConfig::default()
    };
    (config, seen)
}

fn url(path: &str, config: &HttpConfig) -> String {
    format!("http://api.test:{}{path}", config.resolve[0].1.port())
}

struct Fixture {
    te: TestEngine,
    http: HttpConfig,
    seen: Seen,
    root: tempfile::TempDir,
}

async fn fixture() -> Fixture {
    let (http, seen) = serve().await;
    let root = tempfile::tempdir().unwrap();
    let vault = Arc::new(MemoryVault::default());
    let te = test_engine(root.path().to_path_buf(), vault, http.clone());
    te.secrets.set("p1", "API_KEY", API_KEY).unwrap();
    Fixture {
        te,
        http,
        seen,
        root,
    }
}

/// An approved automation in project `p1`, stored as of the fake clock.
fn approved(te: &TestEngine, graph: Value, trigger: Value) -> Automation {
    let mut a = Automation::new("p1".into(), "test".into(), te.engine.now_ms());
    a.graph = serde_json::from_value::<Graph>(graph).unwrap();
    a.trigger = serde_json::from_value::<Trigger>(trigger).unwrap();
    a.approved_revision = Some(a.revision);
    te.store.create(&a, te.engine.now_ms()).unwrap()
}

fn manual(te: &TestEngine, graph: Value) -> Automation {
    approved(te, graph, json!({ "kind": "manual" }))
}

async fn run_to_end(te: &TestEngine, a: &Automation) -> Run {
    let run = te.engine.start_run(a, RunTrigger::Manual, 1_000).unwrap();
    settled(&te.store, &run.id).await
}

async fn settled(store: &AutomationStore, id: &RunId) -> Run {
    for _ in 0..1500 {
        let run = store.get_run(id).unwrap().unwrap();
        if run.status != RunStatus::Running {
            return run;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("run {id} never settled");
}

/// `node -> (status, error)` for every step of the run.
fn steps(store: &AutomationStore, id: &RunId) -> BTreeMap<String, (StepStatus, Option<String>)> {
    store
        .get_steps(id)
        .unwrap()
        .into_iter()
        .map(|s| (s.node_id.to_string(), (s.status, s.error)))
        .collect()
}

fn output(store: &AutomationStore, id: &RunId, node: &str) -> Option<Value> {
    store
        .get_steps(id)
        .unwrap()
        .into_iter()
        .find(|s| s.node_id.as_str() == node)
        .and_then(|s| s.output)
}

fn ok(error: Option<&str>) -> (StepStatus, Option<String>) {
    let status = if error.is_some() {
        StepStatus::Failed
    } else {
        StepStatus::Succeeded
    };
    (status, error.map(str::to_string))
}

const SKIPPED: (StepStatus, Option<String>) = (StepStatus::Skipped, None);

fn http_get(url: &str) -> Value {
    json!({ "kind": "http", "method": "GET", "url": url, "allowed_hosts": ["api.test"],
            "headers": [{ "name": "Authorization", "value": "Bearer {{secrets.API_KEY}}" }] })
}

fn node(id: &str, spec: Value) -> Value {
    json!({ "id": id, "label": id, "spec": spec })
}

fn edge(from: &str, port: &str, to: &str) -> Value {
    json!({ "from": from, "port": port, "to": to })
}

fn transform(fields: Value) -> Value {
    json!({ "kind": "transform", "fields": fields })
}

const MOCK_AGENT: &str = r#"
import json, os, sys

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def say(text):
    send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s1",
          "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}}})

mode, hung = None, None
for line in sys.stdin:
    msg = json.loads(line)
    method, rid = msg.get("method"), msg.get("id")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": rid, "result": {
            "protocolVersion": 1, "agentCapabilities": {}, "authMethods": []}})
    elif method == "session/new":
        send({"jsonrpc": "2.0", "id": rid, "result": {"sessionId": "s1"}})
    elif method == "session/prompt":
        text = msg["params"]["prompt"][0]["text"]
        with open(os.environ["PROMPT_LOG"], "a") as f:
            f.write(json.dumps(text) + "\n")
        retry = text.startswith("Your answer did not match")
        if not retry:
            mode = text.split()[0]
        if mode == "MODE=hang":
            hung = rid
            continue
        if mode == "MODE=ok" or (mode == "MODE=fix" and retry):
            say('Here it is:\n```json\n{"headline": "two items", "count": 2}\n```')
        elif mode == "MODE=fix":
            say('{"headline": 5, "count": 2}')
        else:
            say("I cannot answer in JSON.")
        send({"jsonrpc": "2.0", "id": rid, "result": {"stopReason": "end_turn"}})
    elif method == "session/cancel" and hung is not None:
        send({"jsonrpc": "2.0", "id": hung, "result": {"stopReason": "cancelled"}})
        hung = None
"#;

struct MockAgent {
    dir: tempfile::TempDir,
    // Real-loop tests set a process-wide idle timeout; never overlap them.
    _serial: tokio::sync::MutexGuard<'static, ()>,
}

impl MockAgent {
    /// Registers the scripted agent as `mock`.
    async fn install(te: &TestEngine) -> Option<Self> {
        let Some(python) = find_python() else {
            if std::env::var(SKIP_ENV).as_deref() == Ok("1") {
                eprintln!("SKIP automation agent tests: no python ({SKIP_ENV}=1)");
                return None;
            }
            panic!("automation agent tests need `python3` on PATH, or {SKIP_ENV}=1 to skip");
        };
        let serial = TIMEOUT_TEST_LOCK.lock().await;
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("agent.py");
        std::fs::write(&script, MOCK_AGENT).unwrap();
        te.agents.record(&AgentConfig {
            config_id: Some("mock".to_string()),
            name: "Mock".to_string(),
            command: python.to_string(),
            args: vec!["-u".to_string(), script.to_string_lossy().into_owned()],
            env: [(
                "PROMPT_LOG".to_string(),
                dir.path()
                    .join("prompts.log")
                    .to_string_lossy()
                    .into_owned(),
            )]
            .into(),
            allow_terminal: false,
        });
        Some(Self {
            dir,
            _serial: serial,
        })
    }

    fn prompts(&self) -> Vec<String> {
        std::fs::read_to_string(self.dir.path().join("prompts.log"))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }
}

fn agent(prompt: &str, max_attempts: u8) -> Value {
    json!({ "kind": "agent", "agent_id": "mock", "prompt": prompt,
            "output_schema": { "type": "object",
                "properties": { "headline": { "type": "string" }, "count": { "type": "integer" } },
                "required": ["headline", "count"] },
            "timeout_ms": 30_000, "max_attempts": max_attempts })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fetch_extract_shape_and_post_delivers_the_expected_body() {
    let f = fixture().await;
    let Some(mock) = MockAgent::install(&f.te).await else {
        return;
    };
    let a = manual(
        &f.te,
        json!({
            "nodes": [
                node("fetch", http_get(&url("/redirect-in", &f.http))),
                node("extract", agent("MODE=ok Summarize {{nodes.fetch.output.body.items}}", 2)),
                node("shape", transform(json!([
                    { "name": "text", "value": "{{nodes.extract.output.headline}}" },
                    { "name": "count", "value": "{{nodes.extract.output.count}}" },
                    { "name": "source", "value": "{{nodes.fetch.output.body.source}}" }
                ]))),
                node("post", json!({ "kind": "http", "method": "POST", "url": url("/collect", &f.http),
                    "body": "{{nodes.shape.output}}", "allowed_hosts": ["api.test"] }))
            ],
            "edges": [edge("trigger", "out", "fetch"), edge("fetch", "out", "extract"),
                      edge("extract", "out", "shape"), edge("shape", "out", "post")]
        }),
    );

    let run = run_to_end(&f.te, &a).await;

    assert_eq!(
        (run.status, run.stop_reason.as_deref()),
        (RunStatus::Succeeded, None)
    );
    assert_eq!(
        *f.seen.posts.lock(),
        vec![(
            format!("{}:post", run.id),
            json!({ "text": "two items", "count": 2, "source": "feed" })
        )]
    );
    assert_eq!(
        output(&f.te.store, &run.id, "extract"),
        Some(json!({ "headline": "two items", "count": 2 }))
    );
    let prompts = mock.prompts();
    assert_eq!(prompts.len(), 1);
    assert!(prompts[0].starts_with(
        "MODE=ok Summarize [\"a\",\"b\"]\n\nAnswer with exactly one JSON value that matches this JSON Schema"
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failure_follows_its_error_edge_and_the_run_succeeds() {
    let f = fixture().await;
    let a = manual(
        &f.te,
        json!({
            "nodes": [
                node("fetch", http_get(&url("/fail", &f.http))),
                node("next", transform(json!([]))),
                node("handled", transform(json!([{ "name": "status", "value": "{{nodes.fetch.output.status}}" }])))
            ],
            "edges": [edge("trigger", "out", "fetch"), edge("fetch", "out", "next"),
                      edge("fetch", "error", "handled")]
        }),
    );

    let run = run_to_end(&f.te, &a).await;

    assert_eq!(run.status, RunStatus::Succeeded);
    assert_eq!(
        steps(&f.te.store, &run.id),
        BTreeMap::from([
            ("fetch".to_string(), ok(Some("http_status:500"))),
            ("handled".to_string(), ok(None)),
            ("next".to_string(), SKIPPED),
        ])
    );
    assert_eq!(
        output(&f.te.store, &run.id, "handled"),
        Some(json!({ "status": 500 }))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failure_without_an_error_edge_fails_the_run_and_skips_the_rest() {
    let f = fixture().await;
    let a = manual(
        &f.te,
        json!({
            "nodes": [node("fetch", http_get(&url("/fail", &f.http))), node("next", transform(json!([])))],
            "edges": [edge("trigger", "out", "fetch"), edge("fetch", "out", "next")]
        }),
    );

    let run = run_to_end(&f.te, &a).await;

    assert_eq!(
        (run.status, run.stop_reason.as_deref()),
        (RunStatus::Failed, Some("fetch: http_status:500"))
    );
    assert_eq!(
        steps(&f.te.store, &run.id),
        BTreeMap::from([
            ("fetch".to_string(), ok(Some("http_status:500"))),
            ("next".to_string(), SKIPPED),
        ])
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_condition_takes_the_true_or_the_false_branch() {
    let f = fixture().await;
    for (n, taken, not_taken) in [("5", "big", "small"), ("1", "small", "big")] {
        let a = manual(
            &f.te,
            json!({
                "nodes": [
                    node("src", transform(json!([{ "name": "n", "value": n }]))),
                    node("check", json!({ "kind": "condition", "left": "{{nodes.src.output.n}}", "op": "gt", "right": "3" })),
                    node("big", transform(json!([]))),
                    node("small", transform(json!([])))
                ],
                "edges": [edge("trigger", "out", "src"), edge("src", "out", "check"),
                          edge("check", "true", "big"), edge("check", "false", "small")]
            }),
        );

        let run = run_to_end(&f.te, &a).await;

        let steps = steps(&f.te.store, &run.id);
        assert_eq!(run.status, RunStatus::Succeeded);
        assert_eq!(steps[taken], ok(None), "n={n}");
        assert_eq!(steps[not_taken], SKIPPED, "n={n}");
        assert_eq!(
            output(&f.te.store, &run.id, "check"),
            Some(json!({ "result": n == "5" }))
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_schema_mismatch_is_reprompted_with_the_errors_and_then_accepted() {
    let f = fixture().await;
    let Some(mock) = MockAgent::install(&f.te).await else {
        return;
    };
    let a = manual(
        &f.te,
        json!({
            "nodes": [node("extract", agent("MODE=fix go", 2))],
            "edges": [edge("trigger", "out", "extract")]
        }),
    );

    let run = run_to_end(&f.te, &a).await;

    assert_eq!(run.status, RunStatus::Succeeded);
    assert_eq!(
        output(&f.te.store, &run.id, "extract"),
        Some(json!({ "headline": "two items", "count": 2 }))
    );
    let prompts = mock.prompts();
    assert_eq!(prompts.len(), 2);
    assert_eq!(
        prompts[1],
        "Your answer did not match the JSON Schema:\n- $.headline: expected string, got number\nAnswer again with only the corrected JSON value."
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exhausted_attempts_fail_the_step() {
    let f = fixture().await;
    let Some(mock) = MockAgent::install(&f.te).await else {
        return;
    };
    let a = manual(
        &f.te,
        json!({
            "nodes": [node("extract", agent("MODE=bad go", 2))],
            "edges": [edge("trigger", "out", "extract")]
        }),
    );

    let run = run_to_end(&f.te, &a).await;

    assert_eq!(
        steps(&f.te.store, &run.id)["extract"],
        ok(Some(
            "agent_output_invalid: the reply contains no JSON value"
        ))
    );
    assert_eq!(run.status, RunStatus::Failed);
    assert_eq!(mock.prompts().len(), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_agent_this_host_never_spawned_fails_the_step() {
    let f = fixture().await;
    let a = manual(
        &f.te,
        json!({
            "nodes": [node("extract", agent("MODE=ok", 1))],
            "edges": [edge("trigger", "out", "extract")]
        }),
    );

    let run = run_to_end(&f.te, &a).await;

    assert_eq!(
        steps(&f.te.store, &run.id)["extract"],
        ok(Some("agent_unknown"))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_redirect_off_the_allowlist_fails_without_reaching_it() {
    let f = fixture().await;
    let a = manual(
        &f.te,
        json!({
            "nodes": [node("fetch", http_get(&url("/redirect-out", &f.http)))],
            "edges": [edge("trigger", "out", "fetch")]
        }),
    );

    let run = run_to_end(&f.te, &a).await;

    assert_eq!(
        steps(&f.te.store, &run.id)["fetch"],
        ok(Some("redirect_blocked:evil.test"))
    );
    assert_eq!(*f.seen.stolen.lock(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn secret_values_never_reach_step_output_and_a_missing_one_fails_closed() {
    let f = fixture().await;
    let a = manual(
        &f.te,
        json!({
            "nodes": [node("fetch", http_get(&url("/echo", &f.http)))],
            "edges": [edge("trigger", "out", "fetch")]
        }),
    );

    let run = run_to_end(&f.te, &a).await;

    let body = output(&f.te.store, &run.id, "fetch").unwrap()["body"].clone();
    assert_eq!(body, json!({ "you_sent": "Bearer [redacted]" }));
    let stored = serde_json::to_string(&f.te.store.get_steps(&run.id).unwrap()).unwrap();
    assert!(!stored.contains(API_KEY));

    let missing = manual(
        &f.te,
        json!({
            "nodes": [node("fetch", json!({ "kind": "http", "method": "GET", "url": url("/echo", &f.http),
                "allowed_hosts": ["api.test"],
                "headers": [{ "name": "X-Key", "value": "{{secrets.NOT_SET}}" }] }))],
            "edges": [edge("trigger", "out", "fetch")]
        }),
    );
    let run = run_to_end(&f.te, &missing).await;
    assert_eq!(
        steps(&f.te.store, &run.id)["fetch"],
        ok(Some("secret_missing:NOT_SET"))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_mid_agent_cancels_the_run() {
    let f = fixture().await;
    let Some(mock) = MockAgent::install(&f.te).await else {
        return;
    };
    let a = manual(
        &f.te,
        json!({
            "nodes": [node("extract", agent("MODE=hang", 1)), node("after", transform(json!([])))],
            "edges": [edge("trigger", "out", "extract"), edge("extract", "out", "after")]
        }),
    );
    let run =
        f.te.engine
            .start_run(&a, RunTrigger::Manual, 1_000)
            .unwrap();
    for _ in 0..1500 {
        if !mock.prompts().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    assert!(f.te.engine.cancel_run(&run.id));
    let run = settled(&f.te.store, &run.id).await;

    assert_eq!(
        (run.status, run.stop_reason.as_deref()),
        (RunStatus::Cancelled, Some("cancelled"))
    );
    assert_eq!(
        steps(&f.te.store, &run.id),
        BTreeMap::from([
            ("extract".to_string(), ok(Some("cancelled"))),
            ("after".to_string(), SKIPPED),
        ])
    );
    assert!(!f.te.engine.cancel_run(&run.id));
}

fn every_10s(te: &TestEngine, graph: Value) -> Automation {
    approved(
        te,
        graph,
        json!({ "kind": "schedule", "schedule": { "kind": "every", "every_ms": 10_000, "anchor_ms": 0 } }),
    )
}

fn single(spec: Value) -> Value {
    json!({ "nodes": [node("only", spec)], "edges": [edge("trigger", "out", "only")] })
}

fn running_row(a: &Automation) -> Run {
    Run {
        id: RunId::generate(),
        automation_id: a.id.clone(),
        revision: a.revision,
        graph: a.graph.clone(),
        trigger: RunTrigger::Scheduled,
        scheduled_for: 0,
        status: RunStatus::Running,
        started_at: 0,
        finished_at: None,
        stop_reason: None,
        summary: None,
        conversation_id: None,
        worktree_id: None,
    }
}

fn runs(store: &AutomationStore, id: &AutomationId) -> Vec<Run> {
    store.list_runs(id, 50).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_due_slot_while_a_run_is_in_flight_is_recorded_skipped() {
    let f = fixture().await;
    let a = every_10s(&f.te, single(transform(json!([]))));
    let in_flight = running_row(&a);
    f.te.store.insert_run(&in_flight).unwrap();

    f.te.clock.set(10_000);
    f.te.engine.tick();

    let latest = runs(&f.te.store, &a.id);
    assert_eq!(latest.len(), 2);
    let skipped = latest.iter().find(|r| r.id != in_flight.id).unwrap();
    assert_eq!(
        (
            skipped.status,
            skipped.trigger,
            skipped.scheduled_for,
            skipped.stop_reason.as_deref()
        ),
        (
            RunStatus::Skipped,
            RunTrigger::Scheduled,
            10_000,
            Some(OVERLAP_REASON)
        )
    );
    assert_eq!(
        f.te.store.get(&a.id).unwrap().unwrap().next_run_at,
        Some(20_000)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn boot_settles_stranded_runs_and_fires_one_catch_up() {
    let f = fixture().await;
    let a = every_10s(&f.te, single(transform(json!([]))));
    let stranded = running_row(&a);
    f.te.store.insert_run(&stranded).unwrap();

    f.te.clock.set(95_000);
    f.te.engine.boot();

    let stranded = f.te.store.get_run(&stranded.id).unwrap().unwrap();
    assert_eq!(
        (stranded.status, stranded.stop_reason.as_deref()),
        (RunStatus::Failed, Some("stranded"))
    );
    let fired: Vec<Run> = runs(&f.te.store, &a.id)
        .into_iter()
        .filter(|r| r.id != stranded.id)
        .collect();
    assert_eq!(fired.len(), 1);
    assert_eq!(
        (fired[0].trigger, fired[0].scheduled_for),
        (RunTrigger::CatchUp, 10_000)
    );
    assert_eq!(
        settled(&f.te.store, &fired[0].id).await.status,
        RunStatus::Succeeded
    );
    assert_eq!(
        f.te.store.get(&a.id).unwrap().unwrap().next_run_at,
        Some(100_000)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_scheduled_run_backs_off_the_next_slot() {
    let f = fixture().await;
    let a = every_10s(
        &f.te,
        single(json!({ "kind": "fail", "message": "boom {{trigger.kind}}" })),
    );

    f.te.clock.set(10_000);
    f.te.engine.tick();
    let run = settled(&f.te.store, &runs(&f.te.store, &a.id)[0].id).await;

    assert_eq!(
        (run.status, run.stop_reason.as_deref()),
        (RunStatus::Failed, Some("boom scheduled"))
    );
    let after = f.te.store.get(&a.id).unwrap().unwrap();
    assert_eq!(
        (
            after.consecutive_errors,
            after.unseen_failures,
            after.next_run_at
        ),
        (1, 1, Some(40_000))
    );
}

#[test]
fn extract_json_takes_the_whole_reply_then_a_fence_then_the_first_value() {
    assert_eq!(extract_json(" [1, 2] "), Some(json!([1, 2])));
    assert_eq!(extract_json("\"plain\""), Some(json!("plain")));
    assert_eq!(
        extract_json("Sure:\n```json\n{\"a\": 1}\n```\nand {\"b\": 2}"),
        Some(json!({ "a": 1 }))
    );
    assert_eq!(
        extract_json("The answer is {\"a\": [1]} as asked."),
        Some(json!({ "a": [1] }))
    );
    assert_eq!(extract_json("no braces {here"), None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_worktree_per_run_runs_in_a_fresh_worktree_that_is_removed_after() {
    let f = fixture().await;
    let repo = f.root.path();
    let git = |args: &[&str]| {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(repo)
            .output()
            .unwrap();
        assert!(status.status.success(), "git {args:?}: {status:?}");
        String::from_utf8(status.stdout).unwrap()
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
    let mut a = manual(&f.te, single(transform(json!([]))));
    a.isolation = crate::automation::model::Isolation::WorktreePerRun;

    let run = run_to_end(&f.te, &a).await;

    assert_eq!(run.status, RunStatus::Succeeded);
    let name = run.worktree_id.clone().unwrap();
    assert_eq!(name, format!("automation-{}", &run.id.as_str()[..8]));
    assert!(!repo.join(".termul/worktrees").join(&name).exists());
    assert_eq!(git(&["branch", "--list", "automation/*"]), "");
}
