use super::*;

/// Alias for the shared test lock (see `TEST_HOST_LOCK`).
use super::TEST_HOST_LOCK as HOST_LOCK;

/// Platform-neutral CDP protocol seams (every platform — the module is
/// compiled for tests regardless of target OS).
use super::cdp_protocol;

fn call(action: &str, args: Value) -> BrowserCall {
    BrowserCall {
        action: action.to_string(),
        args,
        element: None,
    }
}

#[test]
fn dispatch_without_host_fails_closed() {
    let _g = HOST_LOCK.lock().unwrap();
    clear_browser_host();
    let rt = tokio::runtime::Runtime::new().unwrap();
    let err = rt
        .block_on(dispatch(
            "sess",
            "agent",
            call("navigate", json!({"url": "https://x"})),
        ))
        .expect_err("no host must fail closed");
    assert_eq!(err.code, ERR_CAPABILITY);
}

#[test]
fn hooks_without_host_are_noops() {
    let _g = HOST_LOCK.lock().unwrap();
    clear_browser_host();
    assert!(!tab_created("t1"));
    // Real nonces/request ids are `Uuid`s — keep the test values in the
    // same shape (and avoid hard-coded literal nonces).
    assert!(!eval_resolved(&Uuid::new_v4().to_string(), true, None));
    assert!(!consent_responded(&Uuid::new_v4().to_string(), true));
    tab_closed("t1");
    tab_navigated("t1");
    session_ended("s1");
}

#[test]
fn url_allowlist_accepts_http_s_only() {
    assert!(DesktopBrowserHost::check_url("https://example.com").is_ok());
    assert!(DesktopBrowserHost::check_url("http://127.0.0.1:3000/app").is_ok());
    for bad in [
        "file:///etc/passwd",
        "javascript:alert(1)",
        "data:text/html,<h1>x</h1>",
        "about:blank",
        "not a url",
        "",
    ] {
        assert!(
            DesktopBrowserHost::check_url(bad).is_err(),
            "must reject {bad}"
        );
    }
}

#[test]
fn require_url_arg_missing_or_non_string_names_url() {
    let missing = DesktopBrowserHost::require_url_arg(&json!({ "tabId": "t-1" }), "navigate")
        .expect_err("missing url must error");
    assert_eq!(missing.code, ERR_INVALID_PARAMS);
    assert!(
        missing.message.contains("url"),
        "must name 'url': {}",
        missing.message
    );
    assert!(
        missing.message.contains("navigate"),
        "must name the action: {}",
        missing.message
    );

    let non_string = DesktopBrowserHost::require_url_arg(&json!({ "url": 7 }), "new_tab")
        .expect_err("non-string url must error");
    assert_eq!(non_string.code, ERR_INVALID_PARAMS);
    assert!(
        non_string.message.contains("url"),
        "must name 'url': {}",
        non_string.message
    );
    assert!(
        non_string.message.contains("new_tab"),
        "must name the action: {}",
        non_string.message
    );

    let ok =
        DesktopBrowserHost::require_url_arg(&json!({ "url": "https://example.com" }), "navigate")
            .expect("string url extracts");
    assert_eq!(ok, "https://example.com");
}

#[test]
fn eval_gate_maps_stale_ref_prefix() {
    let err = eval_gate(json!({"error": "stale_ref: @e3 detached"}), 1)
        .expect_err("stale prefix maps to stale_ref");
    assert_eq!(err.code, ERR_STALE_REF);
    let err = eval_gate(json!({"error": "boom"}), 1).expect_err("other errors internal");
    assert_eq!(err.code, ERR_INTERNAL);
    eval_gate(json!({"ok": true}), 1).expect("no error field passes");
}

/// A registered host routes dispatch end-to-end; `session_ended` reaches
/// `end_session` so tabs/consent are reclaimed.
#[test]
fn registered_host_routes_dispatch_and_session_end() {
    let _g = HOST_LOCK.lock().unwrap();
    clear_browser_host();
    struct Stub {
        ended: parking_lot::Mutex<Vec<String>>,
    }
    impl BrowserHost for Stub {
        fn execute<'a>(
            &'a self,
            session_id: &'a str,
            _agent_id: &'a str,
            call: BrowserCall,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<Value, BrowserError>> + Send + 'a>,
        > {
            Box::pin(async move { Ok(json!({ "sid": session_id, "action": call.action })) })
        }
        fn end_session(&self, session_id: &str) {
            self.ended.lock().push(session_id.to_string());
        }
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
    let stub = Arc::new(Stub {
        ended: parking_lot::Mutex::new(Vec::new()),
    });
    set_browser_host(stub.clone());
    let rt = tokio::runtime::Runtime::new().unwrap();
    let out = rt
        .block_on(dispatch("sess-1", "agent", call("list_tabs", Value::Null)))
        .expect("stub host resolves");
    assert_eq!(out["sid"], "sess-1");
    assert_eq!(out["action"], "list_tabs");
    session_ended("sess-1");
    assert_eq!(stub.ended.lock().as_slice(), &["sess-1".to_string()]);
    clear_browser_host();
}

#[test]
fn browser_call_deserializes_action_args_element() {
    let c: BrowserCall = serde_json::from_value(json!({
        "action": "click",
        "args": {"ref": "@e2"},
        "element": "the login button"
    }))
    .unwrap();
    assert_eq!(c.action, "click");
    assert_eq!(c.args["ref"], "@e2");
    assert_eq!(c.element.as_deref(), Some("the login button"));

    let bare: BrowserCall = serde_json::from_value(json!({"action": "snapshot"})).unwrap();
    assert!(bare.args.is_null());
    assert!(bare.element.is_none());
}

// -- spec-acp-browser-automation-v2 CAP-2: eval transport strategy ---------

#[test]
fn eval_transport_plan_falls_back_to_bridge_exactly_once() {
    let plan = eval_transports();
    // The bridge is the terminal transport everywhere — its outcome
    // (including the `timeout` code) governs the call.
    assert_eq!(plan.last(), Some(&EvalTransport::Bridge));
    // ... and it appears exactly once: a CDP error buys at most one
    // fallback attempt, never a retry loop.
    assert_eq!(
        plan.iter().filter(|t| **t == EvalTransport::Bridge).count(),
        1,
        "the bridge must be a single terminal attempt"
    );
    #[cfg(target_os = "windows")]
    assert_eq!(
        plan,
        &[EvalTransport::Cdp, EvalTransport::Bridge][..],
        "Windows: CDP first, exactly one bridge fallback"
    );
    #[cfg(not(target_os = "windows"))]
    assert_eq!(
        plan,
        &[EvalTransport::Bridge][..],
        "non-Windows: JS-eval bridge only (unchanged)"
    );
}

#[test]
fn eval_fallback_only_for_undelivered_cdp_commands() {
    use cdp_protocol::CdpEvalFailureKind as Kind;
    let mk = |kind: Kind| cdp_protocol::CdpEvalError::new(kind, BrowserError::internal("x"));
    // Transport-establishment failure (the command never reached the
    // page): one bridge retry is side-effect-safe.
    assert!(
        cdp_protocol::should_fallback_to_bridge(&mk(Kind::NotDelivered)),
        "issue/dispatch failures must retry via the bridge"
    );
    // Everything else is terminal: the script ran (page exception), may
    // have run (no reply), or the command was processed (protocol error,
    // malformed reply) — re-running a mutating script could double its
    // side effects.
    for terminal in [
        Kind::PageException,
        Kind::NoReply,
        Kind::ProtocolError,
        Kind::MalformedReply,
    ] {
        assert!(
            !cdp_protocol::should_fallback_to_bridge(&mk(terminal)),
            "{terminal:?} must be terminal (no bridge retry)"
        );
    }
}

#[test]
fn issue_timeout_cancels_queued_closure_only_before_it_issues() {
    use std::sync::atomic::AtomicU8;

    use cdp_protocol::CdpEvalFailureKind as Kind;

    // Timeout wins the race: the closure never issued the command, so the
    // timeout cancels it and the failure is bridge-retry-safe.
    let pending = AtomicU8::new(cdp_protocol::CALL_PENDING);
    let kind = cdp_protocol::issue_timeout_kind(&pending);
    assert_eq!(kind, Kind::NotDelivered);
    // The cancelled state is now terminal for any later observer.
    assert_eq!(cdp_protocol::issue_timeout_kind(&pending), Kind::NoReply);

    // Closure wins the race (already issued): the timeout cannot cancel the
    // command — it is out and may run, so the failure is terminal.
    let issued = AtomicU8::new(cdp_protocol::CALL_ISSUED);
    assert_eq!(cdp_protocol::issue_timeout_kind(&issued), Kind::NoReply);
}

// -- spec-acp-browser-automation-v2 CAP-2: CDP Runtime.evaluate protocol ----

#[test]
fn cdp_evaluate_params_pin_method_expression_and_flags() {
    let params = cdp_protocol::evaluate_params("(function(){ return 1; })()");
    assert_eq!(params["expression"], "(function(){ return 1; })()");
    assert_eq!(params["returnByValue"], true, "value must ride the reply");
    assert_eq!(params["awaitPromise"], true, "promises must resolve first");
    assert_eq!(cdp_protocol::EVALUATE_METHOD, "Runtime.evaluate");
}

#[test]
fn cdp_parse_evaluate_result_returns_value_shapes() {
    // String completion (settle's `document.readyState` probe).
    let v = cdp_protocol::parse_evaluate_result(&json!({
        "result": {"type": "string", "value": "complete"}
    }))
    .expect("string value parses");
    assert_eq!(v, json!("complete"));

    // Object completion (the snapshot script shape: text + ref count).
    let v = cdp_protocol::parse_evaluate_result(&json!({
        "result": {"type": "object", "value": {"text": "- button \"x\" @e1", "refs": 1}}
    }))
    .expect("object value parses");
    assert_eq!(v["refs"], 1);

    // Boolean completion (wait {text} probe).
    let v = cdp_protocol::parse_evaluate_result(&json!({
        "result": {"type": "boolean", "value": true}
    }))
    .expect("boolean value parses");
    assert_eq!(v, json!(true));

    // `undefined` completion: no `value` key → null, parity with the
    // bridge's `JSON.stringify(undefined → null)` reply.
    let v = cdp_protocol::parse_evaluate_result(&json!({"result": {"type": "undefined"}}))
        .expect("undefined completion parses");
    assert!(v.is_null());
}

#[test]
fn cdp_parse_evaluate_result_maps_exceptions_and_malformed_replies() {
    let err = cdp_protocol::parse_evaluate_result(&json!({
        "exceptionDetails": {
            "text": "Uncaught",
            "exception": {"type": "object", "subtype": "error",
                          "description": "TypeError: boom"}
        }
    }))
    .expect_err("page exceptions are errors");
    assert_eq!(err.error.code, ERR_INTERNAL);
    assert_eq!(err.kind, cdp_protocol::CdpEvalFailureKind::PageException);

    // exceptionDetails without a description still map to internal.
    let err = cdp_protocol::parse_evaluate_result(&json!({
        "exceptionDetails": {"text": "Uncaught"}
    }))
    .expect_err("text-only exceptions are errors");
    assert_eq!(err.error.code, ERR_INTERNAL);
    assert_eq!(err.kind, cdp_protocol::CdpEvalFailureKind::PageException);

    // A reply with neither result nor exceptionDetails is malformed.
    let err = cdp_protocol::parse_evaluate_result(&json!({}))
        .expect_err("reply without result is malformed");
    assert_eq!(err.error.code, ERR_INTERNAL);
    assert_eq!(err.kind, cdp_protocol::CdpEvalFailureKind::MalformedReply);
}

#[test]
fn cdp_parse_evaluate_result_maps_protocol_error_replies() {
    let err = cdp_protocol::parse_evaluate_result(&json!({
        "error": {"code": -32601, "message": "Method not found"}
    }))
    .expect_err("protocol error replies are errors");
    assert_eq!(err.error.code, ERR_INTERNAL);
    assert_eq!(err.kind, cdp_protocol::CdpEvalFailureKind::ProtocolError);
    assert!(
        err.error.message.contains("Method not found"),
        "must carry the CDP error string: {}",
        err.error.message
    );

    // A non-object error body is not a protocol error — it falls through
    // to result parsing and surfaces as malformed.
    let err = cdp_protocol::parse_evaluate_result(&json!({"error": "boom"}))
        .expect_err("non-object error body has no result either");
    assert_eq!(err.kind, cdp_protocol::CdpEvalFailureKind::MalformedReply);
}

#[test]
fn cdp_parse_evaluate_result_ignores_null_exception_details() {
    let v = cdp_protocol::parse_evaluate_result(&json!({
        "exceptionDetails": null,
        "result": {"type": "string", "value": "complete"}
    }))
    .expect("a JSON null exceptionDetails must not enter the exception branch");
    assert_eq!(v, json!("complete"));
}

#[test]
fn cdp_parse_evaluate_result_rejects_non_object_result() {
    // A non-object `result` field is a malformed reply — NOT a successful
    // null (the silent-empty-reply bug).
    let err = cdp_protocol::parse_evaluate_result(&json!({"result": "nope"}))
        .expect_err("non-object result must be an error");
    assert_eq!(err.error.code, ERR_INTERNAL);
    assert_eq!(err.kind, cdp_protocol::CdpEvalFailureKind::MalformedReply);
}

// -- spec-acp-browser-automation-v2 CAP-2: snapshot shaping -----------------

#[test]
fn truncate_snapshot_leaves_short_text_untouched() {
    let text = "- button \"Sign in\" @e1\n- text \"hello\"";
    assert_eq!(truncate_snapshot(text.to_string()), text);
}

#[test]
fn truncate_snapshot_caps_long_ascii_text_with_marker() {
    let long = "a".repeat(SNAPSHOT_MAX_CHARS + 1024);
    let out = truncate_snapshot(long);
    assert!(
        out.ends_with(SNAPSHOT_TRUNCATION_MARKER),
        "marker must be appended: {:?}",
        &out[out.len().saturating_sub(40)..]
    );
    let kept = &out[..out.len() - SNAPSHOT_TRUNCATION_MARKER.len()];
    assert_eq!(kept.len(), SNAPSHOT_MAX_CHARS);
    assert!(
        out.len() <= SNAPSHOT_MAX_CHARS + SNAPSHOT_TRUNCATION_MARKER.len(),
        "reply stays inside the child reply bound"
    );
}

#[test]
fn truncate_snapshot_cuts_on_a_char_boundary() {
    // (cap - 1) ASCII bytes then 3-byte chars: the naive cut index would
    // land mid-character.
    let mut long = "a".repeat(SNAPSHOT_MAX_CHARS - 1);
    long.push_str("日本語日本語");
    let out = truncate_snapshot(long.clone());
    assert!(out.ends_with(SNAPSHOT_TRUNCATION_MARKER));
    let kept = &out[..out.len() - SNAPSHOT_TRUNCATION_MARKER.len()];
    // Cut backs up to the last ASCII byte instead of splitting the char.
    assert_eq!(kept.len(), SNAPSHOT_MAX_CHARS - 1);
    assert_eq!(kept, &long[..SNAPSHOT_MAX_CHARS - 1]);
    assert!(kept.is_ascii());
}

#[test]
fn shape_snapshot_rejects_non_object_results() {
    for bad in [Value::Null, json!("oops"), json!(7), json!(true)] {
        let err = shape_snapshot(&bad, "agent-t", 3)
            .expect_err("non-object eval result must error, not read as empty");
        assert_eq!(err.code, ERR_INTERNAL);
    }
}

#[test]
fn shape_snapshot_passes_short_fields_through() {
    let reply = shape_snapshot(
        &json!({
            "url": "https://example.com/a",
            "title": "Example",
            "text": "- button \"x\" @e1",
            "refs": 2
        }),
        "agent-t",
        7,
    )
    .expect("object result shapes");
    assert_eq!(reply["tabId"], "agent-t");
    assert_eq!(reply["epoch"], 7);
    assert_eq!(reply["url"], "https://example.com/a");
    assert_eq!(reply["title"], "Example");
    assert_eq!(reply["snapshot"], "- button \"x\" @e1");
    assert_eq!(reply["refs"], 2);
}

#[test]
fn shape_snapshot_defaults_missing_fields() {
    let reply =
        shape_snapshot(&json!({}), "agent-t", 1).expect("empty object still shapes");
    assert_eq!(reply["snapshot"], "");
    assert!(reply["url"].is_null());
    assert!(reply["title"].is_null());
    assert_eq!(reply["refs"], 0);
}

#[test]
fn shape_snapshot_caps_page_controlled_url_and_title() {
    let ascii = "a".repeat(SNAPSHOT_META_MAX_CHARS + 512);
    // 3-byte chars straddling the cap: the cut must back up to a boundary.
    let cjk = "日".repeat(SNAPSHOT_META_MAX_CHARS / 3 + 8);
    let reply = shape_snapshot(
        &json!({
            "url": format!("https://example.com/{ascii}"),
            "title": cjk,
            "text": "t",
            "refs": 0
        }),
        "agent-t",
        1,
    )
    .expect("object result shapes");
    let url = reply["url"].as_str().expect("url stays a string");
    assert!(url.len() <= SNAPSHOT_META_MAX_CHARS);
    assert!(url.starts_with("https://example.com/"));
    let title = reply["title"].as_str().expect("title stays a string");
    assert!(title.len() <= SNAPSHOT_META_MAX_CHARS);
    assert!(title.chars().all(|c| c == '日'), "no partial char");
    // Non-string page values pass through untouched (only strings are
    // page-controlled bloat vectors).
    let reply = shape_snapshot(&json!({"url": 7, "title": false}), "agent-t", 1)
        .expect("object result shapes");
    assert_eq!(reply["url"], 7);
    assert_eq!(reply["title"], false);
}
