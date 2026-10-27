use std::io::Write;
use std::sync::Arc;

use tokio::sync::broadcast::error::TryRecvError;
use tokio::sync::Mutex as AsyncMutex;

use crate::trackers::TerminalEventHub;
use crate::web::log_capture::capture_tracing;

use super::frame::SessionRpcResult;
use super::gate_test_support::{
    blocking_gate, capture, capture_gate, count, expected_write, outcome_cases, provider,
    restore_during_write, spawn_gate_write, spawn_submit, start_completion, trusted_gate,
    FailingWriter, PtyWriter,
};
use super::CLEAR_LINE_SEQUENCE;
use super::RESTORE_PROMPT_SEQUENCE;

#[tokio::test]
async fn submit_writes_the_draft_once() {
    let (bytes, gate) = capture_gate();
    gate.observe_output(b"\x1b[?2004h");

    let result = gate.submit("git sta", true).await;

    assert_eq!(result, SessionRpcResult::Accepted);
    let written = bytes.lock().expect("bytes").clone();
    let expected = format!("{CLEAR_LINE_SEQUENCE}\x1b[200~git sta\x1b[201~\r");
    assert_eq!(String::from_utf8(written.clone()).expect("utf8"), expected);
    assert_eq!(
        count(&written, b"git sta"),
        1,
        "the draft is written exactly once"
    );
    assert_eq!(count(&written, b"\r"), 1, "exactly one accept terminator");
}

#[tokio::test]
async fn submit_frames_multiline_draft_into_single_submission() {
    let (bytes, gate) = capture_gate();
    gate.observe_output(b"\x1b[?2004h");

    let result = gate.submit("echo a\necho b", true).await;

    assert_eq!(result, SessionRpcResult::Accepted);
    let written = bytes.lock().expect("bytes").clone();
    let expected = format!("{CLEAR_LINE_SEQUENCE}\x1b[200~echo a\necho b\x1b[201~\r");
    assert_eq!(String::from_utf8(written.clone()).expect("utf8"), expected);
    assert_eq!(count(&written, b"echo a\necho b"), 1);
    assert_eq!(count(&written, b"\x1b[200~"), 1);
    assert_eq!(count(&written, b"\x1b[201~\r"), 1);
    assert_eq!(count(&written, b"\r"), 1, "one accept after paste end");
}

#[tokio::test]
async fn submit_refuses_control_bytes_before_any_write() {
    let (bytes, gate) = capture_gate();

    let result = gate.submit("safe\u{1b}[201~\recho injected", true).await;

    assert_eq!(result, SessionRpcResult::PreWrite);
    assert!(
        bytes.lock().expect("bytes").is_empty(),
        "PreWrite must not write any PTY byte"
    );
    assert!(
        gate.trusted_at_prompt(),
        "a pre-write refusal keeps the trusted prompt"
    );
}

#[tokio::test]
async fn submit_wraps_when_bracketed_paste_is_on() {
    let (bytes, gate) = capture_gate();
    gate.observe_output(b"\x1b[?2004h");

    let result = gate.submit("git sta", true).await;

    assert_eq!(result, SessionRpcResult::Accepted);
    let written = bytes.lock().expect("bytes").clone();
    let expected = format!("{CLEAR_LINE_SEQUENCE}\x1b[200~git sta\x1b[201~\r");
    assert_eq!(String::from_utf8(written.clone()).expect("utf8"), expected);
}

#[tokio::test]
async fn submit_writes_plain_bytes_when_bracketed_paste_is_off() {
    let (bytes, gate) = capture_gate();

    let result = gate.submit("git sta", true).await;

    assert_eq!(result, SessionRpcResult::Accepted);
    let written = bytes.lock().expect("bytes").clone();
    let expected = format!("{CLEAR_LINE_SEQUENCE}git sta\r");
    assert_eq!(String::from_utf8(written.clone()).expect("utf8"), expected);
    assert_eq!(count(&written, b"\x1b[200~"), 0);
    assert_eq!(count(&written, b"\x1b[201~"), 0);
    assert_eq!(count(&written, b"\r"), 1);
}

#[tokio::test(start_paused = true)]
async fn submit_waits_for_bracketed_paste_when_previously_enabled() {
    let (bytes, gate) = capture_gate();
    let gate = Arc::new(gate);
    gate.observe_output(b"\x1b[?2004h");
    gate.observe_output(b"\x1b[?2004l");

    let gate_clone = gate.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        gate_clone.observe_output(b"\x1b[?2004h");
    });

    let result = gate.submit("git sta", true).await;

    assert_eq!(result, SessionRpcResult::Accepted);
    let written = bytes.lock().expect("bytes").clone();
    let expected = format!("{CLEAR_LINE_SEQUENCE}\x1b[200~git sta\x1b[201~\r");
    assert_eq!(String::from_utf8(written.clone()).expect("utf8"), expected);
}

#[tokio::test(start_paused = true)]
async fn submit_writes_plain_when_bracketed_paste_wait_times_out() {
    let (bytes, gate) = capture_gate();
    let gate = Arc::new(gate);
    gate.observe_output(b"\x1b[?2004h");
    gate.observe_output(b"\x1b[?2004l");

    let hub = TerminalEventHub::standalone();
    let mut events = hub.subscribe();

    let result = gate.submit("git sta", true).await;

    assert_eq!(result, SessionRpcResult::Accepted);
    let written = bytes.lock().expect("bytes").clone();
    let expected = format!("{CLEAR_LINE_SEQUENCE}git sta\r");
    assert_eq!(String::from_utf8(written.clone()).expect("utf8"), expected);
    assert_eq!(count(&written, b"\x1b[200~"), 0);
    assert_eq!(count(&written, b"\x1b[201~"), 0);
    assert_eq!(count(&written, RESTORE_PROMPT_SEQUENCE.as_bytes()), 0);
    assert!(matches!(events.try_recv(), Err(TryRecvError::Empty)));
}

#[tokio::test(start_paused = true)]
async fn submit_never_waits_when_bracketed_paste_was_never_enabled() {
    let (bytes, gate) = capture_gate();
    let start = tokio::time::Instant::now();

    let result = gate.submit("git sta", true).await;

    assert_eq!(result, SessionRpcResult::Accepted);
    assert_eq!(
        tokio::time::Instant::now() - start,
        std::time::Duration::ZERO
    );
    let written = bytes.lock().expect("bytes").clone();
    let expected = format!("{CLEAR_LINE_SEQUENCE}git sta\r");
    assert_eq!(String::from_utf8(written.clone()).expect("utf8"), expected);
    assert_eq!(count(&written, b"\x1b[200~"), 0);
    assert_eq!(count(&written, b"\x1b[201~"), 0);
}

#[tokio::test]
async fn submit_empty_draft_never_wraps() {
    let (bytes, gate) = capture_gate();
    gate.observe_output(b"\x1b[?2004h");

    let result = gate.submit("", true).await;

    assert_eq!(result, SessionRpcResult::Accepted);
    let written = bytes.lock().expect("bytes").clone();
    let expected = format!("{CLEAR_LINE_SEQUENCE}\r");
    assert_eq!(String::from_utf8(written.clone()).expect("utf8"), expected);
    assert_eq!(count(&written, b"\x1b[200~"), 0);
    assert_eq!(count(&written, b"\x1b[201~"), 0);
}

#[tokio::test]
async fn submit_accepts_tab_and_newline() {
    let (bytes, gate) = capture_gate();

    let result = gate.submit("echo a\techo b\necho c", true).await;

    assert_eq!(result, SessionRpcResult::Accepted);
    let written = bytes.lock().expect("bytes").clone();
    assert!(
        written
            .windows(b"echo a\techo b\necho c".len())
            .any(|part| part == b"echo a\techo b\necho c"),
        "tab and newline drafts are written: {}",
        String::from_utf8_lossy(&written)
    );
    assert!(!gate.trusted_at_prompt());
}

#[tokio::test]
async fn missing_writer_is_pre_write() {
    let writer: PtyWriter = Arc::new(AsyncMutex::new(None));
    let gate = trusted_gate(writer.clone());

    let result = gate.submit("git sta", true).await;

    assert_eq!(result, SessionRpcResult::PreWrite);
    assert!(writer.lock().await.is_none(), "writer stays missing");
}

#[tokio::test]
async fn write_error_is_partial() {
    for fail_on_flush in [false, true] {
        let failing: Box<dyn Write + Send> = Box::new(FailingWriter { fail_on_flush });
        let gate = trusted_gate(Arc::new(AsyncMutex::new(Some(failing))));

        let result = gate.submit("git sta", true).await;

        assert_eq!(
            result,
            SessionRpcResult::Partial,
            "fail_on_flush={fail_on_flush}"
        );
        assert_ne!(result, SessionRpcResult::Accepted);
        assert_ne!(result, SessionRpcResult::PreWrite);
    }
}

#[tokio::test]
async fn one_generator() {
    let (bytes, gate) = capture_gate();

    let first = start_completion(&gate, "r1", b"GEN-ONE").await.result;
    let second = start_completion(&gate, "r2", b"GEN-TWO").await.result;

    assert_eq!(first, SessionRpcResult::Accepted);
    assert_eq!(second, SessionRpcResult::NotStarted);
    let written = bytes.lock().expect("bytes").clone();
    assert_eq!(count(&written, b"GEN-ONE"), 1, "first written once");
    assert_eq!(count(&written, b"GEN-TWO"), 0, "second not written");
}

#[tokio::test]
async fn unrestorable_provider_is_not_started() {
    let (bytes, gate) = capture_gate();

    let skipped = gate
        .request_completion(
            &super::gate_test_support::request("r1"),
            &provider("raw-gen", b"GEN-RAW", false),
            true,
        )
        .await
        .result;
    assert_eq!(skipped, SessionRpcResult::NotStarted);
    assert!(
        bytes.lock().expect("bytes").is_empty(),
        "unrestorable writes nothing"
    );

    let started = gate
        .request_completion(
            &super::gate_test_support::request("r2"),
            &provider("safe-gen", b"GEN-SAFE", true),
            true,
        )
        .await
        .result;
    assert_eq!(started, SessionRpcResult::Accepted, "the slot stayed free");
    assert_eq!(
        bytes.lock().expect("bytes").as_slice(),
        b"\x1b0Di\x15GEN-SAFE r2 3 4 74657374\r"
    );
}

#[tokio::test]
async fn generator_slot_frees_after_finish() {
    let (bytes, gate) = capture_gate();

    let first = start_completion(&gate, "r1", b"GEN-ONE").await.result;
    super::gate_test_support::finish(&gate, "other", String::new());
    let blocked = start_completion(&gate, "r2", b"GEN-TWO").await.result;
    super::gate_test_support::finish(&gate, "r1", String::new());
    let second = start_completion(&gate, "r3", b"GEN-THREE").await.result;
    gate.cancel_completion("r3");
    assert_eq!(
        start_completion(&gate, "r4", b"GEN-FOUR").await.result,
        SessionRpcResult::NotStarted,
        "cancel retains shell occupancy until the matching frame"
    );
    super::gate_test_support::finish(&gate, "r3", String::new());
    let third = start_completion(&gate, "r4", b"GEN-FOUR").await.result;

    assert_eq!(first, SessionRpcResult::Accepted);
    assert_eq!(
        blocked,
        SessionRpcResult::NotStarted,
        "foreign id keeps slot"
    );
    assert_eq!(second, SessionRpcResult::Accepted, "finish frees the slot");
    assert_eq!(
        third,
        SessionRpcResult::Accepted,
        "cancelled shell drains before the next request"
    );
    let written = bytes.lock().expect("bytes").clone();
    assert_eq!(count(&written, b"GEN-ONE"), 1);
    assert_eq!(count(&written, b"GEN-TWO"), 0);
    assert_eq!(count(&written, b"GEN-THREE"), 1);
    assert_eq!(count(&written, b"GEN-FOUR"), 1);
}

#[tokio::test]
async fn completion_result_is_not_broadcast() {
    let hub = TerminalEventHub::standalone();
    let mut subscriber = hub.subscribe();
    let (_bytes, gate) = capture_gate();

    let start = start_completion(&gate, "r1", b"GEN-ONE").await;
    assert_eq!(start.result, SessionRpcResult::Accepted);
    let waiter = start.waiter.expect("an accepted request has a waiter");

    super::gate_test_support::finish(&gate, "r1", r#"{"items":["status"]}"#.to_owned());

    assert_eq!(
        waiter.await.expect("result").expect("completed").output,
        r#"{"items":["status"]}"#
    );
    assert!(
        matches!(subscriber.try_recv(), Err(TryRecvError::Empty)),
        "the hub receives no completion payload"
    );
}

#[tokio::test]
async fn finished_request_id_is_not_reused() {
    let (_bytes, gate) = capture_gate();

    let a = start_completion(&gate, "A", b"GEN-A").await;
    super::gate_test_support::finish(&gate, "A", "a-result".to_owned());
    assert_eq!(
        a.waiter
            .expect("A waiter")
            .await
            .expect("A result")
            .expect("completed")
            .output,
        "a-result"
    );

    let b = start_completion(&gate, "B", b"GEN-B").await;
    assert_eq!(b.result, SessionRpcResult::Accepted);
    super::gate_test_support::finish(&gate, "A", "stale-a".to_owned());
    super::gate_test_support::finish(&gate, "B", "b-result".to_owned());

    assert_eq!(
        b.waiter
            .expect("B waiter")
            .await
            .expect("B result")
            .expect("completed")
            .output,
        "b-result",
        "a payload for finished request A is not B's result"
    );
}

#[tokio::test]
async fn failed_restore_drops_trust() {
    let (bytes, gate) = capture_gate();

    let start = start_completion(&gate, "r1", b"GEN-ONE").await;
    assert_eq!(start.result, SessionRpcResult::Accepted);
    gate.restore_failed("r1");
    super::gate_test_support::finish(&gate, "r1", "late-result".to_owned());

    assert!(
        matches!(
            start.waiter.expect("waiter").await,
            Ok(Err(super::rpc::CompletionOutcome::Cancelled))
        ),
        "a completion that could not restore state returns no result"
    );
    assert!(!gate.trusted_at_prompt(), "the session is raw");
    assert_eq!(
        gate.submit("git sta", true).await,
        SessionRpcResult::NotStarted
    );
    let written = bytes.lock().expect("bytes").clone();
    assert_eq!(count(&written, b"git sta"), 0, "the draft is not written");
}

#[tokio::test]
async fn submit_drains_the_generator_first() {
    let (bytes, gate) = capture_gate();
    gate.observe_output(b"\x1b[?2004h");
    let gate = Arc::new(gate);

    let start = start_completion(&gate, "r1", b"GEN-ONE").await;
    assert_eq!(start.result, SessionRpcResult::Accepted);
    let mut waiter = start.waiter.expect("waiter");

    let submit = spawn_submit(&gate);
    tokio::task::yield_now().await;
    assert_eq!(count(&bytes.lock().expect("bytes"), b"git sta"), 0);
    super::gate_test_support::finish(&gate, "r1", "late-result".to_owned());
    assert_eq!(submit.await.unwrap(), SessionRpcResult::Accepted);

    assert!(
        matches!(
            waiter.try_recv(),
            Ok(Err(super::rpc::CompletionOutcome::Cancelled))
        ),
        "the generator is cancelled before the draft is written"
    );
    let written = bytes.lock().expect("bytes").clone();
    let mut expected = b"\x1b0Di\x15GEN-ONE r1 3 4 74657374\r".to_vec();
    expected.extend_from_slice(CLEAR_LINE_SEQUENCE.as_bytes());
    expected.extend_from_slice(b"\x1b[200~git sta\x1b[201~\r");
    assert_eq!(written, expected, "generator command, then the draft once");
    assert_eq!(count(&written, b"git sta"), 1);
}

#[tokio::test]
async fn capture_tracing_keeps_callsites_first_used_on_another_thread() {
    fn emit(marker: &str) {
        tracing::warn!("capture probe: {marker}");
    }

    let (_, logged) = capture_tracing(async {
        std::thread::spawn(|| emit("other thread"))
            .join()
            .expect("uncaptured thread");
        emit("capturing thread");
    })
    .await;

    assert_eq!(logged.lines().count(), 1, "one captured event: {logged:?}");
    assert!(logged.contains("capture probe: capturing thread"));
    assert!(!logged.contains("other thread"));
}

#[tokio::test]
async fn outcome_logs_omit_the_draft() {
    for (gate, allow_write, expected) in outcome_cases() {
        let (result, logged) = capture_tracing(gate.submit("git status", allow_write)).await;
        assert_eq!(result, expected);
        let name = format!("{expected:?}");
        let naming: Vec<&str> = logged.lines().filter(|l| l.contains(&name)).collect();
        assert_eq!(naming.len(), 1, "one log line names {name}: {logged:?}");
        assert!(!logged.contains("git status"), "the draft is never logged");
    }
}

#[tokio::test]
async fn restore_prompt_writes_the_sequence() {
    let (bytes, gate) = capture_gate();

    assert_eq!(gate.restore_prompt(true).await, SessionRpcResult::Accepted);

    let written = bytes.lock().expect("bytes").clone();
    assert_eq!(written, RESTORE_PROMPT_SEQUENCE.as_bytes());
    assert_eq!(count(&written, b"git status"), 0, "no draft restored");
}

#[tokio::test]
async fn generator_slot_is_visible() {
    let (_bytes, gate) = capture_gate();
    let gen = provider("gen", b"GEN-ONE", true);
    assert!(!gate.generator_active());

    let start = gate
        .request_completion(&super::gate_test_support::request("r1"), &gen, true)
        .await;
    assert_eq!(start.result, SessionRpcResult::Accepted);
    assert!(gate.generator_active(), "active while the slot is held");
    super::gate_test_support::finish(&gate, "r1", "payload".to_owned());
    assert!(!gate.generator_active(), "inactive after finish");

    let start = gate
        .request_completion(&super::gate_test_support::request("r2"), &gen, true)
        .await;
    assert_eq!(start.result, SessionRpcResult::Accepted);
    assert!(gate.generator_active());
    gate.cancel_completion("r2");
    assert!(!gate.generator_active(), "inactive after cancel");
}

#[tokio::test]
async fn completion_while_raw_is_not_started() {
    let (bytes, gate) = capture_gate();
    let gen = provider("gen", b"GEN-ONE", true);

    let start = gate
        .request_completion(&super::gate_test_support::request("r1"), &gen, true)
        .await;
    assert_eq!(start.result, SessionRpcResult::Accepted);
    gate.restore_failed("r1");
    assert!(!gate.trusted_at_prompt());

    let start = gate
        .request_completion(&super::gate_test_support::request("r2"), &gen, true)
        .await;
    assert_eq!(start.result, SessionRpcResult::NotStarted);
    assert!(start.waiter.is_none());
    assert!(!gate.generator_active());
    assert_eq!(
        count(&bytes.lock().expect("bytes"), b"GEN-ONE"),
        1,
        "a raw gate writes no generator command"
    );
}

#[tokio::test]
async fn trust_lost_while_waiting_for_the_writer_is_not_started() {
    let (bytes, writer) = capture();
    let gate = Arc::new(trusted_gate(writer.clone()));
    let guard = writer.lock().await;
    let submit_gate = gate.clone();
    let submit = tokio::spawn(async move { submit_gate.submit("git sta", true).await });
    let completion_gate = gate.clone();
    let completion = tokio::spawn(async move {
        start_completion(&completion_gate, "r1", b"GEN-ONE")
            .await
            .result
    });
    tokio::task::yield_now().await;
    assert!(!submit.is_finished());
    assert!(!completion.is_finished());
    gate.restore_failed("unknown");
    drop(guard);
    assert_eq!(submit.await.unwrap(), SessionRpcResult::NotStarted);
    assert_eq!(completion.await.unwrap(), SessionRpcResult::NotStarted);
    assert!(bytes.lock().expect("bytes").is_empty());
}

#[tokio::test]
async fn submit_waits_for_a_cancelled_generator() {
    let (bytes, gate) = capture_gate();
    let gate = Arc::new(gate);
    assert_eq!(
        start_completion(&gate, "r1", b"GEN-ONE").await.result,
        SessionRpcResult::Accepted
    );
    assert!(gate.cancel_completion("r1"));
    let submit = spawn_submit(&gate);
    tokio::task::yield_now().await;
    assert_eq!(count(&bytes.lock().expect("bytes"), b"git sta"), 0);
    super::gate_test_support::finish(&gate, "r1", "late-result".to_owned());
    assert_eq!(submit.await.unwrap(), SessionRpcResult::Accepted);
    let written = bytes.lock().expect("bytes");
    assert_eq!(
        *written,
        format!("\x1b0Di\x15GEN-ONE r1 3 4 74657374\r{CLEAR_LINE_SEQUENCE}git sta\r").as_bytes()
    );
    assert_eq!(count(&written, b"git sta"), 1);
}

#[tokio::test(start_paused = true)]
async fn drain_timeout_falls_back_to_raw() {
    let (bytes, gate) = capture_gate();
    assert_eq!(
        start_completion(&gate, "r1", b"GEN-ONE").await.result,
        SessionRpcResult::Accepted
    );
    assert_eq!(
        gate.submit("git sta", true).await,
        SessionRpcResult::NotStarted
    );
    assert!(!gate.trusted_at_prompt());
    assert!(!gate.generator_active());
    assert_eq!(
        bytes.lock().expect("bytes").as_slice(),
        b"\x1b0Di\x15GEN-ONE r1 3 4 74657374\r"
    );
}

#[tokio::test]
async fn restore_failure_while_draining_is_not_started() {
    let (bytes, gate) = capture_gate();
    let gate = Arc::new(gate);
    assert_eq!(
        start_completion(&gate, "r1", b"GEN-ONE").await.result,
        SessionRpcResult::Accepted
    );
    let submit = spawn_submit(&gate);
    tokio::task::yield_now().await;
    gate.restore_failed("r1");
    assert_eq!(submit.await.unwrap(), SessionRpcResult::NotStarted);
    assert!(!gate.trusted_at_prompt());
    assert_eq!(
        bytes.lock().expect("bytes").as_slice(),
        b"\x1b0Di\x15GEN-ONE r1 3 4 74657374\r"
    );
}

#[tokio::test]
async fn partial_generator_write_drops_trust() {
    for fail_on_flush in [true, false] {
        let failing: Box<dyn Write + Send> = Box::new(FailingWriter { fail_on_flush });
        let gate = trusted_gate(Arc::new(AsyncMutex::new(Some(failing))));
        assert!(gate.register_session("s1".into(), "n1".into()));
        let start = start_completion(&gate, "r1", b"GEN-ONE").await;
        assert_eq!(start.result, SessionRpcResult::Partial);
        assert_eq!(
            gate.authentic_session().phase,
            super::gate::SessionPhase::Raw,
            "fail_on_flush={fail_on_flush}"
        );
        assert!(!gate.trusted_at_prompt(), "fail_on_flush={fail_on_flush}");
        assert!(!gate.generator_active());
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn trust_cannot_drop_during_a_write() {
    let mut observations = Vec::new();
    for completion in [false, true] {
        let fixture = blocking_gate(completion);
        let gate = &fixture.gate;
        let writing = spawn_gate_write(gate, completion);
        fixture
            .entered
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("write paused");
        let (restoring, _restore_done, blocked) = restore_during_write(&fixture);
        fixture.release.send(()).expect("release write");
        assert_eq!(
            writing.await.expect("gate task"),
            SessionRpcResult::Accepted
        );
        restoring.join().expect("restore thread");
        let expected = expected_write(completion);
        assert_eq!(*fixture.bytes.lock().expect("bytes"), expected);
        assert_eq!(
            count(&expected, if completion { b"GEN-ONE" } else { b"git sta" }),
            1
        );
        if completion {
            super::gate_test_support::finish(gate, "r1", String::new());
        }
        assert_eq!(
            gate.submit("later draft", true).await,
            SessionRpcResult::NotStarted
        );
        assert_eq!(*fixture.bytes.lock().expect("bytes"), expected);
        observations.push((
            completion,
            blocked,
            fixture.events.lock().expect("events").clone(),
        ));
    }
    for (completion, blocked, events) in observations {
        assert!(
            blocked,
            "restore_failed completed during write, completion={completion}, events={events:?}"
        );
        assert_eq!(
            events,
            ["write-done", "restore-done"],
            "completion={completion}"
        );
    }
}

#[tokio::test]
async fn accepted_submit_ends_host_trust() {
    let (_, gate) = capture_gate();
    gate.mark_trusted_prompt(7, "/repo".into());
    assert_eq!(
        gate.submit("git status", true).await,
        SessionRpcResult::Accepted
    );
    assert_eq!(
        gate.submit("git diff", true).await,
        SessionRpcResult::NotStarted
    );
    assert_eq!(
        gate.request_completion(
            &super::gate_test_support::request("r1"),
            &provider("bash", b"GEN", true),
            true
        )
        .await
        .result,
        SessionRpcResult::NotStarted
    );
    assert!(!gate.trusted_at_prompt());
}

#[tokio::test]
async fn gate_writes_the_trigger_for_each_request() {
    let (bytes, gate) = capture_gate();
    let request: super::gate::CompletionRequest = serde_json::from_value(serde_json::json!({
        "requestId":"r1", "bufferRevision":7, "cursor":7, "draft":"git status",
        "promptGeneration":7, "cwd":"/repo"
    }))
    .unwrap();
    let start = gate
        .request_completion(&request, &provider("gen", b"__termul_complete", true), true)
        .await;
    assert_eq!(start.result, SessionRpcResult::Accepted);
    assert_eq!(
        *bytes.lock().unwrap(),
        b"\x1b0Di\x15__termul_complete r1 7 7 67697420737461\r"
    );
    for cursor in [11, 1] {
        let (bytes, gate) = capture_gate();
        let request: super::gate::CompletionRequest = serde_json::from_value(serde_json::json!({
            "requestId":"r1", "bufferRevision":7, "cursor":cursor,
            "draft":if cursor == 1 { "😀" } else { "git status" }, "promptGeneration":7, "cwd":"/repo"
        })).unwrap();
        assert_eq!(
            gate.request_completion(&request, &provider("gen", b"__termul_complete", true), true)
                .await
                .result,
            SessionRpcResult::NotStarted
        );
        assert!(bytes.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn gate_uses_the_registered_trigger_prefix_once() {
    let (bytes, gate) = capture_gate();
    let provider = provider("bash", b"\x1b0Di\x15__termul_complete ", true);
    let mut request = super::gate_test_support::request("r1");
    request.buffer_revision = 7;
    request.cursor = 7;
    request.draft = "git status".into();
    assert_eq!(
        gate.request_completion(&request, &provider, true)
            .await
            .result,
        SessionRpcResult::Accepted
    );
    assert_eq!(
        *bytes.lock().unwrap(),
        b"\x1b0Di\x15__termul_complete r1 7 7 67697420737461\r"
    );
}

fn observe_completion_trust_loss(gate: &Arc<super::gate::SessionGate>) {
    let weak = Arc::downgrade(gate);
    gate.install_trust_loss_sink(Arc::new(move |_| {
        let gate = weak.upgrade().unwrap();
        // Snapshot on another thread before the sink can repair the phase.
        let snapshot = std::thread::spawn(move || gate.authentic_session())
            .join()
            .unwrap();
        assert!(snapshot.prompt.is_none());
        assert_eq!(snapshot.phase, super::gate::SessionPhase::Raw);
    }));
}

#[tokio::test]
async fn finish_completion_loses_trust_before_notification() {
    let (_, gate) = capture_gate();
    let gate = Arc::new(gate);
    assert!(gate.register_session("s1".into(), "n1".into()));
    observe_completion_trust_loss(&gate);
    assert_eq!(
        start_completion(&gate, "r1", b"GEN-ONE").await.result,
        SessionRpcResult::Accepted
    );
    let request = super::gate_test_support::request("r1");
    gate.finish_completion(super::frame::CompletionResult {
        session_id: "s1".into(),
        nonce: "n1".into(),
        request_id: request.request_id,
        buffer_revision: request.buffer_revision,
        cursor: request.cursor,
        prompt_generation: request.prompt_generation + 1,
        cwd: request.cwd,
        output: String::new(),
    });
    assert_eq!(
        gate.authentic_session().phase,
        super::gate::SessionPhase::Raw
    );
}

#[tokio::test(start_paused = true)]
async fn completion_watchdog_loses_trust_before_notification() {
    let (_, gate) = capture_gate();
    let gate = Arc::new(gate);
    assert!(gate.register_session("s1".into(), "n1".into()));
    observe_completion_trust_loss(&gate);
    let start = start_completion(&gate, "r1", b"GEN-ONE").await;
    gate.start_completion_watchdog(start.epoch.unwrap());
    tokio::task::yield_now().await;
    tokio::time::advance(super::rpc::COMPLETION_TIMEOUT).await;
    tokio::task::yield_now().await;
    tokio::time::advance(super::gate::GENERATOR_DRAIN_TIMEOUT).await;
    tokio::task::yield_now().await;
    assert_eq!(
        gate.authentic_session().phase,
        super::gate::SessionPhase::Raw
    );
}

#[test]
fn process_exit_clears_prompt_and_phase_together() {
    let (_, gate) = capture_gate();
    assert!(gate.register_session("s1".into(), "n1".into()));
    gate.process_exited();
    let snapshot = gate.authentic_session();
    assert!(snapshot.exited);
    assert!(snapshot.prompt.is_none());
    assert_eq!(snapshot.phase, super::gate::SessionPhase::Raw);
}
