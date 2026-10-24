use std::sync::Mutex as StdMutex;

use super::*;

/// A renderer connection that records the frames it is handed.
struct FakeRenderer {
    id: &'static str,
    frames: Arc<StdMutex<Vec<CanvasCallFrame>>>,
    accept: bool,
}

impl FakeRenderer {
    fn new(id: &'static str) -> Self {
        Self {
            id,
            frames: Arc::default(),
            accept: true,
        }
    }

    fn closed(id: &'static str) -> Self {
        Self {
            accept: false,
            ..Self::new(id)
        }
    }

    fn holder(&self) -> CanvasHolder {
        let frames = Arc::clone(&self.frames);
        let accept = self.accept;
        CanvasHolder::new(
            self.id,
            crate::canvas::persistence::test_renderer(),
            Arc::new(move |frame| {
                if accept {
                    frames.lock().unwrap().push(frame);
                }
                accept
            }),
        )
    }

    fn frames(&self) -> Vec<CanvasCallFrame> {
        self.frames.lock().unwrap().clone()
    }

    /// Wait until the router has handed this renderer `count` frames.
    async fn received(&self, count: usize) -> Vec<CanvasCallFrame> {
        for _ in 0..200 {
            let frames = self.frames();
            if frames.len() >= count {
                return frames;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("the renderer never received {count} frame(s)");
    }
}

/// The host holds a mount at `mount_seq` and `holder` reports it runs it.
fn mount(router: &CanvasRouter, project_id: &str, mount_seq: u64, holder: CanvasHolder) {
    router.mounts().ensure_test_mount(project_id, mount_seq);
    assert!(router.mount(project_id, mount_seq, holder));
}

fn code_of(outcome: &CanvasOutcome) -> Option<CanvasErrorCode> {
    outcome.as_ref().err().map(|error| error.code)
}

#[tokio::test]
async fn a_project_with_no_mount_answers_canvas_closed() {
    let router = CanvasRouter::default();
    let outcome = router.call("proj-1", "document.inspect", "{}".into()).await;
    assert_eq!(code_of(&outcome), Some(CanvasErrorCode::CanvasClosed));
}

#[tokio::test]
async fn a_call_reaches_the_holder_and_returns_its_result_text_verbatim() {
    let router = Arc::new(CanvasRouter::default());
    let renderer = FakeRenderer::new("conn-a");
    mount(&router, "proj-1", 3, renderer.holder());

    let caller = Arc::clone(&router);
    let call = tokio::spawn(async move {
        caller
            .call(
                "proj-1",
                "node.get",
                r#"{"id":18446744073709551615}"#.into(),
            )
            .await
    });
    let frame = renderer.received(1).await.remove(0);
    assert_eq!(frame.project_id, "proj-1");
    assert_eq!(frame.mount_seq, 3);
    assert_eq!(frame.method, "node.get");
    assert_eq!(frame.params, r#"{"id":18446744073709551615}"#);

    // u64 ids above 2^53 survive because nothing on the way parses them.
    let result = r#"{"id":18446744073709551615,"name":"Frame"}"#;
    assert!(router.reply("conn-a", frame.call_id, 3, Ok(result.to_string())));
    assert_eq!(call.await.unwrap(), Ok(result.to_string()));
}

#[tokio::test]
async fn the_wire_frame_has_the_canvas_call_shape() {
    let router = Arc::new(CanvasRouter::default());
    let renderer = FakeRenderer::new("conn-a");
    mount(&router, "proj-1", 1, renderer.holder());
    let caller = Arc::clone(&router);
    let call =
        tokio::spawn(async move { caller.call("proj-1", "engine.commands", "{}".into()).await });
    let frame = renderer.received(1).await.remove(0);
    let wire = serde_json::to_value(&frame).unwrap();
    assert_eq!(
        wire,
        serde_json::json!({
            "type": "canvas_call",
            "callId": frame.call_id,
            "projectId": "proj-1",
            "mountSeq": 1,
            "method": "engine.commands",
            "params": "{}",
            "timeoutMs": wire["timeoutMs"],
        })
    );
    let left = wire["timeoutMs"]
        .as_u64()
        .expect("the call carries its time left");
    assert!(
        left > 0 && left <= 10_000,
        "the host's own remaining wait: {left}"
    );
    router.reply("conn-a", frame.call_id, 1, Ok("[]".into()));
    assert_eq!(call.await.unwrap(), Ok("[]".to_string()));
}

#[tokio::test]
async fn an_unanswered_call_times_out_with_canvas_timeout() {
    let router = CanvasRouter::new(Duration::from_millis(50));
    let renderer = FakeRenderer::new("conn-a");
    mount(&router, "proj-1", 1, renderer.holder());
    let outcome = router.call("proj-1", "document.inspect", "{}".into()).await;
    assert_eq!(code_of(&outcome), Some(CanvasErrorCode::CanvasTimeout));
    // A late reply finds nothing waiting.
    let call_id = renderer.frames()[0].call_id;
    assert!(!router.reply("conn-a", call_id, 1, Ok("{}".into())));
}

#[tokio::test]
async fn a_remount_mid_call_resolves_canvas_closed() {
    let router = Arc::new(CanvasRouter::default());
    let renderer = FakeRenderer::new("conn-a");
    mount(&router, "proj-1", 1, renderer.holder());
    let caller = Arc::clone(&router);
    let call =
        tokio::spawn(async move { caller.call("proj-1", "document.inspect", "{}".into()).await });
    let frame = renderer.received(1).await.remove(0);

    mount(&router, "proj-1", 2, renderer.holder());
    assert_eq!(
        code_of(&call.await.unwrap()),
        Some(CanvasErrorCode::CanvasClosed)
    );
    // The old mount's answer resolves nothing.
    assert!(!router.reply("conn-a", frame.call_id, 1, Ok("{}".into())));

    // The new mount serves the next call.
    let caller = Arc::clone(&router);
    let call =
        tokio::spawn(async move { caller.call("proj-1", "document.inspect", "{}".into()).await });
    let frame = renderer.received(2).await.remove(1);
    assert_eq!(frame.mount_seq, 2);
    router.reply("conn-a", frame.call_id, 2, Ok("{}".into()));
    assert_eq!(call.await.unwrap(), Ok("{}".to_string()));
}

#[tokio::test]
async fn a_reply_stamped_with_another_mount_seq_resolves_canvas_closed() {
    let router = Arc::new(CanvasRouter::default());
    let renderer = FakeRenderer::new("conn-a");
    mount(&router, "proj-1", 4, renderer.holder());
    let caller = Arc::clone(&router);
    let call =
        tokio::spawn(async move { caller.call("proj-1", "document.inspect", "{}".into()).await });
    let frame = renderer.received(1).await.remove(0);
    assert!(router.reply("conn-a", frame.call_id, 5, Ok("{}".into())));
    assert_eq!(
        code_of(&call.await.unwrap()),
        Some(CanvasErrorCode::CanvasClosed)
    );
}

#[tokio::test]
async fn a_newer_renderer_takes_the_project_and_closes_calls_sent_to_the_old_one() {
    let router = Arc::new(CanvasRouter::default());
    let desktop = FakeRenderer::new("conn-desktop");
    let web = FakeRenderer::new("conn-web");
    mount(&router, "proj-1", 1, desktop.holder());
    let caller = Arc::clone(&router);
    let call =
        tokio::spawn(async move { caller.call("proj-1", "document.inspect", "{}".into()).await });
    let frame = desktop.received(1).await.remove(0);

    // Same mountSeq, different connection: still a different mount.
    mount(&router, "proj-1", 1, web.holder());
    assert_eq!(
        code_of(&call.await.unwrap()),
        Some(CanvasErrorCode::CanvasClosed)
    );
    assert!(!router.reply("conn-desktop", frame.call_id, 1, Ok("{}".into())));

    let caller = Arc::clone(&router);
    let call = tokio::spawn(async move { caller.call("proj-1", "node.get", "{}".into()).await });
    let frame = web.received(1).await.remove(0);
    assert_eq!(
        desktop.frames().len(),
        1,
        "the old holder gets no new calls"
    );
    router.reply("conn-web", frame.call_id, 1, Ok("{}".into()));
    assert_eq!(call.await.unwrap(), Ok("{}".to_string()));
}

#[tokio::test]
async fn only_the_connection_a_call_went_to_can_answer_it() {
    let router = Arc::new(CanvasRouter::new(Duration::from_millis(200)));
    let renderer = FakeRenderer::new("conn-a");
    mount(&router, "proj-1", 1, renderer.holder());
    let caller = Arc::clone(&router);
    let call =
        tokio::spawn(async move { caller.call("proj-1", "document.inspect", "{}".into()).await });
    let frame = renderer.received(1).await.remove(0);
    assert!(!router.reply("conn-intruder", frame.call_id, 1, Ok("{}".into())));
    assert!(router.reply("conn-a", frame.call_id, 1, Ok(r#"{"ok":1}"#.into())));
    assert_eq!(call.await.unwrap(), Ok(r#"{"ok":1}"#.to_string()));
}

#[tokio::test(start_paused = true)]
async fn the_holder_disconnecting_closes_its_calls_and_its_mounts() {
    let router = Arc::new(CanvasRouter::default());
    let renderer = FakeRenderer::new("conn-a");
    mount(&router, "proj-1", 1, renderer.holder());
    mount(&router, "proj-2", 1, renderer.holder());
    let caller = Arc::clone(&router);
    let call =
        tokio::spawn(async move { caller.call("proj-1", "document.inspect", "{}".into()).await });
    renderer.received(1).await;

    router.release_holder("conn-a");
    assert_eq!(
        code_of(&call.await.unwrap()),
        Some(CanvasErrorCode::CanvasClosed),
        "a call the lost connection held cannot be answered"
    );
    for project in ["proj-1", "proj-2"] {
        let outcome = router.call(project, "document.inspect", "{}".into()).await;
        assert_eq!(code_of(&outcome), Some(CanvasErrorCode::CanvasClosed));
    }
}

#[tokio::test]
async fn unmount_only_drops_the_mount_it_names() {
    let router = Arc::new(CanvasRouter::default());
    let renderer = FakeRenderer::new("conn-a");
    mount(&router, "proj-1", 2, renderer.holder());
    assert!(!router.unmount("proj-1", "conn-a", 1), "a stale mountSeq");
    assert!(!router.unmount("proj-1", "conn-b", 2), "another connection");

    let caller = Arc::clone(&router);
    let call =
        tokio::spawn(async move { caller.call("proj-1", "document.inspect", "{}".into()).await });
    renderer.received(1).await;
    assert!(router.unmount("proj-1", "conn-a", 2));
    assert_eq!(
        code_of(&call.await.unwrap()),
        Some(CanvasErrorCode::CanvasClosed)
    );
    let outcome = router.call("proj-1", "document.inspect", "{}".into()).await;
    assert_eq!(code_of(&outcome), Some(CanvasErrorCode::CanvasClosed));
}

#[tokio::test]
async fn an_undeliverable_call_answers_canvas_closed_without_waiting() {
    let router = CanvasRouter::new(Duration::from_secs(30));
    mount(
        &router,
        "proj-1",
        1,
        FakeRenderer::closed("conn-a").holder(),
    );
    let outcome = tokio::time::timeout(
        Duration::from_secs(1),
        router.call("proj-1", "document.inspect", "{}".into()),
    )
    .await
    .expect("an undeliverable call must not wait for the timeout");
    assert_eq!(code_of(&outcome), Some(CanvasErrorCode::CanvasClosed));
}

#[tokio::test]
async fn a_report_for_a_mount_the_host_does_not_hold_is_refused() {
    let router = CanvasRouter::default();
    let renderer = FakeRenderer::new("conn-a");
    assert!(
        !router.mount("proj-1", 1, renderer.holder()),
        "no mount at all"
    );
    router.mounts().ensure_test_mount("proj-1", 2);
    assert!(
        !router.mount("proj-1", 1, renderer.holder()),
        "a stale mountSeq"
    );
    let outcome = router.call("proj-1", "document.inspect", "{}".into()).await;
    assert_eq!(code_of(&outcome), Some(CanvasErrorCode::CanvasClosed));
    assert!(renderer.frames().is_empty());
}

#[test]
fn typed_errors_encode_as_the_json_of_code_and_message() {
    let encoded = CanvasError::new(CanvasErrorCode::EngineError, "late").to_backend_string();
    let value: serde_json::Value = serde_json::from_str(&encoded).unwrap();
    assert_eq!(
        value,
        serde_json::json!({"code": "ENGINE_ERROR", "message": "late"})
    );
}

#[test]
fn errors_an_agent_can_recover_from_tell_it_the_next_step() {
    let actionable = [
        (CanvasErrorCode::CanvasClosed, "Canvas button"),
        (CanvasErrorCode::CanvasClosing, "Canvas button"),
        (CanvasErrorCode::CanvasHidden, "Canvas tab"),
        (
            CanvasErrorCode::CanvasOpenElsewhere,
            "another Termul window",
        ),
        (CanvasErrorCode::CanvasTimeout, "do not retry it blindly"),
        (CanvasErrorCode::UnsupportedInKiosk, "save_file"),
    ];
    for (code, step) in actionable {
        let encoded = CanvasError::new(code, "no canvas is mounted").to_backend_string();
        let value: serde_json::Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(value["code"], code.as_str());
        let message = value["message"].as_str().unwrap();
        assert!(
            message.starts_with("no canvas is mounted. ") && message.contains(step),
            "{message}"
        );
    }
    let ended = CanvasError::new(CanvasErrorCode::CanvasTimeout, "late.").to_backend_string();
    assert!(ended.contains(r#""late. The canvas"#), "{ended}");
    for code in [CanvasErrorCode::UnknownMethod, CanvasErrorCode::EngineError] {
        let encoded = CanvasError::new(code, "bad").to_backend_string();
        assert!(encoded.ends_with(r#""message":"bad"}"#), "{encoded}");
    }
}

#[test]
fn a_timeout_advises_by_tool_and_only_reads_are_retried_as_is() {
    let late = CanvasError::new(CanvasErrorCode::CanvasTimeout, "late");
    let advice = [
        ("export", "smaller `scale` or `size`"),
        ("screenshot", "smaller `maxSize` or `scale`"),
        ("batch", "read the current state"),
        ("create_node", "read the current state"),
        ("set_properties", "read the current state"),
        ("run_command", "read the current state"),
        ("get_node", "retry once"),
        ("inspect_document", "retry once"),
    ];
    for (tool, hint) in advice {
        let encoded = late.to_backend_string_for(Some(tool));
        assert!(encoded.contains(hint), "{tool}: {encoded}");
        if hint != "retry once" {
            assert!(!encoded.contains("retry once"), "{tool}: {encoded}");
        }
    }
}

#[test]
fn renderer_replies_parse_into_outcomes_at_the_boundary() {
    let parse = |value: serde_json::Value| {
        serde_json::from_value::<CanvasReplyPayload>(value)
            .unwrap()
            .into_outcome()
    };
    assert_eq!(
        parse(serde_json::json!({"callId": 1, "mountSeq": 1, "ok": true, "result": "[1]"})),
        Ok("[1]".to_string())
    );
    assert_eq!(
        parse(serde_json::json!({
            "callId": 1, "mountSeq": 1, "ok": false,
            "error": {"code": "CANVAS_HIDDEN", "message": "hidden"}
        })),
        Err(CanvasError::new(CanvasErrorCode::CanvasHidden, "hidden"))
    );
    assert_eq!(
        code_of(&parse(serde_json::json!({
            "callId": 1, "mountSeq": 1, "ok": false,
            "error": {"code": "SOMETHING_NEW", "message": "x"}
        }))),
        Some(CanvasErrorCode::EngineError)
    );
    assert_eq!(
        code_of(&parse(
            serde_json::json!({"callId": 1, "mountSeq": 1, "ok": true})
        )),
        Some(CanvasErrorCode::EngineError)
    );
}
