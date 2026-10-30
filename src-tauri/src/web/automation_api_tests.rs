use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{Method, Request};
use serde_json::{json, Value};
use tower::ServiceExt;

use super::*;
use crate::automation::engine::HttpConfig;
use crate::automation::test_support::{
    no_history, test_engine, weekday_asks, MemoryVault, FRIDAY_MS,
};
use crate::web::watch::WatchKind;
use crate::web::ws::{outbound_channel, Outbound};

const LOOPBACK: &str = "127.0.0.1:50000";
const LAN: &str = "192.168.1.9:50000";
const OPEN: WriteFlags = WriteFlags {
    allow_remote_writes: false,
    shared_live_writes_denied: false,
};

fn service_with(vault: MemoryVault) -> Arc<AutomationService> {
    let te = test_engine(std::env::temp_dir(), Arc::new(vault), HttpConfig::default());
    Arc::new(AutomationService::new(te.engine, no_history()))
}

fn service() -> Arc<AutomationService> {
    service_with(MemoryVault::default())
}

fn router_for(
    service: Option<Arc<AutomationService>>,
    token_gated: bool,
    peer: &str,
    write_flags: WriteFlags,
) -> Router {
    let peer: SocketAddr = peer.parse().unwrap();
    automation_router::<()>(AutomationRouteState {
        service,
        token_gated,
        write_flags,
    })
    .layer(MockConnectInfo(peer))
}

/// A loopback client of an ungated host.
fn router(service: &Arc<AutomationService>) -> Router {
    router_for(Some(service.clone()), false, LOOPBACK, OPEN)
}

async fn send(app: Router, method: Method, uri: &str, body: Option<Value>) -> (u16, Value) {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    let status = response.status().as_u16();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn ok(data: Value) -> (u16, Value) {
    (200, json!({ "success": true, "data": data }))
}

fn transform_graph() -> Value {
    json!([
        { "op": "add_node", "node": { "id": "shape", "label": "Shape",
          "spec": { "kind": "transform", "fields": [{ "name": "greeting", "value": "hello" }] } } },
        { "op": "connect", "edge": { "from": "trigger", "port": "out", "to": "shape" } }
    ])
}

fn automation_json(id: &str, revision: u64, approved: Option<u64>, graph: Value) -> Value {
    json!({
        "id": id, "project_id": "p1", "name": "Digest",
        "revision": revision, "approved_revision": approved, "enabled": true,
        "trigger": { "kind": "manual" }, "graph": graph,
        "isolation": "shared_in_root", "next_run_at": null,
        "consecutive_errors": 0, "schedule_error_count": 0, "unseen_failures": 0,
        "last_run": null, "created_at": 1000, "updated_at": 1000, "deleted_at": null
    })
}

fn shaped_graph() -> Value {
    json!({
        "nodes": [{ "id": "shape", "label": "Shape",
            "spec": { "kind": "transform", "fields": [{ "name": "greeting", "value": "hello" }] } }],
        "edges": [{ "from": "trigger", "port": "out", "to": "shape" }]
    })
}

async fn create(app: &Router) -> String {
    let (_, body) = send(
        app.clone(),
        Method::POST,
        "/api/automations",
        Some(json!({ "project_id": "p1", "name": "Digest" })),
    )
    .await;
    body["data"]["id"].as_str().unwrap().to_string()
}

async fn wait_settled(app: &Router, id: &str) -> Value {
    let uri = format!("/api/automations/{id}/runs?limit=5");
    for _ in 0..200 {
        let (_, body) = send(app.clone(), Method::GET, &uri, None).await;
        if body["data"][0]["status"] != "running" {
            return body;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the run never settled");
}

#[tokio::test]
async fn an_automation_is_built_approved_and_run_over_its_routes() {
    let service = service();
    let app = router(&service);

    let (status, created) = send(
        app.clone(),
        Method::POST,
        "/api/automations",
        Some(json!({ "project_id": "p1", "name": "Digest" })),
    )
    .await;
    let id = created["data"]["id"].as_str().unwrap().to_string();
    let empty = json!({ "nodes": [], "edges": [] });
    assert_eq!(
        (status, created),
        ok(automation_json(&id, 1, None, empty.clone()))
    );

    assert_eq!(
        send(
            app.clone(),
            Method::GET,
            "/api/automations?project_id=p1",
            None
        )
        .await,
        ok(json!([automation_json(&id, 1, None, empty)]))
    );

    let applied = send(
        app.clone(),
        Method::POST,
        &format!("/api/automations/{id}/ops"),
        Some(json!({ "base_revision": 1, "ops": transform_graph() })),
    )
    .await;
    assert_eq!(
        applied,
        ok(json!({ "automation": automation_json(&id, 2, None, shaped_graph()), "issues": [] }))
    );

    assert_eq!(
        send(
            app.clone(),
            Method::GET,
            &format!("/api/automations/{id}"),
            None
        )
        .await,
        ok(json!({
            "automation": automation_json(&id, 2, None, shaped_graph()),
            "issues": [],
            "policy": {
                "trigger_summary": "manual only", "next_runs": [], "agents": [],
                "secrets": [], "outbound_hosts": [], "untrusted_flow": false,
                "failure_policy": "backoff 30s/1m/5m/15m/60m"
            }
        }))
    );

    assert_eq!(
        send(
            app.clone(),
            Method::POST,
            &format!("/api/automations/{id}/approve"),
            Some(json!({ "revision": 2 })),
        )
        .await,
        ok(automation_json(&id, 2, Some(2), shaped_graph()))
    );

    let (status, run) = send(
        app.clone(),
        Method::POST,
        &format!("/api/automations/{id}/run"),
        Some(json!({})),
    )
    .await;
    let run_id = run["data"]["id"].as_str().unwrap().to_string();
    let run_json = |status: &str, finished_at: Value| {
        json!({
            "id": run_id, "automation_id": id, "revision": 2, "graph": shaped_graph(),
            "trigger": "manual", "scheduled_for": 1000, "status": status,
            "started_at": 1000, "finished_at": finished_at, "stop_reason": null,
            "summary": null, "conversation_id": null, "worktree_id": null
        })
    };
    assert_eq!((status, run), ok(run_json("running", Value::Null)));

    assert_eq!(
        (200, wait_settled(&app, &id).await),
        ok(json!([run_json("succeeded", json!(1000))])),
        "a trigger-to-transform graph succeeds"
    );

    assert_eq!(
        send(
            app.clone(),
            Method::GET,
            &format!("/api/automation-runs/{run_id}/steps"),
            None
        )
        .await,
        ok(json!([{
            "run_id": run_id, "node_id": "shape", "status": "succeeded",
            "output": { "greeting": "hello" }, "error": null,
            "started_at": 1000, "finished_at": 1000
        }]))
    );

    assert_eq!(
        send(
            app.clone(),
            Method::POST,
            &format!("/api/automation-runs/{run_id}/cancel"),
            Some(json!({})),
        )
        .await,
        ok(json!(false)),
        "a settled run is not in flight"
    );

    assert_eq!(
        send(
            app.clone(),
            Method::POST,
            &format!("/api/automations/{id}/seen"),
            Some(json!({})),
        )
        .await,
        ok(Value::Null)
    );

    let (status, disabled) = send(
        app.clone(),
        Method::POST,
        &format!("/api/automations/{id}/enabled"),
        Some(json!({ "enabled": false })),
    )
    .await;
    assert_eq!((status, &disabled["data"]["enabled"]), (200, &json!(false)));

    assert_eq!(
        send(
            app.clone(),
            Method::DELETE,
            &format!("/api/automations/{id}"),
            None
        )
        .await,
        ok(Value::Null)
    );
    assert_eq!(
        send(
            app.clone(),
            Method::GET,
            "/api/automations?project_id=p1",
            None
        )
        .await,
        ok(json!([]))
    );
}

#[tokio::test]
async fn secrets_agents_and_schedule_previews_answer_over_their_routes() {
    let service = service();
    let app = router(&service);

    assert_eq!(
        send(
            app.clone(),
            Method::PUT,
            "/api/automation-secrets",
            Some(json!({ "project_id": "p1", "name": "API_KEY", "value": "sk-1" })),
        )
        .await,
        ok(Value::Null)
    );
    assert_eq!(
        send(
            app.clone(),
            Method::GET,
            "/api/automation-secrets?project_id=p1",
            None
        )
        .await,
        ok(json!(["API_KEY"]))
    );
    assert_eq!(
        send(
            app.clone(),
            Method::DELETE,
            "/api/automation-secrets?project_id=p1&name=API_KEY",
            None
        )
        .await,
        ok(Value::Null)
    );
    assert_eq!(
        send(
            app.clone(),
            Method::GET,
            "/api/automation-secrets?project_id=p1",
            None
        )
        .await,
        ok(json!([]))
    );

    assert_eq!(
        send(app.clone(), Method::GET, "/api/automation-agents", None).await,
        ok(json!([]))
    );

    let preview = |schedule: Value| {
        send(
            app.clone(),
            Method::POST,
            "/api/automations/preview-schedule",
            Some(json!({ "schedule": schedule })),
        )
    };
    assert_eq!(
        preview(json!({ "kind": "every", "every_ms": 60_000, "anchor_ms": 0 })).await,
        ok(json!({ "next_runs": [60_000, 120_000, 180_000], "error": null }))
    );
    let (status, bad) = preview(json!({ "kind": "cron", "expr": "nope", "timezone": "UTC" })).await;
    assert_eq!(
        (
            status,
            &bad["data"]["next_runs"],
            bad["data"]["error"].is_string()
        ),
        (200, &json!([]), true),
        "an invalid schedule is an answer with its reason: {bad}"
    );
}

#[tokio::test]
async fn service_errors_map_to_http_statuses() {
    let service = service();
    let app = router(&service);
    let id = create(&app).await;

    assert_eq!(
        send(app.clone(), Method::GET, "/api/automations/missing", None).await,
        (
            404,
            json!({ "success": false, "code": "not_found", "error": "missing not found" })
        )
    );

    let ops_uri = format!("/api/automations/{id}/ops");
    send(
        app.clone(),
        Method::POST,
        &ops_uri,
        Some(json!({ "base_revision": 1, "ops": transform_graph() })),
    )
    .await;
    assert_eq!(
        send(
            app.clone(),
            Method::POST,
            &ops_uri,
            Some(json!({ "base_revision": 1, "ops": transform_graph() })),
        )
        .await,
        (
            409,
            json!({
                "success": false, "code": "revision_conflict", "current_revision": 2,
                "error": "revision conflict: the automation is at revision 2"
            })
        )
    );

    assert_eq!(
        send(
            app.clone(),
            Method::POST,
            &format!("/api/automations/{id}/run"),
            Some(json!({}))
        )
        .await,
        (
            409,
            json!({
                "success": false, "code": "not_approved",
                "error": "approve the current revision before running it"
            })
        )
    );

    send(
        app.clone(),
        Method::POST,
        &ops_uri,
        Some(json!({ "base_revision": 2, "ops": [{ "op": "remove_node", "id": "shape" }] })),
    )
    .await;
    let (status, refused) = send(
        app.clone(),
        Method::POST,
        &format!("/api/automations/{id}/approve"),
        Some(json!({ "revision": 3 })),
    )
    .await;
    assert_eq!(
        (status, &refused["code"], &refused["error"]),
        (422, &json!("has_issues"), &json!("1 open issue(s)"))
    );

    let (status, malformed) = send(
        app.clone(),
        Method::POST,
        &ops_uri,
        Some(json!({ "base_revision": 3, "ops": [{ "op": "explode" }] })),
    )
    .await;
    assert_eq!((status, &malformed["code"]), (422, &json!("invalid_input")));

    let (status, no_body) = send(app.clone(), Method::POST, &ops_uri, None).await;
    assert_eq!((status, &no_body["code"]), (422, &json!("invalid_input")));
}

#[tokio::test]
async fn a_locked_keychain_and_a_missing_service_are_unavailable() {
    let locked = service_with(MemoryVault {
        unavailable: true,
        ..MemoryVault::default()
    });
    let (status, body) = send(
        router(&locked),
        Method::PUT,
        "/api/automation-secrets",
        Some(json!({ "project_id": "p1", "name": "API_KEY", "value": "sk-1" })),
    )
    .await;
    assert_eq!(
        (status, &body["code"]),
        (503, &json!("keychain_unavailable"))
    );

    let (status, body) = send(
        router_for(None, false, LOOPBACK, OPEN),
        Method::GET,
        "/api/automations?project_id=p1",
        None,
    )
    .await;
    assert_eq!((status, &body["code"]), (503, &json!("unavailable")));
}

#[tokio::test]
async fn admission_follows_the_token_gate_and_the_remote_write_guard() {
    let service = service();
    let shared_live = WriteFlags {
        allow_remote_writes: false,
        shared_live_writes_denied: true,
    };
    let opted_in = WriteFlags {
        allow_remote_writes: true,
        shared_live_writes_denied: false,
    };
    // (token gated, bearer, peer, flags, method) -> status
    let cases = [
        (true, false, LOOPBACK, OPEN, Method::GET, 403),
        (true, true, LOOPBACK, OPEN, Method::GET, 200),
        (false, false, LAN, OPEN, Method::GET, 403),
        (true, true, LAN, OPEN, Method::GET, 200),
        (true, true, LAN, OPEN, Method::POST, 403),
        (true, true, LAN, opted_in, Method::POST, 200),
        (true, true, LOOPBACK, shared_live, Method::POST, 403),
        (true, true, LOOPBACK, shared_live, Method::GET, 200),
    ];
    for (gated, bearer, peer, flags, method, expected) in cases {
        let app = router_for(Some(service.clone()), gated, peer, flags);
        let (uri, body) = if method == Method::GET {
            ("/api/automations?project_id=p1", None)
        } else {
            (
                "/api/automations",
                Some(json!({ "project_id": "p1", "name": "Digest" })),
            )
        };
        let mut request = Request::builder()
            .method(method.clone())
            .uri(uri)
            .header("content-type", "application/json")
            .body(body.map_or_else(Body::empty, |b: Value| Body::from(b.to_string())))
            .unwrap();
        if bearer {
            request.extensions_mut().insert(BearerVerified);
        }
        let status = app.oneshot(request).await.unwrap().status().as_u16();
        assert_eq!(
            status, expected,
            "gated={gated} bearer={bearer} peer={peer} flags={flags:?} {method}"
        );
    }
}

#[tokio::test]
async fn one_mutation_is_one_automation_changed_delta_on_the_agents_watch() {
    let service = service();
    let relay = Arc::new(WsRelaySink::new());
    let (out, mut frames) = outbound_channel(16, 15);
    relay
        .watches()
        .subscribe(WatchKind::Agents, "", &out, || json!([]))
        .unwrap();
    tokio::spawn(forward_changes(service.subscribe(), relay.clone()));

    let id = create(&router(&service)).await;
    let expected = json!({ "event": "automation_changed",
        "payload": { "project_id": "p1", "automation_id": id } });
    let mut deltas = Vec::new();
    for _ in 0..200 {
        while let Ok(Outbound::Watch(frame)) = frames.try_recv() {
            if let Some(delta) = frame.delta_value() {
                deltas.push(delta.clone());
            }
        }
        if !deltas.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    tokio::time::sleep(Duration::from_millis(20)).await;
    while let Ok(Outbound::Watch(frame)) = frames.try_recv() {
        if let Some(delta) = frame.delta_value() {
            deltas.push(delta.clone());
        }
    }

    assert_eq!(deltas, vec![expected]);
}

/// Through the real host stack: the bearer gate covers the automation
/// routes, and both router variants merge them (no service is installed in
/// the test process, so an admitted request reads `unavailable`).
#[tokio::test]
async fn the_host_router_gates_and_serves_the_automation_routes() {
    let dir = tempfile::tempdir().unwrap();
    let auth = Arc::new(crate::web::auth::WebAuth::new(
        crate::web::auth::WebAuthToken::new("automation-token").unwrap(),
    ));
    let app = crate::web::router::router_with_static(
        Arc::new(crate::acp::AcpManager::new(vec![])),
        crate::web::test_pty_manager(),
        Arc::new(WsRelaySink::new()),
        Arc::new(crate::web::project_registry::ProjectRegistry::new()),
        dir.path(),
        false,
        false,
        Some(auth),
        crate::web::origin::OriginPolicy::default(),
    );
    let peer: SocketAddr = LOOPBACK.parse().unwrap();
    for (token, expected) in [
        ("wrong", (401, "UNAUTHORIZED")),
        ("automation-token", (503, "unavailable")),
    ] {
        let request = Request::builder()
            .uri("/api/automation-agents")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {token}"))
            .extension(axum::extract::ConnectInfo(peer))
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        let status = response.status().as_u16();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            (status, body["code"].as_str().unwrap()),
            expected,
            "token={token}"
        );
    }
}

fn suggesting_service() -> Arc<AutomationService> {
    let te = test_engine(
        std::env::temp_dir(),
        Arc::new(MemoryVault::default()),
        HttpConfig::default(),
    );
    te.clock.set(FRIDAY_MS);
    Arc::new(AutomationService::new(
        te.engine,
        Arc::new(|project_id: &str, _: i64| weekday_asks(project_id)),
    ))
}

#[tokio::test]
async fn suggestions_are_listed_matched_and_dismissed_over_their_routes() {
    let service = suggesting_service();
    let app = router(&service);
    let list = "/api/automation-suggestions?project_id=p1&timezone=UTC";

    let (status, body) = send(app.clone(), Method::GET, list, None).await;
    assert_eq!(status, 200);
    let fingerprint = body["data"][0]["fingerprint"].as_str().unwrap().to_string();
    let suggestion = json!({
        "fingerprint": fingerprint,
        "representative": "summarize the 3 open PRs in termul",
        "occurrences": 4,
        "days": 4,
        "last_at": 1_793_264_700_000_i64,
        "cadence": {
            "schedule": { "kind": "cron", "expr": "0 9 * * 1-5", "timezone": "UTC" },
            "label": "weekdays at 09:00"
        }
    });
    assert_eq!((status, body), ok(json!([suggestion.clone()])));

    let matched = |text: &str| {
        json!({ "project_id": "p1", "text": text, "timezone": "UTC" })
    };
    let match_uri = "/api/automation-suggestions/match";
    assert_eq!(
        send(app.clone(), Method::POST, match_uri, Some(matched("summarize the open PRs in termul"))).await,
        ok(suggestion)
    );
    assert_eq!(
        send(app.clone(), Method::POST, match_uri, Some(matched("fix the flaky reconnect test"))).await,
        ok(Value::Null)
    );

    let answer = json!({ "project_id": "p1", "fingerprint": fingerprint });
    assert_eq!(
        send(app.clone(), Method::POST, "/api/automation-suggestions/dismiss", Some(answer)).await,
        ok(Value::Null)
    );
    assert_eq!(send(app, Method::GET, list, None).await, ok(json!([])));
}

#[tokio::test]
async fn answering_a_suggestion_is_a_write_and_matching_is_a_read() {
    let service = suggesting_service();
    let lan = |path: &str, body: Value| {
        let mut request = Request::builder()
            .method(Method::POST)
            .uri(path)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        request.extensions_mut().insert(BearerVerified);
        request
    };
    let app = router_for(Some(service), true, LAN, OPEN);
    let status = |response: Response| response.status().as_u16();

    let matched = app
        .clone()
        .oneshot(lan(
            "/api/automation-suggestions/match",
            json!({ "project_id": "p1", "text": "summarize the open PRs in termul" }),
        ))
        .await
        .unwrap();
    assert_eq!(status(matched), 200);
    for path in [
        "/api/automation-suggestions/dismiss",
        "/api/automation-suggestions/accept",
    ] {
        let answered = app
            .clone()
            .oneshot(lan(path, json!({ "project_id": "p1", "fingerprint": "abcd" })))
            .await
            .unwrap();
        assert_eq!(status(answered), 403, "{path}");
    }
}
