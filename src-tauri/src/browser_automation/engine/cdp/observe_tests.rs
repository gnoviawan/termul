use serde_json::json;

use super::*;

fn console(level: ConsoleLevel, text: &str, source: Option<&str>) -> Observed {
    Observed::Console(ConsoleEntry::new(level, text, source))
}

#[test]
fn console_calls_read_primitives_and_object_previews() {
    let mut t = NetworkTracker::default();
    let params = json!({
        "type": "warning",
        "args": [
            { "type": "string", "value": "low disk:" },
            { "type": "number", "value": 3, "description": "3" },
            { "type": "object", "subtype": "null", "value": null },
            { "type": "undefined" },
            { "type": "object", "className": "Object", "description": "Object", "objectId": "1" },
            { "type": "number", "unserializableValue": "NaN", "description": "NaN" }
        ],
        "stackTrace": { "callFrames": [{ "url": "http://127.0.0.1:5191/console.html?x=1" }] }
    });
    assert_eq!(
        parse(&mut t, "", "Runtime.consoleAPICalled", &params),
        console(
            ConsoleLevel::Warn,
            "low disk: 3 null undefined Object NaN",
            Some("http://127.0.0.1:5191/console.html")
        )
    );
}

#[test]
fn exceptions_and_engine_log_entries_are_console_entries() {
    let mut t = NetworkTracker::default();
    let thrown = json!({ "exceptionDetails": { "text": "Uncaught", "exception": { "description": "TypeError: boom" } } });
    assert_eq!(
        parse(&mut t, "", "Runtime.exceptionThrown", &thrown),
        console(ConsoleLevel::Error, "TypeError: boom", None)
    );
    let log = json!({ "entry": { "source": "network", "level": "error", "text": "Failed to load resource: 404", "url": "http://h/missing.png?v=1" } });
    assert_eq!(
        parse(&mut t, "S1", "Log.entryAdded", &log),
        console(ConsoleLevel::Error, "Failed to load resource: 404", Some("http://h/missing.png"))
    );
}

#[test]
fn a_request_reports_once_it_ends_and_redirect_hops_report_their_status() {
    let mut t = NetworkTracker::default();
    let sent = |url: &str, redirect: Option<u16>, at: f64| {
        let mut p = json!({ "requestId": "7", "request": { "url": url, "method": "GET" }, "type": "Document", "timestamp": at });
        if let Some(status) = redirect {
            p["redirectResponse"] = json!({ "status": status });
        }
        p
    };
    assert_eq!(parse(&mut t, "", "Network.requestWillBeSent", &sent("http://h/redirect?q=1", None, 10.0)), Observed::None);
    let hop = parse(&mut t, "", "Network.requestWillBeSent", &sent("http://h/target", Some(302), 10.1));
    let Observed::Network(hop) = hop else { panic!("{hop:?}") };
    assert_eq!((hop.url.as_str(), hop.status, hop.resource.as_deref()), ("http://h/redirect", Some(302), Some("document")));
    parse(&mut t, "", "Network.responseReceived", &json!({ "requestId": "7", "response": { "status": 200 }, "type": "Document" }));
    let done = parse(&mut t, "", "Network.loadingFinished", &json!({ "requestId": "7", "timestamp": 10.35 }));
    let Observed::Network(done) = done else { panic!("{done:?}") };
    assert_eq!((done.url.as_str(), done.status, done.duration_ms), ("http://h/target", Some(200), Some(250)));
}

#[test]
fn request_ids_are_scoped_to_their_session() {
    let mut t = NetworkTracker::default();
    let sent = json!({ "requestId": "1", "request": { "url": "http://a/x", "method": "GET" }, "timestamp": 1.0 });
    parse(&mut t, "", "Network.requestWillBeSent", &sent);
    parse(&mut t, "S9", "Network.requestWillBeSent", &json!({ "requestId": "1", "request": { "url": "http://b/y", "method": "POST" }, "timestamp": 1.0 }));
    let failed = parse(&mut t, "S9", "Network.loadingFailed", &json!({ "requestId": "1", "timestamp": 1.5, "errorText": "net::ERR_FAILED" }));
    let Observed::Network(failed) = failed else { panic!("{failed:?}") };
    assert_eq!((failed.url.as_str(), failed.method.as_str(), failed.failed), ("http://b/y", "POST", true));
    assert_eq!(parse(&mut t, "S9", "Target.detachedFromTarget", &json!({ "sessionId": "S9" })), Observed::Detached { session: "S9".into() });
    let page = parse(&mut t, "", "Network.loadingFinished", &json!({ "requestId": "1", "timestamp": 2.0 }));
    assert!(matches!(page, Observed::Network(ref e) if e.url == "http://a/x"), "{page:?}");
}

#[test]
fn only_frame_targets_get_frame_sessions() {
    let mut t = NetworkTracker::default();
    let attached = |kind: &str| json!({ "sessionId": "S2", "targetInfo": { "targetId": "F2", "type": kind, "url": "https://x/" }, "waitingForDebugger": false });
    assert_eq!(
        parse(&mut t, "", "Target.attachedToTarget", &attached("iframe")),
        Observed::FrameAttached { session: "S2".into(), frame: "F2".into() }
    );
    assert_eq!(parse(&mut t, "", "Target.attachedToTarget", &attached("worker")), Observed::None);
    assert_eq!(parse(&mut t, "", "Page.frameNavigated", &json!({})), Observed::None);
}

#[test]
fn a_redirect_ends_the_earlier_hop_with_its_status() {
    let mut t = NetworkTracker::default();
    assert_eq!(t.request("1", "GET", "http://h/redirect?x=1", Some("Document"), None, 1.0), None);
    let hop = t.request("1", "GET", "http://h/target", Some("Document"), Some(302), 1.25);
    assert_eq!(
        hop,
        Some(NetworkEntry {
            method: "GET".into(),
            url: "http://h/redirect".into(),
            status: Some(302),
            resource: Some("document".into()),
            duration_ms: Some(250),
            failed: false,
        })
    );
    t.response("1", 200, None);
    let done = t.finished("1", 1.5).unwrap();
    assert_eq!((done.url.as_str(), done.status, done.duration_ms), ("http://h/target", Some(200), Some(250)));
    assert_eq!(t.finished("1", 2.0), None);
}

#[test]
fn failures_and_unknown_ids() {
    let mut t = NetworkTracker::default();
    t.request("a", "POST", "https://h/api", None, None, 0.0);
    t.response("a", 500, Some("Fetch"));
    let failed = t.failed("a", 0.1).unwrap();
    assert!(failed.failed);
    assert_eq!((failed.status, failed.resource.as_deref()), (Some(500), Some("fetch")));
    assert_eq!(t.failed("zzz", 1.0), None);
    t.request("s1:9", "GET", "https://h/x", None, None, 0.0);
    t.forget_prefix("s1:");
    assert_eq!(t.finished("s1:9", 1.0), None);
}

#[test]
fn every_subscribed_event_is_parsed_and_every_session_gets_the_same_domains() {
    let methods: Vec<&str> = enable_calls().iter().map(|(m, _)| m.as_str()).collect();
    assert_eq!(methods, ["Runtime.enable", "Log.enable", "Network.enable", "Target.setAutoAttach"]);
    assert_eq!(enable_calls()[2].1["maxTotalBufferSize"], 0, "no bodies are kept");
    assert_eq!(enable_calls()[3].1["flatten"], true);
    let domains: Vec<&str> = EVENTS.iter().filter_map(|e| e.split('.').next()).collect();
    for domain in ["Runtime", "Log", "Network", "Target"] {
        assert!(domains.contains(&domain), "{domain}");
    }
}
