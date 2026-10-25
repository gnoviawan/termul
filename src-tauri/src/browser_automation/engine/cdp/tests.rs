use parking_lot::Mutex;
use serde_json::{json, Value};

use super::*;
use crate::browser_automation::engine::{assets, EngineFuture};

#[test]
fn a_helper_call_passes_agent_strings_as_a_by_value_argument() {
    let script = assets::fill("html>body:nth-of-type(1)", "\"); leak(); (\"");
    let params = call_params(&script, 7);
    assert_eq!(params["executionContextId"], 7);
    assert_eq!(
        params["arguments"],
        json!([{ "value": { "path": "html>body:nth-of-type(1)", "value": "\"); leak(); (\"" } }])
    );
    let declaration = params["functionDeclaration"].as_str().unwrap();
    assert_eq!(declaration, format!("function (p) {{\n{}\n}}", assets::FILL.body));
    assert_eq!(params["returnByValue"], true, "value must ride the reply");
    assert_eq!(params["awaitPromise"], true, "promises must resolve first");
}

#[test]
fn cdp_parse_evaluate_result_returns_value_shapes() {
    let v = parse_evaluate_result(&json!({
        "result": {"type": "string", "value": "complete"}
    }))
    .expect("string value parses");
    assert_eq!(v, json!("complete"));

    let v = parse_evaluate_result(&json!({
        "result": {"type": "object", "value": {"items": [], "refs": 1}}
    }))
    .expect("object value parses");
    assert_eq!(v["refs"], 1);

    let v = parse_evaluate_result(&json!({
        "result": {"type": "boolean", "value": true}
    }))
    .expect("boolean value parses");
    assert_eq!(v, json!(true));

    // An `undefined` return has no `value` key and reads as null.
    let v = parse_evaluate_result(&json!({"result": {"type": "undefined"}}))
        .expect("undefined completion parses");
    assert!(v.is_null());
}

#[test]
fn cdp_parse_evaluate_result_maps_exceptions_and_malformed_replies() {
    let err = parse_evaluate_result(&json!({
        "exceptionDetails": {
            "text": "Uncaught",
            "exception": {"type": "object", "subtype": "error",
                          "description": "TypeError: boom"}
        }
    }))
    .expect_err("page exceptions are errors");
    assert_eq!(err, EngineError::new(EngineErrorKind::PageException));

    let err = parse_evaluate_result(&json!({"exceptionDetails": {"text": "Uncaught"}}))
        .expect_err("text-only exceptions are errors");
    assert_eq!(err.kind, EngineErrorKind::PageException);

    let err = parse_evaluate_result(&json!({})).expect_err("reply without result is malformed");
    assert_eq!(err, EngineError::new(EngineErrorKind::Malformed));
}

#[test]
fn cdp_parse_evaluate_result_maps_protocol_error_replies() {
    let err = parse_evaluate_result(&json!({
        "error": {"code": -32601, "message": "Method not found"}
    }))
    .expect_err("protocol error replies are errors");
    assert_eq!(err, EngineError::new(EngineErrorKind::Protocol));

    // A non-object error body is not a protocol error: it falls through
    // to result parsing and surfaces as malformed.
    let err = parse_evaluate_result(&json!({"error": "boom"}))
        .expect_err("non-object error body has no result either");
    assert_eq!(err.kind, EngineErrorKind::Malformed);
}

#[test]
fn cdp_parse_evaluate_result_ignores_null_exception_details() {
    let v = parse_evaluate_result(&json!({
        "exceptionDetails": null,
        "result": {"type": "string", "value": "complete"}
    }))
    .expect("a JSON null exceptionDetails must not enter the exception branch");
    assert_eq!(v, json!("complete"));
}

#[test]
fn cdp_parse_evaluate_result_rejects_non_object_result() {
    let err = parse_evaluate_result(&json!({"result": "nope"}))
        .expect_err("non-object result must be an error");
    assert_eq!(err.kind, EngineErrorKind::Malformed);
}

/// Records every call and answers each method from its scripted reply
/// (an empty object when none is scripted).
struct RecordingTransport {
    calls: Mutex<Vec<(String, &'static str, Value)>>,
    /// The frame of every `call_in`, in order.
    frames: Mutex<Vec<Option<String>>>,
    replies: Vec<(CdpMethod, Result<Value, EngineError>)>,
}

impl CdpTransport for RecordingTransport {
    fn call<'a>(
        &'a self,
        tab: &'a str,
        method: CdpMethod,
        params: Value,
    ) -> EngineFuture<'a, Value> {
        self.calls
            .lock()
            .push((tab.to_string(), method.as_str(), params));
        let out = self
            .replies
            .iter()
            .find(|(m, _)| *m == method)
            .map_or(Ok(json!({})), |(_, r)| r.clone());
        Box::pin(async move { out })
    }

    fn call_in<'a>(
        &'a self,
        tab: &'a str,
        frame: Option<&'a str>,
        method: CdpMethod,
        params: Value,
    ) -> EngineFuture<'a, Value> {
        self.frames.lock().push(frame.map(str::to_string));
        self.call(tab, method, params)
    }
}

fn transport(replies: Vec<(CdpMethod, Result<Value, EngineError>)>) -> RecordingTransport {
    RecordingTransport {
        calls: Mutex::new(Vec::new()),
        frames: Mutex::new(Vec::new()),
        replies,
    }
}

fn isolated_world_replies(call: Result<Value, EngineError>) -> Vec<(CdpMethod, Result<Value, EngineError>)> {
    vec![
        (
            CdpMethod::PageGetFrameTree,
            Ok(json!({ "frameTree": { "frame": { "id": "MAIN" } } })),
        ),
        (
            CdpMethod::PageCreateIsolatedWorld,
            Ok(json!({ "executionContextId": 42 })),
        ),
        (CdpMethod::RuntimeCallFunctionOn, call),
    ]
}

#[tokio::test]
async fn click_at_presses_then_releases_left_button_at_the_point() {
    let t = transport(vec![]);
    click_at(&t, "agent-a", Point { x: 10.5, y: 20.0 })
        .await
        .expect("click succeeds");
    let calls = t.calls.lock();
    let kinds: Vec<&str> = calls.iter().map(|c| c.2["type"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["mousePressed", "mouseReleased"]);
    for (tab, method, params) in calls.iter() {
        assert_eq!(tab, "agent-a");
        assert_eq!(*method, "Input.dispatchMouseEvent");
        assert_eq!(params["x"], 10.5);
        assert_eq!(params["y"], 20.0);
        assert_eq!(params["button"], "left");
    }
}

#[tokio::test]
async fn evaluate_calls_the_helper_in_the_main_frames_isolated_world() {
    let t = transport(isolated_world_replies(Ok(
        json!({ "result": { "type": "string", "value": "complete" } }),
    )));
    assert_eq!(
        evaluate(&t, "agent-a", &assets::ready_state()).await,
        Ok(json!("complete"))
    );
    let calls = t.calls.lock();
    let methods: Vec<&str> = calls.iter().map(|c| c.1).collect();
    assert_eq!(
        methods,
        ["Page.getFrameTree", "Page.createIsolatedWorld", "Runtime.callFunctionOn"]
    );
    assert_eq!(calls[1].2, json!({ "frameId": "MAIN", "worldName": "termul_agent" }));
    assert_eq!(calls[2].2["executionContextId"], 42);
}

#[tokio::test]
async fn a_failure_before_the_helper_call_never_calls_it() {
    let lost = EngineError::new(EngineErrorKind::NoReply);
    let mut replies = isolated_world_replies(Ok(json!({})));
    replies[1].1 = Err(lost);
    let t = transport(replies);
    assert_eq!(evaluate(&t, "agent-a", &assets::snapshot()).await, Err(lost));
    assert!(t.calls.lock().iter().all(|c| c.1 != "Runtime.callFunctionOn"));
    let t = transport(vec![(CdpMethod::PageGetFrameTree, Ok(json!({})))]);
    assert_eq!(
        evaluate(&t, "agent-a", &assets::snapshot()).await,
        Err(EngineError::new(EngineErrorKind::Malformed))
    );
    assert!(t.calls.lock().iter().all(|c| c.1 != "Runtime.callFunctionOn"));

    let ran = EngineError::new(EngineErrorKind::Timeout);
    let t = transport(isolated_world_replies(Err(ran)));
    assert_eq!(evaluate(&t, "agent-a", &assets::snapshot()).await, Err(ran));
}

#[tokio::test]
async fn capture_screenshot_decodes_png_bytes_and_rejects_missing_data() {
    let t = transport(vec![(
        CdpMethod::PageCaptureScreenshot,
        Ok(json!({"data": "iVBORw=="})),
    )]);
    assert_eq!(
        capture_screenshot(&t, "agent-a").await,
        Ok(vec![0x89, 0x50, 0x4e, 0x47])
    );
    assert_eq!(t.calls.lock()[0].2, json!({"format": "png"}));

    let t = transport(vec![]);
    assert_eq!(
        capture_screenshot(&t, "agent-a").await,
        Err(EngineError::new(EngineErrorKind::Malformed))
    );
}

#[tokio::test]
async fn a_frame_helper_runs_in_that_frames_world_on_its_route() {
    let t = transport(isolated_world_replies(Ok(json!({ "result": { "type": "string", "value": "x" } }))));
    assert_eq!(evaluate_in(&t, "agent-a", Some("F9"), &assets::ready_state()).await, Ok(json!("x")));
    let calls = t.calls.lock();
    let methods: Vec<&str> = calls.iter().map(|c| c.1).collect();
    assert_eq!(methods, ["Page.createIsolatedWorld", "Runtime.callFunctionOn"], "a frame's id is its own root");
    assert_eq!(calls[0].2, json!({ "frameId": "F9", "worldName": "termul_agent" }));
    assert_eq!(*t.frames.lock(), [Some("F9".to_string()), Some("F9".to_string())]);
}

#[tokio::test]
async fn a_frame_the_engine_no_longer_has_is_gone() {
    let refused = EngineError::new(EngineErrorKind::Protocol);
    let t = transport(vec![(CdpMethod::PageCreateIsolatedWorld, Err(refused))]);
    assert_eq!(
        evaluate_in(&t, "agent-a", Some("F9"), &assets::snapshot()).await,
        Err(EngineError::new(EngineErrorKind::FrameGone))
    );
    let t = transport(vec![
        (CdpMethod::PageGetFrameTree, Ok(json!({ "frameTree": { "frame": { "id": "MAIN" } } }))),
        (CdpMethod::PageCreateIsolatedWorld, Err(refused)),
    ]);
    assert_eq!(evaluate(&t, "agent-a", &assets::snapshot()).await, Err(refused), "the page itself is never gone");
}

#[tokio::test]
async fn a_frames_owner_path_is_read_from_its_element_in_the_parent() {
    let t = transport(vec![
        (CdpMethod::DomGetFrameOwner, Ok(json!({ "backendNodeId": 31 }))),
        (CdpMethod::PageGetFrameTree, Ok(json!({ "frameTree": { "frame": { "id": "MAIN" } } }))),
        (CdpMethod::PageCreateIsolatedWorld, Ok(json!({ "executionContextId": 42 }))),
        (CdpMethod::DomResolveNode, Ok(json!({ "object": { "objectId": "obj-1" } }))),
        (CdpMethod::RuntimeCallFunctionOn, Ok(json!({ "result": { "type": "string", "value": "html>body>iframe:nth-of-type(2)" } }))),
    ]);
    assert_eq!(owner_path(&t, "agent-a", None, "F9").await, Ok("html>body>iframe:nth-of-type(2)".to_string()));
    let calls = t.calls.lock();
    assert_eq!(calls[0].2, json!({ "frameId": "F9" }));
    assert_eq!(calls[3].2, json!({ "backendNodeId": 31, "executionContextId": 42 }));
    assert_eq!(calls[4].2["objectId"], "obj-1");
    assert!(calls[4].2.get("executionContextId").is_none(), "the helper is bound to the element");
    assert_eq!(calls[4].2["functionDeclaration"], format!("function (p) {{\n{}\n}}", assets::OWNER_PATH.body));
}

#[test]
fn in_process_frames_are_listed_with_their_parents() {
    let tree = json!({ "frameTree": {
        "frame": { "id": "MAIN" },
        "childFrames": [
            { "frame": { "id": "A" }, "childFrames": [{ "frame": { "id": "A1" } }] },
            { "frame": { "id": "B" } }
        ]
    }});
    assert_eq!(
        child_frames(&tree),
        [("A".to_string(), None), ("A1".to_string(), Some("A".to_string())), ("B".to_string(), None)]
    );
    assert!(child_frames(&json!({})).is_empty());
}

#[tokio::test]
async fn set_input_files_hands_the_staged_path_to_the_file_input_by_handle() {
    let t = transport(isolated_world_replies(Ok(json!({
        "result": { "type": "object", "subtype": "node", "objectId": "obj-7" }
    }))));
    let staged = [std::path::PathBuf::from("/data/staging/u1/report.pdf")];
    set_input_files(&t, "agent-a", None, "html>body>input:nth-of-type(1)", &staged)
        .await
        .expect("files set");
    let calls = t.calls.lock();
    let methods: Vec<&str> = calls.iter().map(|c| c.1).collect();
    assert_eq!(
        methods,
        [
            "Page.getFrameTree",
            "Page.createIsolatedWorld",
            "Runtime.callFunctionOn",
            "DOM.setFileInputFiles"
        ]
    );
    assert_eq!(calls[2].2["returnByValue"], false, "the element comes back by reference");
    assert_eq!(calls[2].2["executionContextId"], 42);
    assert_eq!(
        calls[3].2,
        json!({ "files": ["/data/staging/u1/report.pdf"], "objectId": "obj-7" })
    );
}

#[tokio::test]
async fn set_input_files_sets_nothing_when_the_path_names_no_file_input() {
    let t = transport(isolated_world_replies(Ok(json!({
        "result": { "type": "object", "subtype": "null", "value": null }
    }))));
    let staged = [std::path::PathBuf::from("/data/staging/u1/report.pdf")];
    assert_eq!(
        set_input_files(&t, "agent-a", None, "html>body>a:nth-of-type(1)", &staged).await,
        Err(EngineError::new(EngineErrorKind::PageException))
    );
    assert!(t.calls.lock().iter().all(|c| c.1 != "DOM.setFileInputFiles"));
}

#[test]
fn every_session_cancels_file_choosers_with_the_page_domain_on() {
    let calls = file_chooser_calls();
    let methods: Vec<&str> = calls.iter().map(|(m, _)| m.as_str()).collect();
    assert_eq!(methods, ["Page.enable", "Page.setInterceptFileChooserDialog"]);
    assert_eq!(calls[1].1, json!({ "enabled": true, "cancel": true }), "the native dialog never opens");
}
