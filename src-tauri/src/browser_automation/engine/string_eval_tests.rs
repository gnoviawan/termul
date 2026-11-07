use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::json;

use super::*;

type Job = Box<dyn FnOnce(&()) + Send>;

/// A UI thread that runs queued closures only when the test lets it.
#[derive(Clone, Default)]
struct FakeUiQueue(Arc<Mutex<Vec<Job>>>);

impl FakeUiQueue {
    fn push(&self, job: Job) -> Result<(), ()> {
        self.0.lock().push(job);
        Ok(())
    }

    fn drain(&self) {
        for job in std::mem::take(&mut *self.0.lock()) {
            job(&());
        }
    }
}

const SHORT: Duration = Duration::from_millis(20);

fn flag_issue(ran: &Arc<AtomicBool>) -> impl FnOnce(&(), Completion) + Send + 'static {
    let ran = ran.clone();
    move |_, done| {
        ran.store(true, Ordering::SeqCst);
        let _ = done.send(Ok("{\"ok\":true}".into()));
    }
}

#[test]
fn a_completed_call_yields_the_helpers_json_value() {
    assert_eq!(
        parse(Ok(r#"{"rect":{"cx":1.5},"role":"button"}"#.into())),
        Ok(json!({ "rect": { "cx": 1.5 }, "role": "button" }))
    );
    assert_eq!(parse(Ok("null".into())), Ok(Value::Null));
}

#[test]
fn engine_failures_and_unusable_text_are_terminal() {
    assert_eq!(
        parse(Err(EngineErrorKind::PageException)),
        Err(EngineError::new(EngineErrorKind::PageException))
    );
    assert_eq!(
        parse(Ok("undefined".into())),
        Err(EngineError::new(EngineErrorKind::Malformed))
    );
}

#[test]
fn webkit_engines_declare_isolated_eval_the_policy_hooks_and_synthetic_input() {
    let facts = isolated_facts();
    assert!(facts.traits.isolated_world);
    assert_eq!(facts.capabilities.get(CapabilityId::IsolatedEval), Support::Trusted);
    assert_eq!(
        facts.capabilities.get(CapabilityId::PersistentProfile),
        crate::browser_automation::engine::profile::persistent_profile_support()
    );
    for id in [
        CapabilityId::PointerClick,
        CapabilityId::TrustedKey,
        CapabilityId::PointerMove,
        CapabilityId::Wheel,
    ] {
        assert_eq!(facts.capabilities.get(id), Support::Synthetic, "{id:?}");
    }
    for id in [
        CapabilityId::Screenshot,
        CapabilityId::NavigationIntercept,
        CapabilityId::NewWindowIntercept,
        CapabilityId::DialogIntercept,
        CapabilityId::PermissionIntercept,
        CapabilityId::ExternalProtocolIntercept,
        CapabilityId::DownloadIntercept,
        CapabilityId::FileChooser,
    ] {
        assert_eq!(facts.capabilities.get(id), Support::Trusted, "{id:?}");
    }
    for id in [CapabilityId::ScriptMessage, CapabilityId::Drag] {
        assert!(matches!(facts.capabilities.get(id), Support::Unavailable(_)), "{id:?}");
    }

    let old = no_world_facts("needs a newer OS");
    assert!(!old.traits.isolated_world);
    assert_eq!(
        old.capabilities.get(CapabilityId::IsolatedEval),
        Support::Unavailable("needs a newer OS")
    );
}

#[test]
fn the_webkit_call_body_is_static_and_the_parameters_ride_one_string() {
    let hostile = "\"); window.leak = 1; (\"";
    let script = super::super::assets::fill("html>body:nth-of-type(1)", hostile);
    let body = call_body(&script);
    assert!(!body.contains(hostile));
    assert!(body.contains(&format!("JSON.parse({PARAMS_ARG})")));
    assert!(body.contains(script.helper.body));
    assert_eq!(
        serde_json::from_str::<Value>(&params_json(&script)).unwrap(),
        json!({ "path": "html>body:nth-of-type(1)", "value": hostile })
    );
}

#[tokio::test]
async fn a_queued_call_that_runs_in_time_returns_the_helpers_value() {
    let queue = FakeUiQueue::default();
    let ran = Arc::new(AtomicBool::new(false));
    let pending = run(|job| queue.push(job), Duration::from_secs(5), flag_issue(&ran));
    let (result, ()) = tokio::join!(pending, async { queue.drain() });
    assert_eq!(result, Ok(json!({ "ok": true })));
    assert!(ran.load(Ordering::SeqCst));
}

#[tokio::test]
async fn a_closure_the_ui_thread_reaches_after_the_timeout_does_not_issue() {
    let queue = FakeUiQueue::default();
    let ran = Arc::new(AtomicBool::new(false));
    let result = run(|job| queue.push(job), SHORT, flag_issue(&ran)).await;
    assert_eq!(result, Err(EngineError::new(EngineErrorKind::Timeout)));
    queue.drain();
    assert!(!ran.load(Ordering::SeqCst), "the late closure ran its action");
}

#[tokio::test]
async fn dropping_the_awaiting_future_also_stands_the_queued_closure_down() {
    let queue = FakeUiQueue::default();
    let ran = Arc::new(AtomicBool::new(false));
    let outer = tokio::time::timeout(
        SHORT,
        run(|job| queue.push(job), Duration::from_secs(5), flag_issue(&ran)),
    )
    .await;
    assert!(outer.is_err());
    queue.drain();
    assert!(!ran.load(Ordering::SeqCst), "the late closure ran its action");
}

#[tokio::test]
async fn a_call_issued_before_the_deadline_but_unanswered_is_terminal() {
    let queue = FakeUiQueue::default();
    let ran = Arc::new(AtomicBool::new(false));
    let issued = ran.clone();
    let pending = run(
        |job| queue.push(job),
        SHORT,
        move |_: &(), _done: Completion| issued.store(true, Ordering::SeqCst),
    );
    let (result, ()) = tokio::join!(pending, async { queue.drain() });
    assert!(ran.load(Ordering::SeqCst));
    assert_eq!(result, Err(EngineError::new(EngineErrorKind::NoReply)));
}

#[tokio::test]
async fn a_queue_that_refuses_the_closure_is_a_dispatch_failure() {
    let ran = Arc::new(AtomicBool::new(false));
    let result = run(|_job| Err(()), SHORT, flag_issue(&ran)).await;
    assert_eq!(result, Err(EngineError::new(EngineErrorKind::Dispatch)));
}
