use super::*;

/// Alias for the shared test lock (see `TEST_HOST_LOCK`).
use super::TEST_HOST_LOCK as HOST_LOCK;

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
