use std::sync::{Arc, Mutex};

use super::deliver::process_reader_chunk;
use super::filter::SessionFilter;
use super::frame::SessionRpcResult;
use super::gate_test_support::{capture_gate, start_completion};

fn completion_frame() -> Vec<u8> {
    let payload = serde_json::json!({
        "type": "Completion", "session_id": "s1", "nonce": "n1",
        "request_id": "r1", "buffer_revision": 3, "cursor": 4,
        "prompt_generation": 7, "cwd": "/repo", "output": "status\nbranch"
    });
    format!("\x1b]9477;{payload}\x07").into_bytes()
}

#[tokio::test]
async fn reader_delivers_a_frame_to_the_gate() {
    let (_writer, gate) = capture_gate();
    let gate = Arc::new(gate);
    let pending = Mutex::new(Vec::new());
    let mut filter = SessionFilter::new();
    let hub = crate::trackers::terminal_events::TerminalEventHub::standalone();
    assert!(process_reader_chunk(
        &mut filter,
        b"before ",
        &pending,
        &gate,
        "test",
        &hub
    ));
    let start = start_completion(&gate, "r1", b"GEN").await;
    assert_eq!(start.result, SessionRpcResult::Accepted);
    let mut waiter = start.waiter.expect("completion waiter");
    let mut chunk = completion_frame();
    chunk.extend_from_slice(b" after");

    assert!(process_reader_chunk(
        &mut filter,
        &chunk,
        &pending,
        &gate,
        "test",
        &hub
    ));

    assert_eq!(*pending.lock().expect("pending"), b"before  after");
    assert_eq!(
        waiter
            .try_recv()
            .expect("parsed output")
            .expect("completed")
            .output,
        "status\nbranch"
    );
    assert!(!gate.generator_active());
    let source = include_str!("../manager/spawn.rs");
    let reader = source.split("fn reader_loop(").nth(1).expect("reader loop");
    let reader = reader.split("pub(super) fn flusher_loop(").next().unwrap();
    assert!(
        reader.contains("process_reader_chunk("),
        "reader must use the tested handoff"
    );
}

#[tokio::test]
async fn split_frame_is_delivered_once() {
    use tokio::sync::oneshot::error::TryRecvError;

    let (_writer, gate) = capture_gate();
    let gate = Arc::new(gate);
    let start = start_completion(&gate, "r1", b"GEN").await;
    assert_eq!(start.result, SessionRpcResult::Accepted);
    let mut waiter = start.waiter.expect("completion waiter");
    let pending = Mutex::new(Vec::new());
    let mut filter = SessionFilter::new();
    let frame = completion_frame();
    let (first, second) = frame.split_at(frame.len() / 2);

    assert!(process_reader_chunk(
        &mut filter,
        first,
        &pending,
        &gate,
        "test",
        &crate::trackers::terminal_events::TerminalEventHub::standalone()
    ));
    assert!(pending.lock().expect("pending").is_empty());
    assert_eq!(waiter.try_recv(), Err(TryRecvError::Empty));
    assert!(gate.generator_active());

    assert!(process_reader_chunk(
        &mut filter,
        second,
        &pending,
        &gate,
        "test",
        &crate::trackers::terminal_events::TerminalEventHub::standalone()
    ));
    assert!(
        pending.lock().expect("pending").is_empty(),
        "protocol bytes leaked"
    );
    assert_eq!(
        waiter
            .try_recv()
            .expect("completed frame")
            .expect("completed")
            .output,
        "status\nbranch"
    );
    assert!(!gate.generator_active());

    assert!(process_reader_chunk(
        &mut filter,
        b"",
        &pending,
        &gate,
        "test",
        &crate::trackers::terminal_events::TerminalEventHub::standalone()
    ));
    assert!(pending.lock().expect("pending").is_empty());
    assert_eq!(waiter.try_recv(), Err(TryRecvError::Closed));
}

#[tokio::test]
async fn prompt_frame_is_a_lifecycle_event() {
    use crate::trackers::terminal_events::{TerminalEvent, TerminalEventHub};

    let (_writer, gate) = capture_gate();
    let gate = Arc::new(gate);
    gate.expect_session("s1".into(), "n1".into());
    let hub = TerminalEventHub::standalone();
    let pending = Mutex::new(Vec::new());
    let mut filter = SessionFilter::new();
    let init = b"\x1b]9477;{\"type\":\"InitShell\",\"session_id\":\"s1\",\"nonce\":\"n1\"}\x07";
    assert!(process_reader_chunk(
        &mut filter,
        init,
        &pending,
        &gate,
        "test",
        &hub
    ));
    let mut events = hub.subscribe();
    let payload = serde_json::json!({
        "type": "PromptReady", "session_id": "s1", "nonce": "n1",
        "prompt_generation": 7, "line_empty": true,
        "prompt_suppressed": true, "cwd": "/repo"
    });
    let chunk = format!("\x1b]9477;{payload}\x07");
    assert!(process_reader_chunk(
        &mut filter,
        chunk.as_bytes(),
        &pending,
        &gate,
        "test",
        &hub
    ));
    let event = events.try_recv().expect("one lifecycle event");
    assert!(
        matches!(event, TerminalEvent::SessionLifecycle { ref session_id, .. } if session_id == "s1")
    );
    let value = serde_json::to_value(event).expect("lifecycle payload");
    assert!(value.get("completion").is_none());
    assert!(value.get("output").is_none());
    assert!(events.try_recv().is_err());
    assert!(hub.snapshot("test").cwd.is_none());
}

#[tokio::test]
async fn completion_frame_is_not_a_lifecycle_event() {
    use crate::trackers::terminal_events::TerminalEventHub;

    let (_writer, gate) = capture_gate();
    let gate = Arc::new(gate);
    gate.expect_session("s1".into(), "n1".into());
    gate.register_session("s1".into(), "n1".into());
    let hub = TerminalEventHub::standalone();
    let mut events = hub.subscribe();
    let start = start_completion(&gate, "r1", b"GEN").await;
    let mut waiter = start.waiter.expect("completion waiter");
    let pending = Mutex::new(Vec::new());
    let mut filter = SessionFilter::new();
    assert!(process_reader_chunk(
        &mut filter,
        &completion_frame(),
        &pending,
        &gate,
        "test",
        &hub
    ));
    assert_eq!(
        waiter
            .try_recv()
            .expect("gate result")
            .expect("completed")
            .output,
        "status\nbranch"
    );
    assert!(
        events.try_recv().is_err(),
        "completion reached the event hub"
    );
    assert!(pending.lock().expect("pending").is_empty());
}

#[tokio::test]
async fn desync_restores_the_prompt() {
    use super::{filter::MAX_SESSION_FRAME_BYTES, RESTORE_PROMPT_SEQUENCE};
    use crate::trackers::terminal_events::TerminalEventHub;

    let (writer, gate) = capture_gate();
    let gate = Arc::new(gate);
    gate.expect_session("s1".into(), "n1".into());
    gate.register_session("s1".into(), "n1".into());
    let hub = TerminalEventHub::standalone();
    let mut events = hub.subscribe();
    let pending = Mutex::new(Vec::new());
    let mut filter = SessionFilter::new();
    let draft = "git status";
    let mut chunk = b"\x1b]9477;".to_vec();
    chunk.extend(vec![b'x'; MAX_SESSION_FRAME_BYTES]);
    chunk.push(7);
    assert!(process_reader_chunk(
        &mut filter,
        &chunk,
        &pending,
        &gate,
        "test",
        &hub
    ));
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if writer.lock().expect("writer").as_slice() == RESTORE_PROMPT_SEQUENCE.as_bytes() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("desync did not write the restore sequence");
    assert!(!gate.trusted_at_prompt(), "desync must mark the gate raw");
    assert!(!String::from_utf8_lossy(&writer.lock().expect("writer")).contains(draft));
    let event = serde_json::to_value(events.try_recv().expect("desync lifecycle")).unwrap();
    assert_eq!(event["kind"], "Desync");
    assert_eq!(event["session_id"], "s1");
    assert!(!event.to_string().contains(draft));
    assert!(event.get("draft").is_none());
    assert!(events.try_recv().is_err());
    assert!(hub.snapshot("test").cwd.is_none());
}

#[tokio::test]
async fn generator_bytes_do_not_reach_the_client() {
    use crate::trackers::terminal_events::TerminalEventHub;

    let (writer, gate) = capture_gate();
    let gate = Arc::new(gate);
    gate.expect_session("s1".into(), "n1".into());
    gate.register_session("s1".into(), "n1".into());
    let trigger = b"__termul_complete r1 7 7 67697420737461";
    let start = start_completion(&gate, "r1", trigger).await;
    assert_eq!(start.result, SessionRpcResult::Accepted);
    assert_eq!(
        writer.lock().expect("writer").as_slice(),
        [b"\x1b0Di\x15".as_slice(), trigger, b" r1 3 4 74657374\r"].concat()
    );
    let mut waiter = start.waiter.expect("completion waiter");
    let pending = Mutex::new(Vec::new());
    let mut filter = SessionFilter::new();
    let mut chunk = trigger.to_vec();
    chunk.extend_from_slice(b"COMPGEN leak");
    chunk.extend(completion_frame());
    chunk.extend_from_slice(b"\x1b[?2004h\x1b[K");

    assert!(process_reader_chunk(
        &mut filter,
        &chunk,
        &pending,
        &gate,
        "test",
        &TerminalEventHub::standalone(),
    ));

    let client_bytes = pending.lock().expect("pending").clone();
    let client_text = String::from_utf8_lossy(&client_bytes);
    assert!(!client_text.contains("__termul_complete r1 7 7 67697420737461"));
    assert!(!client_text.contains("COMPGEN leak"));
    assert_eq!(client_bytes, b"\x1b[?2004h\x1b[K");
    assert!(
        gate.bracketed_paste_enabled(),
        "DECSET 2004 in forwarded output must enable paste wrapping"
    );
    assert_eq!(
        waiter
            .try_recv()
            .expect("gate result")
            .expect("completed")
            .output,
        "status\nbranch"
    );
}

#[tokio::test]
async fn user_output_returns_after_the_generator() {
    use super::gate::SuppressionEndReason;
    use crate::trackers::terminal_events::TerminalEventHub;

    let (_writer, gate) = capture_gate();
    let gate = Arc::new(gate);
    gate.expect_session("s1".into(), "n1".into());
    gate.register_session("s1".into(), "n1".into());
    let start = start_completion(&gate, "r1", b"GEN").await;
    assert_eq!(start.result, SessionRpcResult::Accepted);
    let pending = Mutex::new(Vec::new());
    let mut filter = SessionFilter::new();
    let hub = TerminalEventHub::standalone();

    assert!(process_reader_chunk(
        &mut filter,
        &completion_frame(),
        &pending,
        &gate,
        "test",
        &hub,
    ));
    assert!(process_reader_chunk(
        &mut filter,
        b"user output",
        &pending,
        &gate,
        "test",
        &hub,
    ));
    assert_eq!(*pending.lock().expect("pending"), b"user output");

    let (_writer, watchdog_gate) = capture_gate();
    let watchdog_gate = Arc::new(watchdog_gate);
    watchdog_gate.expect_session("s1".into(), "n1".into());
    watchdog_gate.register_session("s1".into(), "n1".into());
    let start = start_completion(&watchdog_gate, "r1", b"GEN").await;
    assert_eq!(start.result, SessionRpcResult::Accepted);
    let watchdog_pending = Mutex::new(Vec::new());
    let mut watchdog_filter = SessionFilter::new();
    assert!(process_reader_chunk(
        &mut watchdog_filter,
        b"COMPGEN leak",
        &watchdog_pending,
        &watchdog_gate,
        "test",
        &hub,
    ));
    assert!(watchdog_pending.lock().expect("pending").is_empty());

    watchdog_gate.end_suppression(SuppressionEndReason::Watchdog);
    assert!(process_reader_chunk(
        &mut watchdog_filter,
        b"user output",
        &watchdog_pending,
        &watchdog_gate,
        "test",
        &hub,
    ));
    assert_eq!(*watchdog_pending.lock().expect("pending"), b"user output");
}

#[tokio::test]
async fn hub_publishes_initshell_before_the_prompt() {
    use crate::trackers::terminal_events::TerminalEventHub;

    let (_writer, gate) = capture_gate();
    let gate = Arc::new(gate);
    gate.expect_session("s1".into(), "n1".into());
    let hub = TerminalEventHub::standalone();
    let mut events = hub.subscribe();
    let pending = Mutex::new(Vec::new());
    let mut filter = SessionFilter::new();
    let prompt = serde_json::json!({
        "type": "PromptReady", "session_id": "s1", "nonce": "n1",
        "prompt_generation": 7, "line_empty": true,
        "prompt_suppressed": true, "cwd": "/repo"
    });
    let chunk = format!(
        "\x1b]9477;{{\"type\":\"InitShell\",\"session_id\":\"s1\",\"nonce\":\"n1\"}}\x07\x1b]9477;{prompt}\x07"
    );

    assert!(process_reader_chunk(
        &mut filter,
        chunk.as_bytes(),
        &pending,
        &gate,
        "test",
        &hub,
    ));

    let first = serde_json::to_value(events.try_recv().expect("init shell event")).unwrap();
    let second = serde_json::to_value(events.try_recv().expect("prompt ready event")).unwrap();
    assert_eq!(first["kind"], "InitShell");
    assert_eq!(first["session_id"], "s1");
    assert_eq!(first["nonce"], "n1");
    assert!(first.get("completion").is_none());
    assert!(first.get("output").is_none());
    assert_eq!(second["kind"], "PromptReady");
    assert_eq!(second["session_id"], "s1");
    assert_eq!(second["nonce"], "n1");
    assert!(second.get("completion").is_none());
    assert!(second.get("output").is_none());
    assert!(events.try_recv().is_err());
}

#[tokio::test]
async fn hub_command_started_leaves_the_editor() {
    use crate::trackers::terminal_events::TerminalEventHub;

    let (_writer, gate) = capture_gate();
    let gate = Arc::new(gate);
    gate.expect_session("s1".into(), "n1".into());
    gate.register_session("s1".into(), "n1".into());
    let hub = TerminalEventHub::standalone();
    let mut events = hub.subscribe();
    let pending = Mutex::new(Vec::new());
    let mut filter = SessionFilter::new();

    let unauthenticated = b"\x1b]9477;{\"type\":\"CommandStarted\",\"nonce\":\"wrong\"}\x07";
    assert!(process_reader_chunk(
        &mut filter,
        unauthenticated,
        &pending,
        &gate,
        "test",
        &hub,
    ));
    assert!(events.try_recv().is_err());

    let started = b"\x1b]9477;{\"type\":\"CommandStarted\",\"nonce\":\"n1\"}\x07";
    assert!(process_reader_chunk(
        &mut filter,
        started,
        &pending,
        &gate,
        "test",
        &hub,
    ));

    let event = serde_json::to_value(events.try_recv().expect("command started event")).unwrap();
    assert_eq!(event["type"], "session_lifecycle");
    assert_eq!(event["kind"], "CommandStarted");
    assert_eq!(event["session_id"], "s1");
    assert_eq!(event["nonce"], "n1");
    assert!(events.try_recv().is_err());
}

#[tokio::test]
async fn hub_records_the_finished_exit_code() {
    use crate::trackers::terminal_events::TerminalEventHub;

    let (_writer, gate) = capture_gate();
    let gate = Arc::new(gate);
    gate.expect_session("s1".into(), "n1".into());
    gate.register_session("s1".into(), "n1".into());
    let hub = TerminalEventHub::standalone();
    let mut events = hub.subscribe();
    let pending = Mutex::new(Vec::new());
    let mut filter = SessionFilter::new();

    let unauthenticated =
        b"\x1b]9477;{\"type\":\"CommandFinished\",\"nonce\":\"wrong\",\"exit_code\":2}\x07";
    assert!(process_reader_chunk(
        &mut filter,
        unauthenticated,
        &pending,
        &gate,
        "test",
        &hub,
    ));
    assert!(events.try_recv().is_err());

    let finished = b"\x1b]9477;{\"type\":\"CommandFinished\",\"nonce\":\"n1\",\"exit_code\":2}\x07";
    assert!(process_reader_chunk(
        &mut filter,
        finished,
        &pending,
        &gate,
        "test",
        &hub,
    ));

    let event = serde_json::to_value(events.try_recv().expect("command finished event")).unwrap();
    assert_eq!(event["type"], "session_lifecycle");
    assert_eq!(event["kind"], "CommandFinished");
    assert_eq!(event["session_id"], "s1");
    assert_eq!(event["nonce"], "n1");
    assert_eq!(event["exit_code"], 2);
    assert!(events.try_recv().is_err());
}

fn lifecycle_frame(kind: &str, nonce: &str) -> Vec<u8> {
    let payload = serde_json::json!({
        "type": kind, "session_id": if nonce == "n2" { "evil" } else { "s1" },
        "nonce": nonce, "prompt_generation": 7, "line_empty": true,
        "prompt_suppressed": true, "cwd": "/repo"
    });
    format!("\x1b]9477;{payload}\x07").into_bytes()
}

#[tokio::test]
async fn forged_initshell_is_ignored() {
    let mut reader = TrustReader::new();
    let mut events = reader.hub.subscribe();
    for kind in ["InitShell", "PromptReady"] {
        reader.receive(&lifecycle_frame(kind, "n2"));
    }
    assert!(
        events.try_recv().is_err(),
        "forged lifecycle event published"
    );
    assert_eq!(reader.gate.session_identity(), None);
    assert!(!reader.gate.trusted_at_prompt());
    for kind in ["InitShell", "PromptReady"] {
        reader.receive(&lifecycle_frame(kind, "n1"));
        let event =
            serde_json::to_value(events.try_recv().expect("issued lifecycle event")).unwrap();
        assert_eq!(event["kind"], kind);
    }
    let identity = Some(("s1".into(), "n1".into()));
    assert_eq!(reader.gate.session_identity(), identity);
    reader.receive(&lifecycle_frame("InitShell", "n1"));
    assert!(events.try_recv().is_err(), "second InitShell published");
    assert_eq!(reader.gate.session_identity(), identity);
    let raw = super::gate::SessionGate::new(super::gate_test_support::capture().1);
    raw.mark_raw();
    reader.gate = Arc::new(raw);
    reader.receive(&lifecycle_frame("InitShell", "n1"));
    assert_eq!(reader.gate.session_identity(), None);
    assert!(events.try_recv().is_err(), "unissued InitShell published");
}

struct TrustReader {
    gate: Arc<super::gate::SessionGate>,
    filter: SessionFilter,
    pending: Mutex<Vec<u8>>,
    hub: crate::trackers::terminal_events::TerminalEventHub,
}

impl TrustReader {
    fn new() -> Self {
        let (_, gate) = capture_gate();
        gate.mark_raw();
        gate.expect_session("s1".into(), "n1".into());
        Self {
            gate: Arc::new(gate),
            filter: SessionFilter::new(),
            pending: Mutex::new(Vec::new()),
            hub: crate::trackers::terminal_events::TerminalEventHub::standalone(),
        }
    }

    fn receive(&mut self, chunk: &[u8]) {
        assert!(process_reader_chunk(
            &mut self.filter,
            chunk,
            &self.pending,
            &self.gate,
            "test",
            &self.hub
        ));
    }
}

#[tokio::test]
async fn host_trusts_only_an_authenticated_prompt() {
    let mut reader = TrustReader::new();
    reader.receive(&lifecycle_frame("PromptReady", "n1"));
    assert!(!reader.gate.trusted_at_prompt(), "prompt before InitShell");
    reader.receive(&lifecycle_frame("InitShell", "n1"));
    reader.receive(&lifecycle_frame("PromptReady", "other"));
    assert!(!reader.gate.trusted_at_prompt(), "wrong nonce");
    for (line_empty, suppressed) in [(false, true), (true, false), (false, false)] {
        let payload = serde_json::json!({
            "type": "PromptReady", "nonce": "n1", "prompt_generation": 7,
            "cwd": "/repo", "line_empty": line_empty, "prompt_suppressed": suppressed
        });
        reader.receive(format!("\x1b]9477;{payload}\x07").as_bytes());
        assert!(!reader.gate.trusted_at_prompt(), "unsafe prompt flags");
    }
    reader.receive(&lifecycle_frame("PromptReady", "n1"));
    assert!(
        reader.gate.trusted_at_prompt(),
        "authenticated empty suppressed prompt"
    );
    let mut combined = TrustReader::new();
    let mut chunk = lifecycle_frame("InitShell", "n1");
    chunk.extend(lifecycle_frame("PromptReady", "other"));
    combined.receive(&chunk);
    assert!(
        !combined.gate.trusted_at_prompt(),
        "wrong nonce in InitShell chunk"
    );
    combined.receive(&lifecycle_frame("PromptReady", "n1"));
    assert!(combined.gate.trusted_at_prompt());
}

#[tokio::test]
async fn raw_command_ends_host_trust() {
    let mut reader = TrustReader::new();
    let mut chunk = lifecycle_frame("InitShell", "n1");
    chunk.extend(lifecycle_frame("PromptReady", "n1"));
    reader.receive(&chunk);
    assert!(reader.gate.trusted_at_prompt());
    reader.receive(&lifecycle_frame("CommandStarted", "other"));
    assert!(
        reader.gate.trusted_at_prompt(),
        "forged command changed trust"
    );
    reader.receive(&lifecycle_frame("CommandStarted", "n1"));
    assert!(
        !reader.gate.trusted_at_prompt(),
        "raw command retained trust"
    );
    assert_eq!(
        reader.gate.submit("git status", true).await,
        SessionRpcResult::NotStarted
    );
}

#[tokio::test]
async fn completion_reply_carries_the_completer_output() {
    use super::{
        gate::CompletionRequest,
        gate_test_support::{provider, rpc_terminal},
        rpc,
    };
    let (pty, id, _keep_alive) = rpc_terminal().await;
    let gate = pty.get(&id).unwrap().session_gate.clone();
    gate.expect_session("s1".into(), "n1".into());
    gate.set_completion_providers(vec![provider("gen", b"__termul_complete", true)]);
    let mut reader = TrustReader::new();
    reader.gate = gate.clone();
    reader.receive(&lifecycle_frame("InitShell", "n1"));
    let prompt = serde_json::json!({"type":"PromptReady", "nonce":"n1",
        "prompt_generation":3, "cwd":"/repo", "line_empty":true, "prompt_suppressed":true});
    reader.receive(format!("\x1b]9477;{prompt}\x07").as_bytes());
    for cancelled in [false, true] {
        let request = CompletionRequest {
            request_id: "r1".into(),
            buffer_revision: 7,
            cursor: 7,
            draft: "git status".into(),
            prompt_generation: 3,
            cwd: "/repo".into(),
        };
        let call = rpc::request_completion(&pty, &id, &request, true);
        tokio::pin!(call);
        // Poll admission before delivering the shell's response; the RPC must retain its waiter.
        let early = tokio::select! { reply = &mut call => Some(reply), _ = tokio::task::yield_now() => None };
        if cancelled {
            assert!(gate.cancel_completion("r1"));
        }
        let frame = serde_json::json!({"type":"Completion", "session_id":"s1", "nonce":"n1",
            "request_id":"r1", "buffer_revision":7, "cursor":7, "prompt_generation":3,
            "cwd":"/repo", "output":"737461747573"});
        reader.receive(format!("\x1b]9477;{frame}\x07").as_bytes());
        let reply = match early {
            Some(reply) => reply,
            None => call.await,
        };
        let reply = serde_json::to_value(reply).unwrap();
        assert_eq!(
            reply["result"], "Accepted",
            "completion RPC must return a reply object"
        );
        assert_eq!(
            reply["outcome"],
            if cancelled { "Cancelled" } else { "Completed" }
        );
        if cancelled {
            assert!(reply.get("completion").is_none());
        } else {
            for field in [
                "request_id",
                "buffer_revision",
                "cursor",
                "prompt_generation",
                "cwd",
                "output",
            ] {
                assert_eq!(reply["completion"][field], frame[field], "{field}");
            }
        }
        assert!(!reply.to_string().contains(":null"));
        assert!(reader.pending.lock().unwrap().is_empty());
    }
    pty.force_kill(&id).await.unwrap();
}

#[tokio::test]
async fn request_from_another_prompt_is_not_started() {
    use super::gate_test_support::{provider, request};
    let (bytes, gate) = capture_gate();
    let mut reader = TrustReader::new();
    reader.gate = Arc::new(gate);
    reader.gate.mark_raw();
    reader.gate.expect_session("s1".into(), "n1".into());
    reader.receive(&lifecycle_frame("InitShell", "n1"));
    let prompt = serde_json::json!({"type":"PromptReady", "nonce":"n1", "prompt_generation":3,
        "cwd":"/repo", "line_empty":true, "prompt_suppressed":true});
    reader.receive(format!("\x1b]9477;{prompt}\x07").as_bytes());
    for (generation, cwd) in [(2, "/repo"), (3, "/other")] {
        let mut request = request("r1");
        request.prompt_generation = generation;
        request.cwd = cwd.into();
        assert_eq!(
            reader
                .gate
                .request_completion(&request, &provider("gen", b"GEN", true), true)
                .await
                .result,
            SessionRpcResult::NotStarted,
            "request from another prompt must not start"
        );
        assert!(bytes.lock().unwrap().is_empty());
    }
    let mut request = request("r1");
    request.prompt_generation = 3;
    assert_eq!(
        reader
            .gate
            .request_completion(&request, &provider("gen", b"GEN", true), true)
            .await
            .result,
        SessionRpcResult::Accepted
    );
}

async fn completion_reader() -> (
    Arc<crate::pty::PtyManager>,
    String,
    std::io::PipeWriter,
    TrustReader,
) {
    let (pty, id, keep_alive) = super::gate_test_support::rpc_terminal().await;
    let mut reader = TrustReader::new();
    reader.gate = pty.get(&id).unwrap().session_gate.clone();
    reader.gate.expect_session("s1".into(), "n1".into());
    reader
        .gate
        .set_completion_providers(vec![super::gate_test_support::provider(
            "gen",
            b"__termul_complete",
            true,
        )]);
    reader.receive(&lifecycle_frame("InitShell", "n1"));
    let prompt = serde_json::json!({"type":"PromptReady", "nonce":"n1", "prompt_generation":3,
        "cwd":"/repo", "line_empty":true, "prompt_suppressed":true});
    reader.receive(format!("\x1b]9477;{prompt}\x07").as_bytes());
    (pty, id, keep_alive, reader)
}

fn rpc_request() -> super::gate::CompletionRequest {
    let mut request = super::gate_test_support::request("r1");
    request.prompt_generation = 3;
    request.buffer_revision = 7;
    request.cursor = 7;
    request.draft = "git status".into();
    request
}

fn rpc_frame(generation: u64, cwd: &str, nonce: &str) -> Vec<u8> {
    let payload = serde_json::json!({"type":"Completion", "session_id":"s1", "nonce":nonce,
        "request_id":"r1", "buffer_revision":7, "cursor":7, "prompt_generation":generation,
        "cwd":cwd, "output":"737461747573"});
    format!("\x1b]9477;{payload}\x07").into_bytes()
}

#[tokio::test]
async fn host_checks_the_completion_frame() {
    for (generation, cwd) in [(4, "/repo"), (3, "/elsewhere")] {
        let (pty, id, _keep_alive, mut reader) = completion_reader().await;
        let request = rpc_request();
        let call = super::rpc::request_completion(&pty, &id, &request, true);
        tokio::pin!(call);
        tokio::select! { reply = &mut call => panic!("reply before frame: {reply:?}"), _ = tokio::task::yield_now() => {} }
        reader.receive(&rpc_frame(3, "/repo", "wrong"));
        tokio::select! { reply = &mut call => panic!("wrong nonce completed: {reply:?}"), _ = tokio::task::yield_now() => {} }
        reader.receive(&rpc_frame(generation, cwd, "n1"));
        let reply = serde_json::to_value(call.await).unwrap();
        assert_eq!(
            reply["outcome"], "Dropped",
            "changed shell context must be dropped"
        );
        assert!(reply.get("completion").is_none());
        assert!(!reader.gate.trusted_at_prompt());
        assert!(reader.pending.lock().unwrap().is_empty());
        pty.force_kill(&id).await.unwrap();
    }
}

#[tokio::test(start_paused = true)]
async fn timed_out_completion_frees_the_shell_before_its_reply() {
    use super::gate_test_support::provider;
    use std::time::Duration;
    for late_frame in [true, false] {
        let (pty, id, _keep_alive, mut reader) = completion_reader().await;
        let request = rpc_request();
        let call = super::rpc::request_completion(&pty, &id, &request, true);
        tokio::pin!(call);
        tokio::select! { reply = &mut call => panic!("early reply: {reply:?}"), _ = tokio::task::yield_now() => {} }
        tokio::time::advance(Duration::from_millis(1500)).await;
        tokio::select! { reply = &mut call => panic!("reply before shell drained: {reply:?}"), _ = tokio::task::yield_now() => {} }
        let mut next = request.clone();
        next.request_id = "r2".into();
        assert_eq!(
            reader
                .gate
                .request_completion(&next, &provider("gen", b"GEN", true), true)
                .await
                .result,
            SessionRpcResult::NotStarted,
            "timeout must retain shell occupancy"
        );
        if late_frame {
            reader.receive(&rpc_frame(3, "/repo", "n1"));
        } else {
            tokio::time::advance(super::gate::GENERATOR_DRAIN_TIMEOUT).await;
        }
        let reply = tokio::time::timeout(Duration::from_millis(1), &mut call)
            .await
            .expect("drained completion did not resolve");
        let reply = serde_json::to_value(reply).unwrap();
        assert_eq!(
            reply["outcome"], "TimedOut",
            "late completion must keep its timeout decision"
        );
        assert!(reply.get("completion").is_none());
        assert!(reader.pending.lock().unwrap().is_empty());
        assert_eq!(reader.gate.trusted_at_prompt(), late_frame);
        if late_frame {
            assert_eq!(
                reader
                    .gate
                    .request_completion(&next, &provider("gen", b"GEN", true), true)
                    .await
                    .result,
                SessionRpcResult::Accepted
            );
        }
        pty.force_kill(&id).await.unwrap();
    }
    let (pty, id, _keep_alive, mut reader) = completion_reader().await;
    let request = rpc_request();
    let call = super::rpc::request_completion(&pty, &id, &request, true);
    tokio::pin!(call);
    tokio::select! { reply = &mut call => panic!("early reply: {reply:?}"), _ = tokio::task::yield_now() => {} }
    tokio::time::advance(Duration::from_millis(1500)).await;
    // All competing terminal events run at the same paused timestamp.
    reader.receive(&rpc_frame(3, "/repo", "n1"));
    reader.gate.cancel_completion("r1");
    let reply = serde_json::to_value(call.await).unwrap();
    assert!(["TimedOut", "Completed", "Cancelled"].contains(&reply["outcome"].as_str().unwrap()));
    assert!(!reader.gate.generator_active());
    assert!(
        !reader.gate.cancel_completion("r1"),
        "a second terminal decision must be refused"
    );
    pty.force_kill(&id).await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn suppression_ends_when_trust_is_lost() {
    for reason in [
        "desync",
        "command",
        "watchdog",
        "submit",
        "exit",
        "cancel_frame",
        "cancel_watchdog",
    ] {
        let (pty, id, _keep_alive, mut reader) = completion_reader().await;
        let request = rpc_request();
        let call = super::rpc::request_completion(&pty, &id, &request, true);
        tokio::pin!(call);
        tokio::select! { biased; reply = &mut call => panic!("early reply: {reply:?}"), _ = tokio::task::yield_now() => {} }
        assert!(reader.gate.suppressing_output());
        match reason {
            "desync" => {
                let mut chunk = b"\x1b]9477;".to_vec();
                chunk.extend(vec![b'x'; super::filter::MAX_SESSION_FRAME_BYTES]);
                chunk.push(7);
                reader.receive(&chunk);
            }
            "command" => reader.receive(&lifecycle_frame("CommandStarted", "n1")),
            "exit" => reader.gate.process_exited(),
            "submit" => {
                let gate = reader.gate.clone();
                let submit = gate.submit("git status", true);
                tokio::pin!(submit);
                tokio::select! { biased; result = &mut submit => panic!("submit did not drain: {result:?}"), _ = tokio::task::yield_now() => {} }
                tokio::time::advance(super::gate::GENERATOR_DRAIN_TIMEOUT).await;
                assert_eq!(submit.await, SessionRpcResult::NotStarted);
            }
            _ => {
                if reason.starts_with("cancel") {
                    assert!(reader.gate.cancel_completion("r1"));
                    assert!(
                        reader.gate.suppressing_output(),
                        "cancel must retain suppression"
                    );
                    reader.receive(b"COMPGEN leak");
                    assert!(reader.pending.lock().unwrap().is_empty());
                }
                if reason == "cancel_frame" {
                    reader.receive(&rpc_frame(3, "/repo", "n1"));
                } else {
                    tokio::time::advance(super::rpc::COMPLETION_TIMEOUT).await;
                    tokio::task::yield_now().await;
                    tokio::time::advance(super::gate::GENERATOR_DRAIN_TIMEOUT).await;
                    tokio::task::yield_now().await;
                }
            }
        }
        assert!(
            !reader.gate.suppressing_output(),
            "suppression remained active after {reason}"
        );
        reader.receive(b"user output");
        assert!(
            reader.pending.lock().unwrap().ends_with(b"user output"),
            "user output hidden after {reason}"
        );
        pty.force_kill(&id).await.unwrap();
    }
}

#[tokio::test(start_paused = true)]
async fn prompt_with_command_separator_is_forwarded_after_completion_and_cancellation() {
    for mode in ["completed", "cancelled"] {
        let (pty, id, _keep_alive, mut reader) = completion_reader().await;
        let request = rpc_request();
        let call = super::rpc::request_completion(&pty, &id, &request, true);
        tokio::pin!(call);
        tokio::select! { biased; reply = &mut call => panic!("early reply: {reply:?}"), _ = tokio::task::yield_now() => {} }
        assert!(reader.gate.suppressing_output());

        if mode == "completed" {
            reader.receive(&rpc_frame(3, "/repo", "n1"));
            let reply = serde_json::to_value(call.await).unwrap();
            assert_eq!(reply["outcome"], "Completed");
        } else {
            assert!(reader.gate.cancel_completion("r1"));
            reader.receive(&rpc_frame(3, "/repo", "n1"));
            let reply = serde_json::to_value(call.await).unwrap();
            assert_eq!(reply["outcome"], "Cancelled");
        }
        assert!(!reader.gate.suppressing_output());

        // Real-prompt chunk carrying \x1b]133;A;termul\x07 + PromptReady arrives
        let mut prompt_chunk = b"\x1b]133;A;termul\x07".to_vec();
        let prompt_payload = serde_json::json!({
            "type": "PromptReady",
            "nonce": "n1",
            "prompt_generation": 4,
            "cwd": "/repo",
            "line_empty": true,
            "prompt_suppressed": true
        });
        prompt_chunk.extend(format!("\x1b]9477;{prompt_payload}\x07").into_bytes());
        reader.receive(&prompt_chunk);

        assert!(
            reader
                .pending
                .lock()
                .unwrap()
                .windows(b"\x1b]133;A;termul\x07".len())
                .any(|w| w == b"\x1b]133;A;termul\x07"),
            "133;A;termul bytes missing from forwarded stream in {mode} mode"
        );
        assert!(
            reader.gate.trusted_at_prompt(),
            "{mode}: prompt must be trusted"
        );
        pty.force_kill(&id).await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn suppression_starts_before_the_trigger_is_written() {
    let fixture = super::gate_test_support::blocking_gate(true);
    let writing = super::gate_test_support::spawn_gate_write(&fixture.gate, true);
    fixture
        .entered
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("trigger write entered");
    let pending = Mutex::new(Vec::new());
    let mut filter = SessionFilter::new();
    let delivered = process_reader_chunk(
        &mut filter,
        b"GEN-ONE echo",
        &pending,
        &fixture.gate,
        "test",
        &crate::trackers::terminal_events::TerminalEventHub::standalone(),
    );
    fixture.release.send(()).unwrap();
    assert_eq!(writing.await.unwrap(), SessionRpcResult::Accepted);
    assert!(delivered);
    assert!(
        pending.lock().unwrap().is_empty(),
        "generator echo leaked while trigger write was in progress"
    );
}

struct TrustLossReader {
    writer: std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
    gate: std::sync::Arc<super::gate::SessionGate>,
    filter: SessionFilter,
    pending: Mutex<Vec<u8>>,
    hub: crate::trackers::terminal_events::TerminalEventHub,
}

fn bind_trust_loss_reader() -> TrustLossReader {
    let (writer, gate) = capture_gate();
    let gate = std::sync::Arc::new(gate);
    assert!(gate.register_session("s1".into(), "n1".into()));
    let hub = crate::trackers::terminal_events::TerminalEventHub::standalone();
    let pending = Mutex::new(Vec::new());
    let mut filter = SessionFilter::new();
    assert!(process_reader_chunk(
        &mut filter,
        b"",
        &pending,
        &gate,
        "test",
        &hub
    ));
    TrustLossReader {
        writer,
        gate,
        filter,
        pending,
        hub,
    }
}

fn mismatched_completion_frame() -> Vec<u8> {
    let payload = serde_json::json!({
        "type": "Completion", "session_id": "s1", "nonce": "n1",
        "request_id": "r1", "buffer_revision": 3, "cursor": 4,
        "prompt_generation": 4, "cwd": "/elsewhere", "output": "737461747573"
    });
    format!("\x1b]9477;{payload}\x07").into_bytes()
}

async fn await_restore_sequence(writer: &std::sync::Mutex<Vec<u8>>) {
    use super::RESTORE_PROMPT_SEQUENCE;
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if writer
                .lock()
                .expect("writer")
                .windows(RESTORE_PROMPT_SEQUENCE.len())
                .any(|part| part == RESTORE_PROMPT_SEQUENCE.as_bytes())
            {
                break;
            }
            tokio::task::yield_now().await;
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    })
    .await
    .expect("restore sequence not written");
}

fn take_one_desync(
    events: &mut tokio::sync::broadcast::Receiver<crate::trackers::terminal_events::TerminalEvent>,
) -> serde_json::Value {
    let event = events.try_recv().expect("expected one Desync");
    let value = serde_json::to_value(&event).unwrap();
    assert_eq!(value["type"], "session_lifecycle");
    assert_eq!(value["kind"], "Desync");
    assert_eq!(value["session_id"], "s1");
    assert_eq!(value["nonce"], "n1");
    assert!(value.get("draft").is_none());
    assert!(value.get("completion").is_none());
    assert!(
        events.try_recv().is_err(),
        "trust loss must publish exactly one Desync"
    );
    value
}

#[tokio::test]
async fn wrong_context_frame_publishes_desync() {
    use super::rpc::CompletionOutcome;
    let mut reader = bind_trust_loss_reader();
    let mut events = reader.hub.subscribe();
    let start = start_completion(&reader.gate, "r1", b"GEN").await;
    assert_eq!(start.result, SessionRpcResult::Accepted);
    let mut waiter = start.waiter.expect("waiter");
    assert!(process_reader_chunk(
        &mut reader.filter,
        &mismatched_completion_frame(),
        &reader.pending,
        &reader.gate,
        "test",
        &reader.hub
    ));
    let delivery = waiter.try_recv().expect("waiter resolved");
    assert!(
        matches!(delivery, Err(CompletionOutcome::Dropped)),
        "wrong context must drop: {delivery:?}"
    );
    assert!(!reader.gate.trusted_at_prompt());
    take_one_desync(&mut events);
    await_restore_sequence(&reader.writer).await;
}

#[tokio::test(start_paused = true)]
async fn completion_watchdog_publishes_desync() {
    let reader = bind_trust_loss_reader();
    let mut events = reader.hub.subscribe();
    let start = start_completion(&reader.gate, "r1", b"GEN").await;
    assert_eq!(start.result, SessionRpcResult::Accepted);
    reader
        .gate
        .start_completion_watchdog(start.epoch.expect("epoch"));
    tokio::time::advance(super::rpc::COMPLETION_TIMEOUT).await;
    tokio::task::yield_now().await;
    tokio::time::advance(super::gate::GENERATOR_DRAIN_TIMEOUT).await;
    tokio::task::yield_now().await;
    take_one_desync(&mut events);
    assert!(!reader.gate.suppressing_output());
    await_restore_sequence(&reader.writer).await;
}

#[tokio::test(start_paused = true)]
async fn process_exit_ends_completion_without_the_watchdog() {
    use super::gate_test_support::provider;
    use super::rpc::CompletionOutcome;
    use super::RESTORE_PROMPT_SEQUENCE;
    let reader = bind_trust_loss_reader();
    let mut events = reader.hub.subscribe();
    let start = start_completion(&reader.gate, "r1", b"GEN").await;
    assert_eq!(start.result, SessionRpcResult::Accepted);
    let mut waiter = start.waiter.expect("waiter");
    reader
        .gate
        .start_completion_watchdog(start.epoch.expect("epoch"));
    reader.gate.process_exited();
    let delivery = waiter.try_recv().expect("waiter resolved on process exit");
    assert!(
        matches!(delivery, Err(CompletionOutcome::TimedOut)),
        "process exit must reuse TimedOut: {delivery:?}"
    );
    assert!(!reader.gate.suppressing_output());
    assert!(!reader.gate.trusted_at_prompt());
    assert_eq!(
        reader
            .gate
            .request_completion(
                &super::gate_test_support::request("r2"),
                &provider("gen", b"GEN", true),
                true
            )
            .await
            .result,
        SessionRpcResult::NotStarted
    );
    assert!(
        events.try_recv().is_err(),
        "process exit must not publish Desync"
    );
    assert!(
        !reader
            .writer
            .lock()
            .expect("writer")
            .windows(RESTORE_PROMPT_SEQUENCE.len())
            .any(|part| part == RESTORE_PROMPT_SEQUENCE.as_bytes()),
        "process exit must not write the restore sequence"
    );
    let source = include_str!("../manager/spawn.rs");
    let reader = source.split("fn reader_loop(").nth(1).expect("reader loop");
    assert!(
        reader.contains("session_gate.process_exited()"),
        "reader exit must call the gate shutdown hook"
    );
}

#[tokio::test(start_paused = true)]
async fn submit_drain_timeout_publishes_desync() {
    let reader = bind_trust_loss_reader();
    let mut events = reader.hub.subscribe();
    assert_eq!(
        start_completion(&reader.gate, "r1", b"GEN").await.result,
        SessionRpcResult::Accepted
    );
    assert_eq!(
        reader.gate.submit("git sta", true).await,
        SessionRpcResult::NotStarted
    );
    take_one_desync(&mut events);
    await_restore_sequence(&reader.writer).await;
}

#[tokio::test(start_paused = true)]
async fn submit_drain_timeout_then_watchdog_restores_once() {
    use super::RESTORE_PROMPT_SEQUENCE;
    let reader = bind_trust_loss_reader();
    let mut events = reader.hub.subscribe();
    let start = start_completion(&reader.gate, "r1", b"GEN").await;
    assert_eq!(start.result, SessionRpcResult::Accepted);
    reader
        .gate
        .start_completion_watchdog(start.epoch.expect("epoch"));
    assert_eq!(
        reader.gate.submit("git sta", true).await,
        SessionRpcResult::NotStarted
    );
    tokio::time::advance(super::rpc::COMPLETION_TIMEOUT + super::gate::GENERATOR_DRAIN_TIMEOUT)
        .await;
    tokio::task::yield_now().await;
    take_one_desync(&mut events);
    await_restore_sequence(&reader.writer).await;
    for _ in 0..20 {
        tokio::task::yield_now().await;
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    let restores = reader
        .writer
        .lock()
        .expect("writer")
        .windows(RESTORE_PROMPT_SEQUENCE.len())
        .filter(|part| *part == RESTORE_PROMPT_SEQUENCE.as_bytes())
        .count();
    assert_eq!(restores, 1, "exactly one restore write after drain timeout");
    assert!(!reader.gate.generator_active());
}

#[test]
fn trust_loss_sink_installs_once_without_per_chunk_allocation() {
    let (_, gate) = capture_gate();
    let _: std::sync::OnceLock<super::gate::TrustLossSink> = gate.trust_loss_sink;
    let source = include_str!("deliver.rs");
    let bind = source
        .split("fn bind_trust_loss_sink")
        .nth(1)
        .expect("bind_trust_loss_sink");
    assert!(
        bind.contains("has_trust_loss_sink") || bind.contains("get_or_init"),
        "bind_trust_loss_sink must skip allocation when the sink is already installed"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn drain_timeout_does_not_cancel_next_request() {
    let (writer, gate) = capture_gate();
    let gate = Arc::new(gate);
    let boundary = Arc::new(std::sync::Barrier::new(2));
    let resume = Arc::new(std::sync::Barrier::new(2));
    let reached = boundary.clone();
    let release = resume.clone();
    gate.install_trust_loss_sink(Arc::new(move |_| {
        reached.wait();
        release.wait();
    }));
    let old = start_completion(&gate, "r1", b"OLD").await;
    assert_eq!(old.result, SessionRpcResult::Accepted);
    let submitting = gate.clone();
    let submit = tokio::spawn(async move { submitting.submit("draft", true).await });
    boundary.wait();
    // A late authenticated frame cannot grant trust or disturb a new epoch.
    gate.finish_completion(super::frame::CompletionResult {
        session_id: "s1".into(),
        nonce: "n1".into(),
        request_id: "r1".into(),
        buffer_revision: 3,
        cursor: 4,
        prompt_generation: 7,
        cwd: "/repo".into(),
        output: "late".into(),
    });
    let next = start_completion(&gate, "r2", b"NEXT").await;
    let trusted = gate.trusted_at_prompt();
    let suppressed = gate.suppressing_output();
    resume.wait();
    assert_eq!(submit.await.unwrap(), SessionRpcResult::NotStarted);
    assert_eq!(
        next.result,
        SessionRpcResult::NotStarted,
        "timeout must revoke trust before releasing the writer"
    );
    assert!(!trusted);
    assert!(!suppressed);
    assert!(!writer
        .lock()
        .unwrap()
        .windows(4)
        .any(|bytes| bytes == b"NEXT"));
}

#[test]
fn lifecycle_publication_snapshot_matches_its_sequence_boundary() {
    let (_, gate) = capture_gate();
    let gate = Arc::new(gate);
    assert!(gate.register_session("s1".into(), "n1".into()));
    gate.mark_raw();
    let hub = crate::trackers::terminal_events::TerminalEventHub::standalone();
    let mut events = hub.subscribe();
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let mut snapshots = Vec::new();
    std::thread::scope(|scope| {
        for prompt in [false, true] {
            let gate = gate.clone();
            let hub = hub.clone();
            let barrier = barrier.clone();
            scope.spawn(move || {
                let mut filter = SessionFilter::new();
                let pending = Mutex::new(Vec::new());
                barrier.wait();
                for generation in 1..=32 {
                    let frame = serde_json::json!({
                        "type":if prompt {"PromptReady"} else {"CommandStarted"},
                        "nonce":"n1","prompt_generation":generation,
                        "cwd":"/repo","line_empty":true,"prompt_suppressed":true,
                    });
                    let bytes = format!("\x1b]9477;{frame}\x07");
                    assert!(process_reader_chunk(
                        &mut filter,
                        bytes.as_bytes(),
                        &pending,
                        &gate,
                        "test",
                        &hub
                    ));
                    std::thread::yield_now();
                }
            });
        }
        barrier.wait();
        for _ in 0..256 {
            snapshots.push(gate.authentic_session());
            std::thread::yield_now();
        }
    });
    snapshots.push(gate.authentic_session());
    let mut published = Vec::new();
    while let Ok(event) = events.try_recv() {
        published.push(event);
    }
    assert_eq!(published.len(), 64);
    for (index, event) in published.iter().enumerate() {
        assert_eq!(event.lifecycle_sequence(), Some(index as u64 + 1));
    }
    for snapshot in snapshots {
        let last = published
            .iter()
            .take(snapshot.sequence as usize)
            .next_back();
        let prompt = match last {
            Some(crate::trackers::terminal_events::TerminalEvent::SessionLifecycle {
                kind,
                prompt_generation: Some(generation),
                cwd: Some(cwd),
                ..
            }) if kind == "PromptReady" => Some((*generation, cwd.clone())),
            _ => None,
        };
        assert_eq!(
            snapshot.prompt, prompt,
            "snapshot sequence {}",
            snapshot.sequence
        );
    }
}

#[tokio::test(start_paused = true)]
async fn missing_command_started_does_not_write_an_in_band_restore() {
    use super::RESTORE_PROMPT_SEQUENCE;
    let reader = bind_trust_loss_reader();
    let mut events = reader.hub.subscribe();
    assert_eq!(
        reader.gate.submit("git status", true).await,
        SessionRpcResult::Accepted
    );
    tokio::time::advance(std::time::Duration::from_secs(3)).await;
    tokio::task::yield_now().await;
    assert!(
        events.try_recv().is_err(),
        "a missing CommandStarted must not publish Desync"
    );
    assert!(
        !reader
            .writer
            .lock()
            .expect("writer")
            .windows(RESTORE_PROMPT_SEQUENCE.len())
            .any(|part| part == RESTORE_PROMPT_SEQUENCE.as_bytes()),
        "a missing CommandStarted must not write restore sequence"
    );
}

fn command_finished_frame(nonce: &str, exit_code: Option<i32>) -> Vec<u8> {
    command_finished_frame_code(nonce, exit_code.map(i64::from))
}

fn command_finished_frame_code(nonce: &str, exit_code: Option<i64>) -> Vec<u8> {
    let mut payload = serde_json::json!({"type":"CommandFinished","nonce":nonce});
    if let Some(code) = exit_code {
        payload["exit_code"] = serde_json::json!(code);
    }
    format!("\x1b]9477;{payload}\x07").into_bytes()
}

fn finished_exit_harness() -> (
    Arc<super::gate::SessionGate>,
    crate::trackers::ExitCodeTracker,
    crate::trackers::terminal_events::TerminalEventHub,
    Mutex<Vec<u8>>,
    SessionFilter,
) {
    let (_writer, gate) = capture_gate();
    gate.expect_session("s1".into(), "n1".into());
    assert!(gate.register_session("s1".into(), "n1".into()));
    let hub = crate::trackers::terminal_events::TerminalEventHub::standalone();
    let tracker = crate::trackers::ExitCodeTracker::new(hub.clone());
    tracker.initialize_terminal("test");
    let gate = Arc::new(gate);
    gate.bind_exit_code_tracker(Arc::new(tracker.clone()));
    (
        gate,
        tracker,
        hub,
        Mutex::new(Vec::new()),
        SessionFilter::new(),
    )
}

fn exit_code_changed_events(
    events: &mut tokio::sync::broadcast::Receiver<crate::trackers::terminal_events::TerminalEvent>,
) -> Vec<i32> {
    let mut codes = Vec::new();
    while let Ok(event) = events.try_recv() {
        if let crate::trackers::terminal_events::TerminalEvent::ExitCodeChanged {
            exit_code, ..
        } = event
        {
            codes.push(exit_code);
        }
    }
    codes
}

#[tokio::test]
async fn authenticated_command_finished_records_exit_code_once() {
    let (gate, tracker, hub, pending, mut filter) = finished_exit_harness();
    let mut events = hub.subscribe();
    assert!(process_reader_chunk(
        &mut filter,
        &command_finished_frame("n1", Some(3)),
        &pending,
        &gate,
        "test",
        &hub,
    ));
    assert_eq!(exit_code_changed_events(&mut events), [3]);
    assert_eq!(tracker.get_exit_code("test"), Some(3));
    assert!(process_reader_chunk(
        &mut filter,
        &command_finished_frame("n1", Some(3)),
        &pending,
        &gate,
        "test",
        &hub,
    ));
    assert!(
        exit_code_changed_events(&mut events).is_empty(),
        "the same code twice must not emit again"
    );
    assert_eq!(tracker.get_exit_code("test"), Some(3));
}

#[tokio::test]
async fn command_finished_without_code_keeps_previous_exit_code() {
    let (gate, tracker, hub, pending, mut filter) = finished_exit_harness();
    let mut events = hub.subscribe();
    tracker.record_exit_code("test", 2);
    let _ = exit_code_changed_events(&mut events);
    assert!(process_reader_chunk(
        &mut filter,
        &command_finished_frame("n1", None),
        &pending,
        &gate,
        "test",
        &hub,
    ));
    assert!(
        exit_code_changed_events(&mut events).is_empty(),
        "CommandFinished without a code must not emit ExitCodeChanged"
    );
    assert_eq!(tracker.get_exit_code("test"), Some(2));
}

#[tokio::test]
async fn command_finished_out_of_i32_range_keeps_previous_exit_code() {
    let (gate, tracker, hub, pending, mut filter) = finished_exit_harness();
    let mut events = hub.subscribe();
    tracker.record_exit_code("test", 2);
    let _ = exit_code_changed_events(&mut events);
    for overflow in [i64::from(i32::MAX) + 1, i64::from(i32::MIN) - 1] {
        assert!(process_reader_chunk(
            &mut filter,
            &command_finished_frame_code("n1", Some(overflow)),
            &pending,
            &gate,
            "test",
            &hub,
        ));
        assert!(
            exit_code_changed_events(&mut events).is_empty(),
            "an out-of-range exit_code must not emit ExitCodeChanged"
        );
        assert_eq!(tracker.get_exit_code("test"), Some(2));
    }
}

#[tokio::test]
async fn forged_command_finished_does_not_record_exit_code() {
    let (gate, tracker, hub, pending, mut filter) = finished_exit_harness();
    let mut events = hub.subscribe();
    assert!(process_reader_chunk(
        &mut filter,
        &command_finished_frame("forged", Some(3)),
        &pending,
        &gate,
        "test",
        &hub,
    ));
    assert!(
        exit_code_changed_events(&mut events).is_empty(),
        "a forged-nonce CommandFinished must not emit ExitCodeChanged"
    );
    assert_eq!(tracker.get_exit_code("test"), None);
}

#[tokio::test]
async fn one_desync_plus_two_restore_rpcs_writes_the_sequence_once() {
    use super::filter::MAX_SESSION_FRAME_BYTES;
    use super::RESTORE_PROMPT_SEQUENCE;
    use crate::trackers::terminal_events::TerminalEventHub;

    let (writer, gate) = capture_gate();
    let gate = Arc::new(gate);
    gate.expect_session("s1".into(), "n1".into());
    gate.register_session("s1".into(), "n1".into());
    let hub = TerminalEventHub::standalone();
    let pending = Mutex::new(Vec::new());
    let mut filter = SessionFilter::new();
    let mut chunk = b"\x1b]9477;".to_vec();
    chunk.extend(vec![b'x'; MAX_SESSION_FRAME_BYTES]);
    chunk.push(7);
    assert!(process_reader_chunk(
        &mut filter,
        &chunk,
        &pending,
        &gate,
        "test",
        &hub
    ));
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if writer
                .lock()
                .expect("writer")
                .windows(RESTORE_PROMPT_SEQUENCE.len())
                .any(|part| part == RESTORE_PROMPT_SEQUENCE.as_bytes())
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("host desync restore");
    assert_eq!(gate.restore_prompt(true).await, SessionRpcResult::Accepted);
    assert_eq!(gate.restore_prompt(true).await, SessionRpcResult::Accepted);
    let restores = writer
        .lock()
        .expect("writer")
        .windows(RESTORE_PROMPT_SEQUENCE.len())
        .filter(|part| *part == RESTORE_PROMPT_SEQUENCE.as_bytes())
        .count();
    assert_eq!(
        restores, 1,
        "one Desync plus two restore_prompt RPCs writes the sequence once"
    );
}

#[test]
fn raw_session_desync_never_writes_to_an_unregistered_pty() {
    use std::io::Read;

    for issue_identity in [false, true] {
        let (mut reader, writer) = std::io::pipe().unwrap();
        let gate = Arc::new(super::gate::SessionGate::new(Arc::new(
            tokio::sync::Mutex::new(Some(Box::new(writer))),
        )));
        if issue_identity {
            gate.expect_session("s1".into(), "n1".into());
        }
        let hub = crate::trackers::terminal_events::TerminalEventHub::standalone();
        let mut events = hub.subscribe();
        let mut chunk = b"\x1b]9477;".to_vec();
        chunk.extend(vec![b'x'; 65_536]);
        chunk.push(0x07);
        assert!(process_reader_chunk(
            &mut SessionFilter::new(),
            &chunk,
            &Mutex::new(Vec::new()),
            &gate,
            "raw",
            &hub,
        ));
        drop(gate);
        let mut written = Vec::new();
        reader.read_to_end(&mut written).unwrap();
        assert!(written.is_empty(), "unregistered PTY received {written:?}");
        assert!(events.try_recv().is_err());
    }
}

#[tokio::test]
async fn raw_session_unsafe_prompt_revokes_previous_submit_and_completion_trust() {
    for (line_empty, prompt_suppressed) in [(false, true), (true, false), (false, false)] {
        let mut reader = TrustReader::new();
        reader.receive(&lifecycle_frame("InitShell", "n1"));
        reader.receive(&lifecycle_frame("PromptReady", "n1"));
        assert!(reader.gate.trusted_at_prompt());
        let payload = serde_json::json!({
            "type": "PromptReady", "nonce": "n1", "prompt_generation": 8,
            "cwd": "/other", "line_empty": line_empty,
            "prompt_suppressed": prompt_suppressed,
        });
        reader.receive(format!("\x1b]9477;{payload}\x07").as_bytes());
        assert!(
            !reader.gate.trusted_at_prompt(),
            "stale prompt trust retained"
        );
        assert_eq!(
            reader.gate.authentic_session().phase,
            super::gate::SessionPhase::Raw
        );
        assert_eq!(
            reader.gate.submit("git status", true).await,
            SessionRpcResult::NotStarted
        );
        assert_eq!(
            start_completion(&reader.gate, "r1", b"GEN").await.result,
            SessionRpcResult::NotStarted
        );
    }
}
