use super::*;
use std::sync::Mutex as StdMutex;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio::runtime::Runtime;

#[derive(Default)]
struct CapturingSink {
    events: StdMutex<Vec<(String, serde_json::Value)>>,
}

impl EventSink for CapturingSink {
    fn emit(&self, event: &crate::web::sink::AcpEvent) {
        if event.type_ == crate::acp::events::EVENT_PLAN_UPDATE
            || event.type_ == crate::acp::events::EVENT_SESSION_INFO_UPDATE
        {
            self.events
                .lock()
                .unwrap()
                .push((event.type_.to_string(), event.payload.clone()));
        }
    }
}

async fn connect_and_send(port: u16, frame: &serde_json::Value) -> serde_json::Value {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let mut buf = serde_json::to_vec(frame).unwrap();
    buf.push(b'\n');
    stream.write_all(&buf).await.unwrap();
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).await.unwrap();
    serde_json::from_str(&line).unwrap_or(serde_json::Value::Null)
}

#[test]
fn register_returns_valid_port_token_provisional() {
    let server = HostPlanServer::start(vec![], None);
    let (port, token, provisional) = server.register_session("agent-1");
    assert!(port > 0, "port must be bound by the dedicated thread");
    assert!(!token.is_empty());
    assert!(!provisional.is_empty());
    assert_ne!(token, provisional, "token and provisional sid must differ");
}

#[test]
fn unbound_call_is_rejected_before_bind() {
    // Before `bind_session` is called, the real session_id is unknown — a
    // call arriving in that window is rejected (the agent can't legally
    // call tools before `session/new` returns, but we defend anyway).
    let server = HostPlanServer::start(vec![Arc::new(CapturingSink::default())], None);
    let (port, token, provisional) = server.register_session("agent-1");
    let runtime = Runtime::new().unwrap();
    runtime.block_on(async move {
        let frame = serde_json::json!({
            "token": token,
            "session_id": provisional,
            "kind": "plan",
            "todos": [{"content": "x"}],
        });
        let reply = connect_and_send(port, &frame).await;
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"], "session not ready");
    });
}

#[test]
fn token_provisional_mismatch_is_rejected() {
    // A valid token paired with the wrong provisional session_id is
    // rejected (defense-in-depth against a leaked token + guessed sid).
    let server = HostPlanServer::start(vec![Arc::new(CapturingSink::default())], None);
    let (port, token, _provisional) = server.register_session("agent-1");
    let runtime = Runtime::new().unwrap();
    runtime.block_on(async move {
        let frame = serde_json::json!({
            "token": token,
            "session_id": "wrong-provisional",
            "kind": "plan",
            "todos": [{"content": "x"}],
        });
        let reply = connect_and_send(port, &frame).await;
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"], "auth rejected");
    });
}

#[test]
fn bound_session_emits_plan_update() {
    let sink = Arc::new(CapturingSink::default());
    let server = HostPlanServer::start(vec![sink.clone()], None);
    let (port, token, provisional) = server.register_session("agent-1");
    server.bind_session(&token, "sess-real");
    server.begin_turn("agent-1", "sess-real");

    let runtime = Runtime::new().unwrap();
    runtime.block_on(async move {
        let frame = serde_json::json!({
            "token": token,
            "session_id": provisional,
            "kind": "plan",
            "todos": [
                {"content": "one"},
                {"content": "two", "status": "in_progress", "priority": "high"},
            ],
        });
        let reply = connect_and_send(port, &frame).await;
        assert_eq!(reply["ok"], true);
    });
    let captured = sink.events.lock().unwrap();
    assert_eq!(captured.len(), 1, "exactly one plan_update must be emitted");
    assert_eq!(captured[0].1["sessionId"], "sess-real");
}

#[test]
fn bound_session_without_an_active_turn_is_rejected() {
    let sink = Arc::new(CapturingSink::default());
    let server = HostPlanServer::start(vec![sink.clone()], None);
    let (port, token, provisional) = server.register_session("agent-1");
    server.bind_session(&token, "sess-real");

    let runtime = Runtime::new().unwrap();
    runtime.block_on(async move {
        let frame = serde_json::json!({
            "token": token,
            "session_id": provisional,
            "todos": [{"content": "late work"}],
        });
        let reply = connect_and_send(port, &frame).await;
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"], "no active turn");
    });

    assert!(sink.events.lock().unwrap().is_empty());
}

#[test]
fn stale_binding_routes_to_the_agents_only_active_turn() {
    let sink = Arc::new(CapturingSink::default());
    let server = HostPlanServer::start(vec![sink.clone()], None);
    let (port, token, provisional) = server.register_session("agent-1");
    server.bind_session(&token, "sess-old");
    server.begin_turn("agent-1", "sess-current");

    let runtime = Runtime::new().unwrap();
    runtime.block_on(async move {
        let frame = serde_json::json!({
            "token": token,
            "session_id": provisional,
            "todos": [{"content": "current work"}],
        });
        let reply = connect_and_send(port, &frame).await;
        assert_eq!(reply["ok"], true);
    });

    let captured = sink.events.lock().unwrap();
    assert_eq!(captured.len(), 1);
    assert_eq!(captured[0].1["sessionId"], "sess-current");
    assert!(server.plan_store.get("sess-old").is_none());
    assert_eq!(server.plan_store.get("sess-current").unwrap().len(), 1);
}

#[test]
fn bound_active_session_wins_when_agent_has_multiple_active_turns() {
    let sink = Arc::new(CapturingSink::default());
    let server = HostPlanServer::start(vec![sink.clone()], None);
    let (port, token, provisional) = server.register_session("agent-1");
    server.bind_session(&token, "sess-bound");
    server.begin_turn("agent-1", "sess-bound");
    server.begin_turn("agent-1", "sess-other");

    let runtime = Runtime::new().unwrap();
    runtime.block_on(async move {
        let frame = serde_json::json!({
            "token": token,
            "session_id": provisional,
            "todos": [{"content": "bound work"}],
        });
        let reply = connect_and_send(port, &frame).await;
        assert_eq!(reply["ok"], true);
    });

    let captured = sink.events.lock().unwrap();
    assert_eq!(captured[0].1["sessionId"], "sess-bound");
}

#[test]
fn ambiguous_stale_binding_is_rejected_instead_of_cross_routed() {
    let sink = Arc::new(CapturingSink::default());
    let server = HostPlanServer::start(vec![sink.clone()], None);
    let (port, token, provisional) = server.register_session("agent-1");
    server.bind_session(&token, "sess-old");
    server.begin_turn("agent-1", "sess-a");
    server.begin_turn("agent-1", "sess-b");

    let runtime = Runtime::new().unwrap();
    runtime.block_on(async move {
        let frame = serde_json::json!({
            "token": token,
            "session_id": provisional,
            "todos": [{"content": "ambiguous work"}],
        });
        let reply = connect_and_send(port, &frame).await;
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"], "ambiguous active session");
    });

    assert!(sink.events.lock().unwrap().is_empty());
}

#[test]
fn end_turn_removes_routing_candidate() {
    let server = HostPlanServer::start(vec![], None);
    server.begin_turn("agent-1", "sess-current");
    server.end_turn("agent-1", "sess-current");
    assert!(server.active_turns.lock().get("agent-1").is_none());
}

#[test]
fn browser_frame_without_host_fails_closed_with_typed_code() {
    // The `browser` tool dispatch is host-gated: without a registered
    // BrowserHost (termul-server, tests, non-desktop surfaces) the frame is
    // rejected with the typed `capability_unavailable` code — the agent sees
    // a clean capability signal, never a panic or silent no-op.
    // Serialize on the shared host lock — sibling tests register a stub host.
    let _guard = crate::browser_automation::TEST_HOST_LOCK.lock().unwrap();
    crate::browser_automation::clear_browser_host();
    let server = HostPlanServer::start(vec![], None);
    let (port, token, provisional) = server.register_session("agent-1");
    server.bind_session(&token, "sess-real");
    server.begin_turn("agent-1", "sess-real");
    let runtime = Runtime::new().unwrap();
    runtime.block_on(async move {
        let frame = serde_json::json!({
            "token": token,
            "session_id": provisional,
            "kind": "browser",
            "browser_action": "navigate",
            "browser_args": {"url": "https://example.com"},
        });
        let reply = connect_and_send(port, &frame).await;
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["code"], "capability_unavailable");
    });
}

#[test]
fn browser_frame_missing_action_is_rejected() {
    let server = HostPlanServer::start(vec![], None);
    let (port, token, provisional) = server.register_session("agent-1");
    server.bind_session(&token, "sess-real");
    server.begin_turn("agent-1", "sess-real");
    let runtime = Runtime::new().unwrap();
    runtime.block_on(async move {
        let frame = serde_json::json!({
            "token": token,
            "session_id": provisional,
            "kind": "browser",
        });
        let reply = connect_and_send(port, &frame).await;
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"], "browser_action is required");
    });
}

#[test]
fn browser_frame_round_trip_serializes_payload_fields() {
    // Wire shape the child emits — must survive serde unchanged so the
    // parent can reconstruct BrowserCall.
    let frame = FrameRequest {
        token: "t".into(),
        session_id: "p".into(),
        kind: FrameKind::Browser,
        todos: Vec::new(),
        title: None,
        browser_action: Some("click".into()),
        browser_args: Some(serde_json::json!({"ref": "@e3"})),
        browser_element: Some("the save button".into()),
    };
    let value = serde_json::to_value(&frame).unwrap();
    assert_eq!(value["kind"], "browser");
    assert_eq!(value["browser_action"], "click");
    assert_eq!(value["browser_args"]["ref"], "@e3");
    let decoded: FrameRequest = serde_json::from_value(value).unwrap();
    assert_eq!(decoded.kind, FrameKind::Browser);
    assert_eq!(decoded.browser_action.as_deref(), Some("click"));
}

#[test]
fn browser_frame_from_flat_call_carries_folded_args_to_dispatch() {
    // End-to-end wire shape: a FLAT tool call (folded by the child's
    // `TermulBrowserInput` deserializer) → TCP frame → parent Browser arm →
    // `dispatch` — the dispatched `BrowserCall` args must carry the folded
    // keys. A stub host echoes the args it received as the reply result.
    // Serialize on the shared host lock — sibling tests touch the host.
    let _guard = crate::browser_automation::TEST_HOST_LOCK.lock().unwrap();
    crate::browser_automation::clear_browser_host();
    use crate::browser_automation::{BrowserCall, BrowserError, BrowserHost};
    use serde_json::Value;
    struct EchoHost;
    impl BrowserHost for EchoHost {
        fn execute<'a>(
            &'a self,
            _session_id: &'a str,
            _agent_id: &'a str,
            call: BrowserCall,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<Value, BrowserError>> + Send + 'a>,
        > {
            Box::pin(async move { Ok(call.args) })
        }
        fn end_session(&self, _session_id: &str) {}
        fn notify_tab_created(&self, _tab_id: &str) -> bool {
            false
        }
        fn notify_tab_closed(&self, _tab_id: &str) {}
        fn notify_tab_navigated(&self, _tab_id: &str) {}
        fn resolve_consent(&self, _request_id: &str, _allowed: bool) -> bool {
            false
        }
        fn resolve_eval(&self, _nonce: &str, _ok: bool, _value: Option<String>) -> bool {
            false
        }
    }
    crate::browser_automation::set_browser_host(std::sync::Arc::new(EchoHost));

    let input: crate::acp::host_mcp::TermulBrowserInput = serde_json::from_value(
        serde_json::json!({ "action": "navigate", "url": "https://example.com" }),
    )
    .unwrap();
    let frame = FrameRequest {
        token: "unused".into(),
        session_id: "unused".into(),
        kind: FrameKind::Browser,
        todos: Vec::new(),
        title: None,
        browser_action: Some(input.action),
        browser_args: Some(input.args),
        browser_element: input.element,
    };

    let server = HostPlanServer::start(vec![], None);
    let (port, token, provisional) = server.register_session("agent-1");
    server.bind_session(&token, "sess-real");
    server.begin_turn("agent-1", "sess-real");
    let mut wire = serde_json::to_value(&frame).unwrap();
    wire["token"] = serde_json::json!(token);
    wire["session_id"] = serde_json::json!(provisional);
    let runtime = Runtime::new().unwrap();
    runtime.block_on(async move {
        let reply = connect_and_send(port, &wire).await;
        assert_eq!(reply["ok"], true);
        assert_eq!(reply["result"]["url"], "https://example.com");
    });
    crate::browser_automation::clear_browser_host();
}

#[test]
fn bad_token_alone_is_rejected() {
    // Unknown token — rejected even with a plausible provisional sid.
    let server = HostPlanServer::start(vec![Arc::new(CapturingSink::default())], None);
    let (port, _token, _provisional) = server.register_session("agent-1");
    let runtime = Runtime::new().unwrap();
    runtime.block_on(async move {
        let frame = serde_json::json!({
            "token": "bogus-token",
            "session_id": "bogus-sid",
            "kind": "plan",
            "todos": [{"content": "x"}],
        });
        let reply = connect_and_send(port, &frame).await;
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"], "auth rejected");
    });
}

#[test]
fn bound_title_call_persists_and_broadcasts() {
    let root = std::env::temp_dir().join(format!("termul-host-mcp-title-{}", uuid::Uuid::new_v4()));
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let runtime = Runtime::new().unwrap();
    runtime.block_on(async move {
        let persistence = Arc::new(SessionPersistence::open(root.join("store")).await.unwrap());
        persistence
            .register_session(crate::acp::SessionRegistration {
                session_id: "sess-real".into(),
                stable_agent_namespace: Some("config:test".into()),
                runtime_agent_id: Some("agent-1".into()),
                project_id: None,
                cwd,
                ..Default::default()
            })
            .await
            .unwrap();
        let sink = Arc::new(CapturingSink::default());
        let server = HostPlanServer::start(vec![sink.clone()], Some(Arc::clone(&persistence)));
        let (port, token, provisional) = server.register_session("agent-1");
        server.bind_session(&token, "sess-real");
        server.begin_turn("agent-1", "sess-real");
        let frame = serde_json::json!({
            "token": token,
            "session_id": provisional,
            "kind": "set_title",
            "title": "**Fix login bug**\nignored",
        });
        let reply = connect_and_send(port, &frame).await;
        assert_eq!(reply["ok"], true);
        let metadata = persistence.metadata("sess-real").unwrap();
        assert_eq!(metadata.title.as_deref(), Some("Fix login bug"));
        assert_eq!(
            metadata.title_source,
            Some(crate::acp::session_persistence::TitleSource::BackgroundGenerated)
        );
        let records = persistence.replay_after("sess-real", 0).unwrap();
        assert!(records
            .iter()
            .any(|record| record.type_ == "local_title_generated"));
        assert_eq!(sink.events.lock().unwrap().len(), 1);
        persistence.shutdown().await.unwrap();
        let _ = std::fs::remove_dir_all(root);
    });
}

#[test]
fn second_title_call_same_session_is_success_noop() {
    // Per-session enforcement: after the first call sets the title, a
    // second call for the same session must return `ok` (so the agent
    // stops retrying) without writing a second persistence record or
    // emitting a second session_info_update.
    let root = std::env::temp_dir().join(format!(
        "termul-host-mcp-title-noop-{}",
        uuid::Uuid::new_v4()
    ));
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let runtime = Runtime::new().unwrap();
    runtime.block_on(async move {
        let persistence = Arc::new(SessionPersistence::open(root.join("store")).await.unwrap());
        persistence
            .register_session(crate::acp::SessionRegistration {
                session_id: "sess-real".into(),
                stable_agent_namespace: Some("config:test".into()),
                runtime_agent_id: Some("agent-1".into()),
                project_id: None,
                cwd,
                ..Default::default()
            })
            .await
            .unwrap();
        let sink = Arc::new(CapturingSink::default());
        let server = HostPlanServer::start(vec![sink.clone()], Some(Arc::clone(&persistence)));
        let (port, token, provisional) = server.register_session("agent-1");
        server.bind_session(&token, "sess-real");
        server.begin_turn("agent-1", "sess-real");

        let first = serde_json::json!({
            "token": token,
            "session_id": provisional,
            "kind": "set_title",
            "title": "First title",
        });
        let reply = connect_and_send(port, &first).await;
        assert_eq!(reply["ok"], true);
        let events_after_first = sink.events.lock().unwrap().len();

        let second = serde_json::json!({
            "token": token,
            "session_id": provisional,
            "kind": "set_title",
            "title": "Should be ignored",
        });
        let reply = connect_and_send(port, &second).await;
        assert_eq!(reply["ok"], true, "repeat title call must succeed (no-op)");

        // No second event + title unchanged + no second record.
        assert_eq!(
            sink.events.lock().unwrap().len(),
            events_after_first,
            "no second session_info_update"
        );
        let metadata = persistence.metadata("sess-real").unwrap();
        assert_eq!(metadata.title.as_deref(), Some("First title"));
        let title_records = persistence
            .replay_after("sess-real", 0)
            .unwrap()
            .iter()
            .filter(|r| r.type_ == "local_title_generated")
            .count();
        assert_eq!(title_records, 1, "no duplicate title persistence record");
        persistence.shutdown().await.unwrap();
        let _ = std::fs::remove_dir_all(root);
    });
}

#[test]
fn title_per_session_flag_survives_a_new_turn() {
    // Per-session (not per-turn): `end_turn` + `begin_turn` for a 2nd turn
    // must NOT reset the title flag — the agent can't set the title again
    // on a later turn.
    let root = std::env::temp_dir().join(format!(
        "termul-host-mcp-title-turn-{}",
        uuid::Uuid::new_v4()
    ));
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let runtime = Runtime::new().unwrap();
    runtime.block_on(async move {
        let persistence = Arc::new(SessionPersistence::open(root.join("store")).await.unwrap());
        persistence
            .register_session(crate::acp::SessionRegistration {
                session_id: "sess-real".into(),
                stable_agent_namespace: Some("config:test".into()),
                runtime_agent_id: Some("agent-1".into()),
                project_id: None,
                cwd,
                ..Default::default()
            })
            .await
            .unwrap();
        let sink = Arc::new(CapturingSink::default());
        let server = HostPlanServer::start(vec![sink.clone()], Some(Arc::clone(&persistence)));
        let (port, token, provisional) = server.register_session("agent-1");
        server.bind_session(&token, "sess-real");
        server.begin_turn("agent-1", "sess-real");

        let first = serde_json::json!({
            "token": token,
            "session_id": provisional,
            "kind": "set_title",
            "title": "Turn 1 title",
        });
        assert_eq!(connect_and_send(port, &first).await["ok"], true);

        // End the turn + start a fresh turn (mirrors a 2nd user prompt).
        server.end_turn("agent-1", "sess-real");
        server.begin_turn("agent-1", "sess-real");

        let second = serde_json::json!({
            "token": token,
            "session_id": provisional,
            "kind": "set_title",
            "title": "Turn 2 title",
        });
        let reply = connect_and_send(port, &second).await;
        assert_eq!(
            reply["ok"], true,
            "2nd-turn title call must succeed (no-op)"
        );
        let metadata = persistence.metadata("sess-real").unwrap();
        assert_eq!(
            metadata.title.as_deref(),
            Some("Turn 1 title"),
            "title must NOT change on a later turn"
        );
        persistence.shutdown().await.unwrap();
        let _ = std::fs::remove_dir_all(root);
    });
}
